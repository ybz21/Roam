# Roam

> Code on a remote machine as if you never left the desk.

[Simplified Chinese](README.zh-CN.md)

Roam is a remote coding workspace for long, messy, high-context software work:
large refactors, production debugging, test loops, migrations, and multi-agent
coding sessions that need to keep running after you close your laptop.

It has two halves:

- **The server side** runs on your development machine. It keeps terminals,
  coding agents, logs, files, and a browser alive in one persistent workspace.
- **The local side** is the `ttmux` CLI. It turns `tmux` into a programmable
  control plane for sessions, parallel jobs, agent workers, and swarms.

You can start work from SSH, continue from a browser, check progress from a
phone, and come back later without reconstructing the entire coding context.

## The Product Story

Remote coding is easy when the task is small. It gets painful when the task is
complex:

- the dev server must keep running
- tests and logs need separate terminals
- browser state matters for reproducing bugs
- agents need isolated workspaces and follow-up instructions
- long-running tasks should survive disconnects
- you need a way to understand what is still running

Roam treats the remote machine as the source of truth. The server keeps the work
alive. The CLI gives that work names, status, logs, and structure. The Web
console lets you operate it from anywhere.

## Server Side: The Remote Workspace

The Roam server is a Go + React Web console that runs on the machine where the
code lives. It is intentionally thin: it does not invent a second runtime. It
wraps `ttmux`, `tmux`, Chrome, and the filesystem already on that server.

On the server, Roam provides:

- **Persistent terminal access**: each terminal tab attaches to a real tmux
  session, so work continues after browser disconnects.
- **Agent-aware conversations**: when a session is running Claude or Codex, Roam
  can render the transcript as a readable chat while keeping the raw terminal
  available.
- **Swarm dashboard**: large goals can be tracked through members, dependency
  gates, a shared board, and a message feed.
- **File operations**: browse, inspect, and upload files next to the active
  terminal context.
- **Shared browser**: mirror and control a Chrome instance on the server, useful
  for UI debugging, login flows, screenshots, and agent-visible browsing.
- **Security controls**: password login, optional 2FA, login lockout, and a
  deployment model that works well behind tunnels.

In practice, the server answers: "What is happening on my coding machine right
now, and how do I control it without being physically there?"

## Local Side: The ttmux Control Plane

`ttmux` is the local CLI that makes the workspace scriptable. It wraps tmux with
named workflows that humans and coding agents can both use.

On the terminal side, `ttmux` provides:

- **Session management**: create, attach, detach, capture, rename, and kill tmux
  sessions with simpler commands.
- **Parallel task groups**: run lint, tests, builds, log watchers, and scripts in
  isolated sessions, then inspect status and collect outputs.
- **Agent workers**: spawn multiple coding agents with separate names, working
  directories, permissions, and follow-up channels.
- **Swarm orchestration**: model a larger goal as a supervised group with members,
  dependencies, a board, and a shared feed.
- **Machine-readable output**: JSON status and collection commands for scripts,
  agents, and the Web console.
- **Browser automation helper**: the sibling `chrome` CLI controls the same
  server-side Chrome instance over CDP.

In practice, `ttmux` answers: "How do I split this complex coding job into
durable, observable pieces?"

## Install CLI

Prerequisite: `tmux`.

```bash
curl -fsSL https://raw.githubusercontent.com/ybz21/ttmux/main/install.sh | bash
```

The installer puts `ttmux` in `~/.local/bin`, installs shell completion, creates
the data directories under `~/.local/share/ttmux`, and installs the bundled
Claude Code skills when possible.

If `~/.local/bin` is not on your `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Manual install:

```bash
cp ttmux ~/.local/bin/ttmux
chmod +x ~/.local/bin/ttmux
ttmux completion
```

## Quick Start

Create and attach a persistent session:

```bash
ttmux new work
ttmux ls
ttmux a work
```

Run several tasks in parallel:

```bash
ttmux spawn ci \
  "lint"      "npm run lint" \
  "test"      "npm test" \
  "typecheck" "npx tsc --noEmit"

ttmux status ci
ttmux wait ci
ttmux collect ci --json
ttmux group kill ci
```

Spawn coding agents as workers:

```bash
ttmux spawn --agent refactor \
  "api"   "Refactor the auth API" \
  "tests" "Add regression tests" \
  "docs"  "Update developer docs" \
  --dir ~/project --perm auto

ttmux status refactor
ttmux send refactor-api "Also cover expired-token behavior"
ttmux collect refactor
```

Create a swarm for a larger goal:

```bash
ttmux swarm new login --goal "Implement login end to end"
ttmux swarm add login api --type agent "Implement the login API"
ttmux swarm add login ui  --type agent --depends-on api "Build the login UI"
ttmux swarm adopt login
ttmux swarm status login
```

## Web Console

The Web console runs on the development machine and wraps the same CLI. Reads
proxy `ttmux ... --json`; writes call the matching command.

Prerequisites for the full Web console:

- Go 1.21+
- Node.js 18+ and npm
- tmux
- sqlite3 for swarm mode
- Chrome or Chromium for browser mirror/control

Run from a clone:

```bash
git clone https://github.com/ybz21/ttmux.git
cd ttmux

cp .env.example .env
./start-all.sh
```

Useful process commands:

```bash
./start-all.sh status
./start-all.sh logs
./start-all.sh stop
./start-all.sh fg
```

By default `start-all.sh` serves on `0.0.0.0:13579` so devices on the same LAN
can reach it. Change the password and bind address in `.env` before real use:

```dotenv
TTMUX_WEB_PASSWORD=change-this-to-a-strong-password
TTMUX_WEB_BIND=127.0.0.1:13579
```

For remote access, prefer Tailscale, Cloudflare Tunnel, SSH forwarding, or frp.
Do not expose the Web console directly to the public Internet without a tunnel,
a strong password, and 2FA.

Full deployment notes are in [docs/install/README.md](docs/install/README.md).

## Core Commands

### Sessions

| Command | Description |
| --- | --- |
| `ttmux ls [--json]` | List sessions |
| `ttmux new [name]` | Create a session |
| `ttmux a [name]` | Attach, or pick interactively |
| `ttmux d [name]` | Detach |
| `ttmux kill [name]` | Kill a session |
| `ttmux killall` | Kill all sessions |
| `ttmux rename <old> <new>` | Rename a session |
| `ttmux capture <session> [--lines N]` | Capture pane output |

### Task Groups

| Command | Description |
| --- | --- |
| `ttmux spawn <group> <name> <cmd> ...` | Spawn parallel command workers |
| `ttmux spawn --agent <group> <name> <task> ...` | Spawn parallel agent workers |
| `ttmux spawn [--agent] --file <group> <file>` | Spawn from a task file |
| `ttmux status <group> [--json]` | Show worker status |
| `ttmux wait <group> [--timeout N]` | Wait for completion |
| `ttmux collect <group> [--json]` | Collect worker output |
| `ttmux send <session> <message>` | Send follow-up input |
| `ttmux group ls` | List task groups |
| `ttmux group kill <group>` | Kill a task group |

Agent options:

```text
--dir <path> --model <model> --perm <mode> --max-turns <N>
```

### Swarms

A swarm is a goal-bearing group for complex work. It adds member metadata,
dependency gating, a shared board, a message feed, and optional master adoption.

| Command | Description |
| --- | --- |
| `ttmux swarm new <name> [--goal "..."] [--no-master]` | Create a swarm |
| `ttmux swarm add <swarm> <member> --type task|agent ...` | Add a member |
| `ttmux swarm ls [--json]` | List swarms |
| `ttmux swarm status <swarm> [--json]` | Show members, deps, board/feed summary |
| `ttmux swarm activate <swarm> [member] [--force]` | Unlock pending members |
| `ttmux swarm done <swarm> [member]` | Mark member or whole swarm done |
| `ttmux swarm collect <swarm> [--json]` | Collect outputs |
| `ttmux swarm say/feed/watch <swarm> ...` | Write/read/follow the message feed |
| `ttmux swarm board <swarm> [--json]` | Show the board |
| `ttmux swarm task <add|ls|show|assign|move|done|rm> <swarm> ...` | Manage cards |
| `ttmux swarm sql <swarm> [--json] "SELECT ..."` | Read-only swarm database query |
| `ttmux swarm adopt <swarm> [--by <session>]` | Hand the swarm to a master session |
| `ttmux swarm archive|rm <swarm>` | Archive or delete |

### Environment

| Command | Description |
| --- | --- |
| `ttmux env` | List global environment values |
| `ttmux env set <KEY=VALUE>` | Set a value for future sessions |
| `ttmux env rm <KEY>` | Remove a value |
| `ttmux env clear` | Clear all values |
| `ttmux env push` | Push values into existing sessions |

Unrecognized commands are forwarded to `tmux`, so normal tmux commands remain
available.

## Browser Automation

`chrome` is a standalone CLI installed next to `ttmux`. It drives the shared
Chrome instance over CDP with `playwright-core`, so actions are visible in the
Web console browser tab.

```bash
chrome setup
chrome goto https://example.com
chrome fill "#q" "roam"
chrome press "#q" Enter
chrome text h1
chrome screenshot shot.png --full
chrome tabs
```

Source: [cli/chrome-cli](cli/chrome-cli).

## How It Works

```text
ttmux spawn ci "lint" "npm run lint" "test" "npm test"
                 |
                 +-- tmux session: ci-lint  -> log file
                 +-- tmux session: ci-test  -> log file
```

- Each worker is a detached tmux session.
- Output is captured with `pipe-pane` into `~/.local/share/ttmux/logs`.
- Task group metadata lives under `~/.local/share/ttmux/groups`.
- Swarm metadata uses SQLite under the ttmux data directory.
- The Web console calls the CLI for orchestration and uses WebSocket/SSE for live
  terminals, logs, status, and browser streaming.

## Repository Layout

```text
ttmux                    single-file CLI distribution
chrome                   single-file browser automation distribution
cli/ttmux-cli/           modular source for ttmux
cli/chrome-cli/          modular source for chrome
backend/                 Go + Gin Web backend
frontend/                React + Vite + Ant Design Web console
skills/                  Claude Code skills for ttmux and cc-swarm
docs/                    install and design documentation
tests/                   smoke and end-to-end checks
```

Important: do not edit the root `ttmux` or `chrome` files directly unless you are
intentionally changing the generated distribution files. Edit the modular source
under `cli/`, then rebuild:

```bash
bash cli/ttmux-cli/build.sh
bash cli/chrome-cli/build.sh
```

## Development

Build and run the Web console:

```bash
./start-all.sh fg
```

Frontend only:

```bash
cd frontend
npm install
npm run dev
```

Backend only:

```bash
cd backend
TTMUX_BIN=../ttmux TTMUX_WEB_PASSWORD=dev go run ./cmd
```

CLI smoke test:

```bash
TTMUX=./ttmux bash tests/test_ttmux.sh
```

## Security Model

Roam intentionally exposes shell, terminal, file, agent, and browser control for
the machine it runs on. Treat the Web console like SSH access:

- use a strong `TTMUX_WEB_PASSWORD`
- enable 2FA from the Web console for long-running deployments
- bind to `127.0.0.1` when using a tunnel
- avoid direct public exposure
- run it on a machine/account whose privileges match the risk

## Status

Roam is early and pragmatic. The CLI is a shell script distribution, the Web
backend is a thin Go wrapper around it, and the UI is optimized for remote coding
operations rather than for general-purpose server administration.

Before publishing a public release, add a repository `LICENSE` file and align it
with the license declared in package metadata and docs.
