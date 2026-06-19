# Roam

[English](README.md) ｜ **简体中文**

> **随时随地，回到你的开发机。**

**Roam** 是一个面向远程代码开发的工作空间。它让你在任何地方、任何时间，
用手机、平板或电脑连回自己的开发机，继续写代码、看日志、跑测试、调浏览器、
管理终端和监督 AI Agent。

你的代码、终端、浏览器、开发服务和 Agent 都运行在开发机上。设备只是入口：
出门时用手机看进度，路上用平板补充指令，回到桌面后用电脑继续接手，不需要
重新 SSH、重新开窗口、重新找上下文。

如果开发机上已经装了 [Claude Code](https://claude.ai/code)、Codex 或其他
coding agent，Roam 可以把它们变成可观察、可追加指令、可并行编排的工作单元。
你可以让多个 Agent 分别处理 API、前端、测试、文档，也可以用 **swarm** 把它们
串联成一个带目标、依赖、看板和消息流的协作系统，用来推进更复杂的开发任务。

命令行工具名为 **`ttmux`**。它把 tmux 变成远程开发和 Agent 编排的控制平面；
Web 控制台则把这些能力带到浏览器和移动设备上。

## 系统优势

- **随身开发**：手机、平板、电脑都能连接同一台开发机，查看终端、日志、任务和
  Agent 进度。
- **上下文不丢**：会话跑在开发机上，断网、关浏览器、换设备后仍可继续接回原来的
  工作现场。
- **长任务不断**：构建、测试、迁移、调试、爬日志和 Agent 执行都可以在后台持续
  运行。
- **Agent 更好用**：Claude Code、Codex 等工具可以被命名、分组、追踪、收集输出，
  也能随时追加指令。
- **swarm 串联复杂任务**：把一个大目标拆成多个成员，设置依赖关系，通过共享看板和
  广场消息流推进协作。
- **终端和 Web 一套能力**：CLI 适合脚本和自动化，Web 控制台适合远程查看、移动端
  操作和实时接管。
- **贴近真实开发机**：Roam 不发明新的运行环境，而是复用开发机上的 tmux、shell、
  Chrome、文件系统和现有开发工具。
- **可脚本化、可观测**：任务状态、日志、输出和 swarm 数据都可以被 CLI 或 JSON
  读取，方便人和 Agent 一起使用。

## 为什么需要它

远程开发在小任务里很简单，但一旦任务变复杂，就会遇到很多断点：

- 开发服务要一直跑着
- 测试、日志、构建需要多个终端
- 浏览器状态对复现问题很重要
- Agent 需要独立上下文和后续指令
- 长任务要能在你离线后继续执行
- 你需要快速知道现在到底哪些任务还在跑

Roam 把开发机作为唯一真实工作现场。服务器负责保持工作持续运行，`ttmux` 负责给
会话、任务、日志和 Agent 编排命名并提供状态，Web 控制台负责让你从任何设备接入。

## ttmux 是什么

tmux 是做并行工作的理想底座：

- 会话是 **隔离的执行环境**
- 输出可被 **程序化捕获**
- 一切皆可 **脚本化** 组合
- 零额外开销，只是进程和管道

`ttmux` 在 tmux 上补上更适合远程开发和 Agent 协作的控制层：会话管理、并行任务、
输出收集、多 Agent worker、swarm 编排，以及机器可读的 JSON 状态。

## 安装

```bash
# 一键安装
curl -fsSL https://raw.githubusercontent.com/ybz21/ttmux/main/install.sh | bash

# 或手动
cp ttmux ~/.local/bin/
chmod +x ~/.local/bin/ttmux
ttmux completion   # 安装 Tab 补全
```

完整指南（CLI + Web 控制台、配置、远程访问）见 **[docs/install/](docs/install/)**。

## 快速开始

```bash
ttmux new work        # 新建会话
ttmux ls              # 列出会话
ttmux a work          # 进入会话
ttmux kill work       # 关闭会话
```

## 任务编排

杀手级功能。把任何复杂任务拆成并行子任务：

```bash
# 起一个含 3 个并行 worker 的任务组
ttmux spawn ci \
  "lint"      "npm run lint" \
  "test"      "npm test" \
  "typecheck" "npx tsc --noEmit"

ttmux status ci          # 看进度
ttmux wait ci            # 等全部完成
ttmux collect ci --json  # 收集所有输出
ttmux group kill ci      # 清理
```

用 `--agent` 以同样方式起 Claude Agent：

```bash
ttmux spawn --agent refactor \
  "api"   "重构用户认证模块" \
  "db"    "优化数据库查询性能" \
  "tests" "补充单元测试" \
  --dir ~/project --perm auto

ttmux status refactor                 # 进度（命令 + Agent）
ttmux send refactor-api "加上 JWT"    # 给运行中的 Agent 追加指令
ttmux collect refactor                # 收集所有输出
```

也可从文件加载任务：

```bash
# tasks.txt —— 每行 "名字 命令"
# lint    npm run lint
# test    npm test
# build   npm run build

ttmux spawn --file release tasks.txt
```

## 命令

### 会话管理

| 命令 | 说明 |
|------|------|
| `ttmux ls [--json]` | 列出所有会话 |
| `ttmux new [name]` | 新建会话 |
| `ttmux a [name]` | 进入会话（不给名字则交互选择） |
| `ttmux d` | 脱离当前会话 |
| `ttmux kill [name]` | 关闭会话（需确认） |
| `ttmux killall` | 关闭所有会话 |
| `ttmux rename <old> <new>` | 重命名会话 |

### 任务编排

| 命令 | 说明 |
|------|------|
| `ttmux spawn <group> <n1> <c1> ...` | 起并行命令任务 |
| `ttmux spawn --agent <group> <n1> <task1> ...` | 起并行 Claude Agent |
| `ttmux spawn [--agent] --file <group> <file>` | 从任务文件起 |
| `ttmux status [group] [--json]` | 总览或某组状态（命令 + Agent） |
| `ttmux wait <group> [--timeout N]` | 等待某组完成 |
| `ttmux collect <group> [--json]` | 收集所有任务输出 |
| `ttmux send <session> <msg>` | 给任务/Agent 追加指令 |
| `ttmux group ls` | 列出所有任务组 |
| `ttmux group kill <name>` | 关闭组内所有任务 |
| `ttmux capture <session> [--lines N]` | 捕获 pane 输出 |

Agent 选项：`--dir <路径>` `--model <模型>` `--perm <模式>` `--max-turns <N>`。
旧别名 `agent spawn|status|send|collect|kill` 仍可用。

### 蜂群（swarm）

蜂群是一个**带目标的任务组**，有依赖门控、共享**看板**(kanban) 和**广场**(消息流)——还能被一个 `cc` 主控会话接管做自主监督。

| 命令 | 说明 |
|------|------|
| `ttmux swarm new <name> [--goal "..."] [--no-master]` | 建群（默认起一个 `cc` 主控） |
| `ttmux swarm add <swarm> <member> --type task\|agent ... <cmd/task>` | 加成员（`--depends-on a,b` 做门控） |
| `ttmux swarm ls [--json]` | 列出蜂群（目标 / 状态 / 主控） |
| `ttmux swarm status <swarm> [--json]` | 成员、依赖、待解锁 + 看板/广场摘要 |
| `ttmux swarm activate <swarm> [member] [--force]` | 解锁待定成员（`--force` 忽略依赖） |
| `ttmux swarm done <swarm> [member]` | 标记成员完成 + 级联解锁（不给成员 = 整群） |
| `ttmux swarm collect <swarm> [--json]` | 收集成员输出 |
| `ttmux swarm say / feed / watch <swarm> ...` | 广场：发言 / 读流 / 实时跟随 |
| `ttmux swarm board <swarm> [--json]` | 按列看板总览 |
| `ttmux swarm task <add\|ls\|show\|assign\|move\|done\|rm> <swarm> ...` | 管理看板卡片 |
| `ttmux swarm sql <swarm> [--json] "SELECT ..."` | 只读查询该群的 `swarm.db` |
| `ttmux swarm adopt <swarm> [--by <cc session>]` | 把蜂群交给一个 `cc` 主控 |
| `ttmux swarm archive\|rm <swarm>` | 归档 / 删除 |

```bash
ttmux swarm new login --goal "加登录功能"
ttmux swarm add login api --type agent "实现登录 API"
ttmux swarm adopt login                 # 让 cc 主控来监督
```

### 窗口与 Pane

| 命令 | 说明 |
|------|------|
| `ttmux nw [name]` | 新建窗口 |
| `ttmux lw` | 列出窗口 |
| `ttmux kw [id]` | 关闭窗口 |
| `ttmux sp [-h\|-v]` | 拆分 pane |
| `ttmux kp` | 关闭 pane |

### 杂项

| 命令 | 说明 |
|------|------|
| `ttmux send [session] <cmd>` | 给会话发命令 |
| `ttmux info` | 服务器信息 |
| `ttmux source` | 重载 tmux.conf |
| `ttmux completion` | 安装 Tab 补全 |

任何无法识别的命令都会直接转发给 `tmux`。

### 浏览器自动化 —— `chrome`

`chrome` 是**独立 CLI**（与 `ttmux` 平级，不是子命令），用 **Playwright**
（`connectOverCDP`）通过 CDP 驱动 Chrome，接的是 Web 控制台镜像的那台全局 Chrome
——**自动化能在「浏览器」标签里实时围观**。依赖很轻：`npm i playwright-core`
（不下载自带浏览器），`install.sh` 自动装好。

```bash
chrome goto https://example.com
chrome fill "#q" "hello" && chrome press "#q" Enter
chrome text h1
chrome eval "document.title"
chrome screenshot shot.png --full
```

动词：`goto / click / fill / type / press / text / html / attr / eval / wait /
screenshot / pdf / tabs / new / close`。选项 `--tab N` / `--url <子串>` 选标签页；
`--timeout <ms>`、`--cdp <地址>`。完整列表见 `chrome help`，源码见
[`cli/chrome-cli/`](cli/chrome-cli/)。

## 给 AI Agent 用

ttmux 设计上就是给 [Claude Code](https://claude.ai/code) 等 AI Agent 调用的。

### Claude Code Skill

```bash
# 安装 skill
mkdir -p ~/.claude/skills/cc-swarm
cp -r skills/cc-swarm/* ~/.claude/skills/cc-swarm/
```

`cc-swarm` skill 教 Claude Code 把目标拆成蜂群、按依赖门控成员、并通过看板 + 广场监督进度。

### JSON 模式

所有查询类命令都支持 `--json` 输出机器可读结果：

```bash
ttmux ls --json
ttmux status ci --json
ttmux collect ci --json
```

## Web 控制台

`ttmux-web` 是 Go(Gin) + React(Vite + Antd) 控制台——CLI 的薄封装（读 = 代理 `ttmux <cmd> --json`，写 = 调对应子命令）。覆盖 会话 / 任务 / 蜂群看板+广场 / Env，每个会话带实时 xterm.js 终端，状态走 SSE 流。

```bash
cp .env.example .env  # 设置口令 / 端口
./start-all.sh        # 构建前端 → 编译后端 → 启动（后台守护）
```

默认监听 `0.0.0.0:13579`（局域网可达）。配置走仓库根的 `.env`；完整安装、全部环境变量、远程访问见 **[docs/install/](docs/install/)**。后端内部细节见 [`backend/README.md`](backend/README.md)。

> ⚠ Web 控制台等于把 shell 执行能力搬上网。请用强 `TTMUX_WEB_PASSWORD`，
> 外网访问走隧道（Tailscale / Cloudflare），不要直接暴露端口。

## 工作原理

```
                    ttmux spawn build "lint" "npm run lint" "test" "npm test"
                                         │
                    ┌────────────────────┼────────────────────┐
                    ▼                    ▼                    ▼
             ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
             │ build-lint   │    │ build-test   │    │  (next...)  │
             │ tmux session │    │ tmux session │    │ tmux session│
             └──────┬───────┘    └──────┬───────┘    └─────────────┘
                    │ pipe-pane          │ pipe-pane
                    ▼                    ▼
             ~/.local/share/      ~/.local/share/
             ttmux/logs/          ttmux/logs/
             build-lint.log       build-test.log
```

- 每个任务 = 一个 detached tmux 会话
- 输出经 `pipe-pane` 自动落日志
- 组元数据存 `~/.local/share/ttmux/groups/`
- 状态从 tmux 格式串查询（`#{pane_dead}`、`#{pane_current_command}`）

## 文档

- [docs/install/](docs/install/) — 安装与部署
- [docs/design/](docs/design/) — 设计文档（蜂群编排 / 广场看板 / Web 接入）

## License

MIT
