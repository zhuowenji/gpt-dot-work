import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TaskStore } from '../store.mjs';
import { createApiServer, listen } from '../server.mjs';
import { readConfig } from '../config.mjs';
const source = file => readFile(new URL('../../' + file, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'chat-static-'));
  const staticDir = join(dir, 'dist');
  await mkdir(join(staticDir, 'admin', 'chat'), {recursive:true});
  await mkdir(join(staticDir, 'src'), {recursive:true});
  const root = await source('task-chat/index.html');
  const css = await source('task-chat/style.css');
  await writeFile(join(staticDir, 'index.html'), root);
  await writeFile(join(staticDir, 'style.css'), css);
  await writeFile(join(staticDir, 'app.js'), '// safe fixture');
  await writeFile(join(staticDir, 'admin', 'index.html'), await source('task-chat/admin-chat.html'));
  await writeFile(join(staticDir, 'admin', 'chat', 'index.html'), '<!doctype html><html><head></head><body>Owner inbox<script src="/admin/chat/app.js"></script></body></html>');
  await writeFile(join(staticDir, 'admin', 'chat', 'app.js'), '// safe inbox fixture');
  const config = readConfig({WORKSPACE_API_TOKEN:'fictional-static-fixture-'.repeat(3), WORKSPACE_PUBLIC_ORIGIN:'http://localhost:4318', WORKSPACE_DB_PATH:join(dir,'state.sqlite'), WORKSPACE_STATIC_DIR:staticDir, WORKSPACE_PORT:'0'});
  const store = new TaskStore(config.dbPath);
  const server = createApiServer(store,config);
  const address = await listen(server,config);
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();await rm(dir,{recursive:true,force:true});});
  return {base:`http://127.0.0.1:${address.port}`,dir,staticDir,root,css};
}
test('polished root keeps the original chat structure and explicit offline capabilities', async()=>{
  const html=(await source('task-chat/index.html')).toString();
  const css=(await source('task-chat/style.css')).toString();
  for (const id of ['taskList','messages','composer','input','queuedMessages','deleteTaskDialog']) assert.ok(html.includes(`id="${id}"`));
  assert.match(html, /class="sidebar"/); assert.match(html, /class="main"/);
  assert.doesNotMatch(html, /任务会自动进入队列|上传图片、视频或其他文件/);
  assert.match(css, /--surface:/); assert.match(css, /--accent:/); assert.match(css, /data-theme="dark"/);
});
test('public root preserves uploaded HTML and permits fixed theme script without broad inline scripts',async t=>{
  const {base,root,css}=await setup(t);
  for(const path of ['/','/index.html']){
    const response=await fetch(base+path);assert.equal(response.status,200);
    assert.equal(await response.text(),root.toString());
    assert.equal(response.headers.get('set-cookie'),null);
    const csp=response.headers.get('content-security-policy');
    const theme=/<script>([\s\S]*?)<\/script>/.exec(root.toString())[1];
    assert.ok(csp.includes(`'sha256-${createHash('sha256').update(theme).digest('base64')}'`));
    assert.doesNotMatch(csp,/script-src[^;]*'unsafe-inline'/);
    assert.match(csp,/img-src 'self' data:/);
  }
  assert.equal(await (await fetch(base+'/style.css')).text(),css.toString());
  assert.equal((await fetch(base+'/app.js')).status,200);
});
test('record list is served under admin without making private APIs public',async t=>{
  const {base}=await setup(t);
  for(const path of ['/admin','/admin/']){
    const response=await fetch(base+path);assert.equal(response.status,200);
    assert.match(await response.text(),/<title>对话记录<\/title>/);
    assert.equal(response.headers.get('x-robots-tag'),'noindex');
  }
  for(const path of ['/admin/chat','/admin/chat/','/admin/chat/app.js'])assert.equal((await fetch(base+path)).status,200);
  for(const path of ['/api/tasks','/api/workspace','/api/status','/api/videos','/api/admin/chat/tasks'])assert.equal((await fetch(base+path)).status,401,path);
  for(const path of ['/office/','/agent-api.html','/client/worker.py','/task-chat/app.js','/backend/chat.mjs','/admin/index.html','/admin/chat/index.html','/state.sqlite'])assert.equal((await fetch(base+path)).status,404,path);
});
test('root aliases and admin assets cannot escape static root via symlinks',async t=>{
  const {base,dir,staticDir}=await setup(t);
  await writeFile(join(dir,'private.txt'),'PRIVATE_SENTINEL');
  await rm(join(staticDir,'app.js'));
  await symlink(join(dir,'private.txt'),join(staticDir,'app.js'));
  assert.equal((await fetch(base+'/app.js')).status,404);
  await rm(join(staticDir,'admin'),{recursive:true});
  await symlink(dir,join(staticDir,'admin'));
  assert.equal((await fetch(base+'/admin/')).status,404);
});
