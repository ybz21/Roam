# ttmux-cli-go

Go implementation track for the `ttmux` CLI.

## Architecture

The command surface is split by domain instead of mirroring the old monolithic
shell file:

- `cmd/ttmux-cli-go`: thin executable entrypoint.
- `internal/app`: command routing and compatibility decisions.
- `internal/runtime`: filesystem layout, tmux execution, shell fallback, task metadata.
- `internal/command/session`: session command adapters, capture, and info JSON.
- `internal/command/group`: group command adapters for list/status/collect JSON.
- `internal/command/env`: global env command adapters and storage.
- `internal/command/swarm`: swarm command adapter and shell fallback boundary.
- `internal/swarm`: reusable swarm data/status core.

## Compatibility Strategy

All `ttmux` commands are implemented natively in the Go router and verified
byte-compatible with the shell CLI (the two interoperate on the same data and
SQLite stores). The migration is complete; the sections below list the surface.

Native (no shell dependency):

- session: `ls`/`ls --json`, `new`, `a`/`attach`, `d`/`detach`, `kill`, `killall`,
  `rename`, `send`, `source`
- windows/panes: `nw`, `lw`, `kw`, `sp`/`split`, `kp`
- tasks: `spawn <group> ...`, `spawn --agent ...` (claude/codex launch built in
  Go), `wait`, `status`/`status --json`, `capture`, `collect --json`,
  `group ls`/`group status`/`group kill`, `agent spawn|status|send|collect|kill`
- env: `env`/`env --json`/`set`/`rm`/`clear`/`push`
- info: `info`/`info --json`, `help`, `-v`
- spawn: `spawn`/`spawn --agent`/`--file` forms, `wait`
- swarm — full data plane and orchestration:
  - lifecycle: `new`, `add` (deps gating + claude/codex member launch), `done`
    (cascade unlock), `activate`, `adopt`, `archive`, `rm`
  - views: `ls`/`ls --json`, `status`/`status --json`, `collect`/`collect --json`,
    `sql` (read-only)
  - plaza: `say` (author inference, @mention busy-touch, leader notify), `feed`,
    `watch`, `listen` (relevance tagging + cursor)
  - board: `board`, `task add|ls|show|assign|move|done|rm`

The swarm layer uses parameterized SQL via the pure-Go driver — no `sqlite3` CLI,
no shell escaping/injection — and is byte-for-byte compatible with the shell
CLI's DBs (both tools interoperate on the same `meta.db`/`swarm.db`).

Also native: the interactive menu (`ttmux` with no args / `-i`), `completion`
script install, and `swarm migrate`.

**The binary is now fully standalone — every command is native Go, with no
remaining shell-out.** The checked-in `ttmux` bash script is retained for
reference and side-by-side comparison, but the Go binary no longer depends on it.

## Agent Mode

For non-interactive callers (swarm member agents, scripts), set `TTMUX_AGENT=1`
in the environment or pass a leading `-q`/`--quiet`/`--agent` flag. In agent mode:

- ANSI colors are disabled;
- status/info/warning/error messages go to **stderr**, leaving **stdout** for
  data only — e.g. `id=$(ttmux -q swarm task add feat "title")` yields just `t1`;
- read commands keep their `--json` forms for structured parsing
  (`ls`/`status`/`feed`/`board`/`collect`/`sql`/`swarm ls`).

The migration path is to replace the remaining routed commands one domain at a
time while keeping command behavior stable.

## Cross-Compilation

The native surface depends only on `tmux` at runtime — no bash, python3, or the
`sqlite3` CLI. SQLite access uses the pure-Go `modernc.org/sqlite` driver, so the
binary cross-compiles with `CGO_ENABLED=0` to every Go target that runs tmux
(Linux, macOS, *BSD; Windows only under WSL):

    CGO_ENABLED=0 GOOS=darwin  GOARCH=arm64 go build ./cmd/ttmux-cli-go
    CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build ./cmd/ttmux-cli-go
    CGO_ENABLED=0 GOOS=freebsd GOARCH=amd64 go build ./cmd/ttmux-cli-go

The detached first-run auto-confirm worker uses `setsid` via
`syscall.SysProcAttr`, which is available on all Unix targets.

## Runtime Dependency

The only runtime dependency is `tmux` itself (plus `claude`/`codex` when
launching agents). There is no dependency on bash, `python3`, or the `sqlite3`
CLI. The `runtime.Shell` escape hatch remains in the code but is no longer used
by any command.
