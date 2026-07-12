// 组合 WorktreeSession API 的端到端测试：真 git 仓库 + 隔离 tmux socket + 真 ttmux CLI。
// 覆盖 建worktree+会话 / fork子会话 / 关闭三选一(merge/discard) 的编排与补偿语义。
package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"ttmux-web/ttmux"
)

// scrubGitEnv 同 worktree 包：剥掉钩子注入的 GIT_*，避免子进程 git 被劫持。
func scrubGitEnv() []string {
	env := os.Environ()
	out := env[:0]
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		switch k {
		case "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
			"GIT_COMMON_DIR", "GIT_PREFIX", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE":
			continue
		}
		out = append(out, kv)
	}
	return out
}

func e2eSetup(t *testing.T) (*gin.Engine, string, func(...string) string) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go not available to build CLI")
	}
	tmp := t.TempDir()

	// 隔离 tmux socket
	sock := fmt.Sprintf("roam-e2e-%d", os.Getpid())
	wrapper := filepath.Join(tmp, "tmux-wrapper")
	if err := os.WriteFile(wrapper, []byte("#!/bin/sh\nexec tmux -L "+sock+" \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMUX_BIN", wrapper)
	t.Setenv("ROAM_HOME", filepath.Join(tmp, "roam-home"))
	t.Setenv("TMUX", "") // 测试进程可能跑在 tmux 里，避免 CLI 误判
	t.Cleanup(func() { _ = exec.Command("tmux", "-L", sock, "kill-server").Run() })

	// 构建被测 CLI
	bin := filepath.Join(tmp, "ttmux-e2e")
	root, _ := filepath.Abs("../..")
	build := exec.Command("go", "build", "-o", bin, "./cmd/ttmux-cli-go")
	build.Dir = filepath.Join(root, "cli", "ttmux-cli-go")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build cli: %v\n%s", err, out)
	}

	gin.SetMode(gin.TestMode)
	h := New(ttmux.New(bin), "", tmp)
	r := gin.New()
	r.POST("/worktree-sessions", h.WorktreeSessionCreate)
	r.POST("/sessions/:name/fork-worktree", h.SessionForkWorktree)
	r.POST("/sessions/:name/close-with-worktree", h.SessionCloseWithWorktree)
	r.GET("/sessions/:name/worktree-status", h.SessionWorktreeStatus)
	r.GET("/git/worktrees", h.WorktreeList)
	r.POST("/races", h.RaceCreate)
	r.POST("/races/:id/crown", h.RaceCrown)
	r.POST("/races/:id/cleanup", h.RaceCleanup)

	tmuxOut := func(args ...string) string {
		out, _ := exec.Command("tmux", append([]string{"-L", sock}, args...)...).CombinedOutput()
		return strings.TrimSpace(string(out))
	}
	return r, tmp, tmuxOut
}

func e2eRepo(t *testing.T, tmp string) string {
	t.Helper()
	repo := filepath.Join(tmp, "repo")
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(scrubGitEnv(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	run("init", "-b", "main")
	if err := os.WriteFile(filepath.Join(repo, "a.txt"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "init")
	return repo
}

func post(t *testing.T, r *gin.Engine, path string, body any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	return w.Code, resp
}

func TestWorktreeSessionLifecycle(t *testing.T) {
	r, tmp, tmuxOut := e2eSetup(t)
	repo := e2eRepo(t, tmp)

	// ① 组合创建（先会话后 worktree）：不传分支 → 自动占位 roam/<会话名>，会话被 cd 进 worktree
	code, resp := post(t, r, "/worktree-sessions", map[string]any{
		"name": "e2e-main", "dir": repo, "base": "main",
	})
	if code != 200 {
		t.Fatalf("worktree-sessions: %d %v", code, resp)
	}
	data := resp["data"].(map[string]any)
	wtPath := data["path"].(string)
	if data["branch"] != "e2e-main" || !strings.Contains(wtPath, ".worktrees") {
		t.Fatalf("bad data: %v", data)
	}
	if !strings.Contains(tmuxOut("list-sessions", "-F", "#{session_name}"), "e2e-main") {
		t.Fatal("session not created")
	}
	// cd 是注入 shell 的异步键入，轮询等 pane cwd 落进 worktree
	waitCwd := func(sess, want string) {
		t.Helper()
		for i := 0; i < 50; i++ {
			if tmuxOut("list-panes", "-t", "="+sess, "-F", "#{pane_current_path}") == want {
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
		t.Fatalf("session %s cwd never reached %q (now %q)", sess, want,
			tmuxOut("list-panes", "-t", "="+sess, "-F", "#{pane_current_path}"))
	}
	waitCwd("e2e-main", wtPath)

	// ② fork 子会话进新 worktree（仓库自动取父 cwd）
	code, resp = post(t, r, "/sessions/e2e-main/fork-worktree", map[string]any{
		"child": "e2e-kid", "branch": "roam/e2e-kid",
	})
	if code != 200 {
		t.Fatalf("fork-worktree: %d %v", code, resp)
	}
	kid := resp["data"].(map[string]any)
	kidPath := kid["path"].(string)
	if kid["parent"] != "e2e-main" {
		t.Fatalf("bad fork data: %v", kid)
	}
	waitCwd("e2e-kid", kidPath)

	// ③ discard 关闭子会话：会话/worktree/分支全清
	code, resp = post(t, r, "/sessions/e2e-kid/close-with-worktree", map[string]any{
		"mode": "discard", "path": kidPath,
	})
	if code != 200 {
		t.Fatalf("discard close: %d %v", code, resp)
	}
	if strings.Contains(tmuxOut("list-sessions", "-F", "#{session_name}"), "e2e-kid") {
		t.Fatal("kid session survived discard")
	}
	if _, err := os.Stat(kidPath); err == nil {
		t.Fatal("kid worktree survived discard")
	}
	lsBranch := exec.Command("git", "-C", repo, "branch", "--list", "roam/e2e-kid")
	lsBranch.Env = scrubGitEnv()
	if out, _ := lsBranch.Output(); strings.TrimSpace(string(out)) != "" {
		t.Fatal("kid branch survived discard")
	}

	// ④ merge 关闭主 worktree 会话：未提交改动 wip 落盘 → squash 回 main → 清理
	if err := os.WriteFile(filepath.Join(wtPath, "feature.txt"), []byte("done\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, resp = post(t, r, "/sessions/e2e-main/close-with-worktree", map[string]any{
		"mode": "merge", "strategy": "squash", "path": wtPath,
	})
	if code != 200 {
		t.Fatalf("merge close: %d %v", code, resp)
	}
	if _, err := os.Stat(filepath.Join(repo, "feature.txt")); err != nil {
		t.Fatal("merged change missing in main worktree")
	}
	if _, err := os.Stat(wtPath); err == nil {
		t.Fatal("worktree survived merge close")
	}
	if strings.Contains(tmuxOut("list-sessions", "-F", "#{session_name}"), "e2e-main") {
		t.Fatal("session survived merge close")
	}
}

// Race Service：开赛（先会话后 worktree × N）→ 赢家做出改动 → crown（wip→squash→清理输家）。
func TestRaceLifecycle(t *testing.T) {
	r, tmp, tmuxOut := e2eSetup(t)
	repo := e2eRepo(t, tmp)

	// ① 开赛：2 选手（cmd 留空 = 纯 shell 会话，不真起 agent）
	code, resp := post(t, r, "/races", map[string]any{
		"name": "race-x", "dir": repo, "base": "main", "prompt": "fix it",
		"contestants": []map[string]any{{"agent": "claude"}, {"agent": "codex"}},
	})
	if code != 200 {
		t.Fatalf("races: %d %v", code, resp)
	}
	race := resp["data"].(map[string]any)
	raceID := race["id"].(string)
	cts := race["contestants"].([]any)
	if len(cts) != 2 {
		t.Fatalf("want 2 contestants: %v", cts)
	}
	a := cts[0].(map[string]any)
	loser := cts[1].(map[string]any)
	if a["branch"] != "race-x-a" || loser["branch"] != "race-x-b" {
		t.Fatalf("bad lane branches: %v / %v", a["branch"], loser["branch"])
	}
	sessions := tmuxOut("list-sessions", "-F", "#{session_name}")
	if !strings.Contains(sessions, "race-x-a") || !strings.Contains(sessions, "race-x-b") {
		t.Fatalf("contestant sessions missing: %s", sessions)
	}

	// ② 赢家 worktree 里留未提交改动（crown 应先 wip-commit 再合并）
	winPath := a["path"].(string)
	if err := os.WriteFile(filepath.Join(winPath, "win.txt"), []byte("winner\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// ③ crown：squash 合回 main + 清理输家
	code, resp = post(t, r, "/races/"+raceID+"/crown", map[string]any{
		"winner": a["session"], "strategy": "squash", "cleanup": true,
	})
	if code != 200 {
		t.Fatalf("crown: %d %v", code, resp)
	}
	if st := resp["data"].(map[string]any)["status"]; st != "crowned" {
		t.Fatalf("race status %v", st)
	}
	if _, err := os.Stat(filepath.Join(repo, "win.txt")); err != nil {
		t.Fatal("winner change not merged into main")
	}
	if _, err := os.Stat(loser["path"].(string)); err == nil {
		t.Fatal("loser worktree survived cleanup")
	}
	if strings.Contains(tmuxOut("list-sessions", "-F", "#{session_name}"), "race-x-b") {
		t.Fatal("loser session survived cleanup")
	}
	// 赢家会话/worktree 保留（收尾走 W7/W4）
	if !strings.Contains(tmuxOut("list-sessions", "-F", "#{session_name}"), "race-x-a") {
		t.Fatal("winner session should survive crown")
	}

	// ④ 全部清理：赢家也收掉
	code, resp = post(t, r, "/races/"+raceID+"/cleanup", nil)
	if code != 200 {
		t.Fatalf("cleanup: %d %v", code, resp)
	}
	if _, err := os.Stat(winPath); err == nil {
		t.Fatal("winner worktree survived full cleanup")
	}
}
