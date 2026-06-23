// Package interactive implements the menu-driven mode (mirrors lib/interactive.sh).
// Real actions are dispatched through the native command router (run), so the
// interactive paths behave identically to the equivalent CLI invocations.
package interactive

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"ttmux-cli-go/internal/runtime"
	swarmcore "ttmux-cli-go/internal/swarm"
	"ttmux-cli-go/internal/ui"
)

// Runner dispatches a CLI argument vector (typically app.Run).
type Runner func(args []string) error

type menu struct {
	rt  runtime.Runtime
	run Runner
	st  *swarmcore.Store
}

// Run starts the interactive loop.
func Run(rt runtime.Runtime, version string, run Runner) error {
	m := &menu{rt: rt, run: run, st: swarmcore.NewStore(swarmcore.Options{
		HomeDir: rt.HomeDir, DataDir: rt.DataDir, TmuxBin: rt.TmuxBin, Now: rt.Now,
	})}
	for {
		m.header(version)
		m.mainMenu()
		choice, _ := ui.ReadLine("  选择操作: ")
		fmt.Println()
		switch choice {
		case "1":
			_ = m.run([]string{"ls"})
			m.pause()
		case "2":
			name, _ := ui.ReadLine("  会话名称 (空=自动): ")
			if name == "" {
				_ = m.run([]string{"new"})
			} else {
				_ = m.run([]string{"new", name})
			}
		case "3":
			_ = m.run([]string{"a"})
		case "4":
			_ = m.run([]string{"kill"})
			m.pause()
		case "5":
			m.swarmMenu()
		case "6":
			for _, g := range m.groups() {
				_ = m.run([]string{"status", g})
			}
			_ = m.run([]string{"ls"})
			m.pause()
		case "7":
			m.waitCollect()
			m.pause()
		case "8":
			m.taskSend()
			m.pause()
		case "9":
			m.groupKill()
			m.pause()
		case "s":
			if t, ok := m.pickSession("发送命令到"); ok {
				if cmd, _ := ui.ReadLine("  命令: "); cmd != "" {
					_ = m.run([]string{"send", t, cmd})
				}
			}
			m.pause()
		case "h":
			_ = m.run([]string{"help"})
			m.pause()
		case "q", "0", "":
			fmt.Printf("  %sbye%s\n\n", ui.P().Dim, ui.P().Reset)
			return nil
		default:
			ui.Warn(os.Stdout, "无效选择")
			m.pause()
		}
	}
}

func (m *menu) header(version string) {
	clear()
	p := ui.P()
	fmt.Printf("\n  %s %s  %s\n", ui.Bold("ttmux"), ui.Dim("v"+version), ui.Dim("— 交互模式 (q 退出)"))
	fmt.Printf("  %s%s%s\n", p.Dim, strings.Repeat("─", 44), p.Reset)
	swarms, _ := m.st.ListSwarms()
	fmt.Printf("  %s会话: %s%s%d%s%s  任务组: %s%s%d%s%s  蜂群: %s%s%d%s\n\n",
		p.Dim, p.Reset, p.Bold, len(m.rt.Sessions()), p.Reset, p.Dim, p.Reset, p.Bold, len(m.groups()), p.Reset, p.Dim, p.Reset, p.Bold, len(swarms), p.Reset)
}

func (m *menu) mainMenu() {
	p := ui.P()
	c := func(s string) string { return p.Cyan + s + p.Reset }
	fmt.Printf("  %s\n", ui.Bold("会话"))
	fmt.Printf("    %s) 列出会话          %s) 新建会话\n", c("1"), c("2"))
	fmt.Printf("    %s) 附加会话          %s) 关闭会话\n\n", c("3"), c("4"))
	fmt.Printf("  %s %s\n", ui.Bold("任务编排"), p.Magenta+"(蜂群 / swarm)"+p.Reset)
	fmt.Printf("    %s) 蜂群编排 ▸        %s) 状态总览\n", c("5"), c("6"))
	fmt.Printf("    %s) 等待并收集        %s) 追加指令\n", c("7"), c("8"))
	fmt.Printf("    %s) 清理任务组\n\n", c("9"))
	fmt.Printf("  %s\n", ui.Bold("其他"))
	fmt.Printf("    %s) 发送命令          %s) 帮助\n\n", c("s"), c("h"))
}

func (m *menu) waitCollect() {
	g, ok := m.pickGroup("选择任务组")
	if !ok {
		return
	}
	_ = m.run([]string{"status", g})
	p := ui.P()
	fmt.Printf("  %s\n", ui.Bold("操作:"))
	fmt.Printf("    %s1%s) 等待完成  %s2%s) 收集输出  %s3%s) 两者都做  %s0%s) 返回\n", p.Cyan, p.Reset, p.Cyan, p.Reset, p.Cyan, p.Reset, p.Cyan, p.Reset)
	action, _ := ui.ReadLine("  选择: ")
	switch action {
	case "1":
		_ = m.run([]string{"wait", g})
	case "2":
		_ = m.run([]string{"collect", g})
	case "3":
		_ = m.run([]string{"wait", g})
		_ = m.run([]string{"collect", g})
	}
}

func (m *menu) taskSend() {
	g, ok := m.pickGroup("选择任务组")
	if !ok {
		return
	}
	members, _ := m.rt.GroupSessions(g)
	if len(members) == 0 {
		ui.Info(os.Stdout, "该任务组还没有成员")
		return
	}
	if sel, ok := m.pickFrom("任务列表", members, m.runningLabel); ok {
		if msg, _ := ui.ReadLine("  追加指令: "); msg != "" {
			_ = m.run([]string{"send", sel, msg})
		}
	}
}

func (m *menu) groupKill() {
	groups := m.groups()
	if len(groups) == 0 {
		ui.Info(os.Stdout, "没有任务组")
		return
	}
	p := ui.P()
	fmt.Printf("\n  %s\n", ui.Bold("选择要清理的任务组:"))
	fmt.Printf("    %s0%s) %s全部清理%s\n", p.Cyan, p.Reset, p.Red, p.Reset)
	for i, g := range groups {
		fmt.Printf("    %s%d%s) %s\n", p.Cyan, i+1, p.Reset, g)
	}
	choice, _ := ui.ReadLine("\n  编号: ")
	if choice == "0" {
		if ui.Confirm(fmt.Sprintf("确定清理全部 %d 个任务组?", len(groups))) {
			for _, g := range groups {
				_ = m.run([]string{"group", "kill", g})
			}
		}
		return
	}
	if n, err := strconv.Atoi(choice); err == nil && n >= 1 && n <= len(groups) {
		_ = m.run([]string{"group", "kill", groups[n-1]})
	}
}

// ── helpers ──

func clear() { fmt.Print("\033[H\033[2J") }

func (m *menu) pause() {
	_, _ = ui.ReadLine("\n  按回车继续...")
}

func (m *menu) groups() []string {
	matches, _ := filepath.Glob(filepath.Join(m.rt.GroupsDir, "*.group"))
	var out []string
	for _, f := range matches {
		out = append(out, strings.TrimSuffix(filepath.Base(f), ".group"))
	}
	return out
}

func (m *menu) runningLabel(sess string) string {
	if m.rt.HasSession(sess) {
		return " " + ui.P().Yellow + "运行中" + ui.P().Reset
	}
	return " " + ui.Dim("已结束")
}

func (m *menu) pickSession(prompt string) (string, bool) {
	var names []string
	excl := swarmcore.SessionNames(m.st.Options())
	for _, s := range m.rt.Sessions() {
		if !excl[s] {
			names = append(names, s)
		}
	}
	return m.pickFrom(prompt, names, nil)
}

func (m *menu) pickGroup(prompt string) (string, bool) {
	return m.pickFrom(prompt, m.groups(), nil)
}

// pickFrom prints a numbered list and returns the chosen item.
func (m *menu) pickFrom(prompt string, items []string, label func(string) string) (string, bool) {
	if len(items) == 0 {
		ui.Info(os.Stdout, "没有可选项")
		return "", false
	}
	if len(items) == 1 {
		return items[0], true
	}
	p := ui.P()
	fmt.Printf("\n  %s:\n", ui.Bold(prompt))
	for i, it := range items {
		suffix := ""
		if label != nil {
			suffix = label(it)
		}
		fmt.Printf("    %s%d%s) %s%s\n", p.Cyan, i+1, p.Reset, it, suffix)
	}
	choice, _ := ui.ReadLine("\n  编号: ")
	if n, err := strconv.Atoi(choice); err == nil && n >= 1 && n <= len(items) {
		return items[n-1], true
	}
	return "", false
}
