import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { TaskStore, ApiError, TASK_STATES } from './store.mjs';
import { readConfig } from './config.mjs';

const digest = value => createHash('sha256').update(value).digest();
function authorized(req, expected) {
  const actual = req.headers.authorization;
  return Boolean(expected && typeof actual === 'string' && actual.startsWith('Bearer ') && timingSafeEqual(digest(actual.slice(7)), digest(expected)));
}
function send(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'json_required', 'Send Content-Type: application/json');
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 32768) throw new ApiError(413, 'body_too_large', 'JSON body exceeds 32 KiB');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_input', 'Expected a JSON object');
  return body;
}
function emptyBody(body) {
  if (Object.keys(body).length) throw new ApiError(400, 'invalid_input', 'This operation accepts an empty JSON object only');
}
function integerQuery(url, key, fallback, max) {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) throw new ApiError(400, 'invalid_query', `Invalid ${key}`);
  return Number(raw);
}

export function createApiServer(store, config) {
  if (!config.apiToken || config.apiToken.length < 32) throw new Error('A strong API token is required');
  if (config.approvalToken && (config.approvalToken.length < 32 || config.approvalToken === config.apiToken)) throw new Error('The approval credential must be strong and distinct from the API credential');
  const server = createServer(async (req, res) => {
    try {
      const origin = req.headers.origin;
      if (origin && origin !== config.allowedOrigin) throw new ApiError(403, 'origin_denied', 'This browser origin is not allowed');
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        if (!origin) throw new ApiError(403, 'origin_denied', 'Preflight requires an allowed origin');
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key', 'Access-Control-Max-Age': '600' });
        res.end(); return;
      }
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') { send(res, 200, { ok: true }); return; }
      const match = /^\/api\/tasks\/([a-f0-9-]{36})(?:\/(submit|cancel|retry|approval|events))?$/.exec(url.pathname);
      const approvalRoute = req.method === 'POST' && match?.[2] === 'approval';
      if (!authorized(req, approvalRoute ? config.approvalToken : config.apiToken)) throw new ApiError(401, 'unauthorized', 'A valid bearer credential is required for this operation');
      if (req.method === 'GET' && url.pathname === '/api/status') {
        send(res, 200, { runtime: config.runtime, demo: config.runtime === 'demo', realExecutionConfigured: false, pollMs: config.pollMs, approvalConfigured: Boolean(config.approvalToken), states: TASK_STATES }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/tasks') {
        const limit = integerQuery(url, 'limit', 100, 500);
        if (limit < 1) throw new ApiError(400, 'invalid_query', 'limit must be at least 1');
        const rawCursor = url.searchParams.get('cursor');
        const cursorMatch = rawCursor === null ? null : /^(\d+):([a-f0-9-]{36})$/.exec(rawCursor);
        if (rawCursor !== null && (!cursorMatch || !Number.isSafeInteger(Number(cursorMatch[1])))) throw new ApiError(400, 'invalid_query', 'Invalid cursor');
        const cursor = cursorMatch ? { createdAt: Number(cursorMatch[1]), id: cursorMatch[2] } : null;
        const tasks = store.list({ limit, cursor });
        const last = tasks.at(-1);
        send(res, 200, { tasks, nextCursor: tasks.length === limit ? `${last.createdAt}:${last.id}` : null }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks') {
        send(res, 201, { task: store.create(await readBody(req), req.headers['idempotency-key']) }); return;
      }
      if (!match) throw new ApiError(404, 'not_found', 'Endpoint not found');
      const [, id, action] = match;
      if (req.method === 'GET' && !action) { send(res, 200, { task: store.get(id) }); return; }
      if (req.method === 'GET' && action === 'events') { send(res, 200, { events: store.events(id, integerQuery(url, 'after', 0, Number.MAX_SAFE_INTEGER)) }); return; }
      if (req.method === 'PATCH' && !action) { send(res, 200, { task: store.edit(id, await readBody(req), req.headers['idempotency-key']) }); return; }
      if (req.method === 'POST' && ['submit', 'cancel', 'retry', 'approval'].includes(action)) {
        const body = await readBody(req);
        if (action === 'approval') {
          if (Object.keys(body).some(key => !['requestId', 'decision'].includes(key))) throw new ApiError(400, 'invalid_input', 'Only requestId and decision are accepted');
          send(res, 200, { task: store.decideApproval(id, body, req.headers['idempotency-key']) });
        } else {
          emptyBody(body);
          send(res, 200, { task: store[action](id, req.headers['idempotency-key']) });
        }
        return;
      }
      throw new ApiError(404, 'not_found', 'Endpoint not found');
    } catch (error) {
      if (!res.headersSent) send(res, error instanceof ApiError ? error.status : 500, { error: { code: error instanceof ApiError ? error.code : 'internal_error', message: error instanceof ApiError ? error.message : 'The request could not be completed' } });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

export async function listen(server, config) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); }); });
  return server.address();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const config = readConfig();
  const store = new TaskStore(config.dbPath);
  const server = createApiServer(store, config);
  const address = await listen(server, config);
  process.stdout.write(`Task API listening on ${config.host}:${address.port}. Runtime: ${config.runtime}.\n`);
  const shutdown = () => server.close(() => store.close());
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
