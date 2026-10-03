import { randomUUID, createHash } from 'node:crypto';
import { ApiError } from './store.mjs';

// Project-owned conversation memory. There is no model, external embedding,
// credential storage, automatic fact extraction or authority in saved text.
export const CONTEXT_LIMITS = Object.freeze({
  messages: 24, messageCharacters: 3000, messageBudget: 18000, summaries: 8,
  memory: 24, relatedThreads: 8, candidates: 300, queryCharacters: 240,
  memoryPerPrincipal: 300, memoryTotal: 30000, versions: 100,
  summaryCharacters: 4000, valueCharacters: 1200, sourceIds: 40, patchEntries: 12,
});
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message, status = 400) => { throw new ApiError(status, code, message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('invalid_context', `Only ${allowed.join(', ')} accepted`);
}
function text(value, maximum, label, empty = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || (!empty && !value.trim()) || value.length > maximum || Buffer.byteLength(value) > maximum * 4 || controls.test(value)) fail('invalid_context', `${label} must be printable text of at most ${maximum} characters`);
  return value.trim();
}
function certainty(value) {
  if (!['confirmed', 'inferred'].includes(value)) fail('invalid_context', 'certainty must explicitly be confirmed or inferred');
  return value;
}
function safeMemory(value) {
  // Defense in depth, not a complete DLP classifier. No automatic extraction is
  // performed; reviewers must keep sensitive personal data out of durable facts.
  if (/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_-]{18,}|\bBearer\s+[A-Za-z0-9._~-]{12,}|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.|\b\d{3}-\d{2}-\d{4}\b|(?:password|passwd|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|secret|密码|口令|令牌)\s*[:=：]\s*\S+)/i.test(value)) fail('sensitive_memory', 'Do not put passwords, tokens, identity numbers or credentials in memory');
}
function terms(value) {
  return [...new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).flatMap(word => /[\p{Script=Han}]/u.test(word) ? [...word].slice(0, 30).map((char, i, chars) => char + (chars[i + 1] || '')) : [word]))].slice(0, 30);
}
function score(value, words) { const source = value.toLocaleLowerCase(); return words.reduce((n, word) => n + (source.includes(word) ? 1 : 0), 0); }

export class ChatContextStore {
  constructor(store) {
    this.store = store; this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_context_state (principal TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS chat_memory_entries (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, memory_key TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('fact','preference','task')), current_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_memory_by_principal ON chat_memory_entries(principal, updated_at, id);
      CREATE TABLE IF NOT EXISTS chat_memory_versions (
        entry_id TEXT NOT NULL REFERENCES chat_memory_entries(id), version INTEGER NOT NULL,
        value TEXT NOT NULL, certainty TEXT NOT NULL CHECK(certainty IN ('confirmed','inferred')),
        status TEXT NOT NULL CHECK(status IN ('active','superseded','invalidated','completed')),
        source_thread_id TEXT NOT NULL REFERENCES chat_threads(id), source_message_ids TEXT NOT NULL,
        source_snapshots TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
        PRIMARY KEY(entry_id, version)
      );
      CREATE TABLE IF NOT EXISTS chat_summary_versions (
        thread_id TEXT NOT NULL REFERENCES chat_threads(id), version INTEGER NOT NULL, principal TEXT NOT NULL,
        summary TEXT NOT NULL, category TEXT NOT NULL, certainty TEXT NOT NULL CHECK(certainty IN ('confirmed','inferred')),
        status TEXT NOT NULL CHECK(status IN ('active','superseded','invalidated')),
        source_message_ids TEXT NOT NULL, source_snapshots TEXT NOT NULL, actor TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(thread_id, version)
      );
      CREATE INDEX IF NOT EXISTS chat_summaries_by_principal ON chat_summary_versions(principal, status, created_at);
      CREATE TABLE IF NOT EXISTS chat_context_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, principal TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES chat_threads(id),
        actor TEXT NOT NULL, event TEXT NOT NULL, entry_id TEXT, version INTEGER, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_context_audit_by_principal ON chat_context_audit(principal, seq);
    `);
  }

  // This class is an internal service, not an authentication boundary. HTTP
  // callers authorize the thread first; connector callers resolve it from a
  // leased persisted task. Neither accepts a user ID/principal from task text.
  thread(threadId) {
    const row = this.db.prepare('SELECT * FROM chat_threads WHERE id = ? AND deleted_at IS NULL').get(threadId);
    if (!row) fail('not_found', 'Conversation not found', 404);
    return row;
  }
  touch(principal) {
    this.db.prepare('INSERT INTO chat_context_state(principal, revision) VALUES (?, 1) ON CONFLICT(principal) DO UPDATE SET revision = revision + 1').run(principal);
  }
  audit(row, actor, event, entryId = null, version = null) {
    this.db.prepare('INSERT INTO chat_context_audit(principal, thread_id, actor, event, entry_id, version, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.principal, row.id, actor, event, entryId, version, this.store.now());
  }
  version(threadId) {
    const row = this.thread(threadId);
    const revision = this.db.prepare('SELECT revision FROM chat_context_state WHERE principal = ?').get(row.principal)?.revision || 0;
    const threads = this.db.prepare('SELECT id, revision, deleted_at FROM chat_threads WHERE principal = ? ORDER BY id').all(row.principal);
    return hash({ principal: row.principal, revision, threads });
  }
  assertVersion(threadId, expected) {
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) fail('invalid_context', 'expected_context_version must be a context version');
    if (this.version(threadId) !== expected) fail('context_changed', 'Conversation context changed. Reload and review it before writing back.', 409);
  }
  sources(principal, ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > CONTEXT_LIMITS.sourceIds || ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) fail('invalid_context', `Provide 1–${CONTEXT_LIMITS.sourceIds} distinct source_message_ids`);
    return ids.map(id => {
      const source = this.db.prepare('SELECT m.id, m.thread_id, m.content, m.updated_at, m.created_at FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id WHERE m.id = ? AND t.principal = ? AND t.deleted_at IS NULL AND m.deleted_at IS NULL').get(id, principal);
      if (!source) fail('invalid_source', 'Every source must be a live message belonging to this conversation user');
      return { id: source.id, thread_id: source.thread_id, created_at: source.created_at, updated_at: source.updated_at, content_hash: hash(source.content) };
    });
  }
  liveSources(principal, snapshots) {
    try {
      const old = JSON.parse(snapshots), current = this.sources(principal, old.map(source => source.id));
      return hash(old) === hash(current);
    } catch { return false; }
  }
  memoryDto(row) {
    return { id: row.id, version: row.current_version, type: row.type, key: row.memory_key, value: row.value, certainty: row.certainty, status: row.status,
      source_thread_id: row.source_thread_id, source_message_ids: JSON.parse(row.source_message_ids), source_messages: JSON.parse(row.source_snapshots).map(({ content_hash, ...source }) => source),
      actor: row.actor, reason: row.reason, created_at: row.created_at, updated_at: row.updated_at };
  }
  memoryRows(principal) {
    return this.db.prepare('SELECT e.*, v.value, v.certainty, v.status, v.source_thread_id, v.source_message_ids, v.source_snapshots, v.actor, v.reason FROM chat_memory_entries e JOIN chat_memory_versions v ON v.entry_id = e.id AND v.version = e.current_version WHERE e.principal = ? ORDER BY e.updated_at DESC, e.id DESC LIMIT ?').all(principal, CONTEXT_LIMITS.memoryPerPrincipal);
  }
  listMemory(threadId, { includeInactive = false } = {}) {
    const row = this.thread(threadId);
    return this.memoryRows(row.principal).filter(entry => includeInactive || entry.status === 'active' && this.liveSources(row.principal, entry.source_snapshots)).map(entry => this.memoryDto(entry));
  }
  getContext(threadId, { query = '', beforeMessageId } = {}) {
    const standalone = !this.db.isTransaction;
    if (standalone) this.db.exec('BEGIN');
    try {
      const result = this.readContext(threadId, { query, beforeMessageId });
      if (standalone) this.db.exec('COMMIT');
      return result;
    } catch (error) { if (standalone) this.db.exec('ROLLBACK'); throw error; }
  }
  readContext(threadId, { query = '', beforeMessageId } = {}) {
    const row = this.thread(threadId);
    query = text(query, CONTEXT_LIMITS.queryCharacters, 'query', true);
    if (beforeMessageId !== undefined && (!Number.isSafeInteger(beforeMessageId) || beforeMessageId < 1)) fail('invalid_context', 'beforeMessageId must be a positive message ID');
    if (beforeMessageId !== undefined) {
      const source = this.db.prepare('SELECT id FROM chat_messages WHERE id = ? AND thread_id = ? AND deleted_at IS NULL').get(beforeMessageId, threadId);
      if (!source) fail('invalid_source', 'Context message must belong to the authorized conversation');
    }
    const selected = this.db.prepare('SELECT id, role, content, created_at, updated_at FROM chat_messages WHERE thread_id = ? AND deleted_at IS NULL AND id <= ? ORDER BY id DESC LIMIT ?').all(threadId, beforeMessageId ?? Number.MAX_SAFE_INTEGER, CONTEXT_LIMITS.messages);
    const words = terms(query || selected.find(message => message.role === 'user')?.content.slice(0, CONTEXT_LIMITS.queryCharacters) || row.title);
    let remaining = CONTEXT_LIMITS.messageBudget;
    const messages = selected.flatMap(message => {
      if (!remaining) return [];
      const bounded = message.content.slice(0, Math.min(remaining, CONTEXT_LIMITS.messageCharacters)); remaining -= bounded.length;
      return [{ ...message, content: bounded, truncated: bounded.length < message.content.length, provenance: 'historical_message', authority: 'untrusted_content' }];
    }).reverse();
    const rank = (items, value) => items.map(item => ({ item, score: score(value(item), words) })).sort((a, b) => b.score - a.score).map(({ item }) => item);
    const memory = rank(this.listMemory(threadId), entry => `${entry.key} ${entry.value}`).slice(0, CONTEXT_LIMITS.memory);
    const summaries = rank(this.db.prepare("SELECT s.* FROM chat_summary_versions s JOIN chat_threads t ON t.id = s.thread_id WHERE s.principal = ? AND t.principal = ? AND t.deleted_at IS NULL AND s.status = 'active' ORDER BY s.created_at DESC LIMIT ?").all(row.principal, row.principal, CONTEXT_LIMITS.candidates)
      .filter(summary => this.liveSources(row.principal, summary.source_snapshots)), item => `${item.summary} ${item.category}`).slice(0, CONTEXT_LIMITS.summaries)
      .map(item => ({ thread_id: item.thread_id, version: item.version, summary: item.summary, category: item.category, certainty: item.certainty, source_message_ids: JSON.parse(item.source_message_ids), created_at: item.created_at, actor: item.actor }));
    const related = rank(this.db.prepare('SELECT id, title, category, updated_at FROM chat_threads WHERE principal = ? AND id <> ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?').all(row.principal, threadId, CONTEXT_LIMITS.candidates), item => `${item.title} ${item.category}`).slice(0, CONTEXT_LIMITS.relatedThreads);
    return { thread_id: threadId, principal: row.principal, context_version: this.version(threadId), messages, summaries, memory,
      related_threads: related, tasks: memory.filter(entry => entry.type === 'task'), cold_start: !summaries.length && !memory.length && !related.length,
      limits: CONTEXT_LIMITS, provenance: { method: 'bounded_keyword_and_recency', automatic_extraction: false, external_model_calls: false, message_truth: 'historical, not current facts', authority: 'server_verified_thread_principal' } };
  }

  trustedActor(actor) {
    if (actor !== 'owner' && !/^connector:[A-Za-z0-9._:-]{1,100}$/.test(actor || '')) fail('context_write_denied', 'Only a reviewed owner or authenticated connector can write derived context', 403);
  }
  // Called inside the caller's existing write transaction/idempotency boundary.
  writeback(threadId, payload, { actor, sourceMessageIds, expectedContextVersion } = {}) {
    if (!this.db.isTransaction) throw new Error('Context writeback requires the caller\'s atomic transaction');
    this.trustedActor(actor);
    fields(payload, ['summary', 'category', 'memory_patch']);
    const row = this.thread(threadId);
    if (expectedContextVersion !== undefined) this.assertVersion(threadId, expectedContextVersion);
    if (payload.memory_patch !== undefined && (!Array.isArray(payload.memory_patch) || payload.memory_patch.length > CONTEXT_LIMITS.patchEntries)) fail('invalid_context', 'memory_patch must be a bounded list');
    const changes = (payload.memory_patch || []).map(patch => this.writeMemory(row, patch, actor));
    if (payload.summary !== undefined || payload.category !== undefined) {
      const summary = payload.summary;
      if (summary !== undefined) fields(summary, ['text', 'certainty', 'source_message_ids']);
      const value = summary === undefined ? this.thread(threadId).summary : text(summary.text, CONTEXT_LIMITS.summaryCharacters, 'summary', true);
      safeMemory(value);
      const category = payload.category === undefined ? row.category : text(payload.category, 80, 'category', true) || '未分类';
      if (/[\r\n\t]/.test(category)) fail('invalid_context', 'category must be a single line');
      safeMemory(category);
      const ids = summary?.source_message_ids || sourceMessageIds;
      const snapshots = this.sources(row.principal, ids);
      const version = (this.db.prepare('SELECT MAX(version) AS n FROM chat_summary_versions WHERE thread_id = ?').get(threadId).n || 0) + 1;
      if (version > CONTEXT_LIMITS.versions) fail('context_capacity', 'Summary version history has reached its limit', 429);
      const confidence = summary === undefined ? 'inferred' : certainty(summary.certainty);
      this.db.prepare("UPDATE chat_summary_versions SET status = 'superseded' WHERE thread_id = ? AND status = 'active'").run(threadId);
      this.db.prepare("INSERT INTO chat_summary_versions(thread_id, version, principal, summary, category, certainty, status, source_message_ids, source_snapshots, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)").run(threadId, version, row.principal, value, category, confidence, JSON.stringify(ids), JSON.stringify(snapshots), actor, this.store.now());
      this.db.prepare('UPDATE chat_threads SET summary = ?, category = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(value, category, this.store.now(), threadId);
      this.audit(row, actor, 'summary_written', null, version); this.touch(row.principal);
    }
    return { context_version: this.version(threadId), memory: changes };
  }
  writeMemory(row, patch, actor, selfCorrection = false) {
    fields(patch, ['id', 'version', 'type', 'key', 'value', 'certainty', 'status', 'source_message_ids', 'reason']);
    const existing = patch.id ? this.memoryRows(row.principal).find(entry => entry.id === patch.id) : null;
    if (patch.id && !existing) fail('not_found', 'Memory entry not found', 404);
    if (selfCorrection && !existing) fail('context_write_denied', 'Users can correct their existing memory entries', 403);
    if (existing && patch.version !== existing.current_version) fail('memory_changed', 'Memory changed. Reload before correcting it.', 409);
    if (!existing && patch.version !== undefined) fail('invalid_context', 'New entries do not accept version');
    const type = existing?.type || patch.type, key = existing?.memory_key || text(patch.key, 100, 'key');
    if (!['fact', 'preference', 'task'].includes(type) || existing && (patch.type !== undefined && patch.type !== type || patch.key !== undefined && patch.key !== key)) fail('invalid_context', 'Use fact, preference or task and keep an existing entry key/type unchanged');
    const status = patch.status || 'active';
    if (!['active', 'invalidated', 'completed'].includes(status) || status === 'completed' && type !== 'task') fail('invalid_context', 'Invalid memory status');
    if (!existing && status !== 'active') fail('invalid_context', 'New entries must be active');
    const value = text(patch.value ?? existing?.value, CONTEXT_LIMITS.valueCharacters, 'value');
    const confidence = certainty(patch.certainty ?? (selfCorrection ? 'confirmed' : existing?.certainty));
    const reason = text(patch.reason || '', 240, 'reason', true);
    safeMemory(`${key}\n${value}\n${reason}`);
    const ids = patch.source_message_ids ?? (status === 'active' ? undefined : JSON.parse(existing.source_message_ids));
    const snapshots = this.sources(row.principal, ids);
    if (status === 'active' && this.memoryRows(row.principal).some(entry => entry.id !== existing?.id && entry.memory_key === key && entry.type === type && entry.status === 'active')) fail('memory_key_exists', 'Correct the existing current entry instead of creating or restoring a conflicting fact', 409);
    if (!existing) {
      if (this.memoryRows(row.principal).length >= CONTEXT_LIMITS.memoryPerPrincipal || this.db.prepare('SELECT COUNT(*) AS n FROM chat_memory_entries').get().n >= CONTEXT_LIMITS.memoryTotal) fail('context_capacity', 'Memory storage limit reached', 429);
    }
    const id = existing?.id || randomUUID(), version = (existing?.current_version || 0) + 1, at = this.store.now();
    if (version > CONTEXT_LIMITS.versions) fail('context_capacity', 'Memory version history has reached its limit', 429);
    if (existing) {
      this.db.prepare("UPDATE chat_memory_versions SET status = 'superseded' WHERE entry_id = ? AND version = ? AND status = 'active'").run(id, existing.current_version);
      this.db.prepare('UPDATE chat_memory_entries SET current_version = ?, updated_at = ? WHERE id = ?').run(version, at, id);
      // A summary may have used this fact indirectly through an earlier reply.
      // Without semantic dependency tracking, retire this user's old summaries
      // conservatively rather than presenting contradicted text as current.
      this.invalidateSummaries(row, null, actor);
    } else this.db.prepare('INSERT INTO chat_memory_entries(id, principal, memory_key, type, current_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, row.principal, key, type, version, at, at);
    this.db.prepare('INSERT INTO chat_memory_versions(entry_id, version, value, certainty, status, source_thread_id, source_message_ids, source_snapshots, actor, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, version, value, confidence, status, row.id, JSON.stringify(ids), JSON.stringify(snapshots), actor, reason, at);
    this.audit(row, actor, selfCorrection ? 'memory_corrected_by_user' : 'memory_written', id, version); this.touch(row.principal);
    return this.memoryDto(this.memoryRows(row.principal).find(entry => entry.id === id));
  }
  correct(threadId, id, payload, session) {
    if (!this.db.isTransaction) throw new Error('Memory correction requires the caller\'s atomic transaction');
    const row = this.thread(threadId);
    if (!session || row.principal !== session.principal) fail('not_found', 'Memory entry not found', 404);
    fields(payload, ['version', 'value', 'certainty', 'status', 'source_message_ids', 'reason']);
    return this.writeMemory(row, { ...payload, id }, `user:${row.principal}`, true);
  }
  history(threadId, id) {
    const row = this.thread(threadId);
    const entry = this.memoryRows(row.principal).find(item => item.id === id);
    if (!entry) fail('not_found', 'Memory entry not found', 404);
    const versions = this.db.prepare('SELECT * FROM chat_memory_versions WHERE entry_id = ? ORDER BY version DESC LIMIT ?').all(id, CONTEXT_LIMITS.versions);
    const audit = this.db.prepare('SELECT seq, thread_id, actor, event, version, at FROM chat_context_audit WHERE principal = ? AND entry_id = ? ORDER BY seq DESC LIMIT ?').all(row.principal, id, CONTEXT_LIMITS.versions);
    return { entry: this.memoryDto(entry), versions: versions.map(version => ({ version: version.version, value: version.value, status: version.status, certainty: version.certainty, source_thread_id: version.source_thread_id, source_message_ids: JSON.parse(version.source_message_ids), actor: version.actor, reason: version.reason, created_at: version.created_at })), audit };
  }
  invalidateSummaries(row, sourceIds, actor) {
    for (const summary of this.db.prepare("SELECT * FROM chat_summary_versions WHERE principal = ? AND status = 'active'").all(row.principal)) {
      if (sourceIds && !JSON.parse(summary.source_message_ids).some(id => sourceIds.includes(id))) continue;
      this.db.prepare("UPDATE chat_summary_versions SET status = 'invalidated' WHERE thread_id = ? AND version = ?").run(summary.thread_id, summary.version);
      this.db.prepare("UPDATE chat_threads SET summary = '', updated_at = ?, revision = revision + 1 WHERE id = ?").run(this.store.now(), summary.thread_id);
      this.audit({ ...row, id: summary.thread_id }, actor, 'summary_invalidated', null, summary.version);
    }
  }
  invalidateSources(threadId, ids, actor) {
    const row = this.thread(threadId);
    let changedMemory = false;
    for (const entry of this.memoryRows(row.principal)) {
      if (entry.status !== 'active' || !JSON.parse(entry.source_message_ids).some(id => ids.includes(id))) continue;
      // Source withdrawal/edit must succeed even if the version quota is full.
      // Preserve the old value and provenance, but never retrieve it as current.
      this.db.prepare("UPDATE chat_memory_versions SET status = 'invalidated' WHERE entry_id = ? AND version = ?").run(entry.id, entry.current_version);
      this.audit(row, actor, 'memory_source_invalidated', entry.id, entry.current_version);
      changedMemory = true;
    }
    this.invalidateSummaries(row, changedMemory ? null : ids, actor); this.touch(row.principal);
  }
  migratePrincipal(source, destination) {
    if (!this.db.isTransaction) throw new Error('Memory migration requires the verified account transaction');
    // Only ChatAccountAuth invokes this inside its verified migration transaction,
    // after moving threads. Scope changes never come from an API payload.
    if (!/^visitor:[a-f0-9]{32}$/.test(source) || !/^account:[a-f0-9]{32}$/.test(destination)) fail('invalid_migration', 'Verified guest/account principals are required');
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM chat_memory_entries WHERE principal IN (?, ?)').get(source, destination).n;
    if (count > CONTEXT_LIMITS.memoryPerPrincipal) fail('account_migration_limit', 'Combined memory exceeds the account storage limit; guest history was kept', 429);
    const conflicts = [], migratedThreads = new Set();
    for (const entry of this.memoryRows(source)) {
      if (!this.db.prepare('SELECT id FROM chat_threads WHERE id = ? AND principal = ?').get(entry.source_thread_id, destination)) fail('invalid_migration', 'Conversation ownership must migrate in the same transaction', 409);
      // A conflicting guest fact is preserved for review, never silently replaces
      // a signed-in account fact with the same type/key.
      const duplicate = this.memoryRows(destination).some(current => current.type === entry.type && current.memory_key === entry.memory_key && current.status === 'active');
      this.db.prepare('UPDATE chat_memory_entries SET principal = ? WHERE id = ?').run(destination, entry.id);
      migratedThreads.add(entry.source_thread_id);
      if (duplicate && entry.status === 'active') {
        this.db.prepare("UPDATE chat_memory_versions SET status = 'invalidated' WHERE entry_id = ? AND version = ?").run(entry.id, entry.current_version);
        conflicts.push(...JSON.parse(entry.source_message_ids));
      }
    }
    this.db.prepare('UPDATE chat_summary_versions SET principal = ? WHERE principal = ? AND thread_id IN (SELECT id FROM chat_threads WHERE principal = ?)').run(destination, source, destination);
    this.db.prepare('UPDATE chat_context_audit SET principal = ? WHERE principal = ? AND thread_id IN (SELECT id FROM chat_threads WHERE principal = ?)').run(destination, source, destination);
    for (const threadId of migratedThreads) {
      const row = this.thread(threadId);
      if (conflicts.length) this.invalidateSummaries(row, conflicts, 'account_migration');
      this.audit(row, 'account_migration', 'principal_migrated');
    }
    this.touch(source); this.touch(destination);
  }
}
