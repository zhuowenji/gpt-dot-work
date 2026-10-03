import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../store.mjs';
import { VideoStore, normalizeVideoIdentity, rollingMonth } from '../videos.mjs';
import { createApiServer, listen } from '../server.mjs';

const NOW = Date.parse('2026-10-03T22:00:00Z');
function setup(t, options = {}) {
  let time = NOW;
  const tasks = new TaskStore(options.path || ':memory:', { now: () => time });
  const videos = new VideoStore(tasks);
  t.after(() => tasks.close());
  return { tasks, videos, advance(ms) { time += ms; } };
}
function record(overrides = {}) {
  return { url: 'https://www.douyin.com/video/1234567890123456789?tracking=removed', title: '不锈钢厨房沥水篮', category: 'kitchen_non_electric', publishedDate: '2026-09-21', rawPublicationDate: '2026-09-21', observedAt: '2026-10-03T21:00:00Z', rawLikeCount: '2,345', observedLikes: 2345, likeCountExact: true, source: '人工查看抖音视频页', evidence: [{ kind: 'page_text', value: '测试页面证据：发布日期 2026-09-21；点赞 2,345', url: 'https://www.douyin.com/video/1234567890123456789' }], ...overrides };
}
function ingest(videos, value = record(), key = randomUUID()) { return videos.ingest({ videos: [value] }, key); }

test('empty video store is additive, same-database, private and collector-inactive', t => {
  const { tasks, videos } = setup(t);
  assert.equal(videos.db, tasks.db);
  assert.equal(tasks.list().length, 0);
  assert.deepEqual(videos.list(), { videos: [], total: 0, nextCursor: null });
  const settings = videos.settings();
  assert.equal(settings.criteria.minLikes, 1000); assert.equal(settings.criteria.maxLikes, 3000);
  assert.equal(settings.runtime.collectorConnected, false); assert.equal(settings.runtime.schedulerActive, false);
  assert.equal(settings.runtime.lastRunAt, null); assert.equal(settings.runtime.nextRunAt, null);
});
test('rolling month uses Shanghai dates and clamps month ends and leap day', () => {
  assert.deepEqual(rollingMonth(NOW), { windowStart: '2026-09-04', windowEnd: '2026-10-04' });
  assert.deepEqual(rollingMonth(Date.parse('2026-03-31T02:00:00Z')), { windowStart: '2026-02-28', windowEnd: '2026-03-31' });
  assert.equal(rollingMonth(Date.parse('2024-03-31T02:00:00Z')).windowStart, '2024-02-29');
});
test('normalization strips trackers, extracts IDs, validates ID agreement and blocks unsafe URLs', () => {
  const normalized = normalizeVideoIdentity('https://m.douyin.com/share/video/123456789/?foo=bar');
  assert.equal(normalized.canonicalUrl, 'https://www.douyin.com/video/123456789');
  assert.equal(normalizeVideoIdentity('https://www.douyin.com/?modal_id=123456789').videoId, '123456789');
  assert.equal(normalizeVideoIdentity('https://v.douyin.com/ABC123/?foo=bar').canonicalUrl, 'https://v.douyin.com/ABC123/');
  for (const url of ['javascript:alert(1)', 'http://www.douyin.com/video/123456789', 'https://douyin.com.evil.test/video/123456789', 'https://user:pass@www.douyin.com/video/123456789', 'https://www.douyin.com:444/video/123456789', 'https://www.douyin.com/user/123456789']) assert.throws(() => normalizeVideoIdentity(url));
  assert.throws(() => normalizeVideoIdentity('https://www.douyin.com/video/123456789', '987654321'));
});
test('ingestion retains raw counts and timestamps; exact duplicate and retry never create extra observations', t => {
  const { videos } = setup(t); const key = randomUUID();
  const a = ingest(videos, record(), key), b = ingest(videos, record(), key);
  assert.deepEqual(a, b); assert.equal(a.created, 1);
  const c = ingest(videos); assert.equal(c.unchanged, 1);
  const { video, observations } = videos.get(a.results[0].id);
  assert.equal(video.verification.state, 'candidate'); assert.equal(video.screening.matches, true);
  assert.equal(video.observation.rawLikeCount, '2,345'); assert.equal(video.observation.observedLikes, 2345);
  assert.equal(video.observation.observedAt, '2026-10-03T21:00:00.000Z'); assert.equal(observations.length, 1);
  assert.equal(video.firstSeenAt, NOW); assert.equal(video.publishedDate, '2026-09-21');
  assert.throws(() => ingest(videos, record({ title: 'changed' }), key), e => e.code === 'idempotency_conflict');
});
test('same timestamp conflicting facts reject the entire batch atomically', t => {
  const { videos } = setup(t); ingest(videos);
  assert.throws(() => videos.ingest({ videos: [record({ url: 'https://www.douyin.com/video/999999999' }), record({ rawLikeCount: '2500', observedLikes: 2500 })] }, randomUUID()), e => e.code === 'video_observation_conflict');
  assert.equal(videos.list().total, 1);
  assert.equal(videos.list().videos[0].observation.observedLikes, 2345);
});
test('short URL and video ID aliases deduplicate; ambiguous separate records never silently merge', t => {
  const { videos } = setup(t);
  const short = record({ url: 'https://v.douyin.com/Abcd123/' });
  const created = ingest(videos, short).results[0];
  const updated = ingest(videos, { ...short, videoId: '1234567890123456789' }).results[0];
  assert.equal(updated.id, created.id); assert.equal(videos.list().total, 1);
  assert.equal(videos.get(created.id).video.canonicalUrl, 'https://www.douyin.com/video/1234567890123456789');
  assert.equal(ingest(videos).unchanged, 1);
  ingest(videos, record({ url: 'https://v.douyin.com/Other123/' }));
  assert.throws(() => ingest(videos, record({ url: 'https://v.douyin.com/Other123/', videoId: '1234567890123456789' })), e => e.code === 'video_identity_conflict');
});
test('uncertain/abbreviated/missing values remain candidates, cannot be marked verified', t => {
  const { videos } = setup(t);
  const created = ingest(videos, record({ rawLikeCount: '2.3千', observedLikes: 2300, likeCountExact: false, publishedDate: null, evidence: [] })).results[0];
  const video = videos.get(created.id).video;
  assert.equal(video.screening.matches, false); assert.equal(video.screening.missing.length, 3);
  assert.throws(() => videos.verify(video.id, { revision: video.revision, state: 'verified', note: '已查看' }, randomUUID()), e => e.code === 'video_not_verifiable');
  assert.throws(() => ingest(videos, record({ rawLikeCount: '2.3千', observedLikes: 2300, likeCountExact: true })));
});
test('all requested bounds/categories/exclusions are screened, including title contradictions', t => {
  const { videos } = setup(t);
  const variants = [
    { observedLikes: 999, rawLikeCount: '999' }, { observedLikes: 3001, rawLikeCount: '3001' },
    { publishedDate: '2026-09-03' }, { category: 'appliance' }, { category: 'inflatable_bed' },
    { title: '便携充气床' }, { title: '家居空气炸锅' }, { category: 'unknown' },
  ];
  for (const [i, change] of variants.entries()) ingest(videos, record({ ...change, url: `https://www.douyin.com/video/${100000000 + i}` }));
  assert.ok(videos.list().videos.every(v => !v.screening.matches));
  assert.equal(videos.list({ view: 'verified' }).total, 0);
  for (const likes of [1000, 3000]) {
    const result = ingest(videos, record({ observedLikes: likes, rawLikeCount: String(likes), url: `https://www.douyin.com/video/8${likes}00000`, publishedDate: '2026-09-04' }));
    assert.equal(videos.get(result.results[0].id).video.screening.matches, true);
  }
});
test('manual verification is revision-safe, audited, idempotent, and newer observations require recheck', t => {
  const { videos } = setup(t);
  const id = ingest(videos).results[0].id, initial = videos.get(id).video;
  const key = randomUUID(), input = { revision: initial.revision, state: 'verified', note: '人工核对页面：类别、发布日期、精确点赞数均符合。' };
  const result = videos.verify(id, input, key, 'owner_session');
  assert.deepEqual(videos.verify(id, input, key, 'owner_session'), result);
  assert.equal(videos.list({ view: 'verified' }).total, 1);
  assert.equal(videos.get(id).verificationEvents[0].actor, 'owner_session');
  assert.throws(() => videos.verify(id, input, randomUUID()), e => e.code === 'video_revision_conflict');
  ingest(videos, record({ observedAt: '2026-10-03T21:30:00Z', observedLikes: 2999, rawLikeCount: '2999' }));
  const updated = videos.get(id);
  assert.equal(updated.video.verification.state, 'candidate'); assert.equal(updated.observations.length, 2);
  assert.equal(videos.list({ view: 'verified' }).total, 0); assert.equal(updated.verificationEvents[0].actor, 'system');
});
test('historical observation never overwrites newest count or verification, rolling dates re-evaluate dynamically', t => {
  const { videos, advance } = setup(t);
  const id = ingest(videos).results[0].id;
  videos.verify(id, { revision: 1, state: 'verified', note: '人工核对通过' }, randomUUID());
  ingest(videos, record({ observedAt: '2026-10-01T12:00:00Z', rawLikeCount: '1500', observedLikes: 1500 }));
  assert.equal(videos.get(id).video.observation.observedLikes, 2345);
  assert.equal(videos.get(id).video.verification.state, 'verified');
  advance(40 * 86400000);
  assert.equal(videos.list({ view: 'verified' }).total, 0);
  assert.equal(videos.get(id).video.screening.matches, false);
});
test('settings are versioned and cannot fake runtime availability or start a collector', t => {
  const { videos } = setup(t); const old = videos.settings();
  const input = { revision: old.revision, criteria: { ...old.criteria, keywords: ['沥水'] }, schedule: { ...old.schedule, requestedEnabled: true, intervalMinutes: 15 } };
  const saved = videos.putSettings(input); assert.equal(saved.revision, 1);
  assert.equal(saved.schedule.requestedEnabled, true); assert.equal(saved.runtime.schedulerActive, false);
  assert.throws(() => videos.putSettings(input), e => e.code === 'video_settings_conflict');
  assert.throws(() => videos.putSettings({ ...input, runtime: { collectorConnected: true } }));
  assert.throws(() => videos.putSettings({ ...input, schedule: { ...input.schedule, intervalMinutes: 1 } }));
  assert.throws(() => videos.putSettings({ ...input, criteria: { ...input.criteria, excludedCategories: [] } }));
});
test('pagination is stable and finite at same first-seen timestamp', t => {
  const { videos } = setup(t);
  for (let i = 0; i < 3; i++) ingest(videos, record({ url: `https://www.douyin.com/video/${1234567890 + i}` }));
  const first = videos.list({ limit: 2 }); assert.equal(first.total, 3); assert.ok(first.nextCursor);
  const [at, id] = first.nextCursor.split(':');
  const second = videos.list({ limit: 2, cursor: { firstSeenAt: Number(at), id } });
  assert.equal(second.videos.length, 1); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.videos, ...second.videos].map(v => v.id)).size, 3);
});
test('malformed data and inbound attempts to mark verified are rejected', t => {
  const { videos } = setup(t);
  for (const variant of [{ verification: { state: 'verified' } }, { observedLikes: '2345' }, { observedLikes: -1 }, { publishedDate: '2026-02-30' }, { observedAt: '2026-10-05T00:00:00Z' }, { observedAt: '2026-10-03T21:00:00' }, { evidence: [{ kind: 'page_text', value: 'test', url: 'javascript:alert(1)' }] }]) assert.throws(() => ingest(videos, record(variant)));
  assert.equal(videos.list().total, 0);
});
test('SQLite reopen preserves results/settings, backed up with the existing task database', t => {
  const dir = mkdtempSync(join(tmpdir(), 'video-persistence-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'tasks.sqlite'); const tasks = new TaskStore(path, { now: () => NOW }), videos = new VideoStore(tasks);
  const id = ingest(videos).results[0].id; tasks.close();
  const reopened = new TaskStore(path, { now: () => NOW }); t.after(() => reopened.close());
  assert.equal(new VideoStore(reopened).get(id).video.observation.rawLikeCount, '2,345');
  assert.equal(reopened.list().length, 0);
});
test('HTTP routes require auth and idempotency; runtime is honest; bad cursor/view rejected', async t => {
  const { tasks } = setup(t);
  // This public fixture is not a deployment credential.
  const token = 'fictional-test-token-not-for-production';
  const config = { apiToken: token, publicOrigin: 'http://localhost:4318', host: '127.0.0.1', port: 0, runtime: 'disabled' };
  const server = createApiServer(tasks, config), address = await listen(server, config);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${address.port}`;
  const req = async (path, options = {}) => { const res = await fetch(base + path, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } }); return { status: res.status, data: await res.json() }; };
  assert.equal((await fetch(base + '/api/videos')).status, 401);
  assert.equal((await req('/api/video-settings')).data.runtime.collectorConnected, false);
  const payload = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videos: [record()] }) };
  assert.equal((await req('/api/videos/ingest', payload)).status, 400);
  const result = await req('/api/videos/ingest', { ...payload, headers: { ...payload.headers, 'Idempotency-Key': randomUUID() } });
  assert.equal(result.status, 200); assert.equal(result.data.created, 1);
  assert.equal((await req('/api/videos?view=verified')).data.total, 0);
  assert.equal((await req('/api/videos?cursor=bad')).status, 400);
  assert.equal((await req('/api/videos?view=bogus')).status, 400);
  assert.equal((await req('/api/videos?limit=0')).status, 400);
  assert.equal((await req('/api/videos/' + result.data.results[0].id)).data.observations.length, 1);
});

test('identity enrichment invalidates verification for same-time and historical observations', t => {
  for (const historical of [false, true]) {
    const { videos } = setup(t);
    const short = record({ url: 'https://v.douyin.com/Test123/' });
    const id = ingest(videos, short).results[0].id;
    videos.verify(id, { revision: 1, state: 'verified', note: '人工核验原短链' }, randomUUID());
    ingest(videos, { ...short, videoId: '987654321987654321', ...(historical ? { observedAt: '2026-10-02T21:00:00Z' } : {}) });
    const result = videos.get(id);
    assert.equal(result.video.verification.state, 'candidate');
    assert.equal(result.video.canonicalUrl, 'https://www.douyin.com/video/987654321987654321');
    assert.equal(result.verificationEvents[0].actor, 'system');
    assert.match(result.verificationEvents[0].note, /身份/);
    assert.equal(videos.list({ view: 'verified' }).total, 0);
  }
});
test('public DTO requires explicit publication and excludes every private field', t => {
  const { videos } = setup(t);
  const id = ingest(videos, record({ source: 'PRIVATE SOURCE', evidence: [{ kind: 'page_text', value: 'PRIVATE EVIDENCE', url: 'https://example.test/private-evidence' }] })).results[0].id;
  assert.deepEqual(videos.publicList(), { videos: [], shown: 0, hasMore: false });
  assert.throws(() => videos.publish(id, { revision: 1, isPublic: true }, randomUUID()), e => e.code === 'video_not_publishable');
  videos.verify(id, { revision: 1, state: 'verified', note: 'PRIVATE REVIEW NOTE' }, randomUUID());
  assert.equal(videos.publicList().shown, 0);
  const input = { revision: 2, isPublic: true }, key = randomUUID();
  const result = videos.publish(id, input, key);
  assert.deepEqual(videos.publish(id, input, key), result);
  const pub = videos.publicList(); assert.equal(pub.shown, 1);
  assert.deepEqual(Object.keys(pub.videos[0]).sort(), ['category', 'observedAt', 'observedLikes', 'publishedDate', 'title', 'url', 'verification'].sort());
  assert.equal(pub.videos[0].verification, 'verified');
  assert.doesNotMatch(JSON.stringify(pub), /PRIVATE|example\.test|rawLikeCount|revision|videoId|settings/);
  assert.ok(!JSON.stringify(pub).includes(id));
  videos.publish(id, { revision: result.video.revision, isPublic: false }, randomUUID());
  assert.equal(videos.publicList().shown, 0);
});
test('new observations/identity changes/rejections unpublish; expired criteria remove public eligibility', t => {
  for (const change of ['observation', 'identity', 'rejection', 'expiry']) {
    const { videos, advance } = setup(t);
    const source = record(change === 'identity' ? { url: 'https://v.douyin.com/Short123/' } : {});
    const id = ingest(videos, source).results[0].id;
    videos.verify(id, { revision: 1, state: 'verified', note: '已核验' }, randomUUID());
    videos.publish(id, { revision: 2, isPublic: true }, randomUUID());
    assert.equal(videos.publicList().shown, 1);
    if (change === 'observation') ingest(videos, { ...source, observedAt: '2026-10-03T21:30:00Z' });
    if (change === 'identity') ingest(videos, { ...source, videoId: '1234567890123456789' });
    if (change === 'rejection') videos.verify(id, { revision: 3, state: 'rejected', note: '复核后排除' }, randomUUID());
    if (change === 'expiry') advance(40 * 86400000);
    assert.equal(videos.publicList().shown, 0);
    if (change !== 'expiry') assert.equal(videos.get(id).video.publication.isPublic, false);
  }
});
test('anonymous public endpoint is read-only and has no owner data or write path', async t => {
  const { tasks, videos } = setup(t);
  const id = ingest(videos).results[0].id;
  videos.verify(id, { revision: 1, state: 'verified', note: 'private note' }, randomUUID());
  videos.publish(id, { revision: 2, isPublic: true }, randomUUID());
  const config = { apiToken: 'fictional-test-token-not-for-production', publicOrigin: 'http://localhost:4318', host: '127.0.0.1', port: 0, runtime: 'disabled' };
  const server = createApiServer(tasks, config), address = await listen(server, config);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${address.port}`;
  const result = await fetch(base + '/api/public/videos?limit=100');
  assert.equal(result.status, 200); assert.equal((await result.json()).shown, 1);
  for (const path of ['/api/videos', '/api/video-settings', '/api/workspace', '/api/videos/' + id]) assert.equal((await fetch(base + path)).status, 401);
  assert.equal((await fetch(base + '/api/public/videos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(base + '/api/videos/' + id + '/publication', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 3, isPublic: false }) })).status, 401);
  assert.equal((await fetch(base + '/api/public/videos?limit=101')).status, 400);
});

test('optional author names preserve private observations and never enter public DTO', t => {
  const { videos } = setup(t);
  const id = ingest(videos, record({ authorName: '  测试作者  ' })).results[0].id;
  const detail = videos.get(id);
  assert.equal(detail.video.authorName, '测试作者');
  assert.equal(detail.video.observation.authorName, '测试作者');
  assert.equal(detail.observations[0].authorName, '测试作者');
  videos.verify(id, { revision: 1, state: 'verified', note: '已核验' }, randomUUID());
  videos.publish(id, { revision: 2, isPublic: true }, randomUUID());
  assert.equal(videos.publicList().shown, 1);
  assert.equal(Object.hasOwn(videos.publicList().videos[0], 'authorName'), false);
  assert.doesNotMatch(JSON.stringify(videos.publicList()), /测试作者/);
  assert.throws(() => ingest(videos, record({ authorName: '不同作者' })), e => e.code === 'video_observation_conflict');
  ingest(videos, record({ authorName: '后续观察到的作者名', observedAt: '2026-10-03T21:30:00Z' }));
  assert.equal(videos.get(id).video.authorName, '后续观察到的作者名');
  assert.equal(videos.get(id).observations[1].authorName, '测试作者');
  assert.equal(videos.publicList().shown, 0);
});
test('unknown author is nullable and backward-compatible with stored pre-author observations', t => {
  const { tasks, videos } = setup(t);
  const id = ingest(videos).results[0].id;
  assert.equal(videos.get(id).video.authorName, null);
  assert.equal(ingest(videos, record({ authorName: null })).unchanged, 1);
  assert.equal(ingest(videos, record({ authorName: '  ' })).unchanged, 1);
  const row = tasks.db.prepare('SELECT id, body FROM video_observations WHERE video_id = ?').get(id);
  const old = JSON.parse(row.body); delete old.authorName;
  tasks.db.prepare('UPDATE video_observations SET body = ? WHERE id = ?').run(JSON.stringify(old), row.id);
  assert.equal(ingest(videos).unchanged, 1);
  assert.throws(() => ingest(videos, record({ authorName: 123 })));
  assert.throws(() => ingest(videos, record({ authorName: 'a'.repeat(201) })));
});
