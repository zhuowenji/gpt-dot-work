import { randomUUID } from 'node:crypto';
import { ApiError } from './store.mjs';
import { CHAT_LIMITS } from './chat.mjs';
import { ManagedBridgeEvents } from './managed-bridge-events.mjs';
import { ManagedBridgeAuth, BRIDGE_PREFIX, BRIDGE_LIMITS, exactFields, sha256 } from './managed-bridge-auth.mjs';

const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const jsonHash = value => sha256(JSON.stringify(value));
const send = (res, data) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
function printable(value, max, label) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value.length > max || Buffer.byteLength(value) > max * 4 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(400, 'invalid_input', `${label} must contain 1–${max} printable characters`);
  return value.trim();
}

// Only chat-derived work enters this queue. Neither this API nor saved visitor
// text can create tasks in the historical owner task/approval/tool system.
export class ManagedBridgeApi {
  constructor(store, config, chat) {
    this.store = store; this.db = store.db; this.chat = chat;
    this.auth = new ManagedBridgeAuth(store, config.managedBridgeRegistration);
    this.events = new ManagedBridgeEvents(store, {
      enabled: config.managedBridgeEventsEnabled === true,
      allowedCallbackOrigins: config.managedBridgeCallbackOrigins || [],
      registrationActive: registration => this.auth.active() && registration.key_id === this.auth.registration.key_id
        && registration.site_id === this.auth.registration.site_id && registration.owner_subject === this.auth.registration.owner_subject,
    });
    this.running = false; this.timer = null; this.batch = null; this.lastDispatchError = null;
    this.auth.onRevoke = () => this.events?.haltRevoked();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_execution_tasks (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES chat_threads(id),
        source_message_id INTEGER NOT NULL UNIQUE REFERENCES chat_messages(id), principal TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','leased','completed','failed','cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        lease_id TEXT, lease_key_id TEXT, lease_until INTEGER, snapshot TEXT, reply_id INTEGER REFERENCES chat_messages(id),
        notified_generation INTEGER NOT NULL DEFAULT -1, notification_sequence INTEGER NOT NULL DEFAULT 0, ready_state INTEGER NOT NULL DEFAULT 0, notified_at INTEGER, redrive_count INTEGER NOT NULL DEFAULT 0, notified_key_id TEXT, stalled INTEGER NOT NULL DEFAULT 0, error_code TEXT, completed_key_id TEXT
      );
      CREATE INDEX IF NOT EXISTS chat_execution_queue ON chat_execution_tasks(state, created_at, id);
      CREATE UNIQUE INDEX IF NOT EXISTS chat_execution_one_principal ON chat_execution_tasks(principal) WHERE state = 'leased';
      CREATE TABLE IF NOT EXISTS chat_execution_operations (
        key_id TEXT NOT NULL, scope TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(key_id, scope, idempotency_key)
      );
    `);
    const columns = new Set(this.db.prepare('PRAGMA table_info(chat_execution_tasks)').all().map(row => row.name));
    for (const [name, type] of [['notified_generation', 'INTEGER NOT NULL DEFAULT -1'], ['notification_sequence', 'INTEGER NOT NULL DEFAULT 0'], ['ready_state', 'INTEGER NOT NULL DEFAULT 0'], ['notified_at', 'INTEGER'], ['redrive_count', 'INTEGER NOT NULL DEFAULT 0'], ['notified_key_id', 'TEXT'], ['stalled', 'INTEGER NOT NULL DEFAULT 0'], ['completed_key_id', 'TEXT'], ['error_code', 'TEXT']]) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE chat_execution_tasks ADD COLUMN ${name} ${type}`);
    }
    chat.execution = this;
  }
  atomic(fn) { return this.db.isTransaction ? fn() : this.store.transaction(fn); }
  reserveReplyCapacity(thread, addedBytes) {
    if (!this.auth.active()) return;
    const pending = this.db.prepare(`SELECT COUNT(*) AS n FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
      WHERE m.role = 'user' AND m.editable = 1 AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND t.principal = ?`).get(thread.principal).n;
    const waiting = this.db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id = ? AND role = 'user' AND editable = 1 AND deleted_at IS NULL").get(thread.id).n;
    const ownBytes = this.db.prepare('SELECT COALESCE(SUM(m.content_bytes), 0) AS n FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id WHERE t.principal = ?').get(thread.principal).n;
    const global = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(content_bytes), 0) AS bytes FROM chat_messages').get();
    const allPending = this.db.prepare("SELECT COUNT(*) AS n FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id WHERE m.role = 'user' AND m.editable = 1 AND m.deleted_at IS NULL AND t.deleted_at IS NULL").get().n;
    const threadCount = this.db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id = ?').get(thread.id).n;
    if (threadCount + waiting + 2 > CHAT_LIMITS.messagesPerThread || global.n + allPending + 2 > CHAT_LIMITS.totalMessages
      || ownBytes + addedBytes + (pending + 1) * CHAT_LIMITS.textBytes > CHAT_LIMITS.principalBytes
      || global.bytes + addedBytes + (allPending + 1) * CHAT_LIMITS.textBytes > CHAT_LIMITS.totalBytes) fail(429, 'reply_capacity_reserved', 'This conversation or intake is full; capacity for accepted answers must be preserved');
  }
  reserveEditCapacity(thread, addedBytes) {
    if (!this.auth.active() || addedBytes <= 0) return;
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id WHERE t.principal = ? AND t.deleted_at IS NULL AND m.role = 'user' AND m.editable = 1 AND m.deleted_at IS NULL").get(thread.principal).n;
    const own = this.db.prepare('SELECT COALESCE(SUM(m.content_bytes), 0) AS n FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id WHERE t.principal = ?').get(thread.principal).n;
    const total = this.db.prepare('SELECT COALESCE(SUM(content_bytes), 0) AS n FROM chat_messages').get().n;
    const allPending = this.db.prepare("SELECT COUNT(*) AS n FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id WHERE t.deleted_at IS NULL AND m.role = 'user' AND m.editable = 1 AND m.deleted_at IS NULL").get().n;
    if (own + addedBytes + pending * CHAT_LIMITS.textBytes > CHAT_LIMITS.principalBytes || total + addedBytes + allPending * CHAT_LIMITS.textBytes > CHAT_LIMITS.totalBytes) fail(429, 'reply_capacity_reserved', 'Capacity for accepted answers must be preserved');
  }
  messageChanged(messageId) {
    if (!this.auth.active()) return;
    this.db.prepare("UPDATE chat_execution_tasks SET state = 'pending', attempts = 0, error_code = NULL, stalled = 0, notified_generation = -1, ready_state = 0, updated_at = ? WHERE source_message_id = ? AND state = 'failed'").run(this.store.now(), messageId);
    this.notifyReady();
  }
  threadFailure(threadId) {
    return this.db.prepare("SELECT j.error_code FROM chat_execution_tasks j JOIN chat_messages m ON m.id = j.source_message_id WHERE j.thread_id = ? AND j.state = 'failed' AND j.error_code IS NOT NULL AND m.editable = 1 AND m.deleted_at IS NULL ORDER BY j.updated_at DESC LIMIT 1").get(threadId)?.error_code || null;
  }
  enqueueMessage(thread, messageId) {
    if (!this.auth.active()) return null;
    if (!this.db.isTransaction) throw new Error('Execution enqueue requires the chat transaction');
    const source = this.db.prepare("SELECT * FROM chat_messages WHERE id = ? AND thread_id = ? AND role = 'user' AND editable = 1 AND deleted_at IS NULL").get(messageId, thread.id);
    if (!source || thread.deleted_at !== null && thread.deleted_at !== undefined) return null;
    const existing = this.db.prepare('SELECT id FROM chat_execution_tasks WHERE source_message_id = ?').get(messageId);
    if (existing) return existing.id;
    const id = randomUUID(), at = this.store.now();
    this.db.prepare("INSERT INTO chat_execution_tasks(id, thread_id, source_message_id, principal, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)").run(id, thread.id, messageId, thread.principal, at, at);
    return id;
  }
  synchronize() {
    if (!this.db.isTransaction) throw new Error('Execution reconciliation requires a transaction');
    const at = this.store.now();
    this.db.prepare(`UPDATE chat_execution_tasks SET state = 'cancelled', lease_id = NULL, lease_key_id = NULL, lease_until = NULL, snapshot = NULL, updated_at = ?
      WHERE state IN ('pending','leased','failed') AND (NOT EXISTS (SELECT 1 FROM chat_threads t WHERE t.id = thread_id AND t.deleted_at IS NULL)
      OR NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.id = source_message_id AND m.deleted_at IS NULL AND m.editable = 1))`).run(at);
    this.db.prepare("UPDATE chat_execution_tasks SET state = 'failed', error_code = 'lease_retry_exhausted', lease_id = NULL, lease_key_id = NULL, lease_until = NULL, snapshot = NULL, updated_at = ? WHERE state = 'leased' AND lease_until <= ? AND attempts >= 5").run(at, at);
    // A principal migration, crash or explicit key replacement fences old work.
    // Retrying this queue only regenerates text; it must never replay tool effects.
    this.db.prepare(`UPDATE chat_execution_tasks SET state = 'pending', stalled = CASE WHEN lease_until <= ${at} THEN 1 ELSE 0 END, lease_id = NULL, lease_key_id = NULL, lease_until = NULL, snapshot = NULL, updated_at = ?
      WHERE state = 'leased' AND (lease_until <= ? OR lease_key_id <> ? OR principal <> (SELECT principal FROM chat_threads WHERE id = thread_id))`).run(at, at, this.auth.registration.key_id);
    this.db.prepare("UPDATE chat_execution_tasks SET principal = (SELECT principal FROM chat_threads WHERE id = thread_id) WHERE state = 'pending'").run();
    const unscheduled = this.db.prepare(`SELECT m.id AS message_id, t.* FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
      LEFT JOIN chat_execution_tasks j ON j.source_message_id = m.id
      WHERE j.id IS NULL AND m.role = 'user' AND m.editable = 1 AND m.deleted_at IS NULL AND t.deleted_at IS NULL ORDER BY m.id`).all();
    for (const row of unscheduled) this.enqueueMessage(row, row.message_id);
    // Legacy accepted backlog may predate answer reservations. Surface a terminal
    // capacity blocker instead of endlessly leasing an unanswerable full thread.
    this.db.prepare(`UPDATE chat_execution_tasks SET state = 'failed', error_code = 'reply_capacity', updated_at = ? WHERE state = 'pending'
      AND (SELECT COUNT(*) FROM chat_messages m WHERE m.thread_id = chat_execution_tasks.thread_id) >= ?`).run(at, CHAT_LIMITS.messagesPerThread);
    this.notifyReady();
  }
  notifyReady() {
    if (!this.events.enabled || !this.auth.active() || !this.events.status(this.auth.registration).subscription_active) return;
    if (!this.db.isTransaction) throw new Error('Ready notification requires the task transition transaction');
    const slots = BRIDGE_LIMITS.concurrency - this.db.prepare("SELECT COUNT(*) AS n FROM chat_execution_tasks WHERE state = 'leased'").get().n;
    const eligible = this.candidates(10000).map(row => this.db.prepare('SELECT * FROM chat_execution_tasks WHERE id = ?').get(row.id));
    const exhausted = job => job.redrive_count >= 8 && job.ready_state === 1 && job.notified_generation === job.attempts && job.notified_key_id === this.auth.registration.key_id;
    const ready = eligible.filter(job => !exhausted(job)).slice(0, Math.max(0, slots)).map(row => row.id);
    // Exhausted jobs stay manually claimable but cannot starve other principals'
    // automatic wakes. Preserve exhaustion until a real eligibility transition.
    const retained = [...ready, ...eligible.filter(exhausted).map(row => row.id)];
    this.db.prepare(`UPDATE chat_execution_tasks SET ready_state = 0 WHERE state = 'pending' ${retained.length ? `AND id NOT IN (${retained.map(() => '?').join(',')})` : ''}`).run(...retained);
    for (const id of ready) {
      const job = this.db.prepare('SELECT * FROM chat_execution_tasks WHERE id = ?').get(id);
      const same = job.notified_generation === job.attempts && job.notified_key_id === this.auth.registration.key_id && job.ready_state === 1;
      // An acknowledged event can lose its consumer before claim. Redrive the
      // still-ready job with a new stable event, bounded to eight five-minute
      // redrives per uninterrupted ready period; never recreate completed work.
      if (same && (job.redrive_count >= 8 || job.notified_at > this.store.now() - 300000)) continue;
      this.events.enqueueTaskReady(this.auth.registration, { task_id: id, queue: 'website-chat', created_at: this.store.now(), generation: job.notification_sequence + 1 });
      this.db.prepare('UPDATE chat_execution_tasks SET notified_generation = ?, notification_sequence = notification_sequence + 1, notified_key_id = ?, ready_state = 1, notified_at = ?, redrive_count = ? WHERE id = ?')
        .run(job.attempts, this.auth.registration.key_id, this.store.now(), same ? job.redrive_count + 1 : 0, id);
    }
  }

  start() {
    if (this.running || !this.events.enabled) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.batch = (async () => {
        if (this.auth.active()) {
          this.atomic(() => this.synchronize());
          await Promise.all(Array.from({ length: BRIDGE_LIMITS.concurrency }, () => this.events.dispatchOne()));
        } else { this.events.haltRevoked(); this.events.cleanup(); }
        this.lastDispatchError = null;
      })().catch(() => { this.lastDispatchError = 'dispatcher_unavailable'; }).finally(() => {
        this.batch = null;
        if (this.running) { this.timer = setTimeout(tick, 1000); this.timer.unref(); }
      });
    };
    tick();
  }
  async stop() {
    this.running = false; clearTimeout(this.timer); this.events.close();
    await this.batch;
  }
  connectionState() {
    const eventStatus = this.events.status(this.auth.registration);
    const lastReply = this.db.prepare("SELECT MAX(updated_at) AS at FROM chat_execution_tasks WHERE state = 'completed' AND completed_key_id = ?").get(this.auth.registration?.key_id || '').at || null;
    const proof = this.db.prepare(`SELECT MAX(j.updated_at) AS at FROM chat_execution_tasks j
      JOIN managed_bridge_event_outbox e ON e.task_id = j.id AND e.key_id = j.completed_key_id
      JOIN managed_bridge_event_deliveries d ON d.event_id = e.event_id
      WHERE j.state = 'completed' AND j.completed_key_id = ? AND d.status = 'delivered'`).get(this.auth.registration?.key_id || '').at || null;
    const stalled = this.db.prepare("SELECT COUNT(*) AS n FROM chat_execution_tasks WHERE state = 'leased' AND lease_until <= ? OR state = 'pending' AND stalled = 1").get(this.store.now()).n;
    const exhausted = this.db.prepare("SELECT COUNT(*) AS n FROM chat_execution_tasks WHERE state = 'pending' AND ready_state = 1 AND redrive_count >= 8 AND notified_at <= ?").get(this.store.now() - 300000).n;
    const connected = Boolean(this.auth.active() && eventStatus.subscription_active && proof && proof > this.store.now() - 900000 && !stalled && !exhausted && !this.lastDispatchError);
    return { ...eventStatus, last_reply_at: lastReply, last_verified_round_trip_at: proof, execution_connected: connected,
      verification: connected ? 'recent_signed_round_trip' : proof ? 'historical_round_trip_not_current' : 'real_end_to_end_not_verified',
      worker_capacity_verified: false, failed_tasks: this.db.prepare("SELECT COUNT(*) AS n FROM chat_execution_tasks WHERE state = 'failed'").get().n, stalled_tasks: stalled, wake_exhausted_tasks: exhausted, dispatcher_error: this.lastDispatchError };
  }
  isMessageLeased(id) {
    return this.auth.active() && Boolean(this.db.prepare("SELECT 1 FROM chat_execution_tasks WHERE source_message_id = ? AND state = 'leased' AND lease_until > ? AND lease_key_id = ?").get(id, this.store.now(), this.auth.registration.key_id));
  }
  threadLeased(id) {
    return this.auth.active() && Boolean(this.db.prepare("SELECT 1 FROM chat_execution_tasks WHERE thread_id = ? AND state = 'leased' AND lease_until > ? AND lease_key_id = ?").get(id, this.store.now(), this.auth.registration.key_id));
  }
  idempotent(scope, body, fn) {
    const key = body.idempotency_key;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) fail(400, 'idempotency_key_required', 'idempotency_key must contain 8–128 safe ASCII characters');
    const fingerprint = jsonHash(body), keyId = this.auth.registration.key_id;
    return this.atomic(() => {
      this.auth.requireActive();
      const old = this.db.prepare('SELECT * FROM chat_execution_operations WHERE key_id = ? AND scope = ? AND idempotency_key = ?').get(keyId, scope, key);
      if (old) {
        if (old.fingerprint !== fingerprint) fail(409, 'idempotency_conflict', 'This operation key was used with different input');
        return JSON.parse(old.response);
      }
      if (this.db.prepare('SELECT COUNT(*) AS n FROM chat_execution_operations').get().n >= BRIDGE_LIMITS.operations) fail(429, 'bridge_capacity', 'Execution operation storage limit reached');
      const result = fn();
      this.db.prepare('INSERT INTO chat_execution_operations(key_id, scope, idempotency_key, fingerprint, response, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(keyId, scope, key, fingerprint, JSON.stringify(result), this.store.now());
      return result;
    });
  }
  candidates(limit = 100) {
    // Return at most one eligible task per persisted principal. Older threads
    // retain their requested queue order; no client-supplied user ID is accepted.
    return this.db.prepare(`WITH ranked AS (
      SELECT j.id, j.principal, j.created_at, m.id AS message_id,
        ROW_NUMBER() OVER (PARTITION BY j.principal ORDER BY t.created_at, (SELECT MIN(first.id) FROM chat_messages first WHERE first.thread_id = t.id), m.queue_position, m.id) AS position
      FROM chat_execution_tasks j JOIN chat_threads t ON t.id = j.thread_id JOIN chat_messages m ON m.id = j.source_message_id
      WHERE j.state = 'pending' AND NOT EXISTS (SELECT 1 FROM chat_execution_tasks busy WHERE busy.principal = j.principal AND busy.state = 'leased')
    ) SELECT id FROM ranked WHERE position = 1 ORDER BY created_at, message_id, id LIMIT ?`).all(limit);
  }
  status(body) {
    exactFields(body, []);
    return this.atomic(() => {
      this.synchronize();
      return { enabled: true, key_active: this.auth.active(), key_expires_at: this.auth.registration.expires_at, queue: 'website-chat',
        ...this.connectionState(), max_concurrency: BRIDGE_LIMITS.concurrency,
        active_leases: this.db.prepare("SELECT COUNT(*) AS n FROM chat_execution_tasks WHERE state = 'leased'").get().n };
    });
  }
  list(body) {
    exactFields(body, ['limit']);
    const limit = body.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'invalid_input', 'limit must be between 1 and 100');
    return this.atomic(() => {
      this.synchronize(); const rows = this.candidates(limit + 1);
      return { tasks: rows.slice(0, limit).map(row => ({ task_id: row.id })), has_more: rows.length > limit };
    });
  }
  authority(thread) {
    const owner = thread.principal === 'owner' && thread.kind === 'owner_instruction';
    return { source: owner ? 'authenticated_owner' : 'website_visitor', instruction_authority: owner ? 'owner_request' : 'untrusted_content',
      allowed_capabilities: ['task_context', 'task_reply', 'task_memory'], external_actions_authorized: false };
  }
  sourceSnapshots(principal, ids) {
    const result = [];
    for (let i = 0; i < ids.length; i += 40) result.push(...this.chat.context.sources(principal, ids.slice(i, i + 40)));
    return result;
  }
  capture(job, thread) {
    const source = this.db.prepare('SELECT id, role, content, created_at, updated_at FROM chat_messages WHERE id = ? AND thread_id = ? AND deleted_at IS NULL').get(job.source_message_id, thread.id);
    const messageIds = this.db.prepare("SELECT id FROM chat_messages WHERE thread_id = ? AND deleted_at IS NULL AND (role = 'agent' OR editable = 0 OR id = ?) ORDER BY id").all(thread.id, source.id).map(row => row.id);
    const context = this.chat.context.getContext(thread.id, { messageIds });
    // Keep the signed proxy response under its transport budget even when every
    // memory entry carries the maximum provenance or uses multibyte Unicode.
    while (Buffer.byteLength(JSON.stringify({ message: source, context })) > 230000) {
      context.truncated_for_transport = true;
      if (context.related_threads.length) context.related_threads.pop();
      else if (context.summaries.length) context.summaries.pop();
      else if (context.memory.length) { context.memory.pop(); context.tasks = context.memory.filter(entry => entry.type === 'task'); }
      else if (context.messages.length) context.messages.shift();
      else fail(413, 'context_too_large', 'Task context exceeds the transport limit');
    }
    const ids = [...new Set([source.id, ...context.messages.map(message => message.id), ...context.memory.flatMap(entry => entry.source_message_ids), ...context.summaries.flatMap(summary => summary.source_message_ids)])].sort((a, b) => a - b);
    const snapshot = { thread_id: thread.id, principal: thread.principal, kind: thread.kind, message: { ...source, authority: 'untrusted_content' }, context,
      memory_revision: this.db.prepare('SELECT revision FROM chat_context_state WHERE principal = ?').get(thread.principal)?.revision || 0,
      sources: this.sourceSnapshots(thread.principal, ids), authority: this.authority(thread) };
    snapshot.context_version = jsonHash(snapshot);
    snapshot.context.context_version = snapshot.context_version;
    return snapshot;
  }
  claim(body) {
    exactFields(body, ['task_id', 'idempotency_key', 'lease_seconds']);
    if (!uuid(body.task_id)) fail(400, 'invalid_input', 'task_id must be a returned task UUID');
    const seconds = body.lease_seconds ?? BRIDGE_LIMITS.leaseSeconds;
    if (!Number.isInteger(seconds) || seconds < 30 || seconds > BRIDGE_LIMITS.leaseSeconds) fail(400, 'invalid_input', 'lease_seconds must be between 30 and 300');
    return this.idempotent('claim', body, () => {
      this.synchronize();
      const job = this.db.prepare('SELECT * FROM chat_execution_tasks WHERE id = ?').get(body.task_id);
      if (!job) fail(404, 'not_found', 'Task not found');
      if (job.state !== 'pending') fail(409, 'task_not_pending', 'Task is not pending');
      if (this.db.prepare("SELECT COUNT(*) AS n FROM chat_execution_tasks WHERE state = 'leased'").get().n >= BRIDGE_LIMITS.concurrency) fail(409, 'execution_slots_full', 'All execution slots are occupied');
      if (!this.candidates(10000).some(row => row.id === job.id)) fail(409, 'principal_busy', 'An earlier task or active lease for this user must finish first');
      const thread = this.chat.thread(job.thread_id, job.principal), snapshot = this.capture(job, thread);
      const leaseId = randomUUID(), until = Math.min(this.store.now() + seconds * 1000, this.auth.registration.expires_at);
      this.db.prepare("UPDATE chat_execution_tasks SET state = 'leased', stalled = 0, attempts = attempts + 1, lease_id = ?, lease_key_id = ?, lease_until = ?, snapshot = ?, updated_at = ? WHERE id = ?").run(leaseId, this.auth.registration.key_id, until, JSON.stringify(snapshot), this.store.now(), job.id);
      return { task_id: job.id, lease_id: leaseId, lease_expires_at: until, kind: thread.kind, authority: snapshot.authority };
    });
  }
  leased(body, validateContext = true) {
    if (!uuid(body.task_id) || !uuid(body.lease_id)) fail(400, 'invalid_input', 'task_id and lease_id must be returned UUIDs');
    const job = this.db.prepare('SELECT * FROM chat_execution_tasks WHERE id = ?').get(body.task_id);
    if (!job) fail(404, 'not_found', 'Task not found');
    if (job.state !== 'leased' || job.lease_id !== body.lease_id || job.lease_key_id !== this.auth.registration.key_id || job.lease_until <= this.store.now()) fail(409, 'lease_expired', 'This lease is no longer current');
    const thread = this.chat.thread(job.thread_id, job.principal);
    const source = this.db.prepare('SELECT editable, deleted_at FROM chat_messages WHERE id = ?').get(job.source_message_id);
    if (!source || source.deleted_at !== null || !source.editable) fail(409, 'task_changed', 'This task has already been answered or withdrawn');
    const snapshot = JSON.parse(job.snapshot);
    if (validateContext) {
      const revision = this.db.prepare('SELECT revision FROM chat_context_state WHERE principal = ?').get(job.principal)?.revision || 0;
      if (thread.kind !== snapshot.kind || revision !== snapshot.memory_revision || jsonHash(this.sourceSnapshots(job.principal, snapshot.sources.map(source => source.id))) !== jsonHash(snapshot.sources)) fail(409, 'context_changed', 'Claimed context changed; release and claim again before replying');
    }
    return { job, thread, snapshot };
  }
  context(body) {
    exactFields(body, ['task_id', 'lease_id']);
    return this.atomic(() => {
      const { job, snapshot } = this.leased(body);
      return { task_id: job.id, lease_id: job.lease_id, message: snapshot.message, context_version: snapshot.context_version, context: snapshot.context, authority: snapshot.authority };
    });
  }
  reply(body) {
    exactFields(body, ['task_id', 'lease_id', 'idempotency_key', 'text', 'expected_context_version', 'context']);
    const text = printable(body.text, 8000, 'text');
    exactFields(body.context, ['summary', 'category', 'memory_patch']);
    if (!body.context.summary || !Array.isArray(body.context.memory_patch)) fail(400, 'invalid_input', 'Reply requires summary and memory_patch (which may be empty)');
    return this.idempotent('reply', body, () => {
      const { job, thread, snapshot } = this.leased(body);
      if (body.expected_context_version !== snapshot.context_version) fail(409, 'context_changed', 'Reply must reference its exact leased context version');
      const allowed = new Set(snapshot.sources.map(source => source.id));
      for (const item of [body.context.summary, ...body.context.memory_patch]) {
        if (!Array.isArray(item?.source_message_ids) || !item.source_message_ids.length || item.source_message_ids.some(id => !allowed.has(id))) fail(400, 'invalid_source', 'Memory and summary sources must come from the returned leased context');
      }
      // Reply, source acknowledgement, memory versions and completion share one
      // SQLite transaction. A context validation failure rolls back every write.
      const messageId = this.chat.insertMessage(thread, text, 'agent', `connector:${this.auth.registration.key_id}`);
      this.db.prepare('UPDATE chat_messages SET editable = 0 WHERE id = ?').run(job.source_message_id);
      const writeback = this.chat.context.writeback(thread.id, body.context, { actor: `connector:${this.auth.registration.key_id}` });
      this.db.prepare("UPDATE chat_execution_tasks SET state = 'completed', completed_key_id = ?, reply_id = ?, lease_id = NULL, lease_key_id = NULL, lease_until = NULL, snapshot = NULL, updated_at = ? WHERE id = ?").run(this.auth.registration.key_id, messageId, this.store.now(), job.id);
      this.notifyReady();
      return { task_id: job.id, reply_id: messageId, completed: true, context_version: writeback.context_version };
    });
  }
  release(body) {
    exactFields(body, ['task_id', 'lease_id', 'idempotency_key', 'reason']);
    if (!['retry', 'failed'].includes(body.reason)) fail(400, 'invalid_input', 'reason must be retry or failed');
    return this.idempotent('release', body, () => {
      const { job } = this.leased(body, false), state = body.reason === 'retry' ? 'pending' : 'failed';
      this.db.prepare('UPDATE chat_execution_tasks SET state = ?, error_code = ?, lease_id = NULL, lease_key_id = NULL, lease_until = NULL, snapshot = NULL, updated_at = ? WHERE id = ?').run(state, state === 'failed' ? 'worker_failed' : null, this.store.now(), job.id);
      this.notifyReady();
      return { task_id: job.id, status: state };
    });
  }
  async handle(req, res, url) {
    if (!url.pathname.startsWith(BRIDGE_PREFIX)) return false;
    const { operation, registration } = await this.auth.authenticate(req, url);
    const name = url.pathname.slice(BRIDGE_PREFIX.length);
    const methods = { status: 'status', 'tasks/list': 'list', 'tasks/claim': 'claim', 'tasks/context': 'context', 'tasks/reply': 'reply', 'tasks/release': 'release' };
    let result;
    if (methods[name]) result = this[methods[name]](operation);
    else if (name === 'subscriptions/upsert' && this.events) {
      const activeBefore = new Set(this.db.prepare("SELECT id FROM managed_bridge_subscriptions WHERE key_id = ? AND status = 'active' AND expires_at > ?").all(registration.key_id, this.store.now()).map(row => row.id));
      result = await this.events.upsert(registration, operation);
      this.atomic(() => {
        // New or reactivated subscriptions need a current-ready wake, not replay
        // of expired/cancelled historical deliveries. Refreshes do not duplicate.
        if (!activeBefore.has(result.id)) this.db.prepare("UPDATE chat_execution_tasks SET notified_generation = -1, ready_state = 0 WHERE state = 'pending'").run();
        this.synchronize();
      });
    }
    else if (name === 'subscriptions/delete' && this.events) result = await this.events.delete(registration, operation);
    else fail(501, 'subscription_unavailable', 'Event delivery is not configured');
    send(res, result); return true;
  }
}
