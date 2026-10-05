// Offline child process only. Loopback pinning is passed directly to the transport
// unit; production callback validation continues to reject every loopback address.
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { pinnedHttpsTransport } from '../managed-bridge-events.mjs';
const [keyPath, certPath] = process.argv.slice(2);
const seen = [];
const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (request, response) => {
  seen.push({ host: request.headers.host, sni: request.socket.servername });
  if (request.url === '/reset') { request.socket.destroy(); return; }
  if (request.url === '/malformed') { request.socket.end('NOT HTTP\r\n\r\n'); return; }
  if (request.url === '/hang') return;
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => response.end(body));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const send = (path, hostname = 'callbacks.example.test', signal) => pinnedHttpsTransport({
  url: new URL(`https://${hostname}:${port}${path}`), address: { address: '127.0.0.1', family: 4 },
  headers: {}, body: '{"challenge":"offline-fixture"}', timeoutMs: 1000, connectTimeoutMs: 500, readResponse: true, signal,
});
const failure = (reason, code, phase, retryable = false) => error => {
  assert.equal(error.reason, reason); assert.equal(error.transportCode, code);
  assert.equal(error.transportPhase, phase); assert.equal(error.retryableConnection, retryable);
  assert.equal(error.cause, undefined);
  return true;
};
try {
  assert.deepEqual(await send('/echo'), { status: 200, body: '{"challenge":"offline-fixture"}' });
  assert.deepEqual(seen[0], { host: `callbacks.example.test:${port}`, sni: 'callbacks.example.test' });
  await assert.rejects(send('/reset'), failure('transport_error', 'ECONNRESET', 'response'));
  await assert.rejects(send('/malformed'), failure('transport_error', 'HPE_INVALID_CONSTANT', 'response'));
  await assert.rejects(send('/echo', 'wrong.example.test'), failure('tls_error', 'ERR_TLS_CERT_ALTNAME_INVALID', 'tls'));
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), 50);
  try { await assert.rejects(send('/hang', 'callbacks.example.test', controller.signal), { reason: 'cancelled' }); }
  finally { clearTimeout(abort); }
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
await assert.rejects(send('/echo'), failure('connect_error', 'ECONNREFUSED', 'connect', true));
console.log('Real Node HTTPS fixture passed: lookup, Host/SNI, TLS verification, peer reset, malformed HTTP, cancellation, refusal.');
