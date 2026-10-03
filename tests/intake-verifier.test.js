import test from 'node:test';
import assert from 'node:assert/strict';
import { quantiles, metrics, USERS, WARM_WAVES } from '../scripts/verify-intake.mjs';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../scripts/verify-intake.mjs', import.meta.url));
test('nearest-rank percentiles include the maximum at p99 for bounded samples', () => {
  assert.deepEqual(quantiles([10, 1, 5, 4, 3, 2, 6, 8, 7, 9]), { n: 10, p50: 5, p95: 10, p99: 10, min: 1, max: 10 });
});
test('unavailable server timing is unknown, never a fabricated zero or client latency', () => {
  const m = metrics([{ serverReceiptMs: null, clientHeadersMs: 12, clientAckMs: 13 }]);
  assert.equal(m.serverReceiptMs.n, 0); assert.equal(m.serverReceiptMs.p95, null);
  assert.equal(m.clientMinusServerMs.n, 0); assert.equal(m.clientAckMs.p95, 13);
});
test('fixed workload stays bounded and does not silently scale to a stress test', () => {
  assert.equal(USERS, 10); assert.equal(WARM_WAVES, 3);
});
test('CLI defaults to exactly one read-only health request and creates no session', async () => {
  const requests = [];
  const server = createServer((req,res) => { requests.push(`${req.method} ${req.url}`); res.setHeader('Content-Type','application/json'); res.end('{"ok":true}'); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const child = spawn(process.execPath, [script, '--base', `http://127.0.0.1:${server.address().port}`]);
    let output = ''; child.stdout.on('data', b => { output += b; });
    const [code] = await once(child, 'exit');
    assert.equal(code,0); assert.deepEqual(requests,['GET /health']); assert.match(output,/read-only/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('CLI refuses any non-allowlisted remote origin before HTTP', () => {
  const r = spawnSync(process.execPath, [script, '--base', 'https://example.invalid', '--allow-writes', '--authorized-remote'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /not in the exact owned-origin allowlist/);
});
test('CLI refuses owned remote writes without explicit operator authorization before HTTP', () => {
  const r = spawnSync(process.execPath, [script, '--base', 'https://dot.075900.vip', '--allow-writes'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /Remote writes require explicit operator authorization/);
});
test('CLI refuses owned remote writes without expected release before HTTP', () => {
  const r = spawnSync(process.execPath, [script, '--base', 'https://dot.075900.vip', '--allow-writes', '--authorized-remote'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /Remote writes require --expected-release/);
});
test('CLI rejects an arbitrary Origin override before HTTP', () => {
  const r = spawnSync(process.execPath, [script, '--base', 'http://127.0.0.1:1', '--origin', 'https://example.invalid', '--allow-writes'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /Origin override is limited/);
});
test('loopback with owned-site Origin still requires production-write authorization', () => {
  const r = spawnSync(process.execPath, [script, '--base', 'http://127.0.0.1:1', '--origin', 'https://dot.075900.vip', '--allow-writes'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /Remote writes require explicit operator authorization/);
});
