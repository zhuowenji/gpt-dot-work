import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest } from 'node:http';
import { TaskStore } from '../store.mjs';
import { createApiServer, listen } from '../server.mjs';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'chat-receipt-timing-'));
  const path = join(dir, 'state.sqlite'), store = new TaskStore(path);
  const config = { apiToken: randomBytes(32).toString('hex'), host: '127.0.0.1', port: 0,
    publicOrigin: 'http://localhost', production: false, trustedProxyIPs: [], runtime: 'disabled',
    sessionTtlMs: 43200000, sessionIdleMs: 3600000 };
  const server = createApiServer(store, config), independentReader = new DatabaseSync(path);
  const committedAtHeader = [];
  server.prependListener('request', (_req, res) => {
    const writeHead = res.writeHead;
    res.writeHead = function (status, ...args) {
      if (status === 201 && this.getHeader('Server-Timing')) committedAtHeader.push(independentReader.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n);
      return writeHead.call(this, status, ...args);
    };
  });
  const address = await listen(server, config), base = `http://127.0.0.1:${address.port}`;
  config.publicOrigin = base;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); independentReader.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const client = () => {
    let cookie = '', csrf = '';
    const request = async (route, { method = 'GET', body, key = randomUUID(), headers = {} } = {}) => {
      const response = await fetch(base + route, { method, headers: { Origin: base, Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Idempotency-Key': key,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const data = response.status === 204 ? null : await response.json(); if (data?.csrfToken) csrf = data.csrfToken;
      return { status: response.status, data, timing: response.headers.get('Server-Timing') };
    };
    return { request, headers: () => ({ Origin: base, Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Idempotency-Key': randomUUID(), 'Content-Type': 'application/json' }) };
  };
  return { base, client, store, committedAtHeader };
}
const submission = content => ({ content, attachments: [], agent_id: null });
function timing(r) {
  assert.equal(r.status, 201);
  assert.match(r.timing, /^intake-receipt;dur=\d+\.\d{3}$/);
  const ms = Number(r.timing.split('=')[1]); assert(Number.isFinite(ms) && ms >= 0); return ms;
}

test('only successful create/append receipts expose timing after independently visible commit', async t => {
  const f = await fixture(t), c = f.client(); await c.request('/api/chat/me');
  const create = await c.request('/api/chat/tasks', { method: 'POST', body: submission('synthetic receipt') });
  timing(create); assert.deepEqual(f.committedAtHeader, [1]);
  const append = await c.request(`/api/chat/tasks/${create.data.id}/messages`, { method: 'POST', body: submission('synthetic follow-up') });
  timing(append); assert.deepEqual(f.committedAtHeader, [1, 2]);
  assert.equal((await c.request(`/api/chat/tasks/${create.data.id}`)).timing, null);
  const pin = await c.request(`/api/chat/tasks/${create.data.id}/pin`, { method: 'POST', body: { pinned: true } });
  assert.equal(pin.status, 200); assert.equal(pin.timing, null);
});

test('idempotent success is freshly timed; conflicts, malformed inputs and denied sessions are not', async t => {
  const f = await fixture(t), c = f.client(), other = f.client(); await c.request('/api/chat/me'); await other.request('/api/chat/me');
  const key = randomUUID(), body = submission('synthetic replay');
  const first = await c.request('/api/chat/tasks', { method: 'POST', body, key }); timing(first);
  const replay = await c.request('/api/chat/tasks', { method: 'POST', body, key }); timing(replay);
  assert.deepEqual(replay.data, first.data); assert.deepEqual(f.committedAtHeader, [1, 1]);
  const conflict = await c.request('/api/chat/tasks', { method: 'POST', body: submission('changed'), key });
  assert.equal(conflict.status, 409); assert.equal(conflict.timing, null);
  const invalid = await c.request('/api/chat/tasks', { method: 'POST', body: submission('') });
  assert.equal(invalid.status, 400); assert.equal(invalid.timing, null);
  const denied = await c.request('/api/chat/tasks', { method: 'POST', body, headers: { 'X-CSRF-Token': 'invalid' } });
  assert.equal(denied.status, 403); assert.equal(denied.timing, null);
  const cross = await other.request(`/api/chat/tasks/${first.data.id}/messages`, { method: 'POST', body });
  assert.equal(cross.status, 404); assert.equal(cross.timing, null);
});

test('health, identity, account and login routes never expose intake timing', async t => {
  const f = await fixture(t), c = f.client();
  for (const route of ['/health', '/api/chat/me', '/api/chat/tasks', '/api/chat/account/session', '/api/session']) {
    const r = await c.request(route); assert.equal(r.status, 200); assert.equal(r.timing, null);
  }
  for (const route of ['/api/chat/account/signup', '/api/chat/account/login', '/api/login']) {
    const r = await c.request(route, { method: 'POST', body: {} }); assert(r.status >= 400); assert.equal(r.timing, null);
  }
});

test('database rollback emits no successful receipt metric and stores no message', async t => {
  const f = await fixture(t), c = f.client(); await c.request('/api/chat/me');
  f.store.db.exec("CREATE TRIGGER fixture_reject_insert BEFORE INSERT ON chat_messages BEGIN SELECT RAISE(ABORT, 'local test fault'); END");
  const r = await c.request('/api/chat/tasks', { method: 'POST', body: submission('must roll back') });
  assert.equal(r.status, 500); assert.equal(r.timing, null); assert.deepEqual(f.committedAtHeader, []);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chat_threads').get().n, 0);
});

test('measurement starts at handler entry and includes awaiting a slow request body', async t => {
  const f = await fixture(t), c = f.client(); await c.request('/api/chat/me');
  const body = JSON.stringify(submission('synthetic delayed body'));
  const result = await new Promise((resolve, reject) => {
    const req = httpRequest(f.base + '/api/chat/tasks', { method: 'POST', headers: { ...c.headers(), 'Content-Length': Buffer.byteLength(body) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', data => { text += data; });
      res.on('end', () => resolve({ status: res.statusCode, timing: res.headers['server-timing'], data: JSON.parse(text) }));
    });
    req.on('error', reject); req.flushHeaders(); req.write(body.slice(0, 1));
    setTimeout(() => req.end(body.slice(1)), 80);
  });
  assert(timing(result) >= 50, 'The metric must include body-read time rather than start immediately before COMMIT');
  assert.equal(result.data.execution_connected, false);
});
