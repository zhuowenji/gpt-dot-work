import { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
const path = process.env.WORKSPACE_DB_PATH;
if (!path || !isAbsolute(path) || !existsSync(path)) {
  process.stderr.write('Set WORKSPACE_DB_PATH to an existing absolute database path.\n');
  process.exit(1);
}
const db = new DatabaseSync(path);
db.exec('PRAGMA busy_timeout = 5000;');
// Restoring a backup must not revive any browser credential, including guests
// and optional accounts added after the original owner-only deployment.
for (const table of ['owner_sessions', 'chat_guest_sessions', 'chat_account_sessions', 'chat_account_idempotency']) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (exists) db.exec(`DELETE FROM ${table};`);
}
db.close();
process.stdout.write('All owner, guest and account browser sessions have been revoked.\n');
