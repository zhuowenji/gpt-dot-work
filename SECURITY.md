# GPT-DOT-WORK 安全说明 / Security

## 支持范围

当前为未正式发布的本地原型，没有生产支持或安全响应时限承诺。不要用于敏感生产数据或直接暴露到公网。

- 前端数据保存在当前浏览器 localStorage 中，不是加密保险库，也不提供用户登录或跨设备同步。
- 后台是独立的本地队列原型。API 令牌不是完整的多用户认证/授权系统；默认仅监听回环地址，执行器默认 disabled。
- 请为 API 与审批配置不同随机令牌；不要将令牌放入前端代码、截图、URL、仓库或公开 issue。
- 数据库、导出、日志和备份可能包含用户内容，应存储在仓库外，限制访问并由使用者管理保留与删除。
- 在接入真实 AI 或执行工具前，需要完成权限范围、人工审批、隔离执行、审计脱敏、成本控制、数据接收方与保留策略设计。

## 私下报告漏洞

当前尚未发布正式仓库，也未设置公开安全邮箱；此文档不声称存在可用举报渠道。

正式仓库启用 GitHub private vulnerability reporting 后，请在 Security → Advisories 中使用 Report a vulnerability。若按钮不存在，请勿把漏洞细节、真实数据或令牌发到公共 issue。可仅提交「请提供私下安全联系渠道」的普通请求，不包含漏洞细节，等待维护者提供经过验证的私下渠道。

私下报告应包含受影响版本、最小虚构复现、影响和可选修复建议。仅测试你拥有或获得授权的环境；不要读取他人数据。令牌已泄漏时应先撤销/轮换，而不是仅删除帖子。

维护者发布前必须启用并验证私人报告渠道、指定处理责任人，并更新这里的支持范围。参考：[GitHub 官方私人漏洞报告设置](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)。
