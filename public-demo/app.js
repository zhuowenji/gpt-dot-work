// Deliberately independent from the authenticated workspace application.
// Only this public read-only endpoint is requested, without cookies or auth headers.
const PUBLIC_RESULTS_URL = '/api/public/videos?limit=100';
const categoryLabels = {household_general:'家用百货',kitchen_non_electric:'非电厨房用品'};
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const dateText = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Shanghai'}).format(date) + '（北京时间）' : '未提供';
};
function safeVideoUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\/(?:www\.douyin\.com\/video\/[0-9]{5,30}|v\.douyin\.com\/[A-Za-z0-9_-]{3,100}\/)$/.test(value)) return null;
  return value;
}
function isPublicVideo(video) {
  return video && typeof video.title === 'string' && typeof video.category === 'string'
    && safeVideoUrl(video.url) && typeof video.publishedDate === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(video.publishedDate)
    && Number.isSafeInteger(video.observedLikes) && video.observedLikes >= 0
    && typeof video.observedAt === 'string' && Number.isFinite(Date.parse(video.observedAt))
    && video.verification === 'verified';
}
function renderVideo(video) {
  return `<article class="result-card"><div class="card-top"><span class="category">${escapeHtml(categoryLabels[video.category] || video.category)}</span><span class="verified">✓ 已核验</span></div><h3>${escapeHtml(video.title)}</h3><p class="published">视频发布日期 · ${escapeHtml(video.publishedDate)}</p><div class="observation"><div><div class="likes-label">记录时的点赞数</div><div class="likes">${video.observedLikes.toLocaleString('zh-CN')}<small>赞</small></div><time class="observed" datetime="${escapeHtml(video.observedAt)}">观察于 ${escapeHtml(dateText(video.observedAt))}</time></div><a class="video-link" href="${escapeHtml(video.url)}" target="_blank" rel="noopener noreferrer">查看抖音视频 ↗</a></div></article>`;
}
let loading = false;
async function loadResults() {
  if (loading) return;
  loading = true;
  const button = $('#refresh'), results = $('#results'), status = $('#status'), count = $('#result-count');
  button.disabled = true; results.setAttribute('aria-busy', 'true');
  status.hidden = false; status.className = 'status'; status.textContent = '正在连接公开结果…';
  // Remove old results before retry: an error must not look like fresh success.
  results.innerHTML = ''; count.hidden = true;
  try {
    const response = await fetch(PUBLIC_RESULTS_URL, {method:'GET',credentials:'omit',cache:'no-store',headers:{Accept:'application/json'},redirect:'error'});
    if (!response.ok) throw new Error('Public results are temporarily unavailable');
    const data = await response.json();
    if (!data || !Array.isArray(data.videos) || data.videos.length > 100 || !data.videos.every(isPublicVideo) || data.shown !== data.videos.length || typeof data.hasMore !== 'boolean') throw new Error('Invalid public results');
    $('#updated').textContent = '本次载入 · ' + dateText(new Date().toISOString()) + (data.hasMore ? ' · 仅展示最新 100 条公开结果' : '');
    count.textContent = String(data.shown); count.hidden = false;
    if (!data.videos.length) {
      status.innerHTML = '<strong>暂无公开结果</strong><p>目前还没有符合筛选条件、已核验并由所有者公开的视频。之后有真实结果时会在这里展示。</p>';
    } else {
      results.innerHTML = data.videos.map(renderVideo).join('');
      status.hidden = true;
    }
  } catch {
    $('#updated').textContent = '尚未载入结果';
    status.className = 'status error';
    status.innerHTML = '<strong>暂时无法载入公开结果</strong><p>请稍后点击“刷新结果”重试。</p>';
  } finally {
    loading = false; button.disabled = false; results.setAttribute('aria-busy', 'false');
  }
}
$('#refresh').addEventListener('click', () => void loadResults());
void loadResults();
