import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { OwnerAuth, constantEqual } from './auth.mjs';
import { WorkspaceStore, MAX_WORKSPACE_BYTES } from './workspace.mjs';
import { pathToFileURL } from 'node:url';
import { TaskStore, ApiError, TASK_STATES } from './store.mjs';
import { readConfig } from './config.mjs';

function authorized(req, expected) {
  const actual = req.headers.authorization;
  return Boolean(expected && typeof actual === 'string' && actual.startsWith('Bearer ') && constantEqual(actual.slice(7), expected));
}
function send(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
async function readBody(req, maxBytes = 32768) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'json_required', 'Send Content-Type: application/json');
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw new ApiError(413, 'body_too_large', `JSON body exceeds ${maxBytes} bytes`);
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

async function serveStatic(req, res, pathname, staticDir) {
  if (!['GET', 'HEAD'].includes(req.method) || !staticDir) throw new ApiError(404, 'not_found', 'Endpoint not found');
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw new ApiError(400, 'invalid_path', 'Invalid URL path'); }
  const rootPage = decoded === '/' || decoded === '/index.html';
  if (!rootPage && !/^\/src\/[A-Za-z0-9_/-]+\.(?:js|css|svg|png|webp|ico|woff2)$/.test(decoded)) throw new ApiError(404, 'not_found', 'Asset not found');
  try {
    const root = await realpath(staticDir);
    const path = await realpath(resolve(root, '.' + (rootPage ? '/index.html' : decoded)));
    if (!path.startsWith(root + sep)) throw new ApiError(404, 'not_found', 'Asset not found');
    let content = await readFile(path);
    if (rootPage) content = Buffer.from(content.toString('utf8').replace(/<head(?:\s[^>]*)?>/i, '$&<meta name="workspace-mode" content="server">'));
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': content.length });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(404, 'not_found', 'Build the frontend before serving this page');
  }
}

export function createApiServer(store, config) {
  if (!config.ownerPasswordHash && (!config.apiToken || config.apiToken.length < 32)) throw new Error('An owner password hash or strong API token is required');
  if (config.approvalToken && (config.approvalToken.length < 32 || config.approvalToken === config.apiToken)) throw new Error('The approval credential must be strong and distinct from the API credential');
  const auth = new OwnerAuth(store, config);
  const workspace = new WorkspaceStore(store);
  const server = createServer(async (req, res) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const origin = req.headers.origin;
      if (origin && origin !== (config.publicOrigin || config.allowedOrigin)) throw new ApiError(403, 'origin_denied', 'This browser origin is not allowed');
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        if (!origin) throw new ApiError(403, 'origin_denied', 'Preflight requires an allowed origin');
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, X-CSRF-Token', 'Access-Control-Max-Age': '600' });
        res.end(); return;
      }
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') { send(res, 200, { ok: true, ...(config.releaseId ? { releaseId: config.releaseId } : {}) }); return; }
      if (!url.pathname.startsWith('/api/')) {
        await serveStatic(req, res, url.pathname, config.staticDir); return;
      }
      const session = auth.session(req);
      if (req.method === 'GET' && url.pathname === '/api/session') { send(res, 200, auth.describe(session)); return; }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        auth.requireOrigin(req);
        send(res, 200, await auth.login(req, res, await readBody(req, 2048))); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        if (!session) throw new ApiError(401, 'unauthorized', 'Sign in to continue');
        auth.requireCsrf(req, session); emptyBody(await readBody(req));
        send(res, 200, auth.logout(req, res, session)); return;
      }
      const match = /^\/api\/tasks\/([a-f0-9-]{36})(?:\/(submit|cancel|retry|approval|events))?$/.exec(url.pathname);
      const approvalRoute = req.method === 'POST' && match?.[2] === 'approval';
      // Cookie sessions never grant authorization merely because request text asks.
      // A bearer credential is for a separate machine client, not browser storage.
      const bearer = authorized(req, approvalRoute ? config.approvalToken : config.apiToken);
      if (!bearer && !session) throw new ApiError(401, 'unauthorized', 'Sign in or provide a valid bearer credential');
      if (!bearer && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) auth.requireCsrf(req, session);
      if (req.method === 'GET' && url.pathname === '/api/workspace') { send(res, 200, workspace.get()); return; }
      if (req.method === 'PUT' && url.pathname === '/api/workspace') { send(res, 200, workspace.put(await readBody(req, MAX_WORKSPACE_BYTES + 128))); return; }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        send(res, 200, { runtime: config.runtime, demo: config.runtime === 'demo', realExecutionConfigured: false, pollMs: config.pollMs, approvalConfigured: Boolean(config.approvalToken || config.ownerPasswordHash), states: TASK_STATES }); return;
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
        } else if (action === 'submit') {
          if (Object.keys(body).some(key => key !== 'revision') || (session && !Object.hasOwn(body, 'revision'))) throw new ApiError(400, 'invalid_input', 'Browser submission requires the exact reviewed revision');
          send(res, 200, { task: store.submit(id, req.headers['idempotency-key'], body.revision) });
        } else {
          emptyBody(body);
          send(res, 200, { task: store[action](id, req.headers['idempotency-key']) });
        }
        return;
      }
      throw new ApiError(404, 'not_found', 'Endpoint not found');
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) res.setHeader('Retry-After', error.code === 'login_busy' ? '1' : '900');
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
