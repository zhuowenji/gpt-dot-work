#!/usr/bin/env node
// Bounded HTTP acceptance client, no dependencies, no browser/owner credentials.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export const USERS = 10, WARM_WAVES = 3;
export const payload = content => ({ content, attachments: [], agent_id: null });
export function quantiles(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  const q = p => v.length ? Number(v[Math.max(0, Math.ceil(p * v.length) - 1)].toFixed(3)) : null;
  return { n: v.length, p50: q(.50), p95: q(.95), p99: q(.99), min: v.length ? Number(v[0].toFixed(3)) : null, max: q(1) };
}
export function metrics(rows) {
  return {
    serverReceiptMs: quantiles(rows.map(r => r.serverReceiptMs)),
    clientHeadersMs: quantiles(rows.map(r => r.clientHeadersMs)),
    clientAckMs: quantiles(rows.map(r => r.clientAckMs)),
    clientMinusServerMs: quantiles(rows.map(r => r.serverReceiptMs === null ? null : r.clientAckMs - r.serverReceiptMs)),
  };
}
export function client(base, origin) {
  const jar = new Map(); let csrf;
  const c = { base, origin, records: [], csrf: () => csrf };
  c.request = async (path, { method = 'GET', body, key = randomUUID(), label = '', csrfOverride, headers = {} } = {}) => {
    const mutation = !['GET', 'HEAD'].includes(method);
    const start = performance.now();
    const response = await fetch(c.base + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: {
        Origin: c.origin || new URL(c.base).origin,
        ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(mutation ? { 'X-CSRF-Token': csrfOverride ?? csrf, 'X-Idempotency-Key': key } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers,
      }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const clientHeadersMs = performance.now() - start;
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], split = pair.indexOf('=');
      if (/Max-Age=0(?:;|$)/.test(cookie)) jar.delete(pair.slice(0, split));
      else jar.set(pair.slice(0, split), pair.slice(split + 1));
    }
    const data = await response.json();
    if (data.csrfToken) csrf = data.csrfToken;
    const timing = response.headers.get('Server-Timing')?.match(/(?:^|,)\s*intake-receipt;dur=([\d.]+)/);
    const result = { status: response.status, data, clientHeadersMs, clientAckMs: performance.now() - start,
      serverReceiptMs: timing ? Number(timing[1]) : null };
    c.records.push({ label, method, path, status: result.status, clientHeadersMs: result.clientHeadersMs,
      clientAckMs: result.clientAckMs, serverReceiptMs: result.serverReceiptMs });
    return result;
  };
  return c;
}
function ack(r, message) {
  assert.equal(r.status, 201, message || JSON.stringify(r.data));
  assert.equal(r.data.received, true); assert.equal(r.data.execution_connected, false);
}
export async function runAcceptance({ base, origin, expectedRelease, restart, includeAuth = false }) {
  const runId = randomUUID(); const clients = Array.from({ length: USERS }, () => client(base, origin));
  const passed = [], cold = [], warm = [], threads = [], expected = [];
  const health = await clients[0].request('/health', { label: 'health' });
  assert.equal(health.status, 200); if (expectedRelease) assert.equal(health.data.releaseId, expectedRelease);
  const identities = await Promise.all(clients.map(c => c.request('/api/chat/me', { label: 'identity' })));
  identities.forEach(r => { assert.equal(r.status, 200); assert.equal(r.data.role, 'visitor'); assert.equal(r.data.execution_connected, false); });
  assert.equal(new Set(identities.map(r => r.data.identity)).size, USERS);
  passed.push('10 independent anonymous sessions created through HTTP, on the same client IP');
  // Same key in all 10 sessions is intentional: scope must include identity.
  const createKey = `accept-${runId}-create`;
  await Promise.all(clients.map(async (c, i) => {
    const text = `Acceptance ${runId} synthetic user ${i}: first request`;
    const r = await c.request('/api/chat/tasks', { method: 'POST', body: payload(text), key: createKey, label: 'cold-create' });
    ack(r); cold.push(r); threads[i] = r.data.id; expected[i] = [text];
  }));
  assert.equal(new Set(threads).size, USERS);
  passed.push('10 simultaneous first requests acknowledged; shared idempotency keys remain session-scoped');
  const warmKeys = [], warmReceipts = [];
  for (let wave = 0; wave < WARM_WAVES; wave++) {
    warmKeys[wave] = randomUUID(); warmReceipts[wave] = [];
    await Promise.all(clients.map(async (c, i) => {
      const text = `Acceptance ${runId} synthetic user ${i}: follow-up ${wave}`;
      const r = await c.request(`/api/chat/tasks/${threads[i]}/messages`, { method: 'POST', body: payload(text), key: warmKeys[wave], label: 'warm-append' });
      ack(r); warm.push(r); warmReceipts[wave][i] = r.data; expected[i].push(text);
    }));
  }
  const verifyHistory = async label => {
    await Promise.all(clients.map(async (c, i) => {
      const listing = await c.request('/api/chat/tasks', { label });
      assert.equal(listing.status, 200); assert.deepEqual(listing.data.tasks.map(t => t.id), [threads[i]]);
      const detail = await c.request(`/api/chat/tasks/${threads[i]}`, { label });
      assert.equal(detail.status, 200); assert.deepEqual(detail.data.messages.map(m => m.content), expected[i]);
      assert(detail.data.messages.every(m => m.role === 'user')); assert.equal(detail.data.task.execution_connected, false);
    }));
  };
  await verifyHistory('immediate-durable-read');
  passed.push('After the intake bursts, every acknowledged message is retrievable through its own session with exact content and no duplicate');
  await Promise.all(clients.map(async (c, i) => {
    const replay = await c.request('/api/chat/tasks', { method: 'POST', body: payload(expected[i][0]), key: createKey, label: 'creation-replay' });
    ack(replay); assert.equal(replay.data.id, threads[i]);
    const lastWave = WARM_WAVES - 1;
    const appendReplay = await c.request(`/api/chat/tasks/${threads[i]}/messages`, { method: 'POST', body: payload(expected[i][WARM_WAVES]), key: warmKeys[lastWave], label: 'append-replay' });
    ack(appendReplay); assert.deepEqual(appendReplay.data, warmReceipts[lastWave][i]);
    const conflict = await c.request('/api/chat/tasks', { method: 'POST', body: payload('changed payload'), key: createKey, label: 'idempotency-conflict' });
    assert.equal(conflict.status, 409); assert.equal(conflict.data.error.code, 'idempotency_conflict');
  }));
  passed.push('Creation and append retries return the original receipt; changed input with the same key is rejected');
  // Bounded duplicate race: 5 identities × 2 requests at a time, at most 10 in flight.
  for (let offset = 0; offset < USERS; offset += 5) {
    await Promise.all(clients.slice(offset, offset + 5).map(async (c, k) => {
      const i = offset + k, text = `Acceptance ${runId} synthetic user ${i}: simultaneous retry`;
      const key = randomUUID(), path = `/api/chat/tasks/${threads[i]}/messages`;
      const pair = await Promise.all([0, 1].map(() => c.request(path, { method: 'POST', body: payload(text), key, label: 'duplicate-race' })));
      pair.forEach(r => ack(r)); assert.deepEqual(pair[0].data, pair[1].data); expected[i].push(text);
    }));
  }
  passed.push('Concurrent same-key duplicate retries create exactly one message per user');
  // All 90 off-diagonal reads are checked in sequential waves of 10.
  for (let shift = 1; shift < USERS; shift++) {
    await Promise.all(clients.map(async (c, i) => {
      const r = await c.request(`/api/chat/tasks/${threads[(i + shift) % USERS]}`, { label: 'cross-session-read' });
      assert.equal(r.status, 404); assert(!JSON.stringify(r.data).includes(runId));
    }));
  }
  await Promise.all(clients.map(async (c, i) => {
    const r = await c.request(`/api/chat/tasks/${threads[(i + 1) % USERS]}/messages`, { method: 'POST', body: payload('must never be saved'), label: 'cross-session-write' });
    assert.equal(r.status, 404);
  }));
  const missingCsrf = await clients[0].request(`/api/chat/tasks/${threads[0]}/messages`, { method: 'POST', body: payload('must never be saved'), csrfOverride: 'invalid', label: 'bad-csrf' });
  assert.equal(missingCsrf.status, 403);
  passed.push('All 90 cross-session reads denied, 10 cross-session writes denied, invalid CSRF denied');
  await verifyHistory('verified-history');
  let restartChecked = false;
  if (restart) {
    base = await restart(); clients.forEach(c => { c.base = base; });
    await verifyHistory('post-kill-restart-history');
    await Promise.all(clients.map(async (c, i) => {
      const replay = await c.request('/api/chat/tasks', { method: 'POST', body: payload(expected[i][0]), key: createKey, label: 'post-restart-replay' });
      ack(replay); assert.equal(replay.data.id, threads[i]);
    }));
    await verifyHistory('post-restart-final-history'); restartChecked = true;
    passed.push('SIGKILL/reopen of the same SQLite database preserves all 50 messages, sessions, and idempotent creation receipts');
  }
  const auth = { measured: false };
  if (includeAuth) {
    const signup = [], login = [];
    for (let i = 0; i < 2; i++) {
      const c = clients[i];
      const credentials = { username: `accept_${runId.slice(0, 8)}_${i}`, password: randomUUID() };
      const s = await c.request('/api/chat/account/signup', { method: 'POST', body: credentials, label: 'separate-signup' });
      assert.equal(s.status, 200); assert.equal(s.data.role, 'account'); signup.push(s);
      const migrated = await c.request('/api/chat/tasks', { label: 'account-migration' });
      assert.deepEqual(migrated.data.tasks.map(t => t.id), [threads[i]]);
      assert.equal((await c.request('/api/chat/account/logout', { method: 'POST', body: {}, label: 'auth-logout' })).status, 200);
      await c.request('/api/chat/me', { label: 'post-logout-identity' });
      const l = await c.request('/api/chat/account/login', { method: 'POST', body: credentials, label: 'separate-login' });
      assert.equal(l.status, 200); assert.equal(l.data.role, 'account'); login.push(l);
      const own = await c.request('/api/chat/tasks', { label: 'account-recovered-history' });
      assert.deepEqual(own.data.tasks.map(t => t.id), [threads[i]]);
    }
    Object.assign(auth, { measured: true, signup: metrics(signup), login: metrics(login), note: 'Two sequential signups and two sequential logins only. Not an auth-capacity benchmark; never mixed into intake statistics.' });
    passed.push('Two optional accounts separately register, migrate only their own guest history, logout and log back in');
  }
  return {
    runId, health: health.data, checkedAt: new Date().toISOString(), users: USERS, maxInFlight: 10,
    measurement: {
      interface: 'HTTP API, not browser UI',
      coldDefinition: 'First intake-create wave after health and anonymous session initialization',
      warmDefinition: 'Three append waves on the same 10 existing conversations',
      serverReceiptDefinition: 'Only available with trusted intake-receipt Server-Timing instrumentation; unavailable is null, never inferred from client timing',
      clientAckDefinition: 'Dispatch through complete JSON response; includes transport, queueing and client parsing',
      residualDefinition: 'Client minus server time is combined overhead, not an isolated network measurement',
      percentileMethod: 'Nearest rank; low sample counts, p99 is effectively maximum',
      aiStartAndReply: 'Unmeasured; disabled execution connector',
      restartDurability: restart ? 'SIGKILL recovery of the same SQLite file' : 'Not checked by this portable external run',
    },
    cold: metrics(cold), warm: metrics(warm), auth,
    thresholds: { serverReceiptP95TargetMs: 200, coldPassed: metrics(cold).serverReceiptMs.n ? metrics(cold).serverReceiptMs.p95 <= 200 : null,
      warmPassed: metrics(warm).serverReceiptMs.n ? metrics(warm).serverReceiptMs.p95 <= 200 : null },
    functional: { passed, restartChecked, uniqueThreads: USERS, uniqueMessages: USERS * (WARM_WAVES + 2) },
    requests: clients.flatMap(c => c.records),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
  if (!args.includes('--base')) throw new Error('Usage: node verifier.mjs --base URL [--allow-writes --authorized-remote --expected-release SHA] [--out report.json]. Default is read-only /health.');
  const base = value('--base').replace(/\/$/, ''), parsed = new URL(base);
  assert(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash, 'Use a bare HTTP(S) origin without credentials');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  const ownedRemoteOrigins = new Set(['https://dot.075900.vip']);
  if (!local) assert(ownedRemoteOrigins.has(parsed.origin), 'Remote origin is not in the exact owned-origin allowlist: https://dot.075900.vip');
  const origin = args.includes('--origin') ? value('--origin') : parsed.origin;
  assert(origin === parsed.origin || (local && ownedRemoteOrigins.has(origin)), 'Origin override is limited to the owned site on a loopback target');
  const ownedDeployment = !local || origin !== parsed.origin;
  if (!args.includes('--allow-writes')) {
    const response = await fetch(base + '/health', { redirect: 'error', signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    const health = await response.json();
    if (args.includes('--expected-release')) assert.equal(health.releaseId, value('--expected-release'));
    console.log(JSON.stringify({ mode: 'read-only', base, health, note: 'Only GET /health was sent. No sessions, messages, accounts or performance run created.' }, null, 2));
  } else {
    if (ownedDeployment) {
      assert(args.includes('--authorized-remote'), 'Remote writes require explicit operator authorization with --authorized-remote');
      assert(args.includes('--expected-release'), 'Remote writes require --expected-release to verify the intended deployment before session creation');
    }
    const report = await runAcceptance({ base, origin, expectedRelease: args.includes('--expected-release') ? value('--expected-release') : undefined });
    const out = args.includes('--out') ? value('--out') : 'acceptance-results.json';
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ out, cold: report.cold, warm: report.warm, functional: report.functional, backendTarget: report.thresholds, measurement: report.measurement }, null, 2));
    if (report.thresholds.coldPassed === false || report.thresholds.warmPassed === false) process.exitCode = 1;
  }
}
