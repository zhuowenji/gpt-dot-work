export const STORAGE_KEY = 'gpt-dot-work.demo.v1';
export const statuses = ['待开始', '进行中', '已完成'];
export const seed = {
  version: 1,
  projects: [
    { id: 'p1', name: '个人知识花园', icon: '✳', color: 'blue', category: '长期积累', description: '把零散的想法，慢慢变成能复用的知识。', stage: '整理与连接', plan: '先整理 10 条核心笔记，再为每条笔记补充关联。让知识之间产生连接，而不只是收集更多内容。' },
    { id: 'p2', name: '周末城市漫游', icon: '⌁', color: 'orange', category: '生活计划', description: '留一个下午，重新发现熟悉的城市。', stage: '路线规划', plan: '挑选一条适合步行的路线，留出随意探索的时间。所有地点均为演示占位。' },
    { id: 'p3', name: '独立产品实验室', icon: '◇', color: 'purple', category: '创意探索', description: '用小实验，验证一个值得投入的方向。', stage: '第一轮验证', plan: '从一个具体的小问题开始，做出最简单的可交互原型，再收集反馈。' }
  ],
  notes: [
    { id: 'n1', title: '建立一个可生长的知识库', projectId: 'p1', type: '方法', body: '知识库不是收藏夹。\n\n每条笔记只表达一个核心想法，并补上自己的理解。\n用项目把行动与知识连接起来。\n定期回顾，让旧想法获得新的上下文。', tags: ['知识管理', '个人系统'], updated: '2026-10-01T09:00:00Z' },
    { id: 'n2', title: '让周末多一点留白', projectId: 'p2', type: '灵感', body: '不要把路线排得太满。\n\n选择一个出发点、一家想坐下来的小店，以及一个可以临时改变计划的下午。', tags: ['生活', '慢下来'], updated: '2026-09-30T08:00:00Z' },
    { id: 'n3', title: '小实验比大计划更有说服力', projectId: 'p3', type: '想法', body: '先把假设写清楚：为谁解决什么问题？\n\n用一周完成一个最小实验。记录观察到的事实，再决定下一步。', tags: ['产品思考', '实验'], updated: '2026-09-29T08:00:00Z' }
  ],
  tasks: [
    { id: 't1', title: '整理第一批核心笔记', projectId: 'p1', status: '进行中', priority: '优先', due: '本周' },
    { id: 't2', title: '选定漫游路线', projectId: 'p2', status: '待开始', priority: '普通', due: '周末前' },
    { id: 't3', title: '写下产品实验假设', projectId: 'p3', status: '进行中', priority: '优先', due: '本周' },
    { id: 't4', title: '搭建笔记分类结构', projectId: 'p1', status: '已完成', priority: '普通', due: '已安排' }
  ],
  decisions: [
    { id: 'd1', title: '先按主题，还是按项目整理？', projectId: 'p1', detail: '建议从项目开始，让每条知识都有一个使用场景。', resolved: false },
    { id: 'd2', title: '第一轮实验聚焦哪个问题？', projectId: 'p3', detail: '缩小范围，优先验证一个明确、可观察的假设。', resolved: false }
  ]
};
export function freshState() { return structuredClone(seed); }
export function searchNotes(notes, query) { const q = query.trim().toLocaleLowerCase(); return notes.filter(n => [n.title, n.body, ...n.tags].join(' ').toLocaleLowerCase().includes(q)); }
export function projectProgress(state, id) { const tasks = state.tasks.filter(t => t.projectId === id); return tasks.length ? Math.round(tasks.filter(t => t.status === '已完成').length / tasks.length * 100) : 0; }
export function isValidState(s) {
  const stringFields=(v,fields)=>v && fields.every(k=>typeof v[k]==='string');
  const id=v=>typeof v==='string' && /^[a-zA-Z0-9_-]+$/.test(v);
  if(!s || s.version!==1 || !['projects','notes','tasks','decisions'].every(k=>Array.isArray(s[k])))return false;
  const validProjects=s.projects.every(p=>stringFields(p,['id','name','icon','color','category','description','stage','plan'])&&id(p.id)&&['blue','orange','purple'].includes(p.color));
  if(!validProjects)return false;
  const known=v=>s.projects.some(p=>p.id===v);
  return s.notes.every(n=>stringFields(n,['id','title','body','projectId','type','updated'])&&id(n.id)&&known(n.projectId)&&Array.isArray(n.tags)&&n.tags.every(t=>typeof t==='string'))
    &&s.tasks.every(t=>stringFields(t,['id','title','projectId','status','priority','due'])&&id(t.id)&&known(t.projectId)&&statuses.includes(t.status))
    &&s.decisions.every(d=>stringFields(d,['id','title','projectId','detail'])&&id(d.id)&&known(d.projectId)&&typeof d.resolved==='boolean')
    &&(s.requests===undefined || (Array.isArray(s.requests)&&s.requests.every(r=>stringFields(r,['id','title','body','status','updated'])&&id(r.id)&&['draft','pending','running','blocked','needs_approval','completed','failed','cancelled'].includes(r.status))));
}

// Private server accounts begin empty; public demo seed is opt-in by document mode.
export function emptyState() { return {version:1,projects:[],notes:[],tasks:[],decisions:[]}; }

export function createWorkspaceClient(fetcher = globalThis.fetch.bind(globalThis)) {
  let csrfToken = null;
  async function request(path, {method = 'GET', body, key} = {}) {
    const headers = {Accept:'application/json'};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
    if (key) headers['Idempotency-Key'] = key;
    let response;
    try { response = await fetcher(path, {method,headers,credentials:'same-origin',cache:'no-store',...(body === undefined ? {} : {body:JSON.stringify(body)})}); }
    catch { const error = new Error('无法连接服务器。'); error.code = 'network_error'; throw error; }
    let data;
    try { data = await response.json(); }
    catch { const error = new Error('服务器返回了无法识别的响应。保存结果尚未确认。'); error.code = 'invalid_response'; error.status = response.status; throw error; }
    if (!response.ok) { const error = new Error(data.error?.message || '服务器请求失败。'); error.status = response.status; error.code = data.error?.code; throw error; }
    return data;
  }
  function workspaceEnvelope(data) {
    if (!Number.isSafeInteger(data.revision) || data.revision < 0 || !isValidState(data.workspace) || data.workspace.requests !== undefined) {
      const error = new Error('服务器工作空间格式不正确，未载入或确认保存。'); error.code = 'invalid_response'; throw error;
    }
    return data;
  }
  return {
    setCsrfToken(value) { csrfToken = value; },
    getSession: () => request('/api/session'),
    login: password => request('/api/login', {method:'POST',body:{password}}),
    logout: () => request('/api/logout', {method:'POST',body:{}}),
    getWorkspace: async () => workspaceEnvelope(await request('/api/workspace')),
    saveWorkspace: async (workspace, revision) => workspaceEnvelope(await request('/api/workspace', {method:'PUT',body:{revision,workspace}})),
    listTasks: cursor => request('/api/tasks?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')),
    getTask: id => request('/api/tasks/' + encodeURIComponent(id)),
    getEvents: (id, after = 0) => request('/api/tasks/' + encodeURIComponent(id) + '/events?after=' + after),
    createTask: (body, key) => request('/api/tasks', {method:'POST',body,key}),
    editTask: (id, body, key) => request('/api/tasks/' + encodeURIComponent(id), {method:'PATCH',body,key}),
    taskAction: (id, action, body, key) => request('/api/tasks/' + encodeURIComponent(id) + '/' + action, {method:'POST',body,key}),
    getVideoSettings: async () => videoSettingsEnvelope(await request('/api/video-settings')),
    saveVideoSettings: async body => videoSettingsEnvelope(await request('/api/video-settings', {method:'PUT',body})),
    listVideos: (view = 'all', cursor = null) => request('/api/videos?view=' + encodeURIComponent(view) + '&limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')),
    getVideo: id => request('/api/videos/' + encodeURIComponent(id)),
    ingestVideos: (videos, key) => request('/api/videos/ingest', {method:'POST',body:{videos},key}),
    verifyVideo: (id, body, key) => request('/api/videos/' + encodeURIComponent(id) + '/verification', {method:'PATCH',body,key}),
    publishVideo: (id, body, key) => request('/api/videos/' + encodeURIComponent(id) + '/publication', {method:'PATCH',body,key})
  };
}


export const videoCategoryLabels = {household_general:'家用百货',kitchen_non_electric:'非电厨房用品',appliance:'电器',inflatable_bed:'充气床',other:'其他',unknown:'待确认'};
export const videoVerificationLabels = {candidate:'待人工核验',verified:'已人工核验',rejected:'已人工排除'};
export function defaultVideoSettings() {
  return {revision:0,updatedAt:null,criteria:{categories:['household_general','kitchen_non_electric'],minLikes:1000,maxLikes:3000,windowMonths:1,excludedCategories:['appliance','inflatable_bed'],keywords:[]},schedule:{requestedEnabled:false,intervalMinutes:60,timezone:'Asia/Shanghai'},runtime:{collectorConnected:false,schedulerActive:false,state:'not_configured',reason:'尚未接入获授权的抖音数据源；保存设置不会启动采集。',lastRunAt:null,nextRunAt:null}};
}
export function videoSettingsEnvelope(data) {
  const c=data?.criteria,s=data?.schedule,r=data?.runtime;
  if (!Number.isSafeInteger(data?.revision) || data.revision<0 || !c || !Array.isArray(c.categories) || !c.categories.every(x=>['household_general','kitchen_non_electric'].includes(x)) || !Number.isSafeInteger(c.minLikes) || !Number.isSafeInteger(c.maxLikes) || c.minLikes<0 || c.maxLikes<c.minLikes || c.windowMonths!==1 || !Array.isArray(c.excludedCategories) || !['appliance','inflatable_bed'].every(x=>c.excludedCategories.includes(x)) || !Array.isArray(c.keywords) || !c.keywords.every(x=>typeof x==='string') || !s || typeof s.requestedEnabled!=='boolean' || !Number.isSafeInteger(s.intervalMinutes) || s.intervalMinutes<1 || typeof s.timezone!=='string' || !r || typeof r.collectorConnected!=='boolean' || typeof r.schedulerActive!=='boolean' || typeof r.reason!=='string') {
    const error=new Error('抖音筛选设置响应不完整，未确认载入或保存。');error.code='invalid_response';throw error;
  }
  return data;
}
export function videoSettingsFields(settings) {
  return {categories:[...settings.criteria.categories],minLikes:String(settings.criteria.minLikes),maxLikes:String(settings.criteria.maxLikes),keywords:settings.criteria.keywords.join('，'),requestedEnabled:settings.schedule.requestedEnabled,intervalMinutes:String(settings.schedule.intervalMinutes)};
}
export function videoSettingsPayload(fields, revision) {
  const integer=(value,label)=>{if(!/^\d+$/.test(String(value)))throw new Error(label+'须为非负整数。');const n=Number(value);if(!Number.isSafeInteger(n))throw new Error(label+'过大。');return n;};
  const minLikes=integer(fields.minLikes,'最低点赞数'),maxLikes=integer(fields.maxLikes,'最高点赞数');
  if(maxLikes>1e12)throw new Error('最高点赞数不能超过 1 万亿。');
  if(maxLikes<minLikes)throw new Error('最高点赞数不能小于最低点赞数。');
  if(!Array.isArray(fields.categories) || !fields.categories.length || fields.categories.some(x=>!['household_general','kitchen_non_electric'].includes(x)))throw new Error('至少选择一个支持的商品类别。');
  const intervalMinutes=integer(fields.intervalMinutes,'检查间隔');
  if(intervalMinutes<15 || intervalMinutes>1440)throw new Error('检查间隔须为 15–1440 分钟。');
  const keywords=[...new Set(String(fields.keywords||'').split(/[,，\n]/).map(x=>x.trim()).filter(Boolean))];
  if(keywords.length>12 || keywords.some(x=>x.length>120))throw new Error('最多填写 12 个关键词，每个不超过 120 字符。');
  return {revision,criteria:{categories:[...fields.categories],minLikes,maxLikes,windowMonths:1,excludedCategories:['appliance','inflatable_bed'],keywords},schedule:{requestedEnabled:Boolean(fields.requestedEnabled),intervalMinutes,timezone:'Asia/Shanghai'}};
}
export function videoImportPayload(fields) {
  if(fields.authorName!=null && (typeof fields.authorName!=='string' || fields.authorName.length>200))throw new Error('作者名称须为最多 200 字符的文本，未知时可留空。');
  const authorName=fields.authorName?.trim() || null;
  const raw=String(fields.observedLikes??'').trim();
  if(raw && !/^\d+$/.test(raw))throw new Error('精确点赞数须为非负整数；只有缩写时请留空。');
  const observedLikes=raw ? Number(raw) : null;
  if(observedLikes!==null && (!Number.isSafeInteger(observedLikes) || observedLikes>1e12))throw new Error('点赞数过大。');
  if(fields.likeCountExact && observedLikes===null)throw new Error('勾选精确数值前，请填写实际观察到的完整点赞数。');
  if(fields.likeCountExact && (!/^\d+$/.test(String(fields.rawLikeCount||'').replace(/[,，\s]/g,'')) || Number(String(fields.rawLikeCount||'').replace(/[,，\s]/g,''))!==observedLikes))throw new Error('精确点赞数须与页面数字原文一致，不能由缩写推算。');
  const publishedDate=String(fields.publishedDate||'').trim() || null;
  if(publishedDate && (!/^\d{4}-\d{2}-\d{2}$/.test(publishedDate) || !Number.isFinite(Date.parse(publishedDate+'T00:00:00Z')) || new Date(publishedDate+'T00:00:00Z').toISOString().slice(0,10)!==publishedDate))throw new Error('发布日期无效。');
  const local=String(fields.observedAt||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(local) || !['+08:00','+00:00'].includes(fields.observedTimezone))throw new Error('请填写观察时间与时区。');
  const observedAt=(local.length===16?local+':00':local)+fields.observedTimezone;
  if(!Number.isFinite(Date.parse(observedAt)))throw new Error('观察时间无效。');
  if(Date.parse(observedAt)>Date.now()+300000)throw new Error('观察时间不能晚于当前时间。');
  const observationDay=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(observedAt));
  if(publishedDate && publishedDate>observationDay)throw new Error('发布日期不能晚于观察日期。');
  const evidenceValue=String(fields.evidenceValue||'').trim(),evidenceUrl=String(fields.evidenceUrl||'').trim();
  if(evidenceUrl && !safeVideoEvidenceUrl(evidenceUrl))throw new Error('证据链接须为不含账户信息的 HTTPS 链接。');
  if(!safeDouyinUrl(String(fields.url||'').trim()))throw new Error('请填写抖音官方 HTTPS 视频链接或分享短链接。');
  if(evidenceValue.length>16000)throw new Error('证据内容最多 16000 字符。');
  if(evidenceUrl && !evidenceValue)throw new Error('请同时填写证据内容，说明链接对应的原始信息。');
  if(!Object.hasOwn(videoCategoryLabels,fields.category))throw new Error('请选择有效商品类别。');
  if(!['page_text','screenshot','api_response','manual_note'].includes(fields.evidenceKind))throw new Error('请选择有效证据类型。');
  if(String(fields.title||'').trim().length>1000 || String(fields.source||'').trim().length>200)throw new Error('标题最多 1000 字符，来源说明最多 200 字符。');
  if(!String(fields.title||'').trim() || !String(fields.source||'').trim())throw new Error('请填写视频标题与来源说明。');
  return {url:String(fields.url).trim(),title:String(fields.title).trim(),authorName,category:fields.category,publishedDate,rawPublicationDate:String(fields.rawPublicationDate||'').trim(),observedAt,rawLikeCount:String(fields.rawLikeCount||'').trim(),observedLikes,likeCountExact:Boolean(fields.likeCountExact),source:String(fields.source).trim(),evidence:evidenceValue?[{kind:fields.evidenceKind,value:evidenceValue,url:evidenceUrl||null}]:[]};
}
export function safeDouyinUrl(value) {
  try {
    const url=new URL(value);
    if(url.protocol!=='https:' || url.username || url.password || url.port || !['douyin.com','www.douyin.com','m.douyin.com','v.douyin.com'].includes(url.hostname))return null;
    const specific=url.hostname==='v.douyin.com'?/^\/[A-Za-z0-9_-]{3,100}\/?$/.test(url.pathname):/^\/(?:share\/)?video\/\d{5,30}\/?$/.test(url.pathname) || (url.pathname==='/' && /^\d{5,30}$/.test(url.searchParams.get('modal_id')||''));
    return specific?url.href:null;
  }catch{return null;}
}
export function safeVideoEvidenceUrl(value) {
  try {const url=new URL(value);return url.protocol==='https:' && !url.username && !url.password ? url.href : null;}catch{return null;}
}
export function canVerifyVideo(video) {
  return Boolean(video?.screening?.matches && video.publishedDate && video.observation?.likeCountExact && Number.isSafeInteger(video.observation.observedLikes) && video.observation.evidence?.some(e=>['page_text','screenshot','api_response'].includes(e.kind) && typeof e.value==='string' && e.value.trim()));
}
