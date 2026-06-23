package app

import (
	"fmt"
	"os"
	"strings"

	"ttmux-cli-go/internal/command/completion"
	envelope "ttmux-cli-go/internal/command/env"
	"ttmux-cli-go/internal/command/group"
	"ttmux-cli-go/internal/command/help"
	"ttmux-cli-go/internal/command/interactive"
	"ttmux-cli-go/internal/command/session"
	"ttmux-cli-go/internal/command/spawn"
	swarmcommand "ttmux-cli-go/internal/command/swarm"
	"ttmux-cli-go/internal/runtime"
	swarmcore "ttmux-cli-go/internal/swarm"
	"ttmux-cli-go/internal/ui"
)

const version = runtime.Version

type App struct {
	rt runtime.Runtime
}

func New() App {
	return App{rt: runtime.New()}
}

func (a App) Run(args []string) error {
	args = stripQuiet(args)
	if len(args) == 0 {
		return interactive.Run(a.rt, version, a.Run)
	}
	cmd := args[0]
	rest := args[1:]
	out := os.Stdout
	switch cmd {
	// ── hidden helpers ──
	case "__autoconfirm":
		if len(rest) == 1 {
			spawn.RunAutoconfirm(a.rt, rest[0])
		}
		return nil

	case "-h", "--help", "help":
		help.Show(version, out)
		return nil

	case "-i", "--interactive":
		return interactive.Run(a.rt, version, a.Run)
	case "completion":
		return completion.Install(out)

	case "-v", "--version":
		fmt.Fprintf(out, "ttmux v%s\n", version)
		return nil

	// ── session management (native) ──
	case "ls":
		if has(rest, "--json") {
			return session.ListJSON(a.rt, a.swarmSessions(), out)
		}
		return session.List(a.rt, a.swarmSessions(), out)
	case "new":
		return session.New(a.rt, rest, out)
	case "a", "attach":
		return session.Attach(a.rt, a.swarmSessions(), rest, out)
	case "d", "detach":
		return session.Detach(a.rt, rest, out)
	case "kill":
		return session.Kill(a.rt, a.swarmSessions(), rest, out)
	case "killall":
		return session.KillAll(a.rt, a.swarmSessions(), out)
	case "rename":
		return session.Rename(a.rt, a.swarmSessions(), rest, out)
	case "send":
		return session.Send(a.rt, a.swarmSessions(), rest, out)
	case "source":
		return session.Source(a.rt, out)

	// ── windows / panes (native) ──
	case "nw":
		return session.NewWindow(a.rt, rest, out)
	case "lw":
		return session.ListWindows(a.rt, rest, out)
	case "kw":
		return session.KillWindow(a.rt, rest, out)
	case "sp", "split":
		return session.Split(a.rt, rest, out)
	case "kp":
		return session.KillPane(a.rt, rest, out)

	// ── task orchestration (native) ──
	case "spawn":
		return a.runSpawn(rest)
	case "wait":
		return spawn.Wait(a.rt, rest, out)
	case "agent":
		return a.runAgent(rest)
	case "capture":
		return session.Capture(a.rt, rest, out)
	case "collect":
		if len(rest) < 1 {
			return fmt.Errorf("usage: ttmux collect <group> [--json]")
		}
		if len(rest) >= 2 && rest[1] == "--json" {
			return group.CollectJSON(a.rt, rest[0], out)
		}
		return group.CollectText(a.rt, rest[0], out)
	case "group":
		return a.runGroup(rest)
	case "status":
		return a.runStatus(rest)

	// ── env (native) ──
	case "env":
		return envelope.Run(a.rt, rest, out)
	case "info":
		if has(rest, "--json") {
			return session.InfoJSON(a.rt, version, a.swarmSessions(), out)
		}
		return a.rt.Tmux("info")

	// ── swarm (status native, rest delegated) ──
	case "swarm":
		return swarmcommand.Run(a.rt, rest, out)

	default:
		return a.rt.Tmux(append([]string{cmd}, rest...)...)
	}
}

func (a App) runSpawn(args []string) error {
	switch {
	case len(args) >= 1 && args[0] == "--agent":
		rest := args[1:]
		if len(rest) >= 1 && rest[0] == "--file" {
			return fileSpawn(a.rt, rest[1:], true)
		}
		return spawn.SpawnAgents(a.rt, rest, os.Stdout)
	case len(args) >= 1 && args[0] == "--file":
		return fileSpawn(a.rt, args[1:], false)
	default:
		return spawn.Spawn(a.rt, args, os.Stdout)
	}
}

// fileSpawn parses `<group> <file> [opts]` for the --file spawn forms.
func fileSpawn(rt runtime.Runtime, args []string, agent bool) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: ttmux spawn [--agent] --file <group> <file> [opts]")
	}
	return spawn.SpawnFile(rt, args[0], args[1], args[2:], agent, os.Stdout)
}

func (a App) runAgent(args []string) error {
	subcmd := "help"
	if len(args) > 0 {
		subcmd = args[0]
		args = args[1:]
	}
	switch subcmd {
	case "spawn":
		if len(args) >= 1 && args[0] == "--file" {
			return fileSpawn(a.rt, args[1:], true)
		}
		return spawn.SpawnAgents(a.rt, args, os.Stdout)
	case "status":
		return a.runStatus(args)
	case "send":
		return session.Send(a.rt, a.swarmSessions(), args, os.Stdout)
	case "collect":
		if len(args) < 1 {
			return fmt.Errorf("usage: ttmux agent collect <group> [--json]")
		}
		if len(args) >= 2 && args[1] == "--json" {
			return group.CollectJSON(a.rt, args[0], os.Stdout)
		}
		return group.CollectText(a.rt, args[0], os.Stdout)
	case "kill":
		if len(args) < 1 {
			return fmt.Errorf("usage: ttmux agent kill <group>")
		}
		return group.Kill(a.rt, args[0], os.Stdout)
	default:
		return fmt.Errorf("unknown subcommand: agent %s", subcmd)
	}
}

func (a App) runStatus(args []string) error {
	if len(args) < 1 {
		_ = session.List(a.rt, a.swarmSessions(), os.Stdout)
		fmt.Fprintln(os.Stdout)
		return group.List(a.rt, a.swarmNames(), os.Stdout)
	}
	if len(args) >= 2 && args[1] == "--json" {
		return group.StatusJSON(a.rt, args[0], os.Stdout)
	}
	return group.Status(a.rt, args[0], os.Stdout)
}

func (a App) runGroup(args []string) error {
	subcmd := "ls"
	if len(args) > 0 {
		subcmd = args[0]
		args = args[1:]
	}
	switch subcmd {
	case "ls", "list":
		if has(args, "--json") {
			return group.ListJSON(a.rt, os.Stdout)
		}
		return group.List(a.rt, a.swarmNames(), os.Stdout)
	case "status":
		if len(args) < 1 {
			return fmt.Errorf("usage: ttmux group status <group>")
		}
		if len(args) >= 2 && args[1] == "--json" {
			return group.StatusJSON(a.rt, args[0], os.Stdout)
		}
		return group.Status(a.rt, args[0], os.Stdout)
	case "kill":
		if len(args) < 1 {
			return fmt.Errorf("usage: ttmux group kill <group>")
		}
		return group.Kill(a.rt, args[0], os.Stdout)
	default:
		return fmt.Errorf("unknown subcommand: group %s", subcmd)
	}
}

// swarmSessions returns the set of tmux sessions that belong to swarms so the
// native session listings hide them, matching the shell CLI's _is_swarm_session.
func (a App) swarmSessions() map[string]bool {
	return swarmcore.SessionNames(a.swarmOptions())
}

// swarmNames returns the set of swarm names so the group listing hides them.
func (a App) swarmNames() map[string]bool {
	return swarmcore.Names(a.swarmOptions())
}

func (a App) swarmOptions() swarmcore.Options {
	return swarmcore.Options{
		HomeDir: a.rt.HomeDir,
		DataDir: a.rt.DataDir,
		TmuxBin: a.rt.TmuxBin,
		Now:     a.rt.Now,
	}
}

// stripQuiet consumes leading global -q/--quiet/--agent flags (before the
// command), enabling machine-friendly output (also settable via TTMUX_AGENT=1).
func stripQuiet(args []string) []string {
	for len(args) > 0 {
		switch args[0] {
		case "-q", "--quiet", "--agent":
			ui.SetAgentMode(true)
			args = args[1:]
		default:
			return args
		}
	}
	return args
}

func has(args []string, want string) bool {
	for _, arg := range args {
		if strings.EqualFold(arg, want) {
			return true
		}
	}
	return false
}
