const $ = selector => document.querySelector(selector);
const taskIdPattern = /^[a-f0-9]{32}$/;
let account = null;
let accountKey = null;
let csrfToken = null;
let epoch = 0;
let loadingVersion = 0;
let detailVersion = 0;
let selectedId = null;
let tasks = [];
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
  $('#categoryFilter').value = ''; $('#detailTitle').textContent = '';
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
        const me = await raw('/api/chat/me');
        if (generation !== sessionGeneration) throw new Error('登录验证已失效，请重新读取');
        if (me.role !== 'account' || typeof me.identity !== 'string' || typeof me.csrfToken !== 'string' || !me.csrfToken) { clearPrivateState(); return false; }
        next = {...me, name:me.username || me.account?.username || '已登录用户'};
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
function basePath() { return account?.role === 'owner' ? '/api/admin/chat/tasks' : '/api/chat/tasks'; }
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
function label(task) { return task.receipt_state === 'replied' ? '已回复' : '已收到，等待接收'; }
function submitterLabel(task) {
  if (task.username || task.submitter_name) return task.username || task.submitter_name;
  if ((task.kind || task.source_kind) === 'owner_instruction' || task.principal_role === 'owner') return '所有者';
  const suffix = typeof task.identity === 'string' ? ' ' + task.identity.slice(-6) : '';
  return (task.principal_role === 'account' ? '用户' : '访客') + suffix;
}
function renderRecords() {
  const filter = $('#categoryFilter').value.trim().toLocaleLowerCase();
  const visible = tasks.filter(task => (task.category || '未分类').toLocaleLowerCase().includes(filter));
  $('#records').replaceChildren(); $('#empty').hidden = visible.length > 0;
  for (const task of visible) {
    const row = document.createElement('tr');
    const title = document.createElement('td');
    const open = document.createElement('button'); open.type = 'button'; open.textContent = task.title; open.onclick = () => openDetail(task.id).catch(error => notice(error.message)); title.append(open); row.append(title);
    for (const value of [submitterLabel(task), task.category || '未分类', task.summary || '尚未整理', label(task)]) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    $('#records').append(row);
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
  $('#pageStatus').textContent = `第 ${Math.floor(pageOffset / 100) + 1} 页，本页 ${tasks.length} 条` + (data.has_more === true ? '，还有更多记录' : '');
  renderRecords();
}
async function openDetail(id) {
  if (busy || !taskIdPattern.test(id)) return;
  const version = ++detailVersion;
  const data = await api(basePath() + '/' + id);
  if (version !== detailVersion) return;
  if (data?.task?.id !== id || !Array.isArray(data.messages)) throw new Error('对话响应无效');
  selectedId = id; $('#detailTitle').textContent = data.task.title; $('#threadMessages').replaceChildren();
  for (const entry of data.messages) {
    const item = document.createElement('div'); item.className = 'message';
    const role = document.createElement('strong'); role.textContent = entry.role === 'agent' ? '所有者回复' : entry.role === 'user' ? '提交的问题' : '接收状态';
    const content = document.createElement('span'); content.textContent = entry.content || ''; item.append(role, content); $('#threadMessages').append(item);
  }
  $('#category').value = data.task.category || ''; $('#summary').value = data.task.summary || ''; $('#reply').value = '';
  $('#replyForm').hidden = account.role !== 'owner';
  $('#metadataForm').hidden = account.role !== 'owner';
  // Account holders can read summaries without gaining access to owner curation controls.
  if (account.role !== 'owner') {
    const metadata = document.createElement('p'); metadata.className = 'muted'; metadata.textContent = `分类：${data.task.category || '未分类'}。摘要：${data.task.summary || '尚未整理'}`; $('#threadMessages').append(metadata);
  }
  $('#detailPanel').hidden = false; notice();
}
function setBusy(value) {
  busy = value;
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
    await loadRecords(); notice('分类和摘要已保存。');
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
$('#closeDetail').onclick = () => { ++detailVersion; selectedId = null; $('#detailPanel').hidden = true; $('#threadMessages').replaceChildren(); $('#reply').value = ''; $('#summary').value = ''; $('#category').value = ''; };
$('#categoryFilter').oninput = renderRecords;
$('#previousPage').onclick = () => { if (!busy && pageOffset > 0) { pageOffset = Math.max(0, pageOffset - 100); loadRecords().catch(error => notice(error.message)); } };
$('#nextPage').onclick = () => { if (!busy && nextOffset !== null) { pageOffset = nextOffset; loadRecords().catch(error => notice(error.message)); } };
$('#refresh').onclick = () => loadRecords().catch(error => notice(error.message));
document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) loadRecords().catch(error => notice(error.message)); });
window.addEventListener('focus', () => { if (!busy) loadRecords().catch(error => notice(error.message)); });
window.addEventListener('pagehide', clearPrivateState);
window.addEventListener('pageshow', event => { if (event.persisted) loadRecords().catch(error => notice(error.message)); });
setInterval(() => { if (!document.hidden && !busy) verifyAccount().catch(error => notice(error.message)); }, 10000);
clearPrivateState(); loadRecords().catch(error => notice(error.message));
