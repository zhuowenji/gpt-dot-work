import { readConfig } from './config.mjs';
import { TaskStore } from './store.mjs';
import { createApiServer, listen } from './server.mjs';
import { TaskWorker } from './worker.mjs';

process.umask(0o077);
const config = readConfig();
const store = new TaskStore(config.dbPath);
const server = createApiServer(store, config);
const worker = new TaskWorker(store, config);
const address = await listen(server, config);
worker.start();
process.stdout.write(`Task service listening on ${config.host}:${address.port}; runtime=${config.runtime}; poll=${config.pollMs} ms.\n`);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await Promise.all([worker.stop(), new Promise(resolve => server.close(resolve))]);
  store.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
