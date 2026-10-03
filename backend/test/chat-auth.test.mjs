import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable, PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../store.mjs';
import { OwnerAuth, digest, parsePasswordHash } from '../auth.mjs';
import { ChatIntake } from '../chat.mjs';
import { ChatAccountAuth, CHAT_ACCOUNT_LIMITS as LIMITS } from '../chat-auth.mjs';

const ORIGIN = 'http://localhost:4318';
function fixture(t, overrides = {}, path = ':memory:') {
  let now = 1800000000000;
  const store = new TaskStore(path, { now: () => now });
  const config = { publicOrigin: ORIGIN, production: false, ownerPasswordHash: '', ownerName: 'Owner', trustedProxyIPs: [], sessionTtlMs: 86400000, sessionIdleMs: 3600000, ...overrides };
  const owner = new OwnerAuth(store, config), chat = new ChatIntake(store, config, owner), auth = new ChatAccountAuth(store, config, owner);
  t.after(() => store.close());
  function guest() {
    const id = randomBytes(32).toString('base64url'), csrfToken = randomBytes(32).toString('base64url');
    const principal = `visitor:${randomBytes(16).toString('hex')}`;
    store.db.prepare('INSERT INTO chat_guest_sessions(id_hash, principal, csrf, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run(digest(id), principal, csrfToken, now, now + LIMITS.sessionTtlMs, now);
    return { cookie: `${chat.cookieName}=${id}`, principal, csrfToken };
  }
  async function request(operation, { method = operation === 'session' ? 'GET' : 'POST', body = {}, raw, rawStream, cookie = '', csrf = '', key = randomUUID(), headers = {}, origin = config.publicOrigin, ip = '127.0.0.1', ownerSession = null, guestSession } = {}) {
    const req = rawStream || Readable.from([Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? JSON.stringify(body))]);
    req.method = method;
    req.headers = { ...(origin ? { origin } : {}), cookie, 'content-type': 'application/json', 'x-csrf-token': csrf, 'x-idempotency-key': key, ...headers };
    req.socket = { remoteAddress: ip };
    const output = new Map();
    const res = { getHeader: name => output.get(name.toLowerCase()), setHeader: (name, value) => output.set(name.toLowerCase(), value), writeHead(status, values) { this.status = status; for (const [name, value] of Object.entries(values)) this.setHeader(name, value); }, end(body) { this.data = JSON.parse(body); } };
    try {
      const handled = await auth.handle(req, res, new URL(`/api/chat/account/${operation}`, config.publicOrigin), { ownerSession, guestSession: guestSession === undefined ? chat.guest(req) : guestSession });
      const setCookie = output.get('set-cookie');
      const cookies = setCookie ? (Array.isArray(setCookie) ? setCookie : [setCookie]) : [];
      return { handled, status: res.status, data: res.data, headers: output, cookies, cookie: cookies.find(value => value.startsWith(auth.cookieName + '='))?.split(';')[0] };
    } catch (error) { return { status: error.status || 500, code: error.code, error }; }
  }
  const signup = (g, username = 'Alice', options = {}) => request('signup', { cookie: g.cookie, csrf: g.csrfToken, body: { username, password: '123456' }, ...options });
  return { store, config, owner, chat, auth, request, guest, signup, now: () => now, advance: ms => { now += ms; } };
}
function addThread(store, guest, { kind = 'visitor_question', author = guest.principal } = {}) {
  const id = randomBytes(16).toString('hex'), at = store.now();
  store.db.prepare('INSERT INTO chat_threads(id, principal, kind, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, guest.principal, kind, 'Question', at, at);
  store.db.prepare('INSERT INTO chat_messages(thread_id, role, author, content, content_bytes, created_at, updated_at, editable, queue_position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'user', author, 'Hello', 5, at, at, 1, 1);
  return id;
}

test('public signup accepts 123456, creates an opaque account, and keeps owner authority separate', async t => {
  const f = fixture(t), g = f.guest();
  const result = await f.signup(g);
  assert.equal(result.status, 200, result.error?.stack);
  assert.match(result.data.identity, /^account:[a-f0-9]{32}$/);
  assert.deepEqual(Object.keys(result.data).sort(), ['authenticated', 'csrfToken', 'expiresAt', 'identity', 'role', 'username']);
  assert.equal(result.data.role, 'account'); assert.equal(result.data.username, 'Alice');
  assert.equal(result.data.expiresAt, f.now() + LIMITS.sessionTtlMs);
  assert.match(result.cookies[0], /HttpOnly; SameSite=Strict; Max-Age=604800$/);
  assert.equal(f.owner.session({ headers: { cookie: result.cookie } }), null);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM owner_sessions').get().n, 0);
  const account = f.store.db.prepare('SELECT * FROM chat_accounts').get(), session = f.store.db.prepare('SELECT * FROM chat_account_sessions').get();
  assert.equal(parsePasswordHash(account.password_hash).salt.length, 16);
  assert.equal(session.id_hash, digest(result.cookie.split('=')[1]));
  assert(!JSON.stringify(account).includes('123456'));
  assert(!JSON.stringify(session).includes(result.cookie.split('=')[1]));
  assert(!JSON.stringify(f.store.db.prepare('SELECT * FROM chat_account_idempotency').all()).includes('123456'));
  assert.equal((await f.request('session', { cookie: result.cookie })).data.identity, result.data.identity);
  assert.deepEqual((await f.request('session')).data, { authenticated: false });
});

test('account cookies on HTTPS are independent host-only Secure cookies and owner sessions prevent role confusion', async t => {
  const f = fixture(t, { publicOrigin: 'https://example.test' }), g = f.guest();
  const result = await f.signup(g);
  assert.equal(result.status, 200);
  assert.match(result.cookies[0], /^__Host-chat_account_session=/);
  assert.match(result.cookies[0], /; Secure$/);
  assert(result.cookies.every(cookie => !cookie.includes('Domain=') && !cookie.includes('workspace_session')));
  const ownerSession = { csrfToken: 'owner-csrf', expiresAt: f.now() + 100000 };
  const blocked = await f.request('signup', { body: { username: 'Other', password: '123456' }, cookie: result.cookie, csrf: ownerSession.csrfToken, ownerSession });
  assert.equal(blocked.status, 409); assert.equal(blocked.code, 'owner_session_active');
  assert.deepEqual((await f.request('session', { cookie: result.cookie, ownerSession })).data, { authenticated: false });
  assert.equal(f.auth.session({ headers: { cookie: result.cookie } }).principal, result.data.identity);
});

test('normalizes Unicode usernames and rejects casing/compatibility duplicates without changing passwords', async t => {
  const f = fixture(t), g = f.guest();
  const first = await f.signup(g, ' Ａｌｉｃｅ ');
  assert.equal(first.status, 200); assert.equal(first.data.username, 'Alice');
  const second = f.guest();
  assert.equal((await f.signup(second, 'aLiCe')).code, 'username_unavailable');
  assert.equal((await f.signup(second, '用户')).status, 200);
  const third = f.guest();
  const one = await f.signup(third, '我'); assert.equal(one.status, 200);
  const login = await f.request('login', { cookie: first.cookie, csrf: first.data.csrfToken, body: { username: 'ＡＬＩＣＥ', password: '123456' } });
  assert.equal(login.status, 200); assert.equal(login.data.identity, first.data.identity);
});

test('validates exact fields, password length/bytes, strict UTF-8 JSON and bounded bodies before password work', async t => {
  const f = fixture(t), g = f.guest(), options = { cookie: g.cookie, csrf: g.csrfToken };
  for (const body of [null, [], {}, { username: 'A', password: '12345' }, { username: 'A', password: 'x'.repeat(1025) }, { username: 'A', password: '\ud800'.repeat(6) }, { username: 'A B', password: '123456' }, { username: 'a'.repeat(41), password: '123456' }, { username: 'A', password: '123456', role: 'owner' }]) {
    assert.equal((await f.request('signup', { ...options, body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await f.request('signup', { ...options, raw: '{bad' })).code, 'invalid_json');
  assert.equal((await f.request('signup', { ...options, raw: '' })).code, 'invalid_json');
  assert.equal((await f.request('signup', { ...options, raw: Buffer.from([123, 34, 97, 34, 58, 34, 255, 34, 125]) })).code, 'invalid_json');
  assert.equal((await f.request('signup', { ...options, raw: ' '.repeat(LIMITS.bodyBytes + 1) })).status, 413);
  assert.equal((await f.request('signup', { ...options, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.request('signup', { ...options, key: 'short' })).code, 'idempotency_key_required');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_accounts').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_account_rate_limits').get().n, 0);
});

test('all account endpoints reject cross-origin requests and mutations use the effective account CSRF token', async t => {
  const f = fixture(t), g = f.guest();
  for (const operation of ['session', 'signup', 'login', 'logout']) {
    assert.equal((await f.request(operation, { cookie: g.cookie, csrf: g.csrfToken, origin: 'https://attacker.test' })).status, 403);
    assert.equal((await f.request(operation, { cookie: g.cookie, csrf: g.csrfToken, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  }
  assert.equal((await f.signup(g, 'Alice', { csrf: '' })).code, 'csrf_denied');
  assert.equal((await f.signup(g, 'Alice', { origin: '' })).code, 'origin_denied');
  assert.equal((await f.request('session', { origin: '' })).status, 200);
  const first = await f.signup(g), another = f.guest();
  assert.equal((await f.request('login', { cookie: `${first.cookie}; ${another.cookie}`, csrf: another.csrfToken, body: { username: 'Alice', password: '123456' } })).code, 'csrf_denied');
  assert.equal((await f.request('logout', { cookie: first.cookie, csrf: first.data.csrfToken, body: { admin: true } })).code, 'invalid_input');
});

test('signup/login migration claims only the simultaneously validated guest and preserves visitor-question classification', async t => {
  const f = fixture(t), g = f.guest(), outsider = f.guest();
  const mine = addThread(f.store, g), theirs = addThread(f.store, outsider);
  const ownerKind = addThread(f.store, g, { kind: 'owner_instruction' });
  const result = await f.signup(g);
  const rows = f.store.db.prepare('SELECT id, principal, kind FROM chat_threads').all();
  assert.equal(rows.find(r => r.id === mine).principal, result.data.identity);
  assert.equal(rows.find(r => r.id === mine).kind, 'visitor_question');
  assert.equal(rows.find(r => r.id === theirs).principal, outsider.principal);
  assert.equal(rows.find(r => r.id === ownerKind).principal, g.principal);
  assert.equal(f.store.db.prepare('SELECT author FROM chat_messages WHERE thread_id = ?').get(mine).author, result.data.identity);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_guest_sessions WHERE principal = ?').get(g.principal).n, 0);
  assert.match(result.cookies[1], /chat_session=;.*Max-Age=0/);
  const fresh = f.guest(), freshId = addThread(f.store, fresh);
  const login = await f.request('login', { cookie: fresh.cookie, csrf: fresh.csrfToken, body: { username: 'Alice', password: '123456' } });
  assert.equal(login.status, 200);
  assert.equal(f.store.db.prepare('SELECT principal FROM chat_threads WHERE id = ?').get(freshId).principal, result.data.identity);
  assert.equal(f.store.db.prepare('SELECT principal FROM chat_threads WHERE id = ?').get(theirs).principal, outsider.principal);
});

test('migration rejects invalidated guest state and failed passwords do not claim or delete any guest', async t => {
  const f = fixture(t), first = await f.signup(f.guest()), g = f.guest(), id = addThread(f.store, g);
  const denied = await f.request('login', { cookie: g.cookie, csrf: g.csrfToken, body: { username: 'Alice', password: 'wrong1' } });
  assert.equal(denied.status, 401);
  assert.equal(f.store.db.prepare('SELECT principal FROM chat_threads WHERE id = ?').get(id).principal, g.principal);
  const fake = { principal: g.principal, role: 'visitor', csrfToken: 'fake', expiresAt: f.now() + 1000 };
  const signed = await f.request('login', { cookie: first.cookie, csrf: first.data.csrfToken, guestSession: fake, body: { username: 'Alice', password: '123456' } });
  assert.equal(signed.status, 200);
  assert.equal(f.store.db.prepare('SELECT principal FROM chat_threads WHERE id = ?').get(id).principal, g.principal);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_guest_sessions WHERE principal = ?').get(g.principal).n, 1);
});

test('login rotates and revokes only the current account cookie; logout cannot revoke other devices', async t => {
  const f = fixture(t), first = await f.signup(f.guest()), another = f.guest();
  const second = await f.request('login', { cookie: another.cookie, csrf: another.csrfToken, body: { username: 'alice', password: '123456' } });
  const third = await f.request('login', { cookie: first.cookie, csrf: first.data.csrfToken, body: { username: 'alice', password: '123456' } });
  assert.equal(third.status, 200); assert.notEqual(third.cookie, first.cookie);
  assert.equal(f.auth.session({ headers: { cookie: first.cookie } }), null);
  assert.equal(f.auth.session({ headers: { cookie: second.cookie } }).principal, first.data.identity);
  assert.equal(f.auth.session({ headers: { cookie: `${third.cookie}; ${third.cookie}` } }), null);
  const logout = await f.request('logout', { cookie: third.cookie, csrf: third.data.csrfToken });
  assert.equal(logout.status, 200); assert.deepEqual(logout.data, { authenticated: false });
  assert.match(logout.cookies[0], /Max-Age=0/);
  assert.equal(f.auth.session({ headers: { cookie: third.cookie } }), null);
  assert(f.auth.session({ headers: { cookie: second.cookie } }));
});

test('idempotent signup retry verifies credentials and never creates duplicate accounts or stores raw credentials', async t => {
  const f = fixture(t), key = randomUUID(), first = await f.signup(f.guest(), 'Alice', { key });
  const again = await f.request('signup', { cookie: first.cookie, csrf: first.data.csrfToken, key, body: { username: 'Alice', password: '123456' } });
  assert.equal(again.status, 200); assert.deepEqual(again.data, first.data); assert.equal(again.cookie, undefined);
  const wrong = await f.request('signup', { cookie: first.cookie, csrf: first.data.csrfToken, key, body: { username: 'Alice', password: 'wrong1' } });
  assert.equal(wrong.status, 401);
  const recoveredGuest = f.guest(), recovered = await f.signup(recoveredGuest, 'Alice', { key });
  assert.equal(recovered.status, 200); assert.equal(recovered.data.identity, first.data.identity);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_accounts').get().n, 1);
  const changed = await f.request('signup', { cookie: first.cookie, csrf: first.data.csrfToken, key, body: { username: 'Other', password: '123456' } });
  assert.equal(changed.code, 'idempotency_conflict');
});

test('session absolute and idle expiry are enforced using the durable server clock', async t => {
  const f = fixture(t), first = await f.signup(f.guest());
  f.advance(LIMITS.sessionIdleMs);
  assert.equal(f.auth.session({ headers: { cookie: first.cookie } }), null);
  const g = f.guest(), second = await f.request('login', { cookie: g.cookie, csrf: g.csrfToken, body: { username: 'Alice', password: '123456' } });
  for (let i = 0; i < 13; i++) { f.advance(LIMITS.sessionIdleMs / 2); assert(f.auth.session({ headers: { cookie: second.cookie } })); }
  f.advance(LIMITS.sessionIdleMs / 2);
  assert.equal(f.auth.session({ headers: { cookie: second.cookie } }), null);
});

test('rate limits survive a new authenticator, ignore untrusted forwarded IPs, and honor explicit trusted proxies', async t => {
  const f = fixture(t), g = f.guest();
  for (let i = 0; i < LIMITS.signupAttempts; i++) {
    const result = await f.signup(f.guest(), `User${i}`, { headers: { 'x-forwarded-for': `192.0.2.${i}`, 'x-workspace-client-ip': `192.0.2.${i}` } });
    assert.equal(result.status, 200);
  }
  const second = new ChatAccountAuth(f.store, f.config, f.owner);
  assert.throws(() => second.rate('127.0.0.1', 'signup'), { code: 'account_rate_limited' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_account_rate_limits').get().n, 1);
  f.advance(LIMITS.rateWindowMs);
  assert.doesNotThrow(() => second.rate('127.0.0.1', 'signup'));
  const proxy = fixture(t, { trustedProxyIPs: ['127.0.0.1'] }), pg = proxy.guest();
  assert.equal((await proxy.signup(pg)).code, 'invalid_client_ip');
  assert.equal((await proxy.signup(pg, 'Alice', { headers: { 'x-workspace-client-ip': '192.0.2.1' } })).status, 200);
});

test('password work is bounded across instances and same-client concurrent requests cannot queue password work', async t => {
  const f = fixture(t);
  let release;
  const blocker = new Promise(resolve => { release = resolve; });
  const first = f.auth.withPasswordWork('192.0.2.1', 'login', () => blocker);
  const secondAuth = new ChatAccountAuth(f.store, f.config, f.owner);
  await assert.rejects(secondAuth.withPasswordWork('192.0.2.1', 'login', () => true), { code: 'account_busy' });
  const second = secondAuth.withPasswordWork('192.0.2.2', 'login', () => blocker);
  await assert.rejects(f.auth.withPasswordWork('192.0.2.3', 'login', () => true), { code: 'account_busy' });
  release(); await Promise.all([first, second]);
  assert.equal(await f.auth.withPasswordWork('192.0.2.1', 'login', () => true), true);
});

test('account, session, rate and idempotency storage caps reject safely and transactions roll back migration', async t => {
  const f = fixture(t), first = await f.signup(f.guest()), g = f.guest(), id = addThread(f.store, g);
  f.store.transaction(() => {
    const insert = f.store.db.prepare('INSERT INTO chat_account_sessions(id_hash, principal, csrf, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)');
    const account = f.store.db.prepare('SELECT * FROM chat_accounts').get();
    // Other principals must occupy global session capacity; current-account rows
    // would correctly be evicted by its independent ten-device ceiling.
    f.store.db.prepare('INSERT INTO chat_accounts(principal, username, username_key, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run('account:' + 'f'.repeat(32), 'Other', 'other', account.password_hash, f.now());
    for (let i = 1; i < LIMITS.sessions; i++) insert.run(digest(`session${i}`), 'account:' + 'f'.repeat(32), 'csrf', f.now(), f.now() + LIMITS.sessionTtlMs, f.now());
  });
  const full = await f.request('login', { cookie: g.cookie, csrf: g.csrfToken, body: { username: 'Alice', password: '123456' } });
  assert.equal(full.code, 'account_capacity');
  assert.equal(f.store.db.prepare('SELECT principal FROM chat_threads WHERE id = ?').get(id).principal, g.principal);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_guest_sessions WHERE principal = ?').get(g.principal).n, 1);
  assert.equal(f.auth.session({ headers: { cookie: first.cookie } }).principal, first.data.identity);
  f.store.db.prepare('DELETE FROM chat_account_sessions').run();
  f.store.transaction(() => {
    const insert = f.store.db.prepare('INSERT INTO chat_account_rate_limits(bucket, started_at, attempts) VALUES (?, ?, 1)');
    f.store.db.prepare('DELETE FROM chat_account_rate_limits').run();
    for (let i = 0; i < LIMITS.rateBuckets; i++) insert.run(`bucket${i}`, f.now());
  });
  assert.throws(() => f.auth.rate('198.51.100.1', 'login'), { code: 'account_capacity' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_account_rate_limits').get().n, LIMITS.rateBuckets);
});

test('account/password/session state persists across database reopen without global account exposure', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-account-test-')), path = join(dir, 'state.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(t, {}, path), result = await f.signup(f.guest());
  const other = new TaskStore(path, { now: f.now });
  t.after(() => other.close());
  const auth = new ChatAccountAuth(other, f.config, new OwnerAuth(other, f.config));
  assert.equal(auth.session({ headers: { cookie: result.cookie } }).principal, result.data.identity);
  assert.equal((await f.request('accounts', { method: 'GET', cookie: result.cookie })).status, 404);
  assert.equal((await f.request('session?username=Alice')).status, 400);
});

test('a login body arriving after logout cannot revive the revoked account session', async t => {
  const f = fixture(t), first = await f.signup(f.guest()), stream = new PassThrough();
  const delayed = f.request('login', { cookie: first.cookie, csrf: first.data.csrfToken, rawStream: stream });
  stream.write('{"use');
  await new Promise(setImmediate);
  const logout = await f.request('logout', { cookie: first.cookie, csrf: first.data.csrfToken });
  assert.equal(logout.status, 200);
  stream.end('rname":"Alice","password":"123456"}');
  const result = await delayed;
  assert.equal(result.status, 401); assert.equal(result.code, 'chat_session_required');
  assert.equal(result.cookie, undefined);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_account_sessions').get().n, 0);
});

test('a completed password check after logout cannot revive the revoked account session', async t => {
  const f = fixture(t), first = await f.signup(f.guest());
  const verify = f.auth.verify.bind(f.auth);
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const checking = new Promise(resolve => { reached = resolve; });
  f.auth.verify = async (...args) => { const result = await verify(...args); reached(); await gate; return result; };
  const delayed = f.request('login', { cookie: first.cookie, csrf: first.data.csrfToken, body: { username: 'Alice', password: '123456' } });
  await checking;
  assert.equal((await f.request('logout', { cookie: first.cookie, csrf: first.data.csrfToken })).status, 200);
  release();
  assert.equal((await delayed).code, 'chat_session_required');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_account_sessions').get().n, 0);
});

test('revoked or expired guest source cannot finish delayed signup and create an account', async t => {
  const f = fixture(t), guest = f.guest(), stream = new PassThrough();
  const delayed = f.request('signup', { cookie: guest.cookie, csrf: guest.csrfToken, rawStream: stream });
  stream.write('{"use');
  await new Promise(setImmediate);
  f.store.db.prepare('DELETE FROM chat_guest_sessions WHERE principal = ?').run(guest.principal);
  stream.end('rname":"Late","password":"123456"}');
  assert.equal((await delayed).code, 'chat_session_required');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_accounts').get().n, 0);
  const expired = f.guest(), expiredStream = new PassThrough();
  const pending = f.request('signup', { cookie: expired.cookie, csrf: expired.csrfToken, rawStream: expiredStream });
  expiredStream.write('{"use'); await new Promise(setImmediate);
  f.advance(LIMITS.sessionIdleMs);
  expiredStream.end('rname":"Late","password":"123456"}');
  assert.equal((await pending).code, 'chat_session_required');
});

test('migration thread and byte limits roll back atomically and retain guest credentials and history', async t => {
  const f = fixture(t), first = await f.signup(f.guest()), account = { principal: first.data.identity };
  f.store.transaction(() => { for (let i = 0; i < LIMITS.accountThreads; i++) addThread(f.store, account); });
  const guest = f.guest(), thread = addThread(f.store, guest);
  const login = await f.request('login', { cookie: guest.cookie, csrf: guest.csrfToken, body: { username: 'Alice', password: '123456' } });
  assert.equal(login.code, 'account_migration_limit');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_threads WHERE principal = ?').get(account.principal).n, LIMITS.accountThreads);
  assert.equal(f.store.db.prepare('SELECT principal FROM chat_threads WHERE id = ?').get(thread).principal, guest.principal);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_guest_sessions WHERE principal = ?').get(guest.principal).n, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_account_sessions').get().n, 1);
  const other = fixture(t), oversized = other.guest(), largeThread = addThread(other.store, oversized);
  other.store.db.prepare('UPDATE chat_messages SET content_bytes = ? WHERE thread_id = ?').run(LIMITS.principalBytes + 1, largeThread);
  const signup = await other.signup(oversized);
  assert.equal(signup.code, 'account_migration_limit');
  assert.equal(other.store.db.prepare('SELECT COUNT(*) AS n FROM chat_accounts').get().n, 0);
  assert.equal(other.store.db.prepare('SELECT COUNT(*) AS n FROM chat_account_sessions').get().n, 0);
  assert.equal(other.store.db.prepare('SELECT COUNT(*) AS n FROM chat_account_idempotency').get().n, 0);
  assert.equal(other.store.db.prepare('SELECT principal FROM chat_threads WHERE id = ?').get(largeThread).principal, oversized.principal);
  assert.equal(other.store.db.prepare('SELECT COUNT(*) AS n FROM chat_guest_sessions').get().n, 1);
});
