// 项目(Project)读模型聚合（08 设计 §4/§5）。项目 = git 仓库：
//
//	GET   /projects            列表聚合（发现 = 读路径副作用：cwd join 命中即记入台账；
//	                           退场也在读时收敛——目录不存在，或 无 roam worktree ∧ 无会话 ∧ 未置顶）
//	PATCH /projects/:key/prefs UI 偏好（置顶/显示名/默认 agent/默认 base）
//
// 台账与偏好在 backend/project（弱数据）；git/session/race 真相源全部现有，零写入。
package api

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"encoding/json"

	"github.com/gin-gonic/gin"
	"ttmux-web/project"
	"ttmux-web/worktree"
)

type projectSession struct {
	Name         string `json:"name"`
	Attached     bool   `json:"attached"`
	LastActivity int64  `json:"lastActivity"`
	Branch       string `json:"branch,omitempty"` // 落在 worktree 里才有
	Linked       bool   `json:"linked,omitempty"`
}

type projectSummary struct {
	Key          string           `json:"key"`
	Name         string           `json:"name"` // displayName 优先，缺省目录名
	Dir          string           `json:"dir"`
	Git          bool             `json:"git"` // 是否 git 仓库——worktree/编队/活动能力只在 git 项目开启
	Pinned       bool             `json:"pinned"`
	DefaultAgent string           `json:"defaultAgent,omitempty"`
	DefaultBase  string           `json:"defaultBase,omitempty"`
	Sessions     int              `json:"sessions"`
	Attached     int              `json:"attached"`
	Worktrees    int              `json:"worktrees"`  // 非 main、非 prunable
	Unfinished   int              `json:"unfinished"` // 孤儿 roam worktree ∧ (未合并提交 ∨ 未提交改动)
	Races        int              `json:"races"`      // running 状态的竞赛数
	LastActivity int64            `json:"lastActivity"`
	FirstSeen    int64            `json:"firstSeen"`
	Top          []projectSession `json:"top"` // 活跃会话前 2（P1 卡片「进行中」）
}

// sessListItem 兼容解析 ttmux ls --json（数值字段 CLI 可能给字符串）。
type sessListItem struct {
	Name         string          `json:"name"`
	Attached     json.RawMessage `json:"attached"`
	LastActivity json.RawMessage `json:"last_activity"`
}

func rawInt(r json.RawMessage) int64 {
	s := string(r)
	if len(s) >= 2 && s[0] == '"' {
		s = s[1 : len(s)-1]
	}
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

// 列表响应 5s TTL 缓存（与 W4 轮询同拍，压住 O(R×N) 子进程）。
var (
	projRespMu sync.Mutex
	projRespAt time.Time
	projResp   gin.H
)

// ProjectsList GET /projects
func (a *API) ProjectsList(c *gin.Context) {
	projRespMu.Lock()
	if projResp != nil && time.Since(projRespAt) < 5*time.Second {
		resp := projResp
		projRespMu.Unlock()
		c.JSON(http.StatusOK, resp)
		return
	}
	projRespMu.Unlock()

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	var sessions []sessListItem
	if out, err := a.TT.Run("ls", "--json"); err == nil {
		_ = json.Unmarshal([]byte(out), &sessions)
	}
	ann := a.WT.Annotations(ctx)

	// 发现：会话 cwd join 命中的仓库自动记入台账（读路径副作用，无注册流程）
	for _, an := range ann {
		if an.Primary != nil && an.Primary.Repo != "" {
			a.Projects.Touch(an.Primary.Repo)
		}
	}

	races := map[string]int{} // dir → running 竞赛数
	a.Races.mu.Lock()
	for _, r := range a.Races.races {
		if r.Status == "running" {
			races[filepath.Clean(r.Dir)]++
		}
	}
	a.Races.mu.Unlock()

	list := []projectSummary{}
	loose := []projectSession{}
	claimed := map[string]bool{} // session → 已归入某项目

	// 两阶段归属：先 git 项目按 annotation（primary repo，最精确），
	// 再非 git 项目按 pane cwd 目录前缀认领剩余会话（08：项目不与 git 绑定）。
	type pending struct {
		key string
		e   project.Entry
		p   *projectSummary
	}
	var nonGit []pending
	var cwds map[string][]string // 懒取：有非 git 项目才拉

	addSession := func(p *projectSummary, top *[]projectSession, name string, attached bool, last int64, branch string, linked bool) {
		claimed[name] = true
		p.Sessions++
		ps := projectSession{Name: name, Attached: attached, LastActivity: last, Linked: linked, Branch: branch}
		if ps.Attached {
			p.Attached++
		}
		if ps.LastActivity > p.LastActivity {
			p.LastActivity = ps.LastActivity
		}
		*top = append(*top, ps)
	}
	finish := func(p *projectSummary, top []projectSession) {
		sort.Slice(top, func(i, j int) bool {
			if top[i].Attached != top[j].Attached {
				return top[i].Attached
			}
			return top[i].LastActivity > top[j].LastActivity
		})
		if len(top) > 2 {
			top = top[:2]
		}
		p.Top = top
		list = append(list, *p)
	}

	for key, e := range a.Projects.Entries() {
		if _, err := os.Stat(e.Dir); err != nil {
			a.Projects.Remove(key) // 退场 (a)：项目目录已不存在
			continue
		}
		p := projectSummary{
			Key: key, Dir: e.Dir, Pinned: e.Pinned, FirstSeen: e.FirstSeen,
			DefaultAgent: e.DefaultAgent, DefaultBase: e.DefaultBase,
			Races: races[filepath.Clean(e.Dir)],
		}
		p.Name = e.DisplayName
		if p.Name == "" {
			p.Name = filepath.Base(e.Dir)
		}
		wts, err := a.WT.List(ctx, e.Dir)
		if err != nil {
			if we, ok := err.(*worktree.Err); ok && we.Code == "NOT_GIT_REPO" {
				nonGit = append(nonGit, pending{key: key, e: e, p: &p}) // 非 git 项目：目录 + 会话
				continue
			}
			continue // 一时读不出（锁竞争/超时）：保留台账，本轮跳过
		}
		p.Git = true
		roamWts := 0
		for _, w := range wts {
			if w.IsMain || w.Prunable {
				continue
			}
			p.Worktrees++
			if !w.External {
				roamWts++
				if len(w.Sessions) == 0 && (w.CommittedAhead > 0 || w.Dirty > 0 || w.Untracked > 0) {
					p.Unfinished++
				}
			}
			if w.LastCommitAt > p.LastActivity {
				p.LastActivity = w.LastCommitAt
			}
		}
		var top []projectSession
		for _, s := range sessions {
			an := ann[s.Name]
			if an == nil || an.Primary == nil || an.Primary.Repo != e.Dir {
				continue
			}
			branch := ""
			if an.Primary.Linked {
				branch = an.Primary.Branch
			}
			addSession(&p, &top, s.Name, rawInt(s.Attached) > 0, rawInt(s.LastActivity), branch, an.Primary.Linked)
		}
		// 退场 (b) 只收敛「发现」通道：不存在任何 roam worktree（clean 也算存在）
		// ∧ 无会话 ∧ 未置顶。用户显式创建（origin=user）的是一等对象，永不自动退场。
		if e.Origin != "user" && roamWts == 0 && p.Sessions == 0 && !e.Pinned {
			a.Projects.Remove(key)
			continue
		}
		finish(&p, top)
	}

	// 非 git 项目：pane cwd 目录前缀认领未归属会话
	for _, ng := range nonGit {
		if cwds == nil {
			cwds = a.WT.SessionCwds(ctx)
		}
		var top []projectSession
		for _, s := range sessions {
			if claimed[s.Name] {
				continue
			}
			under := false
			for _, c := range cwds[s.Name] {
				if c == ng.e.Dir || strings.HasPrefix(c, ng.e.Dir+string(filepath.Separator)) {
					under = true
					break
				}
			}
			if under {
				addSession(ng.p, &top, s.Name, rawInt(s.Attached) > 0, rawInt(s.LastActivity), "", false)
			}
		}
		finish(ng.p, top)
	}

	for _, s := range sessions {
		if !claimed[s.Name] {
			loose = append(loose, projectSession{Name: s.Name, Attached: rawInt(s.Attached) > 0, LastActivity: rawInt(s.LastActivity)})
		}
	}
	// 散会话同样稳定排序（按名称）——活动时间只展示，不参与排序防跳变
	sort.Slice(loose, func(i, j int) bool { return loose[i].Name < loose[j].Name })

	// 服务端给稳定的缺省序：置顶 > 名称；创建时间/最近活跃等排序模式由前端按
	// firstSeen/lastActivity 字段自行切换（用户可选，v0.3）。
	sort.Slice(list, func(i, j int) bool {
		if list[i].Pinned != list[j].Pinned {
			return list[i].Pinned
		}
		return list[i].Name < list[j].Name
	})

	resp := gin.H{"data": gin.H{"projects": list, "loose": loose}}
	projRespMu.Lock()
	projResp, projRespAt = resp, time.Now()
	projRespMu.Unlock()
	c.JSON(http.StatusOK, resp)
}

// ProjectCreate POST /projects {dir, displayName?}
// 显式创建项目对象（origin=user，永不自动退场）。项目 = 任意目录，**不与 git 绑定**：
// 是 git 仓库则经 ResolveRepo 归位主仓库根（worktree 里建也归位）并开启 worktree/
// 编队/活动能力；非 git 目录照样成为项目（目录 + 会话）。
func (a *API) ProjectCreate(c *gin.Context) {
	var b struct {
		Dir         string `json:"dir"`
		DisplayName string `json:"displayName"`
	}
	if err := c.ShouldBindJSON(&b); err != nil || strings.TrimSpace(b.Dir) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	dir := strings.TrimSpace(b.Dir)
	if strings.HasPrefix(dir, "~/") || dir == "~" {
		if home, err := os.UserHomeDir(); err == nil {
			dir = filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(dir, "~"), "/"))
		}
	}
	if !filepath.IsAbs(dir) {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_DIR", "message": "absolute path required"}})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()
	git := true
	if repo, err := a.WT.ResolveRepo(ctx, dir); err == nil {
		dir = repo.Root
	} else {
		// 非 git：目录不存在则创建（新建项目 = 也可以新建文件夹）；canonical 化对齐 cwd join 口径
		if st, serr := os.Stat(dir); serr != nil {
			if mkerr := os.MkdirAll(dir, 0o755); mkerr != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_DIR", "message": mkerr.Error()}})
				return
			}
		} else if !st.IsDir() {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_DIR", "message": "path exists but is not a directory"}})
			return
		}
		if r, e := filepath.EvalSymlinks(dir); e == nil {
			dir = r
		}
		dir = filepath.Clean(dir)
		git = false
	}
	key := a.Projects.Add(dir, strings.TrimSpace(b.DisplayName))
	projRespMu.Lock()
	projResp = nil
	projRespMu.Unlock()
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"key": key, "dir": dir, "git": git}})
}

// ProjectDelete DELETE /projects/:key
// 纯台账操作：从项目列表移除，不动目录/worktree/会话；有会话在跑的仓库
// 下次聚合会被发现通道重新记入（这是特性——项目列表反映实况）。
func (a *API) ProjectDelete(c *gin.Context) {
	if _, ok := a.Projects.Dir(c.Param("key")); !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": "UNKNOWN_PROJECT"}})
		return
	}
	a.Projects.Remove(c.Param("key"))
	projRespMu.Lock()
	projResp = nil
	projRespMu.Unlock()
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}

// ProjectActivity GET /projects/:key/activity —— 活动流：全部分支近 30 天提交（60s 缓存）
func (a *API) ProjectActivity(c *gin.Context) {
	dir, ok := a.Projects.Dir(c.Param("key"))
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": "UNKNOWN_PROJECT"}})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()
	entries, err := a.WT.RecentLog(ctx, dir)
	if err != nil {
		if we, ok := err.(*worktree.Err); ok && we.Code == "NOT_GIT_REPO" {
			entries = nil // 非 git 项目：无 git log，仍可有留痕
		} else {
			wtErr(c, err)
			return
		}
	}
	// 活动流 = git log ∪ 收尾留痕（08 §2.2：丢弃后的提交不可达，留痕保住摘要）
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"commits": entries,
		"traces":  a.Projects.ReadTrace(dir, 50),
	}})
}

// ProjectPrefs PATCH /projects/:key/prefs {pinned?, displayName?, defaultAgent?, defaultBase?}
func (a *API) ProjectPrefs(c *gin.Context) {
	var b struct {
		Pinned       *bool   `json:"pinned"`
		DisplayName  *string `json:"displayName"`
		DefaultAgent *string `json:"defaultAgent"`
		DefaultBase  *string `json:"defaultBase"`
	}
	if err := c.ShouldBindJSON(&b); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	ok := a.Projects.SetPrefs(c.Param("key"), func(p *project.Prefs) {
		if b.Pinned != nil {
			p.Pinned = *b.Pinned
		}
		if b.DisplayName != nil {
			p.DisplayName = *b.DisplayName
		}
		if b.DefaultAgent != nil {
			p.DefaultAgent = *b.DefaultAgent
		}
		if b.DefaultBase != nil {
			p.DefaultBase = *b.DefaultBase
		}
	})
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": "UNKNOWN_PROJECT"}})
		return
	}
	projRespMu.Lock()
	projResp = nil // 偏好变更立即反映到下一次列表
	projRespMu.Unlock()
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}
