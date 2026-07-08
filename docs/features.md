# Roam — Feature List

**English** | [简体中文](features.zh-CN.md)

A structured list of what Roam does. For the overview and screenshots, see the
[README](../README.md).

## Remote access & multi-device
- **Zero-install Web console** — open it from any phone, tablet, or laptop browser; nothing to install on the client.
- **Same scene on every device** — reconnect after a network drop, browser close, or device switch and land back where you left off.
- **PWA install** — add the console to the home screen for an app-like launch.
- **Remote-access friendly** — pairs with Tailscale, Cloudflare Tunnel, frp, or SSH forwarding; self-signed HTTPS by default so mic/clipboard work over LAN/tunnel.

## Sessions & terminals
- **Persistent terminals (tmux-backed)** — terminals, dev servers, and long jobs keep running on the dev machine even when you disconnect.
- **Multi-tab terminals** — font-size control, copy, extra key bar, auto-reconnect on drop.
- **Session list & filters** — filter by Claude / Codex / swarm / state (waiting, idle); rename, group, and jump into any session.
- **Standalone terminal pages** — open a single session full-screen in its own tab (`#/term/<name>`).
- **Mobile key bar** — on-screen keys (Enter, Esc, Tab, arrows…) and a send box for typing into agents from a phone.

## AI coding agents
- **Claude Code & Codex as first-class citizens** — launch, name, group, track, and collect their output.
- **Agent state awareness** — detects when an agent is waiting for confirmation vs idle vs running.
- **Follow-up from anywhere** — drop in more instructions from any device without losing context.
- **Configurable launch commands** — customize the shell command used to start Claude / Codex.

## Swarm orchestration
- **Split one goal across members** — hand the API to one, frontend to another, tests to a third.
- **Live dependency topology** — a real-time graph of members and their links.
- **Collaboration wall (plaza)** — a shared message feed between the human and agents.
- **Drag-to-flow board** — a kanban (backlog / assigned / doing) for the group's tasks.
- **Dependencies & unlock** — finished work unlocks the next step; completion is marked explicitly.

## Files & editor
- **File browser** — flat view and a VS Code-style tree, with a toggle.
- **In-console preview & editor** — Monaco-based editing, markdown/mermaid rendering, office/file previewers.
- **Open files beside a terminal** — browse and edit next to the running agent.

## Browser control
- **Live browser mirror** — the dev machine's Chrome streamed into the console: open tabs, navigate, click, type.
- **Use cases** — debug a web app, keep a login session, or let an agent reproduce a flow, all on the dev machine.
- **Quality controls** — auto / SD / HD / Ultra streaming with latency, bandwidth, and FPS readouts.

## Phone control
- **Android device mirror (adb)** — a real connected phone streamed into the console with a remote nav bar and app launcher.
- **Reproduce mobile flows** — check an app or a mobile web page right next to your terminals.

## Voice
- **Voice input** — dictate into agents/terminals; ASR via Doubao/Volcano or OpenAI-compatible endpoints (mic needs a secure context — hence default HTTPS).

## Plugins & extensibility
- **Built-in plugins** — IM concierge (Feishu, extensible to DingTalk…) and reviewmesh (idle-time automatic peer review).
- **Plugin system** — manifest-based plugin packages (node/exec runtimes) with an install flow, plus builtin Go-module plugins compiled in; a public SDK and a `plugin dev` toolchain. See [plugins/](../plugins/) and [docs/design/plugin/](design/plugin/).

## CLI & automation
- **`ttmux`** — manage persistent sessions, background tasks, agent workers, swarms, and machine-readable state.
- **`chrome`** — drive the dev machine's Chrome for UI debugging, screenshots, form flows, and automated checks.
- **Scriptable** — expose sessions, tasks, logs, and orchestration to scripts and agents.

## Security & access
- **Password access** plus optional **TOTP two-factor**.
- **Self-signed TLS** out of the box; lockout after repeated failures.
- **Treat as SSH-level access** — designed to run behind a tunnel/VPN, not exposed directly to the public Internet.

## UX & internationalization
- **Bilingual UI (中文 / English)** — a hard i18n standard across the product.
- **Dark / light themes**, server-persisted preferences.
- **Built for humans and agents together** — humans take over from the console; agents read state, collect output, and keep pushing.
