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
	"ttmux-web/project"
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

// WorktreeListAll GET /git/worktrees/all —— 跨仓库总览：当前全部会话触达的仓库 → worktree 清单。
func (a *API) WorktreeListAll(c *gin.Context) {
	ctx, cancel := wtCtx(c)
	defer cancel()
	c.JSON(http.StatusOK, gin.H{"data": a.WT.ListAll(ctx)})
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
	// 留痕素材趁 worktree 还在时先取（连分支一起删才算收尾，纯摘 worktree 不留痕）
	var gone *worktree.Worktree
	if b.DeleteBranch {
		if list, err := a.WT.List(ctx, b.Path); err == nil {
			for i := range list {
				if list[i].Path == b.Path {
					gone = &list[i]
				}
			}
		}
	}
	if err := a.WT.Remove(ctx, b); err != nil {
		wtErr(c, err)
		return
	}
	if gone != nil {
		if repo, err := a.WT.ResolveRepo(ctx, filepath.Dir(b.Path)); err == nil {
			action := "discarded"
			if gone.MergedInto != "" {
				action = "cleaned" // 已合入·清理（10 §5）：零损失，与丢弃区分
			}
			a.Projects.Trace(project.TraceEntry{
				Repo: repo.Root, Branch: gone.Branch, HeadOid: gone.Head, Base: gone.Base,
				Action: action, MergedInto: gone.MergedInto, MergedKind: gone.MergedKind,
			})
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}

// WorktreeSync POST /git/worktree/sync {dir} —— 远端轻量同步（10 设计 §3）：
// ls-remote 观测 + fetch 合并目标分支，随后 List 的合入判定吃到新 origin/<base>。
// 只更新 refs/remotes，绝不动工作区（与 GitOp 的 pull/push 语义区分）。失败静默退化。
func (a *API) WorktreeSync(c *gin.Context) {
	var b struct {
		Dir string `json:"dir"`
	}
	if err := c.ShouldBindJSON(&b); err != nil || strings.TrimSpace(b.Dir) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	ctx, cancel := wtCtx(c)
	defer cancel()
	res, err := a.WT.Sync(ctx, filepath.Clean(b.Dir))
	if err != nil {
		wtErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": res})
}

// SyncLoop 后台兜底远端同步（10 设计 §3 第三档）：每 30 分钟对台账内项目做一次
// 轻量 Sync。前台驻留与事件触发由前端调 /git/worktree/sync 承担；这里只兜
// 「没人看着」的时段。非 git 项目 / 失败一律静默跳过。
func (a *API) SyncLoop() {
	t := time.NewTicker(30 * time.Minute)
	defer t.Stop()
	for range t.C {
		for _, e := range a.Projects.Entries() {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			_, _ = a.WT.Sync(ctx, e.Dir)
			cancel()
		}
	}
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
	branches, def, remotes, err := a.WT.Branches(ctx, filepath.Clean(c.Query("dir")))
	if err != nil {
		wtErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"branches": branches, "default": def, "remotes": remotes}})
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
				res["mergedInto"] = w.MergedInto // 合入检测（10 §5）：W7 弹窗按此改文案
				res["mergedKind"] = w.MergedKind
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

// SessionFork POST /sessions/:name/fork {child, dir?}
// 纯 subSession 派生（无 worktree）：ttmux fork（meta 记 parent，缺省继承父 cwd）。
func (a *API) SessionFork(c *gin.Context) {
	parent := sessionParam(c)
	var b struct {
		Child string `json:"child"`
		Dir   string `json:"dir"`
	}
	if err := c.ShouldBindJSON(&b); err != nil || b.Child == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	b.Child = SanitizeSessionName(b.Child)
	args := []string{"fork", parent, b.Child, "--detach", "--json"}
	if d := strings.TrimSpace(b.Dir); d != "" {
		args = append(args, "--dir", d)
	}
	out, err := a.TT.Run(args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "FORK_FAILED", "message": ttmux.StripANSI(out)}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"session": b.Child, "parent": parent}, "name": b.Child})
}

// SessionForkWorktree POST /sessions/:name/fork-worktree {child, branch?, base?, remote?, dir?}
// 编排（先 subSession 后 worktree）：ttmux fork（cwd=父仓库目录，meta 记 parent）→
// 建 worktree（分支缺省自动占位）→ 子会话内注入 cd；失败反向补偿 kill 子会话。
func (a *API) SessionForkWorktree(c *gin.Context) {
	parent := sessionParam(c)
	var b struct {
		Child  string `json:"child"`
		Branch string `json:"branch"`
		Base   string `json:"base"`
		Remote string `json:"remote"`
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
	wt, err := a.WT.Create(ctx, worktree.CreateReq{Dir: dir, Branch: branch, Base: b.Base, Remote: b.Remote})
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
		// 留痕素材趁 worktree 还在时先取：已合入的丢弃 = cleaned（零损失），否则 discarded
		var gone *worktree.Worktree
		if list, err := a.WT.List(ctx, b.Path); err == nil {
			for i := range list {
				if list[i].Path == b.Path {
					gone = &list[i]
				}
			}
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
		if gone != nil {
			if repo, err := a.WT.ResolveRepo(ctx, filepath.Dir(b.Path)); err == nil {
				action := "discarded"
				if gone.MergedInto != "" {
					action = "cleaned"
				}
				a.Projects.Trace(project.TraceEntry{
					Repo: repo.Root, Branch: gone.Branch, HeadOid: gone.Head, Base: gone.Base,
					Action: action, MergedInto: gone.MergedInto, MergedKind: gone.MergedKind,
				})
			}
		}
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_MODE", "message": b.Mode}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"done": stages}})
}

// WorktreeFinish POST /git/worktree/finish
// {path, strategy?, expectedHead?, deleteBranch?, forceDeleteBranch?}
// P3 孤儿任务收尾（08 §5.4）：与 close-with-worktree 的 merge 档同一条链但没有
// kill 步（会话已不在）。冻结校验 expectedHead（确认时的 source HEAD，校验后即
// 作废）→ wip-commit → merge（不把旧 expectedHead 传给 Merge——wip 合法挪 HEAD，
// 同 crown 语义）→ remove → 留痕。每步幂等，失败返回 {stage, done} 前端重试即可，
// 不做 crownDone 式跨请求持久化。
func (a *API) WorktreeFinish(c *gin.Context) {
	var b struct {
		Path              string `json:"path"`
		Strategy          string `json:"strategy"`
		ExpectedHead      string `json:"expectedHead"`
		DeleteBranch      bool   `json:"deleteBranch"`
		ForceDeleteBranch bool   `json:"forceDeleteBranch"`
	}
	if err := c.ShouldBindJSON(&b); err != nil || strings.TrimSpace(b.Path) == "" {
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
	// 留痕素材趁 worktree 还在时先取
	branch := ""
	base := ""
	if list, err := a.WT.List(ctx, b.Path); err == nil {
		for _, w := range list {
			if w.Path == b.Path {
				branch, base = w.Branch, w.Base
			}
		}
	}
	// freeze：确认后漂移即拒（此后该值作废，不再参与任何校验）
	if b.ExpectedHead != "" {
		cur, err := a.WT.Head(ctx, b.Path)
		if err != nil {
			fail("freeze", err)
			return
		}
		if cur != b.ExpectedHead {
			c.JSON(http.StatusConflict, gin.H{"error": gin.H{"code": "HEAD_MOVED", "message": "worktree HEAD moved since confirmation", "stage": "freeze", "done": stages}})
			return
		}
	}
	stages = append(stages, "freeze")
	if err := a.WT.CommitAll(ctx, b.Path, "wip: auto-commit before finish (roam)"); err != nil {
		fail("wip-commit", err)
		return
	}
	stages = append(stages, "wip-commit")
	strategy := b.Strategy
	if strategy == "" {
		strategy = "squash"
	}
	if _, err := a.WT.Merge(ctx, worktree.MergeReq{Path: b.Path, Strategy: strategy}); err != nil {
		fail("merge", err)
		return
	}
	stages = append(stages, "merge")
	head, _ := a.WT.Head(ctx, b.Path)
	if err := a.WT.Remove(ctx, worktree.RemoveReq{
		Path: b.Path, DeleteBranch: b.DeleteBranch,
		ForceDeleteBranch: b.DeleteBranch && (b.ForceDeleteBranch || strategy == "squash"),
	}); err != nil {
		fail("remove", err)
		return
	}
	stages = append(stages, "remove")
	if repo, err := a.WT.ResolveRepo(ctx, filepath.Dir(b.Path)); err == nil {
		a.Projects.Trace(project.TraceEntry{Repo: repo.Root, Branch: branch, HeadOid: head, Base: base, Action: "merged", Strategy: strategy})
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"done": stages, "branch": branch, "base": base}})
}
