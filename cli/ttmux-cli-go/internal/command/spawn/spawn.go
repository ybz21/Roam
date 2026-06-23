package spawn

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"ttmux-cli-go/internal/runtime"
	"ttmux-cli-go/internal/ui"
)

// spawnOne creates a single task session (cmd or agent), mirroring _spawn_one.
// Returns true when a session was created, false when it already existed.
func spawnOne(rt runtime.Runtime, group, name, taskType, payload string, ac AgentConfig, w io.Writer) (bool, error) {
	if err := rt.EnsureDirs(); err != nil {
		return false, err
	}
	sess := group + "-" + name
	if rt.HasSession(sess) {
		ui.Warn(w, "会话 %s 已存在，跳过", ui.Bold(sess))
		return false, nil
	}
	width := "200"
	if taskType == "agent" {
		width = "220"
	}
	if err := rt.Tmux("new-session", "-d", "-s", sess, "-x", width, "-y", "50"); err != nil {
		return false, err
	}
	rt.InjectEnv(sess)
	_ = rt.Tmux("pipe-pane", "-t", sess, "-o", "cat >> '"+rt.LogFile(sess)+"'")
	_ = os.WriteFile(rt.LogFile(sess), nil, 0o644)
	if err := rt.WriteTaskMeta(sess, taskType, payload, ac.Workdir); err != nil {
		return false, err
	}

	runCmd := payload
	if taskType == "agent" {
		runCmd = ac.Command(payload)
	}
	if err := rt.Tmux("send-keys", "-t", sess, runCmd, "C-m"); err != nil {
		return false, err
	}
	if taskType == "agent" && ac.Interactive {
		launchAutoconfirm(rt, sess)
	}
	if err := rt.GroupAddSession(group, sess); err != nil {
		return false, err
	}
	return true, nil
}

// One launches a single task/agent session (exported for the swarm command
// layer, which composes spawn with the swarm data core). Returns true when a
// session was created.
func One(rt runtime.Runtime, group, name, taskType, payload string, ac AgentConfig, w io.Writer) (bool, error) {
	return spawnOne(rt, group, name, taskType, payload, ac, w)
}

// Spawn handles `spawn <group> <name> <cmd> ...` (command tasks), mirroring _do_spawn.
func Spawn(rt runtime.Runtime, args []string, w io.Writer) error {
	if err := rt.EnsureDirs(); err != nil {
		return err
	}
	if len(args) < 3 {
		ui.Err(w, "用法: ttmux spawn <组名> <任务名> <命令> [<任务名> <命令> ...]")
		return fmt.Errorf("usage")
	}
	group := args[0]
	rest := args[1:]
	if rt.GroupExists(group) {
		ui.Warn(w, "任务组 %s 已存在，追加任务", ui.Bold(group))
	}
	wd, _ := os.Getwd()
	ac := DefaultAgentConfig(wd)
	count := 0
	i := 0
	for i+1 < len(rest) {
		name, cmd := rest[i], rest[i+1]
		i += 2
		ok, err := spawnOne(rt, group, name, "cmd", cmd, ac, w)
		if err != nil {
			return err
		}
		if ok {
			count++
			ui.Ok(w, "启动 %s: %s", ui.Bold(group+"-"+name), ui.Dim(cmd))
		}
	}
	if i < len(rest) {
		ui.Warn(w, "忽略落单参数: %s %s", rest[i], ui.Dim("(spawn 需要成对的 name+cmd)"))
	}
	fmt.Fprintln(w)
	ui.Info(w, "任务组 %s 已启动 %d 个任务", ui.Bold(group), count)
	return nil
}

// SpawnAgents handles `spawn --agent <group> <name> <task> ... [opts]`, mirroring _agent_spawn.
func SpawnAgents(rt runtime.Runtime, args []string, w io.Writer) error {
	if err := rt.EnsureDirs(); err != nil {
		return err
	}
	if len(args) < 1 {
		ui.Err(w, "用法: ttmux spawn --agent <组名> <名称> <任务> [...] [选项]")
		return fmt.Errorf("usage")
	}
	group := args[0]
	rest := args[1:]
	wd, _ := os.Getwd()
	ac := DefaultAgentConfig(wd)
	var pairs []string
	for i := 0; i < len(rest); i++ {
		switch rest[i] {
		case "--dir":
			if i+1 < len(rest) {
				ac.Workdir = rest[i+1]
				i++
			}
		case "--model":
			if i+1 < len(rest) {
				ac.Model = rest[i+1]
				i++
			}
		case "--perm":
			if i+1 < len(rest) {
				ac.Permission = rest[i+1]
				i++
			}
		case "--max-turns":
			if i+1 < len(rest) {
				ac.MaxTurns = rest[i+1]
				i++
			}
		default:
			pairs = append(pairs, rest[i])
		}
	}
	if rt.GroupExists(group) {
		ui.Warn(w, "Agent 组 %s 已存在", ui.Bold(group))
		return fmt.Errorf("group exists")
	}
	if len(pairs) < 2 {
		ui.Err(w, "用法: ttmux spawn --agent <组名> <名称> <任务> [...] [选项]")
		return fmt.Errorf("usage")
	}
	count := 0
	for i := 0; i+1 < len(pairs); i += 2 {
		name, task := pairs[i], pairs[i+1]
		ok, err := spawnOne(rt, group, name, "agent", task, ac, w)
		if err != nil {
			return err
		}
		if ok {
			count++
			suffix := ""
			if len(task) > 60 {
				suffix = "..."
			}
			ui.Ok(w, "Agent %s: %s", ui.Bold(name), ui.Dim(truncate(task, 60)+suffix))
		}
	}
	fmt.Fprintln(w)
	ui.Info(w, "Agent 组 %s 已启动 %d 个 Claude 实例", ui.Bold(group), count)
	ui.Info(w, "工作目录: %s", ui.Dim(ac.Workdir))
	return nil
}

// SpawnFile reads "<name> <payload>" lines from a file and spawns them
// (mirrors _do_spawn_file / _agent_spawn_file). agent toggles claude/codex mode.
func SpawnFile(rt runtime.Runtime, group, file string, extra []string, agent bool, w io.Writer) error {
	b, err := os.ReadFile(file)
	if err != nil {
		ui.Err(w, "文件不存在: %s", file)
		return err
	}
	args := []string{group}
	args = append(args, extra...)
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, payload := cut(line)
		if name == "" {
			continue
		}
		args = append(args, name, payload)
	}
	if agent {
		return SpawnAgents(rt, args, w)
	}
	return Spawn(rt, args, w)
}

func cut(line string) (string, string) {
	i := strings.IndexAny(line, " \t")
	if i < 0 {
		return line, ""
	}
	return line[:i], strings.TrimSpace(line[i+1:])
}

// Wait blocks until a group's sessions finish or time out, mirroring _do_wait_group.
func Wait(rt runtime.Runtime, args []string, w io.Writer) error {
	timeout := 300
	group := ""
	for i := 0; i < len(args); i++ {
		if args[i] == "--timeout" && i+1 < len(args) {
			if n, err := strconv.Atoi(args[i+1]); err == nil {
				timeout = n
			}
			i++
		} else {
			group = args[i]
		}
	}
	if group == "" {
		ui.Err(w, "用法: ttmux wait <组名> [--timeout N]")
		return fmt.Errorf("usage")
	}
	if !rt.GroupExists(group) {
		ui.Err(w, "任务组不存在: %s", group)
		return fmt.Errorf("group not found")
	}
	ui.Info(w, "等待任务组 %s 完成... %s", ui.Bold(group), ui.Dim(fmt.Sprintf("(超时 %ds)", timeout)))
	sessions, _ := rt.GroupSessions(group)
	allDone := true
	for _, sess := range sessions {
		if !rt.WaitSession(sess, timeout) {
			allDone = false
			ui.Warn(w, "等待超时 (%ds): %s", timeout, sess)
		}
	}
	if allDone {
		ui.Ok(w, "任务组 %s 全部完成", ui.Bold(group))
	} else {
		ui.Warn(w, "任务组 %s 部分超时", ui.Bold(group))
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
