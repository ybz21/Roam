// subSession 原语：fork / children / parent / ls --tree。
// 设计见 docs/design/web/07-worktree.md §2.1/§2.2 —— tmux 会话保持平坦，
// parent 只是 meta.db sessions 表上的字段（PPID），树是投影。
// ttmux 不理解 worktree：--dir 永远只是普通工作目录。
package session

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"ttmux-cli-go/internal/runtime"
	"ttmux-cli-go/internal/sessmeta"
	"ttmux-cli-go/internal/ui"
)

// CurrentSession 返回当前所处 tmux 会话名（不在 tmux 里返回空）。
func CurrentSession(rt runtime.Runtime) string {
	if os.Getenv("TMUX") == "" {
		return ""
	}
	out, err := rt.TmuxOutput("display-message", "-p", "#S")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// paneCwd 返回会话活动 pane 的 cwd。
// 注意 display-message 对 "=name" 精确目标会静默输出空串，须走 list-panes。
func paneCwd(rt runtime.Runtime, sess string) string {
	out, err := rt.TmuxOutput("list-panes", "-t", "="+sess, "-F", "#{pane_active}\t#{pane_current_path}")
	if err != nil {
		return ""
	}
	first := ""
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		active, cwd, ok := strings.Cut(line, "\t")
		if !ok {
			continue
		}
		if first == "" {
			first = cwd
		}
		if active == "1" {
			return cwd
		}
	}
	return first
}

// Fork 处理 `ttmux fork [<父>] <子> [--dir <path>] [--detach] [--json]`。
// 子继承父的 cwd（可被 --dir 覆盖）与全局 env；meta 记 parent。
func Fork(rt runtime.Runtime, meta *sessmeta.Store, args []string, w io.Writer) error {
	var pos []string
	dir, detach, asJSON := "", false, false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--dir", "-c":
			if i+1 < len(args) {
				dir = args[i+1]
				i++
			}
		case "--detach", "-d":
			detach = true
		case "--json":
			asJSON = true
		default:
			pos = append(pos, args[i])
		}
	}
	var parent, child string
	switch len(pos) {
	case 1:
		parent, child = CurrentSession(rt), pos[0]
		if parent == "" {
			return fmt.Errorf("not inside tmux: specify parent explicitly (ttmux fork <parent> <child>)")
		}
	case 2:
		parent, child = pos[0], pos[1]
	default:
		return fmt.Errorf("usage: ttmux fork [<parent>] <child> [--dir <path>] [--detach] [--json]")
	}
	if !rt.HasSession(parent) {
		return fmt.Errorf("parent session not found: %s", parent)
	}
	if rt.HasSession(child) {
		return fmt.Errorf("session already exists: %s", child)
	}
	if dir == "" {
		dir = paneCwd(rt, parent)
	}
	rt.SetGlobalEnv()
	tmuxArgs := []string{"new-session", "-d", "-s", child}
	if dir != "" {
		tmuxArgs = append(tmuxArgs, "-c", dir)
	}
	if err := rt.Tmux(tmuxArgs...); err != nil {
		return err
	}
	rt.InjectEnv(child)
	if err := meta.Put(sessmeta.Row{Session: child, Parent: parent, CreatedBy: "fork", InitialCwd: dir}); err != nil {
		// meta 失败不回滚会话（会话可用只是没了 parent 关系），但要让调用方知道
		ui.Warn(w, "会话已创建但写入 parent 元数据失败: %v", err)
	}
	if asJSON {
		return json.NewEncoder(w).Encode(map[string]string{"session": child, "parent": parent, "cwd": dir})
	}
	ui.Ok(w, "fork %s → %s (cwd %s)", ui.Bold(parent), ui.Bold(child), dir)
	if !detach && IsTerminal() {
		return rt.Tmux("attach-session", "-t", "="+child)
	}
	return nil
}

// Children 输出直接子会话（--json 为数组）。
func Children(rt runtime.Runtime, meta *sessmeta.Store, args []string, w io.Writer) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: ttmux children <session> [--json]")
	}
	meta.Reconcile(aliveSet(rt))
	kids := meta.Children(args[0])
	if has(args, "--json") {
		if kids == nil {
			kids = []string{}
		}
		return json.NewEncoder(w).Encode(kids)
	}
	for _, k := range kids {
		fmt.Fprintln(w, k)
	}
	return nil
}

// ParentCmd 处理 `ttmux parent set|clear|get <child> [<parent>]`。
func ParentCmd(rt runtime.Runtime, meta *sessmeta.Store, args []string, w io.Writer) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: ttmux parent set <child> <parent> | clear <child> | get <child>")
	}
	op, child := args[0], args[1]
	switch op {
	case "set":
		if len(args) < 3 {
			return fmt.Errorf("usage: ttmux parent set <child> <parent>")
		}
		parent := args[2]
		if !rt.HasSession(parent) {
			return fmt.Errorf("parent session not found: %s", parent)
		}
		if !rt.HasSession(child) {
			return fmt.Errorf("session not found: %s", child)
		}
		if err := meta.SetParent(child, parent); err != nil {
			return err
		}
		ui.Ok(w, "parent(%s) = %s", ui.Bold(child), ui.Bold(parent))
	case "clear":
		if err := meta.SetParent(child, ""); err != nil {
			return err
		}
		ui.Ok(w, "parent(%s) 已清空", ui.Bold(child))
	case "get":
		fmt.Fprintln(w, meta.Parent(child))
	default:
		return fmt.Errorf("unknown parent op: %s", op)
	}
	return nil
}

type treeNode struct {
	Name         string      `json:"name"`
	Windows      int         `json:"windows"`
	Created      string      `json:"created"`
	Attached     int         `json:"attached"`
	LastActivity string      `json:"last_activity"`
	Cwd          string      `json:"cwd,omitempty"`
	Parent       string      `json:"parent,omitempty"`
	CreatedBy    string      `json:"created_by,omitempty"`
	Children     []*treeNode `json:"children,omitempty"`
}

// TreeJSON 输出 parent 投影的会话森林（含每会话活动 pane cwd）。
func TreeJSON(rt runtime.Runtime, meta *sessmeta.Store, exclude map[string]bool, w io.Writer) error {
	nodes, roots := buildTree(rt, meta, exclude)
	_ = nodes
	if roots == nil {
		roots = []*treeNode{}
	}
	return json.NewEncoder(w).Encode(roots)
}

// Tree 人类可读树。
func Tree(rt runtime.Runtime, meta *sessmeta.Store, exclude map[string]bool, w io.Writer) error {
	_, roots := buildTree(rt, meta, exclude)
	var walk func(n *treeNode, prefix string, last bool)
	walk = func(n *treeNode, prefix string, last bool) {
		branch := "├─ "
		next := prefix + "│  "
		if last {
			branch = "└─ "
			next = prefix + "   "
		}
		if prefix == "" {
			branch, next = "", "   "
		}
		fmt.Fprintf(w, "%s%s%s  %s\n", prefix, branch, ui.Bold(n.Name), ui.Dim(n.Cwd))
		for i, c := range n.Children {
			walk(c, next, i == len(n.Children)-1)
		}
	}
	for _, r := range roots {
		walk(r, "", true)
	}
	return nil
}

func buildTree(rt runtime.Runtime, meta *sessmeta.Store, exclude map[string]bool) (map[string]*treeNode, []*treeNode) {
	alive := aliveSet(rt)
	meta.Reconcile(alive)
	rows := meta.All()

	// 会话基础信息（一次 list-sessions）
	// window_activity 补 session_activity 盲区（后台有输出但无人 attach 时不动),取较大值。
	out, _ := rt.TmuxOutput("list-sessions", "-F", "#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}\t#{session_activity}\t#{window_activity}")
	nodes := map[string]*treeNode{}
	var order []string
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		parts := strings.Split(line, "\t")
		if len(parts) < 4 || exclude[parts[0]] {
			continue
		}
		n := &treeNode{Name: parts[0], Created: parts[2]}
		fmt.Sscanf(parts[1], "%d", &n.Windows)
		fmt.Sscanf(parts[3], "%d", &n.Attached)
		if len(parts) > 4 {
			n.LastActivity = parts[4]
		}
		if len(parts) > 5 {
			n.LastActivity = maxNumeric(n.LastActivity, parts[5])
		}
		nodes[n.Name] = n
		order = append(order, n.Name)
	}
	// pane cwd（一次 list-panes -a，取每会话 active pane）
	if pout, err := rt.TmuxOutput("list-panes", "-a", "-F", "#{session_name}\t#{pane_active}\t#{pane_current_path}"); err == nil {
		for _, line := range strings.Split(strings.TrimSpace(pout), "\n") {
			parts := strings.Split(line, "\t")
			if len(parts) < 3 {
				continue
			}
			if n, ok := nodes[parts[0]]; ok && (n.Cwd == "" || parts[1] == "1") {
				n.Cwd = parts[2]
			}
		}
	}
	var roots []*treeNode
	for _, name := range order {
		n := nodes[name]
		if r, ok := rows[name]; ok {
			n.CreatedBy = r.CreatedBy
			if p, ok2 := nodes[r.Parent]; ok2 && r.Parent != "" {
				n.Parent = r.Parent
				p.Children = append(p.Children, n)
				continue
			}
		}
		roots = append(roots, n)
	}
	for _, n := range nodes {
		sort.Slice(n.Children, func(i, j int) bool { return n.Children[i].Name < n.Children[j].Name })
	}
	return nodes, roots
}

// KillTree 处理 `ttmux kill <名> [--cascade] [--yes]`：默认孤儿收养，--cascade 级联。
// 只动 session 与 meta，不删任何目录（设计 §2.1）。
func KillTree(rt runtime.Runtime, meta *sessmeta.Store, exclude map[string]bool, args []string, w io.Writer) error {
	cascade, yes := false, false
	var pos []string
	for _, a := range args {
		switch a {
		case "--cascade":
			cascade = true
		case "--yes", "-y":
			yes = true
		default:
			pos = append(pos, a)
		}
	}
	var target string
	if len(pos) >= 1 {
		target = pos[0]
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
	victims := []string{target}
	if cascade {
		meta.Reconcile(aliveSet(rt))
		victims = append(victims, descendants(meta, target)...)
	}
	if !yes {
		label := ui.Bold(target)
		if len(victims) > 1 {
			label = fmt.Sprintf("%s 及其 %d 个子会话", ui.Bold(target), len(victims)-1)
		}
		if !ui.Confirm("确定关闭会话 " + label + "?") {
			ui.Info(w, "已取消")
			return nil
		}
	}
	// 自底向上杀，避免中途失败留下半棵树没了 parent 记录
	for i := len(victims) - 1; i >= 0; i-- {
		v := victims[i]
		if rt.HasSession(v) {
			if err := rt.Tmux("kill-session", "-t", "="+v); err != nil {
				return err
			}
		}
		_ = meta.OnKill(v) // 非级联时：OnKill 内部把直接孩子 parent 置 NULL = 孤儿收养
	}
	if len(victims) > 1 {
		ui.Ok(w, "会话 %s 及 %d 个子会话已关闭", ui.Bold(target), len(victims)-1)
	} else {
		ui.Ok(w, "会话 %s 已关闭", ui.Bold(target))
	}
	return nil
}

func descendants(meta *sessmeta.Store, root string) []string {
	var out []string
	queue := meta.Children(root)
	for len(queue) > 0 {
		n := queue[0]
		queue = queue[1:]
		out = append(out, n)
		queue = append(queue, meta.Children(n)...)
	}
	return out
}

func aliveSet(rt runtime.Runtime) map[string]bool {
	set := map[string]bool{}
	for _, s := range rt.Sessions() {
		set[s] = true
	}
	return set
}

func has(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}
