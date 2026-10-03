"""Optional isolated UI regression: PORT=4185 npm run dev, then run this file.
All API data is fictional and intercepted in this browser context; no production writes.
"""
import json, os, time
from playwright.sync_api import sync_playwright, expect
base=os.environ.get('CHAT_PREVIEW_URL','http://127.0.0.1:4185')
out=os.environ.get('SCREENSHOT_DIR','/tmp/gpt-dot-work-product-review')
os.makedirs(out,exist_ok=True)
def task(i,title,summary='',replied=False,category='未分类'):
    return {'id':str(i)*32,'title':title,'kind':'visitor_question','identity':'visitor:fixture'+str(i),'principal_role':'visitor','summary':summary,'category':category,'receipt_state':'replied' if replied else 'waiting','execution_connected':False,'created_at':1791068400,'updated_at':1791068400+i*120,'latest_reply_id':0}
threads={}
messages={}
me={'role':'visitor','identity':'visitor:fixture','ip':'127.0.0.1','csrfToken':'fictional-csrf','intake_enabled':True,'execution_connected':False}
errors=[]
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':1440,'height':1000},device_scale_factor=1)
    def api(route):
        path=route.request.url.split('/api/',1)[1]; method=route.request.method
        data={}
        if path=='chat/me': data=me
        elif path=='session': data={'authenticated':True,'csrfToken':'fictional-owner-csrf','owner':{'name':'测试所有者'}}
        elif path.startswith('chat/tasks') or path.startswith('admin/chat/tasks'):
            prefix='admin/chat/tasks' if path.startswith('admin') else 'chat/tasks'
            rest=path[len(prefix):].split('?',1)[0]
            parts=rest.strip('/').split('/') if rest else []
            body=route.request.post_data_json if route.request.post_data else {}
            if method=='GET':
                data={'tasks':list(threads.values()),'has_more':False,'next_offset':None} if not parts else {'task':threads[parts[0]],'messages':messages[parts[0]]}
            elif not parts:
                t=task(1,body['content']); threads[t['id']]=t; messages[t['id']]=[{'id':1,'role':'user','content':body['content'],'queued_editable':True,'queue_position':1}]; data={'id':t['id']}
            elif parts[-1]=='messages':
                mid=len(messages[parts[0]])+1; messages[parts[0]].append({'id':mid,'role':'user','content':body['content'],'queued_editable':True,'queue_position':mid}); data={'id':mid}
            elif parts[-1]=='metadata': threads[parts[0]].update(body); data={'id':parts[0]}
            elif parts[-1]=='replies':
                for m in messages[parts[0]]: m['queued_editable']=False
                messages[parts[0]].append({'id':50,'role':'agent','content':body['content']}); threads[parts[0]]['receipt_state']='replied'; data={'id':50}
            else: data={'id':parts[0]}
        route.fulfill(status=200,content_type='application/json',body=json.dumps(data,ensure_ascii=False))
    context.route('**/api/**',api)
    page=context.new_page(); page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(base); expect(page.locator('#send')).to_be_enabled()
    page.locator('#input').fill('请帮我整理这周的产品反馈。')
    page.locator('#send').click(); expect(page.locator('#messages')).to_contain_text('请帮我整理这周的产品反馈。')
    expect(page.locator('#input')).to_have_value(''); expect(page.locator('#queuedMessages')).to_be_hidden()
    assert page.url.endswith('#thread='+'1'*32)
    page.screenshot(path=out+'/chat-first-light.png')
    page.reload(); expect(page.locator('#messages')).to_contain_text('请帮我整理这周的产品反馈。'); expect(page.locator('#queuedMessages')).to_be_hidden()
    page.locator('#input').fill('重点看搜索和消息排队的问题。'); page.locator('#send').click()
    expect(page.locator('.queued-card')).to_have_count(1)
    expect(page.locator('#messages')).not_to_contain_text('重点看搜索和消息排队的问题。')
    page.screenshot(path=out+'/chat-followup-light.png')
    page.locator('#newTask').click(); expect(page.locator('#chatTitle')).to_have_text('新任务')
    page.locator('#input').fill('未提交草稿'); page.go_back(); expect(page.locator('#chatTitle')).not_to_have_text('新任务')
    page.go_forward(); expect(page.locator('#input')).to_have_value('未提交草稿')
    page.get_by_role('button',name='黑夜模式').click(); page.get_by_role('button',name='登录 / 注册').click()
    expect(page.locator('.account-dialog')).to_be_visible(); page.screenshot(path=out+'/login-dark.png')
    page.get_by_role('button',name='没有账号？注册').click(); expect(page.locator('#accountDialogTitle')).to_have_text('注册账号'); page.get_by_role('button',name='取消',exact=True).last.click(); expect(page.locator('.account-dialog')).not_to_be_visible()
    t=task(2,'确认移动端筛选的交互方案','移动端筛选保持两列布局。先展示当前筛选条件，清除后回到完整列表。',True,'产品设计'); threads[t['id']]=t; messages[t['id']]=[{'id':1,'role':'user','content':t['title'],'queued_editable':False},{'id':2,'role':'agent','content':'已经确认，可按此方案整理。'}]
    t=task(3,'汇总本周用户访谈','访谈集中在三个问题：状态不清楚、查找记录费时、移动端操作不方便。下一步优先改进状态表达。',False,'用户研究'); threads[t['id']]=t; messages[t['id']]=[{'id':1,'role':'user','content':t['title'],'queued_editable':True}]
    page.goto(base+'/admin/'); expect(page.locator('#records tr')).to_have_count(3)
    expect(page.locator('#waitingCount')).to_have_text('2'); expect(page.locator('#summarizedCount')).to_have_text('2')
    expect(page.locator('html')).to_have_attribute('data-theme','dark')
    page.screenshot(path=out+'/admin-dark.png',full_page=True)
    page.get_by_role('button',name='白天模式').click(); page.screenshot(path=out+'/admin-light.png',full_page=True)
    page.locator('#searchRecords').fill('搜索'); expect(page.locator('#records tr')).to_have_count(0)
    page.locator('#clearFilters').click(); expect(page.locator('#records tr')).to_have_count(3)
    page.locator('#knowledgeView').click(); expect(page.locator('.knowledge-entry')).to_have_count(2)
    page.screenshot(path=out+'/knowledge-light.png',full_page=True)
    page.locator('#conversationView').click(); page.locator('.record-title').first.click(); expect(page.locator('#detailPanel')).to_be_visible()
    expect(page.locator('#detailSummaryState')).to_have_text('未整理'); page.locator('#summary').fill('搜索与排队是本轮反馈的重点。'); page.locator('#category').fill('产品反馈'); page.locator('#saveMetadata').click()
    expect(page.locator('#detailSummaryState')).to_have_text('已整理'); expect(page.locator('#summarizedCount')).to_have_text('3')
    page.screenshot(path=out+'/detail-light.png',full_page=True)
    page.locator('#closeDetail').click(); expect(page.locator('#detailPanel')).to_be_hidden()
    page.set_viewport_size({'width':390,'height':844}); page.goto(base+'/admin/'); expect(page.locator('#records tr')).to_have_count(3)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'mobile admin overflow'
    page.screenshot(path=out+'/admin-mobile-light.png',full_page=True)
    page.get_by_role('button',name='黑夜模式').click(); page.screenshot(path=out+'/admin-mobile-dark.png',full_page=True)
    page.goto(base+'/#thread='+'1'*32); expect(page.locator('#messages')).to_contain_text('产品反馈')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'mobile chat overflow'
    page.screenshot(path=out+'/chat-mobile-dark.png')
    assert not errors,errors
    browser.close()
print('PASS: first/follow-up queue, refresh/back/forward, draft preservation, login dismissal, real summary states, search/knowledge, theme persistence, desktop/mobile screenshots, no page errors')
