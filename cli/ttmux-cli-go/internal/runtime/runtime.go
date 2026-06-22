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
	HomeDir    string
	DataDir    string
	LogsDir    string
	GroupsDir  string
	MetaDir    string
	EnvFile    string
	TmuxBin    string
	ShellPath  string
	Repository string
	Now        func() time.Time
}

func New() Runtime {
	home, _ := os.UserHomeDir()
	dataDir := envOr("TTMUX_DATA", filepath.Join(home, ".local", "share", "ttmux"))
	root := discoverRepo()
	return Runtime{
		HomeDir:    envOr("TTMUX_HOME", filepath.Join(home, ".ttmux")),
		DataDir:    dataDir,
		LogsDir:    filepath.Join(dataDir, "logs"),
		GroupsDir:  filepath.Join(dataDir, "groups"),
		MetaDir:    filepath.Join(dataDir, "meta"),
		EnvFile:    filepath.Join(dataDir, "env"),
		TmuxBin:    envOrLookup("TMUX_BIN", "tmux"),
		ShellPath:  envOr("TTMUX_SHELL", filepath.Join(root, "ttmux")),
		Repository: root,
		Now:        time.Now,
	}
}

func (r Runtime) EnsureDirs() error {
	for _, dir := range []string{r.LogsDir, r.GroupsDir, r.MetaDir, filepath.Join(r.HomeDir, "swarms")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return nil
}

func (r Runtime) Shell(args ...string) error {
	cmd := exec.Command(r.ShellPath, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	return cmd.Run()
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
	cmd := exec.Command(r.TmuxBin, "has-session", "-t", name)
	return cmd.Run() == nil
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

func (r Runtime) ReadCapture(name string, lines string) (string, error) {
	if r.HasSession(name) {
		return r.TmuxOutput("capture-pane", "-t", name, "-p", "-S", "-"+lines)
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

func discoverRepo() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	for dir := wd; dir != filepath.Dir(dir); dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, "ttmux")); err == nil {
			return dir
		}
	}
	return wd
}
