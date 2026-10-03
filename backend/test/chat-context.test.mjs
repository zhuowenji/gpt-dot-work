import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, scryptSync } from 'node:crypto';
import { TaskStore } from '../store.mjs';
import { ChatIntake } from '../chat.mjs';
import { OwnerAuth } from '../auth.mjs';
import { ChatContextStore, CONTEXT_LIMITS } from '../chat-context.mjs';
import { createApiServer, listen } from '../server.mjs';
import { createBackup } from '../../scripts/backup.mjs';

const ORIGIN = 'http://localhost:4318', PASSWORD = 'fictional-memory-owner';
const salt = Buffer.alloc(16, 83);
const HASH = `scrypt$32768$8$1$${salt.toString('base64url')}$${scryptSync(PASSWORD, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64url')}`;
const config = { ownerPasswordHash: HASH, ownerName: 'Test owner', publicOrigin: ORIGIN, production: false, sessionTtlMs: 43200000, sessionIdleMs: 3600000, trustedProxyIPs: [], runtime: 'disabled', host: '127.0.0.1', port: 0, pollMs: 60000 };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'chat-context-')), path = join(dir, 'state.sqlite');
  const store = new TaskStore(path); const chat = new ChatIntake(store, config, new OwnerAuth(store, config));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const addThread = (principal, content, id = randomUUID().replaceAll('-', '')) => store.transaction(() => {
    const at = store.now();
    store.db.prepare('INSERT INTO chat_threads(id, principal, kind, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, principal, 'visitor_question', content.slice(0, 80), at, at);
    const messageId = chat.insertMessage(chat.thread(id, principal), content, 'user', principal);
    return { id, messageId, principal };
  });
  const write = (thread, payload) => store.transaction(() => chat.context.writeback(thread.id, payload, { actor: 'owner', sourceMessageIds: [thread.messageId] }));
  const remember = (thread, value = 'Prefers tea', rest = {}) => write(thread, { memory_patch: [{ type: 'preference', key: 'drink', value, certainty: 'confirmed', source_message_ids: [thread.messageId], ...rest }] }).memory[0];
  return { dir, path, store, chat, context: chat.context, addThread, write, remember };
}
async function httpFixture(t) {
  const f = fixture(t), server = createApiServer(f.store, config), address = await listen(server, config);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = () => {
    const cookies = new Map(); let csrf = '';
    const request = async (path, { method = 'GET', body, headers = {}, useCsrf = true } = {}) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { Origin: ORIGIN, Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '), ...(useCsrf ? { 'X-CSRF-Token': csrf } : {}), 'X-Idempotency-Key': randomUUID(), 'Content-Type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0], index = pair.indexOf('='); cookies.set(pair.slice(0, index), pair.slice(index + 1)); }
      const data = await response.json(); if (data.csrfToken) csrf = data.csrfToken;
      return { status: response.status, data };
    };
    return { request, me: () => request('/api/chat/me'), create: text => request('/api/chat/tasks', { method: 'POST', body: { content: text } }), owner: () => request('/api/login', { method: 'POST', body: { password: PASSWORD } }) };
  };
  return { ...f, client };
}
const visitor = n => `visitor:${String(n).padStart(32, '0')}`;

test('cold start, sequential conversations and context sources remain exactly principal-scoped', t => {
  const f = fixture(t), a = f.addThread(visitor(1), 'I prefer tea'), b = f.addThread(visitor(2), 'Private other-user detail');
  const cold = f.context.getContext(a.id);
  assert.equal(cold.cold_start, true); assert.deepEqual(cold.memory, []); assert.deepEqual(cold.summaries, []);
  f.remember(a);
  f.write(a, { summary: { text: 'Tea is preferred', certainty: 'confirmed', source_message_ids: [a.messageId] }, category: 'preferences' });
  f.remember(b, 'Other user prefers coffee');
  const next = f.addThread(a.principal, 'What should I drink?'), context = f.context.getContext(next.id);
  assert.equal(context.memory[0].value, 'Prefers tea'); assert.equal(context.summaries[0].summary, 'Tea is preferred');
  assert.deepEqual(context.related_threads.map(row => row.id), [a.id]);
  assert(!JSON.stringify(context).includes('Other user')); assert(!JSON.stringify(context).includes(b.id));
  assert.equal(context.messages[0].authority, 'untrusted_content');
  assert.throws(() => f.context.getContext(a.id, { beforeMessageId: b.messageId }), { code: 'invalid_source' });
  assert.throws(() => f.write(a, { memory_patch: [{ type: 'fact', key: 'bad', value: 'Cross-user', certainty: 'confirmed', source_message_ids: [b.messageId] }] }), { code: 'invalid_source' });
});

test('corrections supersede prior facts and dependent summaries, preserving versioned provenance and audit', t => {
  const f = fixture(t), a = f.addThread(visitor(1), 'I prefer tea'), entry = f.remember(a);
  f.write(a, { summary: { text: 'Tea is preferred', certainty: 'inferred', source_message_ids: [a.messageId] } });
  const before = f.context.version(a.id), correctionId = f.store.transaction(() => f.chat.insertMessage(f.chat.thread(a.id, a.principal), 'Correction: I prefer coffee now', 'user', a.principal));
  const updated = f.store.transaction(() => f.context.correct(a.id, entry.id, { version: entry.version, value: 'Prefers coffee', source_message_ids: [correctionId], reason: 'User corrected preference' }, { principal: a.principal }));
  assert.equal(updated.version, 2); assert.equal(updated.certainty, 'confirmed');
  const context = f.context.getContext(a.id);
  assert.equal(context.memory.length, 1); assert.equal(context.memory[0].value, 'Prefers coffee'); assert.deepEqual(context.summaries, []);
  assert.notEqual(context.context_version, before);
  const history = f.context.history(a.id, entry.id);
  assert.equal(history.versions[1].status, 'superseded'); assert.equal(history.versions[1].value, 'Prefers tea');
  assert.deepEqual(history.versions[0].source_message_ids, [correctionId]);
  assert.equal(f.chat.thread(a.id, a.principal).summary, '');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM chat_context_audit WHERE event = 'memory_corrected_by_user'").get().n, 1);
  assert.throws(() => f.store.transaction(() => f.context.correct(a.id, entry.id, { version: 1, value: 'Stale overwrite', source_message_ids: [a.messageId] }, { principal: a.principal })), { code: 'memory_changed' });
});

test('edited/withdrawn source messages are never treated as current memory and old history remains inspectable', t => {
  const f = fixture(t), a = f.addThread(visitor(1), 'I prefer tea'), entry = f.remember(a);
  f.store.transaction(() => {
    f.store.db.prepare('UPDATE chat_messages SET content = ? WHERE id = ?').run('Correction to source content', a.messageId);
    f.chat.bump(a.id);
  });
  assert.deepEqual(f.context.getContext(a.id).memory, [], 'fingerprint mismatch fails closed even before explicit invalidation hook');
  f.store.transaction(() => f.context.invalidateSources(a.id, [a.messageId], 'user:fixture'));
  assert.equal(f.context.history(a.id, entry.id).entry.status, 'invalidated');
  assert.equal(f.context.history(a.id, entry.id).versions[0].value, 'Prefers tea');
});

test('indirectly derived summaries retire on correction and an old entry cannot revive beside a conflicting current fact', t => {
  const f = fixture(t), a = f.addThread(visitor(1), 'I prefer tea'), old = f.remember(a);
  const replyId = f.store.transaction(() => f.chat.insertMessage(f.chat.thread(a.id, a.principal), 'Tea noted', 'agent', 'owner'));
  f.write(a, { summary: { text: 'Tea is preferred', certainty: 'inferred', source_message_ids: [replyId] } });
  f.store.transaction(() => f.context.correct(a.id, old.id, { version: 1, status: 'invalidated' }, { principal: a.principal }));
  assert.deepEqual(f.context.getContext(a.id).summaries, []);
  const current = f.remember(a, 'Prefers coffee');
  assert.throws(() => f.store.transaction(() => f.context.correct(a.id, old.id, { version: 2, value: 'Prefers tea again', source_message_ids: [a.messageId] }, { principal: a.principal })), { code: 'memory_key_exists' });
  assert.deepEqual(f.context.getContext(a.id).memory.map(entry => entry.id), [current.id]);
});

test('summary/memory writeback is atomic with reply, requires transaction and rejects stale context or untrusted actor', t => {
  const f = fixture(t), a = f.addThread(visitor(1), 'Question'), version = f.context.version(a.id);
  assert.throws(() => f.context.writeback(a.id, {}, { actor: 'owner' }), /atomic transaction/);
  assert.throws(() => f.store.transaction(() => f.context.writeback(a.id, {}, { actor: 'visitor' })), { code: 'context_write_denied' });
  assert.throws(() => f.store.transaction(() => {
    f.context.assertVersion(a.id, version);
    f.chat.insertMessage(f.chat.thread(a.id, a.principal), 'Reply that must roll back', 'agent', 'owner');
    f.context.writeback(a.id, { memory_patch: [{ type: 'fact', key: 'bad', value: 'No valid source', certainty: 'confirmed', source_message_ids: [9999] }] }, { actor: 'owner' });
  }), { code: 'invalid_source' });
  assert.equal(f.chat.detail(f.chat.thread(a.id, a.principal)).messages.length, 1);
  assert.equal(f.context.version(a.id), version);
  f.remember(a);
  assert.throws(() => f.store.transaction(() => f.context.assertVersion(a.id, version)), { code: 'context_changed' });
});

test('bounded retrieval, input schemas, task status and sensitive-value rejection', t => {
  const f = fixture(t), a = f.addThread(visitor(1), 'Question');
  for (let i = 0; i < 28; i++) f.store.transaction(() => f.chat.insertMessage(f.chat.thread(a.id, a.principal), 'x'.repeat(2000), 'user', a.principal));
  const context = f.context.getContext(a.id);
  assert(context.messages.length <= CONTEXT_LIMITS.messages);
  assert(context.messages.reduce((size, item) => size + item.content.length, 0) <= CONTEXT_LIMITS.messageBudget);
  assert.throws(() => f.context.getContext(a.id, { query: 'x'.repeat(241) }), { code: 'invalid_context' });
  assert.throws(() => f.remember(a, 'x'.repeat(1201)), { code: 'invalid_context' });
  assert.throws(() => f.remember(a, 'password: fictional-secret'), { code: 'sensitive_memory' });
  assert.throws(() => f.remember(a, 'value', { certainty: undefined }), { code: 'invalid_context' });
  assert.throws(() => f.remember(a, 'value', { principal: visitor(2) }), { code: 'invalid_context' });
  const task = f.remember(a, 'Send itinerary', { type: 'task', key: 'itinerary' });
  assert.equal(f.context.getContext(a.id).tasks.length, 1);
  f.store.transaction(() => f.context.correct(a.id, task.id, { version: task.version, status: 'completed' }, { principal: a.principal }));
  assert.deepEqual(f.context.getContext(a.id).tasks, []);
});

test('memory and summaries survive reopen and consistent SQLite backup with provenance', async t => {
  const f = fixture(t), a = f.addThread(visitor(1), 'I prefer tea'), entry = f.remember(a);
  f.write(a, { summary: { text: 'A confirmed preference', certainty: 'confirmed', source_message_ids: [a.messageId] } });
  const before = f.context.getContext(a.id);
  const reopened = new TaskStore(f.path), restoredContext = new ChatContextStore(reopened);
  try { assert.deepEqual(restoredContext.getContext(a.id), before); } finally { reopened.close(); }
  const destination = join(f.dir, 'backup.sqlite'); await createBackup(f.path, destination);
  const restored = new TaskStore(destination), backupContext = new ChatContextStore(restored);
  try {
    assert.deepEqual(backupContext.getContext(a.id), before);
    assert.equal(backupContext.history(a.id, entry.id).versions.length, 1);
    assert.equal(restored.db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  } finally { restored.close(); }
});

test('HTTP context is own-user only; owner reviewed memory writes require CSRF, version, idempotency and exact fields', async t => {
  const f = await httpFixture(t), a = f.client(), b = f.client(), owner = f.client();
  await a.me(); await b.me(); await owner.owner();
  const threadId = (await a.create('I prefer tea')).data.id;
  const detail = (await a.request(`/api/chat/tasks/${threadId}`)).data, sourceId = detail.messages[0].id;
  const path = `/api/admin/chat/tasks/${threadId}/memory`, ownPath = `/api/chat/tasks/${threadId}/context`;
  assert.equal((await b.request(ownPath)).status, 404);
  assert.equal((await a.request(`${ownPath}?principal=owner`)).status, 400);
  assert.equal((await a.request(path)).status, 401);
  const expected = (await owner.request(`/api/admin/chat/tasks/${threadId}/context`)).data.context_version;
  const payload = { expected_context_version: expected, memory_patch: [{ type: 'preference', key: 'drink', value: 'Prefers tea', certainty: 'confirmed', source_message_ids: [sourceId] }] };
  assert.equal((await owner.request(path, { method: 'POST', body: payload, useCsrf: false })).status, 403);
  assert.equal((await owner.request(path, { method: 'POST', body: { ...payload, principal: 'owner' } })).status, 400);
  const key = randomUUID(), first = await owner.request(path, { method: 'POST', body: payload, headers: { 'X-Idempotency-Key': key } });
  assert.equal(first.status, 200);
  assert.deepEqual((await owner.request(path, { method: 'POST', body: payload, headers: { 'X-Idempotency-Key': key } })).data, first.data);
  assert.equal((await owner.request(path, { method: 'POST', body: payload })).status, 409);
  assert.equal((await a.request(ownPath)).data.memory[0].value, 'Prefers tea');
  const entry = first.data.memory[0], correction = `/api/chat/tasks/${threadId}/memory/${entry.id}`;
  assert.equal((await b.request(correction)).status, 404);
  const body = { version: 1, value: 'Prefers coffee', source_message_ids: [sourceId] };
  assert.equal((await a.request(correction, { method: 'PATCH', body, useCsrf: false })).status, 403);
  assert.equal((await a.request(correction, { method: 'PATCH', body })).status, 200);
  assert.equal((await a.request(ownPath)).data.memory[0].value, 'Prefers coffee');
  assert.equal((await a.request(correction)).data.versions.length, 2);
});

test('verified guest registration migrates memory in the same transaction and a new account session reloads it', async t => {
  const f = await httpFixture(t), guest = f.client(), owner = f.client();
  const identity = (await guest.me()).data.identity; await owner.owner();
  const threadId = (await guest.create('I prefer tea')).data.id;
  const detail = (await guest.request(`/api/chat/tasks/${threadId}`)).data;
  f.remember({ id: threadId, messageId: detail.messages[0].id, principal: identity });
  const registered = await guest.request('/api/chat/account/signup', { method: 'POST', body: { username: 'memory-user', password: 'fixture-password' } });
  assert.equal(registered.status, 200);
  assert.notEqual(registered.data.identity, identity);
  const migrated = (await guest.request(`/api/chat/tasks/${threadId}/context`)).data;
  assert.equal(migrated.principal, registered.data.identity); assert.equal(migrated.memory.length, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_memory_entries WHERE principal = ?').get(identity).n, 0);
  const second = f.client(); await second.me();
  assert.equal((await second.request('/api/chat/account/login', { method: 'POST', body: { username: 'memory-user', password: 'fixture-password' } })).status, 200);
  assert.equal((await second.request(`/api/chat/tasks/${threadId}/context`)).data.memory[0].value, 'Prefers tea');
  const stranger = f.client(); await stranger.me();
  assert.equal((await stranger.request(`/api/chat/tasks/${threadId}/context`)).status, 404);
});

test('editing or deleting source through HTTP invalidates derived memory and owner replies can atomically carry reviewed context', async t => {
  const f = await httpFixture(t), user = f.client(), owner = f.client(); await user.me(); await owner.owner();
  const id = (await user.create('I prefer tea')).data.id, sourceId = (await user.request(`/api/chat/tasks/${id}`)).data.messages[0].id;
  f.remember({ id, messageId: sourceId });
  assert.equal((await user.request(`/api/chat/tasks/${id}/messages/${sourceId}`, { method: 'PATCH', body: { content: 'I prefer coffee' } })).status, 200);
  assert.deepEqual((await user.request(`/api/chat/tasks/${id}/context`)).data.memory, []);
  const context = (await owner.request(`/api/admin/chat/tasks/${id}/context`)).data;
  const reply = await owner.request(`/api/admin/chat/tasks/${id}/replies`, { method: 'POST', body: { content: 'Noted your correction', expected_context_version: context.context_version, context: { summary: { text: 'Coffee is now preferred', certainty: 'confirmed', source_message_ids: [sourceId] }, category: 'preferences' } } });
  assert.equal(reply.status, 201); assert.equal(reply.data.execution_connected, false);
  assert.equal((await user.request(`/api/chat/tasks/${id}/context`)).data.summaries[0].summary, 'Coffee is now preferred');
  assert.equal((await user.request(`/api/chat/tasks/${id}`, { method: 'DELETE', body: {} })).status, 200);
  assert.equal((await user.request(`/api/chat/tasks/${id}/context`)).status, 404);
  const next = (await user.create('Next question')).data.id;
  const nextContext = (await user.request(`/api/chat/tasks/${next}/context`)).data;
  assert.deepEqual(nextContext.memory, []); assert.deepEqual(nextContext.summaries, []);
});
