"""Optional public-results UI QA: npm run build && python tests/browser_public_demo.py.
Requires Python Playwright + Chromium. Uses only temporary fixture credentials/data.
"""
from playwright.sync_api import sync_playwright
import json, os, subprocess, tempfile

out = os.environ.get('SCREENSHOT_DIR', '/tmp/gpt-dot-work-public-demo-review')
os.makedirs(out, exist_ok=True)
server_script = r'''
import {readConfig} from './backend/config.mjs';
import {TaskStore} from './backend/store.mjs';
import {WorkspaceStore,emptyWorkspace} from './backend/workspace.mjs';
import {createApiServer,listen} from './backend/server.mjs';
import {scryptSync} from 'node:crypto';
const salt=Buffer.alloc(16,7), password='fictional-browser-test-only';
const hash=`scrypt$32768$8$1$${salt.toString('base64url')}$${scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024}).toString('base64url')}`;
const config=readConfig({WORKSPACE_OWNER_PASSWORD_HASH:hash,WORKSPACE_PUBLIC_ORIGIN:'http://localhost:4318',WORKSPACE_DB_PATH:process.env.DEMO_TEST_DB,WORKSPACE_STATIC_DIR:process.cwd()+'/dist',WORKSPACE_PORT:'0'});
const store=new TaskStore(config.dbPath), data=emptyWorkspace();
data.projects.push({id:'private',name:'PRIVATE_BROWSER_SENTINEL',icon:'P',color:'blue',category:'Private',description:'Private',stage:'Private',plan:'Private'});
new WorkspaceStore(store).put({revision:0,workspace:data});
const server=createApiServer(store,config), address=await listen(server,config);
config.publicOrigin=`http://127.0.0.1:${address.port}`;
console.log(config.publicOrigin);
process.once('SIGTERM',()=>server.close(()=>{store.close();process.exit(0);}));
'''
with tempfile.TemporaryDirectory(prefix='public-results-browser-') as tmp:
    server = subprocess.Popen(['node', '--input-type=module', '-e', server_script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env={**os.environ, 'DEMO_TEST_DB': tmp+'/state.sqlite'})
    try:
        base = server.stdout.readline().strip()
        assert base.startswith('http://127.0.0.1:'), server.stderr.read()
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
            context = browser.new_context(viewport={'width':1440, 'height':1100})
            page = context.new_page()
            errors, requests = [], []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('request', lambda req: requests.append(req.url))
            # Browser-only DTO fixtures; never inserted in the real application database.
            payload = {'videos':[], 'shown':0, 'hasMore':False}
            public_headers = []
            def public_response(route):
                public_headers.append(route.request.all_headers())
                route.fulfill(status=200, content_type='application/json', body=json.dumps(payload))
            context.route('**/api/public/videos?limit=100', public_response)
            response = page.goto(base+'/demo/')
            assert response.status == 200
            assert page.get_by_text('真实结果，只读展示。', exact=True).is_visible()
            assert page.get_by_text('暂无公开结果', exact=True).is_visible()
            assert context.request.get(base+'/api/workspace').status == 401
            assert all('/api/' not in url or '/api/public/videos?limit=100' in url for url in requests)
            page.screenshot(path=out+'/public-results-empty.png', full_page=True)
            fixture = {'title':'Browser fixture <img src=x onerror=alert(1)>', 'category':'测试分类', 'url':'https://www.douyin.com/video/1234567890123456789', 'publishedDate':'2026-10-01', 'observedLikes':12000, 'observedAt':'2026-10-03T12:00:00Z', 'verification':'verified'}
            payload = {'videos':[fixture], 'shown':1, 'hasMore':False}
            page.get_by_role('button', name='刷新结果').click()
            assert page.get_by_role('heading', name=fixture['title'], exact=True).is_visible()
            assert page.locator('img').count() == 0
            link = page.get_by_role('link', name='查看抖音视频 ↗')
            assert link.get_attribute('href') == fixture['url']
            assert link.get_attribute('rel') == 'noopener noreferrer'
            assert page.evaluate('Object.keys(localStorage).length') == 0
            page.screenshot(path=out+'/public-results-desktop.png', full_page=True)
            # Real owner cookie remains available to the private API, but is omitted by this page.
            login = context.request.post(base+'/api/login', headers={'Origin':base}, data={'password':'fictional-browser-test-only'})
            assert login.status == 200
            before = context.request.get(base+'/api/workspace').json()
            assert before['workspace']['projects'][0]['name'] == 'PRIVATE_BROWSER_SENTINEL'
            page.reload()
            assert page.get_by_role('heading', name=fixture['title'], exact=True).is_visible()
            assert not page.get_by_text('PRIVATE_BROWSER_SENTINEL', exact=True).count()
            assert all('cookie' not in headers and 'authorization' not in headers for headers in public_headers)
            assert page.evaluate("async () => { try { await fetch('/api/workspace'); return false; } catch { return true; } }")
            assert context.request.get(base+'/api/workspace').json() == before
            mobile = context.new_page()
            mobile.set_viewport_size({'width':390,'height':844})
            mobile.goto(base+'/demo/')
            assert mobile.get_by_role('heading', name=fixture['title'], exact=True).is_visible()
            assert mobile.evaluate('document.documentElement.scrollWidth <= innerWidth')
            mobile.screenshot(path=out+'/public-results-mobile.png', full_page=True)
            assert not errors, errors
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)
print('PASS: anonymous empty state, safe read-only DTO rendering, owner cookie omission, private API 401, CSP private network block, no local storage, desktop/mobile, no JS errors or overflow')
