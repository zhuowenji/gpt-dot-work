import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ApiError } from './store.mjs';
import { digest, constantEqual, parsePasswordHash } from './auth.mjs';

const derive = promisify(scrypt);
const token = () => randomBytes(32).toString('base64url');
const passwordWork = { active: 0, clients: new Set() };
const dummyPassword = { salt: randomBytes(16), hash: randomBytes(32) };
const hashOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const CHAT_ACCOUNT_LIMITS = Object.freeze({
  sessionTtlMs: 7 * 86400000, sessionIdleMs: 86400000,
  accounts: 10000, sessions: 10000, sessionsPerAccount: 10,
  accountThreads: 200, principalBytes: 1024 * 1024,
  passwordWork: 2, bodyBytes: 8192, rateWindowMs: 900000,
  loginAttempts: 20, signupAttempts: 5, rateBuckets: 8192,
  idempotencyTtlMs: 86400000, idempotencyTotal: 20000, idempotencyPerAccount: 128,
});

function send(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
function validateCredentials(body) {
  if (Object.keys(body).length !== 2 || !Object.hasOwn(body, 'username') || !Object.hasOwn(body, 'password') || typeof body.username !== 'string' || typeof body.password !== 'string') throw new ApiError(400, 'invalid_input', 'Provide only username and password');
  const username = body.username.trim().normalize('NFKC');
  if (![...username].length || [...username].length > 40 || !/^[\p{L}\p{N}_.-]+$/u.test(username)) throw new ApiError(400, 'invalid_username', 'Use 1–40 letters, numbers, periods, underscores or hyphens for your username');
  if (!body.password.isWellFormed() || [...body.password].length < 6 || Buffer.byteLength(body.password) > 1024) throw new ApiError(400, 'invalid_password', 'Use a password of at least 6 characters and at most 1024 bytes');
  // Upper/lower folding also merges compatibility forms, final sigma and sharp-s.
  // Passwords are never trimmed, normalized, or copied into idempotency records.
  return { username, usernameKey: username.toUpperCase().toLowerCase().normalize('NFKC'), password: body.password };
}
async function readBody(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'json_required', 'Send Content-Type: application/json');
  if (req.headers['content-length'] !== undefined && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > CHAT_ACCOUNT_LIMITS.bodyBytes)) throw new ApiError(413, 'body_too_large', 'The request body is too large');
  const chunks = []; let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > CHAT_ACCOUNT_LIMITS.bodyBytes) throw new ApiError(413, 'body_too_large', 'The request body is too large');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_input', 'Expected a JSON object');
  return body;
}

export class ChatAccountAuth {
  constructor(store, config, ownerAuth, context = null) {
    this.store = store; this.db = store.db; this.config = config; this.ownerAuth = ownerAuth;
    this.context = context;
    this.secure = Boolean(config.production || config.publicOrigin?.startsWith('https:'));
    this.cookieName = this.secure ? '__Host-chat_account_session' : 'chat_account_session';
    this.guestCookieName = this.secure ? '__Host-chat_session' : 'chat_session';
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_accounts (
        principal TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_account_sessions (
        id_hash TEXT PRIMARY KEY, principal TEXT NOT NULL REFERENCES chat_accounts(principal),
        csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_account_sessions_by_principal ON chat_account_sessions(principal, created_at);
      CREATE TABLE IF NOT EXISTS chat_account_rate_limits (
        bucket TEXT PRIMARY KEY, started_at INTEGER NOT NULL, attempts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_account_idempotency (
        source_principal TEXT NOT NULL, operation TEXT NOT NULL, key_hash TEXT NOT NULL,
        username_key TEXT NOT NULL, principal TEXT NOT NULL REFERENCES chat_accounts(principal),
        session_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(source_principal, operation, key_hash)
      );
      CREATE INDEX IF NOT EXISTS chat_account_idempotency_by_account ON chat_account_idempotency(principal, operation, key_hash);
      CREATE INDEX IF NOT EXISTS chat_account_idempotency_by_name ON chat_account_idempotency(username_key, operation, key_hash);
      CREATE INDEX IF NOT EXISTS chat_account_idempotency_expiry ON chat_account_idempotency(created_at);
    `);
    this.cleanup();
  }
  cleanup() {
    const at = this.store.now();
    this.db.prepare('DELETE FROM chat_account_sessions WHERE expires_at <= ? OR last_seen <= ?').run(at, at - CHAT_ACCOUNT_LIMITS.sessionIdleMs);
    this.db.prepare('DELETE FROM chat_account_rate_limits WHERE started_at <= ?').run(at - CHAT_ACCOUNT_LIMITS.rateWindowMs);
    this.db.prepare('DELETE FROM chat_account_idempotency WHERE created_at <= ?').run(at - CHAT_ACCOUNT_LIMITS.idempotencyTtlMs);
  }
  cookieId(req, cookieName = this.cookieName) {
    const cookies = (req.headers.cookie || '').split(';').map(part => part.trim().split('='));
    const matches = cookies.filter(([name]) => name === cookieName);
    return matches.length === 1 && matches[0].length === 2 && /^[A-Za-z0-9_-]{43}$/.test(matches[0][1] || '') ? matches[0][1] : null;
  }
  session(req) {
    const id = this.cookieId(req);
    if (!id) return null;
    const idHash = digest(id), at = this.store.now();
    const row = this.db.prepare('SELECT s.*, a.username FROM chat_account_sessions s JOIN chat_accounts a ON a.principal = s.principal WHERE s.id_hash = ?').get(idHash);
    if (!row) return null;
    if (row.expires_at <= at || row.last_seen + CHAT_ACCOUNT_LIMITS.sessionIdleMs <= at) {
      this.db.prepare('DELETE FROM chat_account_sessions WHERE id_hash = ?').run(idHash);
      return null;
    }
    this.db.prepare('UPDATE chat_account_sessions SET last_seen = ? WHERE id_hash = ?').run(at, idHash);
    return { principal: row.principal, role: 'account', username: row.username, csrfToken: row.csrf, expiresAt: row.expires_at };
  }
  describe(session) {
    return session ? { authenticated: true, role: 'account', identity: session.principal, username: session.username, csrfToken: session.csrfToken, expiresAt: session.expiresAt } : { authenticated: false };
  }
  requireReadOrigin(req) {
    if ((req.headers.origin && req.headers.origin !== this.config.publicOrigin) || req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, 'origin_denied', 'A same-origin browser request is required');
  }
  requireCurrentSource(req, source) {
    const account = source?.role === 'account';
    const id = source && this.cookieId(req, account ? this.cookieName : this.guestCookieName);
    const table = account ? 'chat_account_sessions' : 'chat_guest_sessions';
    const row = id && this.db.prepare(`SELECT * FROM ${table} WHERE id_hash = ?`).get(digest(id));
    const at = this.store.now();
    if (!source || !['account', 'visitor'].includes(source.role) || !row || row.principal !== source.principal || row.expires_at <= at || row.last_seen + CHAT_ACCOUNT_LIMITS.sessionIdleMs <= at || !constantEqual(row.csrf, source.csrfToken) || !constantEqual(row.csrf, req.headers['x-csrf-token'])) throw new ApiError(401, 'chat_session_required', 'Your chat identity expired or changed. Refresh it before continuing.');
  }
  setCookie(res, name, id, maxAge) {
    const cookie = `${name}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secure ? '; Secure' : ''}`;
    const previous = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', previous ? [...(Array.isArray(previous) ? previous : [previous]), cookie] : cookie);
  }
  rate(client, operation) {
    const bucket = `${operation}:${digest(client)}`, at = this.store.now();
    this.store.transaction(() => {
      this.db.prepare('DELETE FROM chat_account_rate_limits WHERE started_at <= ?').run(at - CHAT_ACCOUNT_LIMITS.rateWindowMs);
      const row = this.db.prepare('SELECT attempts FROM chat_account_rate_limits WHERE bucket = ?').get(bucket);
      const max = operation === 'signup' ? CHAT_ACCOUNT_LIMITS.signupAttempts : CHAT_ACCOUNT_LIMITS.loginAttempts;
      if (row && row.attempts >= max) throw new ApiError(429, 'account_rate_limited', 'Too many account requests. Try again in 15 minutes.');
      if (!row && this.db.prepare('SELECT COUNT(*) AS n FROM chat_account_rate_limits').get().n >= CHAT_ACCOUNT_LIMITS.rateBuckets) throw new ApiError(429, 'account_capacity', 'Account sign-in is temporarily busy. Try again later.');
      // Count all attempts, including successful registrations and sign-ins.
      this.db.prepare('INSERT INTO chat_account_rate_limits(bucket, started_at, attempts) VALUES (?, ?, 1) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1').run(bucket, at);
    });
  }
  async withPasswordWork(client, operation, fn) {
    if (passwordWork.active >= CHAT_ACCOUNT_LIMITS.passwordWork || passwordWork.clients.has(client)) throw new ApiError(429, 'account_busy', 'Another sign-in is being checked. Try again shortly.');
    this.rate(client, operation);
    passwordWork.active += 1; passwordWork.clients.add(client);
    try { return await fn(); }
    finally { passwordWork.active -= 1; passwordWork.clients.delete(client); }
  }
  async verify(password, encoded) {
    const expected = encoded ? parsePasswordHash(encoded) : dummyPassword;
    const actual = await derive(password, expected.salt, 32, hashOptions);
    return timingSafeEqual(actual, expected.hash) && Boolean(encoded);
  }
  idempotencyKey(req) {
    const key = req.headers['x-idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new ApiError(400, 'idempotency_key_required', 'X-Idempotency-Key must contain 8–128 letters, numbers, periods, underscores, colons or hyphens');
    return digest(key);
  }
  prior(sourcePrincipal, operation, keyHash, usernameKey) {
    const prior = this.db.prepare('SELECT * FROM chat_account_idempotency WHERE source_principal = ? AND operation = ? AND key_hash = ?').get(sourcePrincipal, operation, keyHash);
    if (prior && prior.username_key !== usernameKey) throw new ApiError(409, 'idempotency_conflict', 'That key was already used with a different username');
    return prior || this.db.prepare('SELECT * FROM chat_account_idempotency WHERE username_key = ? AND operation = ? AND key_hash = ? ORDER BY created_at DESC LIMIT 1').get(usernameKey, operation, keyHash);
  }
  migrateGuest(guest, principal) {
    if (!guest || guest.role !== 'visitor' || !/^visitor:[a-f0-9]{32}$/.test(guest.principal)) return false;
    // The caller supplies a cookie-validated guest. Recheck expiry and CSRF inside
    // the write transaction so hashing delays/concurrent requests cannot claim it.
    const row = this.db.prepare('SELECT * FROM chat_guest_sessions WHERE principal = ?').get(guest.principal);
    const at = this.store.now();
    if (!row || row.expires_at <= at || row.last_seen + CHAT_ACCOUNT_LIMITS.sessionIdleMs <= at || !constantEqual(row.csrf, guest.csrfToken)) return false;
    const threads = this.db.prepare("SELECT COUNT(*) AS n FROM chat_threads WHERE principal = ? OR (principal = ? AND kind = 'visitor_question')").get(principal, guest.principal).n;
    const bytes = this.db.prepare("SELECT COALESCE(SUM(m.content_bytes), 0) AS n FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id WHERE t.principal = ? OR (t.principal = ? AND t.kind = 'visitor_question')").get(principal, guest.principal).n;
    if (threads > CHAT_ACCOUNT_LIMITS.accountThreads || bytes > CHAT_ACCOUNT_LIMITS.principalBytes) throw new ApiError(429, 'account_migration_limit', 'These guest conversations exceed the account storage limit. Your guest conversations have been kept.');
    this.db.prepare("UPDATE chat_messages SET author = ? WHERE author = ? AND thread_id IN (SELECT id FROM chat_threads WHERE principal = ? AND kind = 'visitor_question')").run(principal, guest.principal, guest.principal);
    this.db.prepare("UPDATE chat_threads SET principal = ? WHERE principal = ? AND kind = 'visitor_question'").run(principal, guest.principal);
    this.context?.migratePrincipal(guest.principal, principal);
    this.db.prepare('DELETE FROM chat_guest_sessions WHERE principal = ?').run(guest.principal);
    return true;
  }
  issueSession(req, account, current, guest, sourcePrincipal, operation, keyHash, prior) {
    const at = this.store.now(), oldId = this.cookieId(req), oldHash = oldId ? digest(oldId) : null;
    const live = oldHash && this.db.prepare('SELECT expires_at, last_seen FROM chat_account_sessions WHERE id_hash = ? AND principal = ?').get(oldHash, account.principal);
    const replay = Boolean(current?.principal === account.principal && oldHash === prior?.session_hash && live && live.expires_at > at && live.last_seen + CHAT_ACCOUNT_LIMITS.sessionIdleMs > at);
    const id = replay ? null : token(), csrfToken = replay ? current.csrfToken : token();
    const expiresAt = replay ? current.expiresAt : at + CHAT_ACCOUNT_LIMITS.sessionTtlMs;
    const migrated = this.migrateGuest(guest, account.principal);
    if (!replay) {
      if (oldHash) this.db.prepare('DELETE FROM chat_account_sessions WHERE id_hash = ?').run(oldHash);
      this.db.prepare('DELETE FROM chat_account_sessions WHERE id_hash IN (SELECT id_hash FROM chat_account_sessions WHERE principal = ? ORDER BY created_at DESC, id_hash DESC LIMIT -1 OFFSET ?)').run(account.principal, CHAT_ACCOUNT_LIMITS.sessionsPerAccount - 1);
      if (this.db.prepare('SELECT COUNT(*) AS n FROM chat_account_sessions').get().n >= CHAT_ACCOUNT_LIMITS.sessions) throw new ApiError(503, 'account_capacity', 'Account sign-in is temporarily full. Try again later.');
      this.db.prepare('INSERT INTO chat_account_sessions(id_hash, principal, csrf, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run(digest(id), account.principal, csrfToken, at, expiresAt, at);
    }
    const existing = this.db.prepare('SELECT 1 FROM chat_account_idempotency WHERE source_principal = ? AND operation = ? AND key_hash = ?').get(sourcePrincipal, operation, keyHash);
    if (!existing && (this.db.prepare('SELECT COUNT(*) AS n FROM chat_account_idempotency').get().n >= CHAT_ACCOUNT_LIMITS.idempotencyTotal || this.db.prepare('SELECT COUNT(*) AS n FROM chat_account_idempotency WHERE principal = ?').get(account.principal).n >= CHAT_ACCOUNT_LIMITS.idempotencyPerAccount)) throw new ApiError(429, 'account_capacity', 'The daily account request limit has been reached. Try again later.');
    this.db.prepare('INSERT INTO chat_account_idempotency(source_principal, operation, key_hash, username_key, principal, session_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_principal, operation, key_hash) DO UPDATE SET session_hash = excluded.session_hash').run(sourcePrincipal, operation, keyHash, account.username_key, account.principal, replay ? oldHash : digest(id), at);
    return { id, migrated, session: { principal: account.principal, role: 'account', username: account.username, csrfToken, expiresAt } };
  }
  async handle(req, res, url, { ownerSession = null, guestSession = null } = {}) {
    const path = url.pathname;
    if (path !== '/api/chat/account' && !path.startsWith('/api/chat/account/')) return false;
    this.requireReadOrigin(req);
    if (url.search) throw new ApiError(400, 'invalid_query', 'Account endpoints do not accept query parameters');
    const current = this.session(req);
    if (req.method === 'GET' && path === '/api/chat/account/session') { send(res, this.describe(ownerSession ? null : current)); return true; }
    if (req.method !== 'POST') throw new ApiError(404, 'not_found', 'Endpoint not found');
    this.ownerAuth.requireCsrf(req, ownerSession || current || guestSession);
    if (ownerSession) throw new ApiError(409, 'owner_session_active', 'Sign out of the owner workspace before using a public account');
    const operation = path.slice('/api/chat/account/'.length);
    if (!['signup', 'login', 'logout'].includes(operation)) throw new ApiError(404, 'not_found', 'Endpoint not found');
    const source = current || guestSession;
    const keyHash = this.idempotencyKey(req), body = await readBody(req);
    // Request-body reads and scrypt yield to logout/revocation/expiry. Never let
    // a stale credential resume a state mutation after any of those events.
    this.requireCurrentSource(req, source);
    if (operation === 'logout') {
      if (Object.keys(body).length) throw new ApiError(400, 'invalid_input', 'Sign-out accepts an empty JSON object only');
      // Revocation is naturally idempotent and never needs a stored bearer token.
      const id = this.cookieId(req);
      this.store.transaction(() => {
        this.requireCurrentSource(req, source);
        if (current && id) this.db.prepare('DELETE FROM chat_account_sessions WHERE id_hash = ?').run(digest(id));
      });
      this.setCookie(res, this.cookieName, '', 0);
      send(res, { authenticated: false }); return true;
    }
    const credentials = validateCredentials(body), client = this.ownerAuth.clientAddress(req);
    const sourcePrincipal = current?.principal || guestSession?.principal;
    const result = await this.withPasswordWork(client, operation, async () => {
      this.cleanup();
      let prior = this.prior(sourcePrincipal, operation, keyHash, credentials.usernameKey);
      let account = this.db.prepare('SELECT * FROM chat_accounts WHERE username_key = ?').get(credentials.usernameKey);
      let encoded;
      if (operation === 'signup' && !account) {
        if (this.db.prepare('SELECT COUNT(*) AS n FROM chat_accounts').get().n >= CHAT_ACCOUNT_LIMITS.accounts) throw new ApiError(503, 'account_capacity', 'Account registration is temporarily full');
        const salt = randomBytes(16), hash = await derive(credentials.password, salt, 32, hashOptions);
        encoded = `scrypt$32768$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
      } else {
        if (operation === 'signup' && !prior) throw new ApiError(409, 'username_unavailable', 'That username is already in use');
        if (!await this.verify(credentials.password, account?.password_hash)) throw new ApiError(401, 'invalid_credentials', 'The username or password is incorrect');
      }
      return this.store.transaction(() => {
        this.requireCurrentSource(req, source);
        this.cleanup();
        prior = this.prior(sourcePrincipal, operation, keyHash, credentials.usernameKey);
        // Check uniqueness again after async scrypt: simultaneous registrations
        // cannot create duplicate accounts or replace somebody else's password.
        const found = this.db.prepare('SELECT * FROM chat_accounts WHERE username_key = ?').get(credentials.usernameKey);
        if (encoded) {
          if (found) throw new ApiError(409, 'username_unavailable', 'That username is already in use');
          if (this.db.prepare('SELECT COUNT(*) AS n FROM chat_accounts').get().n >= CHAT_ACCOUNT_LIMITS.accounts) throw new ApiError(503, 'account_capacity', 'Account registration is temporarily full');
          account = { principal: `account:${randomBytes(16).toString('hex')}`, username: credentials.username, username_key: credentials.usernameKey };
          this.db.prepare('INSERT INTO chat_accounts(principal, username, username_key, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(account.principal, account.username, account.username_key, encoded, this.store.now());
        } else if (!found || found.principal !== account.principal || found.password_hash !== account.password_hash) throw new ApiError(401, 'invalid_credentials', 'The username or password is incorrect');
        return this.issueSession(req, account, current, guestSession, sourcePrincipal, operation, keyHash, prior);
      });
    });
    if (result.id) this.setCookie(res, this.cookieName, result.id, Math.floor(CHAT_ACCOUNT_LIMITS.sessionTtlMs / 1000));
    if (result.migrated) this.setCookie(res, this.guestCookieName, '', 0);
    send(res, this.describe(result.session)); return true;
  }
}
