# Roam

**English** ｜ [简体中文](README.zh-CN.md)

> **Code anywhere, anytime.**
> Orchestrate a swarm of coding agents from your terminal — or your phone.

**Roam** wraps tmux with a friendlier interface and adds first-class support for **parallel task execution**, **output capture**, **multi-agent orchestration**, and a **swarm** layer with a shared board + plaza — all reachable from the terminal or a **remote web console**. The command-line tool is **`ttmux`**.

## Why

tmux is the perfect substrate for parallel work:

- Sessions are **isolated execution environments**
- Output is **capturable** programmatically
- Everything is **scriptable** and composable
- Zero overhead — just processes and pipes

ttmux makes these capabilities accessible to both humans and AI agents.

## Install

```bash
# One-liner
curl -fsSL https://raw.githubusercontent.com/ybz21/ttmux/main/install.sh | bash

# Or manual
cp ttmux ~/.local/bin/
chmod +x ~/.local/bin/ttmux
ttmux completion   # install tab completion
```

Full guide (CLI + Web console, config, remote access): **[docs/install/](docs/install/)**.

## Quick Start

```bash
ttmux new work        # create a session
ttmux ls              # list sessions
ttmux a work          # attach
ttmux kill work       # kill session
```

## Task Orchestration

The killer feature. Split any complex task into parallel subtasks:

```bash
# Spawn a task group with 3 parallel workers
ttmux spawn ci \
  "lint"      "npm run lint" \
  "test"      "npm test" \
  "typecheck" "npx tsc --noEmit"

# Monitor progress
ttmux status ci

# Wait for all to complete
ttmux wait ci

# Collect all outputs
ttmux collect ci --json

# Clean up
ttmux group kill ci
```

Spawn Claude agents the same way with `--agent`:

```bash
ttmux spawn --agent refactor \
  "api"   "重构用户认证模块" \
  "db"    "优化数据库查询性能" \
  "tests" "补充单元测试" \
  --dir ~/project --perm auto

ttmux status refactor                 # progress (commands + agents)
ttmux send refactor-api "加上 JWT"    # send a follow-up to a running agent
ttmux collect refactor                # gather all outputs
```

Or load tasks from a file:

```bash
# tasks.txt — one "name command" per line
# lint    npm run lint
# test    npm test
# build   npm run build

ttmux spawn --file release tasks.txt
```

## Commands

### Session Management

| Command | Description |
|---------|-------------|
| `ttmux ls [--json]` | List all sessions |
| `ttmux new [name]` | Create session |
| `ttmux a [name]` | Attach (interactive picker if no name) |
| `ttmux d` | Detach current session |
| `ttmux kill [name]` | Kill session (with confirmation) |
| `ttmux killall` | Kill all sessions |
| `ttmux rename <old> <new>` | Rename session |

### Task Orchestration

| Command | Description |
|---------|-------------|
| `ttmux spawn <group> <n1> <c1> ...` | Spawn parallel command tasks |
| `ttmux spawn --agent <group> <n1> <task1> ...` | Spawn parallel Claude agents |
| `ttmux spawn [--agent] --file <group> <file>` | Spawn from a task file |
| `ttmux status [group] [--json]` | Overview or group status (commands + agents) |
| `ttmux wait <group> [--timeout N]` | Wait for group to finish |
| `ttmux collect <group> [--json]` | Collect all task outputs |
| `ttmux send <session> <msg>` | Send a follow-up to a task/agent |
| `ttmux group ls` | List all task groups |
| `ttmux group kill <name>` | Kill all tasks in group |
| `ttmux capture <session> [--lines N]` | Capture pane output |

Agent options: `--dir <path>` `--model <model>` `--perm <mode>` `--max-turns <N>`.
Legacy aliases `agent spawn|status|send|collect|kill` still work.

### Swarm

A swarm is a **goal-bearing task group** with dependency gating, a shared **board** (kanban), and a **plaza** (message feed) — and it can be adopted by a `cc` master session for autonomous supervision.

| Command | Description |
|---------|-------------|
| `ttmux swarm new <name> [--goal "..."] [--no-master]` | Create a swarm (spawns a `cc` master by default) |
| `ttmux swarm add <swarm> <member> --type task\|agent ... <cmd/task>` | Add a member (`--depends-on a,b` to gate) |
| `ttmux swarm ls [--json]` | List swarms (goal / status / master) |
| `ttmux swarm status <swarm> [--json]` | Members, deps, pending + board/plaza summary |
| `ttmux swarm activate <swarm> [member] [--force]` | Unlock pending members (`--force` ignores deps) |
| `ttmux swarm done <swarm> [member]` | Mark member done + cascade unlock (no member = whole swarm) |
| `ttmux swarm collect <swarm> [--json]` | Collect member outputs |
| `ttmux swarm say / feed / watch <swarm> ...` | Plaza: post / read / follow messages |
| `ttmux swarm board <swarm> [--json]` | Board overview by column |
| `ttmux swarm task <add\|ls\|show\|assign\|move\|done\|rm> <swarm> ...` | Manage board cards |
| `ttmux swarm sql <swarm> [--json] "SELECT ..."` | Read-only query of the swarm's `swarm.db` |
| `ttmux swarm adopt <swarm> [--by <cc session>]` | Hand the swarm to a `cc` master |
| `ttmux swarm archive\|rm <swarm>` | Archive / delete |

```bash
ttmux swarm new login --goal "加登录功能"
ttmux swarm add login api --type agent "实现登录 API"
ttmux swarm adopt login                 # let a cc master supervise
```

### Window & Pane

| Command | Description |
|---------|-------------|
| `ttmux nw [name]` | New window |
| `ttmux lw` | List windows |
| `ttmux kw [id]` | Kill window |
| `ttmux sp [-h\|-v]` | Split pane |
| `ttmux kp` | Kill pane |

### Misc

| Command | Description |
|---------|-------------|
| `ttmux send [session] <cmd>` | Send command to session |
| `ttmux info` | Server info |
| `ttmux source` | Reload tmux.conf |
| `ttmux completion` | Install tab completion |

Any unrecognized command is forwarded directly to `tmux`.

### Browser Automation — `ttmux-chrome`

`ttmux-chrome` is a **standalone CLI** (a sibling of `ttmux`, not a subcommand) that
drives Chrome over CDP using **Playwright** (`connectOverCDP`), targeting the same
global Chrome the Web console mirrors — so automation is visible live in the browser
tab. Lean dependency: `npm i playwright-core` (no bundled browser download); set up
automatically by `install.sh`.

```bash
ttmux-chrome goto https://example.com
ttmux-chrome fill "#q" "hello" && ttmux-chrome press "#q" Enter
ttmux-chrome text h1
ttmux-chrome eval "document.title"
ttmux-chrome screenshot shot.png --full
```

Verbs: `goto / click / fill / type / press / text / html / attr / eval / wait /
screenshot / pdf / tabs / new / close`. Options `--tab N` / `--url <substr>` pick a
tab; `--timeout <ms>`, `--cdp <addr>`. Run `ttmux-chrome help` for the full list.
Source: [`cli/chrome-cli/`](cli/chrome-cli/).

## For AI Agents

ttmux is designed to be called by [Claude Code](https://claude.ai/code) and other AI agents.

### Claude Code Skill

```bash
# Install the skill
mkdir -p ~/.claude/skills/cc-swarm
cp -r skills/cc-swarm/* ~/.claude/skills/cc-swarm/
```

The `cc-swarm` skill teaches Claude Code to decompose a goal into a swarm, gate
members by dependencies, and supervise progress via the board + plaza.

### JSON Mode

All query commands support `--json` for machine-readable output:

```bash
ttmux ls --json
ttmux status ci --json
ttmux collect ci --json
```

## Web Console

`ttmux-web` is a Go (Gin) + React (Vite + Antd) console — a thin wrapper over the
CLI (reads proxy `ttmux <cmd> --json`, writes call the matching subcommand). It
covers sessions / tasks / swarm board + plaza / env, with live xterm.js terminals
per session and SSE status streaming.

```bash
cp .env.example .env  # set password / port
./start-all.sh        # build frontend → compile backend → serve (background daemon)
```

Default bind is `0.0.0.0:13579` (LAN-reachable). Config via `.env` at the repo
root; full setup, all env vars, and remote access in **[docs/install/](docs/install/)**.
Backend internals: [`backend/README.md`](backend/README.md).

> ⚠ The Web console puts shell execution on the network. Use a strong
> `TTMUX_WEB_PASSWORD`, and tunnel (Tailscale / Cloudflare) for remote access
> rather than exposing the port directly.

## How It Works

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

- Each task = a detached tmux session
- Output auto-logged via `pipe-pane`
- Group metadata in `~/.local/share/ttmux/groups/`
- Status queried from tmux format strings (`#{pane_dead}`, `#{pane_current_command}`)

## Documentation

- [docs/install/](docs/install/) — install & deployment
- [docs/design/](docs/design/) — design docs (swarm orchestration / board + plaza / web)

## License

MIT
