# 02 · 后端设计（Go + Gin）

← 返回 [README](./README.md) ｜ 认证细节见 [03-auth-security](./03-auth-security.md)

## 1. 仓库布局与后端分层

**前端与后端分离**：前端是独立项目 `frontend/`（仓库根），后端 `backend/` 不包含前端源码。
后端从磁盘提供前端构建产物 `frontend/dist`（路径由 `-web` flag / `TTMUX_WEB_FRONTEND` 指定），
找不到时回退到后端自带的内嵌单页 `server/fallback.html`。

```
ttmux/
├── frontend/          React + Vite + Antd（独立项目，不在后端目录内）
│   └── dist/          vite 构建产物（后端从磁盘读取）
├── backend/           Go + Gin（module: ttmux-web）
│   ├── cmd/           入口、flag 解析（-addr / -web）
│   ├── server/        Gin 引擎、路由注册、中间件 + fallback.html（内嵌回退页）
│   ├── api/           各资源 handler（sessions/tasks/env；tasks 统一命令+Agent）
│   ├── ttmux/         CLI 封装层：exec + JSON 透传（唯一接触 shell 的地方）
│   ├── pty/           终端 PTY 桥接（tmux attach ↔ WebSocket，creack/pty）
│   ├── stream/        SSE 状态推送 + 日志 tail（WebSocket）
│   └── auth/          token 签发/校验、防爆破、认证中间件
└── start.sh --dev       构建前端 → 编译后端 → 启动（后端代理 frontend/dist）
```

**关键依赖**：`gin-gonic/gin`（路由）、`creack/pty`（PTY）、`gorilla/websocket`（WS）。

**配置**（环境变量 / 仓库根 `.env`）：
```
TTMUX_WEB_BIND=0.0.0.0:8080        # 监听地址（-addr 可覆盖）
TTMUX_WEB_PASSWORD=...             # 登录口令（默认值见 .env）
TTMUX_WEB_FRONTEND=.../frontend/dist  # 前端产物目录（-web 可覆盖；缺省自动探测）
TTMUX_BIN=.../ttmux                # ttmux 可执行文件
TTMUX_WEB_LOCK_AFTER=10            # 连续失败 N 次锁定
TTMUX_WEB_LOCK_SECS=30             # 锁定秒数
```
> 口令当前为明文比较（来自 `.env`）；argon2 哈希 + `web.toml` 持久化为后续增强（M4，见 [03](./03-auth-security.md)）。

## 2. CLI 封装层（关键）

所有对 ttmux 的调用集中在 `ttmux/` 包，**唯一接触子进程的地方**：

```go
// 读：解析 --json
func (c *Client) Status(group string) (*StatusResult, error) {
    out, err := c.run("status", group, "--json")   // exec.Command，参数独立传入
    ...
}
// 写：调用对应子命令，永不拼接 shell 字符串
func (c *Client) Spawn(group string, tasks []Task) error { ... }
```

- 所有用户输入作为 `exec.Command` 的**独立参数**传入，杜绝命令注入。
- 只允许**白名单子命令**（ls/new/kill/send/capture/spawn/group/status/collect/agent/env/info）。
- `--json` 缺失的子命令需先在 CLI 侧补齐（见 [06-roadmap](./06-roadmap.md) 开放问题）。

## 3. REST API

统一前缀 `/api`，JSON 响应，非 `login` 路由均经 Gin auth 中间件。

### 3.1 Sessions
| Method | Path | 底层 |
|---|---|---|
| GET | `/api/sessions` | `ttmux ls --json` |
| POST | `/api/sessions` `{name}` | `ttmux new <name>` |
| DELETE | `/api/sessions/:name` | `ttmux kill <name>` |
| POST | `/api/sessions/:name/send` `{cmd}` | `ttmux send <name> <cmd>` |
| GET | `/api/sessions/:name/capture?lines=N` | `ttmux capture <name> --lines N` |

### 3.2 Tasks（命令 + Agent 统一）
> ⭐ ttmux v0.4 起命令任务与 Agent 任务统一为一个模型（每个任务带 `type: cmd|agent`），
> 后端对应**一套 `/api/tasks` 端点**，由请求体 `type` 区分创建方式。
> `status`/`collect` 的 `--json` 已含每个任务的 `type` 与 `task`（描述）字段。

| Method | Path | 底层 |
|---|---|---|
| GET | `/api/tasks` | `ttmux group ls` |
| GET | `/api/tasks/:g` | `ttmux status <g> --json`（返回每任务 `type/status/exit_code/task`） |
| POST | `/api/tasks` `{group, type:"cmd", tasks:[{name,cmd}]}` | `ttmux spawn <g> ...` |
| POST | `/api/tasks` `{group, type:"agent", tasks:[{name,task}], dir?, model?, perm?, maxTurns?}` | `ttmux spawn --agent <g> ...` |
| POST | `/api/tasks/:g/:sess/send` `{msg}` | `ttmux send <sess> <msg>`（命令/Agent 通用） |
| GET | `/api/tasks/:g/collect` | `ttmux collect <g> --json`（含 `type/prompt/output`） |
| DELETE | `/api/tasks/:g` | `ttmux group kill <g>`（Agent 任务自动先 `/exit`） |

> **向后兼容**：如需保留 `/api/groups`、`/api/agents` 旧路径，可作为 `/api/tasks` 的别名映射
> （与 CLI 保留 `agent *` 别名一致），但前端统一只用 `/api/tasks`。

### 3.3 Env
| Method | Path | 底层 |
|---|---|---|
| GET | `/api/env` | `ttmux env` |
| PUT | `/api/env` `{key,value}` | `ttmux env set K=V` |
| DELETE | `/api/env/:key` | `ttmux env rm K` |
| POST | `/api/env/push` | `ttmux env push` |

### 3.4 实时通道
| 协议 | Path | 说明 |
|---|---|---|
| SSE | `/api/stream/status` | 全局状态变化推送 |
| WS | `/api/term/:name` | session 终端双向桥接 |
| WS | `/api/logs/:name` | 日志 `tail -f` 流 |

### 3.5 认证（详见 [03-auth-security](./03-auth-security.md)）
| Method | Path | 说明 |
|---|---|---|
| POST | `/api/login` `{password}` | 校验 → 设置 Cookie |
| POST | `/api/logout` | 清 Cookie + 吊销 |
| GET | `/api/me` | 当前会话信息 / 探活 |

### 3.6 统一响应约定
```json
// 成功
{ "data": { ... } }
// 失败
{ "error": { "code": "GROUP_NOT_FOUND", "message": "..." } }
```
状态码：200 成功 / 400 入参错 / 401 未认证 / 404 不存在 / 429 限流 / 500 CLI 执行失败。

## 4. 实时通道实现

- **SSE 状态推送**：后端单 goroutine 每 1–2s 跑一次 `ttmux status --json`，与上次快照 diff，
  有变化才广播给所有订阅者（fan-out channel），避免前端高频轮询。
- **终端 WS**：握手鉴权通过后 `pty.Start("tmux","attach","-t",sess)`，PTY ↔ WS 字节双向桥接；
  前端 resize 通过 WS 控制消息（JSON `{type:"resize",cols,rows}`）同步 PTY 窗口大小。
- **日志 WS**：流式读取 `~/.local/share/ttmux/logs/<sess>.log`（tail -f 语义），支持断点续传 offset。

## 5. 前端资源托管

- 后端从**磁盘**提供 `frontend/dist`（`-web <dir>` flag 或 `TTMUX_WEB_FRONTEND` 指定，缺省自动探测）：
  `/assets/*` 走 `r.Static`，`/` 与未命中 `/api` 的路由回退到 `dist/index.html`（SPA history 路由）。
- 找不到 `frontend/dist` 时回退到后端内嵌的 `server/fallback.html`（一个自包含的极简控制台）。
- 前后端分离：前端是独立项目，不放在后端目录内（不用 `go:embed` 跨目录引用）。
- 开发期：Vite dev server（`:5173`）通过 proxy 把 `/api`（含 WebSocket）转发到 Gin（`:8080`）。

> 安全相关（认证中间件、防爆破、CSRF、命令注入防护、远程暴露）集中在 [03-auth-security](./03-auth-security.md)。
