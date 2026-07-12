package worktree

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// mkRepo 造一个带一次提交的普通仓库，返回根路径。
func mkRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(scrubGitEnv(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return string(out)
	}
	run("init", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "init")
	return dir
}

func commitFile(t *testing.T, dir, name, content, msg string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("git", "-C", dir, "add", ".")
	cmd.Env = scrubGitEnv()
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("add: %v %s", err, out)
	}
	cmd = exec.Command("git", "-C", dir, "commit", "-m", msg)
	cmd.Env = append(scrubGitEnv(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("commit: %v %s", err, out)
	}
}

// base 缺省应始终回到本地主干（main/master），不能是当前检出的 feature 分支
// （很多仓库没设 origin/HEAD，旧逻辑会兜底到 HEAD 分支）。
func TestDefaultBasePrefersMain(t *testing.T) {
	ctx := context.Background()
	s := New()
	repo := mkRepo(t)
	// 检出到 feature 分支再建 worktree（不传 base）
	cmd := exec.Command("git", "-C", repo, "checkout", "-q", "-b", "feat/wip")
	cmd.Env = scrubGitEnv()
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("checkout: %v %s", err, out)
	}
	resp, err := s.Create(ctx, CreateReq{Dir: repo, Branch: "probe-base"})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Base != "main" {
		t.Fatalf("default base = %q, want main", resp.Base)
	}
}

func TestCreateListRemove(t *testing.T) {
	ctx := context.Background()
	s := New()
	repo := mkRepo(t)

	resp, err := s.Create(ctx, CreateReq{Dir: repo, Branch: "roam/feat-x", Base: "main"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if resp.Branch != "roam/feat-x" || resp.Base != "main" || resp.StartOid == "" {
		t.Fatalf("bad resp: %+v", resp)
	}
	if !strings.Contains(resp.Path, ".worktrees") {
		t.Fatalf("path not under .worktrees: %s", resp.Path)
	}
	// 同名再建 → 锁内分配 -2
	resp2, err := s.Create(ctx, CreateReq{Dir: repo, Branch: "roam/feat-x", Base: "main"})
	if err != nil {
		t.Fatalf("create2: %v", err)
	}
	if resp2.Branch != "roam/feat-x-2" {
		t.Fatalf("expected suffix branch, got %s", resp2.Branch)
	}
	// info/exclude 幂等追加
	b, _ := os.ReadFile(filepath.Join(repo, ".git", "info", "exclude"))
	if !strings.Contains(string(b), "/.worktrees/") {
		t.Fatalf("info/exclude missing entry: %s", b)
	}

	// list：身份/主 worktree 标记
	s.cache = map[string]listCache{} // 绕过缓存
	list, err := s.List(ctx, repo)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("want 3 worktrees, got %d", len(list))
	}
	var wt *Worktree
	for i := range list {
		if list[i].Branch == "roam/feat-x" {
			wt = &list[i]
		}
		if list[i].IsMain && list[i].Branch != "main" {
			t.Fatalf("main worktree mislabelled: %+v", list[i])
		}
	}
	if wt == nil || wt.Base != "main" || wt.External {
		t.Fatalf("roam worktree identity wrong: %+v", wt)
	}

	// 脏保护：未提交改动默认拒删
	if err := os.WriteFile(filepath.Join(resp.Path, "b.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	err = s.Remove(ctx, RemoveReq{Path: resp.Path, IgnoreSessions: true})
	we, ok := err.(*Err)
	if !ok || we.Code != "WORKTREE_DIRTY" {
		t.Fatalf("want WORKTREE_DIRTY, got %v", err)
	}
	// force 删 + 删分支
	if err := s.Remove(ctx, RemoveReq{Path: resp.Path, ForceWorktree: true, DeleteBranch: true, IgnoreSessions: true}); err != nil {
		t.Fatalf("force remove: %v", err)
	}
	if branchExists(ctx, Repo{Root: repo}, "roam/feat-x") {
		t.Fatal("branch should be deleted")
	}
}

func TestExternalWorktreeBaseUnknown(t *testing.T) {
	ctx := context.Background()
	s := New()
	repo := mkRepo(t)
	ext := filepath.Join(repo, ".worktrees", "ext")
	cmd := exec.Command("git", "-C", repo, "worktree", "add", "-b", "hand-made", ext)
	cmd.Env = scrubGitEnv()
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("external add: %v %s", err, out)
	}
	list, err := s.List(ctx, repo)
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range list {
		if w.Branch == "hand-made" {
			if !w.External || w.Base != "" {
				t.Fatalf("external worktree should have unknown base: %+v", w)
			}
			// base unknown → diff/merge 拒绝
			if _, err := s.DiffBase(ctx, w.Path); err == nil || err.(*Err).Code != "BASE_UNKNOWN" {
				t.Fatalf("diff should refuse: %v", err)
			}
			if _, err := s.Merge(ctx, MergeReq{Path: w.Path, Strategy: "merge"}); err == nil || err.(*Err).Code != "BASE_UNKNOWN" {
				t.Fatalf("merge should refuse: %v", err)
			}
			return
		}
	}
	t.Fatal("external worktree not listed")
}

func TestMergeSquashAndConflict(t *testing.T) {
	ctx := context.Background()
	s := New()
	repo := mkRepo(t)

	resp, err := s.Create(ctx, CreateReq{Dir: repo, Branch: "roam/ok", Base: "main"})
	if err != nil {
		t.Fatal(err)
	}
	commitFile(t, resp.Path, "feat.txt", "feature\n", "feat")

	// squash 合并成功（base=main checkout 在主 worktree）
	mr, err := s.Merge(ctx, MergeReq{Path: resp.Path, Strategy: "squash"})
	if err != nil {
		t.Fatalf("squash: %v", err)
	}
	if mr.MergedOid == "" {
		t.Fatal("no merged oid")
	}
	if _, err := os.Stat(filepath.Join(repo, "feat.txt")); err != nil {
		t.Fatal("squash result missing in main worktree")
	}

	// 冲突：两边改同一文件
	c, err := s.Create(ctx, CreateReq{Dir: repo, Branch: "roam/conflict", Base: "main"})
	if err != nil {
		t.Fatal(err)
	}
	commitFile(t, c.Path, "a.txt", "branch version\n", "branch change")
	commitFile(t, repo, "a.txt", "main version\n", "main change")

	_, err = s.Merge(ctx, MergeReq{Path: c.Path, Strategy: "merge"})
	we, ok := err.(*Err)
	if !ok || we.Code != "MERGE_CONFLICT" {
		t.Fatalf("want MERGE_CONFLICT, got %v", err)
	}
	files, _ := we.Extra["conflictFiles"].([]string)
	if len(files) != 1 || files[0] != "a.txt" {
		t.Fatalf("conflict files wrong: %v", we.Extra)
	}
	// abort 后主 worktree 干净、无半成品
	if !isClean(ctx, repo) {
		t.Fatal("main worktree left dirty after abort")
	}
	if p := inProgress(ctx, repo); p != "" {
		t.Fatalf("operation left in progress: %s", p)
	}

	// rebase 路径：解决 conflict 场景外的正常 rebase
	r, err := s.Create(ctx, CreateReq{Dir: repo, Branch: "roam/rebase", Base: "main"})
	if err != nil {
		t.Fatal(err)
	}
	commitFile(t, r.Path, "r.txt", "r\n", "r change")
	commitFile(t, repo, "m.txt", "m\n", "advance main")
	if _, err := s.Merge(ctx, MergeReq{Path: r.Path, Strategy: "rebase"}); err != nil {
		t.Fatalf("rebase merge: %v", err)
	}
	if _, err := os.Stat(filepath.Join(repo, "r.txt")); err != nil {
		t.Fatal("rebase ff result missing")
	}
}

func TestExpectedHeadGuard(t *testing.T) {
	ctx := context.Background()
	s := New()
	repo := mkRepo(t)
	resp, err := s.Create(ctx, CreateReq{Dir: repo, Branch: "roam/drift", Base: "main"})
	if err != nil {
		t.Fatal(err)
	}
	commitFile(t, resp.Path, "d.txt", "d\n", "d")
	_, err = s.Merge(ctx, MergeReq{Path: resp.Path, Strategy: "merge", ExpectedHead: "deadbeef"})
	if we, ok := err.(*Err); !ok || we.Code != "HEAD_MOVED" {
		t.Fatalf("want HEAD_MOVED, got %v", err)
	}
}
