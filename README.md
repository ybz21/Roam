# Roam

> Turn your development machine into an always-on AI coding workstation.

[Simplified Chinese](README.zh-CN.md)

Roam lets you connect back to your development machine from a phone, tablet, or
laptop, then keep coding, watching logs, running tests, debugging in a browser,
and supervising Claude Code, Codex, or other AI coding agents from anywhere.

It solves a concrete problem: **serious software work should not be broken apart
by device changes, network drops, or long-running agent tasks.** Your code,
terminals, dev servers, browser, and agents keep running on the development
machine. Your device is just the control surface.

The value at a glance:

- **Remote development that keeps its context**: start from SSH, continue in the
  browser, check progress from a phone, and return without rebuilding the scene.
- **Long tasks that keep running**: tests, builds, migrations, log watchers,
  debugging sessions, and agents survive disconnects.
- **Manageable AI agents**: name Claude Code, Codex, or other agent workers,
  group them, inspect output, and send follow-up instructions.
- **Orchestration for complex work**: split a larger goal across tasks and
  agents with dependencies, a shared board, and a message feed.

Roam is not another cloud IDE. It connects to your real development machine and
puts terminals, browser state, files, tasks, and AI agents into one workspace you
can control remotely. The UI is a control surface; the work still happens in the
development environment you already use.

![Roam Web console](docs/roam-web-console.png)

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
alive. The Web console lets you operate it from anywhere. The command-line entry
point makes sessions, tasks, logs, and agent orchestration scriptable when you
need automation.

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

## Typical Use

1. Start Roam on your development machine.
2. Open the Web console from a phone, tablet, laptop, or another desktop.
3. Re-enter an existing terminal and continue the same coding context.
4. Run Claude Code, Codex, or another coding agent on the development machine.
5. Close your local browser, SSH session, or laptop; the work keeps running.
6. Come back later from any device to inspect progress, send follow-up
   instructions, or take over manually.

Roam is not mainly a terminal shortcut. It is a persistent workspace for the
machine where the work actually happens. Terminals, dev servers, logs, browser
state, coding-agent conversations, and task status do not disappear just because
your local command line or browser was closed.

## Install And Start

Install the CLI and build the Web console with one line:

```bash
curl -fsSL https://raw.githubusercontent.com/ybz21/ttmux/main/install.sh | bash
```

`install.sh` is a thin orchestrator over `scripts/` — a preflight system check
plus three modules: **[1]** ttmux CLI + skills, **[2]** chrome + Node + Playwright,
**[3]** the backend build (frontend `dist` + Go binary). It installs `ttmux` and
`chrome` to `~/.local/bin` and builds the Web console artifacts, but **does not
start anything**. Run through `curl | bash` it fetches the modules from GitHub on
demand; inside a clone it sources them locally. `TTMUX_SKIP_BACKEND=1` installs
only the CLI/chrome.

Then start the Web console from a checkout:

```bash
cp .env.example .env
./start.sh             # start the built artifacts (no recompile)
# ./start.sh --dev     # development: rebuild frontend + backend each run
```

`start.sh` also takes `stop` / `status` / `logs` / `fg`.

By default the Web console listens on `0.0.0.0:13579`, so devices on the same LAN
can reach it. Change the password before real use:

```dotenv
TTMUX_WEB_PASSWORD=change-this-to-a-strong-password
```

For remote access, prefer Tailscale, Cloudflare Tunnel, SSH forwarding, or frp.
Do not expose the Web console directly to the public Internet without a tunnel,
a strong password, and 2FA.

Exposing Roam through **frp with HTTPS** — required so mobile voice input and
clipboard keep working through the tunnel — is covered in
[docs/deploy/frp.md](docs/deploy/frp.md).

Full deployment notes are in [docs/install/README.md](docs/install/README.md).

## For Claude Code And Codex

If Claude Code, Codex, or another command-line coding agent is installed on your
development machine, run it inside a Roam terminal. Its execution, output,
conversation context, and follow-up channel stay on the development machine.
You can return from a phone or tablet to inspect progress or add instructions.

For larger goals, Roam can organize multiple task or agent members with a shared
board, dependency gates, and a message feed. One member can work on the API,
another on the UI, another on tests, and another on documentation.

## Command Line And Automation

Roam also ships command-line tools for scripts, automation, and AI agents. They
are not the first thing a new user needs to learn; start with the Web console.

- `ttmux`: persistent sessions, background tasks, agent workers, swarms, and
  machine-readable status.
- `chrome`: drives the development machine's browser for UI debugging,
  screenshots, form flows, and automated checks.

Command details live in [docs/install/README.md](docs/install/README.md),
`ttmux help`, and `chrome help`.

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

Install the repository Git hooks once per clone:

```bash
bash scripts/install-git-hooks.sh
```

The pre-commit hook runs the quick quality gate. CI runs the full gate on pushes
and pull requests:

```bash
scripts/quality/check.sh quick
scripts/quality/check.sh full
```

Build and run the Web console:

```bash
./start.sh --dev fg
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
