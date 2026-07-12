// Package api 实现各资源的 HTTP handler（sessions / tasks / env / info / fs）。
// 全部通过 ttmux.Client 转发到 CLI，自身不含编排逻辑。
package api

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"ttmux-web/ttmux"
	"ttmux-web/worktree"
)

type API struct {
	TT          *ttmux.Client
	WT          *worktree.Service // Worktree 领域服务（独占 git worktree 操作）
	BrowserHome string            // 浏览器导航起始页地址（供前端设为默认主页）
	Football    *FootballStore
	Speech      *SpeechStore      // 语音识别(ASR)配置 + 转录
	Prefs       *PreferencesStore // 用户偏好（主题/语言/Agent 命令等）
	Races       *RaceStore        // 竞赛（W5/W6）业务数据模型
}

func New(tt *ttmux.Client, browserHome, dataDir string) *API {
	return &API{TT: tt, WT: worktree.New(), BrowserHome: browserHome, Football: NewFootballStore(), Speech: NewSpeechStore(dataDir), Prefs: NewPreferencesStore(dataDir), Races: NewRaceStore(dataDir)}
}

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
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"authed": true, "browserHome": a.BrowserHome}})
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

// SanitizeSessionName 把 tmux 不允许出现在会话名中的字符替换掉。
// tmux 自身会把 '.' 和 ':' 替换为 '_'，这里提前做同样的事，
// 避免后续 -t 引用时 '.' 被解析为 session.window.pane 分隔符而报错。
func SanitizeSessionName(name string) string {
	return strings.NewReplacer(".", "_", ":", "_").Replace(name)
}

// sessionParam 读取路由 :name 参数并净化（点号/冒号 → 下划线）。
func sessionParam(c *gin.Context) string {
	return SanitizeSessionName(c.Param("name"))
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
	b.Name = SanitizeSessionName(b.Name)
	// 创建 detached 会话（转发给 tmux），可指定工作目录 -c
	args := []string{"new-session", "-d", "-s", b.Name}
	if strings.TrimSpace(b.Dir) != "" {
		args = append(args, "-c", b.Dir)
	}
	out, err := a.TT.Run(args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "TTMUX_ERROR", "message": ttmux.StripANSI(out)}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": ttmux.StripANSI(out), "name": b.Name})
}

func (a *API) RenameSession(c *gin.Context) {
	var b struct {
		Name string `json:"name"`
	}
	oldName := sessionParam(c)
	if err := c.ShouldBindJSON(&b); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	newName := SanitizeSessionName(strings.TrimSpace(b.Name))
	if oldName == "" || newName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	if oldName == newName {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"name": newName}})
		return
	}
	out, err := a.TT.Run("rename-session", "-t", oldName, newName)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "TTMUX_ERROR", "message": ttmux.StripANSI(out)}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"name": newName}})
}

// 走 ttmux kill --yes（非交互）：孤儿收养/meta 清理在 CLI 内完成；?cascade=1 级联杀子树。
func (a *API) KillSession(c *gin.Context) {
	args := []string{"kill", sessionParam(c), "--yes"}
	if c.Query("cascade") == "1" {
		args = append(args, "--cascade")
	}
	a.text(c, args...)
}
func (a *API) Capture(c *gin.Context) {
	a.text(c, "capture", sessionParam(c), "--lines", c.DefaultQuery("lines", "200"))
}

// 允许注入的具名按键（其余只允许单个字母/数字）。用于在专业渲染模式下响应 TUI 选择框。
var allowedKeys = map[string]bool{
	"Up": true, "Down": true, "Left": true, "Right": true,
	"Enter": true, "Escape": true, "Tab": true, "Space": true, "BSpace": true,
}

// Keys POST /sessions/:name/keys —— 向会话注入原始按键（不追加回车）。
// body: {"keys":["Down","Enter"]} 或 {"keys":["2"]}；经白名单校验后 tmux send-keys。
// 之所以单列一个端点：/tasks/_/send 只能发「文本+回车」，无法发方向键/裸数字/Esc，
// 而 Claude/Codex 的权限确认/选项菜单需要这些键来选择。
func (a *API) Keys(c *gin.Context) {
	name := sessionParam(c)
	var b struct {
		Keys []string `json:"keys"`
	}
	if err := c.ShouldBindJSON(&b); err != nil || len(b.Keys) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	args := []string{"send-keys", "-t", name}
	for _, k := range b.Keys {
		ok := allowedKeys[k]
		if !ok && len(k) == 1 {
			ch := k[0]
			ok = (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
		}
		if !ok {
			c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_KEY", "message": k}})
			return
		}
		args = append(args, k)
	}
	if err := exec.Command("tmux", args...).Run(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "TMUX_ERROR", "message": err.Error()}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": "ok"})
}

// SessionCwd GET /sessions/:name/cwd —— 返回会话活动 pane 的工作目录（供文件侧栏定位根）。
func (a *API) SessionCwd(c *gin.Context) {
	out, err := exec.Command("tmux", "display-message", "-p", "-t", sessionParam(c), "#{pane_current_path}").Output()
	dir := ""
	if err == nil {
		dir = strings.TrimSpace(string(out))
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"dir": dir}})
}

// SessionType POST /sessions/:name/type —— 把文本字面量打进当前 pane（不追加回车）。
// 供终端页语音识别后回填用：内容停在输入行，用户复查/编辑后自行按 Enter 发送。
func (a *API) SessionType(c *gin.Context) {
	name := sessionParam(c)
	var b struct {
		Text string `json:"text"`
	}
	if err := c.ShouldBindJSON(&b); err != nil || b.Text == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_REQUEST"}})
		return
	}
	a.text(c, "send-keys", "-t", name, "-l", b.Text)
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
	b.Sess = SanitizeSessionName(b.Sess)
	// 分两步注入：先字面文本(-l，不解释按键名)，停顿一下，再单独回车。
	// 否则像 Codex 这类 TUI 会把「文本+回车」当成一次粘贴，把回车并进去变成换行而非提交。
	if _, err := a.TT.Run("send-keys", "-t", b.Sess, "-l", b.Msg); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "TTMUX_ERROR", "message": ttmux.StripANSI(err.Error())}})
		return
	}
	time.Sleep(90 * time.Millisecond)
	a.text(c, "send-keys", "-t", b.Sess, "Enter")
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
