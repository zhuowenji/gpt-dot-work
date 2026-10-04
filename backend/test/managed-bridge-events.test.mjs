import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../store.mjs';
import { ManagedBridgeEvents, EVENT_LIMITS, isPublicAddress, validateCallbackUrl, standardWebhookHeaders } from '../managed-bridge-events.mjs';

// Deliberately public, fixed test data. Never a generated or deployed credential.
const SECRET = `whsec_${Buffer.from('fixed-offline-fixture-secret-0000').toString('base64')}`;
const TRUSTED = 'https://callbacks.example.test';

test('public-address filter rejects private, reserved, mapped, transition and special ranges', () => {
  for (const address of ['127.0.0.1', '0.0.0.0', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.1.1',
    '192.168.1.1', '192.0.0.9', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:8.8.8.8', '64:ff9b::808:808', 'fc00::1',
    'fe80::1', 'fe80::1%eth0', 'ff02::1', '2001:db8::1', '2001::1', '2001:100::1', '2002:808:808::1', '3fff::1', 'not-ip']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('callback destination requires an exact trusted HTTPS origin without URL tricks', () => {
  const allow = new Set([TRUSTED]);
  assert.equal(validateCallbackUrl(`${TRUSTED}/hook/abc?token=fixed`, allow).href, `${TRUSTED}/hook/abc?token=fixed`);
  for (const url of ['http://callbacks.example.test/hook', 'https://callbacks.example.test.evil.test/hook',
    'https://evil.test/hook', 'https://callbacks.example.test:8443/hook', 'https://a:b@callbacks.example.test/hook',
    'https://callbacks.example.test./hook', 'https://callbacks.example.test/hook#fragment', 'https://127.0.0.1/hook',
    'https://[2606:4700::1111]/hook', 'https://localhost/hook', 'https://callbacks.example.test\\@evil.test/hook',
    ' https://callbacks.example.test/hook']) assert.throws(() => validateCallbackUrl(url, allow), /destination|origin/, url);
  assert.throws(() => validateCallbackUrl(`${TRUSTED}/hook`, new Set()), { code: 'callback_origin_not_allowed' });
});

function fixture(t, options = {}) {
  let at = 1800000000000, live = true;
  const store = new TaskStore(':memory:', { now: () => at });
  const registration = { site_id: 'site-fixture', owner_subject: 'owner-fixture', key_id: 'key-fixture', queue: 'website-chat', expires_at: at + 7 * 86400000 };
  const calls = [], dns = [];
  let respond = options.respond || (request => ({ status: 204 }));
  let resolve = options.resolve || (hostname => [{ address: '8.8.8.8', family: 4 }]);
  const events = new ManagedBridgeEvents(store, {
    enabled: true, allowedCallbackOrigins: [TRUSTED],
    registrationActive: value => live && value.site_id === registration.site_id && value.owner_subject === registration.owner_subject && value.key_id === registration.key_id,
    resolver: hostname => { dns.push(hostname); return resolve(hostname); },
    transport: request => {
      calls.push(request);
      const body = JSON.parse(request.body);
      if (body.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
      return respond(request);
    },
  });
  t.after(() => { events.close(); store.close(); });
  const input = (overrides = {}) => ({ name: 'task.created', arguments: { queue: 'website-chat' }, delivery: { mode: 'webhook', url: `${TRUSTED}/callback/fixture`, secret: SECRET }, ...overrides });
  const remove = () => ({ name: 'task.created', arguments: { queue: 'website-chat' }, delivery: { mode: 'webhook', url: `${TRUSTED}/callback/fixture` } });
  const enqueue = (id = 'task-1') => store.transaction(() => events.enqueueTaskCreated(registration, { task_id: id, queue: 'website-chat', created_at: at }));
  return { store, events, registration, calls, dns, input, remove, enqueue, now: () => at,
    advance: value => { at += value; }, revoke: () => { live = false; events.haltRevoked(); },
    setResolver: value => { resolve = value; }, setResponder: value => { respond = value; } };
}

test('disabled by default does no DNS, callback, subscription or outbox work', async t => {
  const store = new TaskStore(':memory:'); t.after(() => store.close());
  const events = new ManagedBridgeEvents(store, { resolver: () => assert.fail('DNS'), transport: () => assert.fail('network') });
  assert.equal(events.enqueueTaskCreated({}, {}), null);
  assert.equal(await events.dispatchOne(), null);
  await assert.rejects(events.upsert({ site_id: 'site', owner_subject: 'owner', key_id: 'key', queue: 'website-chat', expires_at: Date.now() + 1000 }, {}), { code: 'managed_events_disabled' });
});

test('subscription verifies callback before activation, caps TTL and caches repeated verification', async t => {
  const f = fixture(t);
  const first = await f.events.upsert(f.registration, f.input({ ttlMs: null, cursor: null }));
  assert.deepEqual(first, { id: first.id, refreshBefore: new Date(f.now() + EVENT_LIMITS.maxLeaseMs).toISOString(), cursor: null, truncated: false });
  assert.equal(f.calls.length, 1);
  const verified = f.calls[0], body = JSON.parse(verified.body);
  assert.equal(body.type, 'verification');
  assert.equal(verified.readResponse, true);
  assert.equal(verified.headers['X-MCP-Subscription-Id'], first.id);
  assert.deepEqual({ ...standardWebhookHeaders(SECRET, verified.headers['webhook-id'], verified.body, f.now()) }, Object.fromEntries(Object.entries(verified.headers).filter(([name]) => name.startsWith('webhook-'))));
  const renewed = await f.events.upsert(f.registration, f.input({ ttlMs: 20000 }));
  assert.equal(renewed.id, first.id);
  assert.equal(f.calls.length, 1);
  assert.equal(renewed.refreshBefore, new Date(f.now() + 20000).toISOString());
  f.advance(EVENT_LIMITS.verificationCacheMs + 1);
  await f.events.upsert(f.registration, f.input());
  assert.equal(f.calls.length, 2);
  const shortRegistration = { ...f.registration, expires_at: f.now() + 10000 };
  assert.equal((await f.events.upsert(shortRegistration, f.input())).refreshBefore, new Date(shortRegistration.expires_at).toISOString());
});

test('strict subscription fields, queue and identity authorization', async t => {
  const f = fixture(t);
  for (const input of [f.input({ name: 'reply.created' }), f.input({ arguments: { queue: 'other' } }), f.input({ arguments: { queue: 'website-chat', task_id: 'any' } }), f.input({ ttlMs: 0 }), f.input({ ttlMs: '3000' }), f.input({ cursor: 'replay' }), f.input({ owner_subject: 'forged' }), f.input({ delivery: { mode: 'webhook', url: `${TRUSTED}/hook`, secret: 'whsec_Zg==' } })]) {
    await assert.rejects(f.events.upsert(f.registration, input), { code: 'invalid_subscription' });
  }
  await assert.rejects(f.events.upsert({ ...f.registration, owner_subject: 'other' }, f.input()), { code: 'registration_inactive' });
  await assert.rejects(f.events.upsert(f.registration, f.input({ delivery: { mode: 'webhook', url: 'https://evil.test/opaque-secret', secret: SECRET } })), error => {
    assert.equal(error.code, 'callback_origin_not_allowed'); assert.equal(error.origin, 'https://evil.test'); assert.equal(error.message.includes('opaque-secret'), false); return true;
  });
  assert.equal(f.calls.length, 0);
});

test('wrong verification challenge and redirects do not activate a subscription', async t => {
  const f = fixture(t);
  for (const response of [{ status: 200, body: '{"challenge":"wrong"}' }, { status: 302, body: '{"challenge":"wrong"}' }, { status: 200, body: 'not JSON' }]) {
    f.events.transport = () => response;
    await assert.rejects(f.events.upsert(f.registration, f.input()), { code: 'callback_verification_failed' });
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM managed_bridge_subscriptions WHERE status='active'").get().n, 0);
  }
});

test('transactional outbox rolls back with task insert and remains idempotent', async t => {
  const f = fixture(t); await f.events.upsert(f.registration, f.input());
  assert.throws(() => f.events.enqueueTaskCreated(f.registration, { task_id: 'task-1', queue: 'website-chat', created_at: f.now() }), /transaction/);
  assert.throws(() => f.store.transaction(() => {
    f.events.enqueueTaskCreated(f.registration, { task_id: 'rolled-back', queue: 'website-chat', created_at: f.now() });
    throw new Error('task_insert_failed');
  }), /task_insert_failed/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM managed_bridge_event_outbox').get().n, 0);
  const id = f.enqueue(); assert.equal(f.enqueue(), id);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM managed_bridge_event_deliveries').get().n, 1);
  const result = await f.events.dispatchOne();
  assert.equal(result.status, 'delivered'); assert.equal(result.eventId, id);
  assert.equal(await f.events.dispatchOne(), null);
  const request = f.calls[1], body = JSON.parse(request.body);
  assert.deepEqual(body, { eventId: id, name: 'task.created', timestamp: new Date(f.now()).toISOString(), data: { task_id: 'task-1', queue: 'website-chat' }, cursor: null });
  assert.equal(request.headers['webhook-id'], id);
  assert.equal(f.dns.length, 2);
  assert.deepEqual(request.address, { address: '8.8.8.8', family: 4 });
});

test('no replay to later subscriptions and no events for unsupported reply payload', async t => {
  const f = fixture(t); f.enqueue('before-subscription');
  await f.events.upsert(f.registration, f.input());
  assert.equal(await f.events.dispatchOne(), null);
  assert.throws(() => f.store.transaction(() => f.events.enqueueTaskCreated(f.registration, { task_id: 'reply-1', queue: 'website-chat', created_at: f.now(), name: 'reply.created' })), { code: 'invalid_subscription' });
});

test('transient retry uses stable event bytes/id and a fresh signing timestamp', async t => {
  const f = fixture(t, { respond: () => ({ status: 503 }) }); await f.events.upsert(f.registration, f.input()); f.enqueue();
  assert.equal((await f.events.dispatchOne()).status, 'pending');
  assert.equal(await f.events.dispatchOne(), null);
  f.advance(1001); f.setResponder(() => ({ status: 202 }));
  assert.equal((await f.events.dispatchOne()).status, 'delivered');
  assert.equal(f.calls[1].body, f.calls[2].body);
  assert.equal(f.calls[1].headers['webhook-id'], f.calls[2].headers['webhook-id']);
  assert.notEqual(f.calls[1].headers['webhook-timestamp'], f.calls[2].headers['webhook-timestamp']);
  assert.notEqual(f.calls[1].headers['webhook-signature'], f.calls[2].headers['webhook-signature']);
});

test('retry attempts are bounded and terminal HTTP statuses never retry', async t => {
  const f = fixture(t, { respond: () => ({ status: 503 }) }); await f.events.upsert(f.registration, f.input()); f.enqueue();
  for (let i = 1; i <= EVENT_LIMITS.maxAttempts; i++) {
    const result = await f.events.dispatchOne();
    assert.equal(result.attempts, i); assert.equal(result.status, i === EVENT_LIMITS.maxAttempts ? 'dead' : 'pending');
    f.advance(1000 * 2 ** (i - 1));
  }
  assert.equal(await f.events.dispatchOne(), null);
  for (const status of [302, 400, 401, 403, 404, 410, 413]) {
    f.setResponder(() => ({ status })); f.enqueue(`terminal-${status}`);
    assert.equal((await f.events.dispatchOne()).status, 'dead');
  }
});

test('unsubscribe is scoped and idempotent; re-subscribe does not resurrect cancelled deliveries', async t => {
  const f = fixture(t); await f.events.upsert(f.registration, f.input()); f.enqueue();
  assert.throws(() => f.events.delete({ ...f.registration, owner_subject: 'other' }, f.remove()), { code: 'registration_inactive' });
  assert.deepEqual(f.events.delete(f.registration, f.remove()), {});
  assert.deepEqual(f.events.delete(f.registration, f.remove()), {});
  await f.events.upsert(f.registration, f.input());
  assert.equal(await f.events.dispatchOne(), null);
  f.enqueue('new-task'); assert.equal((await f.events.dispatchOne()).status, 'delivered');
});

test('subscription/key expiry and live revocation stop all queued deliveries', async t => {
  for (const cause of ['subscription', 'key', 'revocation']) {
    const f = fixture(t);
    const registration = cause === 'key' ? { ...f.registration, expires_at: f.now() + 1000 } : f.registration;
    await f.events.upsert(registration, f.input(cause === 'subscription' ? { ttlMs: 1000 } : {})); f.enqueue();
    if (cause === 'revocation') f.revoke(); else f.advance(1000);
    assert.equal(await f.events.dispatchOne(), null, cause);
    assert.equal(f.calls.length, 1, cause);
    assert.equal(f.store.db.prepare('SELECT secret FROM managed_bridge_subscriptions').get().secret, null);
  }
});

test('DNS is revalidated each time, blocks rebinding/mixed answers and revocation after DNS', async t => {
  for (const answer of [[{ address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 6 }], []]) {
    const f = fixture(t); await f.events.upsert(f.registration, f.input()); f.enqueue(); f.setResolver(() => answer);
    assert.equal((await f.events.dispatchOne()).status, 'dead'); assert.equal(f.calls.length, 1);
  }
  const f = fixture(t); await f.events.upsert(f.registration, f.input()); f.enqueue();
  f.setResolver(() => { f.revoke(); return [{ address: '8.8.8.8', family: 4 }]; });
  assert.equal((await f.events.dispatchOne()).status, 'cancelled'); assert.equal(f.calls.length, 1);
});

test('concurrent unsubscribe aborts verification and cannot be undone by its late result', async t => {
  const f = fixture(t); let started;
  const reached = new Promise(resolve => { started = resolve; });
  f.events.transport = request => { started(); return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); };
  const pending = f.events.upsert(f.registration, f.input()); await reached;
  f.events.delete(f.registration, f.remove());
  await assert.rejects(pending, { code: 'callback_verification_failed' });
  assert.equal(f.store.db.prepare('SELECT status FROM managed_bridge_subscriptions').get().status, 'deleted');
});

test('live revoke aborts an in-flight delivery and cannot record it as successful', async t => {
  const f = fixture(t); await f.events.upsert(f.registration, f.input()); f.enqueue();
  let started; const reached = new Promise(resolve => { started = resolve; });
  f.setResponder(request => { started(); return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); });
  const pending = f.events.dispatchOne(); await reached; f.revoke();
  assert.equal((await pending).status, 'cancelled');
});

test('graceful shutdown aborts transport but leaves an authorized delivery retryable on restart', async t => {
  const f = fixture(t); await f.events.upsert(f.registration, f.input()); f.enqueue();
  let started; const reached = new Promise(resolve => { started = resolve; });
  f.setResponder(request => { started(); return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); });
  const pending = f.events.dispatchOne(); await reached; f.events.close();
  assert.equal((await pending).status, 'pending');
  assert.equal(await f.events.dispatchOne(), null);
  assert.equal(f.store.db.prepare('SELECT status, secret FROM managed_bridge_subscriptions').get().status, 'active');
});

test('lost-worker lease is recovered with stable event identity', async t => {
  const f = fixture(t); await f.events.upsert(f.registration, f.input()); const eventId = f.enqueue();
  const lost = f.events.claim(); assert.equal(lost.event_id, eventId); assert.equal(await f.events.dispatchOne(), null);
  f.advance(EVENT_LIMITS.deliveryLeaseMs + 1);
  const result = await f.events.dispatchOne(); assert.equal(result.eventId, eventId); assert.equal(result.status, 'delivered'); assert.equal(result.attempts, 2);
});

test('secret rotation is verified and emits both signatures only within bounded overlap', async t => {
  const f = fixture(t); const sub = await f.events.upsert(f.registration, f.input());
  const replacement = `whsec_${Buffer.from('second-offline-fixture-secret-000').toString('base64')}`;
  const rotated = await f.events.upsert(f.registration, f.input({ delivery: { mode: 'webhook', url: f.input().delivery.url, secret: replacement } }));
  assert.equal(sub.id, rotated.id); assert.equal(f.calls.length, 2);
  f.enqueue(); await f.events.dispatchOne();
  assert.equal(f.calls[2].headers['webhook-signature'].split(' ').length, 2);
  const expected = standardWebhookHeaders(replacement, f.calls[2].headers['webhook-id'], f.calls[2].body, f.now())['webhook-signature'];
  assert.equal(f.calls[2].headers['webhook-signature'].split(' ')[0], expected);
  f.advance(EVENT_LIMITS.rotationMs + 1); f.enqueue('post-rotation'); await f.events.dispatchOne();
  assert.equal(f.calls[3].headers['webhook-signature'].split(' ').length, 1);
});

test('ready generations emit distinct wake IDs while retries of a generation stay idempotent', async t => {
  const f = fixture(t); await f.events.upsert(f.registration, f.input());
  const ready = generation => f.store.transaction(() => f.events.enqueueTaskReady(f.registration, { task_id: 'followup-task', queue: 'website-chat', created_at: f.now(), generation }));
  const first = ready(0); assert.equal(ready(0), first);
  f.advance(1000); const second = ready(1); assert.notEqual(first, second); assert.equal(ready(1), second);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM managed_bridge_event_deliveries').get().n, 2);
  await f.events.dispatchOne(); await f.events.dispatchOne();
  assert.equal(JSON.parse(f.calls[1].body).data.task_id, JSON.parse(f.calls[2].body).data.task_id);
});

test('no externally visible verification or delivery is allowed before an outer transaction commits', async t => {
  const f = fixture(t); await f.events.upsert(f.registration, f.input()); f.enqueue();
  f.store.db.exec('BEGIN IMMEDIATE');
  try {
    await assert.rejects(f.events.upsert(f.registration, f.input()), /transaction/);
    await assert.rejects(f.events.dispatchOne(), /transaction/);
  } finally { f.store.db.exec('ROLLBACK'); }
  assert.equal(f.calls.length, 1);
});

test('revocation during verification prevents activation and emits no application data', async t => {
  const f = fixture(t);
  f.events.transport = request => {
    const body = JSON.parse(request.body); f.revoke(); return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
  };
  await assert.rejects(f.events.upsert(f.registration, f.input()), /active|verified/);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM managed_bridge_subscriptions WHERE status='active'").get().n, 0);
});

test('subscription refresh failure preserves the previously verified destination and key', async t => {
  const f = fixture(t); await f.events.upsert(f.registration, f.input());
  const previous = f.store.db.prepare('SELECT secret, expires_at FROM managed_bridge_subscriptions').get();
  f.events.transport = () => ({ status: 500 });
  await assert.rejects(f.events.upsert(f.registration, f.input({ delivery: { mode: 'webhook', url: f.input().delivery.url, secret: `whsec_${Buffer.from('second-offline-fixture-secret-000').toString('base64')}` } })), { code: 'callback_verification_failed' });
  const current = f.store.db.prepare('SELECT secret, expires_at FROM managed_bridge_subscriptions').get(); assert.deepEqual(current, previous);
});

test('durable outbox and subscription survive restart without duplicate delivery', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'managed-events-test-'));
  const filename = join(directory, 'fixture.sqlite');
  let store = new TaskStore(filename, { now: () => 1800000000000 });
  let events;
  t.after(() => { events?.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const registration = { site_id: 'site-fixture', owner_subject: 'owner-fixture', key_id: 'key-fixture', queue: 'website-chat', expires_at: 1800000000000 + 86400000 };
  const requests = [], options = { enabled: true, allowedCallbackOrigins: [TRUSTED], registrationActive: () => true,
    resolver: () => [{ address: '8.8.8.8', family: 4 }], transport: request => {
      requests.push(request); const body = JSON.parse(request.body); return body.type === 'verification' ? { status: 200, body: JSON.stringify({ challenge: body.challenge }) } : { status: 204 };
    } };
  events = new ManagedBridgeEvents(store, options);
  await events.upsert(registration, { name: 'task.created', arguments: { queue: 'website-chat' }, delivery: { mode: 'webhook', url: `${TRUSTED}/durable-test`, secret: SECRET } });
  const eventId = store.transaction(() => events.enqueueTaskCreated(registration, { task_id: 'durable-task', queue: 'website-chat', created_at: store.now() }));
  events.close(); store.close();
  store = new TaskStore(filename, { now: () => 1800000000000 + 1000 }); events = new ManagedBridgeEvents(store, options);
  assert.deepEqual(await events.dispatchOne(), { eventId, status: 'delivered', attempts: 1 });
  events.close(); store.close();
  store = new TaskStore(filename, { now: () => 1800000000000 + 2000 }); events = new ManagedBridgeEvents(store, options);
  assert.equal(await events.dispatchOne(), null); assert.equal(requests.length, 2);
});

test('status uses actual durable acknowledgement time, scoped to the currently active registration', async t => {
  const f = fixture(t);
  const empty = { subscription_active: false, last_delivery_at: null, delivery_pending: 0, delivery_dead: 0 };
  assert.deepEqual(f.events.status(f.registration), empty);
  await f.events.upsert(f.registration, f.input()); f.enqueue();
  assert.deepEqual(f.events.status(f.registration), { ...empty, subscription_active: true, delivery_pending: 1 });
  f.advance(4321); await f.events.dispatchOne();
  assert.deepEqual(f.events.status(f.registration), { ...empty, subscription_active: true, last_delivery_at: f.now() });
  assert.deepEqual(f.events.status({ ...f.registration, owner_subject: 'someone-else' }), empty);
  assert.deepEqual(f.events.status(null), empty);
  f.revoke(); assert.deepEqual(f.events.status(f.registration), empty);
});

test('Standard Webhooks signs immutable body bytes, id and Unix-seconds attempt timestamp', () => {
  const body = '{"type":"task.created","data":{"task_id":"task-1"}}';
  const headers = standardWebhookHeaders(SECRET, 'evt_123', body, 1800000000123);
  const expected = createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64')).update(`evt_123.1800000000.${body}`).digest('base64');
  assert.deepEqual(headers, { 'webhook-id': 'evt_123', 'webhook-timestamp': '1800000000', 'webhook-signature': `v1,${expected}` });
  assert.notEqual(standardWebhookHeaders(SECRET, 'evt_123', `${body} `, 1800000000123)['webhook-signature'], headers['webhook-signature']);
  assert.throws(() => standardWebhookHeaders(SECRET, 'evt.bad', body, 1800000000123));
  for (const secret of ['bad', 'whsec_Zg==', `${SECRET}\n`, 'whsk_' + SECRET.slice(6), SECRET.replace('whsec_', '')]) {
    assert.throws(() => standardWebhookHeaders(secret, 'evt_123', body, 1800000000123));
  }
});
