# GPT-DOT-WORK · 个人 AI 工作台

独立、非官方项目，与 OpenAI 无隶属、合作或背书关系。

中文个人工作空间：项目、笔记、行动和待执行需求。Node.js 24 + 原生 SQLite，无第三方 npm 依赖。当前为**单用户私有部署候选**，尚未在目标主机上线或完成生产安全审计。真实 AI 执行默认关闭。

许可尚未选定，`UNLICENSED` 不等于开源许可；没有 LICENSE 授权。

## 两种明确分开的模式

| 模式 | 用途 | 数据 | 登录 |
| --- | --- | --- | --- |
| 离线演示 | 看布局、试交互 | 虚构初始数据，当前浏览器 localStorage | 不需要 |
| 私有服务器 | 单个 owner 的真实工作空间 | 服务器 SQLite，首次为空 | 服务端验证、HttpOnly session |

服务器故障不会切回 demo；演示内容不会自动上传。代码中的示例不包含真实聊天记录、用户资料、秘密或服务器地址。

## 本地预览与检查

```sh
npm run build
# 打开 dist/preview.html：无需安装的离线演示
npm run dev:demo
# 或浏览器打开 http://127.0.0.1:4173
npm run check
npm --prefix backend run check
```

`npm run dev` 仍是兼容的静态演示命令。`npm start` 现在启动**真实后端服务**，缺少认证配置时拒绝启动，不能靠演示默认值启动生产服务。

## 私有服务

先阅读 [部署准备](docs/DEPLOYMENT.md) 和 [后台文档](backend/README.md)。由管理员在可信终端准备 owner 密码 hash，放到仓库外受保护的环境配置；不要把密码发到聊天、命令行参数、Git 或日志。

```sh
npm run build
# 由已有运行/部署机制注入认证和数据目录配置之后：
npm start
```

生产环境需要 HTTPS 反向代理及精确的 `WORKSPACE_PUBLIC_ORIGIN`。应用只监听回环端口，owner 登录后从空工作空间创建项目。API 采用会话、CSRF 与版本冲突检测，数据在服务器持久保存。数据库不在 release 目录，代码升级不应覆盖它。

如果已有 Git 自动部署脚本，使用 `sh deploy/prepare-release.sh` 作为其检查/构建阶段；该 hook 不会自行拉取、安装、改代理、重启或新增调度。主机、原脚本、域名、运行权限与回滚步骤须先确认。

## 功能

- 总览、项目、可搜索的笔记、任务状态与本地/服务端明确标识
- 服务器首次为空，可创建项目、笔记和任务；修改持久化到 SQLite
- 保存错误、会话过期和不同页面的写入版本冲突需要显式处理，不伪报成功
- AI 需求草稿与明确提交分开；状态、结果、日志、取消/重试与审批使用服务端记录
- SQLite 原子领取、幂等键、租约、取消围栏和显式审批边界
- owner 登录/退出、会话过期、origin/CSRF 防护、登录限速、受保护的静态和 API 配置
- 一致性 SQLite 备份工具，拒绝覆盖旧备份；备份和恢复仍由已有运维流程负责

默认 worker 每 60 秒检查已提交队列；没有配置真实执行器时进入 `blocked/not_configured`。仅显式 demo handler 会返回标明模拟的结果。网页文字、第三方内容和“已提交”状态本身都不是任意外部操作的授权。这个轮询进程不是聊天助手全天持续思考的承诺。

## 数据和边界

- 离线 demo 使用 localStorage，不加密、不跨设备，不能存敏感资料。
- 服务器 SQLite、认证配置、备份、日志在仓库外；`.gitignore` 不是访问控制。
- 生产会话与密码 hash 需要主机权限和 HTTPS 保护；备份恢复后必须撤销旧会话。
- 没有多用户/MFA、真实 AI 适配器、经过验证的灾难恢复或完整渗透测试。
- 反向代理、证书、旧应用共存与浏览器验收必须在实际环境完成。配置模板不是自动部署承诺。
- 不含第三方字体、图片、遥测或 CDN；使用系统字体与内联基础 SVG。

## 目录与协作

```text
src/       中文前端、模式判断、数据模型
backend/   认证、会话、工作空间、任务 API、SQLite、worker
scripts/   构建、静态演示、备份
tests/    自动化与可选浏览器回归
deploy/   现有部署流程可调用的构建 hook、通用运行/代理模板
docs/     部署、发布、安全和验证说明
```

[贡献指南](CONTRIBUTING.md) · [安全边界](SECURITY.md) · [第三方说明](THIRD_PARTY_NOTICES.md) · [发布清单](docs/OPEN_SOURCE_RELEASE.md) · [验证记录](docs/VERIFICATION.md)
