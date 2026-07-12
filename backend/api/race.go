// Race Service（设计 07 §3 W5/W6、§4）：竞赛 = 一个 prompt × N 选手，每人一个隔离
// worktree + 会话。业务数据模型（race/winner/crown 阶段）持久化在本层（races.json），
// 不进 SessionMeta 也不进 swarm.db；worktree 实况仍以 Worktree Service 为准。
package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"ttmux-web/ttmux"
	"ttmux-web/worktree"
)

type RaceContestant struct {
	Session string `json:"session"`
	Agent   string `json:"agent"` // claude | codex
	Branch  string `json:"branch"`
	Path    string `json:"path"`
	Status  string `json:"status"` // running | failed
	Error   string `json:"error,omitempty"`
}

type Race struct {
	ID          string           `json:"id"`
	Name        string           `json:"name"`
	Dir         string           `json:"dir"` // 仓库目录
	Base        string           `json:"base"`
	Prompt      string           `json:"prompt"`
	CreatedAt   string           `json:"createdAt"`
	Status      string           `json:"status"` // running | crowned | cleaned
	Winner      string           `json:"winner,omitempty"`
	CrownDone   []string         `json:"crownDone,omitempty"` // crown 状态机已完成阶段（失败可续跑）
	Contestants []RaceContestant `json:"contestants"`
}

type RaceStore struct {
	mu    sync.Mutex
	path  string
	races []*Race
}

func NewRaceStore(dataDir string) *RaceStore {
	s := &RaceStore{}
	if dataDir != "" {
		s.path = filepath.Join(dataDir, "races.json")
		if b, err := os.ReadFile(s.path); err == nil {
			_ = json.Unmarshal(b, &s.races)
		}
	}
	return s
}

// save 持久化全量列表（调用方须持锁）。
func (s *RaceStore) save() {
	if s.path == "" {
		return
	}
	b, err := json.MarshalIndent(s.races, "", "  ")
	if err != nil {
		return
	}
	tmp := s.path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, s.path)
	}
}

func (s *RaceStore) get(id string) *Race {
	for _, r := range s.races {
		if r.ID == id {
			return r
		}
	}
	return nil
}

// ── handlers ─────────────────────────────────────────────

// RaceCreate POST /races {name, dir, base?, prompt, contestants: [{agent, cmd}]}
// 逐选手编排（先会话后 worktree，同组合 API）：建会话 → 建 worktree（分支
// <竞赛名>-<a/b/c>，即赛道身份，不随 agent 改名）→ cd → 发同一道题。
// 单个选手失败只标记该选手，不拖累其他人。
func (a *API) RaceCreate(c *gin.Context) {
	var b struct {
		Name        string `json:"name"`
		Dir         string `json:"dir"`
		Base        string `json:"base"`
		Prompt      string `json:"prompt"`
		Contestants []struct {
			Agent string `json:"agent"`
			Cmd   string `json:"cmd"` // agent 启动命令（前端偏好，如 claude / codex）
		} `json:"contestants"`
	}
	if err := c.ShouldBindJSON(&b); err != nil || b.Name == "" || strings.TrimSpace(b.Dir) == "" ||
		strings.TrimSpace(b.Prompt) == "" || len(b.Contestants) == 0 || len(b.Contestants) > 5 {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST", "message": "name/dir/prompt/contestants(1..5) required"}})
		return
	}
	b.Name = SanitizeSessionName(b.Name)
	ctx, cancel := wtCtx(c)
	defer cancel()

	race := &Race{
		ID:        fmt.Sprintf("race-%d", time.Now().UnixNano()),
		Name:      b.Name,
		Dir:       b.Dir,
		Base:      b.Base,
		Prompt:    b.Prompt,
		CreatedAt: time.Now().Format(time.RFC3339),
		Status:    "running",
	}
	ok := 0
	for i, in := range b.Contestants {
		letter := string(rune('a' + i))
		ct := RaceContestant{
			Session: SanitizeSessionName(b.Name + "-" + letter),
			Agent:   in.Agent,
			Status:  "running",
		}
		fail := func(msg string) {
			ct.Status, ct.Error = "failed", msg
			race.Contestants = append(race.Contestants, ct)
		}
		if out, err := a.TT.Run("new-session", "-d", "-s", ct.Session, "-c", b.Dir); err != nil {
			fail("session: " + ttmux.StripANSI(out))
			continue
		}
		wt, err := a.WT.Create(ctx, worktree.CreateReq{Dir: b.Dir, Branch: autoBranch(b.Name) + "-" + letter, Base: b.Base})
		if err != nil {
			_, _ = a.TT.Run("kill", ct.Session, "--yes")
			fail("worktree: " + err.Error())
			continue
		}
		ct.Branch, ct.Path = wt.Branch, wt.Path
		if race.Base == "" {
			race.Base = wt.Base
		}
		_ = a.cdInto(ct.Session, wt.Path)
		// 发题：启动命令 + prompt 作为单引号 CLI 参数（多行原样保留），独立回车提交
		if cmd := strings.TrimSpace(in.Cmd); cmd != "" {
			launch := cmd + " " + shellQuote(b.Prompt)
			if _, err := a.TT.Run("send-keys", "-t", "="+ct.Session+":", "-l", launch); err == nil {
				time.Sleep(90 * time.Millisecond)
				_, _ = a.TT.Run("send-keys", "-t", "="+ct.Session+":", "Enter")
			}
		}
		race.Contestants = append(race.Contestants, ct)
		ok++
	}

	a.Races.mu.Lock()
	a.Races.races = append(a.Races.races, race)
	a.Races.save()
	a.Races.mu.Unlock()
	if ok == 0 {
		c.JSON(http.StatusConflict, gin.H{"error": gin.H{"code": "ALL_FAILED", "message": "no contestant started"}, "data": race})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": race})
}

// RaceList GET /races —— 全量竞赛（前端按仓库/会话自行过滤，worktree 实况另查）。
func (a *API) RaceList(c *gin.Context) {
	a.Races.mu.Lock()
	defer a.Races.mu.Unlock()
	if a.Races.races == nil {
		c.JSON(http.StatusOK, gin.H{"data": []any{}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": a.Races.races})
}

// RaceCrown POST /races/:id/crown {winner, strategy?, cleanup?, expectedHead?}
// crown 状态机：wip-commit → merge → (可选) cleanup 输家；每步完成即持久化，
// 失败返回 {stage, done}，同 winner 重试会跳过已完成阶段续跑。
func (a *API) RaceCrown(c *gin.Context) {
	var b struct {
		Winner       string `json:"winner"` // 选手会话名
		Strategy     string `json:"strategy"`
		Cleanup      bool   `json:"cleanup"`
		ExpectedHead string `json:"expectedHead"`
	}
	if err := c.ShouldBindJSON(&b); err != nil || b.Winner == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	a.Races.mu.Lock()
	race := a.Races.get(c.Param("id"))
	if race == nil {
		a.Races.mu.Unlock()
		c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": "NOT_FOUND"}})
		return
	}
	var winner *RaceContestant
	for i := range race.Contestants {
		if race.Contestants[i].Session == b.Winner {
			winner = &race.Contestants[i]
		}
	}
	if winner == nil || winner.Status == "failed" {
		a.Races.mu.Unlock()
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_WINNER"}})
		return
	}
	// 冻结：换赢家重跑则清空已完成阶段
	if race.Winner != b.Winner {
		race.Winner, race.CrownDone = b.Winner, nil
	}
	done := func(stage string) bool {
		for _, s := range race.CrownDone {
			if s == stage {
				return true
			}
		}
		return false
	}
	mark := func(stage string) { race.CrownDone = append(race.CrownDone, stage); a.Races.save() }
	a.Races.save()
	a.Races.mu.Unlock()

	ctx, cancel := wtCtx(c)
	defer cancel()
	strategy := b.Strategy
	if strategy == "" {
		strategy = "squash"
	}
	fail := func(stage string, err error) {
		if we, ok := err.(*worktree.Err); ok {
			body := gin.H{"code": we.Code, "message": we.Message, "stage": stage, "done": race.CrownDone}
			for k, v := range we.Extra {
				body[k] = v
			}
			c.JSON(http.StatusConflict, gin.H{"error": body})
			return
		}
		c.JSON(http.StatusConflict, gin.H{"error": gin.H{"code": "STAGE_FAILED", "message": err.Error(), "stage": stage, "done": race.CrownDone}})
	}

	// 确认后漂移校验在冻结时做（wip-commit 会合法地挪 HEAD，不能把 expectedHead 传给 Merge）
	if b.ExpectedHead != "" && !done("wip-commit") {
		if head, err := a.WT.Head(ctx, winner.Path); err == nil && !strings.HasPrefix(head, b.ExpectedHead) {
			fail("freeze", &worktree.Err{Code: "HEAD_MOVED", Message: "winner HEAD changed since confirmation, re-check and retry"})
			return
		}
	}
	if !done("wip-commit") {
		if err := a.WT.CommitAll(ctx, winner.Path, "wip: auto-commit before crown merge (roam race)"); err != nil {
			fail("wip-commit", err)
			return
		}
		a.Races.mu.Lock()
		mark("wip-commit")
		a.Races.mu.Unlock()
	}
	if !done("merge") {
		if _, err := a.WT.Merge(ctx, worktree.MergeReq{Path: winner.Path, Strategy: strategy}); err != nil {
			fail("merge", err)
			return
		}
		a.Races.mu.Lock()
		mark("merge")
		a.Races.mu.Unlock()
	}
	if b.Cleanup && !done("cleanup") {
		var errs []string
		for i := range race.Contestants {
			ct := &race.Contestants[i]
			if ct.Session == b.Winner {
				continue
			}
			_, _ = a.TT.Run("kill", ct.Session, "--yes")
			if ct.Path != "" {
				if err := a.WT.Remove(ctx, worktree.RemoveReq{Path: ct.Path, ForceWorktree: true, DeleteBranch: true, ForceDeleteBranch: true, IgnoreSessions: true}); err != nil {
					errs = append(errs, ct.Session+": "+err.Error())
				}
			}
		}
		if len(errs) > 0 {
			fail("cleanup", &worktree.Err{Code: "CLEANUP_PARTIAL", Message: strings.Join(errs, "; ")})
			return
		}
		a.Races.mu.Lock()
		mark("cleanup")
		a.Races.mu.Unlock()
	}
	a.Races.mu.Lock()
	race.Status = "crowned"
	a.Races.save()
	a.Races.mu.Unlock()
	c.JSON(http.StatusOK, gin.H{"data": race})
}

// RaceCleanup POST /races/:id/cleanup —— 全部清理：杀所有选手会话 + 强删 worktree/分支。
// 前端确认框负责展示将丢失的改动（实况来自 /git/worktrees），这里按已确认执行。
func (a *API) RaceCleanup(c *gin.Context) {
	a.Races.mu.Lock()
	race := a.Races.get(c.Param("id"))
	a.Races.mu.Unlock()
	if race == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": "NOT_FOUND"}})
		return
	}
	ctx, cancel := wtCtx(c)
	defer cancel()
	var errs []string
	for i := range race.Contestants {
		ct := &race.Contestants[i]
		_, _ = a.TT.Run("kill", ct.Session, "--yes")
		if ct.Path != "" {
			if _, err := os.Stat(ct.Path); err != nil {
				continue // worktree 已不在（外部删过），幂等跳过
			}
			if err := a.WT.Remove(ctx, worktree.RemoveReq{Path: ct.Path, ForceWorktree: true, DeleteBranch: true, ForceDeleteBranch: true, IgnoreSessions: true}); err != nil {
				errs = append(errs, ct.Session+": "+err.Error())
			}
		}
	}
	if len(errs) > 0 {
		c.JSON(http.StatusConflict, gin.H{"error": gin.H{"code": "CLEANUP_PARTIAL", "message": strings.Join(errs, "; ")}})
		return
	}
	a.Races.mu.Lock()
	race.Status = "cleaned"
	a.Races.save()
	a.Races.mu.Unlock()
	c.JSON(http.StatusOK, gin.H{"data": race})
}

// RaceDelete DELETE /races/:id —— 只删竞赛记录，不动会话/worktree。
func (a *API) RaceDelete(c *gin.Context) {
	id := c.Param("id")
	a.Races.mu.Lock()
	defer a.Races.mu.Unlock()
	for i, r := range a.Races.races {
		if r.ID == id {
			a.Races.races = append(a.Races.races[:i], a.Races.races[i+1:]...)
			a.Races.save()
			c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
			return
		}
	}
	c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": "NOT_FOUND"}})
}
