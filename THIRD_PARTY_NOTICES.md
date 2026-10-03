# GPT-DOT-WORK 第三方组件与素材清单

本文件是审查清单，不是本项目许可证，也不替代各组件完整许可文本。盘点日期：2026-10-03；发布前必须针对最终文件再次核对。

## 当前盘点

- 根目录及 backend/package.json 未声明第三方 npm 依赖；JavaScript 运行时代码使用本地模块和 Node 内置模块。
- Node.js 为外部安装的运行时，未随源码打包。其发行版包含自己的许可与第三方声明：[Node.js LICENSE](https://github.com/nodejs/node/blob/main/LICENSE)。若以后分发运行时/容器，应检查该具体版本的完整声明。
- 可选浏览器测试导入 Python Playwright；该工具未打包进入前端产物。[Playwright Python 官方 LICENSE](https://github.com/microsoft/playwright-python/blob/main/LICENSE) 为 Apache-2.0。Chromium/浏览器也由开发者另行安装；分发二进制时需要额外检查其完整第三方声明。
- CI 使用 actions/checkout 和 actions/setup-node（固定提交）；工具仅在 CI 环境执行。对应许可证见 [checkout](https://github.com/actions/checkout/blob/main/LICENSE) 和 [setup-node](https://github.com/actions/setup-node/blob/main/LICENSE)。
- CSS 仅引用系统字体候选名称，没有提交字体文件或在线字体下载；这不授予任何字体文件的再分发权。
- 当前 UI 使用内联 SVG、CSS 与 Unicode 字符；未发现下载的照片、插画、外部图标包、商标图或字体文件。实现者确认内联 SVG 由本原型直接编写，未从下载的图标包复制；简单几何形状可能自然相似，此记录不声称排他原创权。
- 演示文案/笔记在源码中为通用虚构内容；发布者仍需确认其对代码与设计拥有所需权利。

## 新增组件时

记录名称、固定版本、官方来源、SPDX 许可标识、是否随产物分发、版权声明/NOTICE 要求和源码提供义务。保留要求的完整文本；不确定的兼容性或权利归属应在发布前解决。

项目自身采用 [MIT 许可证](LICENSE)，Copyright (c) 2026 zhuowenji。第三方各自的许可与 NOTICE 要求不受影响，参见 [发布门槛](docs/OPEN_SOURCE_RELEASE.md)。

## 本次任务聊天页面

仅纳入所提供页面的根 HTML、CSS 和经安全适配的原生 JavaScript。上传包中的 React office 源码、编译 bundle、工具目录及 LAN Agent 接入说明未纳入本项目发布内容；没有再分发 React office bundle。页面来源由项目所有者提供，仍需维护者对其分发权负责。
