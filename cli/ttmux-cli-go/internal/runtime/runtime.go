package runtime

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type Runtime struct {
	HomeDir   string
	DataDir   string
	LogsDir   string
	GroupsDir string
	MetaDir   string
	EnvFile   string
	TmuxBin   string
	Now       func() time.Time
}

func New() Runtime {
	home, _ := os.UserHomeDir()
	dataDir := envOr("TTMUX_DATA", filepath.Join(home, ".local", "share", "ttmux"))
	return Runtime{
		HomeDir:   envOr("TTMUX_HOME", filepath.Join(home, ".ttmux")),
		DataDir:   dataDir,
		LogsDir:   filepath.Join(dataDir, "logs"),
		GroupsDir: filepath.Join(dataDir, "groups"),
		MetaDir:   filepath.Join(dataDir, "meta"),
		EnvFile:   filepath.Join(dataDir, "env"),
		TmuxBin:   envOrLookup("TMUX_BIN", "tmux"),
		Now:       time.Now,
	}
}

// Version is the ttmux CLI version reported by the Go binary.
const Version = "0.4.1-go"

func (r Runtime) EnsureDirs() error {
	for _, dir := range []string{r.LogsDir, r.GroupsDir, r.MetaDir, filepath.Join(r.HomeDir, "swarms")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return nil
}

func (r Runtime) Tmux(args ...string) error {
	cmd := exec.Command(r.TmuxBin, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	return cmd.Run()
}

func (r Runtime) TmuxOutput(args ...string) (string, error) {
	var out bytes.Buffer
	cmd := exec.Command(r.TmuxBin, args...)
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	return out.String(), err
}

func (r Runtime) HasSession(name string) bool {
	// "=" 强制精确匹配:tmux -t 默认按前缀匹配,dev 会话死后 has-session
	// 会命中它的陪跑会话 <dev>-review,导致存活误判、退出事件永不触发
	cmd := exec.Command(r.TmuxBin, "has-session", "-t", "="+name)
	return cmd.Run() == nil
}

// Sessions returns all tmux session names (unfiltered).
func (r Runtime) Sessions() []string {
	out, err := r.TmuxOutput("list-sessions", "-F", "#{session_name}")
	if err != nil {
		// tmux server 未启动时 list-sessions 非零退出，此时输出是 stderr 的
		// 错误文本（如 "no server running ..."），不能按行当会话名解析
		return nil
	}
	var names []string
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			names = append(names, line)
		}
	}
	return names
}

// EnvPairs reads the global env file as KEY=VALUE lines (comments/blanks skipped).
func (r Runtime) EnvPairs() []string {
	b, err := os.ReadFile(r.EnvFile)
	if err != nil {
		return nil
	}
	var lines []string
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		lines = append(lines, line)
	}
	return lines
}

// SetGlobalEnv pushes the env file into tmux's global environment so new
// sessions inherit it (mirrors _set_global_env).
func (r Runtime) SetGlobalEnv() {
	for _, line := range r.EnvPairs() {
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		_ = r.Tmux("set-environment", "-g", key, val)
	}
}

// InjectEnv injects the env file into a live session (mirrors _inject_env).
func (r Runtime) InjectEnv(sess string) {
	lines := r.EnvPairs()
	if len(lines) == 0 {
		return
	}
	for _, line := range lines {
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		_ = r.Tmux("set-environment", "-t", sess, key, val)
		_ = r.Tmux("send-keys", "-t", sess, "export "+line, "C-m")
	}
	_ = r.Tmux("send-keys", "-t", sess, "clear", "C-m")
}

func (r Runtime) GroupFile(name string) string {
	return filepath.Join(r.GroupsDir, name+".group")
}

func (r Runtime) TaskMetaDir(name string) string {
	return filepath.Join(r.MetaDir, name)
}

func (r Runtime) TaskType(name string) string {
	b, err := os.ReadFile(filepath.Join(r.TaskMetaDir(name), "type.txt"))
	if err == nil && strings.TrimSpace(string(b)) != "" {
		return strings.TrimSpace(string(b))
	}
	return "cmd"
}

func (r Runtime) TaskDesc(name string) string {
	if b, err := os.ReadFile(filepath.Join(r.TaskMetaDir(name), "desc.txt")); err == nil {
		return strings.TrimSpace(string(b))
	}
	if b, err := os.ReadFile(filepath.Join(r.DataDir, "agents", name, "task.txt")); err == nil {
		return strings.TrimSpace(string(b))
	}
	return ""
}

// TaskDescRaw returns the task description without trimming, mirroring the
// shell CLI's `cat` so `collect --json` preserves the stored trailing newline
// (whereas `status --json` strips it via TaskDesc).
func (r Runtime) TaskDescRaw(name string) string {
	if b, err := os.ReadFile(filepath.Join(r.TaskMetaDir(name), "desc.txt")); err == nil {
		return string(b)
	}
	if b, err := os.ReadFile(filepath.Join(r.DataDir, "agents", name, "task.txt")); err == nil {
		return string(b)
	}
	return ""
}

func (r Runtime) GroupExists(group string) bool {
	_, err := os.Stat(r.GroupFile(group))
	return err == nil
}

func (r Runtime) GroupAddSession(group, session string) error {
	f, err := os.OpenFile(r.GroupFile(group), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(session + "\n")
	return err
}

func (r Runtime) LogFile(sess string) string {
	return filepath.Join(r.LogsDir, sess+".log")
}

// WriteTaskMeta records type/desc/workdir/started for a task session,
// mirroring _task_write_meta so status/collect/kill share one path.
func (r Runtime) WriteTaskMeta(sess, taskType, desc, workdir string) error {
	dir := r.TaskMetaDir(sess)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	writes := map[string]string{
		"type.txt":    taskType + "\n",
		"desc.txt":    desc + "\n",
		"workdir.txt": workdir + "\n",
		"started.txt": r.Now().Format("2006-01-02 15:04:05") + "\n",
	}
	for name, content := range writes {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			return err
		}
	}
	return nil
}

func (r Runtime) CleanTaskMeta(sess string) {
	_ = os.RemoveAll(r.TaskMetaDir(sess))
	_ = os.RemoveAll(filepath.Join(r.DataDir, "agents", sess))
}

func (r Runtime) GroupSessions(group string) ([]string, error) {
	b, err := os.ReadFile(r.GroupFile(group))
	if err != nil {
		return nil, err
	}
	var sessions []string
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			sessions = append(sessions, line)
		}
	}
	return sessions, nil
}

// WaitSession blocks until a session is gone or its pane is dead, or timeout
// seconds elapse (mirrors _do_wait_session). Returns true on completion.
func (r Runtime) WaitSession(sess string, timeout int) bool {
	for elapsed := 0; elapsed < timeout; elapsed++ {
		if !r.HasSession(sess) {
			return true
		}
		dead, _ := r.TmuxOutput("display-message", "-t", "="+sess+":", "-p", "#{pane_dead}")
		if strings.TrimSpace(dead) == "1" {
			return true
		}
		time.Sleep(time.Second)
	}
	return false
}

func (r Runtime) ReadCapture(name string, lines string) (string, error) {
	if r.HasSession(name) {
		// pane 目标的精确匹配要写成 "=名:"(tmux 3.4 对裸 "=名" 报 can't find pane)
		return r.TmuxOutput("capture-pane", "-t", "="+name+":", "-p", "-S", "-"+lines)
	}
	log := filepath.Join(r.LogsDir, name+".log")
	lineCount := 200
	_, _ = fmt.Sscanf(lines, "%d", &lineCount)
	b, err := tailFile(log, lineCount)
	if err != nil {
		return "", fmt.Errorf("session not found and no log: %s", name)
	}
	return string(b), nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envOrLookup(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	if v, err := exec.LookPath(fallback); err == nil {
		return v
	}
	return fallback
}
