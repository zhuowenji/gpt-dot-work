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
  assert.equal([...admin.matchAll(/localStorage\.setItem\(/g)].length, 1);
  assert.match(admin, /localStorage\.setItem\('task-chat-theme', theme\)/);
  assert.doesNotMatch(admin, /sessionStorage/);
  assert.match(app, /drafts\.clear\(\)/); assert.match(app, /previousPrincipal !== identityKey/);
  assert.match(admin, /before !== accountKey/);
});
test('accounts are optional footer UI with two credential fields and existing owner auth', () => {
  assert.match(app, /document\.querySelector\('\.identity'\)\.append\(accountFooter\)/);
  assert.match(app, /usernameInput\.name = 'username'/); assert.match(app, /passwordInput\.name = 'password'/);
  assert.match(app, /signup' \? 6 : 1/);
  assert.match(app, /\/api\/chat\/account\//);
  assert.match(admin, /raw\('\/api\/login'/);
  assert.doesNotMatch(admin, /raw\('\/api\/chat\/me'/);
  assert.match(admin, /function basePath\(\) \{ return '\/api\/admin\/chat\/tasks'/);
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
  scrollIntoView() {}
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
  const location={hash:'',pathname:'/',search:''}; const navigationHandlers={};
  const window={location,history:{pushState(_a,_b,url){location.hash=url.includes('#')?'#'+url.split('#')[1]:'';},replaceState(_a,_b,url){location.hash=url.includes('#')?'#'+url.split('#')[1]:'';}},addEventListener(name,handler){navigationHandlers[name]=handler;}};
  const state={me:{role:'visitor',identity:'guest-test',ip:'127.0.0.1',csrfToken:'csrf-test',intake_enabled:true,execution_connected:false,uploads_enabled:false},tasks:[],messages:[],fail:false};
  const document={hidden:false,visibilityState:'visible',body:new FakeNode('body'),documentElement:{dataset:{theme:'light'}},querySelector:node,querySelectorAll:()=>[],createElement:tag=>new FakeNode(tag),createTextNode:text=>{const n=new FakeNode('text');n.textContent=text;return n;},addEventListener(){}};
  const context=vm.createContext({console,crypto:globalThis.crypto,AbortController,Error,TypeError,Set,Map,Object,Number,Array,JSON,setTimeout,clearTimeout,setInterval(){},document,window,localStorage:{getItem:key=>storage.get(key)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},Option:class extends FakeNode{constructor(text,value){super('option');this.textContent=text;this.value=value;}},fetch:async(path,options)=>{
    calls.push({path,options});
    if(path==='/api/chat/me'){const snapshot={...state.me};if(state.holdIdentity){state.holdIdentity=false;return new Promise(resolve=>{state.releaseIdentity=()=>resolve({ok:true,status:200,json:async()=>snapshot});});}return {ok:true,status:200,json:async()=>snapshot};}
    if(path.startsWith('/api/chat/account/')){state.me={...state.me,role:'account',identity:'account:test',csrfToken:'csrf-account',username:'小明'};return {ok:true,status:200,json:async()=>({authenticated:true})};}
    if(options.method==='GET')return {ok:true,status:200,json:async()=>path.includes('?')?{tasks:state.tasks,has_more:false,next_offset:null}:{task:state.tasks[0],messages:state.messages}};
    if(state.holdWrite){state.holdWrite=false;return new Promise(resolve=>state.releaseWrite=()=>resolve({ok:true,status:200,json:async()=>({id:'a'.repeat(32)})}));}
    if(state.fail){state.fail=false;throw new TypeError('network unavailable');}
    if(path==='/api/chat/tasks'&&options.method==='POST'){const data=JSON.parse(options.body);state.tasks=[{id:'a'.repeat(32),title:data.content,status:'queued',receipt_state:'waiting'}];state.messages=[{id:1,role:'user',content:data.content,queued_editable:true}];}
    return {ok:true,status:200,json:async()=>({id:'a'.repeat(32)})};
  }});
  vm.runInContext(app,context); await settle();
  return {nodes,state,calls,storage,window,navigationHandlers,run:code=>vm.runInContext(code,context)};
}
test('DOM intake enables zero-agent text sends and actually blocks attachment transport',async()=>{
  const h=await rootHarness(); assert.equal(h.nodes.get('#send').disabled,false);
  const before=h.calls.length;h.nodes.get('#attach').onclick();assert.equal(h.calls.length,before);assert.match(h.nodes.get('#hint').textContent,/文件不会传送/);
  h.nodes.get('#input').value='A real question';await h.nodes.get('#composer').handlers.submit({preventDefault(){}});await settle();
  const sent=h.calls.find(c=>c.path==='/api/chat/tasks'&&c.options.method==='POST');
  assert.deepEqual(JSON.parse(sent.options.body),{content:'A real question',attachments:[],agent_id:null});
  assert.equal(sent.options.headers['X-CSRF-Token'],'csrf-test');assert.ok(sent.options.headers['X-Idempotency-Key']);
  assert.equal(h.run('currentId'),'a'.repeat(32));assert.equal(h.nodes.get('#input').value,'');
  assert.match(h.nodes.get('#chatStatus').textContent,/已收到，等待所有者回复/);
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
  const calls=[];const state={owner:true,role:'account',id:'a'.repeat(32),task:{id:'a'.repeat(32),title:'Question',kind:'visitor_question',identity:'visitor:123456',principal_role:'visitor',summary:'',category:'未分类',receipt_state:'waiting'},messages:[{id:1,role:'user',content:'<script>not executed</script>'}],memory:[],fail:false};
  const context=vm.createContext({console,crypto:globalThis.crypto,AbortController,Error,TypeError,Set,Map,Object,Number,Array,JSON,setTimeout,clearTimeout,setInterval(){},window:{addEventListener(){}},localStorage:{getItem(){return null;},setItem(){}},Option:class extends FakeNode{constructor(text,value){super('option');this.textContent=text;this.value=value;}},document:{hidden:false,documentElement:{dataset:{}},querySelector:node,querySelectorAll:()=>[],createElement:tag=>new FakeNode(tag),addEventListener(){}},fetch:async(path,options)=>{
    calls.push({path,options});const response=data=>({ok:true,status:200,json:async()=>data});
    if(path==='/api/session'){
      const session={authenticated:state.owner,csrfToken:'csrf-owner',owner:{name:'Owner'}};
      if(state.holdIdentity){state.holdIdentity=false;return new Promise(resolve=>state.releaseIdentity=()=>resolve(response(session)));}
      return response(session);
    }
    if(path==='/api/chat/me')return response({role:state.role,identity:'account:test',csrfToken:'csrf-account',username:'Reader'});
    if((options.method||'GET')==='GET'&&path.endsWith('/memory'))return response({memory:state.memory,context_version:'f'.repeat(64)});
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
test('ordinary account direct admin access stays gated and stale owner checks cannot reopen it',async()=>{
  const h=await adminHarness();h.state.holdIdentity=true;const old=h.run('verifyAccount()');h.run('clearPrivateState()');h.state.owner=false;
  await h.run('loadRecords()');h.state.releaseIdentity();await assert.rejects(old,/登录验证已失效/);
  assert.equal(h.run('account'),null);
  assert.equal(h.nodes.get('#recordsPanel').hidden,true);assert.equal(h.nodes.get('#detailPanel').hidden,true);
  assert.equal(h.nodes.get('#loginPanel').hidden,false);
  assert.equal(h.calls.some(c=>c.path==='/api/chat/me'||c.path.startsWith('/api/chat/tasks')),false);
  assert.equal(h.nodes.get('#records').textContent,'');
});


test('first received message is not duplicated in queue; only later unanswered followups are queued', async () => {
  const h = await rootHarness();
  h.nodes.get('#input').value = 'First received';
  await h.nodes.get('#composer').handlers.submit({preventDefault(){}}); await settle();
  assert.equal(h.nodes.get('#queuedMessages').childElementCount, 0);
  assert.equal(h.nodes.get('#queuedMessages').hidden, true);
  assert.match(h.nodes.get('#messages').textContent, /First received/);
  h.state.messages.push({id:2, role:'user', content:'Second queued', queued_editable:true, queue_position:2}, {id:3, role:'user', content:'Third queued', queued_editable:true, queue_position:3});
  await h.run(`openTask('${'a'.repeat(32)}')`);
  assert.equal(h.nodes.get('#queuedMessages').childElementCount, 2);
  assert.doesNotMatch(h.nodes.get('#messages').textContent, /Second queued|Third queued/);
  assert.equal(h.run('receivedMessageId'), 1);
  h.run('draggedQueueId = 2');
  await h.nodes.get('#queuedMessages').handlers.drop({preventDefault(){}}); await settle();
  const reorder = h.calls.find(call => call.path.endsWith('/queue/reorder'));
  assert.deepEqual(JSON.parse(reorder.options.body).message_ids, [1,2,3]);
  h.state.messages.forEach(entry => entry.queued_editable = false);
  h.state.messages.push({id:4,role:'agent',content:'Actual reply'}); h.state.tasks[0].receipt_state='replied';
  await h.run(`openTask('${'a'.repeat(32)}')`);
  assert.equal(h.nodes.get('#queuedMessages').hidden, true);
  assert.match(h.nodes.get('#messages').textContent, /Second queued/);
  assert.match(h.nodes.get('#messages').textContent, /Actual reply/);
  h.state.messages.push({id:5,role:'user',content:'New question',queued_editable:true});
  await h.run(`openTask('${'a'.repeat(32)}')`);
  assert.equal(h.nodes.get('#queuedMessages').hidden, true);
  assert.equal(h.run('receivedMessageId'), 5);
});
test('failed initial send retains the draft and idempotency key until the exact retry succeeds', async () => {
  const h = await rootHarness(); h.state.fail = true;
  h.nodes.get('#input').value = 'Keep this draft';
  await h.nodes.get('#composer').handlers.submit({preventDefault(){}}); await settle();
  assert.equal(h.nodes.get('#input').value, 'Keep this draft');
  assert.equal(h.run('currentId'), null);
  await h.nodes.get('#composer').handlers.submit({preventDefault(){}}); await settle();
  const writes=h.calls.filter(call=>call.path==='/api/chat/tasks'&&call.options.method==='POST');
  assert.equal(writes[0].options.headers['X-Idempotency-Key'], writes[1].options.headers['X-Idempotency-Key']);
  assert.equal(h.nodes.get('#input').value, '');
  assert.equal(h.nodes.get('#queuedMessages').hidden, true);
});
test('records distinguish actual reply and summary status and knowledge never fabricates content', async () => {
  const h = await adminHarness();
  assert.equal(h.nodes.get('#waitingCount').textContent, '1');
  assert.equal(h.nodes.get('#repliedCount').textContent, '0');
  assert.equal(h.nodes.get('#summarizedCount').textContent, '0');
  h.nodes.get('#knowledgeView').onclick();
  assert.equal(h.nodes.get('#knowledgeList').childElementCount, 0);
  assert.match(h.nodes.get('#emptyTitle').textContent, /没有整理好的摘要/);
  h.state.task.summary = 'Verified saved summary'; h.state.task.category = 'Support'; h.state.task.updated_at = 1800000000;
  await h.run('loadRecords()');
  assert.equal(h.nodes.get('#summarizedCount').textContent, '1');
  assert.equal(h.nodes.get('#waitingCount').textContent, '1');
  assert.match(h.nodes.get('#knowledgeList').textContent, /Verified saved summary/);
  h.nodes.get('#searchRecords').value='missing'; h.nodes.get('#searchRecords').oninput();
  assert.equal(h.nodes.get('#knowledgeList').childElementCount, 0);
  h.nodes.get('#clearFilters').onclick();
  assert.match(h.nodes.get('#knowledgeList').textContent, /Verified saved summary/);
  assert.doesNotMatch(h.nodes.get('#records').textContent, /处理中|执行完成/);
});
test('account dialog styling preserves cancellation and mode switching', async () => {
  const h = await rootHarness();
  assert.equal(h.run('accountFooter.className'), 'account-footer');
  assert.equal(h.run('accountDialog.className'), 'delete-task-dialog account-dialog');
  h.run('accountFooter.children[0].onclick()');
  assert.equal(h.run('accountDialog.open'), true);
  h.run('accountSwitch.onclick()'); assert.equal(h.run('accountHeading.textContent'), '注册账号');
  h.run('accountSwitch.onclick(); accountCancel.onclick()');
  assert.equal(h.run('accountDialog.open'), false);
});

test('selected thread survives safe refresh restoration, new-draft history, and clears on principal change', async () => {
  const h=await rootHarness(); h.nodes.get('#input').value='Thread one';
  await h.nodes.get('#composer').handlers.submit({preventDefault(){}}); await settle();
  const hash='#thread='+'a'.repeat(32);
  assert.equal(h.window.location.hash,hash);
  h.run('clearPrincipal({preserveNavigation:true})');
  assert.equal(h.window.location.hash,hash);
  await h.run('initializeIdentity()'); await h.run('restoreNavigation()');
  assert.equal(h.run('currentId'),'a'.repeat(32));
  h.run('newTask()'); h.nodes.get('#input').value='Keep unsent new draft';
  h.window.location.hash=hash; await h.run('restoreNavigation()');
  assert.equal(h.run('currentId'),'a'.repeat(32));
  h.window.location.hash=''; await h.run('restoreNavigation()');
  assert.equal(h.nodes.get('#input').value,'Keep unsent new draft');
  h.window.location.hash=hash; await h.run('restoreNavigation()');
  await settle();
  h.state.me={...h.state.me,identity:'account:other',role:'account',csrfToken:'other-csrf'};
  await h.run('initializeIdentity()');
  assert.equal(h.window.location.hash,''); assert.equal(h.run('currentId'),null);
  assert.doesNotMatch(h.nodes.get('#messages').textContent,/Thread one/);
  assert.equal(h.run('drafts.size'),0);
});
test('saving metadata does not erase an unrelated pending reply draft', async () => {
  const h=await adminHarness(); await h.run(`openDetail('${h.state.id}')`);
  h.nodes.get('#reply').value='Unsent reply draft'; h.nodes.get('#summary').value='Actual summary';
  await h.nodes.get('#metadataForm').onsubmit({preventDefault(){}});
  assert.equal(h.nodes.get('#reply').value,'Unsent reply draft');
  assert.match(h.nodes.get('#detailSummary').textContent,/Actual summary/);
});

test('polling is bounded, skips overlapping work, and backs off without inventing execution', async () => {
  const h=await rootHarness();
  h.run("currentId='a'.repeat(32); currentReceiptState='waiting'; rapidPollUntil=Date.now()+30000");
  assert.equal(h.run('pollingDelay()'),1000);
  h.run('rapidPollUntil=Date.now()-1'); assert.equal(h.run('pollingDelay()'),5000);
  h.run('rapidPollUntil=Date.now()+30000; currentReceiptState="replied"'); assert.equal(h.run('pollingDelay()'),5000);
  h.run('currentReceiptState="waiting"; rapidPollRemaining=0'); assert.equal(h.run('pollingDelay()'),5000);
  h.run('pollFailures=4'); assert.equal(h.run('pollingDelay()'),30000);
  const before=h.calls.length; h.run('pollInFlight=true'); await h.run('refresh()'); assert.equal(h.calls.length,before);
});
test('memory panel shows server provenance and uncertainty, with no automatic entries', async () => {
  const h=await adminHarness(); await h.run(`openDetail('${h.state.id}')`); await settle();
  assert.match(h.nodes.get('#memoryNotice').textContent,/没有已审阅的记忆/);
  h.state.memory=[{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',version:2,type:'preference',key:'输出语言',value:'简体中文',certainty:'inferred',status:'active',source_message_ids:[1],updated_at:1800000000000}];
  await h.run(`loadMemory('${h.state.id}')`);
  const text=h.nodes.get('#memoryList').textContent;
  assert.match(text,/简体中文/); assert.match(text,/推断，需核实/); assert.match(text,/来源消息：#1/); assert.match(text,/版本 2/);
  h.run('clearPrivateState()'); assert.equal(h.nodes.get('#memoryList').textContent,'');
});

test('browser navigation during an in-flight submit is honored after acknowledgement without replaying the draft', async () => {
  const h=await rootHarness(); h.nodes.get('#input').value='Initial question';
  await h.nodes.get('#composer').handlers.submit({preventDefault(){}}); await settle();
  h.state.holdWrite=true; h.nodes.get('#input').value='Delayed followup';
  const pending=h.nodes.get('#composer').handlers.submit({preventDefault(){}}); await settle();
  h.window.location.hash=''; await h.run('restoreNavigation()');
  assert.equal(h.run('busy'),true);
  h.state.releaseWrite(); await pending; await settle();
  assert.equal(h.run('currentId'),null); assert.equal(h.window.location.hash,'');
  assert.equal(h.nodes.get('#input').value,'');
  assert.equal(h.calls.filter(call=>call.path.endsWith('/messages')&&call.options.method==='POST').length,1);
});

test('ordinary frontend accounts retain their own chat but have no admin navigation', async () => {
  const h=await rootHarness(); await settle();
  h.state.me={...h.state.me,role:'account',identity:'account:normal',csrfToken:'csrf-normal'};
  await h.run('initializeIdentity()'); h.run('clearError(); updateAccountFooter()');
  assert.doesNotMatch(h.nodes.get('#hint').textContent,/查看.*记录/);
  assert.equal(h.run("accountFooter.children.some(node => node.tagName === 'A' && node.href === '/admin/')"),false);
  assert.equal(h.nodes.get('#send').disabled,false);
});


test('visitor terminal execution failures replace waiting text with clear recovery guidance', async () => {
  const h = await rootHarness(), id = 'a'.repeat(32);
  h.state.tasks = [{ id, title: 'Question', receipt_state: 'waiting', execution_error: 'lease_retry_exhausted' }];
  h.state.messages = [{ id: 1, role: 'user', content: 'Question', queued_editable: true }];
  await h.run(`openTask('${id}')`);
  assert.match(h.nodes.get('#chatStatus').textContent, /自动回复未完成/);
  assert.match(h.nodes.get('#messages').textContent, /新建对话重试/);
  assert.doesNotMatch(h.nodes.get('#messages').textContent, /等待所有者回复|连接器尚未配置/);
  h.state.tasks[0].execution_error = 'reply_capacity'; await h.run(`openTask('${id}')`);
  assert.match(h.nodes.get('#chatStatus').textContent, /容量不足/);
  assert.match(h.nodes.get('#messages').textContent, /容量已满.*新建对话/);
  delete h.state.tasks[0].execution_error; await h.run(`openTask('${id}')`);
  assert.match(h.nodes.get('#messages').textContent, /消息已保存，等待回复/);
  assert.doesNotMatch(h.nodes.get('#messages').textContent, /未能完成/);
});

test('owner records and detail surface terminal execution failures without losing reply controls', async () => {
  const h = await adminHarness();
  h.state.task.execution_error = 'worker_failed'; await h.run('loadRecords()'); await h.run(`openDetail('${h.state.id}')`);
  assert.match(h.nodes.get('#records').textContent, /自动回复失败，需处理/);
  assert.match(h.nodes.get('#detailMeta').textContent, /自动回复失败/);
  assert.match(h.nodes.get('#threadMessages').textContent, /检查执行连接或手动回复/);
  assert.equal(h.nodes.get('#replyForm').hidden, false);
  h.state.task.execution_error = 'reply_capacity'; await h.run(`openDetail('${h.state.id}')`);
  assert.match(h.nodes.get('#threadMessages').textContent, /容量已满/);
});
