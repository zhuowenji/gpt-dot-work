import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createWorkspaceClient,emptyState,defaultVideoSettings,videoSettingsEnvelope,videoSettingsFields,videoSettingsPayload,videoImportPayload,safeDouyinUrl,safeVideoEvidenceUrl,canVerifyVideo} from '../src/model.js';
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
const blankList=()=>({videos:[],total:0,nextCursor:null});
const record=()=>({id:'v1',revision:1,title:'厨房收纳架',videoId:'123456789',canonicalUrl:'https://www.douyin.com/video/123456789',category:'kitchen_non_electric',publishedDate:'2026-10-01',rawPublicationDate:'10月1日',observation:{id:'o1',observedAt:'2026-10-03T10:00:00Z',rawLikeCount:'2,000',observedLikes:2000,likeCountExact:true,source:'本人查看视频页',evidence:[{kind:'page_text',value:'2026-10-01，赞 2,000',url:null}]},verification:{state:'candidate',note:'',verifiedAt:null},screening:{matches:true,missing:[],reasons:[],windowStart:'2026-09-04',windowEnd:'2026-10-04'}});
const importFields=()=>({url:'https://www.douyin.com/video/123456789',title:'厨房收纳架',category:'kitchen_non_electric',publishedDate:'2026-10-01',rawPublicationDate:'10月1日',rawLikeCount:'2,000',observedLikes:'2000',likeCountExact:true,observedAt:'2026-10-03T10:00',observedTimezone:'+08:00',source:'本人查看视频页',evidenceKind:'page_text',evidenceValue:'实际页面原文',evidenceUrl:''});

test('Douyin client shares private cookies and in-memory CSRF with stable mutation keys',async()=>{
  const calls=[];const client=createWorkspaceClient(async(path,options)=>{calls.push({path,options});return response(path==='/api/video-settings'?defaultVideoSettings():{});});client.setCsrfToken('memory-only');
  await client.getVideoSettings();await client.saveVideoSettings(videoSettingsPayload(videoSettingsFields(defaultVideoSettings()),0));
  await client.listVideos('candidate','a/b?x=1');await client.getVideo('id/with spaces');await client.ingestVideos([videoImportPayload(importFields())],'same-import-key');await client.verifyVideo('v1',{revision:3,state:'verified',note:'已核对'},'same-review-key');
  assert.equal(calls[2].path,'/api/videos?view=candidate&limit=50&cursor=a%2Fb%3Fx%3D1');assert.equal(calls[3].path,'/api/videos/id%2Fwith%20spaces');
  assert.equal(calls[4].options.headers['Idempotency-Key'],'same-import-key');assert.equal(calls[5].options.headers['Idempotency-Key'],'same-review-key');assert.equal(calls[5].options.method,'PATCH');
  for(const c of calls){assert.equal(c.options.credentials,'same-origin');assert.equal(c.options.cache,'no-store');if(c.options.method!=='GET')assert.equal(c.options.headers['X-CSRF-Token'],'memory-only');}
  assert.equal(JSON.parse(calls[1].options.body).revision,0);assert.equal(JSON.parse(calls[1].options.body).runtime,undefined);
});
test('settings preserve fixed categories/exclusions/window and inactive scheduling semantics',()=>{
  const settings=defaultVideoSettings(),fields=videoSettingsFields(settings);fields.requestedEnabled=true;fields.keywords='收纳，厨房,收纳';
  const payload=videoSettingsPayload(fields,5);assert.equal(payload.revision,5);assert.equal(payload.criteria.windowMonths,1);assert.deepEqual(payload.criteria.excludedCategories,['appliance','inflatable_bed']);assert.deepEqual(payload.criteria.keywords,['收纳','厨房']);assert.equal(payload.schedule.requestedEnabled,true);assert.equal(payload.schedule.timezone,'Asia/Shanghai');assert.equal(settings.runtime.schedulerActive,false);
  for(const override of [{minLikes:''},{minLikes:'4',maxLikes:'3'},{minLikes:'2.5'},{maxLikes:'1000000000001'},{categories:[]},{categories:['appliance']},{intervalMinutes:'14'},{intervalMinutes:'1441'},{keywords:Array.from({length:13},(_,i)=>'字'+i).join(',')}])assert.throws(()=>videoSettingsPayload({...fields,...override},0));
  assert.throws(()=>videoSettingsEnvelope({...settings,revision:'0'}));assert.throws(()=>videoSettingsEnvelope({...settings,runtime:{}}));
});
test('manual import retains raw text and uncertainty and emits complete zoned timestamps',()=>{
  const precise=videoImportPayload(importFields());assert.equal(precise.observedAt,'2026-10-03T10:00:00+08:00');assert.equal(precise.rawLikeCount,'2,000');assert.equal(precise.observedLikes,2000);assert.equal(precise.likeCountExact,true);
  const uncertain=videoImportPayload({...importFields(),publishedDate:'',rawPublicationDate:'3 天前',rawLikeCount:'1.2万',observedLikes:'',likeCountExact:false,evidenceValue:''});
  assert.equal(uncertain.publishedDate,null);assert.equal(uncertain.observedLikes,null);assert.equal(uncertain.rawPublicationDate,'3 天前');assert.deepEqual(uncertain.evidence,[]);assert.equal(uncertain.verification,undefined);
  assert.throws(()=>videoImportPayload({...importFields(),rawLikeCount:'2千'}),/缩写/);assert.throws(()=>videoImportPayload({...importFields(),observedLikes:''}),/精确/);assert.throws(()=>videoImportPayload({...importFields(),publishedDate:'2026-02-30'}));assert.throws(()=>videoImportPayload({...importFields(),publishedDate:'2026-10-04'}),/晚于/);assert.throws(()=>videoImportPayload({...importFields(),evidenceValue:'',evidenceUrl:'https://example.com/proof'}),/证据内容/);
});
test('video/evidence links reject scripts, impostor hosts, credentials, roots and unsafe protocols',()=>{
  assert.ok(safeDouyinUrl('https://v.douyin.com/abcdEF/'));assert.ok(safeDouyinUrl('https://www.douyin.com/video/123456'));assert.ok(safeDouyinUrl('https://www.douyin.com/?modal_id=123456'));
  for(const url of ['javascript:alert(1)','https://www.douyin.com.evil.test/video/123456','https://evil.douyin.com/video/123456','https://user:pass@www.douyin.com/video/123456','http://www.douyin.com/video/123456','https://www.douyin.com/','https://www.douyin.com:8443/video/123456'])assert.equal(safeDouyinUrl(url),null);
  assert.equal(safeVideoEvidenceUrl('data:text/html,hello'),null);assert.equal(safeVideoEvidenceUrl('http://example.com/image.png'),null);assert.equal(safeVideoEvidenceUrl('https://user:pass@example.com/'),null);assert.ok(safeVideoEvidenceUrl('https://example.com/image.png'));
});
test('verification eligibility requires matching criteria, exact number, date and non-note evidence',()=>{
  assert.equal(canVerifyVideo(record()),true);
  for(const change of [v=>v.screening.matches=false,v=>v.publishedDate=null,v=>v.observation.likeCountExact=false,v=>v.observation.observedLikes=null,v=>v.observation.evidence=[{kind:'manual_note',value:'我觉得符合'}],v=>v.observation.evidence=[]]){const v=record();change(v);assert.equal(canVerifyVideo(v),false);}
});

async function harness(fetcher,{server=true,hash='#douyin'}={}) {
  const app={innerHTML:''},dialog={innerHTML:'',dataset:{},open:false,close(){this.open=false;},showModal(){this.open=true;},addEventListener(){},querySelector(){return null;},querySelectorAll(){return [];}};
  const toast={textContent:'',classList:{add(){},remove(){}}},nodes=new Map(),groups=new Map();let localReads=0,localWrites=0;
  class Fields {constructor(form){this.fields=form.fields;}get(name){return this.getAll(name)[0]??null;}getAll(name){const v=this.fields[name];return v===false||v===undefined||v===null?[]:Array.isArray(v)?v:[v===true?'on':String(v)];}has(name){return this.getAll(name).length>0;}*[Symbol.iterator](){for(const name of Object.keys(this.fields))for(const value of this.getAll(name))yield [name,value];}}
  const context=vm.createContext({structuredClone,FormData:Fields,URL,Blob,crypto:globalThis.crypto,console,fetch:fetcher,localStorage:{getItem(){localReads++;return null;},setItem(){localWrites++;}},setTimeout(){return 1;},clearTimeout(){},location:{hash},window:{addEventListener(){}},document:{hidden:false,addEventListener(){},querySelectorAll(q){return groups.get(q)||[];},querySelector(q){if(q==='meta[name="workspace-mode"]')return server?{content:'server'}:null;if(q==='#app')return app;if(q==='#note-dialog')return dialog;if(q==='#toast')return toast;return nodes.get(q)||null;}}});
  const model=(await readFile(new URL('../src/model.js',import.meta.url),'utf8')).replaceAll('export ','');
  const source=(await readFile(new URL('../src/app.js',import.meta.url),'utf8')).replace(/^import .*?;\n/,'');vm.runInContext(model+'\n'+source,context);await new Promise(resolve=>setImmediate(resolve));
  return {app,dialog,nodes,groups,context,reads:()=>localReads,writes:()=>localWrites,run:code=>vm.runInContext(code,context)};
}
const baseFetch=async(path)=>response(path==='/api/session'?{authenticated:true,csrfToken:'csrf',owner:{name:'Owner'}}:path==='/api/workspace'?{revision:0,workspace:emptyState()}:path==='/api/video-settings'?defaultVideoSettings():path.startsWith('/api/videos?')?blankList():{tasks:[],nextCursor:null});
function fakeForm(fields) {return {fields,addEventListener(){},querySelectorAll(){return [];},querySelector(){return null;}};}

test('integrated page loads only authenticated video endpoints and truthfully disables collection',async()=>{
  const paths=[];const h=await harness(async(path,...args)=>{paths.push(path);return baseFetch(path,...args);});
  assert.ok(paths.includes('/api/video-settings'));assert.ok(paths.includes('/api/videos?view=all&limit=50'));assert.equal(h.reads(),0);assert.equal(h.writes(),0);
  assert.match(h.app.innerHTML,/href="#douyin"/);assert.match(h.app.innerHTML,/自动采集不可用/);assert.match(h.app.innerHTML,/定时检查：未启用/);assert.match(h.app.innerHTML,/<button[^>]*disabled[^>]*>立即采集（不可用）/);assert.match(h.app.innerHTML,/此视图暂无视频记录/);assert.doesNotMatch(h.app.innerHTML,/厨房收纳架/);
});
test('offline demo never fetches, caches or invents Douyin records',async()=>{
  const paths=[];const h=await harness(async path=>{paths.push(path);throw new Error('should not fetch');},{server:false});assert.deepEqual(paths,[]);assert.match(h.app.innerHTML,/离线演示：抖音数据功能不可用/);assert.match(h.app.innerHTML,/这里没有演示视频/);assert.equal(h.writes(),0);assert.equal(h.run('videos.length'),0);
});
test('session lock hides private videos while retaining pending inputs and original revision',async()=>{
  const h=await harness(baseFetch);h.run(`videos=[${JSON.stringify(record())}];videoSettingsDraft={categories:['household_general'],minLikes:'1111',maxLikes:'2222',keywords:'未保存',requestedEnabled:true,intervalMinutes:'60'};videoSettingsDraftRevision=3;videoImportDraft={title:'未保存候选'};videoReviewDraft={id:'v1',note:'未保存备注'};lockSession('expired');`);
  assert.equal(h.run('videos.length'),0);assert.equal(h.run('videoSettings'),null);assert.equal(h.run('videoSettingsDraftRevision'),3);assert.equal(h.run('videoImportDraft.title'),'未保存候选');assert.match(h.app.innerHTML,/未保存的内容/);assert.doesNotMatch(h.app.innerHTML,/厨房收纳架/);
});
test('settings conflict keeps input/base revision and separately displays latest server values',async()=>{
  let latest=false;const saves=[];const h=await harness(async(path,options)=>{if(path==='/api/video-settings'&&options.method==='PUT'){saves.push(JSON.parse(options.body));latest=true;return response({error:{code:'video_settings_conflict',message:'changed'}},409);}if(path==='/api/video-settings'){const s=defaultVideoSettings();s.revision=latest?9:2;s.criteria.minLikes=latest?1500:1000;return response(s);}return baseFetch(path,options);});
  await h.run("videoSettingsDraft={...videoSettingsFields(videoSettings),minLikes:'1200'};videoSettingsDraftRevision=2;saveVideoSettings()");
  assert.equal(saves[0].revision,2);assert.equal(h.run('videoSettingsDraft.minLikes'),'1200');assert.equal(h.run('videoSettingsDraftRevision'),2);assert.equal(h.run('videoSettings.revision'),9);assert.equal(h.run('videoSettingsConflict'),true);assert.match(h.app.innerHTML,/当前服务器设置/);assert.match(h.app.innerHTML,/已比较，基于最新版本继续编辑/);
});
test('expired settings save preserves pending preferences and does not claim success',async()=>{
  const h=await harness(async(path,options)=>path==='/api/video-settings'&&options.method==='PUT'?response({error:{code:'unauthorized',message:'expired'}},401):baseFetch(path,options));
  await h.run("videoSettingsDraft={...videoSettingsFields(videoSettings),minLikes:'1800'};videoSettingsDraftRevision=0;saveVideoSettings()");assert.equal(h.run('phase'),'login');assert.equal(h.run('videoSettingsDraft.minLikes'),'1800');assert.equal(h.run('videoSettingsDraftRevision'),0);assert.equal(h.run('videoSettingsSaving'),false);
});
test('a successful settings save clears only its draft, preserves inactive runtime and refreshes results',async()=>{
  const h=await harness(async(path,options)=>{if(path==='/api/video-settings'&&options.method==='PUT'){const body=JSON.parse(options.body);return response({...defaultVideoSettings(),...body,revision:body.revision+1});}return baseFetch(path,options);});
  await h.run("videoSettingsDraft={...videoSettingsFields(videoSettings),requestedEnabled:true};videoSettingsDraftRevision=0;saveVideoSettings()");assert.equal(h.run('videoSettingsDraft'),null);assert.equal(h.run('videoSettings.schedule.requestedEnabled'),true);assert.equal(h.run('videoSettings.runtime.schedulerActive'),false);assert.match(h.app.innerHTML,/定时检查：未启用/);
});
test('late result from an earlier filter cannot overwrite newer navigation',async()=>{
  let resolveOld;const h=await harness(async(path,options)=>{if(path.includes('view=candidate'))return new Promise(resolve=>resolveOld=resolve);if(path.includes('view=excluded'))return response({...blankList(),videos:[{...record(),id:'excluded',title:'最新筛选结果'}],total:1});return baseFetch(path,options);});
  const old=h.run("videoView='candidate';refreshVideos()");await h.run("videoView='excluded';refreshVideos()");resolveOld(response({...blankList(),videos:[record()],total:1}));await old;assert.equal(h.run('videos[0].id'),'excluded');assert.match(h.app.innerHTML,/最新筛选结果/);
});
test('closing video details invalidates an outstanding response without reopening dialog',async()=>{
  let resolveDetail;const h=await harness(async(path,options)=>path==='/api/videos/v1'?new Promise(resolve=>resolveDetail=resolve):baseFetch(path,options));
  const pending=h.run("openVideoDetail('v1')");assert.equal(h.dialog.open,true);h.run('closeModal()');resolveDetail(response({video:record(),observations:[record().observation],verificationEvents:[]}));await pending;assert.equal(h.dialog.open,false);assert.equal(h.run('videoDetailId'),null);assert.equal(h.dialog.innerHTML,'');
});
test('video, raw evidence, source and review notes are escaped rather than rendered as HTML',async()=>{
  const h=await harness(baseFetch),v=record();v.title='<img src=x onerror=alert(1)>';v.observation.source='<script>alert(1)</script>';v.observation.evidence[0].value='<svg onload=alert(1)>';v.verification.note='<b>not markup</b>';const markup=h.run(`videoDetailMarkup({video:${JSON.stringify(v)},observations:[],verificationEvents:[]})`);
  assert.match(markup,/&lt;img/);assert.match(markup,/&lt;script/);assert.match(markup,/&lt;svg/);assert.match(markup,/&lt;b&gt;/);assert.doesNotMatch(markup,/<script>|<svg onload|<img src=x/);
});
test('candidate import retries use one idempotency key and success cannot resurrect its form draft',async()=>{
  const keys=[];let fail=true;const h=await harness(async(path,options)=>{if(path==='/api/videos/ingest'){keys.push(options.headers['Idempotency-Key']);if(fail)throw new Error('network');return response({created:1,updated:0,unchanged:0,results:[{id:'v1'}]});}return baseFetch(path,options);});
  const form=fakeForm(importFields()),error={textContent:''};h.nodes.set('#video-import-form',form);h.nodes.set('#video-import-error',error);h.run('videoImportEditor()');await form.onsubmit({preventDefault(){}});assert.match(error.textContent,/无法确认/);assert.equal(h.run('videoImportDraft.title'),'厨房收纳架');fail=false;await form.onsubmit({preventDefault(){}});assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.equal(h.run('videoImportDraft'),null);assert.equal(h.dialog.open,false);
});
test('verification requires explicit consent and note, preserves note on conflict and blocks repeat clicks',async()=>{
  const calls=[];let resolveReview;const h=await harness(async(path,options)=>{if(path==='/api/videos/v1/verification'){calls.push(options);return new Promise(resolve=>resolveReview=resolve);}return baseFetch(path,options);});
  const button={dataset:{videoDecision:'verified'},disabled:false},consent={checked:false,disabled:false},note={value:'核对过来源',addEventListener(){}},error={textContent:''};const form=fakeForm({});form.querySelector=()=>button;
  h.nodes.set('#video-review-form',form);h.nodes.set('#video-review-note',note);h.nodes.set('#video-verify-consent',consent);h.nodes.set('#video-review-error',error);h.groups.set('[data-video-decision]',[button]);h.run(`videoDetailId='v1';bindVideoDetail(${JSON.stringify(record())})`);
  await button.onclick();assert.equal(calls.length,0);assert.match(error.textContent,/勾选/);consent.checked=true;note.value='';await button.onclick();assert.equal(calls.length,0);assert.match(error.textContent,/核验依据/);note.value='核对过来源';const first=button.onclick();await button.onclick();assert.equal(calls.length,1);resolveReview(response({error:{code:'video_revision_conflict',message:'changed'}},409));await first;assert.equal(h.run('videoReviewDraft.note'),'核对过来源');assert.match(error.textContent,/重新读取/);assert.equal(h.run('videoMutationBusy'),false);
});
test('source never persists Douyin server data in localStorage and all imports stay in existing build model',async()=>{
  const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');assert.doesNotMatch(source,/localStorage\.setItem\([^\n]*(?:video|csrf|password)/i);assert.equal(source.match(/^import /gm).length,1);assert.match(source,/view==='douyin'\?douyin\(\)/);
});

test('publication uses its own explicit revision-safe CSRF/idempotent endpoint',async()=>{
  let call;const client=createWorkspaceClient(async(path,options)=>{call={path,options};return response({video:{publication:{isPublic:true}}});});client.setCsrfToken('csrf');await client.publishVideo('private/id',{revision:7,isPublic:true},'public-op');assert.equal(call.path,'/api/videos/private%2Fid/publication');assert.equal(call.options.method,'PATCH');assert.equal(call.options.headers['X-CSRF-Token'],'csrf');assert.equal(call.options.headers['Idempotency-Key'],'public-op');assert.deepEqual(JSON.parse(call.options.body),{revision:7,isPublic:true});
});
test('publication panel stays private by default, discloses exact audience/data, and only opens for verified matches',async()=>{
  const h=await harness(baseFetch),v=record();let markup=h.run(`videoPublicationMarkup(${JSON.stringify(v)})`);assert.match(markup,/仅在你的私有工作空间/);assert.doesNotMatch(markup,/id="video-publication-consent"/);v.verification.state='verified';markup=h.run(`videoPublicationMarkup(${JSON.stringify(v)})`);assert.match(markup,/标题、商品类别、抖音链接、发布日期、观察到的点赞数、观察时间和已核验标签/);assert.match(markup,/任何拿到公开链接的人都可查看/);assert.match(markup,/原始证据与核验备注不会公开/);assert.match(markup,/<input id="video-publication-consent" type="checkbox">/);assert.doesNotMatch(markup,/checked/);v.publication={isPublic:true};markup=h.run(`videoPublicationMarkup(${JSON.stringify(v)})`);assert.match(markup,/取消公开/);assert.doesNotMatch(markup,/id="video-publication-consent"/);
});
test('publication cannot run without its own consent and blocks duplicate submissions',async()=>{
  const calls=[];let resolvePublish;const h=await harness(async(path,options)=>{if(path==='/api/videos/v1/publication'){calls.push(options);return new Promise(resolve=>resolvePublish=resolve);}return baseFetch(path,options);});
  const v=record();v.verification.state='verified';const button={dataset:{videoPublication:'true'}},consent={checked:false},error={textContent:''},form=fakeForm({});h.nodes.set('#video-publication-form',form);h.nodes.set('#video-publication-consent',consent);h.nodes.set('#video-publication-error',error);h.groups.set('[data-video-publication]',[button]);h.run(`bindVideoPublication(${JSON.stringify(v)})`);
  await button.onclick();assert.equal(calls.length,0);assert.match(error.textContent,/公开确认/);consent.checked=true;const first=button.onclick();await button.onclick();assert.equal(calls.length,1);resolvePublish(response({error:{code:'video_revision_conflict',message:'changed'}},409));await first;assert.match(error.textContent,/重新读取/);assert.equal(h.run('videoMutationBusy'),false);
});

test('private project plans clearly state that video generation and real execution are unavailable',async()=>{
  const h=await harness(baseFetch,{hash:'#projects'});assert.match(h.app.innerHTML,/项目与待办只保存计划，不会自动执行。真实 AI 执行器尚未配置，生成视频等任务目前无法运行。/);assert.match(h.app.innerHTML,/execution-unavailable-notice/);
});

test('optional author name is preserved in private imports and defaults to null when unknown',()=>{
  assert.equal(videoImportPayload({...importFields(),authorName:'  实际作者名称  '}).authorName,'实际作者名称');
  for(const authorName of [undefined,null,'','  '])assert.equal(videoImportPayload({...importFields(),authorName}).authorName,null);
  assert.throws(()=>videoImportPayload({...importFields(),authorName:'字'.repeat(201)}),/200/);
  assert.throws(()=>videoImportPayload({...importFields(),authorName:123}),/作者名称/);
});
test('private author fields are escaped in cards, details and observation history and remain outside publication disclosure',async()=>{
  const h=await harness(baseFetch),v=record();v.authorName='<img src=x onerror=alert(1)>';v.observation.authorName='<script>historical author</script>';
  const card=h.run(`videoCard(${JSON.stringify(v)})`),detail=h.run(`videoDetailMarkup({video:${JSON.stringify(v)},observations:[${JSON.stringify(v.observation)}],verificationEvents:[]})`);
  assert.match(card,/作者：&lt;img/);assert.match(detail,/<dt>作者<\/dt><dd>&lt;img/);assert.match(detail,/作者：&lt;script&gt;historical author/);assert.doesNotMatch(card+detail,/<img src=x|<script>/);
  assert.match(h.run(`videoCard(${JSON.stringify(record())})`),/作者：未记录/);
  v.verification.state='verified';const publication=h.run(`videoPublicationMarkup(${JSON.stringify(v)})`);assert.doesNotMatch(publication,/作者|authorName|&lt;img/);
});
test('private import editor exposes optional bounded author input and retains known author for new observations',async()=>{
  const h=await harness(baseFetch),v=record();v.authorName='可核对的作者';h.nodes.set('#video-import-form',fakeForm(importFields()));h.run(`videoImportEditor(${JSON.stringify(v)})`);
  assert.match(h.dialog.innerHTML,/name="authorName" maxlength="200" value="可核对的作者"/);assert.match(h.dialog.innerHTML,/可选，未知时留空/);assert.equal(h.run('defaultVideoImportFields().authorName'),'');
});
