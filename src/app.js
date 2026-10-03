import { STORAGE_KEY, freshState, emptyState, searchNotes, projectProgress, statuses, isValidState, createWorkspaceClient } from './model.js';
const $ = (q) => document.querySelector(q);
const icons = {
 overview: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
 projects:'<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/>',
 knowledge:'<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/>',
 tasks:'<rect x="4" y="4" width="16" height="17" rx="3"/><path d="M9 3h6M8 12l2 2 6-6M8 18h8"/>',
 search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>', plus:'<path d="M12 5v14M5 12h14"/>', arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>', down:'<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>', check:'<path d="m5 12 4 4L19 6"/>', clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', sparkle:'<path d="m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3Z"/>'
};
const ico = (name) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]||icons.sparkle}</svg>`;
const esc = (s) => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Only the authenticated server injects this marker. An API failure must never
// turn a private server workspace into the public local demo.
const serverMode = document.querySelector('meta[name="workspace-mode"]')?.content === 'server';
const client = createWorkspaceClient();
let state = serverMode ? emptyState() : freshState();
let session = null, phase = serverMode ? 'loading' : 'ready', authError = '';
let revision = 0, dirtyRevision = null, storageError = false, busy = false, dirty = null, saveError = '', conflict = false;
let requests = [], nextCursor = null, taskError = '', taskBusy = false, polling = null;
let view = 'overview', selectedProject = null, query = '', taskFilter = '全部';
let modalKind = null, detailId = null, detailEvents = [], pendingRequestDraft = null, pendingEditor = null;
let requestMutationBusy = false;
const requestOperationKeys = new Map();
let toastTimer, sessionGeneration = 0;
if (!serverMode) {
  try { const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); if (isValidState(saved)) state = saved; }
  catch { storageError = true; }
  state.requests ||= [];
}
const project = id => state.projects.find(p => p.id === id);
const queueLabels = {draft:'草稿',pending:'排队中',running:'执行中',blocked:'受阻',needs_approval:'等待授权',completed:'已完成',failed:'失败',cancelled:'已取消'};
const allRequests = () => serverMode ? requests : state.requests;
const displayTime = value => value ? new Date(value).toLocaleString('zh-CN') : '—';
function toast(text) {
  $('#toast').textContent = text; $('#toast').classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 5000);
}
function errorText(error) {
  if (error.status === 401) return '登录已过期。未保存的修改只保留在当前页面内存中，请重新登录后处理。';
  if (error.code === 'revision_conflict') return '另一页面已更新此工作空间。你的修改尚未保存；请先导出未保存内容，再载入服务器版本。';
  if (error.status === 403) return '请求未通过安全校验，未确认保存。请重新登录后再试。';
  if (error.status === 429) return '尝试过于频繁，请稍后再试。';
  if (error.code === 'network_error') return '无法确认服务器是否收到请求。请检查连接；当前修改尚未确认保存。';
  return error.message || '操作失败，修改尚未保存。';
}
function rememberRequestForm() {
  const form = $('#request-form');
  if (form && !form.dataset.busy) { const f = new FormData(form); pendingRequestDraft = {...pendingRequestDraft,id:form.dataset.requestId || null,title:String(f.get('title') || ''),instructions:String(f.get('body') || '')}; }
}
function rememberEditorForm() {
  if (dirty || !['note','project','task'].includes(modalKind)) return;
  const form = $('#note-dialog form');
  if (form) pendingEditor = {kind:modalKind,id:form.dataset.editId || null,fields:Object.fromEntries(new FormData(form))};
}
function lockSession(message = '') {
  rememberEditorForm(); rememberRequestForm(); sessionGeneration += 1; session = null; client.setCsrfToken(null);
  phase = 'login'; authError = message; clearTimeout(polling); polling = null;
  $('#note-dialog').close(); $('#note-dialog').innerHTML = ''; modalKind = null; detailId = null;
  state = emptyState(); requests = []; detailEvents = []; render();
}
function handleFailure(error) {
  if (error.status === 401 || (error.status === 403 && ['csrf_invalid','csrf_denied'].includes(error.code))) lockSession(errorText(error));
}
async function loadAuthenticated(info) {
  const generation=sessionGeneration;
  session = info; client.setCsrfToken(info.csrfToken); phase = 'loading'; render();
  try {
    const envelope = await client.getWorkspace();
    if(generation!==sessionGeneration)return;
    state = envelope.workspace; revision = envelope.revision;
    selectedProject = state.projects[0]?.id || null;
    phase = 'ready'; authError = ''; render();
    await refreshTasks(); schedulePoll();
  } catch (error) {
    if (error.status === 401) { lockSession(errorText(error)); return; }
    phase = 'load-error'; authError = errorText(error); render();
  }
}
async function start() {
  route(); if (!serverMode) return;
  try {
    const info = await client.getSession();
    if (info.authenticated) await loadAuthenticated(info);
    else { session = info; phase = 'login'; render(); }
  } catch (error) { phase = 'load-error'; authError = errorText(error); render(); }
}
async function persist(candidate, successText) {
  if (busy) return false;
  if (!dirty) dirtyRevision = revision;
  dirty = candidate; busy = true; saveError = ''; updateSaveStatus();
  try {
    if (serverMode) {
      const envelope = await client.saveWorkspace(candidate, dirtyRevision);
      state = envelope.workspace; revision = envelope.revision;
    } else { localStorage.setItem(STORAGE_KEY, JSON.stringify(candidate)); state = candidate; storageError = false; }
    dirty = null; dirtyRevision = null; saveError = ''; conflict = false; toast(successText); return true;
  } catch (error) {
    storageError = !serverMode; conflict = error.code === 'revision_conflict';
    saveError = serverMode ? errorText(error) : '浏览器无法保存。修改只在当前页面内存中，请导出未保存内容。';
    handleFailure(error); toast(saveError); return false;
  } finally { busy = false; updateSaveStatus(); }
}
async function changeWorkspace(change, text) {
  if (busy || dirty) { toast('请先处理未保存的修改。'); return false; }
  const candidate = structuredClone(state); change(candidate);
  const ok = await persist(candidate, text); render(); return ok;
}
function updateSaveStatus() {
  const el = $('#save-status'); if (el) el.textContent = busy ? '正在保存…' : dirty ? '有未保存的修改' : serverMode ? '已连接服务器' : storageError ? '本地保存不可用' : '当前浏览器保存';
  document.querySelectorAll('[data-mutates]').forEach(button => button.disabled = busy || Boolean(dirty));
}
function exportData(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type:'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function recoveryBanner() {
  if (!dirty && !saveError) return pendingEditor ? '<div class="recovery-banner"><strong>有一份未保存的编辑内容</strong><p>内容只保留在当前页面内存中，请恢复编辑并保存。</p><button class="button secondary" data-action="resume-editor">恢复编辑内容</button></div>' : '';
  return `<div class="recovery-banner" role="alert"><strong>修改尚未保存</strong><p>${esc(saveError || '请重试保存或导出备份。刷新页面会丢失未保存内容。')}</p><div class="button-row">${!conflict ? '<button class="button secondary" data-action="retry-save">重试保存</button>' : ''}<button class="button secondary" data-action="export-unsaved">导出未保存内容</button><button class="button secondary" data-action="reload-workspace">${serverMode ? '载入服务器版本' : '放弃未保存修改'}</button></div></div>`;
}
function nav() {
  return `<aside class="sidebar"><a class="brand" href="#overview"><span class="brand-mark">${ico('sparkle')}</span><span>GPT-DOT-WORK</span></a><div class="workspace-select"><span class="avatar">我</span><div><strong>${esc(session?.owner?.name || '我的工作空间')}</strong><small>让想法有迹可循</small></div></div><div class="nav-label">工作空间</div><nav>${[['overview','总览'],['projects','项目'],['knowledge','知识库'],['tasks','任务']].map(([key,name])=>`<a href="#${key}" class="nav-item ${view===key?'active':''}" ${view===key?'aria-current="page"':''}>${ico(key)}<span>${name}</span>${key==='tasks'?`<em>${state.tasks.filter(t=>t.status!=='已完成').length}</em>`:''}</a>`).join('')}</nav><div class="sidebar-projects"><div class="nav-label">置顶项目</div>${state.projects.map(p=>`<button class="project-link" data-project="${p.id}"><i class="dot ${p.color}"></i>${esc(p.name)}</button>`).join('')}<button class="project-link" data-action="new-project" data-mutates>＋ 新建项目</button></div><div class="sidebar-bottom"><div class="local-label"><span class="status-dot"></span>${serverMode?'已登录 · 私有服务器':'本地演示空间'}</div><p>${serverMode?'数据保存到你的服务器<br>真实 AI 执行器未配置':'数据保存在当前浏览器<br>虚构示例 · 不会执行任务'}</p><button class="export-button" data-action="export">${ico('down')}导出${serverMode?'工作空间':'本地数据'}</button><div class="profile"><span class="avatar small">我</span><div><strong>${esc(session?.owner?.name || '探索者')}</strong><small>独立项目 · 非官方</small></div></div></div></aside>`;
}
function header() { return `<header class="topbar"><div class="breadcrumb">工作空间 <span>/</span> <strong>${{overview:'总览',projects:'项目',knowledge:'知识库',tasks:'任务'}[view]}</strong></div><div class="topbar-right"><span class="demo-badge ${serverMode?'server-badge':''}">${serverMode?'私有服务器':'离线演示'}</span><span id="save-status" class="save-status"></span>${serverMode?'<button class="text-button" data-action="logout">退出登录</button>':''}</div></header>`; }

function taskRow(t){return `<div class="task-row"><button class="task-check ${t.status==='已完成'?'checked':''}" data-mutates data-toggle-task="${esc(t.id)}" aria-label="${t.status==='已完成'?'重新打开':'完成'}：${esc(t.title)}">${t.status==='已完成'?ico('check'):''}</button><div class="task-main"><strong class="${t.status==='已完成'?'strike':''}">${esc(t.title)}</strong><small>${esc(project(t.projectId)?.name)} <span>·</span> ${esc(t.due)}</small></div>${t.priority==='优先'?'<span class="priority">优先</span>':''}<select class="status-select" aria-label="${esc(t.title)}状态" data-mutates data-task-status="${esc(t.id)}">${statuses.map(s=>`<option ${s===t.status?'selected':''}>${s}</option>`).join('')}</select></div>`;}
function projectCard(p){let progress=projectProgress(state,p.id);return `<button class="project-card" data-project="${p.id}"><div class="card-top"><span class="project-icon ${p.color}">${esc(p.icon)}</span><span class="tag">${esc(p.category)}</span><span class="card-arrow">↗</span></div><h3>${esc(p.name)}</h3><p>${esc(p.description)}</p><div class="progress-meta"><span>${esc(p.stage)}</span><span>${progress}%</span></div><div class="progress-track"><div style="width:${progress}%" class="${p.color}"></div></div><div class="card-bottom"><span>${state.notes.filter(n=>n.projectId===p.id).length} 篇笔记</span><span>${state.tasks.filter(t=>t.projectId===p.id&&t.status!=='已完成').length} 项待办 ${ico('arrow')}</span></div></button>`;}
function noteCard(n){return `<button class="note-card" data-note="${esc(n.id)}"><div class="note-meta"><span class="note-type">${ico('knowledge')}${esc(n.type)}</span><span>${esc(n.updated.slice(0,10))}</span></div><h3>${esc(n.title)}</h3><p>${esc(n.body.replace(/\n/g,' '))}</p><div class="note-tags">${n.tags.map(t=>`<span># ${esc(t)}</span>`).join('')}</div><div class="note-project"><i class="dot ${project(n.projectId)?.color||'blue'}"></i>${esc(project(n.projectId)?.name)}</div></button>`;}
function overview(){const open=state.tasks.filter(t=>t.status!=='已完成'), decisions=state.decisions.filter(d=>!d.resolved);return `<section class="welcome"><div><div class="eyebrow">YOUR PERSONAL WORKSPACE</div><h1>给想法一个落脚的地方<span>。</span></h1><p>把知识连起来，把重要的事慢慢做好。</p></div><button class="button primary" data-action="new-note">${ico('plus')}记录想法</button></section><section class="summary-grid"><div><span class="summary-icon blue">${ico('projects')}</span><p>进行中的项目<strong>${state.projects.length}<small>个正在生长的方向</small></strong></p></div><div><span class="summary-icon purple">${ico('knowledge')}</span><p>积累的知识<strong>${state.notes.length}<small>条想法，随时可回顾</small></strong></p></div><div><span class="summary-icon orange">${ico('tasks')}</span><p>待推进的任务<strong>${open.length}<small>专注下一步行动</small></strong></p></div></section><section><div class="section-heading"><h2>正在推进 <span>把注意力留给重要的事</span></h2><a href="#projects">查看全部 ${ico('arrow')}</a></div><div class="project-grid">${state.projects.map(projectCard).join('') || emptyProjects()}</div></section><div class="two-column"><section class="panel"><div class="section-heading"><h2>接下来做什么 <span class="count">${open.length}</span></h2><a href="#tasks">全部任务 ${ico('arrow')}</a></div>${open.slice(0,3).map(taskRow).join('')||'<p class="empty">暂时没有待办，享受一点留白。</p>'}</section><section class="decision-panel"><div class="section-heading"><h2>${ico('sparkle')} 等你决定</h2><span class="count">${decisions.length}</span></div>${decisions.map(d=>`<div class="decision"><small>${esc(project(d.projectId)?.name)}</small><h3>${esc(d.title)}</h3><p>${esc(d.detail)}</p><button data-mutates data-decision="${d.id}">标记已决定 ${ico('arrow')}</button></div>`).join('')||'<p class="empty">所有决定都已处理。</p>'}</section></div><section><div class="section-heading"><h2>最近留下的想法 <span>为下一次灵感铺路</span></h2><a href="#knowledge">打开知识库 ${ico('arrow')}</a></div><div class="note-grid">${[...state.notes].sort((a,b)=>b.updated.localeCompare(a.updated)).slice(0,3).map(noteCard).join('')}</div></section>`;}
function knowledge(){let notes=searchNotes(state.notes,query);return `<div class="page-heading"><div><div class="eyebrow">KNOWLEDGE GARDEN</div><h1>知识在连接中生长。</h1><p>收下灵感，也留下自己的理解。</p></div><button class="button primary" data-action="new-note">${ico('plus')}新建笔记</button></div><div class="knowledge-toolbar"><label class="search">${ico('search')}<input id="knowledge-search" placeholder="搜索标题、内容或标签…" value="${esc(query)}" aria-label="搜索知识库"><kbd>⌘ K</kbd></label><span>${notes.length} 篇笔记</span></div><div class="note-grid knowledge-grid">${notes.map(noteCard).join('')||'<div class="empty panel">没有找到相关笔记。试试其他关键词。</div>'}</div>`;}
function emptyProjects() { return '<div class="empty panel empty-start"><h3>从你的第一个项目开始</h3><p>为空间起一个方向，再添加笔记和待办。</p><button class="button primary" data-action="new-project" data-mutates>＋ 新建项目</button></div>'; }
function projects() {
  const p = project(selectedProject) || state.projects[0];
  return `<div class="page-heading"><div><div class="eyebrow">PROJECTS</div><h1>让每个方向，向前一步。</h1><p>计划、知识和行动，在这里汇合。</p></div><button class="button primary" data-action="new-project" data-mutates>${ico('plus')}新建项目</button></div><div class="project-grid">${state.projects.map(projectCard).join('') || emptyProjects()}</div>${p ? `<section class="project-detail panel"><div class="detail-heading"><span class="project-icon ${p.color}">${esc(p.icon)}</span><div><small>${esc(p.category)} / ${esc(p.stage)}</small><h2>${esc(p.name)}</h2></div><button class="text-button" data-action="edit-project" data-mutates>编辑项目</button></div><div class="plan-box"><span>当前计划</span><p>${esc(p.plan || '还没有填写计划。')}</p></div><div class="section-heading"><h2>下一步行动</h2><button class="text-button" data-action="new-task" data-mutates>+ 添加任务</button></div>${state.tasks.filter(t=>t.projectId===p.id).map(taskRow).join('') || '<p class="empty">还没有待办，写下一个具体行动吧。</p>'}<div class="section-heading"><h2>相关知识</h2><button class="text-button" data-action="new-note" data-mutates>+ 写一条笔记</button></div><div class="note-grid">${state.notes.filter(n=>n.projectId===p.id).map(noteCard).join('') || '<p class="empty">还没有笔记，记录第一条想法吧。</p>'}</div></section>` : ''}`;
}
function tasks() {
  const entries = allRequests();
  return `<div class="page-heading"><div><div class="eyebrow">FOCUS & ACTION</div><h1>从一个小行动开始。</h1><p>清晰地安排事情，也给自己留一点余地。</p></div><button class="button primary" data-action="new-task" data-mutates>${ico('plus')}添加待办</button></div><section class="panel"><div class="tabs">${['全部',...statuses].map(s=>`<button data-filter="${s}" class="${taskFilter===s?'selected':''}">${s} <span>${state.tasks.filter(t=>s==='全部'||t.status===s).length}</span></button>`).join('')}</div>${state.tasks.filter(t=>taskFilter==='全部'||t.status===taskFilter).map(taskRow).join('') || '<p class="empty">这个状态下还没有待办。</p>'}</section><section class="execution panel"><div class="section-heading"><h2>交给 AI 的需求 <span>草稿与提交分开保存</span></h2><button class="button secondary" data-action="new-request">${ico('plus')}起草需求</button></div><div class="notice">${ico('sparkle')}${serverMode ? '需求与执行记录保存到服务器。真实 AI 执行器未配置，不会调用 AI、运行命令或完成外部操作。' + (session?.demo ? '当前队列仅提供明确标注的模拟结果。' : '提交后可能排队或受阻，请以服务器状态为准。') : '离线演示：仅保存本地草稿与提交记录，不会加入真实队列或运行任务。'}</div>${taskError ? `<p class="inline-error" role="alert">${esc(taskError)} <button class="text-button" data-action="refresh-tasks">刷新状态</button></p>` : ''}${pendingRequestDraft ? '<div class="recovery-banner"><p>有一份尚未确认保存的需求内容，只保留在当前页面。</p><button class="button secondary" data-action="resume-request">恢复需求内容</button></div>' : ''}${entries.length ? entries.map(r=>`<button class="request-row" data-request="${esc(r.id)}"><div><strong>${esc(r.title)}</strong><small>${esc((r.instructions || r.body || '').slice(0,90))}</small></div><span class="queue-status ${Object.hasOwn(queueLabels,r.status)?r.status:'unknown'}">${esc(queueLabels[r.status] || '未知状态')}</span><span>↗</span></button>`).join('') : '<div class="request-empty"><span>✧</span><h3>把需求说清楚，是完成的第一步。</h3><p>先保存草稿；只有明确点击提交后才会进入任务队列。</p></div>'}${nextCursor ? '<button class="button secondary" data-action="more-tasks">加载更早的需求</button>' : ''}</section>`;
}
function renderAuth() {
  const loading = phase === 'loading';
  $('#app').innerHTML = `<main class="auth-shell"><section class="auth-card"><div class="auth-brand"><span class="brand-mark">${ico('sparkle')}</span>GPT-DOT-WORK</div><div class="eyebrow">PRIVATE PERSONAL WORKSPACE</div><h1>${loading ? '正在连接你的工作空间…' : '你的想法，安心放在这里。'}</h1><p>单人私有工作空间 · 服务器模式</p>${loading ? '<div class="loading-state" role="status">正在检查登录状态与载入数据，请稍候。</div>' : `<p class="inline-error" role="alert">${esc(authError)}</p>${phase === 'load-error' ? '<button class="button primary" id="retry-load">重新连接</button>' : session?.loginConfigured === false ? '<div class="notice">服务器还没有配置所有者登录。请由部署者完成安全配置后重试。</div><button class="button secondary" id="retry-load">重新检查</button>' : `<form id="login-form"><label for="owner-password">所有者密码<input id="owner-password" name="password" type="password" autocomplete="current-password" required maxlength="1024" placeholder="输入你为这个工作空间设置的密码"></label><button class="button primary" type="submit">登录工作空间</button></form>`}`}${dirty || pendingRequestDraft || pendingEditor ? '<p class="security-note">仍有未保存的内容保留在此页面内存中。不要刷新或关闭页面；重新登录后可处理。</p>' : ''}<p class="security-note">登录后才会载入私人数据。此模式不会读取浏览器里的演示数据。</p></section></main>`;
  $('#retry-load')?.addEventListener('click', () => {phase='loading'; render(); void start();});
  $('#login-form')?.addEventListener('submit', async e => {
    e.preventDefault(); const form = e.currentTarget; const input = form.elements.password;
    const password = input.value; const button = form.querySelector('button'); button.disabled = true; button.textContent = '正在登录…';
    try {
      const info = await client.login(password); input.value = '';
      if (!info.authenticated || typeof info.csrfToken !== 'string') throw new Error('登录响应不完整，请重新连接。');
      await loadAuthenticated(info);
    } catch (error) { input.value = ''; authError = error.status === 401 ? '密码不正确，或登录未成功。请重试。' : errorText(error); phase='login'; render(); $('#owner-password')?.focus(); }
  });
}
function render() {
  if (serverMode && phase !== 'ready') { renderAuth(); return; }
  $('#app').innerHTML = `${nav()}<div class="main">${header()}<main>${recoveryBanner()}${view==='overview'?overview():view==='projects'?projects():view==='knowledge'?knowledge():tasks()}<footer><span>GPT-DOT-WORK · 独立非官方项目</span><span>${serverMode ? `私有服务器 · 工作空间版本 ${revision} · 真实执行器未配置` : '仅当前浏览器保存 · 虚构演示数据'}</span></footer></main></div>`;
  bind(); updateSaveStatus();
}
function closeModal() { $('#note-dialog').close(); $('#note-dialog').innerHTML=''; modalKind=null; detailId=null; detailEvents=[]; }
function modal(content, kind) {
  const d = $('#note-dialog'); d.innerHTML=content; modalKind=kind;
  if (!d.open) d.showModal();
  d.querySelector('[data-close]')?.addEventListener('click',closeModal);
  d.querySelector('input,textarea,button')?.focus();
}
function editorAllowed() {
  if (dirty || busy) { toast('请先处理未保存的修改，再继续编辑。'); return false; }
  return true;
}
function needsProject() {
  if (state.projects.length) return false;
  toast('先创建一个项目，就能添加笔记与待办。'); projectEditor(); return true;
}
function projectOptions(selected) { return state.projects.map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${esc(p.name)}</option>`).join(''); }
function formBusy(form, value) { form.querySelectorAll('button,input,textarea,select').forEach(el=>el.disabled=value); }
async function saveEditor(form, candidate, message) {
  formBusy(form,true); const ok=await persist(candidate,message); formBusy(form,false);
  if (ok) { pendingEditor=null; closeModal(); }
  else if(phase==='ready'){let error=form.querySelector('.inline-error');if(!error){error=document.createElement('p');error.className='inline-error';error.setAttribute('role','alert');form.append(error);}error.textContent=saveError;}
  render();
}
function projectEditor(id) {
  if (!editorAllowed()) return;
  const p = project(id);
  modal(`<form id="project-form" data-edit-id="${esc(id || '')}"><div class="modal-heading"><div><small>PROJECT</small><h2>${p?'编辑项目':'开始一个新方向'}</h2></div><button class="close" type="button" data-close aria-label="关闭">×</button></div><label>项目名称<input name="name" required maxlength="120" value="${esc(p?.name)}" placeholder="例如：我的学习计划"></label><label>一句话介绍<input name="description" maxlength="1000" value="${esc(p?.description)}" placeholder="这个项目想实现什么？"></label><label>当前阶段<input name="stage" maxlength="120" value="${esc(p?.stage || '准备开始')}"></label><label>计划<textarea name="plan" rows="5" maxlength="20000">${esc(p?.plan)}</textarea></label><label>颜色<select name="color">${[['blue','蓝色'],['orange','暖橙'],['purple','紫色']].map(([value,label])=>`<option value="${value}" ${p?.color===value?'selected':''}>${label}</option>`).join('')}</select></label><div class="modal-footer"><small>${serverMode?'保存到私有服务器。':'仅保存在当前浏览器。'}</small><button class="button primary" type="submit">保存项目</button></div></form>`,'project');
  $('#project-form').onsubmit=async e=>{
    e.preventDefault(); if(busy)return; const f=new FormData(e.target), name=String(f.get('name')).trim(); if(!name)return;
    const item={id:p?.id || crypto.randomUUID(),name,description:String(f.get('description')).trim(),stage:String(f.get('stage')).trim() || '准备开始',plan:String(f.get('plan')).trim(),color:f.get('color'),icon:p?.icon || '✳',category:p?.category || '个人项目'};
    const candidate=structuredClone(state); if(p)candidate.projects=candidate.projects.map(x=>x.id===p.id?item:x);else candidate.projects.push(item);
    selectedProject=item.id; await saveEditor(e.target,candidate,serverMode?'项目已保存到服务器':'项目已保存到本地');
  };
}
function noteEditor(id) {
  if(!editorAllowed() || needsProject())return;
  const n=state.notes.find(n=>n.id===id);
  modal(`<form id="note-form" data-edit-id="${esc(id || '')}"><div class="modal-heading"><div><small>KNOWLEDGE NOTE</small><h2>${n?'编辑笔记':'留下一条新想法'}</h2></div><button type="button" class="close" data-close aria-label="关闭">×</button></div><label>标题<input name="title" required maxlength="120" value="${esc(n?.title)}" placeholder="给想法起个名字"></label><label>所属项目<select name="projectId">${projectOptions(n?.projectId || selectedProject)}</select></label><label>内容<textarea name="body" required rows="8" maxlength="20000" placeholder="写下想法、背景和下一步…">${esc(n?.body)}</textarea></label><label>标签 <span>用逗号分隔</span><input name="tags" value="${esc(n?.tags?.join(', '))}" maxlength="200" placeholder="知识管理, 灵感"></label><div class="modal-footer"><small>${serverMode?'保存到私有服务器。':'仅保存在当前浏览器，请勿输入敏感信息。'}</small><button type="submit" class="button primary">保存笔记</button></div></form>`,'note');
  $('#note-form').onsubmit=async e=>{
    e.preventDefault(); if(busy)return; const f=new FormData(e.target),title=String(f.get('title')).trim(),body=String(f.get('body')).trim();
    if(!title||!body){toast('标题和内容不能为空。');return;}
    const note={id:n?.id || crypto.randomUUID(),title,body,projectId:f.get('projectId'),tags:String(f.get('tags')).split(/[,，]/).map(s=>s.trim()).filter(Boolean),type:n?.type || '笔记',updated:new Date().toISOString()};
    const candidate=structuredClone(state); if(n)candidate.notes=candidate.notes.map(x=>x.id===n.id?note:x);else candidate.notes.unshift(note);
    await saveEditor(e.target,candidate,serverMode?'笔记已保存到服务器':'笔记已保存到本地');
  };
}
function taskEditor() {
  if(!editorAllowed() || needsProject())return;
  modal(`<form id="task-form"><div class="modal-heading"><h2>给下一步一个名字</h2><button class="close" type="button" data-close aria-label="关闭">×</button></div><label>待办名称<input name="title" required maxlength="120" placeholder="一件具体、可以完成的事"></label><label>所属项目<select name="projectId">${projectOptions(selectedProject)}</select></label><div class="modal-footer"><small>这是个人待办。添加待办不会启动 AI 执行。</small><button type="submit" class="button primary">添加待办</button></div></form>`,'task');
  $('#task-form').onsubmit=async e=>{
    e.preventDefault(); if(busy)return; const f=new FormData(e.target),title=String(f.get('title')).trim(); if(!title)return;
    const candidate=structuredClone(state); candidate.tasks.unshift({id:crypto.randomUUID(),title,projectId:f.get('projectId'),status:'待开始',priority:'普通',due:'未设日期'});
    await saveEditor(e.target,candidate,serverMode?'待办已保存到服务器':'待办已添加到本地');
  };
}
function upsertRequest(task) { requests=[task,...requests.filter(r=>r.id!==task.id)].sort((a,b)=>b.createdAt-a.createdAt); }
async function refreshTasks(append=false) {
  if(!serverMode || phase!=='ready' || taskBusy)return;
  const generation=sessionGeneration; taskBusy=true;
  try {
    const data=await client.listTasks(append?nextCursor:null);
    if(generation!==sessionGeneration || phase!=='ready')return;
    if(!Array.isArray(data.tasks))throw new Error('需求列表响应无效。');
    requests=append?[...requests,...data.tasks.filter(t=>!requests.some(r=>r.id===t.id))]:data.tasks;
    nextCursor=data.nextCursor; taskError='';
    if(view==='tasks')render();
    if(detailId)await refreshDetail(detailId);
  } catch(error) {if(generation!==sessionGeneration)return;taskError=errorText(error);handleFailure(error);if(phase==='ready'&&view==='tasks')render();}
  finally {taskBusy=false;}
}
function schedulePoll() {
  clearTimeout(polling);
  if(!serverMode || phase!=='ready')return;
  polling=setTimeout(async()=>{if(!document.hidden)await refreshTasks();schedulePoll();},5000);
}
function requestEditor(id, recovered=null) {
  const r=recovered || allRequests().find(x=>x.id===id);
  if(r && r.status && r.status!=='draft'){void openRequestDetail(r);return;}
  modal(`<form id="request-form" data-request-id="${esc(id || r?.id || '')}"><div class="modal-heading"><div><small>REQUEST DRAFT</small><h2>${r?'编辑需求草稿':'你希望完成什么？'}</h2></div><button class="close" type="button" data-close aria-label="关闭">×</button></div><label>需求标题<input name="title" required maxlength="160" value="${esc(r?.title)}" placeholder="例如：把公开资料整理成一页摘要"></label><label>目标、交付物与允许的操作<textarea name="body" required rows="7" maxlength="8000" placeholder="我希望…\n交付物是…\n允许的操作…\n需要先问我的事项…">${esc(r?.instructions || r?.body)}</textarea></label><div class="notice">${serverMode?'保存草稿只写入服务器，不会进入执行队列。保存后可查看并明确提交。真实 AI 执行器未配置。':'离线演示：保存草稿和提交记录均仅在当前浏览器保存，不会触发执行。'}</div><p id="request-form-error" class="inline-error" role="alert"></p><div class="modal-footer"><small>先保存，再确认提交。</small><button class="button primary" type="submit">保存草稿</button></div></form>`,'request');
  let requestId=id || r?.id || null, operationKey=r?.operationKey || crypto.randomUUID();
  $('#request-form').onsubmit=async e=>{
    e.preventDefault();const form=e.target;if(form.dataset.busy)return;
    const f=new FormData(form),title=String(f.get('title')).trim(),instructions=String(f.get('body')).trim(); if(!title||!instructions){toast('请先填写标题和需求。');return;}
    if(!serverMode){
      const candidate=structuredClone(state),item={id:requestId || crypto.randomUUID(),title,body:instructions,status:'draft',updated:new Date().toISOString()};
      candidate.requests=candidate.requests.filter(x=>x.id!==item.id);candidate.requests.unshift(item);
      if(await persist(candidate,'本地草稿已保存，尚未提交。')){closeModal();render();void openRequestDetail(item);}else render();return;
    }
    const payload={title,instructions,kind:r?.kind || 'task'};
    // A request key stays stable after an uncertain save, including recovery.
    // Changing text cannot silently create a second draft after a lost response.
    pendingRequestDraft={id:requestId,title,instructions,operationKey};form.dataset.busy='true';formBusy(form,true);
    const generation=sessionGeneration;
    try {
      const data=requestId?await client.editTask(requestId,payload,operationKey):await client.createTask(payload,operationKey);
      if(!data.task?.id)throw new Error('保存响应不完整，请刷新需求列表核对。');
      requestId=data.task.id;
      if(generation!==sessionGeneration || phase!=='ready'){pendingRequestDraft={id:requestId,title,instructions};return;}
      upsertRequest(data.task);pendingRequestDraft=null;closeModal();render();toast('需求草稿已保存到服务器，尚未提交。');await openRequestDetail(data.task);
    } catch(error){handleFailure(error);const el=$('#request-form-error');if(el)el.textContent=errorText(error);toast(errorText(error));}
    finally{delete form.dataset.busy;formBusy(form,false);}
  };
}
function requestDetailMarkup(r) {
  const isServer=serverMode, body=r.instructions || r.body || '', status=queueLabels[r.status] || '未知状态';
  const approval=r.status==='needs_approval' && r.approval?.status==='pending';
  const events=detailEvents.map(event=>`<li><time>${esc(displayTime(event.at))}</time><strong>${esc(event.type)}</strong><pre>${esc(JSON.stringify(event.details || {},null,2))}</pre></li>`).join('');
  return `<div class="modal-heading"><div><small>${isServer?'SERVER REQUEST':'LOCAL DEMO REQUEST'}</small><h2>${esc(r.title)}</h2></div><button class="close" data-close aria-label="关闭">×</button></div><span class="queue-status ${Object.hasOwn(queueLabels,r.status)?r.status:'unknown'}">${esc(status)}</span><p class="request-body">${esc(body)}</p><div class="notice">${isServer?'真实 AI 执行器未配置。状态、结果和日志均读取自服务器。':'本地演示，不会启动实际执行。'}</div>${r.error?`<div class="recovery-banner"><strong>${esc(r.error.code)}</strong><p>${esc(r.error.message)}</p></div>`:''}<div class="plan-box"><span>结果</span>${r.result?`<p>${esc(r.result.simulated?'模拟结果，未执行真实操作。':'服务器返回的结果')}</p><pre class="result-text">${esc(typeof r.result==='string'?r.result:JSON.stringify(r.result,null,2))}</pre>`:`<p>${r.status==='draft'?'草稿尚未提交。':isServer?'服务器尚未返回结果。':'没有真实执行结果。'}</p>`}<small>更新于 ${esc(displayTime(r.updatedAt || r.updated))}</small></div>${approval?`<section class="approval-box"><h3>这一步需要你的明确授权</h3><p>${esc(r.approval.action)}</p><small>授权编号：${esc(r.approval.requestId)}</small><label class="consent"><input type="checkbox" id="approval-consent">我已阅读上面的具体操作，并授权这一次操作。</label><div class="button-row"><button class="button primary" data-task-action="approval" data-decision="approve" data-request-id="${esc(r.approval.requestId)}">确认授权此操作</button><button class="button secondary" data-task-action="approval" data-decision="reject" data-request-id="${esc(r.approval.requestId)}">拒绝授权</button></div></section>`:''}${r.status==='draft'?`<label class="consent"><input id="submit-consent" type="checkbox">我确认提交以上需求，知晓当前没有真实 AI 执行器。</label><div class="button-row"><button class="button secondary" id="edit-request">编辑草稿</button><button class="button primary" data-task-action="submit">${isServer?'确认提交到服务器队列':'确认提交（演示）'}</button></div>`:''}<div class="button-row request-actions">${!['completed','failed','cancelled'].includes(r.status)?'<button class="button secondary" data-task-action="cancel">取消需求</button>':''}${isServer&&['blocked','failed','cancelled'].includes(r.status)&&r.submittedAt?'<button class="button secondary" data-task-action="retry">重新提交一次</button>':''}${isServer?'<button class="text-button" id="refresh-detail">刷新状态</button>':''}</div><p id="detail-error" class="inline-error" role="alert"></p>${isServer?`<details class="event-list" open><summary>服务器日志（${detailEvents.length}）</summary><ol>${events || '<li>暂无日志，或正在读取…</li>'}</ol></details>`:''}`;
}
async function openRequestDetail(r) {
  detailId=r.id; detailEvents=[]; modal(requestDetailMarkup(r),'request-detail'); $('#note-dialog').dataset.reviewedRevision=String(r.revision || ''); bindDetail(r);
  if(serverMode)await refreshDetail(r.id);
}
async function refreshDetail(id) {
  if (requestMutationBusy) return;
  const generation=sessionGeneration;
  try {
    const [data,log]=await Promise.all([client.getTask(id),client.getEvents(id)]);
    if(detailId!==id || generation!==sessionGeneration || phase!=='ready')return;
    const old=allRequests().find(x=>x.id===id);
    upsertRequest(data.task);detailEvents=log.events || [];
    // Keep a checked consent only while the exact reviewed state/request remains.
    const d=$('#note-dialog'),scroll=d.scrollTop,submitChecked=$('#submit-consent')?.checked;
    const approvalChecked=$('#approval-consent')?.checked,oldRequest=d.querySelector('[data-request-id]')?.dataset.requestId;
    d.innerHTML=requestDetailMarkup(data.task);bindDetail(data.task);
    d.querySelector('[data-close]')?.addEventListener('click',closeModal);
    if(data.task.status==='draft' && Number(d.dataset.reviewedRevision)===data.task.revision && $('#submit-consent'))$('#submit-consent').checked=Boolean(submitChecked);
    d.dataset.reviewedRevision=String(data.task.revision || '');
    if(data.task.approval?.requestId===oldRequest && $('#approval-consent'))$('#approval-consent').checked=Boolean(approvalChecked);
    d.scrollTop=scroll;
  } catch(error){handleFailure(error);if(detailId===id && $('#detail-error'))$('#detail-error').textContent='状态或日志刷新失败。'+errorText(error);}
}
function bindDetail(r) {
  $('#edit-request')?.addEventListener('click',()=>{detailId=null;requestEditor(r.id);});
  $('#refresh-detail')?.addEventListener('click',()=>void refreshDetail(r.id));
  document.querySelectorAll('[data-task-action]').forEach(button=>button.onclick=async()=>{
    if (requestMutationBusy) return;
    const action=button.dataset.taskAction;
    if(action==='submit'&&!$('#submit-consent')?.checked){toast('请先勾选确认，再提交需求。');return;}
    if(action==='approval'&&button.dataset.decision==='approve'&&!$('#approval-consent')?.checked){toast('请先阅读操作并勾选本次授权。');return;}
    if(!serverMode){
      const candidate=structuredClone(state),record=candidate.requests.find(x=>x.id===r.id);
      record.status=action==='cancel'?'cancelled':'blocked';record.updated=new Date().toISOString();
      if(await persist(candidate,action==='cancel'?'已取消本地需求记录':'已保存演示提交记录。未启动执行。')){closeModal();render();void openRequestDetail(record);}else render();return;
    }
    const body=action==='approval'?{requestId:button.dataset.requestId,decision:button.dataset.decision}:action==='submit'?{revision:r.revision}:{};
    const operation=r.id+':'+action+':'+JSON.stringify(body);if(!requestOperationKeys.has(operation))requestOperationKeys.set(operation,crypto.randomUUID());
    requestMutationBusy=true;
    const d=$('#note-dialog');d.querySelectorAll('button,input').forEach(el=>el.disabled=true);
    try {
      const data=await client.taskAction(r.id,action,body,requestOperationKeys.get(operation));upsertRequest(data.task);requestOperationKeys.delete(operation);render();
      toast(action==='submit'?'已提交到服务器，请查看真实队列状态。':action==='approval'?'本次授权决定已记录。':'服务器已记录操作。');
      requestMutationBusy=false; await refreshDetail(r.id);
    } catch(error){handleFailure(error);if($('#detail-error'))$('#detail-error').textContent=errorText(error)+' 请刷新状态核对后再操作。';}
    finally{requestMutationBusy=false;d.querySelectorAll('button,input').forEach(el=>el.disabled=false);}
  });
}
function confirmDiscard(action) {
  if(!dirty && !pendingRequestDraft && !pendingEditor){void action();return;}
  modal(`<div class="modal-heading"><h2>还有尚未保存的内容</h2><button class="close" data-close aria-label="关闭">×</button></div><p class="request-body">继续会丢弃当前页面中的未保存修改。你可以先关闭此窗口并导出备份。</p><button class="button primary" id="confirm-discard">确认丢弃并继续</button>`,'confirm');
  $('#confirm-discard').onclick=()=>{closeModal();void action();};
}
async function reloadWorkspace() {
  if(!serverMode){dirty=null;dirtyRevision=null;saveError='';conflict=false;render();return;}
  busy=true;
  try{const data=await client.getWorkspace();state=data.workspace;revision=data.revision;dirty=null;dirtyRevision=null;saveError='';conflict=false;render();toast('已载入服务器版本。');}
  catch(error){handleFailure(error);toast(errorText(error));}
  finally{busy=false;updateSaveStatus();}
}
async function logout() {
  try{await client.logout();dirty=null;dirtyRevision=null;pendingRequestDraft=null;pendingEditor=null;saveError='';conflict=false;lockSession('已退出登录。');}
  catch(error){lockSession('退出结果尚未确认，私人内容已在此页隐藏。请重新检查登录状态。');}
}
function bind() {
  document.querySelectorAll('[data-project]').forEach(b=>b.onclick=()=>{selectedProject=b.dataset.project;if(view==='projects')render();else location.hash='projects';});
  document.querySelectorAll('[data-note]').forEach(b=>b.onclick=()=>noteEditor(b.dataset.note));
  document.querySelectorAll('[data-toggle-task]').forEach(b=>b.onclick=()=>void changeWorkspace(s=>{const t=s.tasks.find(t=>t.id===b.dataset.toggleTask);t.status=t.status==='已完成'?'待开始':'已完成';},'待办状态已保存'));
  document.querySelectorAll('[data-task-status]').forEach(b=>b.onchange=()=>{const value=b.value;void changeWorkspace(s=>{s.tasks.find(t=>t.id===b.dataset.taskStatus).status=value;},'待办状态已保存');});
  document.querySelectorAll('[data-decision]').forEach(b=>b.onclick=()=>void changeWorkspace(s=>{s.decisions.find(d=>d.id===b.dataset.decision).resolved=true;},'决定状态已保存'));
  document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{taskFilter=b.dataset.filter;render();});
  document.querySelectorAll('[data-request]').forEach(b=>b.onclick=()=>{const r=allRequests().find(x=>x.id===b.dataset.request);void openRequestDetail(r);});
  document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{
    const a=b.dataset.action;
    if(a==='new-project')projectEditor();if(a==='edit-project')projectEditor(selectedProject || state.projects[0]?.id);
    if(a==='new-note')noteEditor();if(a==='new-task')taskEditor();if(a==='new-request')requestEditor();
    if(a==='export')exportData(state,serverMode?'gpt-dot-work-workspace.json':'gpt-dot-work-local-export.json');
    if(a==='export-unsaved')exportData(dirty,'gpt-dot-work-unsaved.json');
    if(a==='retry-save' && dirty)void persist(dirty,serverMode?'修改已保存到服务器':'修改已保存到本地').then(()=>render());
    if(a==='reload-workspace')confirmDiscard(reloadWorkspace);
    if(a==='logout')confirmDiscard(logout);
    if(a==='refresh-tasks')void refreshTasks();if(a==='more-tasks')void refreshTasks(true);
    if(a==='resume-editor' && pendingEditor){
      const saved=pendingEditor;
      if(saved.kind==='note')noteEditor(saved.id);if(saved.kind==='project')projectEditor(saved.id);if(saved.kind==='task')taskEditor();
      const form=$('#note-dialog form');if(form){for(const [key,value] of Object.entries(saved.fields)){if(form.elements.namedItem(key))form.elements.namedItem(key).value=value;}pendingEditor=null;}
    }
    if(a==='resume-request')requestEditor(pendingRequestDraft.id,pendingRequestDraft);
  });
  $('#knowledge-search')?.addEventListener('input',e=>{query=e.target.value;const pos=e.target.selectionStart;render();$('#knowledge-search').focus();$('#knowledge-search').setSelectionRange(pos,pos);});
}
function route() {const next=location.hash.slice(1);view=['overview','projects','knowledge','tasks'].includes(next)?next:'overview';render();}
window.addEventListener('hashchange',route);
window.addEventListener('beforeunload',e=>{if(dirty || pendingRequestDraft || pendingEditor || busy || requestMutationBusy){e.preventDefault();e.returnValue='';}});
window.addEventListener('pageshow',e=>{if(e.persisted && serverMode){lockSession();phase='loading';render();void start();}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden && serverMode && phase==='ready')void refreshTasks();});
$('#note-dialog').addEventListener('cancel',e=>{if(busy || requestMutationBusy || $('#request-form')?.dataset.busy){e.preventDefault();return;}modalKind=null;detailId=null;detailEvents=[];});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='k' && phase==='ready'){e.preventDefault();if(view!=='knowledge'){location.hash='knowledge';setTimeout(()=>$('#knowledge-search')?.focus(),50);}else $('#knowledge-search')?.focus();}});
void start();
