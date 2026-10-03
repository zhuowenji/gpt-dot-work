import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readConfig } from './config.mjs';
import { TaskStore } from './store.mjs';

export class TaskWorker {
  constructor(store, { runtime = 'disabled', pollMs = 60000, leaseMs = 120000, concurrency = 2, workerId = randomUUID() } = {}) {
    if (!['disabled', 'demo'].includes(runtime)) throw new Error('Unsupported runtime');
    this.store = store;
    this.options = { runtime, pollMs, leaseMs, concurrency, workerId };
    this.stopped = true;
    this.active = null;
    this.timer = null;
  }
  async execute({ task, token }) {
    const { runtime, leaseMs } = this.options;
    let leaseValid = true;
    const heartbeat = setInterval(() => {
      try { leaseValid = this.store.heartbeat(task.id, token, leaseMs); }
      catch { leaseValid = false; }
    }, Math.max(100, Math.floor(leaseMs / 3)));
    heartbeat.unref();
    try {
      if (!leaseValid || !this.store.hasLease(task.id, token)) return;
      if (runtime === 'disabled') {
        this.store.finish(task.id, token, 'blocked', { error: { code: 'not_configured', message: 'No AI or execution runtime is configured. No task action was performed.' } });
        return;
      }
      if (!['demo.echo', 'demo.approval'].includes(task.kind)) {
        this.store.finish(task.id, token, 'blocked', { error: { code: 'unsupported_kind', message: 'Demo mode supports only demo.echo and demo.approval. No real action was performed.' } });
        return;
      }
      // This gate is chosen by the server-side allow-listed handler, never by a client flag.
      if (task.kind === 'demo.approval' && !this.store.ensureApproval(task.id, token)) return;
      if (!leaseValid || !this.store.hasLease(task.id, token)) return;
      // Deterministic in-process data only. Text is NEVER evaluated as code, shell, URLs or tools.
      const result = {
        mode: 'demo', simulated: true,
        summary: 'Demo only: saved instructions were echoed. No AI model or external service was called.',
        text: task.instructions,
      };
      this.store.finish(task.id, token, 'completed', { result });
    } catch {
      // No exception messages or request text in logs: adapters may include secrets in errors.
      this.store.finish(task.id, token, 'failed', { error: { code: 'worker_error', message: 'The worker could not complete this attempt.' } });
    } finally { clearInterval(heartbeat); }
  }
  runOnce() {
    // Repeated timer callbacks or callers never overlap within a worker process.
    if (this.active) return this.active;
    this.active = Promise.resolve().then(async () => {
      const claimed = [];
      for (let i = 0; i < this.options.concurrency; i += 1) {
        const next = this.store.claim(this.options.workerId, this.options.leaseMs);
        if (!next) break;
        claimed.push(next);
      }
      await Promise.all(claimed.map(claim => this.execute(claim)));
      return claimed.length;
    }).finally(() => { this.active = null; });
    return this.active;
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async () => {
      try { await this.runOnce(); }
      catch { process.stderr.write('Worker poll failed; it will try again at the next interval.\n'); }
      if (!this.stopped) this.timer = setTimeout(tick, this.options.pollMs);
    };
    void tick();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const config = readConfig(process.env, { requireApiToken: false });
  const store = new TaskStore(config.dbPath);
  const worker = new TaskWorker(store, config);
  worker.start();
  process.stdout.write(`Task worker started (${config.runtime}; polling every ${config.pollMs} ms).\n`);
  let stopping = false;
  const shutdown = async () => { if (stopping) return; stopping = true; await worker.stop(); store.close(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
