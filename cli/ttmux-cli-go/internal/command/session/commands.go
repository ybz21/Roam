package session

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"ttmux-cli-go/internal/runtime"
	"ttmux-cli-go/internal/ui"
)

// List renders the human-readable session table (mirrors _pretty_sessions),
// hiding swarm-owned sessions via exclude.
func List(rt runtime.Runtime, exclude map[string]bool, w io.Writer) error {
	out, _ := rt.TmuxOutput("list-sessions", "-F", "#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}")
	p := ui.P()
	fmt.Fprintln(w)
	count := 0
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) < 4 {
			continue
		}
		name := parts[0]
		if exclude[name] {
			continue
		}
		att := ui.Dim("[空闲]")
		if parts[3] != "0" && parts[3] != "" {
			att = p.Green + "[已连接]" + p.Reset
		}
		ts := parts[2]
		if sec, err := strconv.ParseInt(parts[2], 10, 64); err == nil {
			ts = time.Unix(sec, 0).Format("01-02 15:04")
		}
		fmt.Fprintf(w, "   %s %s  %s%s 个窗口  %s%s  %s\n",
			ui.IconSession, ui.Bold(name), p.Dim, parts[1], ts, p.Reset, att)
		count++
	}
	if count == 0 {
		ui.Info(w, "没有活跃会话")
		return nil
	}
	fmt.Fprintln(w)
	fmt.Fprintf(w, "   %s共 %d 个会话%s\n\n", p.Dim, count, p.Reset)
	return nil
}

// PickSession reproduces _pick_session: a single non-swarm session is returned
// directly; otherwise the user chooses on /dev/tty.
func PickSession(rt runtime.Runtime, exclude map[string]bool, prompt string, w io.Writer) (string, error) {
	var names []string
	for _, s := range rt.Sessions() {
		if !exclude[s] {
			names = append(names, s)
		}
	}
	if len(names) == 0 {
		ui.Err(w, "没有活跃会话")
		return "", fmt.Errorf("no sessions")
	}
	if len(names) == 1 {
		return names[0], nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "\n   %s:\n\n", ui.Bold(prompt))
	for i, s := range names {
		fmt.Fprintf(&b, "   %d) %s\n", i+1, s)
	}
	choice, ok := ui.ReadLine(b.String() + "\n   输入编号或名称: ")
	if !ok {
		return "", fmt.Errorf("no tty")
	}
	if n, err := strconv.Atoi(choice); err == nil && n >= 1 && n <= len(names) {
		return names[n-1], nil
	}
	return choice, nil
}

// New creates (or attaches to) a session (mirrors the `new` case).
func New(rt runtime.Runtime, args []string, w io.Writer) error {
	if len(args) == 0 {
		rt.SetGlobalEnv()
		return rt.Tmux("new-session")
	}
	name := args[0]
	if rt.HasSession(name) {
		ui.Warn(w, "会话 %s 已存在，正在附加...", ui.Bold(name))
		return rt.Tmux("attach-session", "-t", name)
	}
	ui.Info(w, "创建会话 %s", ui.Bold(name))
	rt.SetGlobalEnv()
	return rt.Tmux(append([]string{"new-session", "-s", name}, args[1:]...)...)
}

// Attach attaches to a session (mirrors the `a`/attach case).
func Attach(rt runtime.Runtime, exclude map[string]bool, args []string, w io.Writer) error {
	var target string
	if len(args) >= 1 {
		target = args[0]
	} else {
		t, err := PickSession(rt, exclude, "附加到会话", w)
		if err != nil {
			return err
		}
		target = t
	}
	if !rt.HasSession(target) {
		ui.Err(w, "会话 %s 不存在", ui.Bold(target))
		return fmt.Errorf("session not found: %s", target)
	}
	ui.Info(w, "附加到 %s", ui.Bold(target))
	return rt.Tmux("attach-session", "-t", target)
}

// Detach mirrors the `d`/detach case.
func Detach(rt runtime.Runtime, args []string, w io.Writer) error {
	if err := rt.Tmux(append([]string{"detach-client"}, args...)...); err != nil {
		return err
	}
	ui.Ok(w, "已分离")
	return nil
}

// Kill kills one session after confirmation (mirrors the `kill` case).
func Kill(rt runtime.Runtime, exclude map[string]bool, args []string, w io.Writer) error {
	var target string
	if len(args) >= 1 {
		target = args[0]
	} else {
		t, err := PickSession(rt, exclude, "关闭会话", w)
		if err != nil {
			return err
		}
		target = t
	}
	if !rt.HasSession(target) {
		ui.Err(w, "会话 %s 不存在", ui.Bold(target))
		return fmt.Errorf("session not found: %s", target)
	}
	if !ui.Confirm("确定关闭会话 " + ui.Bold(target) + "?") {
		ui.Info(w, "已取消")
		return nil
	}
	if err := rt.Tmux("kill-session", "-t", target); err != nil {
		return err
	}
	ui.Ok(w, "会话 %s 已关闭", ui.Bold(target))
	return nil
}

// KillAll kills every non-swarm session after confirmation.
func KillAll(rt runtime.Runtime, exclude map[string]bool, w io.Writer) error {
	var names []string
	for _, s := range rt.Sessions() {
		if !exclude[s] {
			names = append(names, s)
		}
	}
	if len(names) == 0 {
		ui.Info(w, "没有活跃会话")
		return nil
	}
	if !ui.Confirm(fmt.Sprintf("确定关闭全部 %d 个会话?", len(names))) {
		ui.Info(w, "已取消")
		return nil
	}
	for _, s := range names {
		_ = rt.Tmux("kill-session", "-t", s)
	}
	ui.Ok(w, "所有普通会话已关闭")
	return nil
}

// Rename renames a session (mirrors the `rename` case).
func Rename(rt runtime.Runtime, exclude map[string]bool, args []string, w io.Writer) error {
	var old, neu string
	switch {
	case len(args) >= 2:
		old, neu = args[0], args[1]
	default:
		if len(args) == 1 {
			old = args[0]
		} else {
			t, err := PickSession(rt, exclude, "重命名会话", w)
			if err != nil {
				return err
			}
			old = t
		}
		n, ok := ui.ReadLine("   新名称: ")
		if !ok || n == "" {
			ui.Err(w, "名称不能为空")
			return fmt.Errorf("empty name")
		}
		neu = n
	}
	if err := rt.Tmux("rename-session", "-t", old, neu); err != nil {
		return err
	}
	ui.Ok(w, "%s → %s", ui.Bold(old), ui.Bold(neu))
	return nil
}

// Send sends a command line to a session (mirrors the top-level `send` case).
func Send(rt runtime.Runtime, exclude map[string]bool, args []string, w io.Writer) error {
	if len(args) < 1 {
		ui.Err(w, "用法: ttmux send [会话名] <命令>")
		return fmt.Errorf("usage")
	}
	var target, cmdStr string
	if len(args) == 1 {
		t, err := PickSession(rt, exclude, "发送命令到", w)
		if err != nil {
			return err
		}
		target, cmdStr = t, args[0]
	} else {
		target = args[0]
		cmdStr = strings.Join(args[1:], " ")
	}
	if !rt.HasSession(target) {
		ui.Err(w, "会话 %s 不存在", ui.Bold(target))
		return fmt.Errorf("session not found: %s", target)
	}
	if err := rt.Tmux("send-keys", "-t", target, cmdStr, "C-m"); err != nil {
		return err
	}
	ui.Ok(w, "已发送到 %s: %s", ui.Bold(target), ui.Dim(cmdStr))
	return nil
}

// Source reloads ~/.tmux.conf (mirrors the `source` case).
func Source(rt runtime.Runtime, w io.Writer) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	path := filepath.Join(home, ".tmux.conf")
	if _, err := os.Stat(path); err != nil {
		ui.Err(w, "未找到 ~/.tmux.conf")
		return fmt.Errorf("no tmux.conf")
	}
	if err := rt.Tmux("source-file", path); err != nil {
		return err
	}
	ui.Ok(w, "配置已重载")
	return nil
}
