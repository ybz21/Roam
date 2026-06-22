package app

import (
	"fmt"
	"os"
	"strings"

	envelope "ttmux-cli-go/internal/command/env"
	"ttmux-cli-go/internal/command/group"
	"ttmux-cli-go/internal/command/session"
	swarmcommand "ttmux-cli-go/internal/command/swarm"
	"ttmux-cli-go/internal/runtime"
	swarmcore "ttmux-cli-go/internal/swarm"
)

const version = "0.4.1-go"

type App struct {
	rt runtime.Runtime
}

func New() App {
	return App{rt: runtime.New()}
}

func (a App) Run(args []string) error {
	if len(args) == 0 {
		return a.rt.Shell(args...)
	}
	cmd := args[0]
	rest := args[1:]
	switch cmd {
	case "-h", "--help", "help", "-i", "--interactive", "new", "a", "attach", "d", "detach", "kill", "killall", "rename",
		"spawn", "wait", "nw", "lw", "kw", "sp", "split", "kp", "send", "source", "completion", "agent":
		return a.rt.Shell(args...)
	case "-v", "--version":
		fmt.Fprintf(os.Stdout, "ttmux v%s\n", version)
		return nil
	case "ls":
		if has(rest, "--json") {
			return session.ListJSON(a.rt, a.swarmSessions(), os.Stdout)
		}
		return a.rt.Shell(args...)
	case "group":
		return a.runGroup(rest)
	case "status":
		if len(rest) >= 2 && rest[1] == "--json" {
			return group.StatusJSON(a.rt, rest[0], os.Stdout)
		}
		return a.rt.Shell(args...)
	case "capture":
		return session.Capture(a.rt, rest, os.Stdout)
	case "collect":
		if len(rest) >= 2 && rest[1] == "--json" {
			return group.CollectJSON(a.rt, rest[0], os.Stdout)
		}
		return a.rt.Shell(args...)
	case "env":
		return envelope.Run(a.rt, rest, os.Stdout)
	case "info":
		if has(rest, "--json") {
			return session.InfoJSON(a.rt, version, a.swarmSessions(), os.Stdout)
		}
		return a.rt.Shell(args...)
	case "swarm":
		return swarmcommand.Run(a.rt, rest, os.Stdout)
	default:
		return a.rt.Tmux(append([]string{cmd}, rest...)...)
	}
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
		return a.rt.Shell(append([]string{"group", subcmd}, args...)...)
	case "status":
		if len(args) >= 2 && args[1] == "--json" {
			return group.StatusJSON(a.rt, args[0], os.Stdout)
		}
		return a.rt.Shell(append([]string{"group", subcmd}, args...)...)
	case "kill":
		return a.rt.Shell(append([]string{"group", subcmd}, args...)...)
	default:
		return fmt.Errorf("unknown subcommand: group %s", subcmd)
	}
}

// swarmSessions returns the set of tmux sessions that belong to swarms so the
// native session listings hide them, matching the shell CLI's _is_swarm_session.
func (a App) swarmSessions() map[string]bool {
	return swarmcore.SessionNames(swarmcore.Options{
		HomeDir: a.rt.HomeDir,
		DataDir: a.rt.DataDir,
		TmuxBin: a.rt.TmuxBin,
		Now:     a.rt.Now,
	})
}

func has(args []string, want string) bool {
	for _, arg := range args {
		if strings.EqualFold(arg, want) {
			return true
		}
	}
	return false
}
