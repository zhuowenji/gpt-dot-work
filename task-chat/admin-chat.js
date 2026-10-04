const $ = selector => document.querySelector(selector);
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  for (const button of document.querySelectorAll('[data-theme-choice]')) button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme));
  $('meta[name="theme-color"]').content = theme === 'dark' ? '#171a23' : '#f7f8fa';
  try { localStorage.setItem('task-chat-theme', theme); } catch {}
}
for (const button of document.querySelectorAll('[data-theme-choice]')) button.onclick = () => setTheme(button.dataset.themeChoice);
try { setTheme(localStorage.getItem('task-chat-theme') === 'dark' ? 'dark' : 'light'); } catch { setTheme('light'); }
const taskIdPattern = /^[a-f0-9]{32}$/;
let account = null;
let accountKey = null;
let csrfToken = null;
let epoch = 0;
let loadingVersion = 0;
let detailVersion = 0;
let selectedId = null;
let tasks = [];
let recordView = 'conversations';
let pageOffset = 0;
let nextOffset = null;
let busy = false;
let sessionPromise = null;
let sessionGeneration = 0;
const receipts = new Map();
function notice(message = '') { $('#notice').textContent = message; }
function errorText(data) { return typeof data?.error === 'string' ? data.error : data?.error?.message || '请求失败，请稍后重试'; }
async function raw(path, options = {}) {
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 15000);
  try {
    const response = await fetch(path, {cache:'no-store', credentials:'same-origin', ...options, signal:abort.signal});
    let data; try { data = await response.json(); } catch { throw new Error('服务器响应无效，无法确认操作结果'); }
    if (!response.ok) { const error = new Error(errorText(data)); error.status = response.status; error.code = data?.error?.code; throw error; }
    return data;
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('连接中断，无法确认是否保存。请重试原操作。');
    throw error;
  } finally { clearTimeout(timer); }
}
function clearPrivateState({preserveSessionCheck = false} = {}) {
  if (!preserveSessionCheck) { ++sessionGeneration; sessionPromise = null; }
  ++epoch; ++loadingVersion; ++detailVersion;
  account = null; accountKey = null; csrfToken = null; tasks = []; pageOffset = 0; nextOffset = null; selectedId = null; receipts.clear();
  $('#identity').textContent = '尚未登录'; $('#records').replaceChildren(); $('#threadMessages').replaceChildren();
  $('#reply').value = ''; $('#category').value = ''; $('#summary').value = ''; $('#ownerPassword').value = '';
  for (const selector of ['#categoryFilter', '#searchRecords', '#replyFilter', '#summaryFilter']) $(selector).value = '';
  for (const selector of ['#detailTitle', '#detailMeta', '#detailSummary', '#detailCategory', '#knowledgeList', '#memoryList', '#memoryNotice']) $(selector).textContent = '';
  for (const selector of ['#waitingCount', '#repliedCount', '#summarizedCount', '#unorganizedCount']) $(selector).textContent = '—';
  recordView = 'conversations';
  $('#recordsPanel').hidden = true; $('#detailPanel').hidden = true; $('#logout').hidden = true; $('#loginPanel').hidden = false;
}
async function verifyAccount() {
  if (sessionPromise) return sessionPromise;
  const generation = sessionGeneration;
  const pending = (async () => {
    try {
      const session = await raw('/api/session');
      if (generation !== sessionGeneration) throw new Error('登录验证已失效，请重新读取');
      let next;
      if (session.authenticated === true && typeof session.csrfToken === 'string' && session.csrfToken) {
        next = {role:'owner', identity:'owner', name:session.owner?.name || '所有者', csrfToken:session.csrfToken};
      } else {
        clearPrivateState(); return false;
      }
      const key = `${next.role}:${next.identity}:${next.csrfToken}`;
      if (accountKey !== key) clearPrivateState({preserveSessionCheck:true});
      account = next; accountKey = key; csrfToken = next.csrfToken;
      $('#identity').textContent = next.role === 'owner' ? `${next.name} · 管理收件箱` : `${next.name} · 我的记录`;
      $('#loginPanel').hidden = true; $('#recordsPanel').hidden = false; $('#logout').hidden = false;
      $('#recordsDescription').textContent = next.role === 'owner' ? '显示访客问题、用户问题和所有者指令；可按分类筛选和整理。' : '只显示此账号自己的对话、分类和摘要。';
      return true;
    } catch (error) { if (generation === sessionGeneration) clearPrivateState(); throw error; }
  })().finally(() => { if (sessionPromise === pending) sessionPromise = null; });
  sessionPromise = pending;
  return pending;
}
function basePath() { return '/api/admin/chat/tasks'; }
async function api(path, options = {}) {
  const before = accountKey;
  if (!await verifyAccount()) throw new Error('请先登录后再查看记录');
  if (before && before !== accountKey) throw new Error('登录身份已改变，已清除此前记录和草稿，请重新操作。');
  const currentEpoch = epoch;
  const method = (options.method || 'GET').toUpperCase();
  const mutation = !['GET', 'HEAD'].includes(method);
  const slot = `${method}:${path}`;
  let receipt;
  if (mutation) {
    const signature = options.body || '';
    const old = receipts.get(slot);
    receipt = old?.signature === signature ? old : {signature, key:crypto.randomUUID()}; receipts.set(slot, receipt);
    options = {...options, headers:{...options.headers, 'X-CSRF-Token':csrfToken, 'X-Idempotency-Key':receipt.key}};
  }
  try {
    const data = await raw(path, {...options, method});
    if (currentEpoch !== epoch) throw new Error('登录身份已改变，请重新读取记录');
    if (receipt && receipts.get(slot) === receipt) receipts.delete(slot);
    return data;
  } catch (error) {
    if (error.status === 401 || error.status === 403) clearPrivateState();
    throw error;
  }
}
function label(task) { if (task.execution_error) return task.execution_error === 'reply_capacity' ? '自动回复容量不足' : '自动回复失败，需处理'; return task.receipt_state === 'replied' ? '已回复' : '待回复'; }
function hasSummary(task) { return typeof task.summary === 'string' && task.summary.trim().length > 0; }
function updatedLabel(task) {
  const value = Number(task.updated_at);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000).toLocaleString('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false}) : '时间未提供';
}
function make(tag, className, text) {
  const node = document.createElement(tag); node.className = className || '';
  if (text !== undefined) node.textContent = text;
  return node;
}
function badge(text, saved = false) { return make('span', 'status-badge' + (saved ? ' is-saved' : ''), text); }
function openButton(task, text, className) {
  const button = make('button', className, text); button.type = 'button';
  button.onclick = () => openDetail(task.id, true).catch(error => notice(error.message));
  return button;
}
function renderOverview() {
  const replied = tasks.filter(task => task.receipt_state === 'replied').length;
  const summarized = tasks.filter(hasSummary).length;
  $('#waitingCount').textContent = tasks.length - replied; $('#repliedCount').textContent = replied;
  $('#summarizedCount').textContent = summarized; $('#unorganizedCount').textContent = tasks.length - summarized;
  $('#overviewScope').textContent = `本页 ${tasks.length} 条 · 统计不含其他分页`;
  const selected = $('#categoryFilter').value;
  $('#categoryFilter').replaceChildren(new Option('全部分类', ''));
  for (const category of [...new Set(tasks.map(task => task.category || '未分类'))].sort()) $('#categoryFilter').append(new Option(category, category));
  $('#categoryFilter').value = [...tasks.map(task => task.category || '未分类')].includes(selected) ? selected : '';
}
function submitterLabel(task) {
  if (task.username || task.submitter_name) return task.username || task.submitter_name;
  if ((task.kind || task.source_kind) === 'owner_instruction' || task.principal_role === 'owner') return '所有者';
  const suffix = typeof task.identity === 'string' ? ' ' + task.identity.slice(-6) : '';
  return (task.principal_role === 'account' ? '用户' : '访客') + suffix;
}
function renderRecords() {
  const category = $('#categoryFilter').value;
  const search = $('#searchRecords').value.trim().toLocaleLowerCase();
  const reply = $('#replyFilter').value;
  const summary = $('#summaryFilter').value;
  const visible = tasks.filter(task => (!category || (task.category || '未分类') === category)
    && (!search || [task.title, task.summary, task.category, submitterLabel(task)].join(' ').toLocaleLowerCase().includes(search))
    && (!reply || (task.receipt_state === 'replied' ? 'replied' : 'waiting') === reply)
    && (!summary || hasSummary(task) === (summary === 'saved'))
    && (recordView !== 'knowledge' || hasSummary(task)));
  $('#records').replaceChildren(); $('#knowledgeList').replaceChildren(); $('#empty').hidden = visible.length > 0;
  $('#clearFilters').hidden = !category && !search && !reply && !summary;
  $('#tableView').hidden = recordView === 'knowledge' || !visible.length;
  $('#knowledgeList').hidden = recordView !== 'knowledge' || !visible.length;
  $('#conversationView').setAttribute('aria-pressed', String(recordView === 'conversations'));
  $('#knowledgeView').setAttribute('aria-pressed', String(recordView === 'knowledge'));
  $('#viewDescription').textContent = recordView === 'knowledge' ? '只收录已经保存的真实摘要' : '回复进度与整理状态分开记录';
  $('#resultCount').textContent = `显示 ${visible.length} / 本页 ${tasks.length} 条`;
  $('#emptyTitle').textContent = search || category || reply || summary ? '没有符合筛选的记录' : recordView === 'knowledge' ? '还没有整理好的摘要' : '还没有对话记录';
  $('#emptyDescription').textContent = search || category || reply || summary ? '试试其他关键词，或清除筛选。筛选仅作用于本页记录。' : recordView === 'knowledge' ? '在对话详情中保存摘要后，会自动出现在这里。' : '从首页收到的新消息会显示在这里。';
  for (const task of visible) {
    if (recordView === 'knowledge') {
      const article = make('article', 'knowledge-entry');
      const head = make('div', 'section-heading');
      const heading = make('h3'); heading.append(openButton(task, task.title, 'record-title'));
      head.append(heading, badge(task.category || '未分类'));
      article.append(head, make('p', 'knowledge-summary', task.summary), make('p', 'muted', `${submitterLabel(task)} · 更新于 ${updatedLabel(task)}`), openButton(task, '查看原始对话 →', 'text-button'));
      $('#knowledgeList').append(article); continue;
    }
    const row = make('tr', task.id === selectedId ? 'is-selected' : '');
    const title = make('td', 'record-subject'); title.append(openButton(task, task.title, 'record-title'), make('small', 'record-submitter', submitterLabel(task)));
    const state = make('td'); state.append(badge(label(task), task.receipt_state === 'replied'));
    const categoryCell = make('td', 'record-category', task.category || '未分类');
    const summaryCell = make('td', 'record-summary'); summaryCell.append(badge(hasSummary(task) ? '已整理' : '未整理', hasSummary(task)), make('p', 'summary-preview', hasSummary(task) ? task.summary : '尚未保存摘要'));
    const date = make('td', 'record-updated', updatedLabel(task));
    const action = make('td'); action.append(openButton(task, '查看', 'text-button'));
    row.append(title, state, categoryCell, summaryCell, date, action); $('#records').append(row);
  }
}

async function loadRecords() {
  if (!await verifyAccount()) return;
  const version = ++loadingVersion;
  const data = await api(basePath() + '?limit=100&offset=' + pageOffset);
  if (version !== loadingVersion) return;
  if (!Array.isArray(data?.tasks)) throw new Error('对话列表响应无效');
  tasks = data.tasks.filter(task => taskIdPattern.test(task.id));
  nextOffset = data.has_more === true && Number.isSafeInteger(data.next_offset) && data.next_offset > pageOffset ? data.next_offset : null;
  $('#previousPage').disabled = pageOffset === 0; $('#nextPage').disabled = nextOffset === null;
  $('#pageStatus').textContent = `第 ${Math.floor(pageOffset / 100) + 1} 页` + (data.has_more === true ? '，还有更多记录' : '');
  renderOverview(); renderRecords();
}
async function openDetail(id, focus = false) {
  if (busy || !taskIdPattern.test(id)) return;
  const version = ++detailVersion;
  const retainedDraft = selectedId === id ? {category:$('#category').value, summary:$('#summary').value, reply:$('#reply').value} : null;
  const data = await api(basePath() + '/' + id);
  if (version !== detailVersion) return;
  if (data?.task?.id !== id || !Array.isArray(data.messages)) throw new Error('对话响应无效');
  selectedId = id; $('#detailTitle').textContent = data.task.title; $('#threadMessages').replaceChildren();
  for (const entry of data.messages) {
    const item = document.createElement('div'); item.className = 'record-message ' + (entry.role === 'agent' ? 'is-reply' : '');
    const role = document.createElement('strong'); role.textContent = entry.role === 'agent' ? '所有者回复' : entry.role === 'user' ? '提交的问题' : '接收状态';
    const content = document.createElement('span'); content.textContent = entry.content || ''; item.append(role, content); $('#threadMessages').append(item);
  }
  if (data.task.execution_error) {
    const warning = make('p', 'muted', data.task.execution_error === 'reply_capacity' ? '自动回复未完成：对话容量已满。请让提问者新建对话继续。' : '自动回复未完成。请检查执行连接或手动回复；提问者也可修改仍可编辑的消息后重试。');
    $('#threadMessages').append(warning);
  }
  $('#category').value = retainedDraft?.category ?? data.task.category ?? ''; $('#summary').value = retainedDraft?.summary ?? data.task.summary ?? ''; $('#reply').value = retainedDraft?.reply || '';
  $('#replyForm').hidden = account.role !== 'owner';
  $('#metadataForm').hidden = account.role !== 'owner';
  $('#detailMeta').textContent = `${submitterLabel(data.task)} · ${label(data.task)} · 更新于 ${updatedLabel(data.task)}`;
  $('#detailSummaryState').textContent = hasSummary(data.task) ? '已整理' : '未整理';
  $('#detailSummaryState').className = 'status-badge' + (hasSummary(data.task) ? ' is-saved' : '');
  $('#detailSummary').textContent = hasSummary(data.task) ? data.task.summary : '尚未保存摘要。对话回复与摘要整理是两个独立状态。';
  $('#detailCategory').textContent = `分类：${data.task.category || '未分类'}`;
  $('#detailPanel').hidden = false; renderRecords(); notice();
  loadMemory(id, version).catch(error => { if (selectedId === id && version === detailVersion) $('#memoryNotice').textContent = error.message; });
  if (focus) { $('#detailPanel').scrollIntoView({behavior:'smooth', block:'start'}); $('#detailPanel').focus({preventScroll:true}); }

}
async function loadMemory(id, detailRequest = detailVersion) {
  $('#memoryList').replaceChildren(); $('#memoryNotice').textContent = '正在读取已审阅记录…';
  const data = await api(basePath() + '/' + id + '/memory');
  if (selectedId !== id || detailRequest !== detailVersion) return;
  if (!Array.isArray(data.memory)) { $('#memoryNotice').textContent = '此部署尚未提供可读取的记忆记录。'; return; }
  $('#memoryNotice').textContent = data.memory.length ? '作废后不再用于后续上下文，历史版本仍保留。' : '还没有已审阅的记忆。普通对话不会自动生成事实或偏好。';
  const typeLabels = {fact:'事实', preference:'偏好', task:'任务'};
  const stateLabels = {active:'有效', invalidated:'已作废', completed:'已完成', superseded:'已替代'};
  for (const entry of data.memory) {
    if (typeof entry.id !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.id) || !Number.isSafeInteger(entry.version)) continue;
    const article = make('article', 'memory-entry');
    const head = make('div', 'section-heading');
    head.append(make('strong', '', entry.key || typeLabels[entry.type] || '记录'), badge(stateLabels[entry.status] || '状态未知', entry.status === 'active'));
    const sources = Array.isArray(entry.source_message_ids) ? entry.source_message_ids.filter(Number.isSafeInteger).map(value => '#' + value).join('、') : '';
    const time = Number(entry.updated_at) > 0 ? new Date(Number(entry.updated_at)).toLocaleString('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false}) : '时间未提供';
    article.append(head, make('p', 'memory-value', entry.value || ''), make('p', 'muted', `${typeLabels[entry.type] || '记录'} · ${entry.certainty === 'confirmed' ? '已确认（用户陈述或人工审阅）' : '推断，需核实'} · 版本 ${entry.version} · ${time}`), make('p', 'muted', `来源消息：${sources || '未提供'}`));
    const actions = make('div', 'memory-actions');
    const history = make('button', 'text-button', '查看版本'); history.type = 'button';
    const versions = make('div', 'memory-versions'); versions.hidden = true;
    history.onclick = async () => {
      if (busy) return; history.disabled = true;
      try {
        const result = await api(basePath() + '/' + id + '/memory/' + entry.id);
        if (selectedId !== id || detailRequest !== detailVersion) return;
        versions.replaceChildren();
        for (const previous of (Array.isArray(result.versions) ? result.versions : [])) versions.append(make('p', '', `版本 ${previous.version} · ${stateLabels[previous.status] || previous.status}：${previous.value || ''}`));
        versions.hidden = false;
      } catch (error) { $('#memoryNotice').textContent = error.message; }
      finally { history.disabled = false; }
    };
    actions.append(history);
    if (taskIdPattern.test(entry.source_thread_id)) actions.append(openButton({id:entry.source_thread_id}, '来源对话', 'text-button'));
    if (entry.status === 'active') {
      const invalidate = make('button', 'text-button', '作废'); invalidate.type = 'button';
      invalidate.onclick = async () => {
        if (busy || selectedId !== id || !window.confirm('作废这条记忆？它将不再用于后续上下文，历史版本仍保留。')) return;
        setBusy(true);
        try {
          if (account.role === 'owner') await api(basePath() + '/' + id + '/memory', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({expected_context_version:data.context_version, memory_patch:[{id:entry.id, version:entry.version, status:'invalidated'}]})});
          else await api(basePath() + '/' + id + '/memory/' + entry.id, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({version:entry.version, status:'invalidated'})});
          setBusy(false); await openDetail(id); await loadRecords(); notice('记忆已作废，后续上下文将不再使用。');
        } catch (error) { $('#memoryNotice').textContent = error.message; }
        finally { setBusy(false); }
      };
      actions.append(invalidate);
    }
    article.append(actions, versions); $('#memoryList').append(article);
  }
}
function setBusy(value) {
  busy = value;
  for (const button of $('#memoryList').querySelectorAll('button')) button.disabled = value;
  for (const selector of ['#sendReply', '#saveMetadata', '#logout', '#refresh', '#reply', '#category', '#summary', '#closeDetail', '#previousPage', '#nextPage']) $(selector).disabled = value;
  $('#previousPage').disabled = value || pageOffset === 0; $('#nextPage').disabled = value || nextOffset === null;
}
$('#replyForm').onsubmit = async event => {
  event.preventDefault();
  const content = $('#reply').value.trim();
  if (busy || !selectedId || account?.role !== 'owner' || !content) return;
  const id = selectedId; setBusy(true); notice();
  try {
    await api('/api/admin/chat/tasks/' + id + '/replies', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({content})});
    $('#reply').value = ''; setBusy(false); await openDetail(id); await loadRecords(); notice('回复已发送到原对话。');
  } catch (error) { notice(error.message); }
  finally { setBusy(false); }
};
$('#metadataForm').onsubmit = async event => {
  event.preventDefault();
  if (busy || !selectedId || account?.role !== 'owner') return;
  const id = selectedId; const body = {summary:$('#summary').value.trim(), category:$('#category').value.trim()};
  setBusy(true); notice();
  try {
    await api('/api/admin/chat/tasks/' + id + '/metadata', {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    setBusy(false); await openDetail(id); await loadRecords(); notice(body.summary ? '分类和摘要已保存，整理状态已更新。' : '已保存。摘要为空，仍显示为尚未整理。');
  } catch (error) { notice(error.message); }
  finally { setBusy(false); }
};
$('#ownerLogin').onsubmit = async event => {
  event.preventDefault(); if (busy) return;
  const password = $('#ownerPassword').value; if (!password) return;
  const button = $('#ownerLogin').querySelector('button'); button.disabled = true; busy = true; notice();
  try {
    await raw('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password})});
    $('#ownerPassword').value = ''; clearPrivateState(); await loadRecords();
  } catch (error) { $('#ownerPassword').value = ''; notice(error.message); }
  finally { busy = false; button.disabled = false; }
};
$('#logout').onclick = async () => {
  if (busy || !account) return;
  const role = account.role; setBusy(true);
  try {
    await api(role === 'owner' ? '/api/logout' : '/api/chat/account/logout', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
    clearPrivateState(); notice('已退出登录。');
  } catch (error) { clearPrivateState(); notice(error.message); }
  finally { setBusy(false); }
};
$('#closeDetail').onclick = () => { ++detailVersion; selectedId = null; $('#detailPanel').hidden = true; $('#threadMessages').replaceChildren(); $('#reply').value = ''; $('#summary').value = ''; $('#category').value = ''; renderRecords(); };
for (const selector of ['#categoryFilter', '#searchRecords', '#replyFilter', '#summaryFilter']) $(selector).oninput = renderRecords;
$('#clearFilters').onclick = () => { for (const selector of ['#categoryFilter', '#searchRecords', '#replyFilter', '#summaryFilter']) $(selector).value = ''; renderRecords(); };
$('#conversationView').onclick = () => { recordView = 'conversations'; renderRecords(); };
$('#knowledgeView').onclick = () => { recordView = 'knowledge'; renderRecords(); };
$('#previousPage').onclick = () => { if (!busy && pageOffset > 0) { pageOffset = Math.max(0, pageOffset - 100); loadRecords().catch(error => notice(error.message)); } };
$('#nextPage').onclick = () => { if (!busy && nextOffset !== null) { pageOffset = nextOffset; loadRecords().catch(error => notice(error.message)); } };
$('#refresh').onclick = () => loadRecords().catch(error => notice(error.message));
document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) loadRecords().catch(error => notice(error.message)); });
window.addEventListener('focus', () => { if (!busy) loadRecords().catch(error => notice(error.message)); });
window.addEventListener('pagehide', clearPrivateState);
window.addEventListener('pageshow', event => { if (event.persisted) loadRecords().catch(error => notice(error.message)); });
setInterval(() => { if (!document.hidden && !busy) verifyAccount().catch(error => notice(error.message)); }, 10000);
clearPrivateState(); loadRecords().catch(error => notice(error.message));
