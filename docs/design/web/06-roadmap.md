# 06 · 落地计划与开放问题

← 返回 [README](./README.md)

## 1. 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| **M0 — 脚手架** | 前后端分离工程（`frontend/` + `backend/`）+ `start-all.sh` 一键启动 | ✅ 已完成 |
| **M1 — 看 + 控** | **认证**（登录/Cookie/防爆破）+ sessions/tasks/env/info + 创建/收集/send/kill（调 `--json`） | ✅ 已完成 |
| **M1.5 — React SPA** | React+Vite+Antd 三端响应式 `AppShell`（手机底部 Tab / 平板可收起 Sider / 电脑常驻 Sider）；后端从磁盘代理 `frontend/dist` | ✅ 已完成 |
| **M3 — 终端** | xterm.js + PTY 桥接（`creack/pty` + `gorilla/websocket`，`tmux attach`）+ 手机快捷键栏 | ✅ 已完成（多终端分屏/重连待补） |
| **M2 — 实时** | SSE 状态推送（`/api/stream/status`）+ 日志 WS（`/api/logs/:name`）已就绪；前端接入替换 3s 轮询 | 🟡 后端完成，前端待接入 |
| **M4 — 打磨** | 断线重连、审计日志、argon2、Tunnel 部署文档；（v2）TOTP/Passkey | ⬜ |

> 可运行实现：前端 [`../../../frontend/`](../../../frontend/)，后端 [`../../../backend/`](../../../backend/README.md)。
> 前后端分离，后端从磁盘代理 `frontend/dist`；找不到时回退到后端内嵌的 `server/fallback.html`。

## 2. 前置依赖（已清零）

ttmux CLI 的 `--json` 覆盖（薄封装的前提）现已齐全：
- ✅ `ls --json`、`status --json`（含 `type/status/exit_code/task`）、`collect --json`（含 `type/prompt/output`）；
  `agent status/collect --json` 为同一统一输出的别名。
- ✅ `env --json`、`group ls --json`、`info --json`（ttmux v0.4 新增）。

*（ttmux v0.4 命令任务与 Agent 任务已统一为一个模型，见根仓库 ttmux 脚本与 [05-pages P3](./05-pages.md)。）*

## 3. 开放问题

1. **终端实现**：自建 PTY 桥接（`creack/pty`，整合度高）vs 集成 `ttyd`（出原型最快，但两套东西割裂）。**倾向自建**。
2. **远程方案**：Tailscale / Cloudflare Tunnel / 反代 + HTTPS —— 偏好哪个？影响部署文档。
3. **多端同时 attach**：同一 session 多端 attach 的体验（tmux 默认共享窗口大小，需确认是否要独立 size）。
4. **状态管理库**：Zustand（轻）vs Redux Toolkit（重但规范）—— 倾向 Zustand。
5. **是否引入 react-query**：缓存/重试 vs 复杂度，与 SSE 增量更新如何配合。

## 4. 已定技术栈

- **前端**：React + Vite + TypeScript + **Ant Design**，xterm.js 终端。
- **后端**：**Go + Gin**（`backend/`，module `ttmux-web`），按包分层；从磁盘代理 `frontend/dist`。
- **实时**：SSE（状态）+ WebSocket（终端/日志）。
- **认证**：argon2 哈希 + HttpOnly/Secure/SameSite Cookie + 签名 token。
- **远程**：默认绑 127.0.0.1，走 Tailscale/Cloudflare Tunnel。
