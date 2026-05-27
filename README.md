# ttmux

> AI-native tmux wrapper — parallel task orchestration from your terminal.

ttmux wraps tmux with a friendlier interface and adds first-class support for **parallel task execution**, **output capture**, and **multi-agent orchestration**.

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
| `ttmux spawn <group> <n1> <c1> ...` | Spawn parallel tasks |
| `ttmux spawn --file <group> <file>` | Spawn from task file |
| `ttmux group ls` | List all task groups |
| `ttmux group status <name>` | Group task status |
| `ttmux group kill <name>` | Kill all tasks in group |
| `ttmux status [group] [--json]` | Overview or group status |
| `ttmux wait <group> [--timeout N]` | Wait for group to finish |
| `ttmux capture <session> [--lines N]` | Capture pane output |
| `ttmux collect <group> [--json]` | Collect all task outputs |

### Multi-Agent (Claude)

| Command | Description |
|---------|-------------|
| `ttmux agent spawn <g> <n> <task> ...` | Launch multiple Claude agents |
| `ttmux agent status <group>` | Agent group status |
| `ttmux agent send <session> <msg>` | Send follow-up to an agent |
| `ttmux agent collect <group> [--json]` | Collect agent outputs |
| `ttmux agent kill <group>` | Clean up agent group |

Options: `--dir <path>` `--model <model>` `--perm <mode>` `--max-turns <N>`

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

## For AI Agents

ttmux is designed to be called by [Claude Code](https://claude.ai/code) and other AI agents.

### Claude Code Skill

```bash
# Install the skill
mkdir -p ~/.claude/skills
cp skills/tmux/SKILL.md ~/.claude/skills/ttmux.md
```

Then use `/ttmux` in Claude Code to decompose tasks into parallel workers.

### JSON Mode

All query commands support `--json` for machine-readable output:

```bash
ttmux ls --json
ttmux status ci --json
ttmux collect ci --json
```

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

## License

MIT
