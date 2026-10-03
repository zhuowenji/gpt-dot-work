import { randomUUID } from 'node:crypto';
import { ApiError } from './store.mjs';

export const VIDEO_CATEGORIES = ['household_general', 'kitchen_non_electric', 'appliance', 'inflatable_bed', 'other', 'unknown'];
export const defaultVideoCriteria = () => ({ categories: ['household_general', 'kitchen_non_electric'], minLikes: 1000, maxLikes: 3000, windowMonths: 1, excludedCategories: ['appliance', 'inflatable_bed'], keywords: [] });
export const videoRuntime = () => ({ collectorConnected: false, schedulerActive: false, state: 'not_configured', reason: '尚未接入获授权的抖音数据源；保存设置不会启动采集。', lastRunAt: null, nextRunAt: null });
const fail = message => { throw new ApiError(400, 'invalid_video_input', message); };
function object(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('字段缺失或包含不支持的字段。');
}
function text(value, max, label, required = false) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (required && !value.trim())) fail(`${label}须为${required ? '非空' : ''}文本，最多 ${max} 字符。`);
  return value.trim();
}
function exactDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('发布日期须为有效 YYYY-MM-DD 或 null。');
  return value;
}
function shanghaiDate(at) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}
export function rollingMonth(at) {
  const end = shanghaiDate(at);
  const [year, month, day] = end.split('-').map(Number);
  const previous = new Date(Date.UTC(year, month - 2, 1));
  const lastDay = new Date(Date.UTC(previous.getUTCFullYear(), previous.getUTCMonth() + 1, 0)).getUTCDate();
  previous.setUTCDate(Math.min(day, lastDay));
  return { windowStart: previous.toISOString().slice(0, 10), windowEnd: end };
}
export function normalizeVideoIdentity(rawUrl, rawId) {
  const urlText = text(rawUrl, 2048, '视频链接', true);
  let url; try { url = new URL(urlText); } catch { fail('须提供有效抖音 HTTPS 视频链接。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !['www.douyin.com', 'douyin.com', 'm.douyin.com', 'v.douyin.com'].includes(url.hostname)) fail('仅接受抖音官方 HTTPS 视频或短链接。');
  if (rawId !== undefined && rawId !== null && (typeof rawId !== 'string' || !/^\d{5,30}$/.test(rawId))) fail('视频 ID 须为 5–30 位数字字符串。');
  let urlId = null, alias;
  if (url.hostname === 'v.douyin.com') {
    if (!/^\/[A-Za-z0-9_-]{3,100}\/?$/.test(url.pathname)) fail('无效抖音短链接。');
    alias = `https://v.douyin.com/${url.pathname.split('/')[1]}/`;
  } else {
    urlId = /^\/(?:share\/)?video\/(\d{5,30})\/?$/.exec(url.pathname)?.[1] || null;
    if (!urlId && url.pathname === '/' && /^\d{5,30}$/.test(url.searchParams.get('modal_id') || '')) urlId = url.searchParams.get('modal_id');
    if (!urlId) fail('链接必须指向一个具体抖音视频。');
    alias = `https://www.douyin.com/video/${urlId}`;
  }
  if (urlId && rawId && urlId !== rawId) fail('视频 ID 与链接中的 ID 不一致。');
  const videoId = rawId || urlId || null;
  return { videoId, canonicalUrl: videoId ? `https://www.douyin.com/video/${videoId}` : alias, aliases: [...new Set([alias, ...(videoId ? [`https://www.douyin.com/video/${videoId}`] : [])])] };
}
function evidenceUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  text(value, 2048, '证据链接', true);
  let url; try { url = new URL(value); } catch { fail('证据链接无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password) fail('证据链接须为无账号信息的 HTTPS 链接。');
  return url.href;
}
function validateObservation(input, now) {
  object(input, ['videoId', 'url', 'title', 'authorName', 'category', 'publishedDate', 'rawPublicationDate', 'observedAt', 'rawLikeCount', 'observedLikes', 'likeCountExact', 'source', 'evidence'], ['url', 'title', 'category', 'publishedDate', 'rawPublicationDate', 'observedAt', 'rawLikeCount', 'observedLikes', 'likeCountExact', 'source', 'evidence']);
  const identity = normalizeVideoIdentity(input.url, input.videoId);
  const title = text(input.title, 1000, '视频标题', true);
  const authorName = input.authorName == null ? null : text(input.authorName, 200, '作者名称') || null;
  if (!VIDEO_CATEGORIES.includes(input.category)) fail('视频类别无效。');
  const rawPublicationDate = text(input.rawPublicationDate, 200, '原始发布日期');
  const publishedDate = input.publishedDate === null ? null : exactDate(input.publishedDate);
  if (typeof input.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.observedAt)) fail('采集时间须包含完整时间和时区。');
  exactDate(input.observedAt.slice(0, 10));
  if (Number(input.observedAt.slice(11, 13)) > 23 || Number(input.observedAt.slice(14, 16)) > 59 || Number(input.observedAt.slice(17, 19)) > 59) fail('采集时间时分秒无效。');
  const observedTime = Date.parse(input.observedAt);
  if (!Number.isFinite(observedTime) || observedTime < Date.UTC(2000, 0, 1) || observedTime > now + 300000) fail('采集时间无效或超出当前时间。');
  if (publishedDate && publishedDate > shanghaiDate(observedTime)) fail('发布日期不能晚于采集日期。');
  const rawLikeCount = text(input.rawLikeCount, 100, '原始点赞文本');
  if (input.observedLikes !== null && (!Number.isSafeInteger(input.observedLikes) || input.observedLikes < 0 || input.observedLikes > 1e12)) fail('点赞数须为非负整数或 null。');
  if (typeof input.likeCountExact !== 'boolean') fail('必须明确点赞数是否精确。');
  if (input.likeCountExact && (input.observedLikes === null || !/^\d+$/.test(rawLikeCount.replace(/[,，\s]/g, '')) || Number(rawLikeCount.replace(/[,，\s]/g, '')) !== input.observedLikes)) fail('精确点赞数须与原始数字一致；1.2千等缩写只能标为非精确。');
  const source = text(input.source, 200, '数据来源', true);
  if (!Array.isArray(input.evidence) || input.evidence.length > 10) fail('每条观察最多保存 10 项证据。');
  const evidence = input.evidence.map(item => {
    object(item, ['kind', 'value', 'url'], ['kind', 'value']);
    if (!['page_text', 'screenshot', 'api_response', 'manual_note'].includes(item.kind)) fail('证据类型无效。');
    return { kind: item.kind, value: text(item.value, 16000, '证据内容', true), url: evidenceUrl(item.url) };
  });
  return { ...identity, title, ...(authorName === null ? {} : { authorName }), category: input.category, publishedDate, rawPublicationDate, observation: { observedAt: new Date(observedTime).toISOString(), rawLikeCount, observedLikes: input.observedLikes, likeCountExact: input.likeCountExact, source, evidence } };
}
function validateSettings(input) {
  object(input, ['revision', 'criteria', 'schedule']);
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) fail('设置版本无效。');
  const c = input.criteria, s = input.schedule;
  object(c, ['categories', 'minLikes', 'maxLikes', 'windowMonths', 'excludedCategories', 'keywords']);
  if (!Array.isArray(c.categories) || !c.categories.length || c.categories.length > 2 || new Set(c.categories).size !== c.categories.length || c.categories.some(v => !['household_general', 'kitchen_non_electric'].includes(v))) fail('至少选择家居百货或非电动厨具之一。');
  if (!Number.isSafeInteger(c.minLikes) || !Number.isSafeInteger(c.maxLikes) || c.minLikes < 0 || c.maxLikes > 1e12 || c.maxLikes < c.minLikes) fail('点赞范围无效。');
  if (c.windowMonths !== 1 || !Array.isArray(c.excludedCategories) || JSON.stringify([...c.excludedCategories].sort()) !== JSON.stringify(['appliance', 'inflatable_bed'])) fail('本流程固定最近一个滚动月，排除电器与充气床。');
  if (!Array.isArray(c.keywords) || c.keywords.length > 12) fail('关键词最多 12 个。');
  const keywords = [...new Set(c.keywords.map(k => text(k, 120, '关键词', true)))];
  object(s, ['requestedEnabled', 'intervalMinutes', 'timezone']);
  if (typeof s.requestedEnabled !== 'boolean' || !Number.isSafeInteger(s.intervalMinutes) || s.intervalMinutes < 15 || s.intervalMinutes > 1440) fail('周期须为 15–1440 分钟。');
  text(s.timezone, 80, '调度时区', true);
  try { new Intl.DateTimeFormat('en', { timeZone: s.timezone }); } catch { fail('调度时区无效。'); }
  return { revision: input.revision, criteria: { ...c, categories: [...c.categories], excludedCategories: ['appliance', 'inflatable_bed'], keywords }, schedule: { ...s } };
}
export function screenVideo(video, criteria, now) {
  const missing = [], reasons = [], window = rollingMonth(now), observation = video.observation;
  if (video.category === 'unknown') missing.push('尚未确认商品类别');
  else if (!criteria.categories.includes(video.category)) reasons.push('商品类别不在选择范围');
  if (criteria.excludedCategories.includes(video.category)) reasons.push('电器或充气床属于排除项');
  if (/充气(?:床|床垫)|inflatable\s*(?:bed|mattress)|电饭煲|电饭锅|空气炸锅|电磁炉|微波炉|电烤箱|电热水壶|榨汁机|破壁机|洗碗机|吸尘器|扫地机器人|electric\s*(?:kettle|oven|cooker)/i.test(video.title)) reasons.push('标题含电器或充气床排除信号，请人工复核');
  if (!video.publishedDate) missing.push('缺少可核验发布日期');
  else if (video.publishedDate < window.windowStart || video.publishedDate > window.windowEnd) reasons.push('发布日期不在最近一个滚动月内');
  if (observation.observedLikes === null) missing.push('缺少点赞数');
  else if (observation.observedLikes < criteria.minLikes || observation.observedLikes > criteria.maxLikes) reasons.push('点赞数不在设定范围');
  if (!observation.likeCountExact) missing.push('点赞数是缩写或估算，未确认精确数值');
  if (!observation.evidence.some(e => ['page_text', 'screenshot', 'api_response'].includes(e.kind))) missing.push('缺少页面、截图或接口证据');
  if (criteria.keywords.length && !criteria.keywords.some(k => video.title.toLocaleLowerCase().includes(k.toLocaleLowerCase()))) reasons.push('标题未匹配所设关键词');
  return { matches: missing.length === 0 && reasons.length === 0, missing, reasons, ...window };
}

export class VideoStore {
  constructor(taskStore) {
    this.store = taskStore; this.db = taskStore.db;
    // Additive tables share the existing protected DB and backup lifecycle.
    this.db.exec(`CREATE TABLE IF NOT EXISTS video_settings (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, updated_at INTEGER, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS video_results (id TEXT PRIMARY KEY, video_id TEXT UNIQUE, canonical_url TEXT NOT NULL UNIQUE, first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS video_order ON video_results(first_seen_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS video_aliases (url TEXT PRIMARY KEY, video_id TEXT NOT NULL REFERENCES video_results(id));
      CREATE TABLE IF NOT EXISTS video_observations (id TEXT PRIMARY KEY, video_id TEXT NOT NULL REFERENCES video_results(id), observed_at INTEGER NOT NULL, received_at INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(video_id, observed_at));
      CREATE INDEX IF NOT EXISTS video_observations_by_video ON video_observations(video_id, observed_at DESC);
      CREATE TABLE IF NOT EXISTS video_verification_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT NOT NULL REFERENCES video_results(id), at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS video_publication_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT NOT NULL REFERENCES video_results(id), at INTEGER NOT NULL, body TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO video_settings(id, revision, updated_at, body) VALUES (1, 0, NULL, ?)').run(JSON.stringify({ criteria: defaultVideoCriteria(), schedule: { requestedEnabled: false, intervalMinutes: 60, timezone: 'Asia/Shanghai' } }));
  }
  settings() {
    const row = this.db.prepare('SELECT * FROM video_settings WHERE id = 1').get();
    return { revision: row.revision, updatedAt: row.updated_at, ...JSON.parse(row.body), runtime: videoRuntime() };
  }
  putSettings(input) {
    const clean = validateSettings(input);
    return this.store.transaction(() => {
      const result = this.db.prepare('UPDATE video_settings SET revision = revision + 1, updated_at = ?, body = ? WHERE id = 1 AND revision = ?').run(this.store.now(), JSON.stringify({ criteria: clean.criteria, schedule: clean.schedule }), clean.revision);
      if (result.changes !== 1) throw new ApiError(409, 'video_settings_conflict', '设置已在另一页面更改，请刷新后重新确认。');
      return this.settings();
    });
  }
  raw(id) {
    const row = this.db.prepare('SELECT body FROM video_results WHERE id = ?').get(id);
    if (!row) throw new ApiError(404, 'not_found', '视频结果不存在。');
    return JSON.parse(row.body);
  }
  decorate(video, criteria = this.settings().criteria) { return { ...video, screening: screenVideo(video, criteria, this.store.now()) }; }
  get(id) {
    return { video: this.decorate(this.raw(id)), observations: this.db.prepare('SELECT body FROM video_observations WHERE video_id = ? ORDER BY observed_at DESC LIMIT 100').all(id).map(row => JSON.parse(row.body)), verificationEvents: this.db.prepare('SELECT at, body FROM video_verification_events WHERE video_id = ? ORDER BY seq DESC LIMIT 100').all(id).map(row => ({ at: row.at, ...JSON.parse(row.body) })) };
  }
  list({ view = 'all', limit = 50, cursor = null } = {}) {
    if (!['all', 'candidate', 'verified', 'excluded'].includes(view)) throw new ApiError(400, 'invalid_query', '结果视图无效。');
    const criteria = this.settings().criteria;
    // Derived screening is recalculated for the rolling date window/settings.
    const rows = this.db.prepare('SELECT body FROM video_results ORDER BY first_seen_at DESC, id DESC').all();
    const selected = rows.map(row => this.decorate(JSON.parse(row.body), criteria)).filter(v => view === 'all' || (view === 'verified' ? v.verification.state === 'verified' && v.screening.matches : view === 'excluded' ? v.verification.state === 'rejected' || v.screening.reasons.length > 0 : v.verification.state !== 'rejected' && !(v.verification.state === 'verified' && v.screening.matches)));
    const candidates = selected.filter(v => !cursor || v.firstSeenAt < cursor.firstSeenAt || (v.firstSeenAt === cursor.firstSeenAt && v.id < cursor.id));
    const videos = candidates.slice(0, limit), last = videos.at(-1);
    return { videos, total: selected.length, nextCursor: candidates.length > limit ? `${last.firstSeenAt}:${last.id}` : null };
  }
  ingest(input, key) {
    object(input, ['videos']);
    if (!Array.isArray(input.videos) || !input.videos.length || input.videos.length > 100) fail('每批须包含 1–100 条视频观察。');
    const clean = input.videos.map(v => validateObservation(v, this.store.now()));
    return this.store.idempotent('videos:ingest', key, clean, () => {
      const counts = { created: 0, updated: 0, unchanged: 0, results: [] };
      for (const record of clean) {
        const ids = new Set();
        if (record.videoId) { const row = this.db.prepare('SELECT id FROM video_results WHERE video_id = ?').get(record.videoId); if (row) ids.add(row.id); }
        for (const alias of record.aliases) { const row = this.db.prepare('SELECT video_id FROM video_aliases WHERE url = ?').get(alias); if (row) ids.add(row.video_id); }
        if (ids.size > 1) throw new ApiError(409, 'video_identity_conflict', '视频 ID 和短链接分别属于不同记录，需要人工处理。');
        const at = this.store.now(), old = ids.size ? this.raw([...ids][0]) : null;
        if (old?.videoId && record.videoId && old.videoId !== record.videoId) throw new ApiError(409, 'video_identity_conflict', '此短链接已属于另一个视频 ID。');
        const id = old?.id || randomUUID();
        const observationData = { ...record.observation, title: record.title, authorName: record.authorName ?? null, category: record.category, publishedDate: record.publishedDate, rawPublicationDate: record.rawPublicationDate };
        const observedAt = Date.parse(record.observation.observedAt);
        const duplicate = old ? this.db.prepare('SELECT body FROM video_observations WHERE video_id = ? AND observed_at = ?').get(id, observedAt) : null;
        if (duplicate) {
          const { id: unusedId, receivedAt: unusedAt, authorName: previousAuthor, ...previous } = JSON.parse(duplicate.body);
          const { authorName: currentAuthor, ...current } = observationData;
          if ((previousAuthor ?? null) !== currentAuthor || JSON.stringify(previous) !== JSON.stringify(current)) throw new ApiError(409, 'video_observation_conflict', '同一视频、同一采集时间已存在不同数据，不能覆盖原证据。');
        }
        const observation = duplicate ? JSON.parse(duplicate.body) : { id: randomUUID(), receivedAt: at, ...observationData };
        let video = old;
        const latest = !old || observedAt > Date.parse(old.observation.observedAt);
        const identityChanged = old && !old.videoId && record.videoId;
        if (!old || latest || identityChanged) {
          video = { ...(old || {}), id, videoId: old?.videoId || record.videoId, canonicalUrl: old?.videoId ? old.canonicalUrl : record.canonicalUrl,
            ...(latest ? { title: record.title, authorName: record.authorName ?? null, category: record.category, publishedDate: record.publishedDate, rawPublicationDate: record.rawPublicationDate, observation } : {}),
            ...((latest || identityChanged) ? { verification: { state: 'candidate', note: '', verifiedAt: null }, publication: { isPublic: false, publishedAt: null } } : {}),
            firstSeenAt: old?.firstSeenAt ?? at, updatedAt: at, revision: (old?.revision || 0) + 1 };
          if (!old) this.db.prepare('INSERT INTO video_results(id, video_id, canonical_url, first_seen_at, updated_at, revision, body) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, video.videoId, video.canonicalUrl, video.firstSeenAt, at, video.revision, JSON.stringify(video));
          else this.save(video);
          if (old && (latest || identityChanged)) {
            this.event(id, { state: 'candidate', note: identityChanged ? '视频身份已更新，需要重新核验。' : '新观察已入库，需要重新核验。', observationId: video.observation.id, actor: 'system' });
            if (old.publication?.isPublic) this.publicationEvent(id, { isPublic: false, reason: identityChanged ? 'identity_changed' : 'new_observation', actor: 'system' });
          }
        }
        for (const alias of record.aliases) this.db.prepare('INSERT OR IGNORE INTO video_aliases(url, video_id) VALUES (?, ?)').run(alias, id);
        if (!duplicate) this.db.prepare('INSERT INTO video_observations(id, video_id, observed_at, received_at, body) VALUES (?, ?, ?, ?, ?)').run(observation.id, id, observedAt, at, JSON.stringify(observation));
        const outcome = !old ? 'created' : !duplicate || identityChanged ? 'updated' : 'unchanged'; counts[outcome]++;
        counts.results.push({ id, outcome, videoId: video.videoId, revision: video.revision });
      }
      return counts;
    });
  }
  save(video) {
    this.db.prepare('UPDATE video_results SET video_id = ?, canonical_url = ?, updated_at = ?, revision = ?, body = ? WHERE id = ?').run(video.videoId, video.canonicalUrl, video.updatedAt, video.revision, JSON.stringify(video), video.id);
  }
  event(id, body) { this.db.prepare('INSERT INTO video_verification_events(video_id, at, body) VALUES (?, ?, ?)').run(id, this.store.now(), JSON.stringify(body)); }
  publicationEvent(id, body) { this.db.prepare('INSERT INTO video_publication_events(video_id, at, body) VALUES (?, ?, ?)').run(id, this.store.now(), JSON.stringify(body)); }
  publish(id, input, key, actor = 'owner') {
    object(input, ['revision', 'isPublic']);
    if (!Number.isSafeInteger(input.revision) || input.revision < 1 || typeof input.isPublic !== 'boolean') fail('公开状态或版本无效。');
    return this.store.idempotent(`videos:publish:${id}`, key, input, () => {
      const video = this.raw(id);
      if (video.revision !== input.revision) throw new ApiError(409, 'video_revision_conflict', '视频已有更新，请重新查看再决定是否公开。');
      if (input.isPublic && (video.verification.state !== 'verified' || !screenVideo(video, this.settings().criteria, this.store.now()).matches)) throw new ApiError(409, 'video_not_publishable', '只有已人工核验且当前条件符合的视频才能公开。');
      video.publication = { isPublic: input.isPublic, publishedAt: input.isPublic ? this.store.now() : null };
      video.revision++; video.updatedAt = this.store.now(); this.save(video);
      this.publicationEvent(id, { isPublic: input.isPublic, reason: 'owner_decision', actor });
      return { video: this.decorate(video) };
    });
  }
  publicList({ limit = 50 } = {}) {
    const criteria = this.settings().criteria;
    const rows = this.db.prepare("SELECT body FROM video_results WHERE json_extract(body, '$.publication.isPublic') = 1 ORDER BY first_seen_at DESC, id DESC").all();
    const allowed = rows.map(row => JSON.parse(row.body)).filter(video => video.verification.state === 'verified' && screenVideo(video, criteria, this.store.now()).matches);
    // A constructed allowlist prevents future private fields from leaking.
    const videos = allowed.slice(0, limit).map(video => ({ title: video.title, category: video.category, url: video.canonicalUrl, publishedDate: video.publishedDate, observedLikes: video.observation.observedLikes, observedAt: video.observation.observedAt, verification: 'verified' }));
    return { videos, shown: videos.length, hasMore: allowed.length > limit };
  }
  verify(id, input, key, actor = 'owner') {
    object(input, ['revision', 'state', 'note']);
    if (!Number.isSafeInteger(input.revision) || input.revision < 1 || !['candidate', 'verified', 'rejected'].includes(input.state)) fail('核验状态或版本无效。');
    const note = text(input.note, 2000, '核验说明', input.state !== 'candidate');
    return this.store.idempotent(`videos:verify:${id}`, key, { ...input, note }, () => {
      const video = this.raw(id);
      if (video.revision !== input.revision) throw new ApiError(409, 'video_revision_conflict', '视频已有新观察或核验，请重新查看后操作。');
      const screening = screenVideo(video, this.settings().criteria, this.store.now());
      if (input.state === 'verified' && !screening.matches) throw new ApiError(409, 'video_not_verifiable', `当前无法核验通过：${[...screening.reasons, ...screening.missing].join('；')}`);
      const at = this.store.now();
      video.verification = { state: input.state, note, verifiedAt: input.state === 'candidate' ? null : at };
      if (input.state !== 'verified' && video.publication?.isPublic) {
        video.publication = { isPublic: false, publishedAt: null };
        this.publicationEvent(id, { isPublic: false, reason: 'verification_changed', actor });
      }
      video.revision++; video.updatedAt = at;
      this.save(video); this.event(id, { state: input.state, note, observationId: video.observation.id, actor });
      return { video: this.decorate(video) };
    });
  }
}
