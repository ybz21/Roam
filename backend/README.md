# ttmux-web — Web 控制台后端（Go + Gin）

ttmux 的 Web 控制台后端，是 ttmux CLI 的薄封装：读 = 调 `ttmux <cmd> --json` 透传；写 = 调对应子命令。
前端是独立项目 [`../frontend/`](../frontend/)（React + Vite + Antd），**不在本目录内**；后端从磁盘代理其
构建产物 `frontend/dist`。完整设计见 [`../docs/design/web/`](../docs/design/web/)。

## 快速开始

```bash
# 在仓库根目录（构建前端 → 编译后端 → 启动）
./start-all.sh
```

配置走仓库根目录的 **`.env`**（见 `.env.example`），真实环境变量优先于 `.env`：
```
TTMUX_WEB_PASSWORD=BladeAI2026!!   # 登录口令（默认值）
TTMUX_WEB_BIND=0.0.0.0:8080        # 监听地址（默认监听所有网卡，手机同 WiFi 可访问）
```
> ⚠ 默认监听 `0.0.0.0`，局域网内任何设备可访问——请使用强口令；外网访问走 Tailscale / Cloudflare Tunnel，不要直开公网端口。

手动运行（flag 覆盖 env）：
```bash
cd backend && go build -o ttmux-web ./cmd
TTMUX_BIN=../ttmux TTMUX_WEB_PASSWORD=secret ./ttmux-web -addr 127.0.0.1:8080 -web ../frontend/dist
```

## 已实现

- **认证**：口令登录 → HMAC 签名 Cookie（HttpOnly/SameSite=Strict）+ 失败退避/锁定（可配 `TTMUX_WEB_LOCK_AFTER/SECS`）。
- **API**（`/api`，均需认证）：
  - `sessions`：列出 / 关闭 / capture
  - `tasks`：列出 / 状态 / 收集 / 创建（命令 & Agent 统一）/ 清理 / 追加指令(send)
  - `env`：列出 / 设置 / 删除 / 推送；`info`
  - **`term/:name`（WebSocket）**：桥接 `tmux attach`，每个会话 = 实时命令行
  - **`stream/status`（SSE）**：定期推送 tasks+sessions 快照；**`logs/:name`（WS）**：日志 `tail -f`
- **前端**：[`../frontend/`](../frontend/) React + Vite + Antd SPA，三端响应式（见 `docs/design/web/01-overview.md`），
  覆盖 概览 / 任务 / 会话 / Env；创建任务（选类型）、收集、追加指令、清理；
  **每个会话/任务可进 xterm.js 终端**（手机带快捷键栏 Enter/Esc/^C/Tab/↑/↓）。
  后端从磁盘读取 `frontend/dist`；找不到时回退到内嵌的 `server/fallback.html`。

## 结构（按职责分包）

```
backend/                module: ttmux-web
├── cmd/main.go         入口、flag 解析（-addr / -web）、配置组装
├── server/             Gin 引擎、路由注册、中间件 + fallback.html（内嵌回退页）
├── api/                各资源 handler（sessions/tasks/env/info）
├── ttmux/              CLI 封装层（唯一接触 shell 的地方）
├── auth/               token 签发/校验、防爆破、认证中间件
├── pty/                终端 PTY 桥接（tmux attach ↔ WebSocket）
└── stream/             SSE 状态推送 + 日志 tail（WebSocket）
```

## 路线图（TODO）

- **实时**：前端接入 SSE/日志 WS（后端已就绪），替换当前 3s 轮询。
- **认证增强**：argon2 口令哈希、TOTP / Passkey。
- **终端**：多终端分屏 / 标签、断线自动重连。

## 开发模式（前后端分离热更新）

```bash
cd backend && TTMUX_BIN=../ttmux TTMUX_WEB_PASSWORD=dev go run ./cmd   # 后端 :8080
cd frontend && npm run dev                                            # 前端 :5173（代理 /api 含 WS 到 :8080）
```
