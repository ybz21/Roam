# ttmux Web 控制台 — 设计文档

> 给 ttmux 加一个 **响应式 Web 控制台**，在 **手机 / 平板 / 电脑** 三端统一适配，
> 让你能远程 **查看**（sessions / groups / agents / 日志 / 终端）并 **操控**
> （spawn、send、kill、env、批准 agent）。
>
> 状态：设计草案 v0.3 — 未实现。

## 文档导航

| # | 文档 | 内容 |
|---|---|---|
| 1 | [01-overview.md](./01-overview.md) | **总体设计** — 背景、目标、三端适配策略、技术选型、系统架构 |
| 2 | [02-backend.md](./02-backend.md) | **后端设计** — Go 分层、CLI 薄封装、REST API、实时通道 |
| 3 | [03-auth-security.md](./03-auth-security.md) | **认证与安全** — 登录流程、Token、防爆破/CSRF、远程暴露策略 |
| 4 | [04-frontend.md](./04-frontend.md) | **前端设计** — 前端架构、响应式布局系统、设计语言、状态数据流 |
| 5 | [05-pages.md](./05-pages.md) | **逐页面设计** — 10 个页面的三端布局与线框 |
| 6 | [06-roadmap.md](./06-roadmap.md) | **落地计划** — 里程碑、开放问题 |
| 7 | [07-worktree.md](./07-worktree.md) | **Worktree 管理** — 命名创建、管理抽屉、对比 base、合并收尾、并行竞赛 |
| 8 | [08-project.md](./08-project.md) | **项目概念** — 仓库即项目、composer 开干、任务=会话∪孤儿 worktree、待收尾一等 |
| 9 | [09-swarm-in-project.md](./09-swarm-in-project.md) | **蜂群×项目创建动线** — 表单产出上下文不产出结构、开场白注入班子建议与 worktree 约定 |

## 实现状态

已落地并可运行（前后端分离）：
- 前端 [`../../../frontend/`](../../../frontend/) — React + Vite + Antd 三端响应式 SPA，含 xterm.js 终端。
- 后端 [`../../../backend/`](../../../backend/README.md) — Go + Gin，按包分层（cmd/server/api/ttmux/pty/stream/auth）。
- 仓库根 `./start.sh --dev` 一键：构建前端 → 编译后端 → 启动（后端从磁盘代理 `frontend/dist`）。

详见 [06-roadmap](./06-roadmap.md)。

## 一句话方案

Web 后端做成 **ttmux CLI 的薄封装**：读 = 调 `ttmux <cmd> --json` 解析，写 = 调对应子命令。
不重写任何编排逻辑，保证 Web 与 CLI 行为永远一致。前端是 **一套响应式 SPA**，
靠单个 `AppShell` 组件按断点切换三端布局，而非做三个独立 App。

## 核心原则

- **薄封装**：后端不重实现编排逻辑，全部转发给 ttmux CLI。
- **一套代码三端适配**：移动优先 + 渐进增强，宽屏把"详情页"从覆盖层升级为并排栏。
- **认证不可妥协**：Web 等于把 shell 执行能力搬上网，强制登录 + 不裸暴露公网。
