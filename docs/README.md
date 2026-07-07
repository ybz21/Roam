# Roam 文档

> **Code anywhere, anytime.** — 品牌名 **Roam**，命令行工具名 `ttmux`。

| 目录 | 内容 |
|------|------|
| [install/](./install/) | **安装与部署** — CLI 一键/源码安装、Web 控制台启动、`.env` 配置、远程访问、故障排查 |
| [design/](./design/) | **设计文档** — 蜂群编排 / 广场看板 / Web 接入，及 Web 控制台逐模块设计与线框 |

## design/ 速览

- [蜂群编排设计](./design/蜂群编排设计.md) — swarm / member / master / 依赖门控
- [蜂群广场与看板设计](./design/蜂群广场与看板设计.md) — Plaza（消息流）+ Board（看板）
- [蜂群广场监听循环设计](./design/蜂群广场监听循环设计.md) — master/worker 持续监听 human 指令与广场消息
- [蜂群 Web 接入设计](./design/蜂群%20Web%20接入设计.md) — 蜂群在 Web 端的映射
- [蜂群成员启动与提示词模板设计](./design/蜂群成员启动与提示词模板设计.md) — claude/codex 引擎 · master/worker 角色 · 提示词模板（Go text/template）
- [蜂群成员角色模型设计](./design/蜂群成员角色模型设计.md) — 细分角色(产品/工程/测试…) + 职责 · 底层/界面/prompt/leader 全链路
- [插件机制设计](./design/plugin/README.md) — 插件机制:调研 / 产品 / 架构(plugind) / manifest / 平台 API / 安全 / 路线图 / 开发指南
- [智能评审插件设计](./design/智能评审插件设计.md) — Codex + Claude 互审、finding、裁决与 swarm 质量闭环
- [web/](./design/web/) — Web 控制台完整设计（总览 / 后端 / 认证 / 前端 / 逐页面 / 路线图）
- [mockups/](./design/mockups/) — 静态原型

## 相关

- 根 [README](../README.md) ｜ [README.zh-CN](../README.zh-CN.md)
- CLI 源码说明 [`cli/ttmux-cli/README.md`](../cli/ttmux-cli/README.md) — `ttmux` 主命令
- 浏览器自动化 CLI [`cli/chrome-cli/README.md`](../cli/chrome-cli/README.md) — `chrome`（Playwright over CDP）
- Web 后端说明 [`backend/README.md`](../backend/README.md)
