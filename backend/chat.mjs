import { randomBytes } from 'node:crypto';
import { ApiError } from './store.mjs';
import { digest, constantEqual } from './auth.mjs';
import { ChatAccountAuth } from './chat-auth.mjs';

// Intake is deliberately separate from TaskStore's executable task state machine.
// These are resource ceilings, not promises that a worker is available.
export const CHAT_LIMITS = Object.freeze({
  sessionTtlMs: 7 * 86400000, sessionIdleMs: 86400000, sessions: 10000,
  textCharacters: 8000, textBytes: 32000, bodyBytes: 32768,
  visitorThreads: 40, accountThreads: 200, ownerThreads: 500, messagesPerThread: 200,
  principalBytes: 1024 * 1024, totalThreads: 10000, totalMessages: 20000,
  totalBytes: 64 * 1024 * 1024, rateWindowMs: 900000, rateBuckets: 8192,
  sessionCreationsPerIp: 12, readsPerVisitor: 1800, readsPerIp: 7200,
  writesPerVisitor: 40, writesPerIp: 120,
  idempotencyTtlMs: 86400000, idempotencyPerPrincipal: 1024, idempotencyTotal: 20000,
});
const randomToken = () => randomBytes(32).toString('base64url');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const notFound = () => new ApiError(404, 'not_found', 'Conversation or message not found');
function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
function fields(body, allowed) {
  if (!object(body) || Object.keys(body).some(key => !allowed.includes(key))) throw new ApiError(400, 'invalid_input', `Only ${allowed.join(', ') || 'an empty object'} accepted`);
}
function content(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > CHAT_LIMITS.textCharacters || Buffer.byteLength(value) > CHAT_LIMITS.textBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new ApiError(400, 'invalid_input', `content must contain 1–${CHAT_LIMITS.textCharacters} printable characters`);
  return value.trim();
}
function submission(body) {
  fields(body, ['content', 'attachments', 'agent_id']);
  if (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.length)) throw new ApiError(400, 'uploads_unavailable', 'Attachments are not supported by this intake service');
  if (body.agent_id !== undefined && body.agent_id !== null) throw new ApiError(400, 'execution_unavailable', 'No execution connector or agent assignment is available');
  return content(body.content);
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  if (req.headers['content-length'] && Number(req.headers['content-length']) > CHAT_LIMITS.bodyBytes) throw new ApiError(413, 'body_too_large', 'The request body is too large');
  for await (const chunk of req) {
    size += chunk.length;
    if (size > CHAT_LIMITS.bodyBytes) throw new ApiError(413, 'body_too_large', 'The request body is too large');
    chunks.push(chunk);
  }
  if (size === 0 && req.method === 'DELETE') return {};
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'json_required', 'Send Content-Type: application/json');
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) || '{}'); }
  catch { throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON'); }
  if (!object(body)) throw new ApiError(400, 'invalid_input', 'Expected a JSON object');
  return body;
}
function pagination(url) {
  const read = (name, fallback, min, max) => {
    const value = url.searchParams.get(name);
    if (value === null) return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new ApiError(400, 'invalid_query', `Invalid ${name}`);
    return Number(value);
  };
  if ([...url.searchParams.keys()].some(key => !['limit', 'offset'].includes(key))) throw new ApiError(400, 'invalid_query', 'Only limit and offset are accepted');
  return { limit: read('limit', 100, 1, 100), offset: read('offset', 0, 0, CHAT_LIMITS.totalThreads) };
}

export class ChatIntake {
  constructor(store, config, auth) {
    this.store = store;
    this.db = store.db;
    this.config = config;
    this.auth = auth;
    this.secure = Boolean(config.production || config.publicOrigin?.startsWith('https:'));
    this.cookieName = this.secure ? '__Host-chat_session' : 'chat_session';
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_guest_sessions (
        id_hash TEXT PRIMARY KEY, principal TEXT NOT NULL UNIQUE, csrf TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_threads (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('visitor_question','owner_instruction')),
        title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '未分类',
        pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        deleted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS chat_threads_by_principal ON chat_threads(principal, deleted_at, updated_at, id);
      CREATE INDEX IF NOT EXISTS chat_threads_by_kind ON chat_threads(kind, deleted_at, updated_at, id);
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL REFERENCES chat_threads(id),
        role TEXT NOT NULL CHECK(role IN ('user','agent')), author TEXT NOT NULL,
        content TEXT NOT NULL, content_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        editable INTEGER NOT NULL CHECK(editable IN (0,1)), queue_position INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS chat_messages_by_thread ON chat_messages(thread_id, id);
      CREATE TABLE IF NOT EXISTS chat_idempotency (
        principal TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL,
        fingerprint TEXT NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (principal, scope, key)
      );
      CREATE INDEX IF NOT EXISTS chat_idempotency_expiry ON chat_idempotency(created_at);
      CREATE TABLE IF NOT EXISTS chat_rate_limits (
        bucket TEXT PRIMARY KEY, started_at INTEGER NOT NULL, attempts INTEGER NOT NULL
      );
    `);
    // Additive upgrade for an existing local intake database.
    const columns = new Set(this.db.prepare('PRAGMA table_info(chat_threads)').all().map(column => column.name));
    if (!columns.has('summary')) this.db.exec("ALTER TABLE chat_threads ADD COLUMN summary TEXT NOT NULL DEFAULT ''");
    if (!columns.has('category')) this.db.exec("ALTER TABLE chat_threads ADD COLUMN category TEXT NOT NULL DEFAULT '未分类'");
    this.cleanup();
    this.accounts = new ChatAccountAuth(store, config, auth);
  }

  cleanup() {
    const at = this.store.now();
    this.db.prepare('DELETE FROM chat_guest_sessions WHERE expires_at <= ? OR last_seen <= ?').run(at, at - CHAT_LIMITS.sessionIdleMs);
    this.db.prepare('DELETE FROM chat_idempotency WHERE created_at <= ?').run(at - CHAT_LIMITS.idempotencyTtlMs);
    this.db.prepare('DELETE FROM chat_rate_limits WHERE started_at <= ?').run(at - CHAT_LIMITS.rateWindowMs);
    // Expiry removes credentials, not conversation history or the owner's inbox.
  }

  rate(buckets) {
    const at = this.store.now();
    this.store.transaction(() => {
      this.db.prepare('DELETE FROM chat_rate_limits WHERE started_at <= ?').run(at - CHAT_LIMITS.rateWindowMs);
      const entries = buckets.map(([bucket, max]) => ({ bucket, max, row: this.db.prepare('SELECT attempts FROM chat_rate_limits WHERE bucket = ?').get(bucket) }));
      if (entries.some(({ row, max }) => row && row.attempts >= max)) throw new ApiError(429, 'chat_rate_limited', 'Too many intake requests. Try again in 15 minutes.');
      if (this.db.prepare('SELECT COUNT(*) AS n FROM chat_rate_limits').get().n + entries.filter(entry => !entry.row).length > CHAT_LIMITS.rateBuckets) throw new ApiError(429, 'chat_capacity', 'Intake is temporarily busy. Try again later.');
      for (const { bucket } of entries) this.db.prepare('INSERT INTO chat_rate_limits(bucket, started_at, attempts) VALUES (?, ?, 1) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1').run(bucket, at);
    });
  }

  guest(req) {
    const matches = (req.headers.cookie || '').split(';').map(value => value.trim().split('=')).filter(([name]) => name === this.cookieName);
    if (matches.length !== 1 || matches[0].length !== 2 || !/^[A-Za-z0-9_-]{43}$/.test(matches[0][1] || '')) return null;
    const idHash = digest(matches[0][1]);
    const row = this.db.prepare('SELECT * FROM chat_guest_sessions WHERE id_hash = ?').get(idHash);
    if (!row) return null;
    const at = this.store.now();
    if (row.expires_at <= at || row.last_seen + CHAT_LIMITS.sessionIdleMs <= at) {
      this.db.prepare('DELETE FROM chat_guest_sessions WHERE id_hash = ?').run(idHash);
      return null;
    }
    this.db.prepare('UPDATE chat_guest_sessions SET last_seen = ? WHERE id_hash = ?').run(at, idHash);
    return { principal: row.principal, role: 'visitor', csrfToken: row.csrf, expiresAt: row.expires_at };
  }

  createGuest(req, res, client) {
    this.rate([[`create-ip:${digest(client)}`, CHAT_LIMITS.sessionCreationsPerIp]]);
    const token = randomToken(), csrfToken = randomToken(), principal = `visitor:${randomBytes(16).toString('hex')}`;
    const at = this.store.now(), expiresAt = at + CHAT_LIMITS.sessionTtlMs;
    this.store.transaction(() => {
      this.db.prepare('DELETE FROM chat_guest_sessions WHERE expires_at <= ? OR last_seen <= ?').run(at, at - CHAT_LIMITS.sessionIdleMs);
      if (this.db.prepare('SELECT COUNT(*) AS n FROM chat_guest_sessions').get().n >= CHAT_LIMITS.sessions) throw new ApiError(503, 'chat_capacity', 'Intake is temporarily full. Try again later.');
      this.db.prepare('INSERT INTO chat_guest_sessions(id_hash, principal, csrf, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run(digest(token), principal, csrfToken, at, expiresAt, at);
    });
    res.setHeader('Set-Cookie', `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(CHAT_LIMITS.sessionTtlMs / 1000)}${this.secure ? '; Secure' : ''}`);
    return { principal, role: 'visitor', csrfToken, expiresAt };
  }

  requireReadOrigin(req) {
    if ((req.headers.origin && req.headers.origin !== this.config.publicOrigin) || req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, 'origin_denied', 'A same-origin browser request is required');
  }

  requireCurrentSession(req, expected) {
    // readBody yields to other requests: logout, expiry, password rotation or
    // account migration may have revoked the exact credential we first checked.
    // Never downgrade a revoked owner/account request to another valid cookie.
    let current;
    if (expected.role === 'owner') {
      const owner = this.auth.session(req);
      current = owner ? { ...owner, principal: 'owner', role: 'owner' } : null;
    } else if (expected.role === 'account') current = this.accounts.session(req);
    else current = this.guest(req);
    if (!current || current.principal !== expected.principal || current.role !== expected.role || !constantEqual(current.csrfToken, expected.csrfToken)) throw new ApiError(401, 'chat_session_required', 'Your chat session changed or expired. Refresh your identity before continuing');
    this.auth.requireCsrf(req, current);
  }

  idempotent(req, session, path, body, fn) {
    const principal = session.principal;
    const key = req.headers['x-idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new ApiError(400, 'idempotency_key_required', 'X-Idempotency-Key must contain 8–128 letters, numbers, periods, underscores, colons or hyphens');
    const scope = `${req.method}:${path}`, fingerprint = digest(JSON.stringify(body));
    return this.store.transaction(() => {
      this.requireCurrentSession(req, session);
      this.db.prepare('DELETE FROM chat_idempotency WHERE created_at <= ?').run(this.store.now() - CHAT_LIMITS.idempotencyTtlMs);
      const prior = this.db.prepare('SELECT fingerprint, response FROM chat_idempotency WHERE principal = ? AND scope = ? AND key = ?').get(principal, scope, key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new ApiError(409, 'idempotency_conflict', 'That key was already used with a different request');
        return JSON.parse(prior.response);
      }
      if (this.db.prepare('SELECT COUNT(*) AS n FROM chat_idempotency WHERE principal = ?').get(principal).n >= CHAT_LIMITS.idempotencyPerPrincipal || this.db.prepare('SELECT COUNT(*) AS n FROM chat_idempotency').get().n >= CHAT_LIMITS.idempotencyTotal) throw new ApiError(429, 'chat_capacity', 'The daily intake request limit has been reached. Try again later.');
      const result = fn();
      this.db.prepare('INSERT INTO chat_idempotency(principal, scope, key, fingerprint, response, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(principal, scope, key, fingerprint, JSON.stringify(result), this.store.now());
      return result;
    });
  }

  thread(id, principal, admin = false) {
    const row = admin
      ? this.db.prepare('SELECT * FROM chat_threads WHERE id = ? AND deleted_at IS NULL').get(id)
      : this.db.prepare('SELECT * FROM chat_threads WHERE id = ? AND principal = ? AND deleted_at IS NULL').get(id, principal);
    if (!row) throw notFound();
    return row;
  }

  taskDto(row, admin = false) {
    const latestReply = this.db.prepare("SELECT MAX(id) AS id FROM chat_messages WHERE thread_id = ? AND role = 'agent' AND deleted_at IS NULL").get(row.id).id || 0;
    const waiting = this.db.prepare('SELECT id FROM chat_messages WHERE thread_id = ? AND editable = 1 AND deleted_at IS NULL LIMIT 1').get(row.id);
    return {
      id: row.id, title: row.title, kind: row.kind, summary: row.summary, category: row.category,
      status: 'queued', pinned: Boolean(row.pinned),
      receipt_state: waiting ? 'waiting' : latestReply ? 'replied' : 'received', latest_reply_id: latestReply,
      target_agent_id: null, target_name: null, agent_name: latestReply ? this.config.ownerName || 'Owner' : null,
      created_at: row.created_at / 1000, updated_at: row.updated_at / 1000, revision: row.revision,
      execution_connected: false, ...(admin ? { identity: row.principal, principal_role: row.principal === 'owner' ? 'owner' : row.principal.startsWith('account:') ? 'account' : 'visitor' } : {}),
    };
  }

  detail(row, admin = false) {
    const messages = this.db.prepare('SELECT * FROM chat_messages WHERE thread_id = ? AND deleted_at IS NULL ORDER BY id').all(row.id).map(message => ({
      id: message.id, role: message.role, content: message.content, attachments: [],
      agent_name: message.role === 'agent' ? this.config.ownerName || 'Owner' : null, target_name: null,
      queued_editable: message.role === 'user' && Boolean(message.editable), queue_position: message.queue_position,
      retry_job_id: null, created_at: message.created_at / 1000, updated_at: message.updated_at / 1000,
    }));
    return { task: this.taskDto(row, admin), messages };
  }

  list(principal, admin, url) {
    const { limit, offset } = pagination(url);
    const rows = admin
      ? this.db.prepare('SELECT * FROM chat_threads WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?').all(limit + 1, offset)
      : this.db.prepare('SELECT * FROM chat_threads WHERE principal = ? AND deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ? OFFSET ?').all(principal, limit + 1, offset);
    const more = rows.length > limit;
    return { tasks: rows.slice(0, limit).map(row => this.taskDto(row, admin)), has_more: more, next_offset: more ? offset + limit : null };
  }

  quota(principal, addedBytes, threadId = null, addingMessage = true) {
    if (addingMessage && threadId && this.db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id = ?').get(threadId).n >= CHAT_LIMITS.messagesPerThread) throw new ApiError(429, 'thread_limit', 'This conversation has reached its message limit');
    const own = this.db.prepare('SELECT COALESCE(SUM(m.content_bytes), 0) AS bytes FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id WHERE t.principal = ?').get(principal);
    const total = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(content_bytes), 0) AS bytes FROM chat_messages').get();
    if (own.bytes + addedBytes > CHAT_LIMITS.principalBytes || total.bytes + addedBytes > CHAT_LIMITS.totalBytes || (addingMessage && total.n >= CHAT_LIMITS.totalMessages)) throw new ApiError(429, 'chat_capacity', 'The intake storage limit has been reached');
  }

  insertMessage(row, text, role, author) {
    this.quota(row.principal, Buffer.byteLength(text), row.id);
    const at = this.store.now();
    const position = this.db.prepare('SELECT COALESCE(MAX(queue_position), 0) + 1 AS n FROM chat_messages WHERE thread_id = ?').get(row.id).n;
    const result = this.db.prepare('INSERT INTO chat_messages(thread_id, role, author, content, content_bytes, created_at, updated_at, editable, queue_position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, role, author, text, Buffer.byteLength(text), at, at, role === 'user' ? 1 : 0, position);
    this.bump(row.id);
    return Number(result.lastInsertRowid);
  }

  bump(id) { this.db.prepare('UPDATE chat_threads SET updated_at = ?, revision = revision + 1 WHERE id = ?').run(this.store.now(), id); }

  mutableMessage(row, id, principal) {
    const message = this.db.prepare('SELECT * FROM chat_messages WHERE id = ? AND thread_id = ? AND author = ? AND deleted_at IS NULL').get(id, row.id, principal);
    if (!message) throw notFound();
    if (message.role !== 'user' || !message.editable) throw new ApiError(409, 'message_already_reviewed', 'Only an unanswered intake message can be edited or withdrawn');
    return message;
  }

  async handle(req, res, url, ownerSession) {
    const path = url.pathname;
    const admin = path === '/api/admin/chat' || path.startsWith('/api/admin/chat/');
    if (!admin && path !== '/api/chat' && !path.startsWith('/api/chat/')) return false;
    this.requireReadOrigin(req);
    if (admin && !ownerSession) throw new ApiError(401, 'unauthorized', 'Owner sign-in is required');
    const client = this.auth.clientAddress(req);
    const guestSession = this.guest(req);
    if (!admin && await this.accounts.handle(req, res, url, { ownerSession, guestSession })) return true;
    let session = ownerSession ? { ...ownerSession, principal: 'owner', role: 'owner' } : this.accounts.session(req) || guestSession;
    if (req.method === 'GET' && path === '/api/chat/me') {
      if (!session) session = this.createGuest(req, res, client);
      if (session.role !== 'owner') this.rate([[`read:${session.principal}`, CHAT_LIMITS.readsPerVisitor], [`read-ip:${digest(client)}`, CHAT_LIMITS.readsPerIp]]);
      send(res, 200, { role: session.role, identity: session.principal, ...(session.username ? { username: session.username } : {}), ip: client, csrfToken: session.csrfToken, expiresAt: session.expiresAt, intake_enabled: true, execution_connected: false, uploads_enabled: false, max_upload_bytes: 0 });
      return true;
    }
    if (!session) throw new ApiError(401, 'chat_session_required', 'Initialize or refresh your chat identity before continuing');
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (mutation) this.auth.requireCsrf(req, session);
    if (session.role !== 'owner') this.rate([
      [`${mutation ? 'write' : 'read'}:${session.principal}`, mutation ? CHAT_LIMITS.writesPerVisitor : CHAT_LIMITS.readsPerVisitor],
      [`${mutation ? 'write' : 'read'}-ip:${digest(client)}`, mutation ? CHAT_LIMITS.writesPerIp : CHAT_LIMITS.readsPerIp],
    ]);
    const prefix = admin ? '/api/admin/chat' : '/api/chat';
    if (!admin && req.method === 'GET' && path === `${prefix}/agents`) { send(res, 200, { agents: [] }); return true; }
    if (!admin && (path === `${prefix}/uploads` || path.startsWith(`${prefix}/uploads/`))) throw new ApiError(503, 'uploads_unavailable', 'Uploads and downloads are not available in this intake service');
    if (req.method === 'GET' && path === `${prefix}/tasks`) { send(res, 200, this.list(session.principal, admin, url)); return true; }
    const match = new RegExp(`^${prefix}/tasks/([a-f0-9]{32})(?:/(pin|messages|queue/reorder|replies|metadata)(?:/([1-9][0-9]*))?)?$`).exec(path);
    if (req.method === 'GET' && match && !match[2]) { send(res, 200, this.detail(this.thread(match[1], session.principal, admin), admin)); return true; }
    if (!mutation) throw new ApiError(404, 'not_found', 'Endpoint not found');
    if (!admin && ['replies', 'metadata'].includes(match?.[2])) throw new ApiError(403, 'owner_reply_required', 'Only a verified owner can reply or classify through the owner inbox');
    if (admin && !((req.method === 'POST' && match?.[2] === 'replies' || req.method === 'PATCH' && match?.[2] === 'metadata') && !match[3])) throw new ApiError(404, 'not_found', 'Endpoint not found');
    const supported = (!admin && req.method === 'POST' && path === `${prefix}/tasks`) || (match && (
      (req.method === 'DELETE' && !match[2]) ||
      (req.method === 'POST' && ['pin', 'messages', 'queue/reorder', 'replies'].includes(match[2]) && !match[3]) ||
      (admin && req.method === 'PATCH' && match[2] === 'metadata' && !match[3]) ||
      (['PATCH', 'DELETE'].includes(req.method) && match[2] === 'messages' && match[3])
    ));
    if (!supported) throw new ApiError(404, 'not_found', 'Endpoint not found');
    const body = await readBody(req);
    const result = this.idempotent(req, session, path, body, () => {
      if (!match) {
        const text = submission(body);
        const ownCount = this.db.prepare('SELECT COUNT(*) AS n FROM chat_threads WHERE principal = ?').get(session.principal).n;
        if (ownCount >= (session.role === 'owner' ? CHAT_LIMITS.ownerThreads : session.role === 'account' ? CHAT_LIMITS.accountThreads : CHAT_LIMITS.visitorThreads) || this.db.prepare('SELECT COUNT(*) AS n FROM chat_threads').get().n >= CHAT_LIMITS.totalThreads) throw new ApiError(429, 'thread_limit', 'The conversation limit has been reached');
        const id = randomBytes(16).toString('hex'), at = this.store.now();
        this.db.prepare('INSERT INTO chat_threads(id, principal, kind, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, session.principal, session.role === 'owner' ? 'owner_instruction' : 'visitor_question', [...text.replace(/\s+/g, ' ')].slice(0, 80).join(''), at, at);
        this.insertMessage(this.thread(id, session.principal), text, 'user', session.principal);
        return { id, received: true, execution_connected: false };
      }
      const [, id, action, rawMessageId] = match;
      const row = this.thread(id, session.principal, admin);
      if (req.method === 'DELETE' && !action) {
        fields(body, []);
        this.db.prepare('UPDATE chat_threads SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND principal = ?').run(this.store.now(), this.store.now(), id, session.principal);
        return { id, deleted: true };
      }
      if (action === 'pin') {
        fields(body, ['pinned']);
        if (typeof body.pinned !== 'boolean') throw new ApiError(400, 'invalid_input', 'pinned must be a boolean');
        this.db.prepare('UPDATE chat_threads SET pinned = ? WHERE id = ? AND principal = ?').run(body.pinned ? 1 : 0, id, session.principal);
        this.bump(id);
        return { id, pinned: body.pinned };
      }
      if (action === 'replies') {
        fields(body, ['content']);
        const text = content(body.content);
        const messageId = this.insertMessage(row, text, 'agent', 'owner');
        this.db.prepare('UPDATE chat_messages SET editable = 0 WHERE thread_id = ? AND role = ?').run(id, 'user');
        return { id: messageId, task_id: id, replied: true, execution_connected: false };
      }
      if (action === 'metadata') {
        fields(body, ['summary', 'category']);
        if (!Object.keys(body).length) throw new ApiError(400, 'invalid_input', 'Provide summary or category');
        for (const [field, maximum] of [['summary', 4000], ['category', 80]]) {
          if (body[field] !== undefined && (typeof body[field] !== 'string' || body[field].length > maximum || Buffer.byteLength(body[field]) > maximum * 4 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body[field]) || (field === 'category' && /[\r\n\t]/.test(body[field])))) throw new ApiError(400, 'invalid_input', `${field} must be text of at most ${maximum} characters`);
        }
        const summary = body.summary === undefined ? row.summary : body.summary.trim();
        const category = body.category === undefined ? row.category : body.category.trim() || '未分类';
        this.db.prepare('UPDATE chat_threads SET summary = ?, category = ? WHERE id = ?').run(summary, category, id);
        this.bump(id);
        return { id, summary, category };
      }
      if (action === 'messages' && !rawMessageId) {
        const messageId = this.insertMessage(row, submission(body), 'user', session.principal);
        return { id: messageId, task_id: id, received: true, execution_connected: false };
      }
      if (action === 'messages') {
        const messageId = Number(rawMessageId);
        if (!Number.isSafeInteger(messageId)) throw notFound();
        const message = this.mutableMessage(row, messageId, session.principal);
        if (req.method === 'PATCH') {
          fields(body, ['content']);
          const text = content(body.content);
          this.quota(row.principal, Buffer.byteLength(text) - message.content_bytes, null, false);
          this.db.prepare('UPDATE chat_messages SET content = ?, content_bytes = ?, updated_at = ? WHERE id = ? AND thread_id = ? AND author = ?').run(text, Buffer.byteLength(text), this.store.now(), messageId, id, session.principal);
        } else {
          fields(body, []);
          this.db.prepare('UPDATE chat_messages SET deleted_at = ?, editable = 0, updated_at = ? WHERE id = ? AND thread_id = ? AND author = ?').run(this.store.now(), this.store.now(), messageId, id, session.principal);
        }
        this.bump(id);
        return { id: messageId, ...(req.method === 'PATCH' ? { updated: true } : { deleted: true }) };
      }
      fields(body, ['message_ids']);
      if (!Array.isArray(body.message_ids) || body.message_ids.length > CHAT_LIMITS.messagesPerThread || body.message_ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(body.message_ids).size !== body.message_ids.length) throw new ApiError(400, 'invalid_input', 'message_ids must be a list of distinct positive integer IDs');
      const current = this.db.prepare("SELECT id FROM chat_messages WHERE thread_id = ? AND author = ? AND role = 'user' AND editable = 1 AND deleted_at IS NULL").all(id, session.principal).map(message => message.id);
      if (current.length !== body.message_ids.length || current.some(id => !body.message_ids.includes(id))) throw new ApiError(409, 'queue_changed', 'Reload and provide all current unanswered message IDs');
      body.message_ids.forEach((messageId, index) => this.db.prepare('UPDATE chat_messages SET queue_position = ? WHERE id = ? AND thread_id = ? AND author = ?').run(index + 1, messageId, id, session.principal));
      this.bump(id);
      return { id, message_ids: body.message_ids };
    });
    send(res, req.method === 'POST' && (path === `${prefix}/tasks` || match?.[2] === 'messages' || match?.[2] === 'replies') ? 201 : 200, result);
    return true;
  }
}
