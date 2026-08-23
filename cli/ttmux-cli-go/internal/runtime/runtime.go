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
	// Roam 主目录 ~/.roam（数据/配置根）。优先 ROAM_HOME，兼容旧 TTMUX_HOME。
	homeDir := envOr("ROAM_HOME", envOr("TTMUX_HOME", filepath.Join(home, ".roam")))
	MigrateLegacyHome(homeDir) // 首次把 ~/.ttmux 与旧运行时数据并入 ~/.roam
	// 运行时数据默认与主目录同根；可用 ROAM_DATA 覆盖（兼容旧 TTMUX_DATA）。
	dataDir := envOr("ROAM_DATA", envOr("TTMUX_DATA", homeDir))
	return Runtime{
		HomeDir:   homeDir,
		DataDir:   dataDir,
		LogsDir:   filepath.Join(dataDir, "logs"),
		GroupsDir: filepath.Join(dataDir, "groups"),
		MetaDir:   filepath.Join(dataDir, "meta"),
		EnvFile:   filepath.Join(dataDir, "env"),
		TmuxBin:   envOrLookup("TMUX_BIN", "tmux"),
		Now:       time.Now,
	}
}

// MigrateLegacyHome 首次启动时把旧目录并入 Roam 主目录（默认 ~/.roam）：
//   - ~/.ttmux → ~/.roam（整体改名，含 meta.db/swarms/plugins）
//   - ~/.local/share/ttmux/* → ~/.roam（旧运行时数据：logs/groups/meta/env/agents/tls…）
//
// 幂等：目标已存在即跳过。设置了 ROAM_HOME/TTMUX_HOME/ROAM_DATA/TTMUX_DATA 任一自定义路径时不迁移。
func MigrateLegacyHome(roamHome string) {
	if os.Getenv("ROAM_HOME") != "" || os.Getenv("TTMUX_HOME") != "" ||
		os.Getenv("ROAM_DATA") != "" || os.Getenv("TTMUX_DATA") != "" {
		return
	}
	if _, err := os.Stat(roamHome); err == nil {
		return // 已迁移
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	if legacy := filepath.Join(home, ".ttmux"); dirExists(legacy) {
		if err := os.Rename(legacy, roamHome); err != nil {
			return
		}
	}
	// 合并旧运行时数据目录的各子项（不覆盖已存在的目标）。
	legacyData := filepath.Join(home, ".local", "share", "ttmux")
	entries, err := os.ReadDir(legacyData)
	if err != nil {
		return
	}
	_ = os.MkdirAll(roamHome, 0o755)
	for _, e := range entries {
		dst := filepath.Join(roamHome, e.Name())
		if _, err := os.Stat(dst); err == nil {
			continue
		}
		_ = os.Rename(filepath.Join(legacyData, e.Name()), dst)
	}
}

func dirExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
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

// EnvValue 读一个全局配置项：**进程环境变量优先**，然后才是 env 文件。
//
// 顺序不能反。env 文件是设置页写的持久配置，而进程环境变量是临时覆盖
// （`ROAM_SESSION_MEM_MAX=200M ttmux new ...` 这种一次性的口子）——
// 临时的压不过持久的，那就没有「临时」可言了。
func (r Runtime) EnvValue(key string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	for _, line := range r.EnvPairs() {
		if k, v, ok := strings.Cut(line, "="); ok && strings.TrimSpace(k) == key {
			return strings.TrimSpace(v)
		}
	}
	return ""
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

// SendPromptSubmit pastes a (possibly multi-line) prompt into a session and
// submits it. TUI agents (Claude/Codex) treat a trailing C-m inside send-keys
// as an input newline rather than a submit, so a naive `send-keys text C-m`
// only types the text without sending it. Instead we drop the text via a paste
// buffer (no embedded submit) then press Enter separately; a second Enter after
// a short delay reliably fires the submit even when the TUI is still ingesting
// the paste. Mirrors the swarm sendPromptSubmit / _tmux_send_prompt_submit.
// Set TTMUX_FORCE_PROMPT_SUBMIT=0 to skip the second Enter (e.g. plain shells).
func (r Runtime) SendPromptSubmit(target, message string) {
	// -p 让 paste-buffer 在目标应用开了 bracketed paste 模式(Claude/Codex 等
	// TUI 都开)时用 ESC[200~..ESC[201~ 包裹，整段多行 prompt 作为「一次粘贴」
	// 送入、内嵌换行保留为输入换行而非提交；不带 -p 时 tmux 把换行当裸 CR 逐个
	// 下发，多行 prompt 会在每个换行处被提前提交、拆成多条。对普通 shell(未开
	// bracketed paste)-p 无副作用，退化为普通粘贴。
	if r.Tmux("set-buffer", "-b", "ttmux-prompt", message) != nil ||
		r.Tmux("paste-buffer", "-p", "-d", "-b", "ttmux-prompt", "-t", target) != nil {
		// Fallback: paste buffer unavailable, send literally.
		_ = r.Tmux("send-keys", "-t", target, "-l", message)
	}
	_ = r.Tmux("send-keys", "-t", target, "Enter")
	if os.Getenv("TTMUX_FORCE_PROMPT_SUBMIT") != "0" {
		time.Sleep(50 * time.Millisecond)
		_ = r.Tmux("send-keys", "-t", target, "Enter")
	}
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

// TaskLabel 任务会话的展示名：先读落盘的 label.txt（会话死了也还在），
// 再问 tmux 的 @roam_name，都没有就退回会话名本身。
func (r Runtime) TaskLabel(sess string) string {
	if b, err := os.ReadFile(filepath.Join(r.TaskMetaDir(sess), "label.txt")); err == nil {
		if s := strings.TrimSpace(string(b)); s != "" {
			return s
		}
	}
	if row := r.SessionRow(sess); row.Name != "" {
		return row.DisplayLabel()
	}
	return sess
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

// WriteTaskMeta records type/desc/workdir/started/label for a task session,
// mirroring _task_write_meta so status/collect/kill share one path.
// label 是任务的语义名（`<组>-<成员>`）：会话本身叫 id，而 tmux 的 @roam_name
// 随会话一起消失——任务跑完 status/collect 还要显示名字，所以另存一份。
func (r Runtime) WriteTaskMeta(sess, taskType, desc, workdir, label string) error {
	dir := r.TaskMetaDir(sess)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	writes := map[string]string{
		"type.txt":    taskType + "\n",
		"desc.txt":    desc + "\n",
		"workdir.txt": workdir + "\n",
		"label.txt":   label + "\n",
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
