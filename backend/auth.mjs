import { createHash, randomBytes, timingSafeEqual, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { ApiError } from './store.mjs';
const derive = promisify(scrypt);
export const digest = value => createHash('sha256').update(value).digest('hex');
export const constantEqual = (left, right) => typeof left === 'string' && typeof right === 'string' && timingSafeEqual(Buffer.from(digest(left), 'hex'), Buffer.from(digest(right), 'hex'));
const token = () => randomBytes(32).toString('base64url');
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
  checkRate(req) {
    const at = this.store.now();
    const windowMs = 15 * 60 * 1000;
    // Never trust a client-supplied X-Forwarded-For. The global limit also bounds
    // attempts behind multiple IPs and concurrent password derivations.
    const buckets = [[`ip:${digest(req.socket.remoteAddress || 'unknown')}`, 5], ['global', 50]];
    this.store.transaction(() => {
      this.db.prepare('DELETE FROM owner_login_attempts WHERE started_at <= ?').run(at - windowMs);
      for (const [bucket, limit] of buckets) {
        const row = this.db.prepare('SELECT attempts FROM owner_login_attempts WHERE bucket = ?').get(bucket);
        if (row && row.attempts >= limit) throw new ApiError(429, 'login_rate_limited', 'Too many login attempts. Try again in 15 minutes.');
      }
      for (const [bucket] of buckets) this.db.prepare('INSERT INTO owner_login_attempts(bucket, started_at, attempts) VALUES (?, ?, 1) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1').run(bucket, at);
    });
  }
  setCookie(res, id, maxAge) {
    res.setHeader('Set-Cookie', `${this.cookieName}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.config.production || this.config.publicOrigin?.startsWith('https:') ? '; Secure' : ''}`);
  }
  async login(req, res, body) {
    this.requireOrigin(req);
    if (!this.password) throw new ApiError(503, 'login_not_configured', 'Owner login has not been configured');
    this.checkRate(req);
    if (Object.keys(body).length !== 1 || typeof body.password !== 'string' || !body.password || Buffer.byteLength(body.password) > 1024) throw new ApiError(400, 'invalid_input', 'Provide a password of at most 1024 bytes');
    const actual = await derive(body.password, this.password.salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    if (!timingSafeEqual(actual, this.password.hash)) throw new ApiError(401, 'invalid_credentials', 'The password is incorrect');
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
