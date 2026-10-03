import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export const TASK_STATES = ['draft', 'pending', 'running', 'blocked', 'needs_approval', 'completed', 'failed', 'cancelled'];
const editableFields = ['title', 'instructions', 'kind'];
const json = value => JSON.stringify(value);
const hash = value => createHash('sha256').update(json(value)).digest('hex');

export function validateTaskInput(input, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'invalid_input', 'Expected a JSON object');
  if (Object.keys(input).some(key => !editableFields.includes(key))) throw new ApiError(400, 'invalid_input', 'Only title, instructions and kind are accepted');
  const output = {};
  for (const [key, max] of [['title', 160], ['instructions', 8000], ['kind', 80]]) {
    if (partial && !Object.hasOwn(input, key)) continue;
    const value = input[key] ?? (key === 'kind' ? 'task' : undefined);
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ApiError(400, 'invalid_input', `${key} must contain 1–${max} characters`);
    output[key] = value.trim();
  }
  if (partial && Object.keys(output).length === 0) throw new ApiError(400, 'invalid_input', 'At least one editable field is required');
  return output;
}

export class TaskStore {
  constructor(path, { now = () => Date.now() } = {}) {
    this.now = now;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('draft','pending','running','blocked','needs_approval','completed','failed','cancelled')),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, submitted_at INTEGER,
        lease_token TEXT, lease_until INTEGER, body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS claimable_tasks ON tasks(status, submitted_at, created_at);
      CREATE TABLE IF NOT EXISTS task_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), at INTEGER NOT NULL, type TEXT NOT NULL, details TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_by_task ON task_events(task_id, seq);
      CREATE TABLE IF NOT EXISTS idempotency (
        scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      );`);
  }

  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id) {
    const row = this.db.prepare('SELECT body FROM tasks WHERE id = ?').get(id);
    if (!row) throw new ApiError(404, 'not_found', 'Task not found');
    return JSON.parse(row.body);
  }
  list({ limit = 100, cursor = null } = {}) {
    const at = cursor?.createdAt ?? Number.MAX_SAFE_INTEGER;
    const id = cursor?.id ?? 'zzzz';
    return this.db.prepare('SELECT body FROM tasks WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT ?').all(at, at, id, limit).map(row => JSON.parse(row.body));
  }
  events(id, after = 0) {
    this.get(id);
    return this.db.prepare('SELECT seq, at, type, details FROM task_events WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT 500').all(id, after).map(row => ({ ...row, details: JSON.parse(row.details) }));
  }
  event(task, type, details = {}) {
    this.db.prepare('INSERT INTO task_events(task_id, at, type, details) VALUES (?, ?, ?, ?)').run(task.id, this.now(), type, json(details));
  }
  save(task, leaseToken = null, leaseUntil = null) {
    task.updatedAt = this.now();
    this.db.prepare('UPDATE tasks SET status = ?, updated_at = ?, submitted_at = ?, lease_token = ?, lease_until = ?, body = ? WHERE id = ?').run(task.status, task.updatedAt, task.submittedAt, leaseToken, leaseUntil, json(task), task.id);
    return task;
  }
  idempotent(scope, key, payload, fn) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new ApiError(400, 'idempotency_key_required', 'Idempotency-Key must contain 8–128 letters, numbers, periods, underscores, colons or hyphens');
    const fingerprint = hash(payload);
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT fingerprint, response FROM idempotency WHERE scope = ? AND key = ?').get(scope, key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new ApiError(409, 'idempotency_conflict', 'That key was already used with a different request');
        return JSON.parse(previous.response);
      }
      const result = fn();
      this.db.prepare('INSERT INTO idempotency(scope, key, fingerprint, response) VALUES (?, ?, ?, ?)').run(scope, key, fingerprint, json(result));
      return result;
    });
  }
  create(input, key) {
    const clean = validateTaskInput(input);
    return this.idempotent('create', key, clean, () => {
      const at = this.now();
      const task = { id: randomUUID(), ...clean, status: 'draft', revision: 1, attempts: 0, createdAt: at, updatedAt: at, submittedAt: null, result: null, error: null, approval: null };
      this.db.prepare('INSERT INTO tasks(id, status, created_at, updated_at, body) VALUES (?, ?, ?, ?, ?)').run(task.id, task.status, at, at, json(task));
      this.event(task, 'draft_saved');
      return task;
    });
  }
  edit(id, input, key) {
    const clean = validateTaskInput(input, true);
    return this.idempotent(`edit:${id}`, key, clean, () => {
      const task = this.get(id);
      if (task.status !== 'draft') throw new ApiError(409, 'invalid_state', 'Only drafts can be edited; create a new draft for different instructions');
      Object.assign(task, clean, { revision: task.revision + 1 });
      this.event(task, 'draft_saved', { revision: task.revision });
      return this.save(task);
    });
  }
  submit(id, key, expectedRevision) {
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw new ApiError(400, 'invalid_input', 'revision must be a positive safe integer');
    return this.idempotent(`submit:${id}`, key, expectedRevision === undefined ? {} : { revision: expectedRevision }, () => {
      const task = this.get(id);
      if (task.status !== 'draft') throw new ApiError(409, 'invalid_state', 'Only a draft can be submitted');
      if (expectedRevision !== undefined && task.revision !== expectedRevision) throw new ApiError(409, 'revision_conflict', 'This draft changed after review. Reload and review the current revision before submitting.');
      task.status = 'pending'; task.submittedAt = this.now();
      this.event(task, 'submitted');
      return this.save(task);
    });
  }
  cancel(id, key) {
    return this.idempotent(`cancel:${id}`, key, {}, () => {
      const task = this.get(id);
      if (task.status === 'cancelled') return task;
      if (['completed', 'failed'].includes(task.status)) throw new ApiError(409, 'invalid_state', 'A finished task cannot be cancelled');
      task.status = 'cancelled'; task.error = null;
      if (task.approval?.status === 'pending') task.approval.status = 'cancelled';
      this.event(task, 'cancelled');
      return this.save(task);
    });
  }
  retry(id, key) {
    return this.idempotent(`retry:${id}`, key, {}, () => {
      const task = this.get(id);
      if (!['blocked', 'failed', 'cancelled'].includes(task.status) || task.submittedAt === null) throw new ApiError(409, 'invalid_state', 'Only a submitted blocked, failed or cancelled task can be retried');
      task.status = 'pending'; task.error = null; task.result = null;
      // A retry is a new attempt: previous approval can never silently carry over.
      task.approval = null;
      this.event(task, 'retry_requested');
      return this.save(task);
    });
  }
  claim(workerId, leaseMs) {
    return this.transaction(() => {
      // No automatic rerun after a lost worker: the prior attempt's effects may be unknown.
      const expired = this.db.prepare("SELECT body FROM tasks WHERE status = 'running' AND lease_until <= ?").all(this.now());
      for (const row of expired) {
        const task = JSON.parse(row.body);
        task.status = 'blocked'; task.error = { code: 'worker_lost', message: 'Worker lease expired. Inspect the prior attempt before requesting a retry.' };
        this.save(task); this.event(task, 'blocked', task.error);
      }
      const row = this.db.prepare("SELECT body FROM tasks WHERE status = 'pending' AND submitted_at IS NOT NULL ORDER BY submitted_at, created_at, id LIMIT 1").get();
      if (!row) return null;
      const task = JSON.parse(row.body);
      const token = randomUUID();
      task.status = 'running'; task.attempts += 1; task.error = null;
      this.save(task, token, this.now() + leaseMs);
      this.event(task, 'claimed', { workerId, attempt: task.attempts });
      return { task, token };
    });
  }
  hasLease(id, token) {
    return Boolean(this.db.prepare("SELECT id FROM tasks WHERE id = ? AND status = 'running' AND lease_token = ? AND lease_until > ?").get(id, token, this.now()));
  }
  heartbeat(id, token, leaseMs) {
    return this.db.prepare("UPDATE tasks SET lease_until = ? WHERE id = ? AND status = 'running' AND lease_token = ? AND lease_until > ?").run(this.now() + leaseMs, id, token, this.now()).changes === 1;
  }
  finish(id, token, status, { result = null, error = null } = {}) {
    if (!['completed', 'failed', 'blocked'].includes(status)) throw new Error('Invalid completion status');
    return this.transaction(() => {
      if (!this.hasLease(id, token)) return false;
      const task = this.get(id);
      task.status = status; task.result = result; task.error = error;
      this.save(task); this.event(task, status, { attempt: task.attempts, ...(error ? { code: error.code } : {}) });
      return true;
    });
  }
  approvalFor(task) {
    return { action: 'Simulate an approval-gated demo. No external message, payment or other action will occur.', fingerprint: hash({ id: task.id, revision: task.revision, title: task.title, instructions: task.instructions, kind: task.kind }) };
  }
  ensureApproval(id, token) {
    return this.transaction(() => {
      if (!this.hasLease(id, token)) return false;
      const task = this.get(id);
      const action = this.approvalFor(task);
      if (task.approval?.status === 'approved' && task.approval.fingerprint === action.fingerprint) return true;
      task.status = 'needs_approval';
      task.approval = { requestId: randomUUID(), ...action, status: 'pending', requestedAt: this.now(), decidedAt: null };
      this.save(task); this.event(task, 'approval_requested', { requestId: task.approval.requestId });
      return false;
    });
  }
  decideApproval(id, { requestId, decision }, key) {
    if (typeof requestId !== 'string' || !['approve', 'reject'].includes(decision)) throw new ApiError(400, 'invalid_input', 'requestId and decision (approve or reject) are required');
    return this.idempotent(`approval:${id}`, key, { requestId, decision }, () => {
      const task = this.get(id);
      if (task.status !== 'needs_approval' || task.approval?.status !== 'pending' || task.approval.requestId !== requestId || task.approval.fingerprint !== this.approvalFor(task).fingerprint) throw new ApiError(409, 'stale_approval', 'Approval does not match the current pending request');
      task.approval.status = decision === 'approve' ? 'approved' : 'rejected';
      task.approval.decidedAt = this.now();
      task.status = decision === 'approve' ? 'pending' : 'cancelled';
      this.save(task); this.event(task, `approval_${task.approval.status}`, { requestId });
      return task;
    });
  }
}
