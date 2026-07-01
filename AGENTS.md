# Agent Required Project Instructions

These instructions apply to Codex, Claude Code, and other coding agents working in this repository.

## Must Read

- [docs/development/i18n.md](docs/development/i18n.md) is the mandatory internationalization standard.
- Frontend changes must follow [docs/design/web/04-frontend.md](docs/design/web/04-frontend.md) unless a newer implementation pattern exists in code.

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
