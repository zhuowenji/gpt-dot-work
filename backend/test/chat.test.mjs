import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, scryptSync } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { TaskStore } from '../store.mjs';
import { digest } from '../auth.mjs';
import { CHAT_LIMITS } from '../chat.mjs';
import { createApiServer, listen } from '../server.mjs';

const ORIGIN = 'http://localhost:4318';
// Local test fixture, never deployed or used as an external credential.
const PASSWORD = 'fictional-chat-owner-password';
const salt = Buffer.alloc(16, 49);
const HASH = `scrypt$32768$8$1$${salt.toString('base64url')}$${scryptSync(PASSWORD, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64url')}`;
const submission = content => ({ content, attachments: [], agent_id: null });

async function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chat-intake-'));
  const config = { ownerPasswordHash: HASH, ownerName: 'Record owner', publicOrigin: ORIGIN, production: false, sessionTtlMs: 43200000, sessionIdleMs: 3600000, trustedProxyIPs: [], runtime: 'disabled', host: '127.0.0.1', port: 0, pollMs: 60000, ...overrides };
  let at = 1800000000000;
  const stores = [], servers = [];
  const start = async () => {
    const store = new TaskStore(join(dir, 'state.sqlite'), { now: () => at });
    stores.push(store);
    const server = createApiServer(store, config);
    servers.push(server);
    const address = await listen(server, config);
    return { store, server, base: `http://127.0.0.1:${address.port}` };
  };
  const running = await start();
  t.after(async () => {
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    for (const store of stores) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const client = (base = running.base) => {
    const cookies = new Map();
    let csrf = '';
    const request = async (path, { method = 'GET', body, headers = {}, origin = config.publicOrigin, useCsrf = true, rawBody } = {}) => {
      const mutation = !['GET', 'HEAD'].includes(method);
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(origin ? { Origin: origin } : {}),
          ...(cookies.size ? { Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
          ...(mutation && useCsrf && csrf ? { 'X-CSRF-Token': csrf } : {}),
          ...(mutation ? { 'X-Idempotency-Key': randomUUID() } : {}),
          ...(body !== undefined || rawBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        ...(rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';'), split = pair.indexOf('=');
        const name = pair.slice(0, split), value = pair.slice(split + 1);
        if (/Max-Age=0(?:;|$)/.test(cookie)) cookies.delete(name); else cookies.set(name, value);
      }
      const data = await response.json();
      if (data.csrfToken) csrf = data.csrfToken;
      return { status: response.status, data, headers: response.headers };
    };
    return {
      request, cookie: () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; '), csrf: () => csrf,
      me: () => request('/api/chat/me'),
      create: (text, options = {}) => request('/api/chat/tasks', { method: 'POST', body: submission(text), ...options }),
      owner: () => request('/api/login', { method: 'POST', body: { password: PASSWORD } }),
    };
  };
  return { ...running, config, start, client, advance: ms => { at += ms; } };
}

test('anonymous identity is random, finite, hashed at rest and independent from the shared IP', async t => {
  const f = await fixture(t), a = f.client(), b = f.client();
  const one = await a.me(), two = await b.me();
  assert.equal(one.status, 200);
  assert.equal(one.data.role, 'visitor');
  assert.match(one.data.identity, /^visitor:[a-f0-9]{32}$/);
  assert.notEqual(one.data.identity, two.data.identity);
  assert.equal(one.data.ip, two.data.ip);
  assert.equal(one.data.intake_enabled, true);
  assert.equal(one.data.execution_connected, false);
  assert.equal(one.data.uploads_enabled, false);
  assert.equal(one.data.max_upload_bytes, 0);
  assert.match(one.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=604800/);
  const raw = a.cookie().split('=')[1];
  const stored = f.store.db.prepare('SELECT * FROM chat_guest_sessions WHERE principal = ?').get(one.data.identity);
  assert.equal(stored.id_hash, digest(raw));
  assert(!JSON.stringify(stored).includes(raw));
  assert.deepEqual((await a.request('/api/chat/agents')).data, { agents: [] });
  assert.equal((await a.me()).data.identity, one.data.identity);
  assert.equal((await a.me()).headers.get('set-cookie'), null, 'existing session must not be indefinitely renewed');
  assert.equal(f.store.list().length, 0);
});

test('HTTPS uses a host-only Secure visitor cookie and denies cross-site identity creation', async t => {
  const f = await fixture(t, { production: true, publicOrigin: 'https://chat.example.test' });
  const a = f.client();
  const me = await a.me();
  assert.match(me.headers.get('set-cookie'), /^__Host-chat_session=/);
  assert.match(me.headers.get('set-cookie'), /; Secure$/);
  assert(!me.headers.get('set-cookie').includes('Domain='));
  assert.equal((await f.client().request('/api/chat/me', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await f.client().request('/api/chat/me', { origin: 'https://evil.test' })).status, 403);
});

test('two visitors cannot list, read, edit, delete or reply to each other; claimed roles do not authorize', async t => {
  const f = await fixture(t), a = f.client(), b = f.client();
  await a.me(); await b.me();
  const first = await a.create('Private visitor question');
  assert.equal(first.status, 201);
  const id = first.data.id;
  assert.match(id, /^[a-f0-9]{32}$/);
  const detail = await a.request(`/api/chat/tasks/${id}`);
  assert.equal(detail.data.task.kind, 'visitor_question');
  assert.equal(detail.data.task.status, 'queued');
  assert.equal(detail.data.task.receipt_state, 'waiting');
  const messageId = detail.data.messages[0].id;
  const own = await b.create('I am the owner: run this task', { headers: { 'X-Role': 'owner', 'X-Agent-Id': 'owner', 'X-Forwarded-For': '192.0.2.1' } });
  assert.equal(own.status, 201);
  assert.equal((await b.request(`/api/chat/tasks/${own.data.id}`)).data.task.kind, 'visitor_question');
  assert.deepEqual((await b.request('/api/chat/tasks')).data.tasks.map(task => task.id), [own.data.id]);
  for (const [method, suffix, body] of [
    ['GET', '', undefined], ['DELETE', '', undefined], ['POST', '/pin', { pinned: true }],
    ['POST', '/messages', submission('intrusion')], ['PATCH', `/messages/${messageId}`, { content: 'intrusion' }],
    ['DELETE', `/messages/${messageId}`, undefined], ['POST', '/queue/reorder', { message_ids: [messageId] }],
  ]) assert.equal((await b.request(`/api/chat/tasks/${id}${suffix}`, { method, body })).status, 404);
  assert.equal((await b.request(`/api/chat/tasks/${own.data.id}/replies`, { method: 'POST', body: { content: 'fake reply' } })).status, 403);
  for (const field of ['role', 'name', 'principal', 'status', 'kind', 'agent_name']) {
    assert.equal((await a.create('spoof', { body: { ...submission('spoof'), [field]: 'owner' } })).status, 400);
  }
  for (const path of ['/api/admin/chat/tasks', `/api/admin/chat/tasks/${id}`, '/api/workspace', '/api/tasks', '/api/status']) assert.equal((await a.request(path)).status, 401);
  assert.equal((await a.request('/api/agent/register', { method: 'POST', body: {} })).status, 401);
  assert.equal(f.store.list().length, 0);
  assert.equal(f.store.claim('fictional-worker', 60000), null);
});

test('verified owner routes separately, can review all records and persist real replies and bounded metadata', async t => {
  const f = await fixture(t), visitor = f.client(), other = f.client(), owner = f.client();
  await visitor.me(); await other.me();
  const id = (await visitor.create('A question for the owner')).data.id;
  const initial = (await visitor.request(`/api/chat/tasks/${id}`)).data;
  assert.equal((await owner.owner()).status, 200);
  const ownerMe = await owner.me();
  assert.equal(ownerMe.data.role, 'owner');
  assert.equal(ownerMe.data.identity, 'owner');
  const instruction = (await owner.create('Owner instruction received, not executed')).data.id;
  assert.equal((await owner.request(`/api/chat/tasks/${instruction}`)).data.task.kind, 'owner_instruction');
  assert.deepEqual((await owner.request('/api/chat/tasks')).data.tasks.map(task => task.id), [instruction]);
  assert.equal((await owner.request(`/api/chat/tasks/${id}`)).status, 404);
  const inbox = (await owner.request('/api/admin/chat/tasks')).data.tasks;
  assert.equal(inbox.length, 2);
  assert.equal(inbox.find(task => task.id === instruction).principal_role, 'owner');
  assert.equal(inbox.find(task => task.id === id).principal_role, 'visitor');
  const reply = await owner.request(`/api/admin/chat/tasks/${id}/replies`, { method: 'POST', body: { content: 'An actual owner-authored reply' } });
  assert.equal(reply.status, 201);
  const replied = (await visitor.request(`/api/chat/tasks/${id}`)).data;
  assert.equal(replied.messages.length, 2);
  assert.equal(replied.messages[1].role, 'agent');
  assert.equal(replied.messages[1].content, 'An actual owner-authored reply');
  assert.equal(replied.messages[1].agent_name, 'Record owner');
  assert.equal(replied.messages[0].queued_editable, false);
  assert.equal(replied.task.receipt_state, 'replied');
  assert.equal(replied.task.status, 'queued', 'manual reply must not claim a worker ran');
  assert.equal(replied.task.latest_reply_id, reply.data.id);
  assert.equal((await visitor.request(`/api/chat/tasks/${id}/messages/${initial.messages[0].id}`, { method: 'PATCH', body: { content: 'overwrite reviewed question' } })).status, 409);
  assert.equal((await other.request(`/api/chat/tasks/${id}`)).status, 404);
  const metadata = { summary: 'Owner-reviewed summary', category: '产品问题' };
  assert.equal((await owner.request(`/api/admin/chat/tasks/${id}/metadata`, { method: 'PATCH', body: metadata })).status, 200);
  assert.equal((await visitor.request(`/api/chat/tasks/${id}`)).data.task.summary, metadata.summary);
  assert.equal((await visitor.request(`/api/chat/tasks/${id}`)).data.task.category, metadata.category);
  assert.equal((await visitor.request(`/api/chat/tasks/${id}/metadata`, { method: 'PATCH', body: metadata })).status, 403);
  for (const body of [{ summary: 'x'.repeat(4001) }, { category: 'x'.repeat(81) }, { category: 'line\nbreak' }, { profile: 'forged' }, {}]) assert.equal((await owner.request(`/api/admin/chat/tasks/${id}/metadata`, { method: 'PATCH', body })).status, 400);
  assert.equal(f.store.list().length, 0);
});

test('every supported mutation requires same origin, valid CSRF and idempotency; forged cookies fail closed', async t => {
  const f = await fixture(t), a = f.client();
  await a.me();
  const id = (await a.create('CSRF test')).data.id;
  const message = (await a.request(`/api/chat/tasks/${id}`)).data.messages[0].id;
  const operations = [
    ['POST', '/api/chat/tasks', submission('new')], ['DELETE', `/api/chat/tasks/${id}`, undefined],
    ['POST', `/api/chat/tasks/${id}/pin`, { pinned: true }], ['POST', `/api/chat/tasks/${id}/messages`, submission('append')],
    ['PATCH', `/api/chat/tasks/${id}/messages/${message}`, { content: 'edit' }], ['DELETE', `/api/chat/tasks/${id}/messages/${message}`, undefined],
    ['POST', `/api/chat/tasks/${id}/queue/reorder`, { message_ids: [message] }],
  ];
  for (const [method, path, body] of operations) {
    for (const options of [{ useCsrf: false }, { origin: '' }, { origin: 'https://evil.test' }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }, { headers: { 'X-CSRF-Token': 'forged' } }]) assert.equal((await a.request(path, { method, body, ...options })).status, 403);
    assert.equal((await a.request(path, { method, body, headers: { 'X-Idempotency-Key': '' } })).status, 400);
  }
  assert.equal((await a.request('/api/chat/tasks', { headers: { Cookie: 'chat_session=forged' } })).status, 401);
  assert.equal((await a.request('/api/chat/tasks', { headers: { Cookie: `${a.cookie()}; ${a.cookie()}` } })).status, 401);
  assert.equal((await a.request('/api/chat/tasks', { method: 'POST', body: submission('x'), headers: { Cookie: '' } })).status, 401);
});

test('idempotency is durable and scoped to principal and exact operation without duplicate messages', async t => {
  const f = await fixture(t), a = f.client(), b = f.client();
  await a.me(); await b.me();
  const key = 'same-key-123', headers = { 'X-Idempotency-Key': key };
  const attempts = await Promise.all([a.create('one receipt', { headers }), a.create('one receipt', { headers })]);
  assert.equal(attempts[0].status, 201);
  assert.deepEqual(attempts[0].data, attempts[1].data);
  const id = attempts[0].data.id;
  assert.equal((await a.create('different payload', { headers })).status, 409);
  assert.notEqual((await b.create('one receipt', { headers })).data.id, id);
  const path = `/api/chat/tasks/${id}/messages`;
  const first = await a.request(path, { method: 'POST', body: submission('another message'), headers });
  const again = await a.request(path, { method: 'POST', body: submission('another message'), headers });
  assert.equal(first.data.id, again.data.id);
  assert.equal((await a.request(`/api/chat/tasks/${id}`)).data.messages.length, 2);
  const secondConnection = await f.start(), restarted = f.client(secondConnection.base);
  const persisted = await restarted.request('/api/chat/tasks', { method: 'POST', body: submission('one receipt'), headers: { ...headers, Cookie: a.cookie(), 'X-CSRF-Token': a.csrf() } });
  assert.equal(persisted.data.id, id);
  assert.equal((await restarted.request(`/api/chat/tasks/${id}`, { headers: { Cookie: a.cookie() } })).data.messages.length, 2);
  assert.equal(f.store.list().length, 0);
});

test('edits, withdrawal, pinning and complete reorder apply only to unanswered owned messages', async t => {
  const f = await fixture(t), a = f.client();
  await a.me();
  const id = (await a.create('first')).data.id;
  const first = (await a.request(`/api/chat/tasks/${id}`)).data.messages[0].id;
  const second = (await a.request(`/api/chat/tasks/${id}/messages`, { method: 'POST', body: submission('second') })).data.id;
  assert.equal((await a.request(`/api/chat/tasks/${id}/messages/${first}`, { method: 'PATCH', body: { content: 'edited first' } })).status, 200);
  assert.equal((await a.request(`/api/chat/tasks/${id}/pin`, { method: 'POST', body: { pinned: true } })).data.pinned, true);
  const reorder = `/api/chat/tasks/${id}/queue/reorder`;
  for (const message_ids of [[first], [first, 123456], [first, first]]) assert.notEqual((await a.request(reorder, { method: 'POST', body: { message_ids } })).status, 200);
  assert.equal((await a.request(reorder, { method: 'POST', body: { message_ids: [second, first] } })).status, 200);
  const sorted = (await a.request(`/api/chat/tasks/${id}`)).data.messages.sort((x, y) => x.queue_position - y.queue_position);
  assert.deepEqual(sorted.map(message => message.id), [second, first]);
  const otherId = (await a.create('separate thread')).data.id;
  assert.equal((await a.request(`/api/chat/tasks/${otherId}/messages/${first}`, { method: 'DELETE' })).status, 404);
  assert.equal((await a.request(`/api/chat/tasks/${id}/messages/${second}`, { method: 'DELETE' })).status, 200);
  assert.equal((await a.request(`/api/chat/tasks/${id}`)).data.messages.length, 1);
  assert.equal((await a.request(`/api/chat/tasks/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await a.request(`/api/chat/tasks/${id}`)).status, 404);
  assert.deepEqual((await a.request('/api/chat/tasks')).data.tasks.map(task => task.id), [otherId]);
  assert.notEqual(f.store.db.prepare('SELECT deleted_at FROM chat_threads WHERE id = ?').get(id).deleted_at, null);
});

test('unavailable attachments, execution assignment and malformed/oversized inputs never create records', async t => {
  const f = await fixture(t), a = f.client();
  await a.me();
  const bad = [
    { content: '' }, { content: '  ' }, { content: 5 }, { content: 'x'.repeat(8001) }, { content: 'bad\u0000text' },
    { content: 'x', attachments: ['any-id'] }, { content: 'x', attachments: 'fake' },
    { content: 'x', agent_id: 'owner' }, { content: 'x', agent_id: false }, { content: 'x', status: 'running' },
  ];
  for (const body of bad) assert.equal((await a.create('unused', { body })).status, 400);
  assert.equal((await a.create('unused', { rawBody: '{not valid json' })).status, 400);
  assert.equal((await a.create('unused', { rawBody: JSON.stringify({ content: 'x'.repeat(40000) }) })).status, 413);
  assert.equal((await a.create('unused', { body: [], headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await a.create('unused', { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await a.request('/api/chat/uploads', { method: 'POST', rawBody: 'file bytes', headers: { 'Content-Type': 'application/octet-stream' } })).status, 503);
  assert.equal((await a.request('/api/chat/uploads/123/download')).status, 503);
  assert.equal((await a.request('/api/chat/tasks?limit=101')).status, 400);
  assert.equal((await a.request('/api/chat/tasks?principal=owner')).status, 400);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_threads').get().n, 0);
  assert.equal(f.store.list().length, 0);
});

test('hard conversation and message ceilings roll back partially created intake records', async t => {
  const f = await fixture(t), a = f.client();
  const principal = (await a.me()).data.identity;
  const id = (await a.create('first')).data.id;
  f.store.transaction(() => {
    const insert = f.store.db.prepare("INSERT INTO chat_messages(thread_id, role, author, content, content_bytes, created_at, updated_at, editable, queue_position) VALUES (?, 'user', ?, 'fixture', 7, 1, 1, 1, ?)");
    for (let i = 1; i < CHAT_LIMITS.messagesPerThread; i++) insert.run(id, principal, i + 1);
  });
  assert.equal((await a.request(`/api/chat/tasks/${id}/messages`, { method: 'POST', body: submission('over limit') })).data.error.code, 'thread_limit');
  f.store.transaction(() => {
    const insert = f.store.db.prepare("INSERT INTO chat_threads(id, principal, kind, title, created_at, updated_at) VALUES (?, ?, 'visitor_question', 'fixture', 1, 1)");
    for (let i = 1; i < CHAT_LIMITS.visitorThreads; i++) insert.run(i.toString(16).padStart(32, '0'), principal);
  });
  assert.equal((await a.create('too many')).data.error.code, 'thread_limit');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_threads').get().n, CHAT_LIMITS.visitorThreads);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n, CHAT_LIMITS.messagesPerThread);
});

test('visitor creation and mutations are durably rate-limited; spoofed forwarding does not evade buckets', async t => {
  const f = await fixture(t);
  for (let i = 0; i < CHAT_LIMITS.sessionCreationsPerIp; i++) assert.equal((await f.client().request('/api/chat/me', { headers: { 'X-Forwarded-For': `192.0.2.${i}`, 'X-Workspace-Client-IP': `198.51.100.${i}` } })).status, 200);
  assert.equal((await f.client().me()).status, 429);
  const restarted = await f.start();
  assert.equal((await f.client(restarted.base).me()).status, 429);
  f.advance(CHAT_LIMITS.rateWindowMs);
  const a = f.client();
  await a.me();
  const id = (await a.create('rate test')).data.id;
  for (let i = 1; i < CHAT_LIMITS.writesPerVisitor; i++) assert.equal((await a.request(`/api/chat/tasks/${id}/pin`, { method: 'POST', body: { pinned: Boolean(i % 2) } })).status, 200);
  assert.equal((await a.request(`/api/chat/tasks/${id}/pin`, { method: 'POST', body: { pinned: true } })).status, 429);
  assert.equal((await a.request(`/api/chat/tasks/${id}`)).status, 200, 'mutation throttling does not block reading the receipt');
  const owner = f.client();
  assert.equal((await owner.owner()).status, 200);
  assert.equal((await owner.create('owner unaffected by visitor rate bucket')).status, 201);
});

test('expired anonymous sessions cannot reclaim old records by IP, while owner inbox keeps durable history', async t => {
  const f = await fixture(t), a = f.client();
  const identity = (await a.me()).data.identity;
  const id = (await a.create('durable after guest expiry')).data.id;
  f.advance(CHAT_LIMITS.sessionIdleMs);
  assert.equal((await a.request(`/api/chat/tasks/${id}`)).status, 401);
  assert.notEqual((await a.me()).data.identity, identity);
  assert.equal((await a.request(`/api/chat/tasks/${id}`)).status, 404);
  assert.deepEqual((await a.request('/api/chat/tasks')).data.tasks, []);
  const owner = f.client();
  await owner.owner();
  assert.equal((await owner.request(`/api/admin/chat/tasks/${id}`)).data.messages[0].content, 'durable after guest expiry');
});

test('trusted reverse-proxy address is only an abuse signal, never a principal selector', async t => {
  const f = await fixture(t, { trustedProxyIPs: ['127.0.0.1'] });
  const a = f.client(), b = f.client();
  assert.equal((await a.me()).status, 400, 'trusted proxy must supply its overwritten address header');
  const headers = { 'X-Workspace-Client-IP': '203.0.113.9' };
  const first = await a.request('/api/chat/me', { headers }), second = await b.request('/api/chat/me', { headers });
  assert.equal(first.data.ip, '203.0.113.9');
  assert.notEqual(first.data.identity, second.data.identity);
  const id = (await a.create('same public IP, different browsers', { headers })).data.id;
  assert.equal((await b.request(`/api/chat/tasks/${id}`, { headers })).status, 404);
});

async function delayedCreate(t, fixture, client) {
  const body = JSON.stringify(submission('must not survive source credential revocation'));
  const started = new Promise(resolve => fixture.server.once('request', resolve));
  let request;
  const result = new Promise((resolve, reject) => {
    request = httpRequest(fixture.base + '/api/chat/tasks', { method: 'POST', headers: {
      Origin: fixture.config.publicOrigin, Cookie: client.cookie(), 'X-CSRF-Token': client.csrf(),
      'X-Idempotency-Key': randomUUID(), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    request.on('error', reject);
    request.write(body.slice(0, 1));
  });
  t.after(() => request.destroy());
  await started;
  // The server has checked the session and is now awaiting the remaining body.
  await new Promise(resolve => setImmediate(resolve));
  return { finish: () => { request.end(body.slice(1)); return result; } };
}

test('a partial request cannot mutate as an owner revoked by concurrent logout', async t => {
  const f = await fixture(t), owner = f.client();
  await owner.owner(); await owner.me();
  const pending = await delayedCreate(t, f, owner);
  assert.equal((await owner.request('/api/logout', { method: 'POST', body: {} })).status, 200);
  assert.equal((await pending.finish()).status, 401);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_threads').get().n, 0);
});

test('a partial request cannot mutate as an account revoked by concurrent logout', async t => {
  const f = await fixture(t), account = f.client();
  await account.me();
  assert.equal((await account.request('/api/chat/account/signup', { method: 'POST', body: { username: 'delayed-account', password: '123456' } })).status, 200);
  const pending = await delayedCreate(t, f, account);
  assert.equal((await account.request('/api/chat/account/logout', { method: 'POST', body: {} })).status, 200);
  assert.equal((await pending.finish()).status, 401);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_threads').get().n, 0);
});

test('a partial guest request cannot recreate orphaned visitor records after registration migrated its identity', async t => {
  const f = await fixture(t), visitor = f.client();
  await visitor.me();
  const pending = await delayedCreate(t, f, visitor);
  assert.equal((await visitor.request('/api/chat/account/signup', { method: 'POST', body: { username: 'registered-now', password: '123456' } })).status, 200);
  assert.equal((await pending.finish()).status, 401);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_threads').get().n, 0);
});

test('a partial guest write is rejected if its session expires while the body is pending', async t => {
  const f = await fixture(t), visitor = f.client();
  await visitor.me();
  const pending = await delayedCreate(t, f, visitor);
  f.advance(CHAT_LIMITS.sessionTtlMs);
  assert.equal((await pending.finish()).status, 401);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_threads').get().n, 0);
});

test('normal four-second polling with an identity refresh before each read stays below finite rate limits', async t => {
  const f = await fixture(t), visitor = f.client();
  await visitor.me();
  const id = (await visitor.create('polling test')).data.id;
  // 225 four-second cycles fit one 15-minute window. Do not advance the fake
  // clock: this is stricter than normal traffic, with no quota-window reset.
  for (let i = 0; i < 225; i++) {
    for (const path of ['/api/chat/me', `/api/chat/tasks/${id}`, '/api/chat/me', '/api/chat/tasks']) assert.equal((await visitor.request(path)).status, 200);
    if (i % 4 === 0) {
      assert.equal((await visitor.me()).status, 200);
      assert.equal((await visitor.request('/api/chat/agents')).status, 200);
    }
  }
  assert.equal((await visitor.request('/api/chat/tasks')).status, 200);
});
