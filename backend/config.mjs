import { homedir } from 'node:os';
import { join, isAbsolute, resolve, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { parsePasswordHash, parseTrustedProxies } from './auth.mjs';
import { parseBridgeRegistration } from './managed-bridge-auth.mjs';

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
function integer(env, name, fallback, minimum, maximum) {
  const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}
function exactOrigin(value, name) {
  if (!value) return;
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${name} must be an exact http(s) origin`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value) throw new Error(`${name} must be an exact http(s) origin without a trailing slash`);
}
function resolvedPath(path) {
  let parent = path;
  const missing = [];
  while (!existsSync(parent)) { missing.unshift(basename(parent)); parent = dirname(parent); }
  return resolve(realpathSync(parent), ...missing);
}

export function readConfig(env = process.env, { requireApiToken = true } = {}) {
  const production = env.NODE_ENV === 'production';
  const trustedProxyIPs = parseTrustedProxies(env.WORKSPACE_TRUST_PROXY || '');
  const releaseId = env.WORKSPACE_RELEASE || '';
  if (releaseId && !/^[A-Za-z0-9._-]{1,64}$/.test(releaseId)) throw new Error('WORKSPACE_RELEASE must contain 1–64 safe release identifier characters');
  const apiToken = env.WORKSPACE_API_TOKEN || '';
  const approvalToken = env.WORKSPACE_APPROVAL_TOKEN || '';
  const ownerPasswordHash = env.WORKSPACE_OWNER_PASSWORD_HASH || '';
  if (ownerPasswordHash) parsePasswordHash(ownerPasswordHash);
  if (apiToken && apiToken.length < 32) throw new Error('WORKSPACE_API_TOKEN must contain at least 32 characters');
  if (requireApiToken && !ownerPasswordHash && apiToken.length < 32) throw new Error('WORKSPACE_API_TOKEN or WORKSPACE_OWNER_PASSWORD_HASH is required');
  if (approvalToken && (approvalToken.length < 32 || approvalToken === apiToken)) throw new Error('WORKSPACE_APPROVAL_TOKEN must be a distinct secret of at least 32 characters');
  const runtime = env.WORKSPACE_RUNTIME || 'disabled';
  if (!['disabled', 'demo'].includes(runtime)) throw new Error('WORKSPACE_RUNTIME must be disabled or demo');
  const stateHome = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const dbPath = env.WORKSPACE_DB_PATH || join(stateHome, 'gpt-dot-work', 'tasks.sqlite');
  if (!isAbsolute(dbPath)) throw new Error('WORKSPACE_DB_PATH must be absolute');
  const resolvedDb = resolvedPath(dbPath);
  if (resolvedDb === repository || resolvedDb.startsWith(repository + sep)) throw new Error('WORKSPACE_DB_PATH must be outside the repository');
  const allowedOrigin = env.WORKSPACE_ALLOWED_ORIGIN || '';
  const publicOrigin = env.WORKSPACE_PUBLIC_ORIGIN || '';
  exactOrigin(allowedOrigin, 'WORKSPACE_ALLOWED_ORIGIN');
  exactOrigin(publicOrigin, 'WORKSPACE_PUBLIC_ORIGIN');
  if (ownerPasswordHash && !publicOrigin) throw new Error('WORKSPACE_PUBLIC_ORIGIN is required for owner login');
  if (ownerPasswordHash && allowedOrigin && allowedOrigin !== publicOrigin) throw new Error('Browser owner access is same-origin only; WORKSPACE_ALLOWED_ORIGIN must be empty or match WORKSPACE_PUBLIC_ORIGIN');
  if (publicOrigin && !publicOrigin.startsWith('https:') && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(publicOrigin).hostname)) throw new Error('Owner login requires HTTPS except on loopback development origins');
  const staticDir = env.WORKSPACE_STATIC_DIR || join(repository, 'dist');
  if (!isAbsolute(staticDir)) throw new Error('WORKSPACE_STATIC_DIR must be absolute');
  const resolvedStatic = resolvedPath(staticDir);
  if (resolvedDb === resolvedStatic || resolvedDb.startsWith(resolvedStatic + sep)) throw new Error('WORKSPACE_DB_PATH must be outside the static directory');
  const host = env.WORKSPACE_HOST || '127.0.0.1';
  if (production && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Production WORKSPACE_HOST must be loopback-only behind an HTTPS reverse proxy');
  // Serving a broader tree could expose source credentials/config. Static delivery
  // still uses an explicit route/extension allowlist and rejects symlinks outside it.
  if (production) {
    if (!ownerPasswordHash) throw new Error('Production requires WORKSPACE_OWNER_PASSWORD_HASH');
    if (!publicOrigin.startsWith('https:')) throw new Error('Production requires an HTTPS WORKSPACE_PUBLIC_ORIGIN');
    if (!existsSync(join(staticDir, 'index.html')) || !statSync(join(staticDir, 'index.html')).isFile()) throw new Error('Production requires a built WORKSPACE_STATIC_DIR/index.html');
  }
  const ownerName = env.WORKSPACE_OWNER_NAME || 'Owner';
  if (ownerName.length > 80 || /[\u0000-\u001f]/.test(ownerName)) throw new Error('WORKSPACE_OWNER_NAME must contain at most 80 printable characters');
  const sessionTtlMs = integer(env, 'WORKSPACE_SESSION_TTL_SECONDS', 43200, 60, 604800) * 1000;
  const sessionIdleMs = integer(env, 'WORKSPACE_SESSION_IDLE_SECONDS', 3600, 60, 86400) * 1000;
  if (sessionIdleMs > sessionTtlMs) throw new Error('Session idle timeout cannot exceed absolute session lifetime');
  return {
    managedBridgeRegistration: parseBridgeRegistration(env.GDW_MANAGED_BRIDGE_REGISTRATION),
    managedBridgeEventsEnabled: env.GDW_MANAGED_BRIDGE_EVENTS_ENABLED === 'true',
    managedBridgeCallbackOrigins: (env.GDW_MANAGED_BRIDGE_CALLBACK_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
    apiToken, approvalToken, runtime, dbPath, allowedOrigin, publicOrigin, production, releaseId,
    ownerPasswordHash, ownerName, staticDir, sessionTtlMs, sessionIdleMs, trustedProxyIPs,
    host,
    port: integer(env, 'WORKSPACE_PORT', 4318, 0, 65535),
    pollMs: integer(env, 'WORKSPACE_POLL_MS', 60000, 1000, 86400000),
    leaseMs: integer(env, 'WORKSPACE_LEASE_MS', 120000, 3000, 86400000),
    concurrency: integer(env, 'WORKSPACE_CONCURRENCY', 2, 1, 16),
  };
}
