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
const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'owner_sessions'").get();
if (exists) db.exec('DELETE FROM owner_sessions;');
db.close();
process.stdout.write('All owner browser sessions have been revoked.\n');
