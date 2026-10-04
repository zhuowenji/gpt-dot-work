// Offline multiprocess test fixture. Input contains public registration only.
import { readFileSync } from 'node:fs';
import { TaskStore } from '../store.mjs';
import { ChatIntake } from '../chat.mjs';
import { OwnerAuth } from '../auth.mjs';
import { ManagedBridgeApi } from '../managed-bridge.mjs';
import { randomUUID } from 'node:crypto';
const [path, configPath, taskId, now] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const store = new TaskStore(path, { now: () => Number(now) });
try {
  const chat = new ChatIntake(store, config, new OwnerAuth(store, config));
  const api = new ManagedBridgeApi(store, config, chat);
  try { process.stdout.write(JSON.stringify(api.claim({ task_id: taskId, idempotency_key: randomUUID(), lease_seconds: 300 }))); }
  catch (error) { process.stdout.write(JSON.stringify({ error: error.code })); }
} finally { store.close(); }
