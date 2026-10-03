import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = process.cwd();
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const pages = new Map([['/','task-chat/index.html'],['/index.html','task-chat/index.html'],['/app.js','task-chat/app.js'],['/style.css','task-chat/style.css'],['/admin','task-chat/admin-chat.html'],['/admin/','task-chat/admin-chat.html'],['/admin/chat','task-chat/admin-chat.html'],['/admin/chat/','task-chat/admin-chat.html'],['/admin/chat/app.js','task-chat/admin-chat.js']]);
const server = http.createServer(async (req,res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const allowedSource = /^\/src\/[A-Za-z0-9_/-]+\.(?:js|css)$/.test(pathname);
    const relative = pages.get(pathname) || (allowedSource ? pathname.slice(1) : null);
    if (!['GET','HEAD'].includes(req.method) || !relative) {res.writeHead(404);res.end('Not found');return;}
    const file = await realpath(path.resolve(root,relative));
    if (!file.startsWith(await realpath(root) + path.sep)) {res.writeHead(404);res.end('Not found');return;}
    const body = await readFile(file);
    const hashes = path.extname(file)==='.html' ? [...body.toString().matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>` 'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`).join('') : '';
    res.writeHead(200, {'Content-Type':types[path.extname(file)]||'text/plain', 'Cache-Control':'no-store','X-Content-Type-Options':'nosniff', 'Content-Security-Policy':`default-src 'self'; script-src 'self'${hashes}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`});res.end(req.method==='HEAD'?undefined:body);
  } catch {res.writeHead(404);res.end('Not found');}
});
server.listen(Number(process.env.PORT || 4173), '127.0.0.1', () => console.log('Local visual preview: http://127.0.0.1:' + server.address().port + ' (intake API unavailable; use npm start for durable chat).'));
