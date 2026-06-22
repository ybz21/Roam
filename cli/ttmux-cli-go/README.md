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

All existing `ttmux` commands are represented in the Go router. Commands that
are already low-risk data reads are implemented natively. Commands with heavy
interactive tmux behavior, prompt editing, or complex process orchestration
currently delegate to the checked-in shell CLI through `runtime.Shell`.

Native in this slice:

- `ls --json`
- `group ls --json`
- `group status <name> --json`
- `status <name> --json`
- `capture <session> [--lines N]`
- `collect <group> --json`
- `env --json`
- `env set KEY=VALUE`
- `env rm KEY`
- `env clear`
- `info --json`
- `swarm status <name> --json`

Compatibility routed in this slice:

- interactive mode and help
- session create/attach/detach/kill/rename
- spawn/wait/window/pane/send/source/completion
- agent orchestration
- swarm mutations, listener, plaza, board, SQL, archive/delete

The migration path is to replace compatibility-routed commands one domain at a
time while keeping command behavior stable.

## Runtime Dependency

This binary is **not** standalone yet. Every compatibility-routed command shells
out to the generated bash CLI at `<repo-root>/ttmux` (located by walking up from
the working directory for a file named `ttmux`, overridable via `TTMUX_SHELL`).
Run `cli/ttmux-cli/build.sh` to (re)generate that script before relying on the
Go binary outside the repository.
