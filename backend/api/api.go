// Package api 实现各资源的 HTTP handler（sessions / tasks / env / info / fs）。
// 全部通过 ttmux.Client 转发到 CLI，自身不含编排逻辑。
package api

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	"ttmux-web/ttmux"
)

type API struct {
	TT       *ttmux.Client
	KannaURL string // 可选：Claude Code 精美 UI（kanna）的地址；为空则前端不显示入口
}

func New(tt *ttmux.Client, kannaURL string) *API { return &API{TT: tt, KannaURL: kannaURL} }

// json 透传 ttmux 的 --json 输出
func (a *API) json(c *gin.Context, args ...string) {
	out, err := a.TT.Run(args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "TTMUX_ERROR", "message": ttmux.StripANSI(out)}})
		return
	}
	c.Data(http.StatusOK, "application/json; charset=utf-8", []byte(out))
}

// text 返回写操作的纯文本结果（去 ANSI）
func (a *API) text(c *gin.Context, args ...string) {
	out, err := a.TT.Run(args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "TTMUX_ERROR", "message": ttmux.StripANSI(out)}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": ttmux.StripANSI(out)})
}

func (a *API) Me(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"authed": true, "kanna": a.KannaURL}})
}
func (a *API) Info(c *gin.Context) { a.json(c, "info", "--json") }

// FS 列出目录下的子目录，供前端选择工作目录
func (a *API) FS(c *gin.Context) {
	p := c.Query("path")
	if p == "" {
		if home, err := os.UserHomeDir(); err == nil {
			p = home
		} else {
			p = "/"
		}
	}
	p = filepath.Clean(p)
	entries, err := os.ReadDir(p)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "FS_ERROR", "message": err.Error()}})
		return
	}
	dirs := []string{}
	for _, e := range entries {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
			dirs = append(dirs, e.Name())
		}
	}
	sort.Strings(dirs)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"path": p, "parent": filepath.Dir(p), "dirs": dirs}})
}

// Sessions
func (a *API) Sessions(c *gin.Context) { a.json(c, "ls", "--json") }
func (a *API) NewSession(c *gin.Context) {
	var b struct {
		Name string `json:"name"`
		Dir  string `json:"dir"`
	}
	if err := c.ShouldBindJSON(&b); err != nil || b.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	// 创建 detached 会话（转发给 tmux），可指定工作目录 -c
	args := []string{"new-session", "-d", "-s", b.Name}
	if strings.TrimSpace(b.Dir) != "" {
		args = append(args, "-c", b.Dir)
	}
	a.text(c, args...)
}

// 用 tmux kill-session（转发），避开 ttmux kill 的交互式 y/N 确认（后端无 tty）
func (a *API) KillSession(c *gin.Context) { a.text(c, "kill-session", "-t", c.Param("name")) }
func (a *API) Capture(c *gin.Context) {
	a.text(c, "capture", c.Param("name"), "--lines", c.DefaultQuery("lines", "200"))
}

// Tasks（命令 + Agent 统一）
func (a *API) Tasks(c *gin.Context)       { a.json(c, "group", "ls", "--json") }
func (a *API) TaskStatus(c *gin.Context)  { a.json(c, "status", c.Param("g"), "--json") }
func (a *API) TaskCollect(c *gin.Context) { a.json(c, "collect", c.Param("g"), "--json") }
func (a *API) TaskKill(c *gin.Context)    { a.text(c, "group", "kill", c.Param("g")) }

func (a *API) Send(c *gin.Context) {
	var b struct {
		Sess string `json:"sess"`
		Msg  string `json:"msg"`
	}
	if err := c.ShouldBindJSON(&b); err != nil || b.Sess == "" || b.Msg == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	a.text(c, "send", b.Sess, b.Msg)
}

func (a *API) Spawn(c *gin.Context) {
	var b struct {
		Group string `json:"group"`
		Type  string `json:"type"`
		Tasks []struct {
			Name string `json:"name"`
			Cmd  string `json:"cmd"`
			Task string `json:"task"`
		} `json:"tasks"`
		Dir      string `json:"dir"`
		Model    string `json:"model"`
		Perm     string `json:"perm"`
		MaxTurns string `json:"maxTurns"`
	}
	if err := c.ShouldBindJSON(&b); err != nil || b.Group == "" || len(b.Tasks) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}

	var args []string
	if b.Type == "agent" {
		args = append(args, "spawn", "--agent", b.Group)
		for _, t := range b.Tasks {
			args = append(args, t.Name, t.Task)
		}
		if b.Dir != "" {
			args = append(args, "--dir", b.Dir)
		}
		if b.Model != "" {
			args = append(args, "--model", b.Model)
		}
		if b.Perm != "" {
			args = append(args, "--perm", b.Perm)
		}
		if b.MaxTurns != "" {
			args = append(args, "--max-turns", b.MaxTurns)
		}
	} else {
		args = append(args, "spawn", b.Group)
		for _, t := range b.Tasks {
			args = append(args, t.Name, t.Cmd)
		}
	}
	a.text(c, args...)
}

// Env
func (a *API) Env(c *gin.Context)       { a.json(c, "env", "--json") }
func (a *API) EnvDelete(c *gin.Context) { a.text(c, "env", "rm", c.Param("key")) }
func (a *API) EnvPush(c *gin.Context)   { a.text(c, "env", "push") }
func (a *API) EnvSet(c *gin.Context) {
	var b struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}
	if err := c.ShouldBindJSON(&b); err != nil || b.Key == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	a.text(c, "env", "set", b.Key+"="+b.Value)
}
