// Git 面板「提交树 / 分支 / 操作」服务层：
//
//	GET  /git/graph   提交 DAG（含 parents 与 refs，泳道布局交给前端算）
//	GET  /git/refs    本地分支 / 远端分支 / 标签 / 储藏
//	GET  /git/show    单个提交的元信息 + 文件清单（numstat + name-status）
//	POST /git/action  本地引用操作（checkout / 分支 / 合并 / 变基 / reset / revert / stash …）
//
// 远端操作仍走 git.go 的 GitOp；这里只做本地引用与工作区的写。
package api

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const gitUS = "\x1f" // 字段分隔符（%x1f / %1f），避开提交信息里可能出现的任何可见字符

// gitReadRoot 把请求里的 dir/root 归一成仓库根；非仓库返回 ok=false 并已写响应。
func gitReadRoot(c *gin.Context) (string, context.Context, context.CancelFunc, bool) {
	dir := filepath.Clean(firstNonEmpty(c.Query("root"), c.Query("dir")))
	if dir == "" || !filepath.IsAbs(dir) {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_PATH"}})
		return "", nil, nil, false
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	root, err := runGit(ctx, dir, "rev-parse", "--show-toplevel")
	if err != nil {
		cancel()
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"repo": false}})
		return "", nil, nil, false
	}
	return strings.TrimSpace(root), ctx, cancel, true
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v != "" {
			return v
		}
	}
	return ""
}

func atoiOr(s string, def int) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return def
}

type gitRef struct {
	Name string `json:"name"` // 展示名：main / origin/main / v1.0 / stash@{0}
	Kind string `json:"kind"` // head | branch | remote | tag | stash | other
}

type graphCommit struct {
	Hash    string   `json:"hash"`
	Short   string   `json:"short"`
	Parents []string `json:"parents"`
	Subject string   `json:"subject"`
	Author  string   `json:"author"`
	Email   string   `json:"email"`
	Date    string   `json:"date"` // ISO-8601，前端按语言本地化
	When    string   `json:"when"` // git 的相对时间，作为兜底
	Refs    []gitRef `json:"refs"`
}

// parseDecorate 解析 %D：`HEAD -> main, origin/main, tag: v1.0`
func parseDecorate(d string, headBranch string) []gitRef {
	refs := []gitRef{}
	for _, raw := range strings.Split(d, ",") {
		s := strings.TrimSpace(raw)
		if s == "" {
			continue
		}
		switch {
		case strings.HasPrefix(s, "HEAD -> "):
			refs = append(refs, gitRef{Name: strings.TrimPrefix(s, "HEAD -> "), Kind: "head"})
		case s == "HEAD":
			refs = append(refs, gitRef{Name: "HEAD", Kind: "head"})
		case strings.HasPrefix(s, "tag: "):
			refs = append(refs, gitRef{Name: strings.TrimPrefix(s, "tag: "), Kind: "tag"})
		case strings.HasPrefix(s, "refs/stash"):
			refs = append(refs, gitRef{Name: "stash", Kind: "stash"})
		case strings.Contains(s, "/"):
			refs = append(refs, gitRef{Name: s, Kind: "remote"})
		default:
			kind := "branch"
			if s == headBranch {
				kind = "head"
			}
			refs = append(refs, gitRef{Name: s, Kind: kind})
		}
	}
	return refs
}

// GitGraph GET /git/graph?dir=&limit=&skip=&scope=all|current&q=
// 返回按 date-order 排好的提交序列；泳道（lane）由前端按 parents 计算，后端只保证顺序稳定。
func (a *API) GitGraph(c *gin.Context) {
	root, ctx, cancel, ok := gitReadRoot(c)
	if !ok {
		return
	}
	defer cancel()

	limit := atoiOr(c.Query("limit"), 150)
	if limit <= 0 || limit > 1000 {
		limit = 150
	}
	skip := atoiOr(c.Query("skip"), 0)
	if skip < 0 {
		skip = 0
	}

	args := []string{"log", "--date-order", "--decorate=short",
		"--pretty=format:%H" + gitUS + "%h" + gitUS + "%P" + gitUS + "%s" + gitUS + "%an" + gitUS + "%ae" + gitUS + "%aI" + gitUS + "%ar" + gitUS + "%D",
		"-n", strconv.Itoa(limit + 1)} // 多取一条用来判断 hasMore
	if skip > 0 {
		args = append(args, "--skip", strconv.Itoa(skip))
	}
	if c.Query("scope") != "current" {
		args = append(args, "--all")
	}
	if q := strings.TrimSpace(c.Query("q")); q != "" {
		// 只按提交信息搜：git 会把 --author 和 --grep 取交集，混在一起反而搜不到东西
		args = append(args, "--regexp-ignore-case", "--fixed-strings", "--grep="+q)
	}
	args = append(args, "--")

	head := strings.TrimSpace(mustGit(ctx, root, "rev-parse", "HEAD"))
	headBranch := strings.TrimSpace(mustGit(ctx, root, "rev-parse", "--abbrev-ref", "HEAD"))

	out, err := runGit(ctx, root, args...)
	if err != nil { // 空仓库（无提交）也会走到这里
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"repo": true, "root": root, "commits": []graphCommit{}, "hasMore": false}})
		return
	}

	commits := []graphCommit{}
	for _, line := range strings.Split(out, "\n") {
		p := strings.Split(line, gitUS)
		if len(p) < 9 {
			continue
		}
		gc := graphCommit{Hash: p[0], Short: p[1], Subject: p[3], Author: p[4], Email: p[5], Date: p[6], When: p[7]}
		if p[2] != "" {
			gc.Parents = strings.Fields(p[2])
		} else {
			gc.Parents = []string{}
		}
		gc.Refs = parseDecorate(p[8], headBranch)
		commits = append(commits, gc)
	}
	hasMore := len(commits) > limit
	if hasMore {
		commits = commits[:limit]
	}

	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"repo": true, "root": root, "head": head, "branch": headBranch,
		"commits": commits, "hasMore": hasMore, "skip": skip,
	}})
}

// mustGit 只取输出、吞掉错误——用于「拿不到就当空」的辅助信息。
func mustGit(ctx context.Context, dir string, args ...string) string {
	out, err := runGit(ctx, dir, args...)
	if err != nil {
		return ""
	}
	return out
}

type branchInfo struct {
	Name     string `json:"name"`
	Short    string `json:"short"` // 头提交短 hash
	Upstream string `json:"upstream,omitempty"`
	Ahead    int    `json:"ahead"`
	Behind   int    `json:"behind"`
	Gone     bool   `json:"gone"` // upstream 已消失
	Date     string `json:"date"`
	Subject  string `json:"subject"`
	Current  bool   `json:"current"`
	Remote   bool   `json:"remote"`
	Worktree string `json:"worktree,omitempty"` // 被别的 worktree 占用时的路径
}

// parseTrack 解析 %(upstream:track)：`[ahead 2, behind 1]` / `[gone]`
func parseTrack(s string) (ahead, behind int, gone bool) {
	s = strings.Trim(s, "[]")
	if s == "gone" {
		return 0, 0, true
	}
	for _, part := range strings.Split(s, ",") {
		f := strings.Fields(strings.TrimSpace(part))
		if len(f) != 2 {
			continue
		}
		n, _ := strconv.Atoi(f[1])
		if f[0] == "ahead" {
			ahead = n
		} else if f[0] == "behind" {
			behind = n
		}
	}
	return
}

func forEachRef(ctx context.Context, root, pattern string, remote bool) []branchInfo {
	const f = "%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track)%1f" +
		"%(committerdate:iso-strict)%1f%(contents:subject)%1f%(HEAD)%1f%(worktreepath)"
	out := mustGit(ctx, root, "for-each-ref", "--sort=-committerdate", "--format="+f, pattern)
	list := []branchInfo{}
	for _, line := range strings.Split(out, "\n") {
		p := strings.Split(strings.TrimRight(line, "\r"), gitUS)
		if len(p) < 7 || p[0] == "" {
			continue
		}
		bi := branchInfo{Name: p[0], Short: p[1], Upstream: p[2], Date: p[4], Subject: p[5], Current: p[6] == "*", Remote: remote}
		bi.Ahead, bi.Behind, bi.Gone = parseTrack(p[3])
		if len(p) > 7 {
			bi.Worktree = p[7]
		}
		if remote && strings.HasSuffix(bi.Name, "/HEAD") {
			continue // origin/HEAD 是符号引用，列表里没意义
		}
		list = append(list, bi)
	}
	return list
}

type stashEntry struct {
	Ref     string `json:"ref"`
	Hash    string `json:"hash"`
	Subject string `json:"subject"`
	When    string `json:"when"`
	Date    string `json:"date"`
}

type tagInfo struct {
	Name    string `json:"name"`
	Short   string `json:"short"`
	Date    string `json:"date"`
	Subject string `json:"subject"`
}

// GitRefs GET /git/refs?dir= —— 分支页数据源：本地/远端分支、标签、储藏。
func (a *API) GitRefs(c *gin.Context) {
	root, ctx, cancel, ok := gitReadRoot(c)
	if !ok {
		return
	}
	defer cancel()

	locals := forEachRef(ctx, root, "refs/heads", false)
	remotes := forEachRef(ctx, root, "refs/remotes", true)

	tags := []tagInfo{}
	tagOut := mustGit(ctx, root, "for-each-ref", "--sort=-creatordate", "--count=100",
		"--format=%(refname:short)%1f%(objectname:short)%1f%(creatordate:iso-strict)%1f%(contents:subject)", "refs/tags")
	for _, line := range strings.Split(tagOut, "\n") {
		if p := strings.Split(line, gitUS); len(p) >= 4 && p[0] != "" {
			tags = append(tags, tagInfo{Name: p[0], Short: p[1], Date: p[2], Subject: p[3]})
		}
	}

	stashes := []stashEntry{}
	stashOut := mustGit(ctx, root, "stash", "list", "--pretty=%gd"+gitUS+"%H"+gitUS+"%s"+gitUS+"%ar"+gitUS+"%aI")
	for _, line := range strings.Split(stashOut, "\n") {
		if p := strings.Split(line, gitUS); len(p) >= 5 && p[0] != "" {
			stashes = append(stashes, stashEntry{Ref: p[0], Hash: p[1], Subject: p[2], When: p[3], Date: p[4]})
		}
	}

	remoteNames := []string{}
	for _, r := range strings.Split(strings.TrimSpace(mustGit(ctx, root, "remote")), "\n") {
		if r != "" {
			remoteNames = append(remoteNames, r)
		}
	}

	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"repo": true, "root": root,
		"branches": locals, "remoteBranches": remotes, "tags": tags, "stashes": stashes, "remotes": remoteNames,
	}})
}

type showFile struct {
	Path   string `json:"path"`
	Orig   string `json:"orig,omitempty"`
	Status string `json:"status"` // A/M/D/R/C/T
	Adds   int    `json:"adds"`
	Dels   int    `json:"dels"`
	Binary bool   `json:"binary"`
}

// GitShow GET /git/show?dir=&hash= —— 单提交详情：元信息 + 文件清单（合并提交按第一父）。
func (a *API) GitShow(c *gin.Context) {
	root, ctx, cancel, ok := gitReadRoot(c)
	if !ok {
		return
	}
	defer cancel()
	hash := strings.TrimSpace(c.Query("hash"))
	if hash == "" || strings.HasPrefix(hash, "-") {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REV"}})
		return
	}

	// %B 多行放最后，前面的字段按 \x1f 切
	meta, err := runGit(ctx, root, "show", "-s", "--decorate=short",
		"--format=%H"+gitUS+"%h"+gitUS+"%P"+gitUS+"%an"+gitUS+"%ae"+gitUS+"%aI"+gitUS+"%ar"+gitUS+"%cn"+gitUS+"%cI"+gitUS+"%D"+gitUS+"%B", hash)
	if err != nil {
		gitFail(c, "GIT_SHOW_FAILED", meta, err)
		return
	}
	p := strings.SplitN(meta, gitUS, 11)
	if len(p) < 11 {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "GIT_SHOW_FAILED"}})
		return
	}
	parents := []string{}
	if strings.TrimSpace(p[2]) != "" {
		parents = strings.Fields(p[2])
	}
	body := strings.TrimRight(p[10], "\n")
	subject, rest := body, ""
	if i := strings.Index(body, "\n"); i >= 0 {
		subject, rest = body[:i], strings.TrimLeft(body[i+1:], "\n")
	}

	// numstat + name-status 合并成一份文件清单
	files := map[string]*showFile{}
	order := []string{}
	numArgs := []string{"show", "--numstat", "--format=", "-m", "--first-parent", hash}
	for _, line := range strings.Split(mustGit(ctx, root, numArgs...), "\n") {
		f := strings.Split(line, "\t")
		if len(f) < 3 || f[2] == "" {
			continue
		}
		path := gitUnquote(f[2])
		sf := &showFile{Path: path, Status: "M"}
		if f[0] == "-" {
			sf.Binary = true
		} else {
			sf.Adds, _ = strconv.Atoi(f[0])
			sf.Dels, _ = strconv.Atoi(f[1])
		}
		if _, seen := files[path]; !seen {
			order = append(order, path)
		}
		files[path] = sf
	}
	stArgs := []string{"show", "--name-status", "--format=", "-m", "--first-parent", hash}
	for _, line := range strings.Split(mustGit(ctx, root, stArgs...), "\n") {
		f := strings.Split(line, "\t")
		if len(f) < 2 || f[0] == "" {
			continue
		}
		path := gitUnquote(f[len(f)-1])
		sf := files[path]
		if sf == nil {
			sf = &showFile{Path: path}
			files[path] = sf
			order = append(order, path)
		}
		sf.Status = string(f[0][0])
		if len(f) >= 3 { // R100 old new / C100 old new
			sf.Orig = gitUnquote(f[1])
		}
	}
	list := make([]showFile, 0, len(order))
	adds, dels := 0, 0
	for _, k := range order {
		list = append(list, *files[k])
		adds += files[k].Adds
		dels += files[k].Dels
	}

	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"hash": p[0], "short": p[1], "parents": parents,
		"author": p[3], "email": p[4], "date": p[5], "when": p[6],
		"committer": p[7], "commitDate": p[8],
		"refs": parseDecorate(p[9], ""), "subject": subject, "body": rest,
		"files": list, "adds": adds, "dels": dels,
	}})
}

// gitRepoState 读出仓库当前是否卡在 merge / rebase / cherry-pick / revert 中。
func gitRepoState(ctx context.Context, root string) string {
	gitDir := strings.TrimSpace(mustGit(ctx, root, "rev-parse", "--absolute-git-dir"))
	if gitDir == "" {
		return ""
	}
	exists := func(name string) bool {
		_, err := os.Stat(filepath.Join(gitDir, name))
		return err == nil
	}
	switch {
	case exists("rebase-merge"), exists("rebase-apply"):
		return "rebase"
	case exists("MERGE_HEAD"):
		return "merge"
	case exists("CHERRY_PICK_HEAD"):
		return "cherry-pick"
	case exists("REVERT_HEAD"):
		return "revert"
	case exists("BISECT_LOG"):
		return "bisect"
	}
	return ""
}

// safeRev 挡住以 - 开头的参数注入（其余交给 git 自己校验）。
func safeRev(s string) bool { return s != "" && !strings.HasPrefix(s, "-") }

// GitAction POST /git/action {root, action, ...} —— 本地引用与工作区写操作（白名单）。
// 远端网络操作（push/pull/fetch/sync）仍走 /git/op。
func (a *API) GitAction(c *gin.Context) {
	var req struct {
		Root      string `json:"root"`
		Action    string `json:"action"`
		Ref       string `json:"ref"`     // 分支/标签/提交名
		Name      string `json:"name"`    // 新分支名 / 新标签名
		From      string `json:"from"`    // 起点
		Hash      string `json:"hash"`    // 提交
		Mode      string `json:"mode"`    // reset: soft|mixed|hard
		Message   string `json:"message"` // stash / tag 说明
		Index     int    `json:"index"`   // stash 序号
		Force     bool   `json:"force"`
		Checkout  bool   `json:"checkout"`
		Untracked bool   `json:"untracked"`
		NoFF      bool   `json:"noFf"`
		Squash    bool   `json:"squash"`
		Upstream  bool   `json:"upstream"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_FORM", "message": err.Error()}})
		return
	}
	root, ok := gitWriteRoot(c, req.Root)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 120*time.Second)
	defer cancel()

	var args []string
	switch req.Action {
	case "checkout": // 切到已有分支 / 提交（分离头）
		if !safeRev(req.Ref) {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REV"}})
			return
		}
		args = []string{"checkout"}
		if req.Force {
			args = append(args, "--force")
		}
		args = append(args, req.Ref)
	case "branch-create":
		if !safeRev(req.Name) {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REV"}})
			return
		}
		if req.Checkout {
			args = []string{"checkout", "-b", req.Name}
		} else {
			args = []string{"branch", req.Name}
		}
		if safeRev(req.From) {
			args = append(args, req.From)
		}
	case "branch-delete":
		if !safeRev(req.Ref) {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REV"}})
			return
		}
		flag := "-d"
		if req.Force {
			flag = "-D"
		}
		args = []string{"branch", flag, req.Ref}
	case "branch-rename":
		if !safeRev(req.Ref) || !safeRev(req.Name) {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REV"}})
			return
		}
		args = []string{"branch", "-m", req.Ref, req.Name}
	case "merge":
		if !safeRev(req.Ref) {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REV"}})
			return
		}
		args = []string{"merge"}
		if req.Squash {
			args = append(args, "--squash")
		} else if req.NoFF {
			args = append(args, "--no-ff")
		}
		args = append(args, "--no-edit", req.Ref)
	case "rebase":
		if !safeRev(req.Ref) {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REV"}})
			return
		}
		args = []string{"rebase", req.Ref}
	case "reset":
		if !safeRev(req.Hash) {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REV"}})
			return
		}
		mode := "--mixed"
		switch req.Mode {
		case "soft":
			mode = "--soft"
		case "hard":
			mode = "--hard"
		}
		args = []string{"reset", mode, req.Hash}
	case "revert":
		if !safeRev(req.Hash) {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REV"}})
			return
		}
		args = []string{"revert", "--no-edit", req.Hash}
	case "cherry-pick":
		if !safeRev(req.Hash) {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REV"}})
			return
		}
		args = []string{"cherry-pick", req.Hash}
	case "tag-create":
		if !safeRev(req.Name) {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REV"}})
			return
		}
		args = []string{"tag"}
		if strings.TrimSpace(req.Message) != "" {
			args = append(args, "-a", req.Name, "-m", req.Message)
		} else {
			args = append(args, req.Name)
		}
		if safeRev(req.Hash) {
			args = append(args, req.Hash)
		}
	case "tag-delete":
		if !safeRev(req.Ref) {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REV"}})
			return
		}
		args = []string{"tag", "-d", req.Ref}
	case "stash-push":
		args = []string{"stash", "push"}
		if req.Untracked {
			args = append(args, "--include-untracked")
		}
		if m := strings.TrimSpace(req.Message); m != "" {
			args = append(args, "-m", m)
		}
	case "stash-pop", "stash-apply", "stash-drop":
		if req.Index < 0 {
			req.Index = 0
		}
		args = []string{"stash", strings.TrimPrefix(req.Action, "stash-"), "stash@{" + strconv.Itoa(req.Index) + "}"}
	case "abort", "continue": // 收拾 merge/rebase/cherry-pick/revert 的中间态
		state := gitRepoState(ctx, root)
		if state == "" || state == "bisect" {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "NO_PENDING_OP"}})
			return
		}
		args = []string{state, "--" + req.Action}
		if req.Action == "continue" && state != "rebase" {
			args = append(args, "--no-edit")
		}
	case "push-branch":
		if !safeRev(req.Ref) {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REV"}})
			return
		}
		args = []string{"push"}
		if req.Upstream {
			args = append(args, "-u", "origin", req.Ref)
		} else {
			args = append(args, "origin", req.Ref)
		}
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_ACTION"}})
		return
	}

	out, err := runGit(ctx, root, args...)
	if err != nil {
		// 冲突类失败带上冲突文件，让前端直接引导到「改动」页解冲突
		conflicts := gitConflictFiles(ctx, root)
		msg := strings.TrimSpace(out)
		if msg == "" {
			msg = err.Error()
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"code": "GIT_ACTION_FAILED", "message": msg,
			"state": gitRepoState(ctx, root), "conflictFiles": conflicts,
		}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true, "output": strings.TrimSpace(out), "state": gitRepoState(ctx, root)}})
}

// gitConflictFiles 列出当前处于未合并（U）状态的文件。
func gitConflictFiles(ctx context.Context, root string) []string {
	out := mustGit(ctx, root, "diff", "--name-only", "--diff-filter=U")
	files := []string{}
	for _, l := range strings.Split(out, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			files = append(files, gitUnquote(l))
		}
	}
	return files
}
