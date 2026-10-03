# 验证记录：私有单用户候选

日期：2026-10-03 UTC。测试环境：Linux、Node.js 24.19.0。

源代码基线是远端 main `04aa92137d421826766c1123be2efa3bf67e17bf`；在独立 `feat/private-owner-deployment` 分支工作，未覆盖 main。本记录描述本地候选，不能代表它已部署或经过托管 CI。

## 已通过

- `npm run check`：45 项测试通过，前端/构建/备份脚本语法与静态构建成功。
- `npm --prefix backend run check`：27 项后台测试通过，所有后台模块语法检查成功。
- `sh deploy/prepare-release.sh`：完整调用两套检查与构建，成功；不执行激活/部署。
- `git diff --check`：无空白错误。
- `tests/browser_smoke.py` Python 语法检查；单文件 demo 构建无外部模块/样式依赖，提取内联 JS 后语法检查通过。

覆盖包括：

- owner 密码 hash 配置、生产 HTTPS/回环/静态目录校验、匿名访问拒绝
- HttpOnly/SameSite/Secure cookie、会话轮换/退出/绝对与空闲过期/密码变更失效
- CSRF、精确 Origin、持久限速及伪造转发 IP 拒绝
- SQLite 工作空间持久化、结构/大小限制、跨页面版本冲突
- 草稿与提交分离、**提交绑定用户审阅的确切 draft revision**，过期内容不进入队列
- 幂等键、8 个进程竞争的原子领取、取消/租约/重试、显式审批和过期审批拒绝
- 前端 client API 合同和源代码 VM 中的登录初态、无 localStorage 私有泄漏、服务器故障不回退演示、空账号与编辑恢复/过期冲突
- SQLite 一致性 WAL 备份、私有权限、新文件不覆盖、密码 hash 工具虚构测试与会话撤销 CLI

## 未完成 / 不代表已验证

- Chromium/UI 渲染、手机/桌面截图与实际浏览器全流程尚未验证。该环境此前阻止 Chromium 启动和本地浏览器访问；没有绕过限制。Node 源代码 VM 只覆盖业务状态边界，不能替代真实 DOM、焦点、视觉、cookie 和代理后的浏览器验证。
- 这批候选改动尚未经过 GitHub 托管 CI，也没有部署。早先 main 的 CI 结果不能代替本分支结果。
- nginx/Caddy 运行配置、证书、目标主机访问权限及既有应用共存尚未验证。systemd 模板本地验证被环境只读 `/run/systemd` 限制阻塞；需要在实际主机审阅/验证。
- 备份恢复完整演练、MFA、多用户、生产渗透测试、真实 AI 适配器和工具隔离尚未完成。

## 上线前必须在实际环境复验

使用已有部署机制，先在独立 release 路径运行构建 hook，再验证登录页、空账号创建项目/笔记/待办、刷新持久化、两页面冲突、退出/过期、草稿确认提交、禁用执行器阻塞、取消/重试和审批。检查 `/health` releaseId 与激活提交一致，且旧应用不受影响。演练私有 SQLite 备份恢复并撤销恢复的会话。详见 [部署准备](DEPLOYMENT.md)。
