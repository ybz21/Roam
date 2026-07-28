package session

import (
	"encoding/json"
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
	// 展示口径「名字(会话 id)」：名字取会话的展示名（@roam_name），id 就是 tmux 会话名
	// 本身（迁移前的老会话由 session_created + session_id 现算派生）。
	out, err := rt.TmuxOutput("list-sessions", "-F", "#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}\t#{session_id}\t#{"+runtime.LabelOption+"}")
	if err != nil {
		// tmux server 未启动时输出的是 stderr 错误文本，不能当会话数据解析
		out = ""
	}
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
		created, _ := strconv.ParseInt(parts[2], 10, 64)
		if created > 0 {
			ts = time.Unix(created, 0).Format("01-02 15:04")
		}
		row := runtime.SessionRow{Name: name, Created: created}
		if len(parts) > 4 {
			row.TmuxID = parts[4]
		}
		if len(parts) > 5 {
			row.Label = strings.TrimSpace(parts[5])
		}
		label := ui.Bold(row.DisplayLabel())
		if sid := row.ID(); sid != "" && sid != row.DisplayLabel() {
			label += p.Dim + "(" + sid + ")" + p.Reset
		}
		fmt.Fprintf(w, "   %s %s  %s%s 个窗口  %s%s  %s\n",
			ui.IconSession, label, p.Dim, parts[1], ts, p.Reset, att)
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
// directly; otherwise the user chooses on /dev/tty. 返回的永远是 tmux 会话名
// （= 会话 id）；用户可以输编号，也可以输展示名/id，后者走 Resolve。
func PickSession(rt runtime.Runtime, exclude map[string]bool, prompt string, w io.Writer) (string, error) {
	var rows []runtime.SessionRow
	for _, s := range rt.SessionRows() {
		if !exclude[s.Name] {
			rows = append(rows, s)
		}
	}
	if len(rows) == 0 {
		ui.Err(w, "没有活跃会话")
		return "", fmt.Errorf("no sessions")
	}
	if len(rows) == 1 {
		return rows[0].Name, nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "\n   %s:\n\n", ui.Bold(prompt))
	for i, s := range rows {
		fmt.Fprintf(&b, "   %d) %s\n", i+1, s.Display())
	}
	choice, ok := ui.ReadLine(b.String() + "\n   输入编号或名称: ")
	if !ok {
		return "", fmt.Errorf("no tty")
	}
	if n, err := strconv.Atoi(choice); err == nil && n >= 1 && n <= len(rows) {
		return rows[n-1].Name, nil
	}
	return rt.Resolve(choice), nil
}

// New 处理 `ttmux new [<展示名>] [--dir <path>] [--size <W>x<H>] [--detach] [--json]
// [tmux 参数…]`。
//
// 参数里的名字是**展示名**：会话本身叫 id（CreateSession 生成），名字只写进
// @roam_name。--detach/--json 供编排方（Web 后端、脚本）用：不 attach，输出
// {"session":"<id>","label":"<展示名>"}。
func New(rt runtime.Runtime, args []string, w io.Writer) error {
	opt := runtime.CreateOpts{}
	detach, asJSON, reuse := false, false, true
	var pos []string
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--dir", "-c":
			if i+1 < len(args) {
				opt.Dir = args[i+1]
				i++
			}
		case "--size":
			if i+1 < len(args) {
				opt.Width, opt.Height, _ = strings.Cut(args[i+1], "x")
				i++
			}
		case "--detach", "-d":
			detach = true
		case "--json":
			asJSON, detach = true, true
		case "--no-reuse": // 允许重名：不复用同展示名的既有会话，一律新建
			reuse = false
		default:
			pos = append(pos, args[i])
		}
	}
	rt.SetGlobalEnv()
	if len(pos) > 0 {
		opt.Label = pos[0]
		opt.Extra = pos[1:]
	}
	if opt.Label != "" && reuse {
		if target := rt.Resolve(opt.Label); rt.HasSession(target) {
			if asJSON {
				return json.NewEncoder(w).Encode(map[string]string{"session": target, "label": rt.SessionLabel(target), "reused": "1"})
			}
			ui.Warn(w, "会话 %s 已存在，正在附加...", ui.Bold(opt.Label))
			if detach {
				return nil
			}
			return rt.Tmux("attach-session", "-t", "="+target)
		}
	}
	sess, err := rt.CreateSession(opt)
	if err != nil {
		return err
	}
	if asJSON {
		return json.NewEncoder(w).Encode(map[string]string{"session": sess, "label": rt.SessionLabel(sess)})
	}
	ui.Info(w, "创建会话 %s", ui.Bold(Display(rt, sess)))
	if detach {
		return nil
	}
	return rt.Tmux("attach-session", "-t", "="+sess)
}

// Attach attaches to a session (mirrors the `a`/attach case).
func Attach(rt runtime.Runtime, exclude map[string]bool, args []string, w io.Writer) error {
	var target string
	if len(args) >= 1 {
		target = rt.Resolve(args[0])
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
	ui.Info(w, "附加到 %s", ui.Bold(Display(rt, target)))
	return rt.Tmux("attach-session", "-t", "="+target)
}

// Display 会话的展示口径「名字(id)」，供各命令回显用。
func Display(rt runtime.Runtime, name string) string {
	if row := rt.SessionRow(name); row.Name != "" {
		return row.Display()
	}
	return name
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
		target = rt.Resolve(args[0])
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
	shown := Display(rt, target)
	if !ui.Confirm("确定关闭会话 " + ui.Bold(shown) + "?") {
		ui.Info(w, "已取消")
		return nil
	}
	if err := rt.Tmux("kill-session", "-t", "="+target); err != nil {
		return err
	}
	ui.Ok(w, "会话 %s 已关闭", ui.Bold(shown))
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
		_ = rt.Tmux("kill-session", "-t", "="+s)
	}
	ui.Ok(w, "所有普通会话已关闭")
	return nil
}

// Rename 改会话的**展示名**（@roam_name）——tmux 会话名是 id，永远不动。
// 于是改名不再牵动任何按名字定位的东西：meta 外键、logs/meta 路径、group 台账、
// 前端标签与 URL 全都不受影响，重名也随便。
func Rename(rt runtime.Runtime, exclude map[string]bool, args []string, w io.Writer) (string, string, error) {
	var target, neu string
	switch {
	case len(args) >= 2:
		target, neu = rt.Resolve(args[0]), strings.Join(args[1:], " ")
	default:
		if len(args) == 1 {
			target = rt.Resolve(args[0])
		} else {
			t, err := PickSession(rt, exclude, "重命名会话", w)
			if err != nil {
				return "", "", err
			}
			target = t
		}
		n, ok := ui.ReadLine("   新名称: ")
		if !ok || n == "" {
			ui.Err(w, "名称不能为空")
			return "", "", fmt.Errorf("empty name")
		}
		neu = n
	}
	if !rt.HasSession(target) {
		ui.Err(w, "会话 %s 不存在", ui.Bold(target))
		return "", "", fmt.Errorf("session not found: %s", target)
	}
	old := rt.SessionLabel(target)
	if err := rt.SetSessionLabel(target, neu); err != nil {
		return "", "", err
	}
	ui.Ok(w, "%s → %s%s", ui.Bold(old), ui.Bold(runtime.SanitizeLabel(neu)), ui.Dim("("+target+")"))
	return target, neu, nil
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
		target = rt.Resolve(args[0])
		cmdStr = strings.Join(args[1:], " ")
	}
	if !rt.HasSession(target) {
		ui.Err(w, "会话 %s 不存在", ui.Bold(target))
		return fmt.Errorf("session not found: %s", target)
	}
	// 用粘贴缓冲 + 独立回车提交：TUI Agent(Claude/Codex)会把 send-keys 里
	// 尾随的 C-m 当成输入换行而非提交，导致「只打字不发送」。SendPromptSubmit
	// 走 paste-buffer 落文本再单独按回车，对多行 prompt 和 TUI 都可靠。
	// pane 目标的精确匹配要写成 "=名:"（tmux 3.4 对裸 "=名" 报 can't find pane）
	rt.SendPromptSubmit("="+target+":", cmdStr)
	ui.Ok(w, "已发送到 %s: %s", ui.Bold(Display(rt, target)), ui.Dim(cmdStr))
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
