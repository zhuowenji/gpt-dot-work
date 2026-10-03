import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { VideoStore } from '../videos.mjs';
import { TaskStore } from '../store.mjs';
import { WorkspaceStore, emptyWorkspace } from '../workspace.mjs';
import { createApiServer, listen } from '../server.mjs';
import { readConfig } from '../config.mjs';
import { digest } from '../auth.mjs';
import { buildPublicDemo } from '../../scripts/public-demo.mjs';

const source = async file => readFile(new URL('../../' + file, import.meta.url), 'utf8');
const demo = await buildPublicDemo({ template: await source('public-demo/index.html'), css: await source('public-demo/style.css'), app: await source('public-demo/app.js') });
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'public-demo-tests-'));
  const staticDir = join(dir, 'dist');
  await mkdir(join(staticDir, 'demo'), { recursive: true });
  await mkdir(join(staticDir, 'admin'), { recursive: true });
  await writeFile(join(staticDir, 'admin', 'index.html'), await source('index.html'));
  await writeFile(join(staticDir, 'index.html'), await source('index.html'));
  await writeFile(join(staticDir, 'demo', 'index.html'), demo);
  const config = readConfig({ WORKSPACE_API_TOKEN: 'fictional-test-token-'.repeat(3), WORKSPACE_PUBLIC_ORIGIN: 'http://localhost:4318', WORKSPACE_DB_PATH: join(dir, 'state.sqlite'), WORKSPACE_STATIC_DIR: staticDir, WORKSPACE_PORT: '0' });
  const store = new TaskStore(config.dbPath);
  const workspace = new WorkspaceStore(store);
  const privateData = emptyWorkspace();
  privateData.projects.push({id:'private',name:'PRIVATE_OWNER_SENTINEL',icon:'P',color:'blue',category:'Private',description:'Only owner',stage:'Private',plan:'Private'});
  workspace.put({ revision: 0, workspace: privateData });
  const server = createApiServer(store, config);
  const address = await listen(server, config);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); await rm(dir, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${address.port}`, dir, staticDir, workspace, store, config };
}

test('anonymous public page is self-contained, with no seeded data, cookie, or private data', async t => {
  const { base, workspace } = await setup(t);
  for (const path of ['/demo/', '/demo']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex');
    const html = await response.text();
    assert.match(html, /公开范围：/);
    assert.match(html, /暂无公开结果/);
    assert.doesNotMatch(html, /createWorkspaceClient|localStorage|个人知识花园|周末城市漫游|const seed/);
    assert.doesNotMatch(html, /PRIVATE_OWNER_SENTINEL|fictional-test-token-/);
    assert.doesNotMatch(html, /<meta name="workspace-mode" content="server">|<script[^>]+src=|<link[^>]+href=/);
    const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];
    const csp = response.headers.get('content-security-policy');
    assert.ok(csp.includes(`script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`));
    for (const directive of ["connect-src http://localhost:4318/api/public/videos", "form-action 'none'", "frame-ancestors 'none'", "default-src 'none'", "worker-src 'none'"]) assert.ok(csp.includes(directive));
  }
  const head = await fetch(base + '/demo/', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal(workspace.get().workspace.projects[0].name, 'PRIVATE_OWNER_SENTINEL');
  assert.equal(workspace.get().revision, 1);
});

test('public demo route does not open private reads, mutations, or other static paths', async t => {
  const { base, workspace } = await setup(t);
  for (const path of ['/api/workspace', '/api/tasks', '/api/status', '/api/videos']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 401, path);
    assert.equal((await response.json()).error.code, 'unauthorized');
  }
  const mutation = await fetch(base + '/api/workspace', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({revision:1,workspace:emptyWorkspace()}) });
  assert.equal(mutation.status, 401);
  assert.equal(workspace.get().revision, 1);
  assert.equal(workspace.get().workspace.projects[0].name, 'PRIVATE_OWNER_SENTINEL');
  for (const path of ['/demo/api/workspace', '/demo/index.html', '/demo/preview.html', '/preview.html', '/backend/.env', '/state.sqlite', '/demo/%2e%2e/backend/.env']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  assert.equal((await fetch(base + '/demo/', { method: 'POST' })).status, 404);
  const privateShell = await fetch(base + '/admin/');
  assert.match(await privateShell.text(), /GPT-DOT-WORK/);
});

test('demo artifact symlinks cannot escape the static directory', async t => {
  const { base, dir, staticDir } = await setup(t);
  await rm(join(staticDir, 'demo', 'index.html'));
  await writeFile(join(dir, 'private.html'), 'PRIVATE_OWNER_SENTINEL');
  await symlink(join(dir, 'private.html'), join(staticDir, 'demo', 'index.html'));
  assert.equal((await fetch(base + '/demo/')).status, 404);
});


test('even a valid owner cookie cannot personalize the public demo or refresh its session', async t => {
  const { base, store, config } = await setup(t);
  const id = 'a'.repeat(43), csrf = 'PRIVATE_CSRF_SENTINEL';
  const at = Date.now();
  store.now = () => at + 1000;
  store.db.prepare('INSERT INTO owner_sessions(id_hash, csrf, password_version, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run(digest(id), csrf, digest(config.ownerPasswordHash || 'disabled'), at, at + 60_000, at);
  const response = await fetch(base + '/demo/', {headers:{Cookie:`workspace_session=${id}`}});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.doesNotMatch(await response.text(), /PRIVATE_OWNER_SENTINEL|PRIVATE_CSRF_SENTINEL/);
  assert.equal(store.db.prepare('SELECT last_seen FROM owner_sessions').get().last_seen, at);
  const privateResponse = await fetch(base + '/api/workspace', {headers:{Cookie:`workspace_session=${id}`}});
  assert.equal(privateResponse.status, 200);
  assert.equal((await privateResponse.json()).workspace.projects[0].name, 'PRIVATE_OWNER_SENTINEL');
  assert.equal(store.db.prepare('SELECT last_seen FROM owner_sessions').get().last_seen, at + 1000);
});

test('a symlinked demo directory cannot escape the static root', async t => {
  const { base, dir, staticDir } = await setup(t);
  const privateDir = join(dir, 'private');
  await mkdir(privateDir);
  await writeFile(join(privateDir, 'index.html'), demo.replace('公开演示', 'PRIVATE_OWNER_SENTINEL'));
  await rm(join(staticDir, 'demo'), {recursive:true});
  await symlink(privateDir, join(staticDir, 'demo'));
  assert.equal((await fetch(base + '/demo/')).status, 404);
});


test('actual public API DTO renders in the standalone client while private data remains absent', async t => {
  const { base, store } = await setup(t);
  store.now = () => Date.parse('2026-10-03T22:00:00Z');
  const videos = new VideoStore(store);
  const record = {url:'https://v.douyin.com/Test123/',title:'公开测试厨房收纳篮',category:'kitchen_non_electric',publishedDate:'2026-10-01',rawPublicationDate:'2026-10-01',observedAt:'2026-10-03T21:00:00Z',rawLikeCount:'2345',observedLikes:2345,likeCountExact:true,source:'PRIVATE_SOURCE_SENTINEL',evidence:[{kind:'page_text',value:'PRIVATE_EVIDENCE_SENTINEL'}]};
  const id = videos.ingest({videos:[record]},randomUUID()).results[0].id;
  videos.verify(id,{revision:1,state:'verified',note:'PRIVATE_VERIFICATION_SENTINEL'},randomUUID());
  assert.equal((await (await fetch(base+'/api/public/videos')).json()).shown,0);
  videos.publish(id,{revision:2,isPublic:true},randomUUID());
  let finished;
  const loaded = new Promise(resolve => { finished = resolve; });
  const nodes = Object.fromEntries(['refresh','results','status','updated','result-count'].map(key=>['#'+key,{innerHTML:'',textContent:'',hidden:false,disabled:false,className:'',setAttribute(name,value){if(key==='results' && name==='aria-busy' && value==='false')finished();},addEventListener(){}}]));
  const calls=[];
  const context=vm.createContext({console,URL,Intl,Date,fetch:async(path,options)=>{calls.push({path,options});return fetch(base+path,options);},document:{querySelector:selector=>nodes[selector]}});
  vm.runInContext(await source('public-demo/app.js'),context);
  await loaded;
  assert.equal(calls.length,1);assert.equal(calls[0].options.credentials,'omit');
  const html=nodes['#results'].innerHTML;
  assert.match(html,/公开测试厨房收纳篮|非电厨房用品/);
  assert.match(html,/https:\/\/v\.douyin\.com\/Test123\//);
  assert.match(html,/2,345/);
  assert.doesNotMatch(html,/PRIVATE_|rawLikeCount|revision/);
  assert.equal((await fetch(base+'/api/workspace')).status,401);
});
