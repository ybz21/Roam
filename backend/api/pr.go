// GET /git/pr?dir=&branch= —— 这条分支在远端的 PR（走本机 gh CLI），给左树任务卡和 Git 面板
// 那枚分支状态图标的弹层用：编号、标题、状态、检查结果、链接。
//
// 没装 gh / 没登录 / 没 PR 都不是错误，是三种「没有」：前端各显示一句话。结果按 (dir, branch)
// 缓存 60s——弹层每开一次拉一次，gh 一次要跑几百毫秒还吃 API 配额。
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

type prInfo struct {
	Found  bool   `json:"found"`
	Reason string `json:"reason,omitempty"` // found=false 时：no-gh | no-auth | none | error
	Number int    `json:"number,omitempty"`
	Title  string `json:"title,omitempty"`
	State  string `json:"state,omitempty"` // OPEN | MERGED | CLOSED
	Draft  bool   `json:"draft,omitempty"`
	URL    string `json:"url,omitempty"`
	Checks string `json:"checks,omitempty"` // passing | failing | pending | none
}

type prCacheEntry struct {
	at   time.Time
	info prInfo
}

var prCache = struct {
	sync.Mutex
	m map[string]prCacheEntry
}{m: map[string]prCacheEntry{}}

const prCacheTTL = 60 * time.Second

func (a *API) GitPR(c *gin.Context) {
	dir := filepath.Clean(c.Query("dir"))
	branch := strings.TrimSpace(c.Query("branch"))
	if dir == "." || !filepath.IsAbs(dir) || branch == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	key := dir + "\x00" + branch
	if c.Query("refresh") == "" {
		prCache.Lock()
		e, ok := prCache.m[key]
		prCache.Unlock()
		if ok && time.Since(e.at) < prCacheTTL {
			c.JSON(http.StatusOK, gin.H{"data": e.info, "cached": true})
			return
		}
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()
	info := lookupPR(ctx, dir, branch)
	prCache.Lock()
	prCache.m[key] = prCacheEntry{time.Now(), info}
	prCache.Unlock()
	c.JSON(http.StatusOK, gin.H{"data": info})
}

// ghCheck 是 statusCheckRollup 里的一项：CheckRun 带 status/conclusion，StatusContext 只带 state。
type ghCheck struct {
	State      string `json:"state"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
}

func lookupPR(ctx context.Context, dir, branch string) prInfo {
	gh, err := exec.LookPath("gh")
	if err != nil {
		return prInfo{Reason: "no-gh"}
	}
	cmd := exec.CommandContext(ctx, gh, "pr", "list", "--head", branch, "--state", "all", "--limit", "1",
		"--json", "number,title,state,url,isDraft,statusCheckRollup")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "NO_COLOR=1")
	out, err := cmd.Output()
	if err != nil {
		msg := ""
		if ee, ok := err.(*exec.ExitError); ok {
			msg = strings.ToLower(string(ee.Stderr))
		}
		if strings.Contains(msg, "auth login") || strings.Contains(msg, "not logged") || strings.Contains(msg, "authentication") {
			return prInfo{Reason: "no-auth"}
		}
		return prInfo{Reason: "error"}
	}
	var rows []struct {
		Number            int       `json:"number"`
		Title             string    `json:"title"`
		State             string    `json:"state"`
		URL               string    `json:"url"`
		IsDraft           bool      `json:"isDraft"`
		StatusCheckRollup []ghCheck `json:"statusCheckRollup"`
	}
	if err := json.Unmarshal(out, &rows); err != nil || len(rows) == 0 {
		return prInfo{Reason: "none"}
	}
	r := rows[0]
	return prInfo{Found: true, Number: r.Number, Title: r.Title, State: r.State, Draft: r.IsDraft, URL: r.URL, Checks: summarizeChecks(r.StatusCheckRollup)}
}

// summarizeChecks 把一串检查压成一个词：有失败就 failing，否则有没跑完的就 pending，否则 passing；空 = none。
func summarizeChecks(items []ghCheck) string {
	if len(items) == 0 {
		return "none"
	}
	pending := false
	for _, it := range items {
		switch strings.ToUpper(it.Conclusion) {
		case "FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE":
			return "failing"
		}
		switch strings.ToUpper(it.State) {
		case "FAILURE", "ERROR":
			return "failing"
		case "PENDING", "EXPECTED":
			pending = true
		}
		if s := strings.ToUpper(it.Status); s != "" && s != "COMPLETED" {
			pending = true
		}
	}
	if pending {
		return "pending"
	}
	return "passing"
}
