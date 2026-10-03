import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scryptSync, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TaskStore } from '../store.mjs';
import { OwnerAuth, digest } from '../auth.mjs';
import { WorkspaceStore, emptyWorkspace } from '../workspace.mjs';
import { createApiServer, listen } from '../server.mjs';
import { readConfig } from '../config.mjs';
import { TaskWorker } from '../worker.mjs';

// Fictional test fixture only; never used as a deployed owner credential.
const PASSWORD = 'fictional-owner-test-password';
const salt = Buffer.alloc(16, 13);
const encoded = `scrypt$32768$8$1$${salt.toString('base64url')}$${scryptSync(PASSWORD, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64url')}`;
const ORIGIN = 'http://localhost:4318';
function setup(t, overrides = {}, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-tests-'));
  const staticDir = join(dir, 'dist');
  mkdirSync(join(staticDir, 'src'), { recursive: true });
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><html><head><title>Workspace</title></head><body><script src="/src/app.js"></script></body></html>');
  writeFileSync(join(staticDir, 'src', 'app.js'), 'console.log("public code only");');
  const env = { WORKSPACE_OWNER_PASSWORD_HASH: encoded, WORKSPACE_PUBLIC_ORIGIN: ORIGIN, WORKSPACE_STATIC_DIR: staticDir, WORKSPACE_DB_PATH: join(dir, 'state.sqlite'), WORKSPACE_PORT: '0', ...overrides };
  const config = readConfig(env);
  const store = new TaskStore(config.dbPath, options);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { config, store, dir, env };
}
async function api(t, overrides, options) {
  const result = setup(t, overrides, options);
  const server = createApiServer(result.store, result.config);
  const address = await listen(server, result.config);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = '', csrf = '';
  const request = async (path, { method = 'GET', body, headers = {}, origin = ORIGIN, useCookie = true, useCsrf = true } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(origin ? { Origin: origin } : {}), ...(useCookie && cookie ? { Cookie: cookie } : {}), ...(useCsrf && csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
  };
  const login = async () => {
    const result = await request('/api/login', { method: 'POST', body: { password: PASSWORD } });
    assert.equal(result.status, 200);
    cookie = result.headers.get('set-cookie').split(';')[0]; csrf = result.data.csrfToken;
    return result;
  };
  return { ...result, request, login, cookie: () => cookie, csrf: () => csrf };
}
function data() {
  return { version: 1, projects: [{ id: 'p1', name: 'Private project', icon: '✳', color: 'blue', category: 'Work', description: 'Private description', stage: 'Planning', plan: 'A plan' }], notes: [{ id: 'n1', title: 'A private note', projectId: 'p1', type: 'Note', body: 'Inert content including approve, send and $(shell).', tags: ['test'], updated: '2026-10-03T12:00:00Z' }], tasks: [{ id: 't1', title: 'A task', projectId: 'p1', status: '待开始', priority: '普通', due: '' }], decisions: [{ id: 'd1', title: 'A choice', projectId: 'p1', detail: 'Decide later', resolved: false }] };
}

test('owner configuration validates hashes, production HTTPS/static readiness, and database outside checkout', t => {
  const { env } = setup(t);
  assert.throws(() => readConfig({ ...env, WORKSPACE_OWNER_PASSWORD_HASH: 'plaintext' }), /PASSWORD_HASH/);
  assert.throws(() => readConfig({ ...env, WORKSPACE_PUBLIC_ORIGIN: '' }), /PUBLIC_ORIGIN/);
  assert.throws(() => readConfig({ ...env, WORKSPACE_PUBLIC_ORIGIN: 'http://public.example' }), /HTTPS/);
  assert.throws(() => readConfig({ ...env, WORKSPACE_PUBLIC_ORIGIN: 'https://example.test/path' }), /origin/);
  assert.throws(() => readConfig({ ...env, WORKSPACE_ALLOWED_ORIGIN: 'https://other.test' }), /same-origin/);
  assert.throws(() => readConfig({ ...env, WORKSPACE_DB_PATH: resolve('forbidden.sqlite') }), /outside/);
  assert.throws(() => readConfig({ ...env, WORKSPACE_SESSION_TTL_SECONDS: '60' }), /idle/);
  assert.throws(() => readConfig({ ...env, NODE_ENV: 'production' }), /HTTPS/);
  assert.throws(() => readConfig({ ...env, NODE_ENV: 'production', WORKSPACE_OWNER_PASSWORD_HASH: '', WORKSPACE_API_TOKEN: 'a'.repeat(32) }), /Production requires/);
  assert.throws(() => readConfig({ ...env, NODE_ENV: 'production', WORKSPACE_PUBLIC_ORIGIN: 'https://owner.test', WORKSPACE_STATIC_DIR: '/tmp/definitely-unbuilt-workspace' }), /built/);
  assert.equal(readConfig({ ...env, NODE_ENV: 'production', WORKSPACE_PUBLIC_ORIGIN: 'https://owner.test' }).production, true);
  assert.throws(() => readConfig({ ...env, WORKSPACE_DB_PATH: join(env.WORKSPACE_STATIC_DIR, 'src', 'state.js') }), /outside the static/);
  assert.throws(() => readConfig({ ...env, NODE_ENV: 'production', WORKSPACE_PUBLIC_ORIGIN: 'https://owner.test', WORKSPACE_HOST: '0.0.0.0' }), /loopback/);
});

test('anonymous users see only public static/session/health; private API is protected and secrets never returned', async t => {
  const { request } = await api(t, { WORKSPACE_RELEASE: 'revision-test' });
  assert.deepEqual((await request('/health')).data, { ok: true, releaseId: 'revision-test' });
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(page.data, /<meta name="workspace-mode" content="server">/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await request('/src/app.js')).status, 200);
  for (const path of ['/backend/.env', '/.git/config', '/src/../../backend/config.mjs', '/preview.html', '/src/app.js%00']) assert.notEqual((await request(path)).status, 200);
  const session = await request('/api/session');
  assert.equal(session.data.authenticated, false);
  assert.equal(session.data.loginConfigured, true);
  assert.equal(session.data.csrfToken, undefined);
  assert.equal(session.data.owner, undefined);
  for (const path of ['/api/workspace', '/api/tasks', '/api/status']) assert.equal((await request(path)).status, 401);
  assert.equal((await request('/api/workspace', { headers: { Cookie: 'workspace_session=forged' } })).status, 401);
  assert(!JSON.stringify(session.data).includes(encoded));
});

test('login requires matching Origin; session uses HttpOnly SameSite, rotates on login, persists only hashed identifier, and logout revokes', async t => {
  const client = await api(t);
  const { request, login, store } = client;
  assert.equal((await request('/api/login', { method: 'POST', origin: '', body: { password: PASSWORD } })).status, 403);
  assert.equal((await request('/api/login', { method: 'POST', origin: 'https://attacker.test', body: { password: PASSWORD } })).status, 403);
  assert.equal((await request('/api/login', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' }, body: { password: PASSWORD } })).status, 403);
  assert.equal((await request('/api/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  const first = await login();
  assert.match(first.headers.get('set-cookie'), /HttpOnly; SameSite=Strict;/);
  assert.equal(first.data.authenticated, true);
  const old = client.cookie();
  const rawId = old.split('=')[1];
  const row = store.db.prepare('SELECT * FROM owner_sessions').get();
  assert.equal(row.id_hash, digest(rawId));
  assert(!JSON.stringify(row).includes(rawId));
  assert(!JSON.stringify(first.data).includes(PASSWORD));
  assert(!JSON.stringify(first.data).includes(encoded));
  await login();
  assert.notEqual(client.cookie(), old);
  assert.equal((await request('/api/workspace', { headers: { Cookie: old } })).status, 401);
  assert.equal((await request('/api/session')).data.csrfToken, client.csrf());
  assert.equal((await request('/api/logout', { method: 'POST', body: {}, useCsrf: false })).status, 403);
  const logout = await request('/api/logout', { method: 'POST', body: {} });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request('/api/workspace')).status, 401);
});

test('production uses host-only Secure cookie and refuses cross-origin writes even with valid CSRF', async t => {
  const client = await api(t, { NODE_ENV: 'production', WORKSPACE_PUBLIC_ORIGIN: 'https://owner.test' });
  const logged = await client.request('/api/login', { method: 'POST', origin: 'https://owner.test', body: { password: PASSWORD } });
  assert.equal(logged.status, 200);
  assert.match(logged.headers.get('set-cookie'), /^__Host-workspace_session=/);
  assert.match(logged.headers.get('set-cookie'), /; Secure$/);
  assert(!logged.headers.get('set-cookie').includes('Domain='));
  const headers = { Cookie: logged.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': logged.data.csrfToken };
  assert.equal((await client.request('/api/workspace', { method: 'PUT', origin: 'https://attacker.test', headers, body: { revision: 0, workspace: data() } })).status, 403);
});

test('workspace writes are CSRF-protected, validated, revision checked and durable across SQLite connections', async t => {
  const { request, login, config, store } = await api(t);
  await login();
  assert.deepEqual((await request('/api/workspace')).data, { revision: 0, updatedAt: null, workspace: emptyWorkspace() });
  const body = { revision: 0, workspace: data() };
  assert.equal((await request('/api/workspace', { method: 'PUT', body, useCsrf: false })).status, 403);
  assert.equal((await request('/api/workspace', { method: 'PUT', body, origin: '' })).status, 403);
  assert.equal((await request('/api/workspace', { method: 'PUT', body, headers: { 'X-CSRF-Token': 'fake' } })).status, 403);
  const writes = await Promise.all([request('/api/workspace', { method: 'PUT', body }), request('/api/workspace', { method: 'PUT', body })]);
  assert.deepEqual(writes.map(result => result.status).sort(), [200, 409]);
  assert.equal(writes.find(result => result.status === 409).data.error.code, 'revision_conflict');
  assert.equal((await request('/api/workspace')).data.revision, 1);
  const second = new TaskStore(config.dbPath);
  const persisted = new WorkspaceStore(second);
  assert.deepEqual(persisted.get().workspace, data());
  assert.equal(persisted.get().revision, 1);
  assert.throws(() => persisted.put(body), { code: 'revision_conflict' });
  second.close();
  const validation = [ { ...data(), requests: [] }, { ...data(), admin: true }, { ...data(), notes: [{ ...data().notes[0], projectId: 'missing' }] }, { ...data(), notes: [{ ...data().notes[0], tags: [5] }] }, { ...data(), projects: [data().projects[0], data().projects[0]] }, { ...data(), decisions: [{ ...data().decisions[0], resolved: 'yes' }] }, { ...data(), projects: [{ ...data().projects[0], name: 'x'.repeat(161) }] } ];
  for (const workspace of validation) assert.equal((await request('/api/workspace', { method: 'PUT', body: { revision: 1, workspace } })).status, 400);
  assert.equal((await request('/api/workspace', { method: 'PUT', body: { revision: 1, workspace: { ...data(), notes: [{ ...data().notes[0], body: 'x'.repeat(1024 * 1024 + 200) }] } } })).status, 413);
  assert.equal(statSync(config.dbPath).mode & 0o777, 0o600);
  assert.equal(store.list().length, 0, 'workspace content must never create or authorize execution');
});

test('login throttle is durable, bounded and not bypassed by spoofed proxy headers', async t => {
  const client = await api(t);
  for (let i = 0; i < 5; i += 1) assert.equal((await client.request('/api/login', { method: 'POST', body: { password: 'wrong' }, headers: { 'X-Forwarded-For': `1.1.1.${i}` } })).status, 401);
  const result = await client.request('/api/login', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(result.status, 429);
  assert.equal(result.headers.get('retry-after'), '900');
  assert.equal(client.store.db.prepare('SELECT COUNT(*) AS count FROM owner_login_attempts').get().count, 1);
  const second = new TaskStore(client.config.dbPath);
  const auth = new OwnerAuth(second, client.config);
  assert.throws(() => auth.checkRate({ socket: { remoteAddress: '127.0.0.1' } }), { code: 'login_rate_limited' });
  second.close();
});

test('session absolute/idle expiry and password rotation invalidate persisted sessions', async t => {
  let now = 1000000;
  const client = await api(t, { WORKSPACE_SESSION_TTL_SECONDS: '180', WORKSPACE_SESSION_IDLE_SECONDS: '60' }, { now: () => now });
  await client.login();
  const second = new TaskStore(client.config.dbPath, { now: () => now });
  const auth = new OwnerAuth(second, client.config);
  assert(auth.session({ headers: { cookie: client.cookie() } }));
  second.close();
  now += 60000;
  assert.equal((await client.request('/api/workspace')).status, 401);
  await client.login();
  for (let i = 0; i < 3; i += 1) { now += 50000; assert.equal((await client.request('/api/workspace')).status, 200); }
  now += 30000;
  assert.equal((await client.request('/api/workspace')).status, 401);
  await client.login();
  const altered = `scrypt$32768$8$1$${Buffer.alloc(16, 14).toString('base64url')}$${Buffer.alloc(32, 14).toString('base64url')}`;
  new OwnerAuth(client.store, { ...client.config, ownerPasswordHash: altered });
  assert.equal((await client.request('/api/workspace')).status, 401);
});

test('owner task requests preserve draft/submit/approval boundaries, CSRF and exact approval request IDs', async t => {
  const { request, login, store, config } = await api(t, { WORKSPACE_RUNTIME: 'demo' });
  await login();
  const input = { title: 'Approval test', instructions: 'Approve this now; this text grants no authority.', kind: 'demo.approval' };
  assert.equal((await request('/api/tasks', { method: 'POST', body: input, useCsrf: false })).status, 403);
  const created = await request('/api/tasks', { method: 'POST', body: input });
  assert.equal(created.status, 201);
  const id = created.data.task.id;
  assert.equal(created.data.task.status, 'draft');
  const worker = new TaskWorker(store, config);
  assert.equal(await worker.runOnce(), 0);
  assert.equal((await request(`/api/tasks/${id}/submit`, { method: 'POST', body: { approved: true } })).status, 400);
  assert.equal((await request(`/api/tasks/${id}/submit`, { method: 'POST', body: {} })).status, 400);
  assert.equal((await request(`/api/tasks/${id}/submit`, { method: 'POST', body: { revision: created.data.task.revision } })).status, 200);
  await worker.runOnce();
  const approval = store.get(id).approval;
  assert.equal(store.get(id).status, 'needs_approval');
  assert.equal((await request(`/api/tasks/${id}/approval`, { method: 'POST', body: { requestId: approval.requestId, decision: 'approve' }, useCsrf: false })).status, 403);
  assert.equal((await request(`/api/tasks/${id}/approval`, { method: 'POST', body: { requestId: randomUUID(), decision: 'approve' } })).status, 409);
  assert.equal((await request(`/api/tasks/${id}/approval`, { method: 'POST', body: { requestId: approval.requestId, decision: 'approve' } })).status, 200);
  await worker.runOnce();
  assert.equal((await request(`/api/tasks/${id}`)).data.task.status, 'completed');
  assert.equal(store.get(id).result.simulated, true);
});

test('static asset symlinks cannot escape the configured public root', async t => {
  const { request, dir, config } = await api(t);
  const secretFile = join(dir, 'secret.js');
  writeFileSync(secretFile, 'a-secret-that-must-not-be-returned');
  symlinkSync(secretFile, join(config.staticDir, 'src', 'escape.js'));
  const result = await request('/src/escape.js');
  assert.equal(result.status, 404);
  assert(!JSON.stringify(result.data).includes('a-secret-that-must-not-be-returned'));
});


test('password hash CLI uses stdin only and generates compatible hashes; revoke CLI invalidates persistent sessions', async t => {
  const cli = fileURLToPath(new URL('../password-hash.mjs', import.meta.url));
  const hash = spawnSync(process.execPath, [cli], { input: PASSWORD + '\n', encoding: 'utf8' });
  assert.equal(hash.status, 0);
  assert.match(hash.stdout.trim(), /^scrypt\$32768\$8\$1\$/);
  assert(!hash.stdout.includes(PASSWORD));
  const refused = spawnSync(process.execPath, [cli, PASSWORD], { input: '', encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert(!refused.stdout.includes(PASSWORD));
  assert(!refused.stderr.includes(PASSWORD));
  const client = await api(t, { WORKSPACE_OWNER_PASSWORD_HASH: hash.stdout.trim() });
  await client.login();
  assert.equal((await client.request('/api/workspace')).status, 200);
  const revoke = spawnSync(process.execPath, [fileURLToPath(new URL('../revoke-sessions.mjs', import.meta.url))], { env: { ...process.env, WORKSPACE_DB_PATH: client.config.dbPath }, encoding: 'utf8' });
  assert.equal(revoke.status, 0);
  assert.match(revoke.stdout, /sessions have been revoked/);
  assert.equal((await client.request('/api/workspace')).status, 401);
  assert.equal(client.store.db.prepare('SELECT COUNT(*) AS count FROM owner_sessions').get().count, 0);
});


test('browser submission atomically binds authorization to the exact reviewed draft revision', async t => {
  const { request, login, store } = await api(t);
  await login();
  const created = await request('/api/tasks', { method: 'POST', body: { title: 'Reviewed draft', instructions: 'The text the owner reviewed.', kind: 'task' } });
  const id = created.data.task.id;
  const reviewedRevision = created.data.task.revision;
  const changed = await request(`/api/tasks/${id}`, { method: 'PATCH', body: { instructions: 'Different text saved in a second tab.' } });
  assert.equal(changed.data.task.revision, reviewedRevision + 1);
  const key = randomUUID();
  const stale = await request(`/api/tasks/${id}/submit`, { method: 'POST', body: { revision: reviewedRevision }, headers: { 'Idempotency-Key': key } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.code, 'revision_conflict');
  assert.equal(store.get(id).status, 'draft');
  assert.equal(store.get(id).submittedAt, null);
  assert.equal(store.events(id).some(event => event.type === 'submitted'), false);
  for (const revision of [null, 0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) assert.equal((await request(`/api/tasks/${id}/submit`, { method: 'POST', body: { revision } })).status, 400);
  const exact = await request(`/api/tasks/${id}/submit`, { method: 'POST', body: { revision: changed.data.task.revision }, headers: { 'Idempotency-Key': key } });
  assert.equal(exact.status, 200);
  assert.equal(exact.data.task.status, 'pending');
  const replay = await request(`/api/tasks/${id}/submit`, { method: 'POST', body: { revision: changed.data.task.revision }, headers: { 'Idempotency-Key': key } });
  assert.equal(replay.status, 200);
  assert.equal(store.events(id).filter(event => event.type === 'submitted').length, 1);
  const changedReplay = await request(`/api/tasks/${id}/submit`, { method: 'POST', body: { revision: reviewedRevision }, headers: { 'Idempotency-Key': key } });
  assert.equal(changedReplay.status, 409);
  assert.equal(changedReplay.data.error.code, 'idempotency_conflict');
});


test('successful logins never spend failure quota, invalid bodies do not count, and a success clears client failures', async t => {
  const client = await api(t);
  for (const body of [{}, { password: '' }, { password: 4 }, { password: 'wrong', extra: true }, { password: 'x'.repeat(1025) }]) assert.equal((await client.request('/api/login', { method: 'POST', body })).status, 400);
  assert.equal(client.store.db.prepare('SELECT COUNT(*) AS count FROM owner_login_attempts').get().count, 0);
  for (let i = 0; i < 6; i += 1) await client.login();
  assert.equal(client.store.db.prepare('SELECT COUNT(*) AS count FROM owner_login_attempts').get().count, 0);
  for (let i = 0; i < 4; i += 1) assert.equal((await client.request('/api/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  assert.equal(client.store.db.prepare('SELECT attempts FROM owner_login_attempts').get().attempts, 4);
  await client.login();
  assert.equal(client.store.db.prepare('SELECT COUNT(*) AS count FROM owner_login_attempts').get().count, 0);
  assert.equal((await client.request('/api/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  assert.equal(client.store.db.prepare('SELECT attempts FROM owner_login_attempts').get().attempts, 1);
});

test('trusted proxy configuration accepts exact loopback peers only and ignores spoofed headers from other peers', t => {
  const { store, config, env } = setup(t);
  for (const value of ['true', '*', 'localhost', '127.0.0.0/8', '0.0.0.0/0', '192.0.2.1', '127.0.0.1,', '::1,127.0.0.1,::1']) assert.throws(() => readConfig({ ...env, WORKSPACE_TRUST_PROXY: value }), /TRUST_PROXY/);
  const auth = new OwnerAuth(store, readConfig({ ...env, WORKSPACE_TRUST_PROXY: '127.0.0.1,::1' }));
  const req = (peer, value, xff = '198.51.100.99') => ({ socket: { remoteAddress: peer }, headers: { 'x-workspace-client-ip': value, 'x-forwarded-for': xff } });
  assert.equal(auth.clientAddress(req('127.0.0.1', '203.0.113.7')), '203.0.113.7');
  assert.equal(auth.clientAddress(req('::ffff:127.0.0.1', '203.0.113.7')), '203.0.113.7');
  assert.equal(auth.clientAddress(req('::1', '2001:0db8:0000:0000:0000:0000:0000:0001')), '2001:db8::1');
  assert.equal(auth.clientAddress(req('::1', '::ffff:203.0.113.7')), '203.0.113.7');
  assert.equal(auth.clientAddress(req('192.0.2.9', '203.0.113.7')), '192.0.2.9');
  assert.equal(auth.clientAddress(req('192.0.2.9', 'invalid spoofed header')), '192.0.2.9');
  const defaultAuth = new OwnerAuth(store, config);
  assert.equal(defaultAuth.clientAddress(req('127.0.0.1', '203.0.113.7')), '127.0.0.1');
  for (const value of [undefined, '', '203.0.113.7, 198.51.100.9', ['203.0.113.7'], 'unknown', '203.0.113.7:443', '[::1]', 'fe80::1%eth0', ' 203.0.113.7', '203.0.113.7 ']) assert.throws(() => auth.clientAddress(req('127.0.0.1', value)), { code: 'invalid_client_ip' });
  assert.throws(() => auth.clientAddress({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.7' } }), { code: 'invalid_client_ip' });
});

test('trusted clients have separate failed-password quotas and malformed proxy input cannot trigger password work', async t => {
  const client = await api(t, { WORKSPACE_TRUST_PROXY: '127.0.0.1' });
  const headersA = { 'X-Workspace-Client-IP': '203.0.113.7' };
  const headersB = { 'X-Workspace-Client-IP': '203.0.113.8' };
  for (const headers of [{}, { 'X-Workspace-Client-IP': '203.0.113.7, 203.0.113.8' }, { 'X-Workspace-Client-IP': 'invalid' }]) assert.equal((await client.request('/api/login', { method: 'POST', body: { password: PASSWORD }, headers })).status, 400);
  assert.equal(client.store.db.prepare('SELECT COUNT(*) AS count FROM owner_login_attempts').get().count, 0);
  for (let i = 0; i < 5; i += 1) assert.equal((await client.request('/api/login', { method: 'POST', body: { password: 'wrong' }, headers: headersA })).status, 401);
  assert.equal((await client.request('/api/login', { method: 'POST', body: { password: PASSWORD }, headers: headersA })).status, 429);
  assert.equal((await client.request('/api/login', { method: 'POST', body: { password: PASSWORD }, headers: headersB })).status, 200);
  assert.equal(client.store.db.prepare("SELECT COUNT(*) AS count FROM owner_login_attempts WHERE bucket = 'global'").get().count, 0);
});

test('password work is bounded to two checks per process and one per client without queueing or counting shed work', async t => {
  const { store, config } = setup(t, { WORKSPACE_TRUST_PROXY: '127.0.0.1' });
  const firstAuth = new OwnerAuth(store, config), secondAuth = new OwnerAuth(store, config);
  const releases = [];
  let active = 0, maximum = 0;
  const verify = async () => {
    active += 1; maximum = Math.max(maximum, active);
    await new Promise(resolve => releases.push(resolve));
    active -= 1;
    return true;
  };
  t.mock.method(firstAuth, 'verifyPassword', verify);
  t.mock.method(secondAuth, 'verifyPassword', verify);
  const req = client => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { origin: ORIGIN, 'x-workspace-client-ip': client } });
  const res = { setHeader() {} };
  const first = firstAuth.login(req('203.0.113.1'), res, { password: PASSWORD });
  await assert.rejects(secondAuth.login(req('203.0.113.1'), res, { password: PASSWORD }), { code: 'login_busy' });
  const second = secondAuth.login(req('203.0.113.2'), res, { password: PASSWORD });
  await assert.rejects(firstAuth.login(req('203.0.113.3'), res, { password: PASSWORD }), { code: 'login_busy' });
  assert.equal(releases.length, 2);
  assert.equal(maximum, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM owner_login_attempts').get().count, 0);
  for (const release of releases.splice(0)) release();
  await Promise.all([first, second]);
  const next = firstAuth.login(req('203.0.113.3'), res, { password: PASSWORD });
  assert.equal(releases.length, 1);
  releases.pop()();
  assert.equal((await next).authenticated, true);
  assert.equal(active, 0);
});

test('failed-client history is bounded and old global lockout state is discarded', t => {
  const { store, config } = setup(t);
  const auth = new OwnerAuth(store, config);
  store.transaction(() => {
    const insert = store.db.prepare('INSERT INTO owner_login_attempts(bucket, started_at, attempts) VALUES (?, ?, ?)');
    for (let i = 0; i < 4100; i += 1) insert.run(`ip:fixture-${i}`, store.now(), 1);
    insert.run('global', store.now(), 50);
  });
  new OwnerAuth(store, config);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM owner_login_attempts WHERE bucket = 'global'").get().count, 0);
  auth.recordFailure('203.0.113.9');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM owner_login_attempts').get().count, 4096);
});
