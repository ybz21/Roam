# Agent Required Project Instructions

These instructions apply to Codex, Claude Code, and other coding agents working in this repository.

## Must Read

- [docs/development/i18n.md](docs/development/i18n.md) is the mandatory internationalization standard.
- [docs/development/ui-design-system.md](docs/development/ui-design-system.md) is the mandatory Web UI design system: type/radius/spacing/accent tokens, the single breakpoint entry point, touch-target rules, and the traps that keep recurring. Read it before any frontend UI change.
- Frontend changes must follow [docs/design/web/04-frontend.md](docs/design/web/04-frontend.md) unless a newer implementation pattern exists in code.

## Icon Gate

UI icons are **SVG only**. Never add emoji (🔄 📎 🤖 …) or text symbols used as icons
(`✕ × ✓ ▾ ▸ ← → ↑ ↓ ⏎ ■ ● ◆ ⚠ ⎇ ⧉ ＋ …`), and never draw a one-off inline SVG in a component.
Take icons from `frontend/src/icons.tsx` (24×24 viewBox, `currentColor`, 1.8 stroke) — add new
ones there; `file-icons.tsx` and `git/parts.tsx` hold the file-type and Git sets in the same style.
The same action must use the same icon everywhere, and **icons must never be baked into i18n
strings** (`'＋ Add task'`): copy holds words only, the call site passes `icon={<PlusIcon />}`.
The only exceptions are keyboard-shortcut modifier glyphs (`⌘ ⇧ ⌃`) and the swarm office view's
deliberate role-avatar emoji. Full rule: [CLAUDE.md](CLAUDE.md#图标硬规则不许-emoji不许文字符号).

## Internationalization Gate

All new user-facing product text must go through the project i18n layer. This includes labels, buttons, placeholders, tooltips, empty states, validation messages, toast/message/notification text, modal titles, table columns, navigation labels, status labels, browser page text, and fallback HTML.

Allowed exceptions are listed in the i18n standard. If a change intentionally leaves user-facing text untranslated, document why in the PR or task summary.

## Quality Gate

- Run `scripts/dev/quality/check.sh quick` before committing local changes.
- Run `scripts/dev/quality/check.sh full` before opening or updating a PR with runtime behavior changes.
- Install the tracked Git hooks with `bash scripts/dev/install-git-hooks.sh`; it sets `core.hooksPath=.githooks` and `commit.template=.gitmessage`.
- Do not commit `.env`, generated dependency folders, coverage output, or hard-coded secrets.

## Commit Convention

- Commit messages follow [Conventional Commits](docs/development/commit-convention.md): `<type>(<scope>): <描述>`.
- The `commit-msg` hook enforces the format locally; PR titles must follow it too (squash merges turn the title into the final commit).

## Code Review

- PRs are reviewed by the **Codex GitHub App** (`chatgpt-codex-connector` bot). See [docs/development/codex-review.md](docs/development/codex-review.md) for how it is enabled and how to respond.
- The `babysit-pr` skill (`skills/babysit-pr/`) automates polling, deciding fix-vs-skip, replying, and resolving Codex review threads.
