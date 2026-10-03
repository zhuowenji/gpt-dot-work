import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {emptyState,isValidState,createWorkspaceClient} from '../src/model.js';

test('empty authenticated workspace is valid and contains no demo data',()=>{
  const state=emptyState();assert.ok(isValidState(state));
  assert.deepEqual(state,{version:1,projects:[],notes:[],tasks:[],decisions:[]});
  state.projects.push({});assert.deepEqual(emptyState().projects,[]);
});
test('API client uses same-origin cookies, memory CSRF and optimistic revision',async()=>{
  const calls=[];
  const client=createWorkspaceClient(async(path,options)=>{
    calls.push({path,options});return {ok:true,status:200,json:async()=>({revision:8,workspace:emptyState()})};
  });
  client.setCsrfToken('memory-csrf');await client.saveWorkspace(emptyState(),7);
  assert.equal(calls[0].path,'/api/workspace');
  assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.cache,'no-store');
  assert.equal(calls[0].options.headers['X-CSRF-Token'],'memory-csrf');
  assert.equal(calls[0].options.headers.Authorization,undefined);
  assert.equal(JSON.parse(calls[0].options.body).revision,7);
  client.setCsrfToken(null);await client.getSession();assert.equal(calls[1].options.headers['X-CSRF-Token'],undefined);
});
test('draft save and explicit submit are separate API operations with stable idempotency',async()=>{
  const calls=[];const client=createWorkspaceClient(async(path,options)=>{calls.push({path,options});return {ok:true,status:200,json:async()=>({task:{id:'task-id',status:'draft'}})};});
  await client.createTask({title:'Title',instructions:'Instructions',kind:'task'},'stable-create-key');
  assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/tasks');
  assert.equal(calls[0].options.headers['Idempotency-Key'],'stable-create-key');
  await client.taskAction('task-id','submit',{revision:4},'stable-submit-key');
  assert.equal(calls[1].path,'/api/tasks/task-id/submit');assert.deepEqual(JSON.parse(calls[1].options.body),{revision:4});
});
test('conflicts, auth expiry, network and invalid responses never become save success',async()=>{
  for(const [status,code] of [[409,'revision_conflict'],[401,'unauthorized'],[403,'csrf_denied']]){
    const client=createWorkspaceClient(async()=>({ok:false,status,json:async()=>({error:{code,message:'Rejected'}})}));
    await assert.rejects(client.saveWorkspace(emptyState(),0),error=>error.status===status && error.code===code);
  }
  const offline=createWorkspaceClient(async()=>{throw new Error('offline');});
  await assert.rejects(offline.saveWorkspace(emptyState(),0),error=>error.code==='network_error');
  const malformed=createWorkspaceClient(async()=>({ok:true,status:200,json:async()=>({revision:1,workspace:{}})}));
  await assert.rejects(malformed.saveWorkspace(emptyState(),0),error=>error.code==='invalid_response');
});
test('private API envelope rejects demo requests and malformed revision',async()=>{
  for(const envelope of [{revision:'1',workspace:emptyState()},{revision:1,workspace:{...emptyState(),requests:[]}}]){
    const client=createWorkspaceClient(async()=>({ok:true,status:200,json:async()=>envelope}));
    await assert.rejects(client.getWorkspace(),error=>error.code==='invalid_response');
  }
});
test('frontend keeps explicit server marker, local-only demo reads, and no auth persistence',async()=>{
  const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
  assert.match(source,/meta\[name="workspace-mode"\]/);
  assert.match(source,/if \(!serverMode\) \{\s*try \{ const saved = JSON.parse\(localStorage.getItem/);
  assert.match(source,/saveWorkspace\(candidate, dirtyRevision\)/);
  assert.match(source,/operationKey=r\?\.operationKey \|\| crypto.randomUUID\(\)/);
  assert.match(source,/pendingRequestDraft=\{id:requestId,title,instructions,operationKey\}/);
  assert.match(source,/action==='submit'\?\{revision:r.revision\}/);
  assert.doesNotMatch(source,/localStorage\.setItem\([^\n]*(?:password|csrfToken|session)/i);
});

// Run the real frontend source with a tiny non-browser DOM boundary. This tests
// startup/privacy and recovery state transitions without requiring Chromium.
async function appHarness(fetcher, serverMode = true) {
  const vm=await import('node:vm');
  const app={innerHTML:''}, dialog={innerHTML:'',dataset:{},close(){},addEventListener(){},querySelector(){return null;},querySelectorAll(){return [];}};
  const toast={textContent:'',classList:{add(){},remove(){}}};
  let localReads=0;
  const context=vm.createContext({structuredClone,FormData,URL,Blob,crypto:globalThis.crypto,console,
    fetch:fetcher,
    localStorage:{getItem(){localReads++;return null;},setItem(){}},
    setTimeout(){return 1;},clearTimeout(){},location:{hash:''},
    window:{addEventListener(){}},
    document:{hidden:false,addEventListener(){},querySelectorAll(){return [];},querySelector(q){
      if(q==='meta[name="workspace-mode"]')return serverMode?{content:'server'}:null;
      if(q==='#app')return app;if(q==='#note-dialog')return dialog;if(q==='#toast')return toast;
      return null;
    }}
  });
  const model=(await readFile(new URL('../src/model.js',import.meta.url),'utf8')).replaceAll('export ','');
  const source=(await readFile(new URL('../src/app.js',import.meta.url),'utf8')).replace(/^import .*?;\n/,'');
  vm.runInContext(model+'\n'+source,context);
  await new Promise(resolve=>setImmediate(resolve));
  return {app,context,localReads:()=>localReads,run:code=>vm.runInContext(code,context)};
}
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
test('server startup shows login without reading demo cache or private API',async()=>{
  const paths=[];const h=await appHarness(async path=>{paths.push(path);return response({authenticated:false,loginConfigured:true});});
  assert.equal(h.localReads(),0);assert.deepEqual(paths,['/api/session']);
  assert.match(h.app.innerHTML,/登录工作空间/);assert.doesNotMatch(h.app.innerHTML,/个人知识花园|周末城市漫游/);
});
test('server outage shows a retryable connection error and never seeds a demo',async()=>{
  const h=await appHarness(async()=>{throw new Error('offline');});
  assert.equal(h.localReads(),0);assert.match(h.app.innerHTML,/重新连接/);
  assert.doesNotMatch(h.app.innerHTML,/个人知识花园|周末城市漫游/);
});
test('authenticated empty startup renders create-project state',async()=>{
  const h=await appHarness(async path=>response(path==='/api/session'?{authenticated:true,csrfToken:'csrf',owner:{name:'Test owner'}}:path==='/api/workspace'?{revision:0,workspace:emptyState()}:{tasks:[],nextCursor:null}));
  assert.equal(h.localReads(),0);assert.match(h.app.innerHTML,/从你的第一个项目开始/);assert.match(h.app.innerHTML,/私有服务器/);
  assert.doesNotMatch(h.app.innerHTML,/个人知识花园|虚构演示数据/);
});
test('unsaved revision is preserved across session expiry and newer server reload',async()=>{
  let loggedIn=false;const saves=[];
  const h=await appHarness(async(path,options)=>{
    if(path==='/api/session')return response({authenticated:false,loginConfigured:true});
    if(path==='/api/workspace'&&options.method==='PUT'){
      saves.push(JSON.parse(options.body).revision);
      return loggedIn?response({error:{code:'revision_conflict',message:'Changed'}},409):response({error:{code:'unauthorized',message:'Expired'}},401);
    }
    if(path==='/api/workspace')return response({revision:9,workspace:emptyState()});
    return response({tasks:[],nextCursor:null});
  });
  await h.run("phase='ready'; revision=3; persist(emptyState(),'must not be saved')");
  assert.equal(h.run('dirtyRevision'),3);assert.equal(h.run('phase'),'login');
  loggedIn=true;await h.run("loadAuthenticated({authenticated:true,csrfToken:'new-csrf',owner:{name:'Owner'}})");
  assert.equal(h.run('revision'),9);assert.equal(h.run('dirtyRevision'),3);
  assert.equal(await h.run("persist(dirty,'must not be saved')"),false);
  assert.deepEqual(saves,[3,3]);assert.equal(h.run('conflict'),true);
  assert.match(h.run('recoveryBanner()'),/修改尚未保存/);
});
test('CSRF denial locks visible private state and retains unsaved candidate',async()=>{
  const h=await appHarness(async path=>response({authenticated:false,loginConfigured:true}));
  h.run("phase='ready'; state=freshState(); dirty=structuredClone(state); dirtyRevision=4; handleFailure({status:403,code:'csrf_denied'});");
  assert.equal(h.run('phase'),'login');assert.equal(h.run('dirtyRevision'),4);
  assert.match(h.app.innerHTML,/登录工作空间/);assert.doesNotMatch(h.app.innerHTML,/个人知识花园/);
});
