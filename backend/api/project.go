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
	Pinned       bool             `json:"pinned"`
	DefaultAgent string           `json:"defaultAgent,omitempty"`
	DefaultBase  string           `json:"defaultBase,omitempty"`
	Sessions     int              `json:"sessions"`
	Attached     int              `json:"attached"`
	Worktrees    int              `json:"worktrees"`  // 非 main、非 prunable
	Unfinished   int              `json:"unfinished"` // 孤儿 roam worktree ∧ (未合并提交 ∨ 未提交改动)
	Races        int              `json:"races"`      // running 状态的竞赛数
	LastActivity int64            `json:"lastActivity"`
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
	inRepo := map[string]bool{} // session → 已归入某项目

	for key, e := range a.Projects.Entries() {
		if _, err := os.Stat(e.Dir); err != nil {
			a.Projects.Remove(key) // 退场 (a)：仓库目录已不存在
			continue
		}
		wts, err := a.WT.List(ctx, e.Dir)
		if err != nil {
			continue // 一时读不出（锁竞争/超时）：保留台账，本轮跳过
		}
		p := projectSummary{
			Key: key, Dir: e.Dir, Pinned: e.Pinned,
			DefaultAgent: e.DefaultAgent, DefaultBase: e.DefaultBase,
			Races: races[filepath.Clean(e.Dir)],
		}
		p.Name = e.DisplayName
		if p.Name == "" {
			p.Name = filepath.Base(e.Dir)
		}
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
			inRepo[s.Name] = true
			p.Sessions++
			ps := projectSession{
				Name: s.Name, Attached: rawInt(s.Attached) > 0,
				LastActivity: rawInt(s.LastActivity), Linked: an.Primary.Linked,
			}
			if an.Primary.Linked {
				ps.Branch = an.Primary.Branch
			}
			if ps.Attached {
				p.Attached++
			}
			if ps.LastActivity > p.LastActivity {
				p.LastActivity = ps.LastActivity
			}
			top = append(top, ps)
		}
		// 退场 (b) 只收敛「发现」通道：不存在任何 roam worktree（clean 也算存在）
		// ∧ 无会话 ∧ 未置顶。用户显式创建（origin=user）的是一等对象，永不自动退场。
		if e.Origin != "user" && roamWts == 0 && p.Sessions == 0 && !e.Pinned {
			a.Projects.Remove(key)
			continue
		}
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
		list = append(list, p)
	}

	for _, s := range sessions {
		if !inRepo[s.Name] {
			loose = append(loose, projectSession{Name: s.Name, Attached: rawInt(s.Attached) > 0, LastActivity: rawInt(s.LastActivity)})
		}
	}
	sort.Slice(loose, func(i, j int) bool { return loose[i].LastActivity > loose[j].LastActivity })

	// 排序在服务端定：置顶 > 有活跃会话 > 最近活动倒序（前端不重排）
	sort.Slice(list, func(i, j int) bool {
		if list[i].Pinned != list[j].Pinned {
			return list[i].Pinned
		}
		ai, aj := list[i].Attached > 0, list[j].Attached > 0
		if ai != aj {
			return ai
		}
		return list[i].LastActivity > list[j].LastActivity
	})

	resp := gin.H{"data": gin.H{"projects": list, "loose": loose}}
	projRespMu.Lock()
	projResp, projRespAt = resp, time.Now()
	projRespMu.Unlock()
	c.JSON(http.StatusOK, resp)
}

// ProjectCreate POST /projects {dir, displayName?}
// 显式创建项目对象（origin=user，永不自动退场）。项目 = git 仓库：目录经
// ResolveRepo 校验并 canonical 化（worktree 里建也归位到主仓库根），非 git 目录报错。
func (a *API) ProjectCreate(c *gin.Context) {
	var b struct {
		Dir         string `json:"dir"`
		DisplayName string `json:"displayName"`
	}
	if err := c.ShouldBindJSON(&b); err != nil || strings.TrimSpace(b.Dir) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()
	repo, err := a.WT.ResolveRepo(ctx, strings.TrimSpace(b.Dir))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "NOT_GIT_REPO", "message": err.Error()}})
		return
	}
	key := a.Projects.Add(repo.Root, strings.TrimSpace(b.DisplayName))
	projRespMu.Lock()
	projResp = nil
	projRespMu.Unlock()
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"key": key, "dir": repo.Root}})
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
