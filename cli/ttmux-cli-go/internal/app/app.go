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
	plugincmd "ttmux-cli-go/internal/command/plugin"
	"ttmux-cli-go/internal/command/session"
	"ttmux-cli-go/internal/command/spawn"
	swarmcommand "ttmux-cli-go/internal/command/swarm"
	"ttmux-cli-go/internal/runtime"
	"ttmux-cli-go/internal/sessmeta"
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
	case "_plugin-host": // 插件子进程入口(stdio JSON-RPC,勿直接调用)
		return plugincmd.HostMain(rest)

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
		if has(rest, "--tree") {
			if has(rest, "--json") {
				return session.TreeJSON(a.rt, a.meta(), a.swarmSessions(), out)
			}
			return session.Tree(a.rt, a.meta(), a.swarmSessions(), out)
		}
		if has(rest, "--json") {
			return session.ListJSON(a.rt, a.swarmSessions(), out)
		}
		return session.List(a.rt, a.swarmSessions(), out)
	case "new":
		return session.New(a.rt, rest, out)
	// ── subSession（fork/树/parent，设计 07 §2.1）──
	case "fork":
		return session.Fork(a.rt, a.meta(), rest, out)
	case "children":
		return session.Children(a.rt, a.meta(), rest, out)
	case "parent":
		return session.ParentCmd(a.rt, a.meta(), rest, out)
	case "a", "attach":
		return session.Attach(a.rt, a.swarmSessions(), rest, out)
	case "d", "detach":
		return session.Detach(a.rt, rest, out)
	case "kill":
		return session.KillTree(a.rt, a.meta(), a.swarmSessions(), rest, out)
	case "killall":
		return session.KillAll(a.rt, a.swarmSessions(), out)
	case "rename":
		if err := session.Rename(a.rt, a.swarmSessions(), rest, out); err != nil {
			return err
		}
		if len(rest) >= 2 { // 显式双参改名成功后同步 meta 外键
			_ = a.meta().OnRename(rest[0], rest[1])
		}
		return nil
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

	// ── native helpers ──
	case "capture":
		return session.Capture(a.rt, rest, out)
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

	// ── plugins(default 分支透传 tmux,必须显式注册)──
	case "plugin":
		return plugincmd.Run(a.rt, rest, out)

	default:
		return a.rt.Tmux(append([]string{cmd}, rest...)...)
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

// swarmSessions returns the set of tmux sessions hidden from native session
// listings: swarm members (matching the shell CLI's _is_swarm_session) plus
// `_ttmux-` 命名空间的基础设施会话(如插件守护进程 _ttmux-plugind)——
// 从列表和 killall 中隐藏防止被顺手关掉;显式指名 attach/kill 不受影响。
// 只收窄到自家前缀:用户自己起的 _xxx 会话不受影响,照常显示。
func (a App) swarmSessions() map[string]bool {
	set := swarmcore.SessionNames(a.swarmOptions())
	for _, s := range a.rt.Sessions() {
		if strings.HasPrefix(s, "_ttmux-") {
			set[s] = true
		}
	}
	return set
}

// swarmNames returns the set of swarm names so the group listing hides them.
func (a App) swarmNames() map[string]bool {
	return swarmcore.Names(a.swarmOptions())
}

func (a App) meta() *sessmeta.Store { return sessmeta.New(a.rt.HomeDir) }

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
