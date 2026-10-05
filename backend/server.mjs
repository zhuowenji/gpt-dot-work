import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { OwnerAuth, constantEqual } from './auth.mjs';
import { WorkspaceStore, MAX_WORKSPACE_BYTES } from './workspace.mjs';
import { VideoStore } from './videos.mjs';
import { ChatIntake } from './chat.mjs';
import { ManagedBridgeApi } from './managed-bridge.mjs';
import { CALLBACK_FAILURE_REASONS } from './managed-bridge-events.mjs';
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

async function serveStatic(req, res, pathname, staticDir, publicOrigin) {
  if (!['GET', 'HEAD'].includes(req.method) || !staticDir) throw new ApiError(404, 'not_found', 'Endpoint not found');
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw new ApiError(400, 'invalid_path', 'Invalid URL path'); }
  const rootPage = decoded === '/' || decoded === '/index.html';
  const adminPage = decoded === '/admin/' || decoded === '/admin';
  const inboxPage = decoded === '/admin/chat/' || decoded === '/admin/chat';
  const demoPage = decoded === '/demo/' || decoded === '/demo';
  const explicitAsset = ['/app.js', '/style.css', '/admin/chat/app.js'].includes(decoded);
  if (!rootPage && !adminPage && !inboxPage && !demoPage && !explicitAsset && !/^\/src\/[A-Za-z0-9_/-]+\.(?:js|css|svg|png|webp|ico|woff2)$/.test(decoded)) throw new ApiError(404, 'not_found', 'Asset not found');
  try {
    const root = await realpath(staticDir);
    const path = await realpath(resolve(root, '.' + (rootPage ? '/index.html' : adminPage ? '/admin/index.html' : inboxPage ? '/admin/chat/index.html' : demoPage ? '/demo/index.html' : decoded)));
    if (!path.startsWith(root + sep)) throw new ApiError(404, 'not_found', 'Asset not found');
    let content = await readFile(path);
    if (adminPage || inboxPage) res.setHeader('X-Robots-Tag', 'noindex');
    if (rootPage) {
      // Preserve uploaded HTML exactly while allowing its fixed theme bootstrap.
      const scripts = [...content.toString('utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)];
      const hashes = scripts.map(script => ` 'sha256-${createHash('sha256').update(script[1]).digest('base64')}'`).join('');
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'${hashes}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; worker-src 'none'`);
    }
    if (demoPage) {
      // Fixed self-contained, read-only public page. Never inject owner session state.
      // Only the explicitly public results endpoint may be contacted.
      const scripts = [...content.toString('utf8').matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
      if (scripts.length !== 1) throw new ApiError(404, 'not_found', 'Build the public demo before serving this page');
      const hash = createHash('sha256').update(scripts[0][1]).digest('base64');
      const connectSource = publicOrigin ? `${publicOrigin}/api/public/videos` : "'self'";
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; connect-src ${connectSource}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; worker-src 'none'; frame-src 'none'`);
      res.setHeader('X-Robots-Tag', 'noindex');
    }
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
  const videos = new VideoStore(store);
  const chat = new ChatIntake(store, config, auth);
  const bridge = new ManagedBridgeApi(store, config, chat);
  const server = createServer(async (req, res) => {
    const requestStartedAt = performance.now();
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
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, X-Idempotency-Key, X-CSRF-Token', 'Access-Control-Max-Age': '600' });
        res.end(); return;
      }
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') { send(res, 200, { ok: true, ...(config.releaseId ? { releaseId: config.releaseId } : {}) }); return; }
      if (!url.pathname.startsWith('/api/')) {
        await serveStatic(req, res, url.pathname, config.staticDir, config.publicOrigin || config.allowedOrigin); return;
      }
      // Public access is limited to this explicit read-only, allowlisted DTO.
      if (req.method === 'GET' && url.pathname === '/api/public/videos') {
        const limit = integerQuery(url, 'limit', 50, 100);
        if (limit < 1) throw new ApiError(400, 'invalid_query', 'limit must be at least 1');
        send(res, 200, videos.publicList({ limit })); return;
      }
      // These 201 receipts are sent only after the chat transaction commits.
      // Keep handler timing separate from network delivery and AI execution.
      if (req.method === 'POST' && /^\/api\/chat\/tasks(?:\/[a-f0-9]{32}\/messages)?$/.test(url.pathname)) {
        const writeHead = res.writeHead;
        res.writeHead = function (statusCode, ...args) {
          if (statusCode === 201) this.setHeader('Server-Timing', `intake-receipt;dur=${(performance.now() - requestStartedAt).toFixed(3)}`);
          return writeHead.call(this, statusCode, ...args);
        };
      }
      if (await bridge.handle(req, res, url)) return;
      const session = auth.session(req);
      if (await chat.handle(req, res, url, session)) return;
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
      if (req.method === 'GET' && url.pathname === '/api/video-settings') { send(res, 200, videos.settings()); return; }
      if (req.method === 'PUT' && url.pathname === '/api/video-settings') { send(res, 200, videos.putSettings(await readBody(req))); return; }
      if (req.method === 'POST' && url.pathname === '/api/videos/ingest') { send(res, 200, videos.ingest(await readBody(req, 1024 * 1024), req.headers['idempotency-key'])); return; }
      if (req.method === 'GET' && url.pathname === '/api/videos') {
        const limit = integerQuery(url, 'limit', 50, 200);
        if (limit < 1) throw new ApiError(400, 'invalid_query', 'limit must be at least 1');
        const rawCursor = url.searchParams.get('cursor');
        const cursorMatch = rawCursor === null ? null : /^(\d+):([a-f0-9-]{36})$/.exec(rawCursor);
        if (rawCursor !== null && (!cursorMatch || !Number.isSafeInteger(Number(cursorMatch[1])))) throw new ApiError(400, 'invalid_query', 'Invalid cursor');
        send(res, 200, videos.list({ view: url.searchParams.get('view') || 'all', limit, cursor: cursorMatch ? { firstSeenAt: Number(cursorMatch[1]), id: cursorMatch[2] } : null })); return;
      }
      const videoMatch = /^\/api\/videos\/([a-f0-9-]{36})(?:\/(verification|publication))?$/.exec(url.pathname);
      if (videoMatch && req.method === 'GET' && !videoMatch[2]) { send(res, 200, videos.get(videoMatch[1])); return; }
      if (videoMatch && req.method === 'PATCH' && videoMatch[2] === 'publication') { send(res, 200, videos.publish(videoMatch[1], await readBody(req), req.headers['idempotency-key'], bearer ? 'owner_api' : 'owner_session')); return; }
      if (videoMatch && req.method === 'PATCH' && videoMatch[2] === 'verification') { send(res, 200, videos.verify(videoMatch[1], await readBody(req), req.headers['idempotency-key'], bearer ? 'owner_api' : 'owner_session')); return; }
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
      if (!res.headersSent) send(res, error instanceof ApiError ? error.status : 500, { error: {
        code: error instanceof ApiError ? error.code : 'internal_error',
        message: error instanceof ApiError ? error.message : 'The request could not be completed',
        ...(error instanceof ApiError && error.code === 'callback_origin_not_allowed' && typeof error.origin === 'string' ? { origin: error.origin } : {}),
        ...(error instanceof ApiError && error.code === 'callback_verification_failed' && CALLBACK_FAILURE_REASONS.includes(error.reason) ? { reason: error.reason } : {}),
      } });
      else res.end();
    }
  });
  server.managedBridge = bridge;
  server.once('listening', () => bridge.start());
  server.once('close', () => { void bridge.stop(); });
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
  const shutdown = async () => { await server.managedBridge.stop(); server.close(() => store.close()); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
