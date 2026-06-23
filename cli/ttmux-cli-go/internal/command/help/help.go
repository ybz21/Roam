// Package help renders the top-level usage screen (mirrors lib/help.sh).
package help

import (
	"fmt"
	"io"

	"ttmux-cli-go/internal/ui"
)

// Show prints the help screen.
func Show(version string, w io.Writer) {
	p := ui.P()
	b := func(s string) string { return ui.Bold(s) }
	g := func(s string) string { return p.Green + s + p.Reset }
	d := func(s string) string { return p.Dim + s + p.Reset }
	c := func(s string) string { return p.Cyan + s + p.Reset }
	m := func(s string) string { return p.Magenta + s + p.Reset }

	fmt.Fprintf(w, "\n  %s %s\n\n", b("ttmux"), d("v"+version+" — AI-native tmux wrapper"))
	fmt.Fprintf(w, "  %s:  ttmux %s [参数...]\n\n", b("用法"), c("<命令>"))

	fmt.Fprintf(w, "  %s\n", b("会话管理"))
	fmt.Fprintf(w, "    %s %s  列出所有会话\n", g("ls"), d("[--json]"))
	fmt.Fprintf(w, "    %s %s   新建会话\n", g("new"), d("[名称]"))
	fmt.Fprintf(w, "    %s %s   附加会话 %s\n", g("a"), d("[名称]"), d("(无参数交互选择)"))
	fmt.Fprintf(w, "    %s %s   分离会话\n", g("d"), d("[名称]"))
	fmt.Fprintf(w, "    %s %s   关闭会话\n", g("kill"), d("[名称]"))
	fmt.Fprintf(w, "    %s            关闭所有会话\n", g("killall"))
	fmt.Fprintf(w, "    %s %s  重命名会话\n\n", g("rename"), d("<旧名> <新名>"))

	fmt.Fprintf(w, "  %s %s\n", b("任务编排"), m("(命令 / Agent 统一)"))
	fmt.Fprintf(w, "    %s %s  批量创建命令任务\n", g("spawn"), d("<组名> <名称> <命令> ..."))
	fmt.Fprintf(w, "    %s %s  批量创建 Claude/Codex Agent\n", g("spawn"), d("--agent <组名> <名称> <任务> ..."))
	fmt.Fprintf(w, "    %s %s  查看状态 (命令+Agent)\n", g("status"), d("<组名> [--json]"))
	fmt.Fprintf(w, "    %s %s  等待任务组完成\n", g("wait"), d("<组名> [--timeout N]"))
	fmt.Fprintf(w, "    %s %s  收集所有任务输出\n", g("collect"), d("<组名> [--json]"))
	fmt.Fprintf(w, "    %s %s  向任务/Agent 追加指令\n", g("send"), d("<会话名> <指令>"))
	fmt.Fprintf(w, "    %s %s  列出 / 清理任务组\n", g("group"), d("ls | kill <组名>"))
	fmt.Fprintf(w, "    %s %s  捕获会话输出\n", g("capture"), d("<会话> [--lines N]"))
	fmt.Fprintf(w, "    %s\n\n", d("Agent 选项: --dir <目录>  --model <模型>  --perm <权限模式>  --max-turns <N>"))

	fmt.Fprintf(w, "  %s %s\n", b("蜂群编排"), m("(swarm — 有目标的任务组)"))
	fmt.Fprintf(w, "    %s %s  新建蜂群\n", g("swarm new"), d("<名> [--goal \"...\"] [--no-master]"))
	fmt.Fprintf(w, "    %s %s  加成员\n", g("swarm add"), d("<群> <成员> --type task|agent [--kind claude|codex] ..."))
	fmt.Fprintf(w, "    %s %s  列出 / 状态\n", g("swarm ls|status"), d("[<群>] [--json]"))
	fmt.Fprintf(w, "    %s %s  解锁挂起 / 标记完成\n", g("swarm activate|done"), d("<群> [成员]"))
	fmt.Fprintf(w, "    %s %s  cc 接管 / 归档 / 删除\n", g("swarm adopt|archive|rm"), d("<群>"))
	fmt.Fprintf(w, "    %s %s  广场: 发言 / 读流 / 监听 / 跟随\n", g("swarm say|feed|listen|watch"), d("<群> ..."))
	fmt.Fprintf(w, "    %s %s  看板: 全貌 / 卡片\n", g("swarm board|task"), d("<群> ..."))
	fmt.Fprintf(w, "    %s %s  只读查每群 swarm.db\n\n", g("swarm sql"), d("<群> [--json] \"SELECT ...\""))

	fmt.Fprintf(w, "  %s\n", b("窗口 / 窗格"))
	fmt.Fprintf(w, "    %s %s  新建窗口   %s 列出窗口   %s %s 关闭窗口\n", g("nw"), d("[名称]"), g("lw"), g("kw"), d("[窗口号]"))
	fmt.Fprintf(w, "    %s %s  分割窗格   %s 关闭窗格\n\n", g("sp"), d("[-h|-v]"), g("kp"))

	fmt.Fprintf(w, "  %s\n", b("全局环境变量"))
	fmt.Fprintf(w, "    %s %s | %s %s | %s | %s\n\n",
		g("env set"), d("<K=V>"), g("env rm"), d("<KEY>"), g("env clear"), g("env push"))

	fmt.Fprintf(w, "  %s\n", b("其他"))
	fmt.Fprintf(w, "    %s 服务器信息   %s 重载 tmux.conf   %s 安装补全   %s 显示帮助\n\n",
		g("info"), g("source"), g("completion"), g("help"))

	fmt.Fprintf(w, "  %s\n\n", d("未识别的命令会直接转发给 tmux"))
}
