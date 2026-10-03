# 私有单用户部署准备

这是可部署候选实现，不是已通过安全审计的生产服务。尚未在目标服务器部署或验证 TLS、浏览器流程、备份恢复和既有应用共存。真实 AI 执行默认禁用。

## 接入现有自动部署机制

如果服务器已有 Git 自动拉取/构建脚本，**只把本项目接入已有机制**，不要另外新增 cron、webhook 或第二套发布流程。仓库里的 `deploy/prepare-release.sh` 是检查/构建 hook，不会拉取 Git、选择分支、重启服务或改代理。

先由有权限的管理员确认：

- 当前触发方式、脚本内容、允许分支、Git 身份/凭据保存方式
- 现有应用根目录、监听端口、运行用户、进程管理方式和 nginx/Caddy 配置
- 新项目专属目录与域名、证书来源、数据/备份路径及权限
- 旧发布保留和失败回滚办法；现有应用的基准健康检查

推荐现有脚本的阶段：

1. 拉取并验证**明确允许的分支和提交**，构建独立 release 目录。禁止强制覆盖已有应用目录。
2. 调用 `sh deploy/prepare-release.sh`；所有检查失败即停止，不切换流量。
3. 保留当前 release 指针及配置，创建一致性 SQLite 备份。数据库不在 release 目录内。
4. 在既有进程管理机制中切换新 release，传入 `WORKSPACE_RELEASE=<提交SHA>`，只重启本项目进程。
5. 在本机和 HTTPS 域名检查 `/health` 的 release ID，并检查登录页与会话 API。再检查旧应用仍正常。
6. 任一健康检查失败，恢复旧 release 指针和旧进程配置。不要盲目回滚数据库；先判断是否存在不兼容迁移，必要时暂停服务并执行经过演练的数据恢复。

此仓库不执行上述主机操作；实际脚本需要根据已有机制适配。`deploy/gpt-dot-work.service` 仅为没有适用现有进程配置时的**可选运行服务模板**，不是新增的部署自动化。已有 supervisor/systemd 容器方式可继续使用。

## 运行模型

- Node.js 24+，单个服务进程提供同源页面、owner 登录、持久工作空间 API 和任务 worker。
- SQLite 仅用于单主机、本地持久磁盘，不支持把数据库放 NFS 或多机共享。
- Node 仅监听 `127.0.0.1:4318`，HTTPS 由既有反向代理终止。不要将该端口公开。
- 数据目录示例 `/var/lib/gpt-dot-work`，源码示例 `/srv/gpt-dot-work/current`，秘密配置示例 `/etc/gpt-dot-work/service.env`，三者分开。
- 静态构建只能包含公开源码/示例；真实数据、密码 hash、session 数据库、备份均不得进 Git 或 dist。

`deploy/service.env.example` 是空秘密模板。生产关键项：

```text
NODE_ENV=production
WORKSPACE_OWNER_PASSWORD_HASH=<管理员在可信终端生成的 scrypt hash>
WORKSPACE_PUBLIC_ORIGIN=https://workspace.example.com
WORKSPACE_DB_PATH=/var/lib/gpt-dot-work/tasks.sqlite
WORKSPACE_STATIC_DIR=/srv/gpt-dot-work/current/dist
WORKSPACE_RUNTIME=disabled
```

密码 hash 也是敏感认证配置，放到受保护的配置文件；不要放命令行参数、聊天、提交记录、公开日志或截图。`backend/README.md` 给出本地密码 hash 工具与配置方式。不要使用示例密码。应用浏览器登录不需要 bearer API/审批 token。

会话使用 HttpOnly、SameSite、生产 Secure cookie，CSRF token 只留页面内存。状态写入必须提供正确 origin 与 CSRF。`WORKSPACE_PUBLIC_ORIGIN` 必须与外部 HTTPS origin 完全一致。不能为了排错关闭这些检查。

## 反向代理与旧应用隔离

优先沿用服务器现有 nginx。`deploy/nginx.conf.example` 只示范新增**独立域名的 server block**，不使用 `default_server`，也不覆盖旧系统的 location/root。必须先审阅现有配置、确认端口/域名不冲突和证书已获授权准备好，再由管理员验证 `nginx -t`、重载，并复查旧应用。

若服务器本来使用 Caddy，可参考 `deploy/Caddyfile.example`。不要为本项目另装/替换现有代理。Caddy 自动 HTTPS 会涉及证书申请与网络条件；这些必须由管理员确认。

模板使用保留示例域名，不能直接上线。当前没有验证目标主机的发行版、Node 路径、systemd、代理配置或证书。

官方参考：[nginx 代理模块](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)、[nginx HTTPS 配置](https://nginx.org/en/docs/http/configuring_https_servers.html)、[Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)、[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)。

## 备份与恢复

`node scripts/backup.mjs /absolute/tasks.sqlite /absolute/private-backups/new-snapshot.sqlite` 使用 SQLite 在线备份 API，不是简单复制正在写入的 `.sqlite` 文件。目标目录必须由当前运行用户拥有且权限为 0700，目标文件必须不存在，且位于仓库外。工具生成 0600 文件、执行 quick_check，并输出 SHA256。它不会自动上传、加密、排期、覆盖或删除备份。

备份包含私人内容和认证会话数据，必须加密保护并设置访问/保留策略。不要附到公开 issue。现有备份机制可以调用此工具；建立任何新定时或外部备份接收方前需要明确授权。

恢复由管理员在维护窗口完成：

1. 停止本项目的 API 和所有 worker，保存当前数据库的一致性快照。
2. 校验备份 SHA256 与 SQLite integrity/quick_check。先恢复到**新的隔离路径**，不要覆盖原数据。
3. 用本版本提供的 session 撤销工具清空恢复库中的 owner session；必要时更新密码 hash。恢复的历史会话不能重新生效。
4. 确认文件拥有者/目录访问权限，令 `WORKSPACE_DB_PATH` 指向新库，再启动旧或目标兼容 release。
5. 验证登录、笔记与任务读取，确认 AI 保持禁用；旧库保留到用户确认恢复正确。

每次升级前应演练恢复；当前单元测试覆盖备份一致性和权限约束，不代替真实主机灾难恢复演练。SQLite API 参考：[Node.js SQLite backup](https://nodejs.org/download/release/v24.8.0/docs/api/sqlite.html#sqlitebackupsource-db-path-options)。

## 上线验收边界

自动化测试通过只说明覆盖到的代码行为。正式使用前仍需验证实际 TLS/域名、cookie 和浏览器登录、过期/退出、双页面写入冲突、移动端、代理限速、磁盘容量、日志脱敏、备份恢复和现有应用不受影响。没有 MFA、多用户隔离或完整渗透测试。暂不建议放高敏感生产数据。

## Alibaba Cloud Linux 3 / RHEL 8 系运行兼容性

Node.js 24 的官方 Linux x64 基线为 kernel ≥4.18、glibc ≥2.28，以及 libstdc++ ≥6.0.25（GLIBCXX_3.4.25）。Alibaba Cloud Linux 3 官方默认 kernel 5.10、glibc 2.32、GCC 10.2，通常满足官方预编译二进制运行基线；这不是对任意现有实例的实测保证。

管理员先只读查看 `node -v`、`command -v node`、`uname -r`、`getconf GNU_LIBC_VERSION`。若未具备 Node24，先确认既有部署脚本管理运行时的方式，再批准使用官方发行包/已采用的可信版本管理器安装独立版本。不要为了本项目替换旧应用的系统 Node、升级全部系统包或调整防火墙。服务配置应使用验证过的 Node 绝对路径；非交互 systemd 不会自动读取交互 shell 的 nvm 配置。

本应用没有本机扩展 npm 依赖，不需要在服务器编译 Node 或升级 GCC。使用官方二进制仍应校验官方发布的校验和/签名，并在启用前运行本项目检查。模板 systemd 指令需要目标机 `systemd-analyze verify`，nginx 模板需要实际证书路径与 `nginx -t`；本制作环境不能替代这些验证。

参考：[Node24 官方平台/二进制要求](https://raw.githubusercontent.com/nodejs/node/v24.x/BUILDING.md)、[Alibaba Cloud Linux 官方环境说明](https://www.alibabacloud.com/help/en/ecs/user-guide/alibaba-cloud-linux)。

会话“空闲”按服务端收到的 HTTP 请求计时，不是检测人的键盘/鼠标活动；可见页面的状态轮询可能延长空闲计时，绝对会话到期仍独立生效。离开共享设备时应退出登录并锁屏。代理后的应用可能将所有来源视为同一个回环地址，登录限速因此可能在连续失败后暂时阻止 owner 登录；需要在实际代理上验证限速体验，不应直接信任任意 X-Forwarded-For 绕过限制。
