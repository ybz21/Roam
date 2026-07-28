package worktree

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// fakeTmux 装一个假 tmux：list-panes 的输出从 panesFile 读，测试中途改文件即可
// 模拟「用户在会话里 cd 走了」/「会话没了」。display-message 也走同一份数据，
// 让 resolveSessionID 能按名字查到 id。返回 panesFile 路径。
func fakeTmux(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	panesFile := filepath.Join(dir, "panes.txt")
	bin := filepath.Join(dir, "tmux")
	// $1=list-panes|display-message；display-message -t =<name>: -p '#{session_id}'
	script := fmt.Sprintf(`#!/bin/sh
case "$1" in
  list-panes) cat %q ;;
  display-message)
    want=$(printf '%%s' "$3" | sed 's/^=//; s/:$//')
    awk -F'\t' -v n="$want" '$2==n {print $1; exit}' %q ;;
esac
`, panesFile, panesFile)
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMUX_BIN", bin)
	return panesFile
}

func setPanes(t *testing.T, panesFile, content string) {
	t.Helper()
	if err := os.WriteFile(panesFile, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// 归属钉死的核心语义：第一次见到就定下来，之后 cwd 怎么变都不改（用户在终端里
// cd 出去，不等于换项目）。
func TestHomePinnedAgainstCwdDrift(t *testing.T) {
	h := newHomeStore("")
	if got := h.pin("$1", "work", "/repo/a"); got != "/repo/a" {
		t.Fatalf("first pin = %q, want /repo/a", got)
	}
	if got := h.pin("$1", "work", "/tmp/elsewhere"); got != "/repo/a" {
		t.Fatalf("cwd 漂移后 home = %q, want /repo/a", got)
	}
	if got := h.get("$1"); got != "/repo/a" {
		t.Fatalf("get = %q, want /repo/a", got)
	}
}

// 键是 session_id 不是名字：改名不影响归属，同名新会话（新 id）也不继承旧归属。
func TestHomeKeyedBySessionID(t *testing.T) {
	h := newHomeStore("")
	h.pin("$1", "work", "/repo/a")
	if got := h.pin("$1", "work-renamed", "/tmp/x"); got != "/repo/a" {
		t.Fatalf("改名后 home = %q, want /repo/a", got)
	}
	if _, home := h.byName("work-renamed"); home != "/repo/a" {
		t.Fatalf("名字快照应跟着更新，byName = %q", home)
	}
	if got := h.pin("$2", "work", "/tmp/fresh"); got != "/tmp/fresh" {
		t.Fatalf("同名新会话不该继承旧归属，got %q", got)
	}
}

// 显式绑定（建会话时就知道目录）覆盖已钉死的值，且不会被后续采样改回去。
func TestBindOverridesPin(t *testing.T) {
	h := newHomeStore("")
	h.pin("$1", "work", "/repo/a")
	h.bind("$1", "work", "/repo/a/.worktrees/task")
	if got := h.pin("$1", "work", "/repo/a"); got != "/repo/a/.worktrees/task" {
		t.Fatalf("home = %q, want worktree 路径", got)
	}
}

// 建会话时问不出 session_id → 按名字挂起，下次 sighting 转正（绑定不丢）。
func TestPendingBindAdoptedOnFirstSighting(t *testing.T) {
	h := newHomeStore("")
	h.bind("", "work", "/repo/a")
	if got := h.pin("$7", "work", "/tmp/somewhere-else"); got != "/repo/a" {
		t.Fatalf("挂起的绑定应被认领，got %q", got)
	}
	if _, ok := h.pending["work"]; ok {
		t.Fatal("认领后不该留 pending")
	}
}

// reconcile 只清死会话；tmux 读失败(alive 空)时一行都不能动。
func TestReconcileKeepsAliveAndSkipsEmpty(t *testing.T) {
	h := newHomeStore("")
	h.bind("$1", "alive", "/repo/a")
	h.bind("$2", "dead", "/repo/b")
	h.reconcile(nil)
	if h.get("$2") == "" {
		t.Fatal("alive 集合为空时不应删任何行")
	}
	h.reconcile(map[string]bool{"$1": true})
	if h.get("$1") != "/repo/a" {
		t.Fatal("活会话归属被误删")
	}
	if h.get("$2") != "" {
		t.Fatal("死会话残行未收敛")
	}
}

// 落盘 + 重建：后端重启不丢归属。
func TestPersistAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	h := newHomeStore(dir)
	h.bind("$3", "work", "/repo/a")
	b, err := os.ReadFile(filepath.Join(dir, "session-homes.json"))
	if err != nil {
		t.Fatalf("未落盘: %v", err)
	}
	var f homeFile
	if err := json.Unmarshal(b, &f); err != nil || f.V != 2 || f.Homes["$3"].Home != "/repo/a" {
		t.Fatalf("落盘内容 = %s (%v)", b, err)
	}
	if got := newHomeStore(dir).get("$3"); got != "/repo/a" {
		t.Fatalf("重启后 home = %q, want /repo/a", got)
	}
}

// v1 文件（会话名 → 目录）：首次见到同名会话时认领一次，之后按 id 走。
func TestLegacyV1FileAdoptedByName(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "session-homes.json"), []byte(`{"work":"/repo/a"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	h := newHomeStore(dir)
	if got := h.pin("$5", "work", "/tmp/now-here"); got != "/repo/a" {
		t.Fatalf("v1 归属未认领，got %q", got)
	}
	if got := newHomeStore(dir).get("$5"); got != "/repo/a" {
		t.Fatalf("认领结果未落盘为 v2，got %q", got)
	}
}

// homePanes：每会话一条、Active=true，带上 id（供 join 复用老的最长前缀逻辑）。
func TestHomePanes(t *testing.T) {
	ps := homePanes([]sessionHome{{ID: "$1", Name: "a", Home: "/repo/a"}, {ID: "$2", Name: "b", Home: "/repo/b"}})
	if len(ps) != 2 || ps[0].Session != "a" || ps[0].ID != "$1" {
		t.Fatalf("panes = %+v", ps)
	}
	for _, p := range ps {
		if !p.Active {
			t.Fatalf("home pane 应为 active: %+v", p)
		}
	}
}

// 端到端语义：会话在仓库里建起来 → cd 去 /tmp → 归属仍是原仓库（annotation.primary）。
func TestAnnotationsStickToHomeAfterCd(t *testing.T) {
	ctx := context.Background()
	repo := mkRepo(t)
	panesFile := fakeTmux(t)
	s := New(t.TempDir())

	setPanes(t, panesFile, "$1\twork\t1\t"+repo+"\n")
	ann := s.Annotations(ctx)["work"]
	if ann == nil || ann.Primary == nil || ann.Primary.Repo != canonical(repo) {
		t.Fatalf("建会话时归属应为 %s，实得 %+v", repo, ann)
	}
	if ann.SessionID != "$1" {
		t.Fatalf("annotation 应带 sessionId，got %q", ann.SessionID)
	}

	// 用户 cd 到仓库外（连 git 仓库都不是）——归属不许跟着走
	away := t.TempDir()
	setPanes(t, panesFile, "$1\twork\t1\t"+away+"\n")
	ann = s.Annotations(ctx)["work"]
	if ann == nil || ann.Primary == nil || ann.Primary.Repo != canonical(repo) {
		t.Fatalf("cd 走之后归属漂了: %+v", ann)
	}
	if ann.Home != canonical(repo) {
		t.Fatalf("home = %q, want %q", ann.Home, canonical(repo))
	}
	if cwds := s.SessionCwds(ctx)["work"]; len(cwds) != 1 || cwds[0] != canonical(repo) {
		t.Fatalf("SessionCwds = %v, want [%s]", cwds, canonical(repo))
	}

	// 会话改名：归属钉在 $1 上，一点不受影响
	setPanes(t, panesFile, "$1\twork2\t1\t"+away+"\n")
	if ann = s.Annotations(ctx)["work2"]; ann == nil || ann.Primary == nil || ann.Primary.Repo != canonical(repo) {
		t.Fatalf("改名后归属漂了: %+v", ann)
	}

	// 会话没了 → 下一轮采样即收敛，不留残行（不靠 kill 时手动清）
	setPanes(t, panesFile, "$9\tother\t1\t"+away+"\n")
	_ = s.Annotations(ctx)
	if h := s.SessionHome("work2"); h != "" {
		t.Fatalf("死会话残行未清: %q", h)
	}
	// 同名新会话（新 id）不继承旧归属
	setPanes(t, panesFile, "$9\twork2\t1\t"+away+"\n")
	if ann := s.Annotations(ctx)["work2"]; ann == nil || ann.Home != canonical(away) {
		t.Fatalf("同名新会话应按自己的 cwd 钉: %+v", ann)
	}
}

// 建会话即绑定：BindSessionHome 只拿到名字，靠 tmux 解析 session_id。
func TestBindSessionHomeResolvesID(t *testing.T) {
	ctx := context.Background()
	repo := mkRepo(t)
	panesFile := fakeTmux(t)
	s := New(t.TempDir())
	// 会话刚建好（cwd 还在家目录），编排层立刻把它钉到 repo 上
	home := t.TempDir()
	setPanes(t, panesFile, "$4\tfresh\t1\t"+home+"\n")
	s.BindSessionHome("fresh", repo)
	if got := s.SessionHome("fresh"); got != canonical(repo) {
		t.Fatalf("SessionHome = %q, want %q", got, canonical(repo))
	}
	if ann := s.Annotations(ctx)["fresh"]; ann == nil || ann.Home != canonical(repo) {
		t.Fatalf("采样不该覆盖显式绑定: %+v", ann)
	}
}
