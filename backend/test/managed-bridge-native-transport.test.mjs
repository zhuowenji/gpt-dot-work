import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('real Node HTTPS preserves pinning and identity and classifies actual socket/TLS failures', t => {
  try { execFileSync('openssl', ['version'], { stdio: 'pipe', timeout: 5000 }); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    t.skip('Optional native TLS fixture requires the local OpenSSL CLI'); return;
  }
  const directory = mkdtempSync(join(tmpdir(), 'callback-native-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const key = join(directory, 'fixture-key.pem'), cert = join(directory, 'fixture-cert.pem');
  // An ephemeral one-day test CA/key, never a production credential. OpenSSL is
  // local only. Its CA is trusted by this child process, never by the host or app.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=callbacks.example.test', '-addext', 'subjectAltName=DNS:callbacks.example.test'], { stdio: 'pipe', timeout: 10000 });
  const fixture = fileURLToPath(new URL('../fixtures/managed-https-transport-process.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [fixture, key, cert], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, encoding: 'utf8', timeout: 10000,
  });
  assert.match(output, /Real Node HTTPS fixture passed/);
});
