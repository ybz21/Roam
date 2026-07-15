package api

import (
	"strings"
	"testing"
)

// auto_leader.md.tmpl 渲染失败会静默降级（Leader 拿到裸 /cc-swarm），
// 所以模板语法/字段必须有测试兜底。
func TestRenderLeaderKickoff(t *testing.T) {
	base := promptCtx{Swarm: "demo", Goal: "做个登录页", Member: "cc-demo", Workdir: "/tmp/x", SkillsDir: "/tmp/skills"}

	p := renderLeaderKickoff(base)
	if p == "" || !strings.Contains(p, "cc-demo") || !strings.Contains(p, "做个登录页") {
		t.Fatalf("基础渲染失败: %q", p[:min(len(p), 120)])
	}
	if strings.Contains(p, "班子建议") || strings.Contains(p, "Worktree 约定") {
		t.Fatal("未传 roster/worktree 时不应出现对应条款（向后兼容）")
	}

	// 项目页发起：班子建议 + worktree 约定条款（09 §4）
	ctx := base
	ctx.Roster = []string{"frontend", "qa"}
	ctx.WorktreePolicy = true
	p = renderLeaderKickoff(ctx)
	if !strings.Contains(p, "班子建议") || !strings.Contains(p, "`frontend`") || !strings.Contains(p, "`qa`") {
		t.Fatal("Roster 条款未渲染")
	}
	if !strings.Contains(p, "Worktree 约定") || !strings.Contains(p, "fork-worktree") {
		t.Fatal("WorktreePolicy 条款未渲染")
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
