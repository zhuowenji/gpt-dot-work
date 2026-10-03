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
  const id=v=>typeof v==='string' && /^[a-zA-Z0-9-]+$/.test(v);
  if(!s || s.version!==1 || !['projects','notes','tasks','decisions'].every(k=>Array.isArray(s[k])))return false;
  const validProjects=s.projects.length>0 && s.projects.every(p=>stringFields(p,['id','name','icon','color','category','description','stage','plan'])&&id(p.id)&&['blue','orange','purple'].includes(p.color));
  if(!validProjects)return false;
  const known=v=>s.projects.some(p=>p.id===v);
  return s.notes.every(n=>stringFields(n,['id','title','body','projectId','type','updated'])&&id(n.id)&&known(n.projectId)&&Array.isArray(n.tags)&&n.tags.every(t=>typeof t==='string'))
    &&s.tasks.every(t=>stringFields(t,['id','title','projectId','status','priority','due'])&&id(t.id)&&known(t.projectId)&&statuses.includes(t.status))
    &&s.decisions.every(d=>stringFields(d,['id','title','projectId','detail'])&&id(d.id)&&known(d.projectId)&&typeof d.resolved==='boolean')
    &&(s.requests===undefined || (Array.isArray(s.requests)&&s.requests.every(r=>stringFields(r,['id','title','body','status','updated'])&&id(r.id)&&['draft','pending','running','blocked','needs_approval','completed','failed','cancelled'].includes(r.status))));
}
