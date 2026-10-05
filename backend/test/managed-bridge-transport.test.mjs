import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { TaskStore } from '../store.mjs';
import { ManagedBridgeEvents, EVENT_LIMITS } from '../managed-bridge-events.mjs';

// Fixed offline fixtures. Mocked HTTPS never opens a socket or resolves DNS.
const SECRET = `whsec_${Buffer.from('fixed-offline-fixture-secret-0000').toString('base64')}`;
const URL = 'https://callbacks.example.test/opaque-fixture-path?token=opaque-fixture-query';
const PUBLIC = [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
const PRIVATE = [{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.1', family: 4 }];
const rawError = code => Object.assign(new Error(`RAW_EXCEPTION ${URL} ${SECRET} PRIVATE_RESPONSE PRIVATE_HEADER`), { code });

function mockHttps(t, behavior) {
  const calls = [];
  const original = https.request;
  t.mock.method(https, 'request', (url, options, onResponse) => {
    const request = new EventEmitter(), socket = new EventEmitter();
    request.destroy = error => { request.destroyed = true; if (error) request.emit('error', error); return request; };
    const aborted = () => request.destroy(rawError('ABORT_ERR'));
    options.signal.addEventListener('abort', aborted, { once: true });
    request.once('error', () => options.signal.removeEventListener('abort', aborted));
    const call = { url, options, request, socket };
    calls.push(call);
    request.end = body => {
      call.body = body;
      queueMicrotask(() => {
        request.emit('socket', socket);
        behavior(call, calls.length - 1, (status = 200, responseBody = JSON.stringify({ challenge: JSON.parse(body).challenge })) => {
          socket.emit('connect'); socket.emit('secureConnect');
          const response = new EventEmitter();
          response.statusCode = status; response.destroy = () => {};
          onResponse(response);
          if (responseBody !== undefined) response.emit('data', Buffer.from(responseBody));
          response.emit('end');
          options.signal.removeEventListener('abort', aborted);
        });
      });
      return request;
    };
    return request;
  });
  syncBuiltinESMExports();
  t.after(() => { https.request = original; syncBuiltinESMExports(); });
  return calls;
}

function fixture(t, { resolver = () => PUBLIC, behavior = (_call, _index, respond) => respond() } = {}) {
  let live = true;
  const store = new TaskStore(':memory:');
  const registration = { site_id: 'site-fixture', owner_subject: 'owner-fixture', key_id: 'key-fixture', queue: 'website-chat', expires_at: Date.now() + 86400000 };
  const calls = mockHttps(t, behavior), dns = [];
  const events = new ManagedBridgeEvents(store, { enabled: true, allowedCallbackOrigins: ['https://callbacks.example.test'],
    registrationActive: () => live, resolver: hostname => { dns.push(hostname); return resolver(hostname); } });
  t.after(() => { events.close(); store.close(); });
  const input = { name: 'task.created', arguments: { queue: 'website-chat' }, delivery: { mode: 'webhook', url: URL, secret: SECRET } };
  return { store, events, registration, calls, dns, input, verify: () => events.upsert(registration, input), revoke: () => { live = false; events.haltRevoked(); } };
}

function fakeClock(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1800000000000 });
  t.mock.method(performance, 'now', () => Date.now());
  return async milliseconds => { t.mock.timers.tick(milliseconds); await nextTurn(); };
}
function safeFailure(reason) {
  return error => {
    assert.equal(error.code, 'callback_verification_failed');
    assert.equal(error.reason, reason);
    const output = JSON.stringify(error) + error.message + error.stack;
    for (const value of [URL, 'opaque-fixture-path', 'opaque-fixture-query', SECRET, 'PRIVATE_RESPONSE', 'PRIVATE_HEADER', 'RAW_EXCEPTION']) assert.equal(output.includes(value), false, value);
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('first unreachable public address falls back within one validated DNS snapshot', async t => {
  const f = fixture(t, { behavior: (call, index, respond) => index === 0 ? call.request.emit('error', rawError('ENETUNREACH')) : respond() });
  await f.verify();
  assert.equal(f.calls.length, 2); assert.deepEqual(f.dns, ['callbacks.example.test']);
  for (const [index, call] of f.calls.entries()) {
    assert.equal(call.url.href, URL);
    assert.equal(call.options.servername, 'callbacks.example.test');
    assert.equal(call.options.rejectUnauthorized, true);
    assert.equal(call.options.agent, false);
    assert.equal(call.options.autoSelectFamily, false);
    call.options.lookup('callbacks.example.test', { all: true }, (error, answers) => { assert.equal(error, null); assert.deepEqual(answers, [PUBLIC[index]]); });
    call.options.lookup('callbacks.example.test', { all: false }, (error, address, family) => { assert.equal(error, null); assert.equal(address, PUBLIC[index].address); assert.equal(family, PUBLIC[index].family); });
    assert.equal(call.options.headers['content-type'], 'application/json');
  }
  assert.equal(f.calls[0].body, f.calls[1].body);
  assert.deepEqual(f.calls[0].options.headers, f.calls[1].options.headers);
});

test('any private or malformed DNS answer rejects the complete set before any connection', async t => {
  for (const answers of [PRIVATE, [PUBLIC[0], PRIVATE[0]], [PRIVATE[0], PUBLIC[0]], [{ address: '8.8.8.8', family: 6 }], []]) {
    const f = fixture(t, { resolver: () => answers });
    await assert.rejects(f.verify(), { code: 'callback_destination_denied' });
    assert.equal(f.calls.length, 0);
  }
});

test('DNS errors and DNS timeouts have finite sanitized diagnostic reasons', async t => {
  const tick = fakeClock(t);
  const failed = fixture(t, { resolver: () => { throw rawError('ENOTFOUND'); } });
  await assert.rejects(failed.verify(), safeFailure('dns_error'));
  const hung = fixture(t, { resolver: () => new Promise(() => {}) });
  const result = assert.rejects(hung.verify(), safeFailure('dns_timeout'));
  await tick(EVENT_LIMITS.dnsTimeoutMs); await result;
  assert.equal(hung.calls.length, 0); assert.equal(hung.events.inFlight.size, 0);
});

test('connect timeout falls back before any TCP connection', async t => {
  const tick = fakeClock(t);
  const f = fixture(t, { behavior: (_call, index, respond) => { if (index > 0) respond(); } });
  const pending = f.verify(); await nextTurn();
  await tick(EVENT_LIMITS.connectTimeoutMs);
  await pending; assert.equal(f.calls.length, 2); assert.equal(f.calls[0].request.destroyed, true);
});

test('TLS certificate and handshake failures terminate without trying other addresses', async t => {
  for (const code of ['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ECONNRESET']) {
    const f = fixture(t, { behavior: call => { call.socket.emit('connect'); call.request.emit('error', rawError(code)); } });
    await assert.rejects(f.verify(), safeFailure('tls_error')); assert.equal(f.calls.length, 1);
  }
});

test('HTTP errors, redirects, challenge mismatch and oversized responses never fall back', async t => {
  for (const [status, body, reason] of [[302, 'PRIVATE_RESPONSE', 'http_error'], [503, 'PRIVATE_RESPONSE', 'http_error'], [200, '{"challenge":"PRIVATE_RESPONSE"}', 'challenge_mismatch'], [200, 'PRIVATE_RESPONSE'.repeat(400), 'response_invalid']]) {
    const f = fixture(t, { behavior: (_call, _index, respond) => respond(status, body) });
    await assert.rejects(f.verify(), safeFailure(reason)); assert.equal(f.calls.length, 1);
  }
});

test('reset after TCP connection never retries a possibly transmitted POST', async t => {
  const f = fixture(t, { behavior: call => { call.socket.emit('connect'); call.socket.emit('secureConnect'); call.request.emit('error', rawError('ECONNRESET')); } });
  await assert.rejects(f.verify(), safeFailure('transport_error')); assert.equal(f.calls.length, 1);
});

test('DNS and all address attempts share one total ten-second monotonic deadline', async t => {
  const tick = fakeClock(t);
  let resolveDns;
  const f = fixture(t, { resolver: () => new Promise(resolve => { resolveDns = resolve; }), behavior: (call, index) => { if (index > 0) call.socket.emit('connect'); } });
  const pending = assert.rejects(f.verify(), safeFailure('request_timeout'));
  await tick(2500); resolveDns(PUBLIC); await nextTurn();
  assert.equal(f.calls.length, 1);
  await tick(3000); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].options.timeout, 4500);
  await tick(4499); assert.equal(f.events.inFlight.size, 1);
  await tick(1); await pending;
  assert.equal(f.events.inFlight.size, 0); assert.equal(f.calls[1].request.destroyed, true);
});

test('revocation aborts the current address and cannot start a fallback', async t => {
  const f = fixture(t, { behavior: () => {} });
  const pending = assert.rejects(f.verify(), safeFailure('cancelled'));
  await nextTurn(); f.revoke(); await pending;
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].request.destroyed, true);
  assert.equal(f.events.inFlight.size, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM managed_bridge_subscriptions WHERE status = 'active'").get().n, 0);
});

test('transport and delivery diagnostics never retain raw messages, URLs, response data or headers', async t => {
  let delivery = false;
  const f = fixture(t, { behavior: (call, _index, respond) => delivery ? call.request.emit('error', rawError('UNRECOGNIZED_SECRET_CODE')) : respond() });
  await f.verify(); delivery = true;
  f.store.transaction(() => f.events.enqueueTaskCreated(f.registration, { task_id: 'offline-task', queue: 'website-chat', created_at: f.store.now() }));
  const result = await f.events.dispatchOne();
  assert.equal(result.status, 'pending');
  const record = f.store.db.prepare('SELECT last_code FROM managed_bridge_event_deliveries').get();
  assert.equal(record.last_code, 'callback_transport_error');
  assert.equal(f.calls.length, 2);
  for (const value of [URL, SECRET, 'PRIVATE_RESPONSE', 'PRIVATE_HEADER', 'RAW_EXCEPTION']) assert.equal(JSON.stringify({ result, record }).includes(value), false);
});


test('all public connection failures exhaust only the same snapshot with a safe reason', async t => {
  for (const [code, reason] of [['ECONNREFUSED', 'connect_error'], ['ETIMEDOUT', 'connect_timeout']]) {
    const f = fixture(t, { behavior: call => call.request.emit('error', rawError(code)) });
    await assert.rejects(f.verify(), safeFailure(reason));
    assert.equal(f.calls.length, PUBLIC.length); assert.equal(f.dns.length, 1);
    assert(f.calls.every(call => call.options.signal.aborted));
  }
});

test('duplicate answers are attempted once and excessive DNS answer sets fail closed', async t => {
  const f = fixture(t, { resolver: () => [PUBLIC[0], PUBLIC[0], PUBLIC[1]], behavior: (call, index, respond) => index === 0 ? call.request.emit('error', rawError('ECONNREFUSED')) : respond() });
  await f.verify(); assert.equal(f.calls.length, 2);
  const excessive = fixture(t, { resolver: () => Array(65).fill(PUBLIC[0]) });
  await assert.rejects(excessive.verify(), { code: 'callback_destination_denied' });
  assert.equal(excessive.calls.length, 0);
});

test('revocation or close between failed addresses prevents any further socket', async t => {
  for (const cause of ['revoke', 'close']) {
    const f = fixture(t, { behavior: call => {
      call.request.emit('error', rawError('ECONNREFUSED'));
      if (cause === 'revoke') f.revoke(); else f.events.close();
    } });
    await assert.rejects(f.verify(), safeFailure('cancelled')); assert.equal(f.calls.length, 1);
  }
});

test('validated address snapshot is isolated from later resolver-object mutation', async t => {
  const answers = PUBLIC.map(answer => ({ ...answer }));
  const f = fixture(t, { resolver: () => answers, behavior: (call, index, respond) => {
    if (index === 0) { answers[1].address = '127.0.0.1'; call.request.emit('error', rawError('ECONNREFUSED')); }
    else respond();
  } });
  await f.verify(); assert.equal(f.calls.length, 2);
  f.calls[1].options.lookup('callbacks.example.test', { all: true }, (_error, pinned) => assert.deepEqual(pinned, [PUBLIC[1]]));
});
