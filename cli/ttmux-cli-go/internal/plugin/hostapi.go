package plugin

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"ttmux-cli-go/internal/command/spawn"
	"ttmux-cli-go/internal/plugin/rpc"
)

// HostAPI serves roam/* platform calls for one hosted plugin. 它是"平台 API →
// Roam 原语"的唯一翻译处:权限检查与审计都发生在这里
// (docs/design/plugin/04-architecture.md 2.4 铁律)。
type HostAPI struct {
	Env     Env
	Store   *Store
	Plugin  RegisteredPlugin
	Actor   string // 发起方,如 cli:user
	Workdir string // 调用方工作区(CLI cwd)
	// dispatchDepth guards against sink cascades re-dispatching forever.
	dispatchDepth int
}

// Handle implements rpc.Handler for the host side of a plugin connection.
func (h *HostAPI) Handle(method string, params json.RawMessage) (any, error) {
	switch method {
	case "roam/workspace.diff":
		return h.workspaceDiff(params)
	case "roam/agent.providers":
		return h.agentProviders()
	case "roam/agent.spawn":
		return h.agentSpawn(params)
	case "roam/session.wait":
		return h.sessionWait(params)
	case "roam/session.capture":
		return h.sessionCapture(params)
	case "roam/session.log":
		return h.sessionLog(params)
	case "roam/session.list":
		return h.sessionList(params)
	case "roam/session.send":
		return h.sessionSend(params)
	case "roam/storage.get":
		return h.storageGet(params)
	case "roam/storage.set":
		return h.storageSet(params)
	case "roam/command.exec":
		return h.commandExec(params)
	case "roam/finding.create":
		return h.findingCreate(params)
	case "roam/finding.list":
		return h.findingList(params)
	case "roam/notification.publish":
		return h.notificationPublish(params)
	case "$/log": // 插件侧日志通知(已走 stderr,此处兜底忽略)
		return nil, nil
	}
	return nil, &rpc.Error{Code: rpc.CodeUnknownMethod, Message: "unknown method: " + method}
}

func (h *HostAPI) requirePerm(perm, action, target string) error {
	if !h.Plugin.Manifest.HasPerm(perm) {
		h.audit(action, target, "denied", "missing permission "+perm)
		return &rpc.Error{Code: rpc.CodePermissionDenied, Message: "permission denied: " + perm}
	}
	return nil
}

func (h *HostAPI) audit(action, target, decision, result string) {
	h.Env.Audit(AuditEntry{
		Plugin:   h.Plugin.Manifest.ID,
		Version:  h.Plugin.Manifest.Version,
		Actor:    h.Actor,
		Action:   action,
		Target:   target,
		Decision: decision,
		Result:   result,
	})
}

// ── workspace ──

type diffResult struct {
	Branch string `json:"branch"`
	Stat   string `json:"stat"`
	Diff   string `json:"diff"`
}

func (h *HostAPI) workspaceDiff(params json.RawMessage) (any, error) {
	if err := h.requirePerm("workspace:read", "workspace.diff", h.Workdir); err != nil {
		return nil, err
	}
	var req struct {
		Base string `json:"base"`
		Dir  string `json:"dir"` // 可选:显式工作区(watcher 触发的自动互审带 workdir 标签)
	}
	_ = json.Unmarshal(params, &req)
	dir := h.Workdir
	if strings.TrimSpace(req.Dir) != "" {
		if !filepath.IsAbs(req.Dir) {
			return nil, fmt.Errorf("workspace.diff: dir must be absolute, got %q", req.Dir)
		}
		if st, err := os.Stat(req.Dir); err != nil || !st.IsDir() {
			return nil, fmt.Errorf("workspace.diff: dir not found: %s", req.Dir)
		}
		dir = req.Dir
	}
	base := orDefault(req.Base, "HEAD")
	branch := h.git(dir, "rev-parse", "--abbrev-ref", "HEAD")
	stat := h.git(dir, "diff", "--stat", base)
	diff := h.git(dir, "diff", base)
	if strings.TrimSpace(diff) == "" {
		// 无未提交变更时退回最近一次提交的 diff,便于"刚提交完求 review"的场景
		diff = h.git(dir, "show", "--format=commit %h %s", base)
		stat = h.git(dir, "show", "--stat", "--format=", base)
	}
	const capBytes = 120 * 1024
	if len(diff) > capBytes {
		diff = diff[:capBytes] + "\n...[diff truncated by roam host]"
	}
	h.audit("workspace.diff", dir, "allowed", fmt.Sprintf("%d bytes", len(diff)))
	return diffResult{Branch: strings.TrimSpace(branch), Stat: stat, Diff: diff}, nil
}

func (h *HostAPI) git(dir string, args ...string) string {
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	_ = cmd.Run()
	return out.String()
}

// ── agent ──

func (h *HostAPI) agentProviders() (any, error) {
	providers := map[string]bool{}
	for _, bin := range []string{"claude", "codex"} {
		_, err := exec.LookPath(bin)
		providers[bin] = err == nil
	}
	return providers, nil
}

type spawnReq struct {
	Provider    string            `json:"provider"`
	Prompt      string            `json:"prompt"`
	SessionName string            `json:"sessionName"`
	Workdir     string            `json:"workdir"`
	Job         string            `json:"job"`
	Labels      map[string]string `json:"labels"`
}

func (h *HostAPI) agentSpawn(params json.RawMessage) (any, error) {
	var req spawnReq
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, err
	}
	if err := h.requirePerm("agents:spawn", "agent.spawn", req.SessionName); err != nil {
		return nil, err
	}
	if req.SessionName == "" || req.Prompt == "" {
		return nil, fmt.Errorf("agent.spawn: sessionName and prompt are required")
	}
	rt := h.Env.RT
	if rt.HasSession(req.SessionName) {
		return nil, fmt.Errorf("session already exists: %s", req.SessionName)
	}
	if err := rt.EnsureDirs(); err != nil {
		return nil, err
	}
	workdir := orDefault(req.Workdir, h.Workdir)
	ac := spawn.DefaultAgentConfig(workdir)
	if req.Provider != "" {
		ac.Kind = req.Provider
	}
	if err := rt.Tmux("new-session", "-d", "-s", req.SessionName, "-x", "220", "-y", "50"); err != nil {
		return nil, err
	}
	rt.InjectEnv(req.SessionName)
	_ = os.WriteFile(rt.LogFile(req.SessionName), nil, 0o644)
	_ = rt.Tmux("pipe-pane", "-t", req.SessionName, "-o", "cat >> '"+rt.LogFile(req.SessionName)+"'")
	_ = rt.WriteTaskMeta(req.SessionName, "agent", "plugin:"+h.Plugin.Manifest.ID, workdir)
	if err := rt.Tmux("send-keys", "-t", req.SessionName, ac.Command(req.Prompt), "C-m"); err != nil {
		return nil, err
	}
	// 一次性 Agent 会话:命令结束后退出 shell,使会话消亡 —— WaitSession 与
	// plugind watcher 都以"会话不存在"为完成信号(pane_dead 在实践中不可靠)。
	// exit 在命令运行期间排队于 tty 输入缓冲,命令收尾后由 shell 消费。
	if err := rt.Tmux("send-keys", "-t", req.SessionName, "exit", "C-m"); err != nil {
		return nil, err
	}
	_ = h.Store.AddSession(SessionRow{Session: req.SessionName, Plugin: h.Plugin.Manifest.ID, Job: req.Job, Labels: req.Labels})
	h.audit("agent.spawn", req.SessionName, "allowed", "provider="+ac.Kind)
	return map[string]string{"session": req.SessionName, "provider": ac.Kind}, nil
}

// ── session ──

type sessionNameReq struct {
	Name       string `json:"name"`
	TailLines  int    `json:"tailLines"`
	TimeoutSec int    `json:"timeoutSec"`
	Job        string `json:"job"`
}

func (h *HostAPI) sessionWait(params json.RawMessage) (any, error) {
	var req sessionNameReq
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, err
	}
	if err := h.requirePerm("sessions:read", "session.wait", req.Name); err != nil {
		return nil, err
	}
	timeout := req.TimeoutSec
	if timeout <= 0 || timeout > 3600 {
		timeout = 1800
	}
	done := h.Env.RT.WaitSession(req.Name, timeout)
	if done {
		_ = h.Store.UpdateSessionStatus(req.Name, "exited")
	}
	h.audit("session.wait", req.Name, "allowed", fmt.Sprintf("done=%v", done))
	return map[string]bool{"done": done}, nil
}

func (h *HostAPI) sessionCapture(params json.RawMessage) (any, error) {
	var req sessionNameReq
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, err
	}
	if err := h.requirePerm("sessions:read", "session.capture", req.Name); err != nil {
		return nil, err
	}
	lines := "200"
	if req.TailLines > 0 {
		lines = fmt.Sprintf("%d", req.TailLines)
	}
	out, err := h.Env.RT.ReadCapture(req.Name, lines)
	if err != nil {
		return nil, err
	}
	h.audit("session.capture", req.Name, "allowed", "")
	return map[string]string{"output": out}, nil
}

func (h *HostAPI) sessionLog(params json.RawMessage) (any, error) {
	var req sessionNameReq
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, err
	}
	if err := h.requirePerm("sessions:read", "session.log", req.Name); err != nil {
		return nil, err
	}
	b, err := os.ReadFile(h.Env.RT.LogFile(req.Name))
	if err != nil {
		return nil, err
	}
	const capBytes = 512 * 1024
	if len(b) > capBytes {
		b = b[len(b)-capBytes:]
	}
	h.audit("session.log", req.Name, "allowed", fmt.Sprintf("%d bytes", len(b)))
	return map[string]string{"log": string(b)}, nil
}

func (h *HostAPI) sessionList(params json.RawMessage) (any, error) {
	var req sessionNameReq
	_ = json.Unmarshal(params, &req)
	if err := h.requirePerm("sessions:read", "session.list", ""); err != nil {
		return nil, err
	}
	rows, err := h.Store.Sessions(h.Plugin.Manifest.ID, "")
	if err != nil {
		return nil, err
	}
	var out []SessionRow
	for _, r := range rows {
		if req.Job != "" && r.Job != req.Job {
			continue
		}
		if r.Status == "running" && !h.Env.RT.HasSession(r.Session) {
			r.Status = "exited"
			_ = h.Store.UpdateSessionStatus(r.Session, "exited")
		}
		out = append(out, r)
	}
	return out, nil
}

// sessionSend types text + Enter into a session(高危:sessions:write;
// 互审意见回灌原会话让 Agent 修改就走这里)。
func (h *HostAPI) sessionSend(params json.RawMessage) (any, error) {
	var req struct {
		Name string `json:"name"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, err
	}
	if err := h.requirePerm("sessions:write", "session.send", req.Name); err != nil {
		return nil, err
	}
	if !h.Env.RT.HasSession(req.Name) {
		return nil, fmt.Errorf("session not found: %s", req.Name)
	}
	// 单行化:交互 TUI 中换行即提交,多行文本会被拆成多次输入
	text := strings.ReplaceAll(strings.ReplaceAll(req.Text, "\r", " "), "\n", " ")
	if err := h.Env.RT.Tmux("send-keys", "-t", req.Name, "-l", text); err != nil {
		return nil, err
	}
	if err := h.Env.RT.Tmux("send-keys", "-t", req.Name, "C-m"); err != nil {
		return nil, err
	}
	h.audit("session.send", req.Name, "allowed", fmt.Sprintf("%d chars", len(text)))
	return map[string]bool{"sent": true}, nil
}

// ── storage(插件私有 KV,落 storage/<id>/kv.json)──

func (h *HostAPI) storagePath() string {
	return filepath.Join(h.Env.StorageDir(h.Plugin.Manifest.ID), "kv.json")
}

func (h *HostAPI) loadKV() map[string]string {
	kv := map[string]string{}
	if b, err := os.ReadFile(h.storagePath()); err == nil {
		_ = json.Unmarshal(b, &kv)
	}
	return kv
}

func (h *HostAPI) storageGet(params json.RawMessage) (any, error) {
	var req struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, err
	}
	return map[string]string{"value": h.loadKV()[req.Key]}, nil
}

func (h *HostAPI) storageSet(params json.RawMessage) (any, error) {
	var req struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, err
	}
	kv := h.loadKV()
	if req.Value == "" {
		delete(kv, req.Key)
	} else {
		kv[req.Key] = req.Value
	}
	if err := os.MkdirAll(filepath.Dir(h.storagePath()), 0o755); err != nil {
		return nil, err
	}
	b, _ := json.MarshalIndent(kv, "", " ")
	return map[string]bool{"ok": true}, os.WriteFile(h.storagePath(), b, 0o600)
}

// ── command.exec (白名单是 v1 唯一真正可强制的命令权限,见 06-platform-api) ──

type execReq struct {
	Argv       []string `json:"argv"`
	Cwd        string   `json:"cwd"`
	TimeoutSec int      `json:"timeoutSec"`
}

func (h *HostAPI) commandExec(params json.RawMessage) (any, error) {
	var req execReq
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, err
	}
	target := strings.Join(req.Argv, " ")
	if !h.Plugin.Manifest.CommandAllowed(req.Argv) {
		h.audit("command.exec", target, "denied", "not in whitelist")
		return nil, &rpc.Error{Code: rpc.CodePermissionDenied, Message: "command not in whitelist: " + target}
	}
	timeout := req.TimeoutSec
	if timeout <= 0 || timeout > 1800 {
		timeout = 600
	}
	cmd := exec.Command(req.Argv[0], req.Argv[1:]...)
	cmd.Dir = orDefault(req.Cwd, h.Workdir)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := runWithTimeout(cmd, time.Duration(timeout)*time.Second)
	exit := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			exit = ee.ExitCode()
		} else {
			h.audit("command.exec", target, "allowed", "error: "+err.Error())
			return nil, err
		}
	}
	const capBytes = 256 * 1024
	output := out.String()
	if len(output) > capBytes {
		output = output[len(output)-capBytes:]
	}
	h.audit("command.exec", target, "allowed", fmt.Sprintf("exit=%d", exit))
	return map[string]any{"exit": exit, "output": output}, nil
}

func runWithTimeout(cmd *exec.Cmd, d time.Duration) error {
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(d):
		_ = cmd.Process.Kill()
		<-done
		return fmt.Errorf("command timed out after %s", d)
	}
}

// ── finding ──

func (h *HostAPI) findingCreate(params json.RawMessage) (any, error) {
	var f Finding
	if err := json.Unmarshal(params, &f); err != nil {
		return nil, err
	}
	if err := h.requirePerm("findings:write", "finding.create", f.Title); err != nil {
		return nil, err
	}
	f.Plugin = h.Plugin.Manifest.ID
	id, err := h.Store.CreateFinding(f)
	if err != nil {
		return nil, err
	}
	h.audit("finding.create", fmt.Sprintf("#%d %s", id, f.Title), "allowed", "severity="+f.Severity)
	return map[string]int64{"id": id}, nil
}

func (h *HostAPI) findingList(params json.RawMessage) (any, error) {
	var req struct {
		Job    string `json:"job"`
		Status string `json:"status"`
	}
	_ = json.Unmarshal(params, &req)
	if err := h.requirePerm("findings:read", "finding.list", ""); err != nil {
		return nil, err
	}
	return h.Store.Findings(h.Plugin.Manifest.ID, req.Job, req.Status)
}

// ── notification (publish + 同步分发给 sink 插件) ──

func (h *HostAPI) notificationPublish(params json.RawMessage) (any, error) {
	var n Notification
	if err := json.Unmarshal(params, &n); err != nil {
		return nil, err
	}
	if err := h.requirePerm("notifications:publish", "notification.publish", n.Type); err != nil {
		return nil, err
	}
	n.Source = h.Plugin.Manifest.ID
	id, err := h.Store.AddNotification(n)
	if err != nil {
		return nil, err
	}
	if id == 0 {
		h.audit("notification.publish", n.Type, "allowed", "deduped")
		return map[string]any{"id": 0, "deduped": true}, nil
	}
	n.ID = id
	h.audit("notification.publish", n.Type, "allowed", n.Title)
	delivered := 0
	if h.dispatchDepth == 0 { // sink 只级联一层,防插件间互发死循环
		delivered = DispatchToSinks(h.Env, h.Store, n, h.dispatchDepth+1)
	}
	return map[string]any{"id": id, "sinks": delivered}, nil
}
