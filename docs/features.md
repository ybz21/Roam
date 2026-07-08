# Roam — Feature List

**English** | [简体中文](features.zh-CN.md)

A detailed list of what Roam does. For the overview and screenshots, see the
[README](../README.md).

## Remote access & multi-device
- **Zero-install Web console** — open it from any phone, tablet, or laptop browser; nothing to install on the client.
- **Same scene on every device** — reconnect after a network drop, browser close, or device switch and land back where you left off.
- **Server-side preferences with cross-device sync** — theme, language, layout, and quick commands follow you across devices.
- **Terminal state restored from the URL** — the open terminals/tabs are encoded in the hash, so a reload or a shared link reopens the same set.
- **PWA install-to-home-screen** — add the console to the home screen (192px icon) for an app-like launch.
- **Remote-access friendly** — pairs with Tailscale, Cloudflare Tunnel, frp, or SSH forwarding; self-signed HTTPS by default so mic/clipboard work over LAN/tunnel.
- **Auto-upgrade detection** — the console can detect a newer remote build and surface an update banner.

## Sessions & terminals
- **Persistent terminals (tmux-backed)** — terminals, dev servers, and long jobs keep running on the dev machine even when you disconnect.
- **Multi-tab terminals** — font-size control, copy, an extra key bar, and auto-reconnect on drop.
- **Session list, filters & search** — filter by Claude / Codex / swarm / state (waiting, idle); two-row filter bar with search; sort by last activity.
- **Rename sessions**; each session carries a `last_activity` timestamp.
- **Standalone terminal pages** — open a single session full-screen in its own tab (`#/term/<name>`).
- **New session with Git Worktree mode** — spin a session up on an isolated worktree/branch.
- **Quick commands** — save frequently used commands, one-click send, focus returns to the input (no double-fire), persisted across reloads.
- **Drag-select copy inside TUI agents** — mouse selection works in Claude/Codex alt-screen sessions (app mouse-reporting is filtered so you can still select text).
- **Scroll history in full-screen TUIs** — mouse wheel scrolls back through Claude/Codex alt-screen via backend-synthesized wheel events.
- **Mobile key bar & send box** — on-screen keys (Enter, Esc, Tab, arrows…) plus a dedicated input box so the soft keyboard doesn't eat your submit.

## AI coding agents
- **Claude Code & Codex as first-class citizens** — launch, name, group, track, and collect their output; agents are tagged in the session list.
- **Agent state awareness** — detects waiting-for-confirmation vs idle vs running.
- **Chat view** — a conversation UI over the agent with block rendering, copy, and prompt-status detection.
- **Paste images into a terminal / chat** — paste a screenshot straight into the input (auto `@`-prefixed as a file reference); Shift+Enter for a newline.
- **Follow-up from anywhere** — drop in more instructions from any device without losing context.
- **Configurable launch commands** — customize the shell command used to start Claude / Codex.

## Swarm orchestration
- **Split one goal across members** — hand the API to one, frontend to another, tests to a third.
- **Member engines & roles** — Claude or Codex per member; master/worker roles, fine-grained subroles (product / engineering / test…) and duties.
- **Auto-leader** — a Leader is spun up from a template so the group doesn't go solo; working-dir support per swarm.
- **Prompt templates** — Go `text/template`-based member prompts, rendered as markdown.
- **Live dependency topology** — an animated real-time graph (the "office" view) of members and their links, adapted for mobile.
- **Collaboration wall (plaza)** — a shared message feed between the human and agents; a listen loop keeps master/worker watching for human/plaza messages.
- **Drag-to-flow board** — a kanban (backlog / assigned / doing) for the group's tasks; inbox for items needing intervention.
- **Dependencies & unlock** — finished work unlocks the next step; completion is marked explicitly.
- **Isolation** — swarm sessions are hidden from the regular session listings and the Go CLI native lists.

## Files & editor
- **File browser** — flat view and a VS Code-style tree, with a toggle; hidden-files switch.
- **Sorting & navigation** — sort by name / kind / modified / created / size; recent-directory quick buttons above the path bar.
- **Global right-click menu** — unified file context menu (open, delete, reference into a terminal…).
- **Monaco code editor** — `FileWorkspace` component with VS Code-style dual-pane editing; drag a file or tab into the right half to split (editor pane + terminal pane).
- **Live reload** — a file changed on disk by an external tool reloads in the open editor.
- **Inline previews** — markdown (with **Mermaid** diagram rendering), images, office/file previewers, relative-link support; file icons by type.
- **Drag a file into a terminal** — drops a reference to it into the prompt.

## Browser control
- **Live browser mirror** — the dev machine's Chrome streamed into the console: open tabs, navigate, click, type.
- **Tab bar** — list/switch/close the mirrored Chrome's tabs; pick which tab to mirror.
- **Quality controls** — auto / SD / HD / Ultra streaming with latency, bandwidth, and FPS readouts; jitter-free rendering during typing/loading.
- **Chrome config panel** — headless/headed toggle, window size, profile, binary path, scale — all from Settings.
- **Robust attach** — attaches to an existing Chrome on the debug port or launches one; auto-switches the CDP port if it's taken; surfaces launch failures in the UI.

## Phone control
- **Android / iOS device mirror** — a real connected phone streamed into the console with a remote nav bar and an app launcher.
- **Adaptive streaming** — quality tiers with latency/bandwidth/FPS; three-end (host/Android/iOS) connection config.
- **On-demand dependency install** — Android tooling installed only when needed (platform switch).
- **Reproduce mobile flows** — check an app or a mobile web page right next to your terminals.

## Voice
- **Voice input** — dictate into agents/terminals.
- **ASR routing** — Doubao/Volcano (standard vs turbo auto-selected by `resourceId`) or OpenAI-compatible endpoints; mic needs a secure context — hence default HTTPS.

## Plugins & extensibility
- **Built-in plugins** — **IM concierge** (Feishu self-built bidirectional bot: `@mention` to delegate, agent-led dialogue, delegate-to-worker; extensible to DingTalk via a provider adapter) and **reviewmesh** (idle-time automatic Codex+Claude peer review with findings and a quality loop).
- **Plugin system v1** — manifest-based plugin packages (node/exec runtimes) with an install flow, plus builtin Go-module plugins compiled in; a public SDK, `plugin dev` toolchain, activation events, watchers, and per-plugin storage. See [plugins/](../plugins/) and [docs/design/plugin/](design/plugin/).

## CLI & automation
- **`ttmux`** — manage persistent sessions, background tasks, agent workers, swarms, and machine-readable state.
- **`chrome`** — drive the dev machine's Chrome for UI debugging, screenshots, form flows, and automated checks (Playwright over CDP).
- **Scriptable** — expose sessions, tasks, logs, and orchestration to scripts and agents.

## Security & access
- **Password access** plus optional **TOTP two-factor**; lockout after repeated failures.
- **Self-signed TLS** out of the box — a split root CA + leaf cert, with a "download certificate" entry so devices can trust it.
- **Treat as SSH-level access** — designed to run behind a tunnel/VPN, not exposed directly to the public Internet.

## UX & internationalization
- **Bilingual UI (中文 / English)** — a hard i18n standard across the product.
- **Dark / light themes**; unified `#/xxx` hash routing; sidebar icons with tooltips.
- **Overview page** — sessions-first ordering, adaptive layout, quick stats (sessions / swarms / active members / pending unlock).
- **Proactive clipboard permission** — requested on load so paste doesn't stall on first use.
- **Built for humans and agents together** — humans take over from the console; agents read state, collect output, and keep pushing.
- **License** — AGPLv3.
