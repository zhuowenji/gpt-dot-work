import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

function integer(env, name, fallback, minimum, maximum) {
  const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function readConfig(env = process.env, { requireApiToken = true } = {}) {
  const apiToken = env.WORKSPACE_API_TOKEN || '';
  const approvalToken = env.WORKSPACE_APPROVAL_TOKEN || '';
  if (requireApiToken && apiToken.length < 32) throw new Error('WORKSPACE_API_TOKEN must contain at least 32 characters');
  if (approvalToken && (approvalToken.length < 32 || approvalToken === apiToken)) {
    throw new Error('WORKSPACE_APPROVAL_TOKEN must be a distinct secret of at least 32 characters');
  }
  const runtime = env.WORKSPACE_RUNTIME || 'disabled';
  if (!['disabled', 'demo'].includes(runtime)) throw new Error('WORKSPACE_RUNTIME must be disabled or demo');
  const stateHome = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const dbPath = env.WORKSPACE_DB_PATH || join(stateHome, 'gpt-dot-work', 'tasks.sqlite');
  if (!isAbsolute(dbPath)) throw new Error('WORKSPACE_DB_PATH must be absolute');
  const allowedOrigin = env.WORKSPACE_ALLOWED_ORIGIN || '';
  if (allowedOrigin) {
    const parsed = new URL(allowedOrigin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== allowedOrigin) {
      throw new Error('WORKSPACE_ALLOWED_ORIGIN must be an exact http(s) origin without a trailing slash');
    }
  }
  return {
    apiToken, approvalToken, runtime, dbPath, allowedOrigin,
    host: env.WORKSPACE_HOST || '127.0.0.1',
    port: integer(env, 'WORKSPACE_PORT', 4318, 0, 65535),
    pollMs: integer(env, 'WORKSPACE_POLL_MS', 60000, 1000, 86400000),
    leaseMs: integer(env, 'WORKSPACE_LEASE_MS', 120000, 3000, 86400000),
    concurrency: integer(env, 'WORKSPACE_CONCURRENCY', 2, 1, 16),
  };
}
