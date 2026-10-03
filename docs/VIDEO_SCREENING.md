# 抖音选品：结果与设置 API

## 这一版能做什么

- 登录后在「抖音选品」页保存筛选条件、调度偏好，手动录入候选视频并复核证据。
- 在已有受保护 SQLite 数据库中持久保存视频、历史观察、核验事件和版本化设置。
- 接收获授权数据源的批量观察。按视频 ID 与规范化视频链接去重；保留原始点赞文本、精确/估算标记、观察时间、发布日期原文、证据与来源。
- 将「候选待核验」「人工核验通过」「排除/不符合」分开。新观察会撤销旧的通过/排除状态，要求复核。
- 现有数据库备份包含所有新增表；不需要新增数据库或凭据。

**这一版没有抖音采集适配器、浏览器采集、定时调度器或 24 小时采集能力。** 页面/API 始终返回 collectorConnected=false、schedulerActive=false、lastRunAt=null、nextRunAt=null。保存 requestedEnabled=true 也只是记录偏好，不会执行。来源文本或 API 写入不证明来源经过平台授权；接入实际数据源前必须确认授权范围、平台使用限制、凭据管理、速率限制与稳定运行方式。

没有创建 API 密钥，没有在页面/localStorage 中暴露 bearer token，没有改变现有会话安全策略。部署、运行环境配置和采集适配器接入是独立步骤。

## 筛选语义

默认类别为 household_general（家居百货）、kitchen_non_electric（非电动厨具）；固定排除 appliance（电器）和 inflatable_bed（充气床）。unknown 或 other 不会被自动认定合格。

默认精确点赞数区间为 **1000–3000，包含两端**。原始文本为「2.3千」「1.2万」时必须 likeCountExact=false；即使提供估计整数，仍是待核验候选。标为精确时，原始文本只能为数字及千位逗号/空白，并且与 observedLikes 一致。

最近一个滚动月按照 **Asia/Shanghai 的日历日期**计算，包含起止日期；例如 2026-10-04 对应 2026-09-04 至 2026-10-04。月底向前推一个月时取目标月最后一天，例如 3 月 31 日向前推至 2 月 28/29 日。不是固定 30 天，也不是上个自然月。

关键词留空时不限制；有多个关键词时，视频标题匹配任意一个即可。标题中的明确电器/充气床词会触发额外排除提示，该有限词表不能替代人工商品分类。

结果是否符合条件会在每次读取时按当前日期和最新设置重新计算。原始人工核验记录不会因设置变化被篡改，但不再符合当前条件的记录不会进入 verified 结果页。

## 认证与请求约束

所有 /api/video-settings、/api/videos 路由沿用现有 owner HttpOnly cookie 会话和 X-CSRF-Token；浏览器写入必须来自配置好的精确 origin。已配置的现有机器客户端可使用已有 WORKSPACE_API_TOKEN bearer 凭据；未配置时不能使用。此模块不生成也不返回凭据。

POST /api/videos/ingest、PATCH /api/videos/:id/verification 与 PATCH /api/videos/:id/publication 必须有 Idempotency-Key（8–128 位字母、数字、点、下划线、冒号或连字符）。网络结果不确定时，用同一个 key 和同一个请求体重试；不能把同一个 key 用于不同内容。

单批 1–100 条，JSON 最大 1 MiB。请求具有事务原子性；任意条目验证/身份冲突失败时整批不写入。设置写入最大 32 KiB。

## API

### GET /api/video-settings

返回 revision、updatedAt、criteria、schedule、runtime。初始值：

```json
{
  "revision": 0,
  "updatedAt": null,
  "criteria": {
    "categories": ["household_general", "kitchen_non_electric"],
    "minLikes": 1000,
    "maxLikes": 3000,
    "windowMonths": 1,
    "excludedCategories": ["appliance", "inflatable_bed"],
    "keywords": []
  },
  "schedule": {"requestedEnabled": false, "intervalMinutes": 60, "timezone": "Asia/Shanghai"},
  "runtime": {
    "collectorConnected": false, "schedulerActive": false,
    "state": "not_configured",
    "reason": "尚未接入获授权的抖音数据源；保存设置不会启动采集。",
    "lastRunAt": null, "nextRunAt": null
  }
}
```

### PUT /api/video-settings

请求仅包含最新 revision、完整 criteria、完整 schedule。成功返回新设置，revision 加一。版本过期返回 409 video_settings_conflict。

categories 须从默认两个类别中至少选择一个。minLikes/maxLikes 为 0–10¹² 整数、下限不大于上限。windowMonths=1 与两个 excludedCategories 固定。keywords 最多 12 项，每项最多 120 字符。intervalMinutes 为 15–1440，timezone 须为有效 IANA 时区。调度时区仅是将来调度的偏好，不改变上面的筛选日期时区。

### POST /api/videos/ingest

下面全部是虚构的字段示例，不是已经采集到的视频：

```json
{
  "videos": [{
    "videoId": "1234567890123456789",
    "url": "https://www.douyin.com/video/1234567890123456789",
    "title": "示例厨房沥水篮",
    "authorName": null,
    "category": "kitchen_non_electric",
    "publishedDate": "2026-09-21",
    "rawPublicationDate": "2026-09-21",
    "observedAt": "2026-10-03T21:00:00Z",
    "rawLikeCount": "2,345",
    "observedLikes": 2345,
    "likeCountExact": true,
    "source": "人工查看抖音视频页",
    "evidence": [{"kind": "page_text", "value": "实际看到的页面文本", "url": "https://www.douyin.com/video/1234567890123456789"}]
  }]
}
```

authorName 为可选作者名称，字符串最多 200 字符；未知时省略、null 或空字符串均保存为未知，不会推测或生成作者名字。作者只在私有记录和观察历史中显示，不包含在公开 DTO 中。

videoId 可省略：从官方 /video/:id、/share/video/:id 或 modal_id 链接解析；支持 v.douyin.com 短链接但不会访问/展开它。所有视频链接必须为官方抖音 HTTPS 链接，无账号信息或非标准端口。移除跟踪参数并规范化 URL；短链后来补充视频 ID 时建立别名。ID/URL 冲突返回 409 video_identity_conflict，不自动合并两个已有记录。

publishedDate 可为 null；observedLikes 可为 null；evidence 可为空。这些记录能够入库，但不能核验通过。observedAt 必须带时区且不得超过当前时间五分钟；publishedDate 不得晚于观察日期。

category 可选 household_general、kitchen_non_electric、appliance、inflatable_bed、other、unknown。title 必填且不超过 1000 字符，rawPublicationDate ≤200，rawLikeCount ≤100，source 必填且 ≤200。evidence 最多 10 项，每项 kind 为 page_text、screenshot、api_response 或 manual_note；value 非空且 ≤16000，url 可省略/null 或 HTTPS 链接。证据保存的是文本和可选链接，不下载/上传截图文件。

所有导入初始为 candidate；请求不能带 verification 等额外字段。重复 video+observedAt+相同事实不重复创建；相同视频、相同时间但事实不同返回 409 video_observation_conflict，保护证据不被覆盖。较早观察存入历史，不能覆盖最新观察及核验状态。

成功返回 created、updated、unchanged 计数及 results（每项 id、videoId、revision、outcome）。updated 也包括新增历史观察或补全身份，不代表最新点赞数被覆盖。

### GET /api/videos?view=all&limit=50&cursor=...

view：all、candidate、verified、excluded。limit 1–200，默认 50。返回 videos、total、nextCursor；用 nextCursor 原值继续，null 表示结束。先按首次入库时间倒序，再按内部 UUID 倒序稳定分页。

- candidate：未排除且当前未满足「已核验+符合当前条件」的记录，可能包含已有明确不匹配原因的候选。
- verified：已人工核验且当前条件仍匹配。
- excluded：人工排除，或当前筛选有明确不匹配原因。与 candidate 可能重叠；缺失证据本身不是明确排除。

每项包括 id、videoId、canonicalUrl、title、authorName、category、publishedDate、rawPublicationDate、observation、verification、revision、firstSeenAt、updatedAt、screening、publication（isPublic/publishedAt）。screening 包含 matches、missing（缺失条件）、reasons（明确不匹配）、windowStart/windowEnd。observation 保留 id、receivedAt、observedAt、rawLikeCount、observedLikes、likeCountExact、source、evidence 及当时标题/作者名称/类别/日期。verification 包含 state、note、verifiedAt。时间戳字段除 observedAt 的 ISO 文本外均为 UTC 毫秒。

### GET /api/videos/:id

返回 video、observations（最近 100 条）、verificationEvents（最近 100 条）。数据库保留完整历史；当前页面/接口仅展示最近 100 条，不能将其当作全量历史导出。

### PATCH /api/videos/:id/verification

```json
{"revision": 1, "state": "verified", "note": "已人工核对原视频的商品类别、发布日期和精确点赞数。"}
```

state：candidate、verified、rejected；后两者 note 必填，最多 2000 字符。核验仅针对所提交 revision 的最新 observation，过期返回 409 video_revision_conflict。verified 要求当前规则符合、精确点赞数、发布日期和非 manual_note 的证据；否则 409 video_not_verifiable。接口验证字段完整性，不会自动证明证据真实，调用者必须实际核对。写入审计记录区分 owner_session、owner_api 及新观察导致的 system 状态变更。

## 公开只读结果

### PATCH /api/videos/:id/publication

仅已登录 owner 或已有可信机器客户端可调用，沿用 CSRF 和 Idempotency-Key。请求：

```json
{"revision": 2, "isPublic": true}
```

所有结果默认私有；人工核验通过不会自动公开。只有已核验且当前条件符合的记录可以主动公开，否则返回 409 video_not_publishable。过期版本返回 409 video_revision_conflict。isPublic=false 撤下公开展示。成功返回 {video} 并增加版本、私有公开操作审计。

公开确认必须提示：任何获得公开页面链接的人都可看到视频标题、商品类别、抖音链接、发布日期、观察到的点赞数/时间、核验标签。不会公开证据、原始记录、来源备注或核验笔记。新观察、视频身份改变、改为候选/排除时自动撤下；日期滚动或设置改变导致不符合当前条件时也不会出现在公共接口中。

### GET /api/public/videos?limit=50

唯一匿名只读数据路由，limit 为 1–100。响应仅含明确允许公开的 DTO：

```json
{"videos":[], "shown":0, "hasMore":false}
```

videos 中每项严格只有 title、category、url、publishedDate、observedLikes、observedAt、verification（固定 verified）。不返回内部 ID、原始点赞文本、证据、来源、核验备注、历史、私有记录数量、任务、知识库、设置或凭据。shown 是本次返回的公开记录数量；hasMore 只表示还有更多符合公开条件的记录，当前展示最多 100 条，无匿名全量导出。POST/PATCH 等写入不会绕过私有 API 认证。

此路由不检查/声称采集器运行状态。公开页面没有结果时必须显示真实空状态，不用虚构样例填充。

## 数据与运维

新增表：video_settings、video_results、video_aliases、video_observations、video_verification_events、video_publication_events。数据库复用既有 TaskStore.db；幂等记录复用 idempotency 表。迁移只有新增表/索引，不改写已有工作空间/任务记录；旧代码回滚时忽略这些表。SQLite 一致性备份工具 scripts/backup.mjs 覆盖完整数据库，因此包含选品结果。部署前仍应按原流程备份并验证恢复。

当前实现面向单人初期结果量，筛选/总数计算会读取现存视频结果。若持续采集产生大量数据，应先增加索引化筛选和历史分页/归档，再接入生产级全天候任务。记录可包含个人信息，按原数据库权限和备份保护要求处理。
