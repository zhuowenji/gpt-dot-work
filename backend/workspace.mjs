import { ApiError } from './store.mjs';

export const MAX_WORKSPACE_BYTES = 1024 * 1024;
export const emptyWorkspace = () => ({ version: 1, projects: [], notes: [], tasks: [], decisions: [] });
const invalid = message => { throw new ApiError(400, 'invalid_workspace', message); };
function object(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) invalid(`${label} has unsupported or missing fields`);
}
function string(value, max, label, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || value.includes('\u0000')) invalid(`${label} must be ${required ? 'nonempty ' : ''}text of at most ${max} characters`);
}
export function validateWorkspace(value) {
  object(value, ['version', 'projects', 'notes', 'tasks', 'decisions'], 'workspace');
  if (value.version !== 1) invalid('Unsupported workspace version');
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_WORKSPACE_BYTES) throw new ApiError(413, 'body_too_large', 'Workspace exceeds 1 MiB');
  for (const collection of ['projects', 'notes', 'tasks', 'decisions']) {
    if (!Array.isArray(value[collection]) || value[collection].length > 1000) invalid(`${collection} must be an array of at most 1000 records`);
    const ids = new Set();
    for (const item of value[collection]) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)) invalid(`${collection} IDs must be unique safe identifiers of at most 80 characters`);
      ids.add(item.id);
    }
  }
  const projects = new Set(value.projects.map(item => item.id));
  function fields(item, spec, label) {
    object(item, Object.keys(spec), label);
    for (const [key, max] of Object.entries(spec)) if (max) string(item[key], max, `${label}.${key}`, ['id', 'name', 'title', 'projectId'].includes(key));
  }
  for (const item of value.projects) {
    fields(item, { id: 80, name: 160, icon: 32, color: 16, category: 120, description: 4000, stage: 120, plan: 20000 }, 'project');
    if (!['blue', 'orange', 'purple'].includes(item.color)) invalid('Unsupported project color');
  }
  for (const item of value.notes) {
    fields(item, { id: 80, title: 160, projectId: 80, type: 80, body: 64000, tags: 0, updated: 40 }, 'note');
    if (!Array.isArray(item.tags) || item.tags.length > 30) invalid('A note can have at most 30 tags');
    item.tags.forEach(tag => string(tag, 80, 'tag', true));
    if (!/^\d{4}-\d{2}-\d{2}T/.test(item.updated) || !Number.isFinite(Date.parse(item.updated))) invalid('Note updated must be an ISO date');
  }
  for (const item of value.tasks) {
    fields(item, { id: 80, title: 160, projectId: 80, status: 16, priority: 32, due: 120 }, 'task');
    if (!['待开始', '进行中', '已完成'].includes(item.status)) invalid('Unsupported task status');
    if (!['普通', '优先'].includes(item.priority)) invalid('Unsupported task priority');
  }
  for (const item of value.decisions) {
    fields(item, { id: 80, title: 160, projectId: 80, detail: 20000, resolved: 0 }, 'decision');
    if (typeof item.resolved !== 'boolean') invalid('Decision resolved must be boolean');
  }
  for (const item of [...value.notes, ...value.tasks, ...value.decisions]) if (!projects.has(item.projectId)) invalid('Every record must reference an existing project');
  return structuredClone(value);
}

export class WorkspaceStore {
  constructor(taskStore) {
    this.store = taskStore;
    this.db = taskStore.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS owner_workspace (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, updated_at INTEGER, body TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO owner_workspace(id, revision, updated_at, body) VALUES (1, 0, NULL, ?)').run(JSON.stringify(emptyWorkspace()));
  }
  get() {
    const row = this.db.prepare('SELECT revision, updated_at, body FROM owner_workspace WHERE id = 1').get();
    return { revision: row.revision, updatedAt: row.updated_at, workspace: JSON.parse(row.body) };
  }
  put(input) {
    object(input, ['revision', 'workspace'], 'request');
    if (!Number.isSafeInteger(input.revision) || input.revision < 0) invalid('revision must be a nonnegative safe integer');
    const workspace = validateWorkspace(input.workspace);
    return this.store.transaction(() => {
      const result = this.db.prepare('UPDATE owner_workspace SET revision = revision + 1, updated_at = ?, body = ? WHERE id = 1 AND revision = ?').run(this.store.now(), JSON.stringify(workspace), input.revision);
      if (result.changes !== 1) throw new ApiError(409, 'revision_conflict', 'The workspace changed in another tab. Reload the latest version before saving.');
      return this.get();
    });
  }
}
