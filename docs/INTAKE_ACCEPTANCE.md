# 接收性能验收（按需运行）

此客户端只使用 Node 内置 API，不依赖浏览器或所有者账号。不会在 CI、构建或服务启动时自动运行。默认仅请求一次健康检查，不创建访客会话，也不代表已经完成性能验收：

```sh
node scripts/verify-intake.mjs --base https://dot.075900.vip
```

需要已有明确授权才可启用写入。下列命令中的部署版本必须替换为实际准备验证的完整版本号；客户端先检查 `/health`，版本不符时停止。三个开关不会自行提供授权。

```sh
node scripts/verify-intake.mjs --base https://dot.075900.vip \
  --allow-writes --authorized-remote --expected-release EXACT_DEPLOYED_REVISION \
  --out intake-public-results.json
```

在网站服务器上验证回环接收开销时，将端口替换为实际监听端口，并保留服务要求的公开 Origin：

```sh
node scripts/verify-intake.mjs --base http://127.0.0.1:VERIFIED_PORT \
  --origin https://dot.075900.vip --allow-writes --authorized-remote \
  --expected-release EXACT_DEPLOYED_REVISION --out intake-loopback-results.json
```

写入范围固定为 10 个访客、有限冷/热轮次，不运行 AI、注册账号、使用所有者凭据、重启、上传或删除数据。合成测试记录带明显标记，并保留在网站中；中途失败的记录同样保留。结果文件不保存 Cookie 或 CSRF。

每次写入测试会创建 10 个访客会话并进行约 100 次写请求。部署的 15 分钟限流窗口只允许每 IP 12 个新访客会话、120 次写入；已有流量也占用额度。不要从同一 IP 紧接着运行公网和回环写入测试；遇到 429 或其他失败应停止，不绕过限流。远程目标仅允许精确的 `https://dot.075900.vip`，拒绝跳转及其他远端。

报告区分客户端确认时延和服务端 `Server-Timing` 接收耗时，后者缺失时显示未知，不将客户端网络时延伪装成服务端处理时间。本地单元测试通过不代表线上 10 用户验收通过。
