// Package plugincmd implements `ttmux plugin ...` and the hidden
// `_plugin-host` runner(CLI 面见 docs/design/plugin/02-product.md 4.4)。
package plugincmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/user"
	"strings"
	"time"

	"ttmux-cli-go/internal/plugin"
	"ttmux-cli-go/internal/plugin/builtin"
	"ttmux-cli-go/internal/plugin/sdk"
	"ttmux-cli-go/internal/runtime"
	"ttmux-cli-go/internal/ui"
)

// Run dispatches `ttmux plugin <subcommand>`.
func Run(rt runtime.Runtime, args []string, out io.Writer) error {
	sub := "help"
	if len(args) > 0 {
		sub = args[0]
		args = args[1:]
	}
	env := plugin.NewEnv(rt)
	switch sub {
	case "ls", "list":
		return list(env, args, out)
	case "info":
		return info(env, args, out)
	case "enable", "disable":
		return setEnabled(env, sub == "enable", args, out)
	case "run":
		return runCommand(env, args, out)
	case "config":
		return config(env, args, out)
	case "findings":
		return findings(env, args, out)
	case "notifications":
		return notifications(env, args, out)
	case "audit":
		return audit(env, args, out)
	case "status":
		return status(env, out)
	case "daemon":
		if hasFlag(args, "--foreground") {
			return plugin.RunDaemonForeground(env)
		}
		if err := plugin.EnsureDaemon(env); err != nil {
			return err
		}
		ui.Ok(out, "plugind 已运行(tmux 会话 %s,查看: ttmux a %s)", plugin.DaemonSession, plugin.DaemonSession)
		return nil
	case "help", "-h", "--help":
		help(out)
		return nil
	}
	return fmt.Errorf("unknown subcommand: plugin %s (see: ttmux plugin help)", sub)
}

// HostMain runs the hidden `_plugin-host <id>` builtin plugin process.
func HostMain(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: ttmux _plugin-host <plugin-id>")
	}
	b, ok := builtin.Find(args[0])
	if !ok {
		return fmt.Errorf("unknown builtin plugin: %s", args[0])
	}
	sdk.Serve(b.Activate)
	return nil
}

func openStore(env plugin.Env) (*plugin.Store, error) {
	store, err := plugin.Open(env)
	if err != nil {
		return nil, err
	}
	if err := plugin.SyncBuiltins(store); err != nil {
		store.Close()
		return nil, err
	}
	return store, nil
}

func list(env plugin.Env, args []string, out io.Writer) error {
	store, err := openStore(env)
	if err != nil {
		return err
	}
	defer store.Close()
	plugins, err := store.List()
	if err != nil {
		return err
	}
	if hasFlag(args, "--json") {
		return printJSON(out, plugins)
	}
	for _, p := range plugins {
		state := ui.Dim("disabled")
		if p.Enabled {
			state = "enabled"
		}
		fmt.Fprintf(out, "%-22s %-8s %-9s %s\n", ui.Bold(p.Manifest.Name), p.Manifest.Version, state,
			p.Manifest.Description.Get("zh-CN"))
		for _, c := range p.Manifest.Contributes.Commands {
			fmt.Fprintf(out, "    · ttmux plugin run %-28s %s\n", c.ID, ui.Dim(c.Title.Get("zh-CN")))
		}
	}
	return nil
}

func info(env plugin.Env, args []string, out io.Writer) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: ttmux plugin info <id> [--json]")
	}
	store, err := openStore(env)
	if err != nil {
		return err
	}
	defer store.Close()
	p, err := store.Get(args[0])
	if err != nil {
		return err
	}
	return printJSON(out, p)
}

func setEnabled(env plugin.Env, enabled bool, args []string, out io.Writer) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: ttmux plugin enable|disable <id>")
	}
	store, err := openStore(env)
	if err != nil {
		return err
	}
	defer store.Close()
	if err := store.SetEnabled(args[0], enabled); err != nil {
		return err
	}
	verb := "已禁用"
	if enabled {
		verb = "已启用"
	}
	ui.Ok(out, "插件 %s %s", ui.Bold(args[0]), verb)
	return nil
}

func runCommand(env plugin.Env, args []string, out io.Writer) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: ttmux plugin run <plugin>.<command> [--key value ...]")
	}
	commandID := args[0]
	flags := parseFlags(args[1:])
	store, err := openStore(env)
	if err != nil {
		return err
	}
	defer store.Close()
	p, handler, err := store.FindCommand(commandID)
	if err != nil {
		return err
	}
	wd, _ := os.Getwd()
	hosted, err := plugin.StartPlugin(env, store, p, actor(), wd, 0)
	if err != nil {
		return err
	}
	defer hosted.Close()
	result, err := hosted.Invoke(handler, flags, time.Hour)
	if err != nil {
		return err
	}
	return printRaw(out, result)
}

func config(env plugin.Env, args []string, out io.Writer) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: ttmux plugin config <id> [set <key> <value> | unset <key>]")
	}
	store, err := openStore(env)
	if err != nil {
		return err
	}
	defer store.Close()
	p, err := store.Get(args[0])
	if err != nil {
		return err
	}
	id := p.Manifest.ID
	cfg, err := env.LoadConfig(id)
	if err != nil {
		return err
	}
	switch {
	case len(args) >= 4 && args[1] == "set":
		cfg[args[2]] = args[3]
		if err := env.SaveConfig(id, cfg); err != nil {
			return err
		}
		ui.Ok(out, "%s.%s 已设置", p.Manifest.Name, args[2])
		return nil
	case len(args) >= 3 && args[1] == "unset":
		delete(cfg, args[2])
		if err := env.SaveConfig(id, cfg); err != nil {
			return err
		}
		ui.Ok(out, "%s.%s 已删除", p.Manifest.Name, args[2])
		return nil
	default:
		masked := map[string]string{}
		for k, v := range cfg {
			if isSecretKey(p.Manifest, k) && len(v) > 8 {
				v = v[:8] + "…"
			}
			masked[k] = v
		}
		return printJSON(out, masked)
	}
}

func isSecretKey(m plugin.Manifest, key string) bool {
	for _, s := range m.Permissions.Secrets {
		if s == key {
			return true
		}
	}
	return false
}

func findings(env plugin.Env, args []string, out io.Writer) error {
	store, err := openStore(env)
	if err != nil {
		return err
	}
	defer store.Close()
	rows, err := store.Findings("", "", "")
	if err != nil {
		return err
	}
	if hasFlag(args, "--json") {
		return printJSON(out, rows)
	}
	for _, f := range rows {
		loc := f.File
		if f.Line > 0 {
			loc = fmt.Sprintf("%s:%d", f.File, f.Line)
		}
		fmt.Fprintf(out, "#%-4d %-7s %-8s %-24s %s %s\n", f.ID, f.Severity, f.Status, loc, f.Title, ui.Dim(f.Job))
	}
	return nil
}

func notifications(env plugin.Env, args []string, out io.Writer) error {
	store, err := openStore(env)
	if err != nil {
		return err
	}
	defer store.Close()
	rows, err := store.Notifications(50)
	if err != nil {
		return err
	}
	if hasFlag(args, "--json") {
		return printJSON(out, rows)
	}
	for _, n := range rows {
		fmt.Fprintf(out, "%s [%s] %s %s\n", n.Created, n.Type, n.Title, ui.Dim(n.Source))
	}
	return nil
}

func audit(env plugin.Env, args []string, out io.Writer) error {
	pluginID := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "--") {
		store, err := openStore(env)
		if err != nil {
			return err
		}
		p, err := store.Get(args[0])
		store.Close()
		if err != nil {
			return err
		}
		pluginID = p.Manifest.ID
	}
	entries, err := env.AuditTail(pluginID, 100)
	if err != nil {
		return err
	}
	if hasFlag(args, "--json") {
		return printJSON(out, entries)
	}
	for _, e := range entries {
		mark := ""
		if e.Decision == "denied" {
			mark = ui.Bold(" DENIED")
		}
		fmt.Fprintf(out, "%s %-20s %-22s %-30s%s %s\n", e.Time, e.Plugin, e.Action, e.Target, mark, ui.Dim(e.Result))
	}
	return nil
}

func status(env plugin.Env, out io.Writer) error {
	st := plugin.DaemonStatus(env)
	if st == nil {
		fmt.Fprintf(out, "plugind: %s(启动: ttmux plugin daemon)\n", ui.Dim("not running"))
	} else {
		fmt.Fprintf(out, "plugind: running pid=%.0f enabled=%.0f/%.0f watching=%.0f sessions\n",
			asF(st["pid"]), asF(st["enabled"]), asF(st["plugins"]), asF(st["watchedSessions"]))
	}
	store, err := openStore(env)
	if err != nil {
		return err
	}
	defer store.Close()
	running, _ := store.Sessions("", "running")
	for _, r := range running {
		fmt.Fprintf(out, "  · %s %s job=%s\n", r.Session, ui.Dim(r.Plugin), r.Job)
	}
	return nil
}

func help(out io.Writer) {
	fmt.Fprint(out, `用法: ttmux plugin <子命令>

  ls [--json]                         列出插件与其命令
  info <id> [--json]                  插件详情(manifest、权限、状态)
  enable|disable <id>                 启用 / 禁用插件
  run <插件>.<命令> [--key value ...]  调用插件命令(如 review-mesh.review)
  config <id> [set k v | unset k]     查看 / 修改插件配置
  findings [--json]                   查看互审 finding
  notifications [--json]              查看通知流
  audit [<id>] [--json]               查看审计日志
  status                              守护进程与会话状态
  daemon [--foreground]               启动 plugind(异步事件收尾需要)

示例:
  ttmux plugin run review-mesh.review              # 互审当前工作区变更
  ttmux plugin config feishu-bridge set webhook <url>
  ttmux plugin run feishu-bridge.test              # 发送飞书测试卡片
`)
}

// ── helpers ──

func actor() string {
	if u, err := user.Current(); err == nil {
		return "cli:" + u.Username
	}
	return "cli:user"
}

// parseFlags turns [--k v --flag] into {k:v, flag:"true"}.
func parseFlags(args []string) map[string]string {
	out := map[string]string{}
	for i := 0; i < len(args); i++ {
		if !strings.HasPrefix(args[i], "--") {
			continue
		}
		key := strings.TrimPrefix(args[i], "--")
		if i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") {
			out[key] = args[i+1]
			i++
		} else {
			out[key] = "true"
		}
	}
	return out
}

func asF(v any) float64 {
	f, _ := v.(float64) // JSON 数字解码为 float64
	return f
}

func hasFlag(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

func printJSON(out io.Writer, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	fmt.Fprintln(out, string(b))
	return nil
}

func printRaw(out io.Writer, raw json.RawMessage) error {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		fmt.Fprintln(out, string(raw))
		return nil
	}
	return printJSON(out, v)
}
