// Package home 提供一个免登录的「导航起始页」(类 hao123)，挂在主服务的公开路由上
// （/home 与 /home/sites，不经认证中间件）。
//
// 之所以免登录：被投屏的那台全局 Chrome 没有 ttmux 的登录态，要把它当默认主页就必须
// 能直接打开。站点列表非敏感（就是一组书签），可在页面上增删改，持久化到
// <dataDir>/home-sites.json。
package home

import (
	_ "embed"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"github.com/gin-gonic/gin"
)

//go:embed index.html
var indexHTML []byte

// 首次运行(无配置文件)时的默认站点。
var defaultSites = []map[string]string{
	{"name": "百度", "url": "https://www.baidu.com"},
	{"name": "GitHub", "url": "https://github.com"},
	{"name": "哔哩哔哩", "url": "https://www.bilibili.com"},
	{"name": "知乎", "url": "https://www.zhihu.com"},
	{"name": "Google", "url": "https://www.google.com"},
	{"name": "YouTube", "url": "https://www.youtube.com"},
	{"name": "Claude", "url": "https://claude.ai"},
	{"name": "ChatGPT", "url": "https://chatgpt.com"},
}

// Home 持有站点列表的持久化文件，并提供 gin handler。
type Home struct {
	file string
	mu   sync.Mutex
}

func New(dataDir string) *Home {
	_ = os.MkdirAll(dataDir, 0o755)
	return &Home{file: filepath.Join(dataDir, "home-sites.json")}
}

// Page 返回导航页 HTML（自带样式，不复用 SPA）。
func (h *Home) Page(c *gin.Context) {
	c.Header("Cache-Control", "no-cache")
	c.Data(http.StatusOK, "text/html; charset=utf-8", indexHTML)
}

// GetSites 返回站点列表 JSON；文件缺失/损坏时回退默认站点。
func (h *Home) GetSites(c *gin.Context) {
	c.Data(http.StatusOK, "application/json; charset=utf-8", h.load())
}

// PutSites 整体覆盖保存站点列表。
func (h *Home) PutSites(c *gin.Context) {
	var v []map[string]string // 校验：必须是站点数组
	if err := c.ShouldBindJSON(&v); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid json"})
		return
	}
	b, _ := json.Marshal(v)
	if err := h.save(b); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *Home) load() []byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	if b, err := os.ReadFile(h.file); err == nil && json.Valid(b) {
		return b
	}
	def, _ := json.Marshal(defaultSites)
	return def
}

// save 原子写回（先写临时文件再 rename）。
func (h *Home) save(b []byte) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	tmp := h.file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, h.file)
}
