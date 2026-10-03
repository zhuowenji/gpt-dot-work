# 验证记录

日期：2026-10-03 UTC。环境：Node.js 24.19.0，Linux。

## 已通过

- 根目录 `npm run check`：21 项自动化测试通过（5 前端模型 + 16 后台），语法检查与静态构建成功。
- `npm --prefix backend run check`：后台模块语法检查与 16 项测试成功。
- 后台覆盖：草稿不入队、显式提交、幂等键冲突、8 个独立进程原子竞抢、默认执行器阻塞、demo 固定处理器、自由文本不执行、取消与租约围栏、失败重试、租约失效、审批不可绕过/过期审批拒绝、持久化、分页、API 鉴权、错误输入。
- `dist/preview.html` 静态验证：CSS 与 JS 内联，无外部脚本/样式引用或模块导入；提取内联脚本后 `node --check` 通过。
- `tests/browser_smoke.py` Python 语法检查通过。
- CI YAML 语法检查通过。工作流固定官方 actions 提交，权限只读，无部署或上传步骤。

## 未完成

- 实际浏览器 UI 回归与桌面/手机截图：执行环境阻止 Chromium 启动；云浏览器无法访问该本地服务。**没有视觉验收截图，不宣称浏览器流程测试通过。**
- GitHub 托管 CI：尚未推送/运行；本地测试通过不能代替托管 CI。
- 公网部署、TLS、用户登录/隔离、正式 AI 适配器、安全审计：未进行。

## 复验

先启动 `npm run dev`。在具备 Python Playwright 和 Chromium 的本地环境执行：

```sh
python tests/browser_smoke.py
```

该脚本会检查桌面/手机导航、笔记搜索、新建/编辑/持久化、HTML 转义、关闭弹窗、任务状态、需求草稿/确认/阻塞/取消和 JSON 导出。成功后再对截图做人工视觉复核。默认截图输出 `/tmp/gpt-dot-work-review`；可用 `SCREENSHOT_DIR` 改到仓库外目录。
