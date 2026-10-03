import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildPublicDemo } from '../scripts/public-demo.mjs';

const source = async file => readFile(new URL('../' + file, import.meta.url), 'utf8');
const inputs = {template: await source('public-demo/index.html'), css: await source('public-demo/style.css'), app: await source('public-demo/app.js')};
const fixture = {title:'Fixture title',category:'测试分类',url:'https://www.douyin.com/video/1234567890123456789',publishedDate:'2026-10-01',observedLikes:12000,observedAt:'2026-10-03T12:00:00Z',verification:'verified'};
const response = (videos=[],extra={}) => ({ok:true,json:async()=>({videos,shown:videos.length,hasMore:false,...extra})});
async function harness(fetcher) {
  const nodes = Object.fromEntries(['refresh','results','status','updated','result-count'].map(key=>['#'+key,{innerHTML:'',textContent:'',hidden:false,disabled:false,className:'',setAttribute(){},addEventListener(){}}]));
  const calls=[];
  const context=vm.createContext({console,URL,Intl,Date,
    fetch:async(path,options)=>{calls.push({path,options});return fetcher(path,options);},
    get localStorage(){throw new Error('Public page must not access local storage');},
    document:{querySelector:selector=>nodes[selector]}
  });
  vm.runInContext(inputs.app,context);
  await new Promise(resolve=>setImmediate(resolve));
  return {nodes,calls,run:code=>vm.runInContext(code,context)};
}

test('public page build is self-contained and independent of owner UI and mock workspace',()=>{
  const html=buildPublicDemo(inputs);
  assert.match(html,/真实结果，只读展示/);
  assert.doesNotMatch(html,/<script[^>]+src=|<link[^>]+href=|createWorkspaceClient|localStorage|workspace_session|const seed/);
  assert.throws(()=>buildPublicDemo({...inputs,template:'<html></html>'}),/asset markers/);
  assert.match(html,/credentials:'omit'/);
});

test('empty public response displays honest empty state and only requests public endpoint without credentials',async()=>{
  const h=await harness(async()=>response());
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].path,'/api/public/videos?limit=100');
  assert.equal(h.calls[0].options.credentials,'omit');
  assert.equal(h.calls[0].options.method,'GET');
  assert.equal(h.calls[0].options.redirect,'error');
  assert.equal(h.calls[0].options.headers.Authorization,undefined);
  assert.match(h.nodes['#status'].innerHTML,/暂无公开结果/);
  assert.equal(h.nodes['#results'].innerHTML,'');
  assert.equal(h.nodes['#result-count'].textContent,'0');
});

test('public results safely display whitelisted fields, dated observation and canonical source links',async()=>{
  const h=await harness(async()=>response([{...fixture,title:'<img src=x onerror=alert(1)>',internalNote:'PRIVATE_SENTINEL',evidence:'PRIVATE_EVIDENCE'}]));
  const html=h.nodes['#results'].innerHTML;
  assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html,/<img|PRIVATE_SENTINEL|PRIVATE_EVIDENCE/);
  assert.match(html,/12,000/); assert.match(html,/记录时的点赞数/); assert.match(html,/北京时间/);
  assert.match(html,/rel="noopener noreferrer"/);
  assert.match(html,/https:\/\/www\.douyin\.com\/video\/1234567890123456789/);
  assert.equal(h.nodes['#status'].hidden,true);
});

test('invalid public data, malicious links and unavailable API never display stale or sample results',async()=>{
  for(const bad of [null,{...fixture,url:'javascript:alert(1)'},{...fixture,url:'https://evil.test/video/123'},{...fixture,url:'https://www.douyin.com/video/123?token=private'},{...fixture,observedLikes:-1},{...fixture,observedAt:'invalid'},{...fixture,verification:'unverified'}]) {
    const h=await harness(async()=>response([bad]));
    assert.match(h.nodes['#status'].innerHTML,/暂时无法载入公开结果/);
    assert.equal(h.nodes['#results'].innerHTML,'');
  }
  let fail=false;
  const h=await harness(async()=>fail?{ok:false}:response([fixture]));
  assert.match(h.nodes['#results'].innerHTML,/Fixture title/);
  fail=true; await h.run('loadResults()');
  assert.equal(h.nodes['#results'].innerHTML,'');
  assert.match(h.nodes['#status'].innerHTML,/暂时无法载入公开结果/);
  fail=false; await h.run('loadResults()');
  assert.match(h.nodes['#results'].innerHTML,/Fixture title/);
  assert.equal(h.nodes['#refresh'].disabled,false);
});

test('repeated refreshes cannot overlap and private UI paths never appear in the page',async()=>{
  let finish;
  const pending=new Promise(resolve=>{finish=resolve;});
  const h=await harness(async()=>{await pending;return response();});
  assert.equal(h.nodes['#refresh'].disabled,true);
  await h.run('loadResults()'); await h.run('loadResults()');
  assert.equal(h.calls.length,1);
  finish(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.nodes['#refresh'].disabled,false);
  assert.doesNotMatch(inputs.app,/\/api\/(?:workspace|session|tasks|login|logout)|credentials:'same-origin'|method:'(?:POST|PUT|PATCH|DELETE)'/);
});


test('official canonical short links are allowed without admitting arbitrary hosts or query tokens',async()=>{
  const h=await harness(async()=>response([{...fixture,url:'https://v.douyin.com/Abc_-123/'}]));
  assert.match(h.nodes['#results'].innerHTML,/https:\/\/v\.douyin\.com\/Abc_-123\//);
  assert.equal(h.run("safeVideoUrl('https://v.douyin.com/Abc/?token=secret')"),null);
  assert.equal(h.run("safeVideoUrl('https://v.douyin.com.evil.test/Abc/')"),null);
});
