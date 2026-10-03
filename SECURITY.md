# GPT-DOT-WORK 安全说明

## 支持范围

当前是未完成生产安全审计的单用户私有部署候选。不能把本地测试通过视为正式生产安全保证；没有多用户、MFA 或安全响应时限承诺。不要直接暴露 Node 监听端口，不要立即用于高敏感生产数据。

- 服务器模式使用 owner 密码验证、服务端会话、HttpOnly cookie、CSRF 与 origin 检查；工作空间和任务存入私有 SQLite。浏览器不持久保存登录凭据。
- 离线演示是独立模式，使用 localStorage 和虚构数据。服务器 API 失败时不会自动退回离线演示，也不会自动把演示数据导入私有库。
- 生产模式需要正确 HTTPS public origin、密码 hash、静态构建与私有数据路径。部署前必须在实际代理后验证 cookie、注销和过期行为。
- Bearer API/审批令牌是可选自动化接口，若启用需独立配置并保存在服务端；不能放入浏览器、URL、截图、日志或公开 issue。
- 数据库、会话、日志、导出、密码 hash 和备份都是私有资料，应在仓库和静态目录外，限制访问、管理保留策略。备份恢复后必须撤销恢复的 session。
- Worker 默认 disabled，不执行用户输入的代码、shell 或任意网页指令。Demo handler 始终标为模拟。连接真实工具前仍需权限、行动审批、隔离、取消、外部幂等、日志脱敏与成本限制。
- 受控部署仍有残余风险：认证端点可能遭拒绝服务；单用户密码无第二因素；主机 root、数据库或认证配置失陷会破坏保密性；SQLite 单主机不能代替高可用数据库。

## 现有服务器保护

只接入已有 Git 构建/部署机制；不额外创建调度器或 webhooks。先审阅既有脚本和代理，新增专属项目路径与虚拟主机，不覆盖默认 nginx 配置或已有应用。上线前后检查旧应用，并准备应用 release 回滚和数据恢复演练。详见 [部署准备](docs/DEPLOYMENT.md)。

## 私下报告漏洞

仓库存在不代表私人漏洞报告渠道已启用。维护者需要启用并实际验证 GitHub private vulnerability reporting，明确响应责任人。

如果 Security → Advisories 中可见 Report a vulnerability，请走该私密渠道。若没有此按钮，请勿把漏洞细节、真实数据或令牌发到公共 issue；可提交仅询问私下联系渠道的普通请求，并等待维护者提供经过验证的方式。

私下报告提供受影响版本、虚构最小复现和影响。只测试获得授权的环境，不读取他人数据。秘密泄漏时应先撤销/轮换，单纯删掉帖子无效。参考：[GitHub 官方私人漏洞报告设置](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)。
