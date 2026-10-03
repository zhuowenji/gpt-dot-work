import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const app = await readFile(new URL('../task-chat/app.js', import.meta.url), 'utf8');
const admin = await readFile(new URL('../task-chat/admin-chat.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../task-chat/admin-chat.html', import.meta.url), 'utf8');
test('uploaded chat uses scoped intake transport and no upload or notification prompt', () => {
  assert.match(app, /return '\/api\/chat\/me'/);
  assert.match(app, /path\.replace\('\/api\/tasks', '\/api\/chat\/tasks'\)/);
  assert.doesNotMatch(app, /XMLHttpRequest|requestPermission|new Notification|last_seen|xhr\.send|fileInput\.click/);
  assert.match(app, /const attachments = \[\];/); assert.match(app, /const agent_id = null;/);
  assert.match(app, /identity\.intake_enabled !== true/);
});
test('root and admin writes have CSRF/idempotency with same-origin cookies and object-shaped errors', () => {
  for (const source of [app, admin]) {
    assert.match(source, /'X-CSRF-Token'/); assert.match(source, /'X-Idempotency-Key'/);
    assert.match(source, /credentials:'same-origin'/); assert.match(source, /cache:'no-store'/);
    assert.match(source, /error\?\.message/);
  }
  assert.match(app, /!\['GET', 'HEAD'\]\.includes\(method\)/);
  assert.match(app, /saved\?\.signature === signature \? saved/);
});
test('no account drafts, credentials or conversation data persist in browser storage', () => {
  assert.equal([...app.matchAll(/localStorage\.setItem\(/g)].length, 1);
  assert.match(app, /localStorage\.setItem\('task-chat-theme', theme\)/);
  assert.doesNotMatch(admin, /localStorage|sessionStorage/);
  assert.match(app, /drafts\.clear\(\)/); assert.match(app, /previousPrincipal !== identityKey/);
  assert.match(admin, /before !== accountKey/);
});
test('accounts are optional footer UI with two credential fields and existing owner auth', () => {
  assert.match(app, /document\.querySelector\('\.identity'\)\.append\(accountFooter\)/);
  assert.match(app, /usernameInput\.name = 'username'/); assert.match(app, /passwordInput\.name = 'password'/);
  assert.match(app, /signup' \? 6 : 1/);
  assert.match(app, /\/api\/chat\/account\//);
  assert.match(admin, /raw\('\/api\/login'/);
  assert.match(admin, /me\.role !== 'account'/);
});
test('records companion has manual curation only and text-only server content', () => {
  assert.match(html, /<table>/); assert.match(html, /id="categoryFilter"/);
  assert.match(html, /src="\/admin\/chat\/app.js"/);
  assert.match(admin, /'\/metadata'/); assert.match(admin, /'\/replies'/);
  assert.doesNotMatch(admin, /innerHTML|insertAdjacentHTML|new Function|eval\(|POST[^\n]*api\/tasks/);
  assert.doesNotMatch(html, /id="newTask"|发布|创建任务/);
  assert.match(app, /所有者回复/); assert.doesNotMatch(app, /Agent 正在执行|任务已完成|等待 Agent/);
});

import vm from 'node:vm';
class FakeNode {
  constructor(tag='div') { this.tagName=tag.toUpperCase(); this.children=[]; this.style={}; this.dataset={}; this.attributes={}; this.handlers={}; this.value=''; this.hidden=false; this.disabled=false; this.open=false; this._text=''; this.className=''; this.classList={add(){},remove(){}}; this.scrollTop=0; this.scrollHeight=100; this.clientHeight=100; }
  append(...children) { for(const child of children) { if(child.parentElement) child.parentElement.children=child.parentElement.children.filter(x=>x!==child); child.parentElement=this; this.children.push(child); } }
  replaceChildren(...children) { this.children=[]; this._text=''; this.append(...children); }
  set textContent(value) { this._text=String(value??''); this.children=[]; }
  get textContent() { return this._text+this.children.map(x=>x.textContent).join(''); }
  set innerHTML(value) { this._html=value; this.children=[]; }
  get innerHTML() { return this._html||''; }
  get childElementCount() { return this.children.length; }
  setAttribute(key,value) { this.attributes[key]=value; }
  addEventListener(key,handler) { this.handlers[key]=handler; }
  querySelectorAll(selector) { const all=this.children.flatMap(child=>[child,...child.querySelectorAll('*')]); return selector==='button'?all.filter(x=>x.tagName==='BUTTON'):selector==='*'?all:[]; }
  querySelector(selector) { return this.querySelectorAll(selector)[0]||null; }
  focus() {}
  showModal() { this.open=true; }
  close() { this.open=false; this.onclose?.(); }
  contains(target) { return this===target||this.children.some(x=>x.contains(target)); }
  insertBefore(child,before) { if(child.parentElement)child.parentElement.children=child.parentElement.children.filter(x=>x!==child);child.parentElement=this;const at=this.children.indexOf(before);this.children.splice(at<0?this.children.length:at,0,child); }
}
const settle = () => new Promise(resolve=>setImmediate(resolve));
async function rootHarness() {
  const nodes=new Map(); const node=key=>{if(!nodes.has(key))nodes.set(key,new FakeNode());return nodes.get(key);};
  const parent=new FakeNode();parent.append(node('#queuedMessages'),node('#composer'));
  const calls=[]; const storage=new Map();
  const state={me:{role:'visitor',identity:'guest-test',ip:'127.0.0.1',csrfToken:'csrf-test',intake_enabled:true,execution_connected:false,uploads_enabled:false},tasks:[],messages:[],fail:false};
  const document={hidden:false,visibilityState:'visible',body:new FakeNode('body'),documentElement:{dataset:{theme:'light'}},querySelector:node,querySelectorAll:()=>[],createElement:tag=>new FakeNode(tag),createTextNode:text=>{const n=new FakeNode('text');n.textContent=text;return n;},addEventListener(){}};
  const context=vm.createContext({console,crypto:globalThis.crypto,AbortController,Error,TypeError,Set,Map,Object,Number,Array,JSON,setTimeout,clearTimeout,setInterval(){},document,window:{addEventListener(){}},localStorage:{getItem:key=>storage.get(key)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},Option:class extends FakeNode{constructor(text,value){super('option');this.textContent=text;this.value=value;}},fetch:async(path,options)=>{
    calls.push({path,options});
    if(path==='/api/chat/me'){const snapshot={...state.me};if(state.holdIdentity){state.holdIdentity=false;return new Promise(resolve=>{state.releaseIdentity=()=>resolve({ok:true,status:200,json:async()=>snapshot});});}return {ok:true,status:200,json:async()=>snapshot};}
    if(path.startsWith('/api/chat/account/')){state.me={...state.me,role:'account',identity:'account:test',csrfToken:'csrf-account',username:'小明'};return {ok:true,status:200,json:async()=>({authenticated:true})};}
    if(options.method==='GET')return {ok:true,status:200,json:async()=>path.includes('?')?{tasks:state.tasks,has_more:false,next_offset:null}:{task:state.tasks[0],messages:state.messages}};
    if(state.fail){state.fail=false;throw new TypeError('network unavailable');}
    if(path==='/api/chat/tasks'&&options.method==='POST'){const data=JSON.parse(options.body);state.tasks=[{id:'a'.repeat(32),title:data.content,status:'queued',receipt_state:'waiting'}];state.messages=[{id:1,role:'user',content:data.content,queued_editable:true}];}
    return {ok:true,status:200,json:async()=>({id:'a'.repeat(32)})};
  }});
  vm.runInContext(app,context); await settle();
  return {nodes,state,calls,storage,run:code=>vm.runInContext(code,context)};
}
test('DOM intake enables zero-agent text sends and actually blocks attachment transport',async()=>{
  const h=await rootHarness(); assert.equal(h.nodes.get('#send').disabled,false);
  const before=h.calls.length;h.nodes.get('#attach').onclick();assert.equal(h.calls.length,before);assert.match(h.nodes.get('#hint').textContent,/文件不会传送/);
  h.nodes.get('#input').value='A real question';await h.nodes.get('#composer').handlers.submit({preventDefault(){}});await settle();
  const sent=h.calls.find(c=>c.path==='/api/chat/tasks'&&c.options.method==='POST');
  assert.deepEqual(JSON.parse(sent.options.body),{content:'A real question',attachments:[],agent_id:null});
  assert.equal(sent.options.headers['X-CSRF-Token'],'csrf-test');assert.ok(sent.options.headers['X-Idempotency-Key']);
  assert.equal(h.run('currentId'),'a'.repeat(32));assert.equal(h.nodes.get('#input').value,'');
  assert.match(h.nodes.get('#chatStatus').textContent,/已收到，等待接收/);
});
test('all root mutation methods reuse uncertain request keys and rotate after success',async()=>{
  const h=await rootHarness();
  for(const [method,path,body] of [['POST','/pin','{"pinned":true}'],['DELETE','',''],['PATCH','/messages/1','{"content":"edit"}'],['POST','/queue/reorder','{"message_ids":[1]}']]){
    const endpoint='/api/tasks/'+'b'.repeat(32)+path;h.state.fail=true;
    const script=`api(${JSON.stringify(endpoint)},{method:${JSON.stringify(method)},body:${JSON.stringify(body)}})`;
    await assert.rejects(h.run(script),/连接中断/);await h.run(script);await h.run(script);
    const writes=h.calls.filter(c=>c.path===endpoint.replace('/api/tasks','/api/chat/tasks')&&c.options.method===method);
    assert.equal(writes[0].options.headers['X-Idempotency-Key'],writes[1].options.headers['X-Idempotency-Key']);
    assert.notEqual(writes[1].options.headers['X-Idempotency-Key'],writes[2].options.headers['X-Idempotency-Key']);
    assert.ok(writes.every(c=>c.options.headers['X-CSRF-Token']==='csrf-test'));
  }
});
test('verified principal changes clear all private DOM, drafts and mutation receipts before next action',async()=>{
  const h=await rootHarness();h.run("input.value='PRIVATE DRAFT';saveDraft();pendingRequests.set('old',{key:'old'});messages.textContent='PRIVATE MESSAGE'");
  h.state.me={...h.state.me,role:'owner',identity:'owner',csrfToken:'csrf-owner'};
  await assert.rejects(h.run("api('/api/tasks',{method:'POST',body:'{\"content\":\"old text\"}'})"),/身份已改变/);
  assert.equal(h.run('drafts.size'),0);assert.equal(h.run('pendingRequests.size'),0);assert.equal(h.nodes.get('#input').value,'');
  assert.doesNotMatch(h.nodes.get('#messages').textContent,/PRIVATE/);
  assert.equal(h.calls.filter(c=>c.path==='/api/chat/tasks'&&c.options.method==='POST').length,0);
  assert.deepEqual([...h.storage.keys()],['task-chat-theme']);
});
test('optional signup sends only username/password and refreshes identity without credential persistence',async()=>{
  const h=await rootHarness();h.run("accountModeChanged('signup');usernameInput.value='小明';passwordInput.value='123456'");
  await h.run('accountForm.onsubmit({preventDefault(){}})');await settle();
  const signup=h.calls.find(c=>c.path==='/api/chat/account/signup');
  assert.deepEqual(JSON.parse(signup.options.body),{username:'小明',password:'123456'});
  assert.equal(signup.options.headers['X-CSRF-Token'],'csrf-test');assert.ok(signup.options.headers['X-Idempotency-Key']);
  assert.equal(h.run('identity.role'),'account');assert.equal(h.run('passwordInput.value'),'');
  assert.equal(h.run('pendingRequests.size'),0);assert.equal(h.run('drafts.size'),0);
});
test('delayed identity response cannot restore a cleared principal or overwrite a newer check',async()=>{
  const h=await rootHarness();h.state.holdIdentity=true;
  const old=h.run('initializeIdentity()');h.run('clearPrincipal()');
  h.state.me={...h.state.me,role:'account',identity:'account:new',username:'New',csrfToken:'csrf-new'};
  await h.run('initializeIdentity()');h.state.releaseIdentity();await assert.rejects(old,/验证已失效/);
  assert.equal(h.run('identity.identity'),'account:new');assert.equal(h.run('identityReady'),true);
});
async function adminHarness() {
  const nodes=new Map();const node=key=>{if(!nodes.has(key))nodes.set(key,new FakeNode());return nodes.get(key);};
  const calls=[];const state={owner:true,role:'account',id:'a'.repeat(32),task:{id:'a'.repeat(32),title:'Question',kind:'visitor_question',identity:'visitor:123456',principal_role:'visitor',summary:'',category:'未分类',receipt_state:'waiting'},messages:[{id:1,role:'user',content:'<script>not executed</script>'}],fail:false};
  const context=vm.createContext({console,crypto:globalThis.crypto,AbortController,Error,TypeError,Set,Map,Object,Number,Array,JSON,setTimeout,clearTimeout,setInterval(){},window:{addEventListener(){}},document:{hidden:false,querySelector:node,createElement:tag=>new FakeNode(tag),addEventListener(){}},fetch:async(path,options)=>{
    calls.push({path,options});const response=data=>({ok:true,status:200,json:async()=>data});
    if(path==='/api/session'){
      const session={authenticated:state.owner,csrfToken:'csrf-owner',owner:{name:'Owner'}};
      if(state.holdIdentity){state.holdIdentity=false;return new Promise(resolve=>state.releaseIdentity=()=>resolve(response(session)));}
      return response(session);
    }
    if(path==='/api/chat/me')return response({role:state.role,identity:'account:test',csrfToken:'csrf-account',username:'Reader'});
    if((options.method||'GET')==='GET')return response(path.includes('?')?{tasks:[state.task],has_more:false,next_offset:null}:{task:state.task,messages:state.messages});
    if(state.fail){state.fail=false;throw new TypeError('network');}
    if(path.endsWith('/replies')){
      const content=JSON.parse(options.body).content;
      return new Promise(resolve=>state.releaseReply=()=>{state.messages.push({id:2,role:'agent',content});state.task.receipt_state='replied';resolve(response({id:2}));});
    }
    if(path.endsWith('/metadata'))Object.assign(state.task,JSON.parse(options.body));
    return response({id:state.id});
  }});
  vm.runInContext(admin,context);await settle();return {nodes,calls,state,run:code=>vm.runInContext(code,context)};
}
test('owner records use actual reply success, prevent double sends, and save manual metadata safely',async()=>{
  const h=await adminHarness();await h.run(`openDetail('${h.state.id}')`);
  assert.equal(h.nodes.get('#replyForm').hidden,false);assert.match(h.nodes.get('#threadMessages').textContent,/<script>not executed/);
  h.nodes.get('#reply').value='A saved reply';const first=h.nodes.get('#replyForm').onsubmit({preventDefault(){}});await settle();
  await h.nodes.get('#replyForm').onsubmit({preventDefault(){}});
  assert.equal(h.calls.filter(c=>c.path.endsWith('/replies')).length,1);assert.doesNotMatch(h.nodes.get('#threadMessages').textContent,/A saved reply/);
  h.state.releaseReply();await first;assert.match(h.nodes.get('#threadMessages').textContent,/A saved reply/);
  h.nodes.get('#summary').value='Reviewed summary';h.nodes.get('#category').value='Support';h.state.fail=true;
  await h.nodes.get('#metadataForm').onsubmit({preventDefault(){}});await h.nodes.get('#metadataForm').onsubmit({preventDefault(){}});
  const writes=h.calls.filter(c=>c.path.endsWith('/metadata'));assert.equal(writes[0].options.headers['X-Idempotency-Key'],writes[1].options.headers['X-Idempotency-Key']);
  assert.equal(writes[0].options.headers['X-CSRF-Token'],'csrf-owner');assert.equal(h.state.task.summary,'Reviewed summary');assert.match(h.nodes.get('#records').textContent,/访客 123456/);
});
test('regular account records omit owner controls and stale session results cannot restore owner UI',async()=>{
  const h=await adminHarness();h.state.holdIdentity=true;const old=h.run('verifyAccount()');h.run('clearPrivateState()');h.state.owner=false;
  await h.run('loadRecords()');h.state.releaseIdentity();await assert.rejects(old,/登录验证已失效/);
  assert.equal(h.run('account.role'),'account');await h.run(`openDetail('${h.state.id}')`);
  assert.equal(h.nodes.get('#replyForm').hidden,true);assert.equal(h.nodes.get('#metadataForm').hidden,true);
  assert.equal(h.calls.some(c=>c.path.startsWith('/api/chat/tasks?')),true);
});
