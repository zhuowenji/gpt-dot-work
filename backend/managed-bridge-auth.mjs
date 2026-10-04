import { createHash, createPublicKey, verify } from 'node:crypto';
import { ApiError } from './store.mjs';

export const BRIDGE_PREFIX = '/api/managed-bridge/v1/';
export const BRIDGE_SITE_ID = 'appgprj_6ac240cb5e1481918cc0ad4edd55286a';
export const BRIDGE_PATHS = Object.freeze(['status', 'tasks/list', 'tasks/claim', 'tasks/context', 'tasks/reply', 'tasks/release', 'subscriptions/upsert', 'subscriptions/delete'].map(path => BRIDGE_PREFIX + path));
export const BRIDGE_LIMITS = Object.freeze({ bodyBytes: 262144, clockSkewMs: 60000, nonceTtlMs: 180000, nonces: 20000, keyTtlMs: 30 * 86400000, operations: 100000, concurrency: 10, leaseSeconds: 300 });
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
export function exactFields(body, allowed) {
  if (!object(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'invalid_input', `Only ${allowed.join(', ') || 'an empty object'} accepted`);
}

// This is PUBLIC operator configuration, never a private signing key or OAuth
// implementation. Empty configuration disables every bridge endpoint.
export function parseBridgeRegistration(input, now = Date.now()) {
  if (!input) return null;
  let registration;
  try { registration = typeof input === 'string' ? JSON.parse(input) : structuredClone(input); }
  catch { throw new Error('GDW_MANAGED_BRIDGE_REGISTRATION must be public registration JSON'); }
  const invalid = message => { throw new Error(`GDW_MANAGED_BRIDGE_REGISTRATION: ${message}`); };
  if (!object(registration) || Object.keys(registration).some(key => !['key_id', 'public_jwk', 'site_id', 'owner_subject', 'queue', 'expires_at', 'scopes'].includes(key))) invalid('unexpected registration field');
  const jwk = registration.public_jwk;
  if (!object(jwk) || Object.keys(jwk).some(key => !['kty', 'crv', 'x', 'y'].includes(key)) || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x || '') || !/^[A-Za-z0-9_-]{43}$/.test(jwk.y || '')) invalid('only a public P-256 JWK is accepted');
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(registration.key_id || '') || registration.site_id !== BRIDGE_SITE_ID || !/^[a-f0-9]{64}$/.test(registration.owner_subject || '') || registration.queue !== 'website-chat') invalid('invalid key, Site, owner or queue binding');
  if (!Number.isSafeInteger(registration.expires_at) || registration.expires_at > now + BRIDGE_LIMITS.keyTtlMs) invalid('expiry must be Unix milliseconds and no more than 30 days ahead');
  if (!Array.isArray(registration.scopes) || !registration.scopes.length || registration.scopes.length > BRIDGE_PATHS.length || new Set(registration.scopes).size !== registration.scopes.length || registration.scopes.some(path => !BRIDGE_PATHS.includes(path))) invalid('scopes must contain exact supported API paths');
  let key;
  try { key = createPublicKey({ key: jwk, format: 'jwk' }); }
  catch { invalid('invalid public JWK'); }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'prime256v1') invalid('only P-256 keys are accepted');
  return Object.freeze(registration);
}
export function signingInput(path, timestamp, nonce, keyId, bytes) {
  return ['GDW-BRIDGE-V1', 'POST', path, timestamp, nonce, keyId, sha256(bytes)].join('\n');
}
export class ManagedBridgeAuth {
  constructor(store, registration) {
    this.store = store; this.db = store.db;
    this.registration = parseBridgeRegistration(registration, store.now());
    this.key = this.registration && createPublicKey({ key: this.registration.public_jwk, format: 'jwk' });
    this.db.exec(`CREATE TABLE IF NOT EXISTS managed_bridge_revocations (key_id TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_bridge_nonces (
      key_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(key_id, nonce)
    ); CREATE INDEX IF NOT EXISTS managed_bridge_nonce_expiry ON managed_bridge_nonces(expires_at);`);
  }
  active() { return Boolean(this.registration && this.registration.expires_at > this.store.now() && !this.db.prepare('SELECT 1 FROM managed_bridge_revocations WHERE key_id = ?').get(this.registration.key_id)); }
  // Operator-only local primitive, deliberately no HTTP credential-management API.
  revoke(keyId) {
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(keyId || '')) throw new Error('Invalid public key ID');
    this.db.prepare('INSERT INTO managed_bridge_revocations(key_id, revoked_at) VALUES (?, ?) ON CONFLICT(key_id) DO NOTHING').run(keyId, this.store.now());
    this.onRevoke?.();
  }
  requireActive() {
    if (!this.registration) fail(503, 'bridge_disabled', 'Managed execution bridge is not configured');
    if (this.db.prepare('SELECT 1 FROM managed_bridge_revocations WHERE key_id = ?').get(this.registration.key_id)) fail(401, 'key_revoked', 'Managed execution bridge registration was revoked');
    if (!this.active()) fail(401, 'key_expired', 'Managed execution bridge registration has expired');
  }
  async authenticate(req, url) {
    this.requireActive();
    // A machine-only route has no browser cookie/bearer fallback and no CORS.
    if (req.headers.origin || req.headers.cookie || req.headers.authorization || req.headers['sec-fetch-site']) fail(403, 'machine_request_required', 'Use the dedicated signed server-to-server request');
    if (req.method !== 'POST' || req.url !== url.pathname || url.search || !BRIDGE_PATHS.includes(url.pathname)) fail(404, 'not_found', 'Endpoint not found');
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '') || req.headers['content-encoding']) fail(415, 'json_required', 'Send unencoded application/json');
    if (Number(req.headers['content-length'] || 0) > BRIDGE_LIMITS.bodyBytes) fail(413, 'body_too_large', 'The request body is too large');
    const names = ['x-gdw-bridge-key-id', 'x-gdw-bridge-timestamp', 'x-gdw-bridge-nonce', 'x-gdw-bridge-signature'];
    for (const name of names) {
      if (req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name).length !== 1) fail(401, 'invalid_signature', 'Exactly one of each signature header is required');
    }
    const [keyId, timestamp, nonce, signature] = names.map(name => req.headers[name]);
    if (keyId !== this.registration.key_id || !/^\d{10,11}$/.test(timestamp || '') || !/^[A-Za-z0-9_-]{22}$/.test(nonce || '') || !/^[A-Za-z0-9_-]{86}$/.test(signature || '')) fail(401, 'invalid_signature', 'Invalid signed request');
    const at = Number(timestamp) * 1000;
    if (!Number.isSafeInteger(at) || Math.abs(this.store.now() - at) > BRIDGE_LIMITS.clockSkewMs) fail(401, 'signature_expired', 'Signed request timestamp is outside the accepted window');
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BRIDGE_LIMITS.bodyBytes) fail(413, 'body_too_large', 'The request body is too large');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (Buffer.from(nonce, 'base64url').toString('base64url') !== nonce || Buffer.from(signature, 'base64url').toString('base64url') !== signature || !verify('sha256', Buffer.from(signingInput(url.pathname, timestamp, nonce, keyId, bytes)), { key: this.key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))) fail(401, 'invalid_signature', 'Invalid signed request');
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail(400, 'invalid_json', 'Request body is not valid JSON'); }
    if (!object(body) || body.site_id !== this.registration.site_id || body.owner_subject !== this.registration.owner_subject || !this.registration.scopes.includes(url.pathname)) fail(403, 'scope_denied', 'Request identity or operation is outside the registered scope');
    this.store.transaction(() => {
      this.requireActive();
      // Recheck time after asynchronous body collection, before consuming nonce.
      if (Math.abs(this.store.now() - at) > BRIDGE_LIMITS.clockSkewMs) fail(401, 'signature_expired', 'Signed request timestamp is outside the accepted window');
      this.db.prepare('DELETE FROM managed_bridge_nonces WHERE expires_at <= ?').run(this.store.now());
      if (this.db.prepare('SELECT 1 FROM managed_bridge_nonces WHERE key_id = ? AND nonce = ?').get(keyId, nonce)) fail(409, 'replay_rejected', 'This signed request nonce was already used; re-sign retries with a fresh nonce');
      if (this.db.prepare('SELECT COUNT(*) AS n FROM managed_bridge_nonces').get().n >= BRIDGE_LIMITS.nonces) fail(429, 'bridge_capacity', 'Signed request capacity reached');
      this.db.prepare('INSERT INTO managed_bridge_nonces(key_id, nonce, expires_at) VALUES (?, ?, ?)').run(keyId, nonce, this.store.now() + BRIDGE_LIMITS.nonceTtlMs);
    });
    const { site_id, owner_subject, ...operation } = body;
    return { registration: this.registration, operation };
  }
}
