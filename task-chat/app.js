// Uploaded visual shell; the transport is a same-origin question intake only.
const list = document.querySelector('#taskList');
const messages = document.querySelector('#messages');
const input = document.querySelector('#input');
const form = document.querySelector('#composer');
const send = document.querySelector('#send');
const attach = document.querySelector('#attach');
const fileInput = document.querySelector('#fileInput');
const attachmentList = document.querySelector('#attachmentList');
const queuedMessages = document.querySelector('#queuedMessages');
const editNotice = document.querySelector('#editNotice');
const title = document.querySelector('#chatTitle');
const status = document.querySelector('#chatStatus');
const hint = document.querySelector('#hint');
const agentSelect = document.querySelector('#agentSelect');
const agentChoice = document.querySelector('#agentChoice');
const agentChoiceLabel = document.querySelector('#agentChoiceLabel');
const agentMenu = document.querySelector('#agentMenu');
const deleteTaskDialog = document.querySelector('#deleteTaskDialog');
const deleteTaskMessage = document.querySelector('#deleteTaskMessage');
const deleteTaskError = document.querySelector('#deleteTaskError');
const confirmDeleteTask = document.querySelector('#confirmDeleteTask');
const cancelDeleteTask = document.querySelector('#cancelDeleteTask');
const themeButtons = [...document.querySelectorAll('[data-theme-choice]')];
const taskIdPattern = /^[a-f0-9]{32}$/;
const uploadUnavailable = '附件上传尚未开放，文件不会传送。请先用文字描述。';
let identity = null;
let identityKey = null;
let identityReady = false;
let identityPromise = null;
let identityGeneration = 0;
let principalVersion = 0;
let currentId = null;
let busy = false;
let taskLoading = false;
let listLoadVersion = 0;
let taskLoadVersion = 0;
let editingId = null;
let editingUnavailable = false;
let draggedQueueId = null;
let taskToDelete = null;
let renderedTaskId = null;
let renderedContent = null;
let renderedMessageIds = new Set();
let readReplies = Object.create(null);
const drafts = new Map();
const pendingRequests = new Map();
const inFlightMutations = new Map();
// No conversation, owner draft, CSRF token or identity is persisted in web storage.
// Remove the older, unscoped archive caches rather than restoring another user's draft.
try {
  localStorage.removeItem('task-chat-drafts-v2');
  localStorage.removeItem('task-chat-read-replies');
} catch {}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  for (const button of themeButtons) button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme));
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#171a23' : '#f7f8fa';
  try { localStorage.setItem('task-chat-theme', theme); } catch {}
}
for (const button of themeButtons) button.onclick = () => setTheme(button.dataset.themeChoice);
setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
function apiPath(path) {
  if (path === '/api/me') return '/api/chat/me';
  if (path === '/api/agents') return '/api/chat/agents';
  if (/^\/api\/tasks(?:[/?]|$)/.test(path)) return path.replace('/api/tasks', '/api/chat/tasks');
  throw new Error('此接口未开放');
}
function errorMessage(data, fallback = '请求失败，请稍后重试') {
  if (typeof data?.error === 'string') return data.error;
  if (typeof data?.error?.message === 'string') return data.error.message;
  return fallback;
}
async function request(path, options = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15000);
  try {
    const response = await fetch(path, {cache:'no-store', credentials:'same-origin', ...options, signal:abort.signal});
    let data;
    try { data = await response.json(); }
    catch { throw new Error('服务器响应无效，无法确认操作结果。请重试原操作。'); }
    if (!response.ok) {
      const error = new Error(errorMessage(data));
      error.status = response.status;
      error.code = data?.error?.code;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('连接中断，无法确认操作结果。请重试原操作。');
    throw error;
  } finally { clearTimeout(timer); }
}
function showWelcome() {
  title.textContent = '新任务';
  status.textContent = identityReady ? '可发送文字，等待接收' : '正在验证访客身份';
  messages.replaceChildren();
  const welcome = document.createElement('div'); welcome.className = 'welcome';
  const mark = document.createElement('div'); mark.className = 'welcome-mark'; mark.textContent = '✦';
  const heading = document.createElement('h1'); heading.textContent = identity?.role === 'owner' ? '今天想安排什么？' : '今天想问什么？';
  const paragraph = document.createElement('p');
  paragraph.textContent = identity?.role === 'owner' ? '指令会保存到你的专属对话，执行连接器尚未配置。' : '把问题写在这里，收到后等待所有者回复。';
  welcome.append(mark, heading, paragraph); messages.append(welcome);
}
function clearPrincipal({preserveIdentityCheck = false} = {}) {
  if (!preserveIdentityCheck) { ++identityGeneration; identityPromise = null; }
  ++principalVersion; ++listLoadVersion; ++taskLoadVersion;
  identity = null; identityKey = null; identityReady = false;
  currentId = null; editingId = null; editingUnavailable = false;
  draggedQueueId = null; taskToDelete = null; taskLoading = false;
  drafts.clear(); pendingRequests.clear(); inFlightMutations.clear(); readReplies = Object.create(null);
  renderedTaskId = null; renderedContent = null; renderedMessageIds.clear();
  input.value = ''; list.replaceChildren(); messages.replaceChildren(); queuedMessages.replaceChildren();
  queuedMessages.hidden = true; attachmentList.replaceChildren(); attachmentList.hidden = true;
  editNotice.hidden = true; fileInput.value = '';
  if (deleteTaskDialog.open) deleteTaskDialog.close();
  document.querySelector('#myIp').textContent = '身份待验证';
  document.title = '任务聊天';
  showWelcome(); updateComposer(); writeHint();
  if (typeof accountFooter !== 'undefined') updateAccountFooter();
  if (typeof passwordInput !== 'undefined') passwordInput.value = '';
  if (typeof accountDialog !== 'undefined' && accountDialog.open && !accountBusy) accountDialog.close();
}
async function initializeIdentity() {
  if (identityPromise) return identityPromise;
  const generation = identityGeneration;
  const pending = (async () => {
    try {
      const data = await request(apiPath('/api/me'));
      if (generation !== identityGeneration) throw new Error('身份验证已失效，请重新读取');
      if (!['owner', 'account', 'visitor'].includes(data?.role) || typeof data.identity !== 'string' || !data.identity || typeof data.csrfToken !== 'string' || !data.csrfToken) throw new Error('身份验证响应无效');
      // A new login session, logout or changed visitor cookie must clear all prior private state.
      const key = `${data.role}:${data.identity}:${data.csrfToken}`;
      if (identityKey !== key) clearPrincipal({preserveIdentityCheck:true});
      identity = data; identityKey = key; identityReady = true;
      document.querySelector('#myIp').textContent = typeof data.ip === 'string' ? data.ip : '未提供';
      agentSelect.replaceChildren(new Option('等待接收', ''));
      agentChoiceLabel.textContent = '等待接收';
      agentChoice.title = '执行连接器尚未配置，当前只接收和保存文字';
      agentChoice.setAttribute('aria-label', '文字接收，执行连接器尚未配置');
      agentMenu.hidden = true; agentChoice.setAttribute('aria-expanded', 'false');
      if (!currentId) showWelcome();
      updateComposer(); updateAccountFooter();
      return data;
    } catch (error) {
      if (generation === identityGeneration) clearPrincipal();
      throw error;
    }
  })().finally(() => { if (identityPromise === pending) identityPromise = null; });
  identityPromise = pending;
  return pending;
}
async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const previousPrincipal = identityKey;
  // Check the server session before reads and writes, including after a different tab logs out.
  await initializeIdentity();
  if (previousPrincipal && previousPrincipal !== identityKey) throw new Error('身份已改变，已清除先前对话和草稿。请重新操作。');
  const version = principalVersion;
  const target = apiPath(path);
  const mutation = !['GET', 'HEAD'].includes(method);
  const receiptKey = `${method}:${target}`;
  let receipt;
  if (mutation) {
    if (identity.intake_enabled !== true) throw new Error('当前暂不接收新消息');
    const signature = options.body || '';
    const saved = pendingRequests.get(receiptKey);
    receipt = saved?.signature === signature ? saved : {signature, key:crypto.randomUUID()};
    pendingRequests.set(receiptKey, receipt);
    options = {...options, headers:{...options.headers, 'X-CSRF-Token':identity.csrfToken, 'X-Idempotency-Key':receipt.key}};
    // Identical in-flight clicks share the same result instead of issuing two writes.
    if (inFlightMutations.has(receipt.key)) return inFlightMutations.get(receipt.key);
  }
  const operation = (async () => {
    try {
      const data = await request(target, {...options, method});
      if (version !== principalVersion) throw new Error('身份已改变，请重新读取当前对话');
      if (mutation && pendingRequests.get(receiptKey) === receipt) pendingRequests.delete(receiptKey);
      return data;
    } catch (error) {
      if (error.status === 401 || (error.status === 403 && ['csrf_denied', 'unauthorized'].includes(error.code))) clearPrincipal();
      throw error;
    } finally { if (receipt) inFlightMutations.delete(receipt.key); }
  })();
  if (receipt) inFlightMutations.set(receipt.key, operation);
  return operation;
}
function guidance() {
  if (!identityReady) return '身份验证后可发送文字；附件上传尚未开放。';
  return identity.role === 'owner'
    ? '所有者指令仅保存；执行连接器尚未配置，不会自动执行。对话可在管理记录中查看。'
    : identity.role === 'account'
      ? '已登录，自己的对话与整理记录可在其他设备登录后继续查看。执行连接器尚未配置，等待所有者回复；附件暂未开放。'
      : '无需登录即可提问。浏览器 Cookie 找回自己的对话；清除 Cookie 或更换设备会失去连续记录。可选注册登录以跨设备保存记录。执行连接器未配置；附件暂未开放。';
}
function writeHint(prefix = '') {
  hint.replaceChildren(document.createTextNode((prefix ? prefix + ' ' : '') + guidance()));
  if (identityReady && ['owner', 'account'].includes(identity.role)) {
    const link = document.createElement('a'); link.href = '/admin/'; link.textContent = identity.role === 'owner' ? ' 查看管理记录' : ' 查看我的记录'; hint.append(link);
  }
  hint.style.color = prefix ? '#c05045' : '';
}
function showError(error) { writeHint(error?.message || '请求失败，请稍后重试'); }
function clearError() { writeHint(); }
function updateComposer() {
  const disabled = busy || taskLoading || !identityReady;
  input.disabled = disabled;
  send.disabled = disabled || editingUnavailable || identity?.intake_enabled !== true;
  attach.disabled = busy || taskLoading;
  attach.setAttribute('aria-disabled', 'true');
  attach.title = uploadUnavailable;
  fileInput.disabled = true;
  agentChoice.disabled = true;
  document.querySelector('#cancelEdit').disabled = disabled;
  document.querySelector('#newTask').disabled = busy || !identityReady;
  for (const button of queuedMessages.querySelectorAll('button')) button.disabled = disabled;
  input.placeholder = identity?.role === 'owner' ? '输入要保存的指令…' : '输入问题，等待所有者接收…';
}
function saveDraft() {
  if (identityReady) drafts.set(currentId, {content:input.value, editingId});
}
function restoreDraft() {
  const draft = drafts.get(currentId);
  input.value = draft?.content || '';
  editingId = draft?.editingId || null;
  editingUnavailable = false;
  editNotice.hidden = !editingId;
}
input.addEventListener('input', saveDraft);
function newTask() {
  if (busy || !identityReady) return;
  saveDraft(); ++taskLoadVersion; taskLoading = false; currentId = null;
  renderedTaskId = null; renderedContent = null; renderedMessageIds.clear();
  queuedMessages.replaceChildren(); queuedMessages.hidden = true;
  restoreDraft(); showWelcome(); clearError(); updateComposer(); input.focus();
  renderList().catch(showError);
}
function taskLabel(task) {
  return task.receipt_state === 'replied' ? '已收到所有者回复' : '已收到，等待接收';
}
function markRead(id, replyId) {
  if (replyId) readReplies[id] = Math.max(Number(readReplies[id] || 0), replyId);
}
async function renderList() {
  const version = ++listLoadVersion;
  const data = {tasks:[]};
  let offset = 0;
  do {
    const page = await api('/api/tasks?limit=100&offset=' + offset);
    if (version !== listLoadVersion) return;
    if (!Array.isArray(page?.tasks)) throw new Error('对话列表响应无效');
    data.tasks.push(...page.tasks);
    offset = page.has_more === true && Number.isSafeInteger(page.next_offset) && page.next_offset > offset ? page.next_offset : null;
  } while (offset !== null && data.tasks.length < 500);
  list.replaceChildren();
  let anyUnread = false;
  for (const task of data.tasks) {
    if (!taskIdPattern.test(task.id)) continue;
    const unread = Number(task.latest_reply_id || 0) > Number(readReplies[task.id] || 0);
    anyUnread ||= unread;
    const row = document.createElement('div'); row.className = 'task-row';
    const button = document.createElement('button'); button.className = 'task-item' + (task.id === currentId ? ' active' : '');
    const dot = document.createElement('span'); dot.className = 'task-dot ' + (task.receipt_state === 'replied' ? 'done' : 'queued') + (unread ? ' unread' : '');
    dot.setAttribute('aria-hidden', 'true'); dot.title = taskLabel(task);
    button.setAttribute('aria-label', `${task.title}，${task.pinned ? '已置顶，' : ''}${taskLabel(task)}${unread ? '，有未读回复' : ''}`);
    const name = document.createElement('span'); name.className = 'title'; name.textContent = task.title;
    button.append(dot, name); button.onclick = () => openTask(task.id, true).catch(showError);
    const actions = document.createElement('div'); actions.className = 'task-actions';
    const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'task-action-pin' + (task.pinned ? ' pinned' : '');
    pin.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="pin-head" d="M8 3h8l-1 5 3 4v2H6v-2l3-4-1-5Z"/><path d="M12 14v7"/></svg>';
    pin.title = task.pinned ? '取消置顶' : '置顶'; pin.setAttribute('aria-label', `${pin.title}：${task.title}`);
    pin.onclick = async () => {
      if (busy || pin.disabled) return;
      pin.disabled = true;
      try { await api('/api/tasks/' + task.id + '/pin', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({pinned:!task.pinned})}); await renderList(); }
      catch (error) { showError(error); pin.disabled = false; }
    };
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'task-action-delete';
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6m4-6v6"/></svg>';
    remove.title = '删除'; remove.setAttribute('aria-label', '删除任务：' + task.title);
    remove.onclick = () => showDeleteTaskDialog(task);
    actions.append(pin, remove); row.append(button, actions); list.append(row);
  }
  document.title = anyUnread ? '● 任务聊天' : '任务聊天';
}
function showDeleteTaskDialog(task) {
  if (busy || taskLoading || deleteTaskDialog.open) return;
  taskToDelete = task;
  deleteTaskMessage.textContent = `确定从对话列表移除“${task.title}”吗？服务器留存记录不会因此清空。`;
  deleteTaskError.textContent = ''; deleteTaskDialog.showModal(); confirmDeleteTask.focus();
}
cancelDeleteTask.onclick = () => deleteTaskDialog.close();
deleteTaskDialog.oncancel = event => { if (busy) event.preventDefault(); };
deleteTaskDialog.onclose = () => { taskToDelete = null; deleteTaskError.textContent = ''; };
document.querySelector('#deleteTaskForm').onsubmit = async event => {
  event.preventDefault();
  if (busy || !taskToDelete) return;
  const id = taskToDelete.id;
  ++taskLoadVersion; taskLoading = false; busy = true;
  confirmDeleteTask.disabled = true; cancelDeleteTask.disabled = true; updateComposer();
  try {
    await api('/api/tasks/' + id, {method:'DELETE'});
    drafts.delete(id); delete readReplies[id]; deleteTaskDialog.close();
    if (currentId === id) { input.value = ''; editingId = null; currentId = null; busy = false; newTask(); }
    else await renderList();
  } catch (error) { if (deleteTaskDialog.open) deleteTaskError.textContent = error.message; else showError(error); }
  finally { busy = false; confirmDeleteTask.disabled = false; cancelDeleteTask.disabled = false; updateComposer(); }
};
function renderQueueCard(entry, id) {
  const card = document.createElement('div'); card.className = 'queued-card'; card.draggable = true; card.dataset.messageId = entry.id;
  card.ondragstart = event => {
    if (busy || taskLoading) { event.preventDefault(); return; }
    draggedQueueId = entry.id; card.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(entry.id));
  };
  card.ondragend = () => { card.classList.remove('dragging'); if (draggedQueueId) { draggedQueueId = null; openTask(id).catch(showError); } };
  const grip = document.createElement('span'); grip.className = 'queue-grip'; grip.textContent = '⋮⋮'; grip.title = '调整待接收消息顺序（不会启动执行）';
  const content = document.createElement('div'); content.className = 'queued-card-content'; content.textContent = entry.content;
  const actions = document.createElement('div'); actions.className = 'queued-card-actions';
  const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '编辑'; edit.title = '编辑待接收文字';
  edit.onclick = () => {
    if (busy || taskLoading) return;
    editingUnavailable = false; editingId = entry.id; editNotice.hidden = false; input.value = entry.content; saveDraft(); clearError(); updateComposer(); input.focus();
  };
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = '撤回待接收文字'; remove.setAttribute('aria-label', '撤回待接收文字');
  remove.onclick = async () => {
    if (busy || taskLoading) return;
    ++taskLoadVersion; busy = true; updateComposer();
    try {
      await api(`/api/tasks/${id}/messages/${entry.id}`, {method:'DELETE'});
      if (editingId === entry.id) { editingId = null; editingUnavailable = false; editNotice.hidden = true; input.value = ''; saveDraft(); }
      busy = false; await openTask(id);
    } catch (error) { showError(error); }
    finally { busy = false; updateComposer(); }
  };
  actions.append(edit, remove); card.append(grip, content, actions); queuedMessages.append(card);
}
async function openTask(id, scrollToBottom = false) {
  if (!taskIdPattern.test(id) || busy || draggedQueueId || (taskLoading && currentId === id)) return;
  const version = ++taskLoadVersion;
  const switching = currentId !== id;
  if (switching) { taskLoading = true; updateComposer(); }
  let data;
  try { data = await api('/api/tasks/' + id); }
  catch (error) { if (version === taskLoadVersion) showError(error); return; }
  finally { if (version === taskLoadVersion) { taskLoading = false; updateComposer(); } }
  if (version !== taskLoadVersion || busy) return;
  if (data?.task?.id !== id || !Array.isArray(data.messages)) throw new Error('对话响应无效');
  if (switching) { saveDraft(); currentId = id; restoreDraft(); }
  if (document.visibilityState === 'visible') markRead(id, Math.max(0, ...data.messages.filter(entry => entry.role === 'agent').map(entry => Number(entry.id) || 0)));
  title.textContent = data.task.title; status.textContent = taskLabel(data.task);
  if (editingId && !data.messages.some(entry => entry.id === editingId && entry.queued_editable)) {
    editingUnavailable = true; showError(new Error('这条消息已不可编辑；文字已保留，请复制后取消编辑。'));
  }
  const fingerprint = JSON.stringify(data);
  if (renderedTaskId === id && renderedContent === fingerprint) {
    if (scrollToBottom) messages.scrollTop = messages.scrollHeight;
    updateComposer(); renderList().catch(showError); return;
  }
  const scrollTop = messages.scrollTop;
  const nearBottom = messages.scrollHeight - messages.clientHeight - scrollTop < 80;
  const ids = new Set(data.messages.map(entry => entry.id));
  const hasNewContent = renderedTaskId !== id || [...ids].some(messageId => !renderedMessageIds.has(messageId));
  messages.replaceChildren(); queuedMessages.replaceChildren();
  if (queuedMessages.parentElement !== form.parentElement) form.parentElement.insertBefore(queuedMessages, form);
  for (const entry of data.messages) {
    const item = document.createElement('div'); item.className = 'message ' + (entry.role === 'user' ? 'user' : entry.role === 'error' ? 'error' : 'agent');
    const who = document.createElement('div'); who.className = 'who';
    who.textContent = entry.role === 'user' ? (identity.role === 'owner' ? '你（所有者指令）' : '你') : entry.role === 'agent' ? '所有者回复' : '接收状态';
    item.append(who);
    const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = typeof entry.content === 'string' ? entry.content : ''; item.append(bubble);
    // Intake has no attachments or executable reply markup; render server text only.
    messages.append(item);
  }
  for (const entry of data.messages.filter(entry => entry.role === 'user' && entry.queued_editable).sort((a,b) => (a.queue_position ?? a.id) - (b.queue_position ?? b.id) || a.id - b.id)) renderQueueCard(entry, id);
  queuedMessages.hidden = queuedMessages.childElementCount === 0;
  if (data.task.receipt_state !== 'replied') {
    const waiting = document.createElement('div'); waiting.className = 'waiting'; waiting.textContent = '已收到，等待接收。执行连接器尚未配置。'; messages.append(waiting);
  }
  updateComposer();
  messages.scrollTop = scrollToBottom || switching || (hasNewContent && nearBottom) ? messages.scrollHeight : scrollTop;
  renderedTaskId = id; renderedContent = fingerprint; renderedMessageIds = ids;
  renderList().catch(showError);
}
queuedMessages.addEventListener('dragover', event => {
  if (!draggedQueueId) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'move';
  const target = event.target.closest('.queued-card');
  const dragged = queuedMessages.querySelector('.queued-card.dragging');
  if (!target || !dragged || target === dragged) return;
  const after = event.clientY > target.getBoundingClientRect().top + target.offsetHeight / 2;
  queuedMessages.insertBefore(dragged, after ? target.nextSibling : target);
});
queuedMessages.addEventListener('drop', async event => {
  if (!draggedQueueId || busy || !currentId) return;
  event.preventDefault();
  const id = currentId;
  const message_ids = [...queuedMessages.children].map(card => Number(card.dataset.messageId));
  draggedQueueId = null; ++taskLoadVersion; busy = true; updateComposer();
  try { await api(`/api/tasks/${id}/queue/reorder`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message_ids})}); }
  catch (error) { showError(error); }
  finally { busy = false; renderedContent = null; updateComposer(); if (identityReady && currentId === id) openTask(id).catch(showError); }
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || taskLoading || !identityReady) return;
  if (editingUnavailable) return showError(new Error('消息已不可编辑，请先取消编辑'));
  const content = input.value.trim();
  if (!content) return;
  if (identity.intake_enabled !== true) return showError(new Error('当前暂不接收新消息'));
  ++taskLoadVersion; busy = true; updateComposer(); clearError();
  try {
    const draftKey = currentId;
    const attachments = [];
    const agent_id = null;
    if (editingId) {
      await api(`/api/tasks/${currentId}/messages/${editingId}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({content})});
      editingId = null; editNotice.hidden = true;
    } else if (currentId) {
      await api('/api/tasks/' + currentId + '/messages', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({content, attachments, agent_id})});
    } else {
      const created = await api('/api/tasks', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({content, attachments, agent_id})});
      if (!taskIdPattern.test(created.id)) throw new Error('消息接收响应无效，无法确认新对话');
      currentId = created.id;
    }
    drafts.delete(draftKey); input.value = ''; clearError();
  } catch (error) { showError(error); }
  finally { busy = false; updateComposer(); }
  if (currentId && identityReady) openTask(currentId, true).catch(showError);
});
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
});
attach.onclick = () => showError(new Error(uploadUnavailable));
fileInput.onchange = () => { fileInput.value = ''; showError(new Error(uploadUnavailable)); };
document.querySelector('#dropHint').textContent = uploadUnavailable;
form.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); form.classList.add('dragging'); } });
form.addEventListener('dragleave', event => { if (!form.contains(event.relatedTarget)) form.classList.remove('dragging'); });
form.addEventListener('drop', event => {
  if (!event.dataTransfer.files.length) return;
  event.preventDefault(); form.classList.remove('dragging'); showError(new Error(uploadUnavailable));
});
document.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
document.addEventListener('drop', event => { if (event.dataTransfer.files.length) { event.preventDefault(); showError(new Error(uploadUnavailable)); } });
document.querySelector('#cancelEdit').onclick = () => {
  editingId = null; editingUnavailable = false; editNotice.hidden = true; input.value = ''; saveDraft(); clearError(); updateComposer();
};
document.querySelector('#newTask').onclick = newTask;
async function refresh() {
  if (document.hidden || busy || taskLoading || draggedQueueId) return;
  try {
    await initializeIdentity();
    if (currentId) await openTask(currentId); else await renderList();
  } catch (error) { showError(error); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('focus', refresh);
// Clear private state before BFCache can retain an owner view across logout/navigation.
window.addEventListener('pagehide', clearPrincipal);
window.addEventListener('pageshow', event => { if (event.persisted) refresh(); });
window.refreshChatAgents = refresh;
// Optional accounts live in the existing footer; ordinary questioning never requires login.
const accountFooter = document.createElement('div');
accountFooter.style.marginTop = '10px';
document.querySelector('.identity').append(accountFooter);
const accountDialog = document.createElement('dialog');
accountDialog.className = 'delete-task-dialog';
accountDialog.setAttribute('aria-labelledby', 'accountDialogTitle');
const accountForm = document.createElement('form');
const accountHeading = document.createElement('h2'); accountHeading.id = 'accountDialogTitle';
const accountNote = document.createElement('p'); accountNote.textContent = '可选账号用于跨设备找回自己的对话；不登录也可以提问。';
const usernameLabel = document.createElement('label'); usernameLabel.textContent = '用户名';
const usernameInput = document.createElement('input'); usernameInput.name = 'username'; usernameInput.autocomplete = 'username'; usernameInput.required = true; usernameInput.maxLength = 40;
const passwordLabel = document.createElement('label'); passwordLabel.textContent = '密码';
const passwordInput = document.createElement('input'); passwordInput.name = 'password'; passwordInput.type = 'password'; passwordInput.required = true;
for (const element of [usernameLabel, passwordLabel]) { element.style.display = 'block'; element.style.margin = '12px 0'; }
for (const element of [usernameInput, passwordInput]) { element.style.display = 'block'; element.style.width = '100%'; element.style.boxSizing = 'border-box'; element.style.padding = '8px'; element.style.marginTop = '5px'; }
usernameLabel.append(usernameInput); passwordLabel.append(passwordInput);
const accountError = document.createElement('p'); accountError.className = 'delete-task-error'; accountError.setAttribute('role', 'alert');
const accountActions = document.createElement('div'); accountActions.className = 'delete-task-actions';
const accountCancel = document.createElement('button'); accountCancel.type = 'button'; accountCancel.textContent = '取消';
const accountSubmit = document.createElement('button'); accountSubmit.type = 'submit';
const accountSwitch = document.createElement('button'); accountSwitch.type = 'button'; accountSwitch.style.marginTop = '12px';
accountActions.append(accountCancel, accountSubmit);
accountForm.append(accountHeading, accountNote, usernameLabel, passwordLabel, accountError, accountActions, accountSwitch);
accountDialog.append(accountForm); document.body.append(accountDialog);
let accountMode = 'login';
let accountBusy = false;
let accountRequestKey = null;
function accountModeChanged(mode) {
  accountMode = mode; accountRequestKey = null; accountError.textContent = ''; passwordInput.value = '';
  accountHeading.textContent = mode === 'signup' ? '注册账号' : '登录账号';
  accountSubmit.textContent = mode === 'signup' ? '注册' : '登录';
  accountSwitch.textContent = mode === 'signup' ? '已有账号？登录' : '没有账号？注册';
  passwordInput.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  passwordInput.minLength = mode === 'signup' ? 6 : 1;
  passwordInput.placeholder = mode === 'signup' ? '至少 6 位，无复杂度要求' : '';
}
function updateAccountFooter() {
  accountFooter.replaceChildren();
  if (identityReady && ['owner', 'account'].includes(identity.role)) {
    const name = document.createElement('span'); name.textContent = identity.role === 'owner' ? '所有者已登录' : `已登录：${identity.username || '用户'}`;
    const records = document.createElement('a'); records.href = '/admin/'; records.textContent = '查看记录'; records.style.display = 'block'; records.style.marginTop = '6px';
    const logout = document.createElement('button'); logout.type = 'button'; logout.textContent = '退出'; logout.style.marginTop = '6px';
    logout.onclick = async () => {
      if (busy || accountBusy) return;
      logout.disabled = true; accountBusy = true;
      try {
        const previous = identityKey;
        await initializeIdentity();
        if (identityKey !== previous) throw new Error('身份已改变，请重新操作');
        // Owner auth remains the existing owner-cookie flow. Account auth is separate.
        await request(identity.role === 'owner' ? '/api/logout' : '/api/chat/account/logout', {method:'POST', headers:{'Content-Type':'application/json', 'X-CSRF-Token':identity.csrfToken, 'X-Idempotency-Key':crypto.randomUUID()}, body:'{}'});
        clearPrincipal(); await initializeIdentity(); clearError(); await renderList();
      } catch (error) { clearPrincipal(); showError(error); }
      finally { accountBusy = false; logout.disabled = false; }
    };
    accountFooter.append(name, records, logout);
  } else {
    const login = document.createElement('button'); login.type = 'button'; login.textContent = '登录 / 注册'; login.disabled = !identityReady;
    login.onclick = () => { if (busy || accountBusy) return; accountModeChanged('login'); accountDialog.showModal(); usernameInput.focus(); };
    accountFooter.append(login);
  }
}
accountCancel.onclick = () => { if (!accountBusy) accountDialog.close(); };
accountDialog.oncancel = event => { if (accountBusy) event.preventDefault(); };
accountDialog.onclose = () => { passwordInput.value = ''; accountError.textContent = ''; accountRequestKey = null; };
accountSwitch.onclick = () => { if (!accountBusy) accountModeChanged(accountMode === 'signup' ? 'login' : 'signup'); };
for (const element of [usernameInput, passwordInput]) element.addEventListener('input', () => { accountRequestKey = null; });
accountForm.onsubmit = async event => {
  event.preventDefault(); if (accountBusy) return;
  const username = usernameInput.value.trim(); const password = passwordInput.value;
  if (!username || !password || (accountMode === 'signup' && [...password].length < 6)) { accountError.textContent = '请输入用户名和密码；注册密码至少 6 位。'; return; }
  accountBusy = true; accountSubmit.disabled = true; accountCancel.disabled = true; accountSwitch.disabled = true;
  usernameInput.disabled = true; passwordInput.disabled = true; accountError.textContent = '';
  try {
    const before = identityKey;
    await initializeIdentity();
    if (before && before !== identityKey) throw new Error('身份已改变，请重新操作');
    accountRequestKey ||= crypto.randomUUID();
    await request('/api/chat/account/' + accountMode, {method:'POST', headers:{'Content-Type':'application/json', 'X-CSRF-Token':identity.csrfToken, 'X-Idempotency-Key':accountRequestKey}, body:JSON.stringify({username, password})});
    passwordInput.value = ''; accountDialog.close(); clearPrincipal(); await initializeIdentity(); clearError(); await renderList();
  } catch (error) { accountError.textContent = error.message; passwordInput.value = ''; if (error.status) accountRequestKey = null; }
  finally { accountBusy = false; accountSubmit.disabled = false; accountCancel.disabled = false; accountSwitch.disabled = false; usernameInput.disabled = false; passwordInput.disabled = false; }
};
window.addEventListener('pagehide', () => { passwordInput.value = ''; usernameInput.value = ''; accountRequestKey = null; if (accountDialog.open) accountDialog.close(); });
clearPrincipal(); clearError();
initializeIdentity().then(async () => { clearError(); await renderList(); }).catch(showError);
setInterval(refresh, 5000);
