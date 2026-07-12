// Worktree API 三层（设计 07 §4）：
//   - Worktree API：薄转发 worktree.Service（领域服务独占 git 操作）
//   - Session API：转发 ttmux CLI（fork/annotations）
//   - 组合 WorktreeSession API：事务编排（建 worktree → 建会话 → 失败反向补偿）
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"ttmux-web/ttmux"
	"ttmux-web/worktree"
)

func wtCtx(c *gin.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(c.Request.Context(), 60*time.Second)
}

// wtErr 把领域错误映射为结构化 JSON（保留 code + extra）。
func wtErr(c *gin.Context, err error) {
	if we, ok := err.(*worktree.Err); ok {
		status := http.StatusConflict
		switch we.Code {
		case "BAD_PATH", "BAD_BRANCH", "BAD_BASE", "BAD_STRATEGY", "NOT_GIT_REPO", "BAD_REQUEST":
			status = http.StatusBadRequest
		}
		body := gin.H{"code": we.Code, "message": we.Message}
		for k, v := range we.Extra {
			body[k] = v
		}
		c.JSON(status, gin.H{"error": body})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "INTERNAL", "message": err.Error()}})
}

// ── Worktree API ─────────────────────────────────────────

// WorktreeCreate POST /git/worktree {dir, branch?, base?, remote?}
func (a *API) WorktreeCreate(c *gin.Context) {
	var b worktree.CreateReq
	if err := c.ShouldBindJSON(&b); err != nil || strings.TrimSpace(b.Dir) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	ctx, cancel := wtCtx(c)
	defer cancel()
	resp, err := a.WT.Create(ctx, b)
	if err != nil {
		wtErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": resp})
}

// WorktreeList GET /git/worktrees?dir=
func (a *API) WorktreeList(c *gin.Context) {
	dir := filepath.Clean(c.Query("dir"))
	ctx, cancel := wtCtx(c)
	defer cancel()
	list, err := a.WT.List(ctx, dir)
	if err != nil {
		wtErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": list})
}

// WorktreeDiff GET /git/worktree/diff?path=[&file=] —— 无 file 返回统计，带 file 返回该文件 diff 文本。
func (a *API) WorktreeDiff(c *gin.Context) {
	ctx, cancel := wtCtx(c)
	defer cancel()
	path := filepath.Clean(c.Query("path"))
	if file := c.Query("file"); file != "" {
		text, err := a.WT.DiffBaseFile(ctx, path, file)
		if err != nil {
			wtErr(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"diff": text}})
		return
	}
	resp, err := a.WT.DiffBase(ctx, path)
	if err != nil {
		wtErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": resp})
}

// WorktreeMerge POST /git/worktree/merge {path, strategy, expectedHead?}
func (a *API) WorktreeMerge(c *gin.Context) {
	var b worktree.MergeReq
	if err := c.ShouldBindJSON(&b); err != nil || b.Path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	ctx, cancel := wtCtx(c)
	defer cancel()
	resp, err := a.WT.Merge(ctx, b)
	if err != nil {
		wtErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": resp})
}

// WorktreeRemove POST /git/worktree/remove {path, forceWorktree?, deleteBranch?, forceDeleteBranch?}
func (a *API) WorktreeRemove(c *gin.Context) {
	var b worktree.RemoveReq
	if err := c.ShouldBindJSON(&b); err != nil || b.Path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	ctx, cancel := wtCtx(c)
	defer cancel()
	if err := a.WT.Remove(ctx, b); err != nil {
		wtErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}

// WorktreePrune POST /git/worktree/prune {dir}
func (a *API) WorktreePrune(c *gin.Context) {
	var b struct {
		Dir string `json:"dir"`
	}
	if err := c.ShouldBindJSON(&b); err != nil || b.Dir == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	ctx, cancel := wtCtx(c)
	defer cancel()
	if err := a.WT.Prune(ctx, b.Dir); err != nil {
		wtErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}

// GitBranches GET /git/branches?dir= —— W1 start-from 选择器数据源。
func (a *API) GitBranches(c *gin.Context) {
	ctx, cancel := wtCtx(c)
	defer cancel()
	branches, def, err := a.WT.Branches(ctx, filepath.Clean(c.Query("dir")))
	if err != nil {
		wtErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"branches": branches, "default": def}})
}

// ── Session API 增量 ─────────────────────────────────────

// SessionAnnotations GET /sessions/annotations —— {session → {primary, matches[], ambiguous}}
func (a *API) SessionAnnotations(c *gin.Context) {
	ctx, cancel := wtCtx(c)
	defer cancel()
	c.JSON(http.StatusOK, gin.H{"data": a.WT.Annotations(ctx)})
}

// SessionWorktreeStatus GET /sessions/:name/worktree-status —— W7 关闭前预检。
func (a *API) SessionWorktreeStatus(c *gin.Context) {
	name := sessionParam(c)
	ctx, cancel := wtCtx(c)
	defer cancel()
	ann := a.WT.Annotations(ctx)[name]
	if ann == nil || ann.Primary == nil || !ann.Primary.Linked {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"inWorktree": false}})
		return
	}
	hit := ann.Primary
	res := gin.H{"inWorktree": true, "path": hit.Worktree, "branch": hit.Branch, "repo": hit.Repo}
	if list, err := a.WT.List(ctx, hit.Worktree); err == nil {
		for _, w := range list {
			if w.Path == hit.Worktree {
				res["base"] = w.Base
				res["dirty"] = w.Dirty
				res["untracked"] = w.Untracked
				res["committedAhead"] = w.CommittedAhead
				res["external"] = w.External
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": res})
}

// ── 组合 WorktreeSession API（事务编排）──────────────────

// autoBranch 从会话名派生占位分支（纯 slug，不强加前缀——用户想要什么前缀
// 由 agent 开工后 `git branch -m` 自定，或走 W4 手动指定；roam 身份在
// roam.* worktree config 里，不靠分支名）。
func autoBranch(session string) string {
	s := strings.ToLower(session)
	s = strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-' {
			return r
		}
		return '-'
	}, s)
	s = strings.Trim(s, "-.")
	for strings.Contains(s, "--") {
		s = strings.ReplaceAll(s, "--", "-")
	}
	if s == "" {
		s = "task"
	}
	return s
}

// shellQuote POSIX 单引号包裹（路径注入会话 shell 时防空格/特殊字符）。
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// cdInto 往会话 shell 排队一条 cd——先建会话再建 worktree 的收尾步：
// 键入先于前端随后发送的 agent 启动指令，shell 按序执行，且 cd 留在回滚里可见。
// pane 目标必须写 =name:（精确会话+缺省窗口）：tmux 3.4 send-keys 对裸 =name 报 can't find pane。
func (a *API) cdInto(session, path string) error {
	if _, err := a.TT.Run("send-keys", "-t", "="+session+":", "-l", "cd "+shellQuote(path)); err != nil {
		return err
	}
	_, err := a.TT.Run("send-keys", "-t", "="+session+":", "Enter")
	return err
}

// WorktreeSessionCreate POST /worktree-sessions {name, dir, branch?, base?, remote?}
// 编排（先会话后 worktree）：ttmux 建会话（cwd=所选目录）→ Worktree Service 建 worktree
// （分支缺省自动占位）→ 会话内注入 cd；worktree 失败反向补偿 kill 会话。
func (a *API) WorktreeSessionCreate(c *gin.Context) {
	var b struct {
		Name   string `json:"name"`
		Dir    string `json:"dir"`
		Branch string `json:"branch"`
		Base   string `json:"base"`
		Remote string `json:"remote"`
	}
	if err := c.ShouldBindJSON(&b); err != nil || b.Name == "" || strings.TrimSpace(b.Dir) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	b.Name = SanitizeSessionName(b.Name)
	ctx, cancel := wtCtx(c)
	defer cancel()
	if out, err := a.TT.Run("new-session", "-d", "-s", b.Name, "-c", b.Dir); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "SESSION_FAILED", "message": ttmux.StripANSI(out)}})
		return
	}
	branch := strings.TrimSpace(b.Branch)
	if branch == "" {
		branch = autoBranch(b.Name)
	}
	wt, err := a.WT.Create(ctx, worktree.CreateReq{Dir: b.Dir, Branch: branch, Base: b.Base, Remote: b.Remote})
	if err != nil {
		_, _ = a.TT.Run("kill", b.Name, "--yes")
		wtErr(c, err)
		return
	}
	_ = a.cdInto(b.Name, wt.Path)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"session": b.Name, "path": wt.Path, "branch": wt.Branch, "base": wt.Base}, "name": b.Name})
}

// SessionForkWorktree POST /sessions/:name/fork-worktree {child, branch?, base?, dir?}
// 编排（先 subSession 后 worktree）：ttmux fork（cwd=父仓库目录，meta 记 parent）→
// 建 worktree（分支缺省自动占位）→ 子会话内注入 cd；失败反向补偿 kill 子会话。
func (a *API) SessionForkWorktree(c *gin.Context) {
	parent := sessionParam(c)
	var b struct {
		Child  string `json:"child"`
		Branch string `json:"branch"`
		Base   string `json:"base"`
		Dir    string `json:"dir"`
	}
	if err := c.ShouldBindJSON(&b); err != nil || b.Child == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	b.Child = SanitizeSessionName(b.Child)
	ctx, cancel := wtCtx(c)
	defer cancel()
	dir := strings.TrimSpace(b.Dir)
	if dir == "" {
		if out, err := a.TT.Run("list-panes", "-t", "="+parent, "-F", "#{pane_active}\t#{pane_current_path}"); err == nil {
			for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
				active, cwd, ok := strings.Cut(line, "\t")
				if ok && (dir == "" || active == "1") {
					dir = cwd
				}
			}
		}
	}
	if dir == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "NO_DIR", "message": "cannot resolve parent cwd; pass dir explicitly"}})
		return
	}
	out, err := a.TT.Run("fork", parent, b.Child, "--dir", dir, "--detach", "--json")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "FORK_FAILED", "message": ttmux.StripANSI(out)}})
		return
	}
	var forked map[string]string
	_ = json.Unmarshal([]byte(out), &forked)
	branch := strings.TrimSpace(b.Branch)
	if branch == "" {
		branch = autoBranch(b.Child)
	}
	wt, err := a.WT.Create(ctx, worktree.CreateReq{Dir: dir, Branch: branch, Base: b.Base})
	if err != nil {
		_, _ = a.TT.Run("kill", b.Child, "--yes")
		wtErr(c, err)
		return
	}
	_ = a.cdInto(b.Child, wt.Path)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"session": b.Child, "parent": parent, "path": wt.Path, "branch": wt.Branch, "base": wt.Base}, "name": b.Child})
}

// SessionCloseWithWorktree POST /sessions/:name/close-with-worktree
// {mode: keep|merge|discard, path?, strategy?, expectedHead?}
// W7 三选一状态机：每步失败即停、返回已完成阶段（可恢复）。
func (a *API) SessionCloseWithWorktree(c *gin.Context) {
	name := sessionParam(c)
	var b struct {
		Mode         string `json:"mode"`
		Path         string `json:"path"`
		Strategy     string `json:"strategy"`
		ExpectedHead string `json:"expectedHead"`
	}
	if err := c.ShouldBindJSON(&b); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	ctx, cancel := wtCtx(c)
	defer cancel()

	stages := []string{}
	fail := func(stage string, err error) {
		if we, ok := err.(*worktree.Err); ok {
			body := gin.H{"code": we.Code, "message": we.Message, "stage": stage, "done": stages}
			for k, v := range we.Extra {
				body[k] = v
			}
			c.JSON(http.StatusConflict, gin.H{"error": body})
			return
		}
		c.JSON(http.StatusConflict, gin.H{"error": gin.H{"code": "STAGE_FAILED", "message": err.Error(), "stage": stage, "done": stages}})
	}
	kill := func() error {
		out, err := a.TT.Run("kill", name, "--yes")
		if err != nil {
			return &worktree.Err{Code: "KILL_FAILED", Message: ttmux.StripANSI(out)}
		}
		return nil
	}

	switch b.Mode {
	case "keep", "":
		if err := kill(); err != nil {
			fail("kill", err)
			return
		}
		stages = append(stages, "kill")
	case "merge":
		if b.Path == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST", "message": "path required for merge mode"}})
			return
		}
		strategy := b.Strategy
		if strategy == "" {
			strategy = "squash"
		}
		// 未提交改动先落一笔 wip，再合并
		if err := a.WT.CommitAll(ctx, b.Path, "wip: auto-commit before merge (roam close)"); err != nil {
			fail("wip-commit", err)
			return
		}
		stages = append(stages, "wip-commit")
		if _, err := a.WT.Merge(ctx, worktree.MergeReq{Path: b.Path, Strategy: strategy, ExpectedHead: b.ExpectedHead}); err != nil {
			fail("merge", err)
			return
		}
		stages = append(stages, "merge")
		if err := kill(); err != nil {
			fail("kill", err)
			return
		}
		stages = append(stages, "kill")
		if err := a.WT.Remove(ctx, worktree.RemoveReq{Path: b.Path, DeleteBranch: true, ForceDeleteBranch: strategy == "squash", IgnoreSessions: true}); err != nil {
			fail("remove", err)
			return
		}
		stages = append(stages, "remove")
	case "discard":
		if b.Path == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST", "message": "path required for discard mode"}})
			return
		}
		if err := kill(); err != nil {
			fail("kill", err)
			return
		}
		stages = append(stages, "kill")
		if err := a.WT.Remove(ctx, worktree.RemoveReq{Path: b.Path, ForceWorktree: true, ForceDeleteBranch: true, DeleteBranch: true, IgnoreSessions: true}); err != nil {
			fail("remove", err)
			return
		}
		stages = append(stages, "remove")
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_MODE", "message": b.Mode}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"done": stages}})
}
