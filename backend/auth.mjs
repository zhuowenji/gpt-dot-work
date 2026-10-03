import { createHash, randomBytes, timingSafeEqual, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { ApiError } from './store.mjs';
const derive = promisify(scrypt);
export const digest = value => createHash('sha256').update(value).digest('hex');
export const constantEqual = (left, right) => typeof left === 'string' && typeof right === 'string' && timingSafeEqual(Buffer.from(digest(left), 'hex'), Buffer.from(digest(right), 'hex'));
const token = () => randomBytes(32).toString('base64url');
// Bound expensive password work across all OwnerAuth instances in this process.
// Reject excess work rather than queueing unbounded promises/password material.
const passwordWork = { active: 0, clients: new Set() };
const MAX_PASSWORD_WORK = 2;
function ipAddress(value) {
  if (typeof value !== 'string' || value.length > 45 || value.includes('%')) return null;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  // IPv4-mapped IPv6 and plain IPv4 identify the same peer/rate-limit bucket.
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(canonical);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  }
  return canonical;
}
export function parseTrustedProxies(value = '') {
  if (!value) return [];
  const peers = value.split(',').map(peer => peer.trim());
  if (peers.length > 2 || peers.some(peer => !['127.0.0.1', '::1'].includes(peer))) throw new Error('WORKSPACE_TRUST_PROXY must be empty or exact loopback peers: 127.0.0.1,::1');
  return [...new Set(peers)];
}
export function parsePasswordHash(encoded) {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[1] !== '32768' || parts[2] !== '8' || parts[3] !== '1' || !/^[A-Za-z0-9_-]{22,86}$/.test(parts[4]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[5])) throw new Error('WORKSPACE_OWNER_PASSWORD_HASH must use scrypt$32768$8$1$<base64url salt>$<base64url 32-byte hash>');
  const salt = Buffer.from(parts[4], 'base64url');
  const hash = Buffer.from(parts[5], 'base64url');
  if (salt.length < 16 || salt.length > 64 || hash.length !== 32 || salt.toString('base64url') !== parts[4] || hash.toString('base64url') !== parts[5]) throw new Error('WORKSPACE_OWNER_PASSWORD_HASH has invalid salt or hash encoding');
  return { salt, hash };
}
export class OwnerAuth {
  constructor(store, config) {
    this.store = store;
    this.db = store.db;
    this.config = config;
    this.password = config.ownerPasswordHash ? parsePasswordHash(config.ownerPasswordHash) : null;
    this.version = digest(config.ownerPasswordHash || 'disabled');
    this.cookieName = config.production ? '__Host-workspace_session' : 'workspace_session';
    this.db.exec(`CREATE TABLE IF NOT EXISTS owner_sessions (
      id_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, password_version TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS owner_login_attempts (bucket TEXT PRIMARY KEY, started_at INTEGER NOT NULL, attempts INTEGER NOT NULL);`);
    this.db.prepare('DELETE FROM owner_sessions WHERE password_version != ? OR expires_at <= ?').run(this.version, this.store.now());
    // Migrate the old shared failure bucket away: one source must never trigger
    // a durable account-wide lockout for an independently verified client.
    this.db.prepare("DELETE FROM owner_login_attempts WHERE bucket = 'global'").run();
  }
  cookieId(req) {
    const cookies = (req.headers.cookie || '').split(';').map(part => part.trim().split('='));
    const matches = cookies.filter(([name]) => name === this.cookieName);
    return matches.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(matches[0][1] || '') ? matches[0][1] : null;
  }
  session(req) {
    const id = this.cookieId(req);
    if (!id) return null;
    const idHash = digest(id);
    const at = this.store.now();
    const row = this.db.prepare('SELECT * FROM owner_sessions WHERE id_hash = ?').get(idHash);
    if (!row) return null;
    if (row.password_version !== this.version || row.expires_at <= at || row.last_seen + this.config.sessionIdleMs <= at) {
      this.db.prepare('DELETE FROM owner_sessions WHERE id_hash = ?').run(idHash);
      return null;
    }
    this.db.prepare('UPDATE owner_sessions SET last_seen = ? WHERE id_hash = ?').run(at, idHash);
    return { idHash, csrfToken: row.csrf, expiresAt: row.expires_at };
  }
  describe(session) {
    return { authenticated: Boolean(session), ...(session ? { csrfToken: session.csrfToken, owner: { name: this.config.ownerName }, expiresAt: session.expiresAt } : {}), loginConfigured: Boolean(this.password), runtime: this.config.runtime, demo: this.config.runtime === 'demo', realExecutionConfigured: false };
  }
  requireOrigin(req) {
    if (!this.config.publicOrigin || req.headers.origin !== this.config.publicOrigin || req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, 'origin_denied', 'A same-origin browser request is required');
  }
  requireCsrf(req, session) {
    this.requireOrigin(req);
    if (!constantEqual(req.headers['x-csrf-token'], session?.csrfToken)) throw new ApiError(403, 'csrf_denied', 'The session verification token is missing or invalid');
  }
  clientAddress(req) {
    const peer = ipAddress(req.socket.remoteAddress);
    if (!peer) throw new ApiError(400, 'invalid_client_ip', 'The connection address is invalid');
    if (!(this.config.trustedProxyIPs || []).includes(peer)) return peer;
    // This dedicated header is only usable behind an explicitly trusted socket
    // peer whose proxy configuration OVERWRITES it. Never parse inherited XFF.
    const client = ipAddress(req.headers['x-workspace-client-ip']);
    if (!client) throw new ApiError(400, 'invalid_client_ip', 'The trusted proxy must provide one valid X-Workspace-Client-IP address');
    return client;
  }
  checkRate(req) {
    const client = this.clientAddress(req);
    const at = this.store.now();
    return this.store.transaction(() => {
      this.db.prepare('DELETE FROM owner_login_attempts WHERE started_at <= ?').run(at - 15 * 60 * 1000);
      const row = this.db.prepare('SELECT attempts FROM owner_login_attempts WHERE bucket = ?').get(`ip:${digest(client)}`);
      if (row && row.attempts >= 5) throw new ApiError(429, 'login_rate_limited', 'Too many failed login attempts. Try again in 15 minutes.');
      return client;
    });
  }
  recordFailure(client) {
    const at = this.store.now();
    this.store.transaction(() => {
      this.db.prepare('DELETE FROM owner_login_attempts WHERE started_at <= ?').run(at - 15 * 60 * 1000);
      this.db.prepare('INSERT INTO owner_login_attempts(bucket, started_at, attempts) VALUES (?, ?, 1) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1').run(`ip:${digest(client)}`, at);
      // Bound failure history under rotating-source attacks without introducing
      // a shared lockout. The short process-wide scrypt gate remains independent.
      this.db.prepare('DELETE FROM owner_login_attempts WHERE bucket IN (SELECT bucket FROM owner_login_attempts ORDER BY started_at DESC, bucket DESC LIMIT -1 OFFSET 4096)').run();
    });
  }
  async verifyPassword(password) {
    const actual = await derive(password, this.password.salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return timingSafeEqual(actual, this.password.hash);
  }
  async authenticate(req, password) {
    const client = this.clientAddress(req);
    if (passwordWork.active >= MAX_PASSWORD_WORK || passwordWork.clients.has(client)) throw new ApiError(429, 'login_busy', 'Another login is being checked. Try again shortly.');
    this.checkRate(req);
    passwordWork.active += 1;
    passwordWork.clients.add(client);
    try {
      if (!await this.verifyPassword(password)) {
        this.recordFailure(client);
        throw new ApiError(401, 'invalid_credentials', 'The password is incorrect');
      }
      // A success never consumes quota and clears only this client's failures.
      // Other clients' failures remain intact; there is no global lockout.
      this.db.prepare('DELETE FROM owner_login_attempts WHERE bucket = ?').run(`ip:${digest(client)}`);
    } finally {
      passwordWork.active -= 1;
      passwordWork.clients.delete(client);
    }
  }
  setCookie(res, id, maxAge) {
    res.setHeader('Set-Cookie', `${this.cookieName}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.config.production || this.config.publicOrigin?.startsWith('https:') ? '; Secure' : ''}`);
  }
  async login(req, res, body) {
    this.requireOrigin(req);
    if (!this.password) throw new ApiError(503, 'login_not_configured', 'Owner login has not been configured');
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.password !== 'string' || !body.password || Buffer.byteLength(body.password) > 1024) throw new ApiError(400, 'invalid_input', 'Provide a password of at most 1024 bytes');
    await this.authenticate(req, body.password);
    const id = token();
    const csrfToken = token();
    const at = this.store.now();
    const expiresAt = at + this.config.sessionTtlMs;
    this.store.transaction(() => {
      const oldId = this.cookieId(req);
      if (oldId) this.db.prepare('DELETE FROM owner_sessions WHERE id_hash = ?').run(digest(oldId));
      this.db.prepare('DELETE FROM owner_sessions WHERE expires_at <= ? OR last_seen <= ?').run(at, at - this.config.sessionIdleMs);
      // Bound storage and active owner devices to ten, newest sessions retained.
      this.db.prepare('DELETE FROM owner_sessions WHERE id_hash IN (SELECT id_hash FROM owner_sessions ORDER BY created_at DESC, id_hash DESC LIMIT -1 OFFSET 9)').run();
      this.db.prepare('INSERT INTO owner_sessions(id_hash, csrf, password_version, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run(digest(id), csrfToken, this.version, at, expiresAt, at);
    });
    this.setCookie(res, id, Math.floor(this.config.sessionTtlMs / 1000));
    return this.describe({ csrfToken, expiresAt });
  }
  logout(req, res, session) {
    this.requireCsrf(req, session);
    this.db.prepare('DELETE FROM owner_sessions WHERE id_hash = ?').run(session.idHash);
    this.setCookie(res, '', 0);
    return { authenticated: false };
  }
}
