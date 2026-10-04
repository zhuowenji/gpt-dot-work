// Operator-only revocation. Does not create/rotate credentials or expose secrets.
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { TaskStore } from './store.mjs';
const [path, keyId, ...extra] = process.argv.slice(2);
if (!path || !isAbsolute(path) || !existsSync(path) || !/^[A-Za-z0-9._:-]{8,100}$/.test(keyId || '') || extra.length) {
  process.stderr.write('Usage: node backend/managed-bridge-revoke.mjs /absolute/existing/state.sqlite PUBLIC_KEY_ID\n');
  process.exitCode = 2;
} else {
  process.umask(0o077);
  const store = new TaskStore(path);
  try {
    store.db.exec('CREATE TABLE IF NOT EXISTS managed_bridge_revocations (key_id TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL)');
    store.db.prepare('INSERT INTO managed_bridge_revocations(key_id, revoked_at) VALUES (?, ?) ON CONFLICT(key_id) DO NOTHING').run(keyId, store.now());
    process.stdout.write('Public key registration revoked. New requests are denied; active deliveries observe durable revocation.\n');
  } finally { store.close(); }
}
