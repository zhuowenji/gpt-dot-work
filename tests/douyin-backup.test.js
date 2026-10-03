import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../backend/store.mjs';
import { VideoStore } from '../backend/videos.mjs';
import { WorkspaceStore, emptyWorkspace } from '../backend/workspace.mjs';
import { createBackup } from '../scripts/backup.mjs';

test('existing SQLite backup includes video results, observations, verification and settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'douyin-backup-'));
  let original, restored;
  try {
    const source = join(root, 'tasks.sqlite'), destination = join(root, 'backup.sqlite');
    const now = () => Date.parse('2026-10-03T22:00:00Z');
    original = new TaskStore(source, { now });
    const task = original.create({ title: 'Existing private task', instructions: 'Do not change this task', kind: 'task' }, randomUUID());
    const workspace = new WorkspaceStore(original);
    workspace.put({ revision: 0, workspace: { ...emptyWorkspace(), projects: [{ id: 'existing', name: 'Existing workspace', icon: '✳', color: 'blue', category: 'Work', description: '', stage: 'Planning', plan: '' }] } });
    const videos = new VideoStore(original);
    const id = videos.ingest({ videos: [{ url: 'https://www.douyin.com/video/123456789', title: '虚构备份测试收纳篮', category: 'household_general', publishedDate: '2026-09-21', rawPublicationDate: '2026-09-21', observedAt: '2026-10-03T21:00:00Z', rawLikeCount: '2345', observedLikes: 2345, likeCountExact: true, source: '虚构测试', evidence: [{ kind: 'page_text', value: '虚构测试证据' }] }] }, randomUUID()).results[0].id;
    videos.verify(id, { revision: 1, state: 'verified', note: '虚构测试核验' }, randomUUID());
    videos.publish(id, { revision: 2, isPublic: true }, randomUUID());
    const settings = videos.settings();
    videos.putSettings({ revision: settings.revision, criteria: { ...settings.criteria, keywords: ['收纳'] }, schedule: settings.schedule });
    await createBackup(source, destination);
    restored = new TaskStore(destination, { now }); const copy = new VideoStore(restored);
    assert.equal(copy.get(id).video.verification.state, 'verified');
    assert.equal(restored.get(task.id).instructions, 'Do not change this task');
    assert.equal(new WorkspaceStore(restored).get().workspace.projects[0].name, 'Existing workspace');
    assert.equal(copy.get(id).observations[0].rawLikeCount, '2345');
    assert.equal(copy.get(id).verificationEvents.length, 1);
    assert.equal(copy.publicList().shown, 1);
    assert.equal(restored.db.prepare('SELECT count(*) AS count FROM video_publication_events').get().count, 1);
    assert.deepEqual(copy.settings().criteria.keywords, ['收纳']);
    assert.equal(copy.settings().runtime.collectorConnected, false);
  } finally { restored?.close(); original?.close(); await rm(root, { recursive: true, force: true }); }
});
