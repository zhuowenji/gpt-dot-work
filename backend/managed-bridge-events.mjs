import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { ApiError } from './store.mjs';

// No startup side effects: no dispatcher, credential generation or network request.
export const EVENT_LIMITS = Object.freeze({
  subscriptions: 32, events: 100000, deliveries: 200000,
  maxAttempts: 8, maxAgeMs: 86400000, deliveryLeaseMs: 30000,
  requestTimeoutMs: 10000, dnsTimeoutMs: 3000, connectTimeoutMs: 3000, maxLeaseMs: 86400000,
  verificationCacheMs: 300000, rotationMs: 300000, minimumLeaseMs: 1000,
  inFlight: 8,
});

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const invalid = message => new ApiError(400, 'invalid_subscription', message);
const unavailable = () => new ApiError(503, 'managed_events_disabled', 'Managed event delivery is not enabled');
const blockedDestination = () => new ApiError(400, 'callback_destination_denied', 'The callback destination is not trusted');
const digest = value => createHash('sha256').update(value).digest('hex');

function exactFields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw invalid('Unsupported subscription fields');
}
function boundedText(value, name, maximum = 256) {
  if (typeof value !== 'string' || !value.length || value.length > maximum || /[\u0000-\u0020\u007f]/u.test(value)) throw invalid(`Invalid ${name}`);
  return value;
}

function ipv4Number(address) {
  if (isIP(address) !== 4) return null;
  return address.split('.').reduce((number, octet) => number * 256 + Number(octet), 0);
}
function inV4(number, base, bits) {
  const block = 2 ** (32 - bits);
  return Math.floor(number / block) === Math.floor(ipv4Number(base) / block);
}

// Fail closed for reserved/documentation/translation/transition address space.
// Hostname allowlisting is additionally mandatory; public DNS alone is not trust.
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const number = ipv4Number(address);
    return ![
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
      ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([base, bits]) => inV4(number, base, bits));
  }
  if (family !== 6 || address.includes('%')) return false;
  const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  // Only global-unicast 2000::/3. Disallow the entire 2001:0::/23 special-purpose
  // allocation, documentation, 6to4 and the 3fff::/20 documentation allocation.
  const words = normalized.split(':');
  const first = Number.parseInt(words[0], 16), second = Number.parseInt(words[1] || '0', 16);
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3fff
    && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}

export function validateCallbackUrl(value, allowedOrigins) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(value)) throw blockedDestination();
  let url;
  try { url = new URL(value); } catch { throw blockedDestination(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port
    || !url.hostname.includes('.') || url.hostname.endsWith('.') || isIP(url.hostname.replace(/^\[|\]$/g, ''))) throw blockedDestination();
  if (!allowedOrigins.has(url.origin)) {
    const error = new ApiError(400, 'callback_origin_not_allowed', `Callback origin is not allowed: ${url.origin}`);
    error.origin = url.origin; // Never expose the opaque callback path or query.
    throw error;
  }
  return url;
}

function signingKey(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw invalid('Invalid callback signing secret');
  const encoded = secret.slice(6), key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64') !== encoded) throw invalid('Invalid callback signing secret');
  return key;
}

export function standardWebhookHeaders(secret, eventId, body, at) {
  if (typeof eventId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(eventId)
    || typeof body !== 'string' || !Number.isSafeInteger(at) || at < 0) throw invalid('Invalid event signature input');
  const timestamp = String(Math.floor(at / 1000));
  const signature = createHmac('sha256', signingKey(secret)).update(`${eventId}.${timestamp}.${body}`).digest('base64');
  return { 'webhook-id': eventId, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` };
}

// Only these bounded reasons cross an API or durable diagnostic boundary.
export const CALLBACK_FAILURE_REASONS = Object.freeze([
  'dns_error', 'dns_timeout', 'connect_error', 'connect_timeout', 'tls_error',
  'http_error', 'challenge_mismatch', 'response_invalid', 'request_timeout',
  'cancelled', 'transport_error',
]);
export const CALLBACK_TRANSPORT_CODES = Object.freeze([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENETUNREACH', 'EHOSTUNREACH',
  'EADDRNOTAVAIL', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'EPROTO', 'EACCES', 'EPERM',
  'ERR_SOCKET_CLOSED', 'ERR_STREAM_DESTROYED', 'ERR_ACCESS_DENIED',
  'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_INVALID_IP_ADDRESS', 'ERR_INVALID_PROTOCOL',
  'ERR_HTTP_INVALID_HEADER_VALUE', 'ERR_INVALID_CHAR', 'ERR_HTTP_HEADERS_SENT',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_HANDSHAKE_TIMEOUT', 'ERR_SSL_WRONG_VERSION_NUMBER',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED', 'CERT_SIGNATURE_FAILURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'INVALID_CA', 'CERT_UNTRUSTED',
  'HPE_INVALID_CONSTANT', 'HPE_INVALID_HEADER_TOKEN', 'HPE_INVALID_CONTENT_LENGTH',
  'HPE_UNEXPECTED_CONTENT_LENGTH', 'HPE_HEADER_OVERFLOW', 'HPE_INVALID_CHUNK_SIZE',
]);
export const CALLBACK_TRANSPORT_PHASES = Object.freeze(['dns', 'connect', 'tls', 'response']);
export const CALLBACK_HTTP_CLASSES = Object.freeze(['http_4xx', 'http_5xx', 'other']);
class CallbackFailure extends Error {
  constructor(reason, retryableConnection = false, code, phase) {
    super(`Callback failed: ${reason}`);
    this.reason = reason; this.retryableConnection = retryableConnection;
    if (CALLBACK_TRANSPORT_CODES.includes(code)) this.transportCode = code;
    if (CALLBACK_TRANSPORT_PHASES.includes(phase)) this.transportPhase = phase;
  }
}
function failureReason(error) {
  return error instanceof CallbackFailure && CALLBACK_FAILURE_REASONS.includes(error.reason) ? error.reason : 'transport_error';
}
function verificationFailed(reason, failure) {
  const safeReason = CALLBACK_FAILURE_REASONS.includes(reason) ? reason : 'transport_error';
  const error = new ApiError(400, 'callback_verification_failed', `The callback challenge was not verified (${safeReason})`);
  error.reason = safeReason;
  if (failure instanceof CallbackFailure) {
    if (CALLBACK_TRANSPORT_CODES.includes(failure.transportCode)) error.transport_code = failure.transportCode;
    if (CALLBACK_TRANSPORT_PHASES.includes(failure.transportPhase)) error.transport_phase = failure.transportPhase;
  }
  return error;
}
function cancelled(signal) {
  return new CallbackFailure(signal?.reason instanceof CallbackFailure ? failureReason(signal.reason) : 'cancelled');
}
function httpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}
function transportFailure(error, connected, tlsReady) {
  if (error instanceof CallbackFailure) return error;
  // Inspect codes only, never messages, causes, response bodies, or request data.
  const code = typeof error?.code === 'string' ? error.code : '';
  const phase = !connected ? 'connect' : tlsReady ? 'response' : 'tls';
  if (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') || [
    'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED', 'CERT_SIGNATURE_FAILURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'INVALID_CA', 'CERT_UNTRUSTED',
  ].includes(code) || (connected && !tlsReady)) return new CallbackFailure('tls_error', false, code, phase);
  // Retry only a known failure before TCP connects, when no HTTP bytes can
  // have been transmitted. TLS, response, or ambiguous failures never fail over.
  if (!connected && ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'ECONNRESET', 'ETIMEDOUT'].includes(code)) {
    return new CallbackFailure(code === 'ETIMEDOUT' ? 'connect_timeout' : 'connect_error', true, code, phase);
  }
  return new CallbackFailure('transport_error', false, code, phase);
}

async function withDeadline(promise, milliseconds, signal, reason = 'request_timeout') {
  let timer, abort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CallbackFailure(reason)), milliseconds);
      abort = () => reject(cancelled(signal));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    })]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

// Exactly one vetted address per HTTPS request. The URL, Host and TLS SNI
// retain the original hostname; no redirects, proxies or TLS exceptions.
export function pinnedHttpsTransport({ url, address, headers, body, signal, timeoutMs, connectTimeoutMs = timeoutMs, readResponse = false }) {
  return new Promise((resolve, reject) => {
    let connected = false, tlsReady = false, connectTimer, req;
    const fail = error => { clearTimeout(connectTimer); reject(signal?.aborted ? cancelled(signal) : transportFailure(error, connected, tlsReady)); };
    const done = result => { clearTimeout(connectTimer); resolve(result); };
    try {
      req = httpsRequest(url, {
        method: 'POST', agent: false, signal, timeout: timeoutMs,
        family: address.family, servername: url.hostname,
        rejectUnauthorized: true, autoSelectFamily: false,
        lookup: (_hostname, options, callback) => callback(null,
          options.all ? [address] : address.address, ...(options.all ? [] : [address.family])),
        headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, response => {
        const status = httpStatus(response.statusCode);
        if (!status) { response.destroy(); fail(new CallbackFailure('response_invalid')); return; }
        if (!readResponse || status < 200 || status >= 300) {
          response.destroy(); done({ status }); return;
        }
        let size = 0; const chunks = [];
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 4096) { response.destroy(); fail(new CallbackFailure('response_invalid')); }
          else chunks.push(chunk);
        });
        response.once('error', fail);
        response.once('end', () => done({ status, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.once('socket', socket => {
        socket.once('connect', () => { connected = true; clearTimeout(connectTimer); });
        socket.once('secureConnect', () => { tlsReady = true; });
      });
      req.once('error', fail);
      req.once('timeout', () => req.destroy(new CallbackFailure(connected ? 'request_timeout' : 'connect_timeout', !connected)));
      connectTimer = setTimeout(() => req.destroy(new CallbackFailure('connect_timeout', true)), connectTimeoutMs);
      req.end(body);
    } catch (error) { fail(error); }
  });
}

function binding(registration) {
  if (!object(registration)) throw new ApiError(403, 'registration_inactive', 'The bridge registration is not active');
  const result = {};
  for (const field of ['site_id', 'owner_subject', 'key_id']) result[field] = boundedText(registration[field], field);
  if (registration.queue !== 'website-chat' || !Number.isSafeInteger(registration.expires_at)) throw invalid('Invalid registration binding');
  return Object.freeze({ ...result, queue: 'website-chat', expires_at: registration.expires_at });
}

export class ManagedBridgeEvents {
  constructor(store, {
    enabled = false, allowedCallbackOrigins = [], registrationActive = () => false,
    resolver = hostname => lookup(hostname, { all: true, verbatim: true }),
    transport = pinnedHttpsTransport, now = () => store.now(),
  } = {}) {
    this.store = store; this.db = store.db; this.now = now;
    this.enabled = enabled === true; this.closed = false;
    this.registrationActive = registrationActive; this.resolver = resolver; this.transport = transport;
    this.allowedOrigins = new Set(); this.inFlight = new Set(); this.savepoint = 0;
    for (const origin of allowedCallbackOrigins) {
      let parsed;
      try { parsed = new URL(origin); } catch { throw new Error('Invalid callback origin configuration'); }
      if (parsed.origin !== origin) throw new Error('Callback allowlist entries must be exact origins');
      validateCallbackUrl(`${origin}/`, new Set([origin]));
      this.allowedOrigins.add(origin);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS managed_bridge_subscriptions (
        id TEXT PRIMARY KEY, site_id TEXT NOT NULL, owner_subject TEXT NOT NULL, key_id TEXT NOT NULL,
        key_expires_at INTEGER NOT NULL, callback_url TEXT NOT NULL, secret TEXT, old_secret TEXT,
        old_secret_until INTEGER, expires_at INTEGER NOT NULL, verified_at INTEGER,
        status TEXT NOT NULL CHECK(status IN ('active','inactive','deleted')),
        version INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS managed_bridge_subscriptions_scope
        ON managed_bridge_subscriptions(site_id, owner_subject, key_id, status, expires_at);
      CREATE TABLE IF NOT EXISTS managed_bridge_event_outbox (
        event_id TEXT PRIMARY KEY, site_id TEXT NOT NULL, owner_subject TEXT NOT NULL, key_id TEXT NOT NULL,
        task_id TEXT NOT NULL, generation INTEGER NOT NULL, occurred_at INTEGER NOT NULL, body TEXT NOT NULL,
        UNIQUE(site_id, owner_subject, key_id, task_id, generation)
      );
      CREATE INDEX IF NOT EXISTS managed_bridge_event_expiry ON managed_bridge_event_outbox(occurred_at);
      CREATE TABLE IF NOT EXISTS managed_bridge_event_deliveries (
        event_id TEXT NOT NULL REFERENCES managed_bridge_event_outbox(event_id) ON DELETE CASCADE,
        subscription_id TEXT NOT NULL REFERENCES managed_bridge_subscriptions(id),
        status TEXT NOT NULL CHECK(status IN ('pending','delivering','delivered','dead','cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
        lease_token TEXT, lease_until INTEGER, last_code TEXT, delivered_at INTEGER,
        PRIMARY KEY(event_id, subscription_id)
      );
      CREATE INDEX IF NOT EXISTS managed_bridge_delivery_ready
        ON managed_bridge_event_deliveries(status, next_attempt_at, lease_until);
    `);
  }

  atomic(fn) {
    const name = `managed_events_${++this.savepoint}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try { const result = fn(); this.db.exec(`RELEASE ${name}`); return result; }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
  }

  active(registration) {
    return this.enabled && registration.expires_at > this.now() && this.registrationActive(registration, this.now()) === true;
  }
  requireActive(registration) {
    if (!this.enabled || this.closed) throw unavailable();
    if (!this.active(registration)) throw new ApiError(403, 'registration_inactive', 'The bridge registration is not active');
  }

  subscriptionInput(registration, body, upsert) {
    this.requireActive(registration);
    exactFields(body, upsert ? ['name', 'arguments', 'delivery', 'ttlMs', 'cursor'] : ['name', 'arguments', 'delivery']);
    exactFields(body.arguments, ['queue']);
    exactFields(body.delivery, upsert ? ['mode', 'url', 'secret'] : ['mode', 'url']);
    if (body.name !== 'task.created' || body.arguments.queue !== 'website-chat' || body.delivery.mode !== 'webhook') throw invalid('Unsupported event, queue or delivery mode');
    if (upsert && body.cursor !== undefined && body.cursor !== null) throw invalid('This event does not support replay cursors');
    const url = validateCallbackUrl(body.delivery.url, this.allowedOrigins).href;
    const id = `sub_${digest(JSON.stringify([registration.site_id, registration.owner_subject, registration.key_id, url, body.name, { queue: 'website-chat' }]))}`;
    if (!upsert) return { id, url };
    signingKey(body.delivery.secret);
    if (body.ttlMs !== undefined && body.ttlMs !== null && (!Number.isSafeInteger(body.ttlMs) || body.ttlMs <= 0)) throw invalid('ttlMs must be a positive integer or null');
    const ttl = Math.min(EVENT_LIMITS.maxLeaseMs, Math.max(EVENT_LIMITS.minimumLeaseMs, body.ttlMs ?? EVENT_LIMITS.maxLeaseMs));
    return { id, url, secret: body.delivery.secret, expiresAt: Math.min(this.now() + ttl, registration.expires_at) };
  }

  rowRegistration(row) {
    return { site_id: row.site_id, owner_subject: row.owner_subject, key_id: row.key_id, expires_at: row.key_expires_at, queue: 'website-chat' };
  }
  rowActive(row) {
    return Boolean(row && row.status === 'active' && row.secret && row.expires_at > this.now() && this.active(this.rowRegistration(row)));
  }

  status(rawRegistration) {
    const empty = { subscription_active: false, last_delivery_at: null, delivery_pending: 0, delivery_dead: 0 };
    if (!rawRegistration || !this.enabled || this.closed) return empty;
    const registration = binding(rawRegistration);
    if (!this.active(registration)) return empty;
    const scope = [registration.site_id, registration.owner_subject, registration.key_id];
    const subscriptions = this.db.prepare('SELECT * FROM managed_bridge_subscriptions WHERE site_id = ? AND owner_subject = ? AND key_id = ?').all(...scope);
    const counts = this.db.prepare(`SELECT MAX(d.delivered_at) AS last_delivery_at,
      SUM(CASE WHEN d.status IN ('pending','delivering') THEN 1 ELSE 0 END) AS delivery_pending,
      SUM(CASE WHEN d.status = 'dead' THEN 1 ELSE 0 END) AS delivery_dead
      FROM managed_bridge_event_deliveries d JOIN managed_bridge_event_outbox e ON e.event_id = d.event_id
      WHERE e.site_id = ? AND e.owner_subject = ? AND e.key_id = ?`).get(...scope);
    return { subscription_active: subscriptions.some(row => this.rowActive(row)),
      last_delivery_at: counts.last_delivery_at ?? null, delivery_pending: counts.delivery_pending || 0, delivery_dead: counts.delivery_dead || 0 };
  }

  cleanup() {
    return this.atomic(() => this.cleanupInsideTransaction());
  }

  cleanupInsideTransaction() {
    if (!this.db.isTransaction) throw new Error('Event cleanup requires a transaction');
    const at = this.now();
    this.db.prepare('UPDATE managed_bridge_subscriptions SET old_secret = NULL, old_secret_until = NULL WHERE old_secret_until <= ?').run(at);
    for (const row of this.db.prepare("SELECT * FROM managed_bridge_subscriptions WHERE status = 'active'").all()) {
      if (!this.rowActive(row)) {
        this.db.prepare("UPDATE managed_bridge_subscriptions SET status = 'inactive', secret = NULL, old_secret = NULL, old_secret_until = NULL WHERE id = ?").run(row.id);
        this.db.prepare("UPDATE managed_bridge_event_deliveries SET status = 'cancelled', lease_token = NULL, lease_until = NULL, last_code = 'subscription_inactive' WHERE subscription_id = ? AND status IN ('pending','delivering')").run(row.id);
      }
    }
    this.db.prepare("UPDATE managed_bridge_event_deliveries SET status = 'dead', lease_token = NULL, lease_until = NULL, last_code = 'retry_limit' WHERE status IN ('pending','delivering') AND (attempts >= ? AND (lease_until IS NULL OR lease_until <= ?) OR event_id IN (SELECT event_id FROM managed_bridge_event_outbox WHERE occurred_at <= ?))").run(EVENT_LIMITS.maxAttempts, at, at - EVENT_LIMITS.maxAgeMs);
    // Event data is a bounded transient transport record; task history remains in
    // its own table. No application callback contents are retained in this module.
    this.db.prepare("DELETE FROM managed_bridge_event_outbox WHERE occurred_at <= ? AND NOT EXISTS (SELECT 1 FROM managed_bridge_event_deliveries d WHERE d.event_id = managed_bridge_event_outbox.event_id AND d.status IN ('pending','delivering'))").run(at - EVENT_LIMITS.maxAgeMs * 2);
  }

  haltRevoked() {
    for (const operation of this.inFlight) if (!operation.valid()) operation.controller.abort();
  }
  close() {
    this.closed = true;
    for (const operation of this.inFlight) operation.controller.abort();
  }

  async callback({ registration, subscriptionId, url, secret, oldSecret, eventId, body, expiresAt, valid, readResponse = false }) {
    if (this.inFlight.size >= EVENT_LIMITS.inFlight) throw new ApiError(429, 'callback_capacity', 'Callback concurrency limit reached');
    if (typeof body !== 'string' || Buffer.byteLength(body) > 262144) throw invalid('Event exceeds the callback payload limit');
    const controller = new AbortController();
    const allowed = () => !this.closed && this.active(registration) && this.now() < expiresAt && valid();
    const operation = { controller, valid: allowed }; this.inFlight.add(operation);
    const abort = reason => controller.abort(new CallbackFailure(reason));
    const deadline = performance.now() + EVENT_LIMITS.requestTimeoutMs;
    const remaining = () => Math.max(0, deadline - performance.now());
    const check = () => {
      if (controller.signal.aborted) throw cancelled(controller.signal);
      if (!allowed()) throw new CallbackFailure('cancelled');
      if (remaining() <= 0) throw new CallbackFailure('request_timeout');
    };
    const timeout = setTimeout(() => abort('request_timeout'), EVENT_LIMITS.requestTimeoutMs);
    const expiry = setTimeout(() => abort('cancelled'), Math.max(1, Math.min(2147483647, expiresAt - this.now())));
    const revocations = setInterval(() => { if (!allowed()) abort('cancelled'); }, 50);
    try {
      check();
      const target = validateCallbackUrl(url, this.allowedOrigins);
      let answers;
      try {
        answers = await withDeadline(Promise.resolve().then(() => this.resolver(target.hostname)), Math.min(EVENT_LIMITS.dnsTimeoutMs, remaining()), controller.signal, 'dns_timeout');
      } catch (error) {
        if (error instanceof CallbackFailure) throw error;
        throw new CallbackFailure('dns_error', false, error?.code, 'dns');
      }
      if (!Array.isArray(answers) || !answers.length || answers.length > 64 || answers.some(answer => !object(answer)
        || ![4, 6].includes(answer.family) || isIP(answer.address) !== answer.family || !isPublicAddress(answer.address))) throw blockedDestination();
      // Snapshot and deduplicate only after validating ALL same-call answers.
      // No re-resolution, alternate resolver, caller IP override, or private subset.
      const addresses = [...new Map(answers.map(({ address, family }) => [`${family}:${address}`, Object.freeze({ address, family })])).values()];
      check();
      const headers = standardWebhookHeaders(secret, eventId, body, this.now());
      if (oldSecret) headers['webhook-signature'] += ` ${standardWebhookHeaders(oldSecret, eventId, body, Number(headers['webhook-timestamp']) * 1000)['webhook-signature']}`;
      headers['X-MCP-Subscription-Id'] = subscriptionId;
      headers['Content-Type'] = 'application/json';
      for (const [index, address] of addresses.entries()) {
        // Recheck revocation, expiry and the shared deadline before every socket.
        check();
        const attemptController = new AbortController();
        const cancelAttempt = () => attemptController.abort(controller.signal.reason);
        controller.signal.addEventListener('abort', cancelAttempt, { once: true });
        try {
          const timeoutMs = Math.max(1, Math.floor(remaining()));
          const connectTimeoutMs = Math.min(EVENT_LIMITS.connectTimeoutMs, Math.max(1, Math.floor(timeoutMs / (addresses.length - index))));
          const result = await withDeadline(Promise.resolve(this.transport({ url: target, address, headers, body,
            signal: attemptController.signal, timeoutMs, connectTimeoutMs, readResponse })), timeoutMs, controller.signal);
          check();
          return result;
        } catch (error) {
          check();
          if (!(error instanceof CallbackFailure && error.retryableConnection) || index === addresses.length - 1) {
            throw error instanceof CallbackFailure ? error : new CallbackFailure('transport_error');
          }
        } finally {
          controller.signal.removeEventListener('abort', cancelAttempt);
          attemptController.abort();
        }
      }
    } finally {
      clearTimeout(timeout); clearTimeout(expiry); clearInterval(revocations);
      controller.abort(); this.inFlight.delete(operation);
    }
  }

  async upsert(rawRegistration, body) {
    if (this.db.isTransaction) throw new Error('Subscription verification cannot run inside a task transaction');
    const registration = binding(rawRegistration), input = this.subscriptionInput(registration, body, true);
    const pending = this.atomic(() => {
      this.requireActive(registration); this.cleanup();
      const prior = this.db.prepare('SELECT * FROM managed_bridge_subscriptions WHERE id = ?').get(input.id);
      if (!prior && this.db.prepare('SELECT COUNT(*) AS n FROM managed_bridge_subscriptions').get().n >= EVENT_LIMITS.subscriptions) throw new ApiError(429, 'subscription_capacity', 'Subscription capacity reached');
      const version = (prior?.version || 0) + 1;
      this.db.prepare(`INSERT INTO managed_bridge_subscriptions(id, site_id, owner_subject, key_id, key_expires_at, callback_url, expires_at, status, version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'inactive', ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`).run(
        input.id, registration.site_id, registration.owner_subject, registration.key_id, registration.expires_at, input.url, input.expiresAt, version, this.now());
      return { version, prior, cached: this.rowActive(prior) && prior.secret === input.secret && prior.verified_at + EVENT_LIMITS.verificationCacheMs > this.now() };
    });
    const current = () => this.db.prepare('SELECT version, status FROM managed_bridge_subscriptions WHERE id = ?').get(input.id)?.version === pending.version;
    if (!pending.cached) {
      const challenge = randomUUID(), eventId = `verification_${randomUUID()}`;
      let response;
      try {
        response = await this.callback({ registration, subscriptionId: input.id, url: input.url, secret: input.secret,
          eventId, body: JSON.stringify({ type: 'verification', challenge }), expiresAt: input.expiresAt, valid: current, readResponse: true });
      } catch (error) {
        if (error.code === 'callback_destination_denied' || error.code === 'callback_origin_not_allowed') throw error;
        throw verificationFailed(failureReason(error), error);
      }
      const status = httpStatus(response.status);
      if (!(status >= 200 && status < 300)) {
        const error = verificationFailed('http_error');
        error.callback_http_class = status >= 400 && status < 500 ? 'http_4xx' : status >= 500 ? 'http_5xx' : 'other';
        throw error;
      }
      let echoed;
      try { echoed = JSON.parse(response.body)?.challenge; } catch { /* invalid response */ }
      const expected = Buffer.from(challenge), received = typeof echoed === 'string' ? Buffer.from(echoed) : Buffer.alloc(0);
      if (received.length !== expected.length || !timingSafeEqual(expected, received)) throw verificationFailed('challenge_mismatch');
    }
    const result = this.atomic(() => {
      this.requireActive(registration);
      if (!current() || input.expiresAt <= this.now()) throw new ApiError(409, 'subscription_superseded', 'The subscription changed or expired during verification');
      const oldSecret = this.rowActive(pending.prior) && pending.prior.secret !== input.secret ? pending.prior.secret : pending.prior?.old_secret;
      const oldUntil = oldSecret && oldSecret !== input.secret
        ? Math.min(input.expiresAt, pending.prior.secret !== input.secret ? this.now() + EVENT_LIMITS.rotationMs : pending.prior.old_secret_until || 0) : null;
      this.db.prepare(`UPDATE managed_bridge_subscriptions SET secret = ?, old_secret = ?, old_secret_until = ?,
        expires_at = ?, verified_at = ?, key_expires_at = ?, status = 'active', updated_at = ? WHERE id = ? AND version = ?`).run(
        input.secret, oldUntil > this.now() ? oldSecret : null, oldUntil > this.now() ? oldUntil : null,
        input.expiresAt, pending.cached ? pending.prior.verified_at : this.now(), registration.expires_at, this.now(), input.id, pending.version);
      return { id: input.id, refreshBefore: new Date(input.expiresAt).toISOString(), cursor: null, truncated: false };
    });
    this.haltRevoked();
    return result;
  }

  delete(rawRegistration, body) {
    const registration = binding(rawRegistration), input = this.subscriptionInput(registration, body, false);
    this.atomic(() => {
      this.requireActive(registration);
      this.db.prepare("UPDATE managed_bridge_subscriptions SET status = 'deleted', version = version + 1, secret = NULL, old_secret = NULL, old_secret_until = NULL, updated_at = ? WHERE id = ?").run(this.now(), input.id);
      this.db.prepare("UPDATE managed_bridge_event_deliveries SET status = 'cancelled', lease_token = NULL, lease_until = NULL, last_code = 'unsubscribed' WHERE subscription_id = ? AND status IN ('pending','delivering')").run(input.id);
    });
    this.haltRevoked(); return {};
  }

  // Call only in the transaction inserting a new executable website-chat task
  // or durably advancing that task's readiness generation.
  // Replies have no entry point here and therefore cannot generate a feedback loop.
  enqueueTaskCreated(rawRegistration, input) {
    if (!this.enabled || this.closed) return null;
    if (!this.db.isTransaction) throw new Error('enqueueTaskCreated requires the task insertion transaction');
    const registration = binding(rawRegistration); this.requireActive(registration);
    exactFields(input, ['task_id', 'queue', 'created_at', 'generation']);
    const generation = input.generation ?? 0;
    if (input.queue !== 'website-chat' || typeof input.task_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.task_id)
      || !Number.isSafeInteger(input.created_at) || input.created_at < 0 || input.created_at > this.now()
      || !Number.isSafeInteger(generation) || generation < 0) throw invalid('Invalid task-created event');
    const eventId = `evt_${digest(JSON.stringify([registration.site_id, registration.owner_subject, registration.key_id, input.task_id, generation]))}`;
    const previous = this.db.prepare('SELECT occurred_at FROM managed_bridge_event_outbox WHERE event_id = ?').get(eventId);
    if (previous) return eventId;
    this.cleanup();
    if (this.db.prepare('SELECT COUNT(*) AS n FROM managed_bridge_event_outbox').get().n >= EVENT_LIMITS.events) throw new ApiError(429, 'event_capacity', 'Event capacity reached');
    const body = JSON.stringify({ eventId, name: 'task.created', timestamp: new Date(input.created_at).toISOString(), data: { task_id: input.task_id, queue: 'website-chat' }, cursor: null });
    this.db.prepare('INSERT INTO managed_bridge_event_outbox(event_id, site_id, owner_subject, key_id, task_id, generation, occurred_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(eventId, registration.site_id, registration.owner_subject, registration.key_id, input.task_id, generation, input.created_at, body);
    const subscribers = this.db.prepare("SELECT * FROM managed_bridge_subscriptions WHERE site_id = ? AND owner_subject = ? AND key_id = ? AND status = 'active' AND expires_at > ?").all(registration.site_id, registration.owner_subject, registration.key_id, this.now()).filter(row => this.rowActive(row));
    if (this.db.prepare('SELECT COUNT(*) AS n FROM managed_bridge_event_deliveries').get().n + subscribers.length > EVENT_LIMITS.deliveries) throw new ApiError(429, 'event_capacity', 'Event delivery capacity reached');
    for (const row of subscribers) this.db.prepare("INSERT INTO managed_bridge_event_deliveries(event_id, subscription_id, status, next_attempt_at) VALUES (?, ?, 'pending', ?)").run(eventId, row.id, this.now());
    return eventId;
  }

  enqueueTaskReady(registration, input) { return this.enqueueTaskCreated(registration, input); }

  claim() {
    if (!this.enabled || this.closed) return null;
    return this.atomic(() => {
      this.cleanup();
      const row = this.db.prepare(`SELECT d.*, e.body, e.occurred_at FROM managed_bridge_event_deliveries d
        JOIN managed_bridge_event_outbox e ON e.event_id = d.event_id
        WHERE (d.status = 'pending' AND d.next_attempt_at <= ?) OR (d.status = 'delivering' AND d.lease_until <= ?)
        ORDER BY d.next_attempt_at, d.event_id, d.subscription_id LIMIT 1`).get(this.now(), this.now());
      if (!row) return null;
      const subscription = this.db.prepare('SELECT * FROM managed_bridge_subscriptions WHERE id = ?').get(row.subscription_id);
      if (!this.rowActive(subscription)) return null;
      const leaseToken = randomUUID(), leaseUntil = Math.min(this.now() + EVENT_LIMITS.deliveryLeaseMs, subscription.expires_at, subscription.key_expires_at);
      this.db.prepare("UPDATE managed_bridge_event_deliveries SET status = 'delivering', attempts = attempts + 1, lease_token = ?, lease_until = ? WHERE event_id = ? AND subscription_id = ?").run(leaseToken, leaseUntil, row.event_id, row.subscription_id);
      return { ...row, attempts: row.attempts + 1, subscription, leaseToken, leaseUntil };
    });
  }

  leaseActive(claim) {
    const current = this.db.prepare('SELECT * FROM managed_bridge_subscriptions WHERE id = ?').get(claim.subscription_id);
    return this.rowActive(current) && current.version === claim.subscription.version && Boolean(this.db.prepare("SELECT 1 FROM managed_bridge_event_deliveries WHERE event_id = ? AND subscription_id = ? AND status = 'delivering' AND lease_token = ? AND lease_until > ?").get(claim.event_id, claim.subscription_id, claim.leaseToken, this.now()));
  }

  async dispatchOne() {
    if (this.db.isTransaction) throw new Error('Callback dispatch cannot run inside a task transaction');
    if (this.inFlight.size >= EVENT_LIMITS.inFlight) return null;
    const claim = this.claim();
    if (!claim) return null;
    const subscription = claim.subscription;
    let status = null, code = 'callback_transport_error';
    try {
      const result = await this.callback({ registration: this.rowRegistration(subscription), subscriptionId: subscription.id,
        url: subscription.callback_url, secret: subscription.secret,
        oldSecret: subscription.old_secret_until > this.now() ? subscription.old_secret : null,
        eventId: claim.event_id, body: claim.body, expiresAt: claim.leaseUntil, valid: () => this.leaseActive(claim) });
      status = httpStatus(result.status);
      code = status ? `http_${status}` : 'callback_response_invalid';
    } catch (error) {
      code = `callback_${failureReason(error)}`;
      if (['callback_destination_denied', 'callback_origin_not_allowed'].includes(error.code)) code = 'callback_destination_denied';
      // No URL, body, secret, headers, provider response or raw exception in logs.
    }
    return this.atomic(() => {
      const current = this.db.prepare('SELECT * FROM managed_bridge_subscriptions WHERE id = ?').get(subscription.id);
      const lease = this.db.prepare("SELECT 1 FROM managed_bridge_event_deliveries WHERE event_id = ? AND subscription_id = ? AND status = 'delivering' AND lease_token = ?").get(claim.event_id, subscription.id, claim.leaseToken);
      if (!lease) return { eventId: claim.event_id, status: 'superseded' };
      let outcome = 'dead';
      const ageExpired = claim.occurred_at + EVENT_LIMITS.maxAgeMs <= this.now();
      const transient = status === null || status === 408 || status === 425 || status === 429 || status >= 500
        || (status >= 200 && status < 300 && claim.leaseUntil <= this.now());
      if (!this.rowActive(current)) outcome = 'cancelled';
      else if (current.version !== subscription.version) outcome = 'pending';
      else if (status >= 200 && status < 300 && this.leaseActive(claim)) outcome = 'delivered';
      else if (!ageExpired && transient && code !== 'callback_destination_denied' && claim.attempts < EVENT_LIMITS.maxAttempts) outcome = 'pending';
      const delay = Math.min(3600000, 1000 * 2 ** Math.min(20, claim.attempts - 1));
      const next = this.now() + delay;
      if (outcome === 'pending' && (claim.attempts >= EVENT_LIMITS.maxAttempts || ageExpired || next >= Math.min(current.expires_at, current.key_expires_at))) outcome = 'dead';
      this.db.prepare('UPDATE managed_bridge_event_deliveries SET status = ?, next_attempt_at = ?, lease_token = NULL, lease_until = NULL, last_code = ?, delivered_at = ? WHERE event_id = ? AND subscription_id = ? AND lease_token = ?').run(outcome, next, code, outcome === 'delivered' ? this.now() : null, claim.event_id, subscription.id, claim.leaseToken);
      return { eventId: claim.event_id, status: outcome, attempts: claim.attempts };
    });
  }
}
