// Package server 装配 Gin 引擎：注册中间件与路由，挂载前端。
//
// 前端（React + Vite）是独立项目（仓库根 frontend/），不放在后端目录内。
// 后端从磁盘提供其构建产物 frontend/dist（路径由 Config.FrontendDir 指定）；
// 未构建/找不到时回退到后端自带的内嵌单页 fallback.html。
package server

import (
	_ "embed"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
	"ttmux-web/api"
	"ttmux-web/auth"
	"ttmux-web/browser"
	"ttmux-web/home"
	"ttmux-web/pty"
	"ttmux-web/stream"
	"ttmux-web/ttmux"
)

//go:embed fallback.html
var fallbackHTML []byte

type Config struct {
	TTmuxBin    string
	LogsDir     string
	FrontendDir string // frontend/dist 的路径；为空或不存在时用内嵌回退页
	KannaURL    string // 可选：kanna（Claude Code 精美 UI）地址
	BrowserHome string // 浏览器导航起始页地址（供 Chrome 当默认主页）
	DataDir     string // 数据目录（导航页站点列表等持久化到此）
	Password    string
	TOTPSecret  string // 可选：两步验证密钥（base32）初始种子；UI 可覆盖
	TOTPState   string // 两步验证状态持久化文件路径
	LockAfter   int
	LockSecs    int
}

func New(cfg Config) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	tt := ttmux.New(cfg.TTmuxBin)
	a := auth.New(cfg.Password, cfg.TOTPSecret, cfg.TOTPState, cfg.LockAfter, cfg.LockSecs)
	h := api.New(tt, cfg.KannaURL, cfg.BrowserHome)
	hub := stream.New(tt, cfg.LogsDir)

	// 公开端点
	r.POST("/api/login", a.Login)
	r.POST("/api/logout", a.Logout)
	r.GET("/api/pubconfig", a.PubConfig) // 登录页据此决定是否要动态码

	// 导航起始页（免登录）：供被投屏的 Chrome 当默认主页，因此不能挂在认证组里
	hm := home.New(cfg.DataDir)
	r.GET("/home", hm.Page)
	r.GET("/home/sites", hm.GetSites)
	r.PUT("/home/sites", hm.PutSites)

	// 受保护端点
	g := r.Group("/api", a.Middleware())
	{
		g.GET("/me", h.Me)
		g.GET("/info", h.Info)

		g.GET("/fs", h.FS)
		g.GET("/files", h.Files)              // 文件侧栏：列目录
		g.GET("/file", h.File)                // 文件侧栏：读文件
		g.GET("/file/raw", h.FileRaw)         // 文件侧栏：原始字节（图片预览 / ?dl=1 下载）
		g.GET("/file/preview", h.FilePreview) // 文件侧栏：Office 转 PDF 预览
		g.GET("/file/stat", h.FileStat)
		g.DELETE("/file", h.FileDelete)
		g.POST("/file/mkdir", h.FileMkdir) // 文件侧栏：在当前目录新建子目录
		g.POST("/upload", h.Upload)        // 上传文件到指定目录（拖拽到对话框 / 文件侧栏）

		g.GET("/git/status", h.GitStatus)     // Git 面板：当前工作目录所属仓库状态
		g.GET("/git/diff", h.GitDiff)         // Git 面板：单文件差异
		g.POST("/git/stage", h.GitStage)      // 暂存
		g.POST("/git/unstage", h.GitUnstage)  // 取消暂存
		g.POST("/git/discard", h.GitDiscard)  // 放弃改动
		g.POST("/git/commit", h.GitCommit)    // 提交（可选 push）
		g.POST("/git/op", h.GitOp)            // push / pull / fetch / sync

		g.GET("/sessions", h.Sessions)
		g.POST("/sessions", h.NewSession)
		g.PATCH("/sessions/:name", h.RenameSession)
		g.DELETE("/sessions/:name", h.KillSession)
		g.GET("/sessions/:name/capture", h.Capture)
		g.POST("/sessions/:name/keys", h.Keys)                       // 注入原始按键（响应 TUI 选择框）
		g.GET("/sessions/:name/cwd", h.SessionCwd)                   // 会话工作目录（文件侧栏定位）
		g.GET("/sessions/:name/claude", h.ClaudeStatus)              // 检测是否在跑 claude
		g.GET("/sessions/:name/transcript", h.ClaudeTranscript)      // 读 claude 对话记录
		g.GET("/sessions/:name/codex", h.CodexStatus)                // 检测是否在跑 codex
		g.GET("/sessions/:name/codex-transcript", h.CodexTranscript) // 读 codex 对话记录

		g.GET("/tasks", h.Tasks)
		g.POST("/tasks", h.Spawn)
		g.GET("/tasks/:g", h.TaskStatus)
		g.GET("/tasks/:g/collect", h.TaskCollect)
		g.DELETE("/tasks/:g", h.TaskKill)
		g.POST("/tasks/:g/send", h.Send)

		// 蜂群(swarm)：建群/加成员/管理 + 广场/看板
		g.GET("/swarms", h.Swarms)
		g.POST("/swarms", h.SwarmNew)
		g.GET("/swarms/:n", h.SwarmStatus)
		g.DELETE("/swarms/:n", h.SwarmArchive)
		g.POST("/swarms/:n/adopt", h.SwarmAdopt)
		g.POST("/swarms/:n/members", h.SwarmAddMember)
		g.POST("/swarms/:n/done", h.SwarmDone)
		g.POST("/swarms/:n/activate", h.SwarmActivate)
		g.GET("/swarms/:n/feed", h.SwarmFeed)
		g.POST("/swarms/:n/say", h.SwarmSay)
		g.GET("/swarms/:n/board", h.SwarmBoard)
		g.POST("/swarms/:n/task", h.SwarmTaskAdd)
		g.PATCH("/swarms/:n/task/:id", h.SwarmTaskPatch)
		g.DELETE("/swarms/:n/task/:id", h.SwarmTaskDelete)

		g.GET("/football/players", h.FootballPlayers)
		g.POST("/football/players", h.FootballPlayerCreate)
		g.GET("/football/players/:id", h.FootballPlayer)
		g.PATCH("/football/players/:id", h.FootballPlayerPatch)
		g.DELETE("/football/players/:id", h.FootballPlayerDelete)
		g.GET("/football/teams", h.FootballTeams)
		g.POST("/football/teams", h.FootballTeamCreate)
		g.GET("/football/teams/:id", h.FootballTeam)
		g.PATCH("/football/teams/:id", h.FootballTeamPatch)
		g.DELETE("/football/teams/:id", h.FootballTeamDelete)
		g.PUT("/football/teams/:id/lineup", h.FootballTeamLineup)
		g.GET("/football/transfers", h.FootballTransfers)
		g.POST("/football/transfers", h.FootballTransferCreate)

		g.GET("/env", h.Env)
		g.PUT("/env", h.EnvSet)
		g.DELETE("/env/:key", h.EnvDelete)
		g.POST("/env/push", h.EnvPush)

		g.GET("/2fa/qr", a.TOTPQR)            // 当前状态 + 密钥二维码
		g.GET("/2fa/gen", a.TOTPGen)          // 生成新密钥（开启前扫码用）
		g.POST("/2fa/enable", a.TOTPEnable)   // 确认动态码后开启
		g.POST("/2fa/disable", a.TOTPDisable) // 关闭

		// 实时通道
		g.GET("/term/:name", pty.Handler)
		g.GET("/browser/stream", browser.Handler) // 镜像全局 Chrome 画面
		g.GET("/browser/tabs", browser.Tabs)      // 标签页：列出
		g.POST("/browser/tabs", browser.NewTab)   // 标签页：新建
		g.DELETE("/browser/tabs/:id", browser.CloseTab)
		g.POST("/browser/tabs/:id/back", browser.TabBack)         // 后退
		g.POST("/browser/tabs/:id/forward", browser.TabForward)   // 前进
		g.POST("/browser/tabs/:id/reload", browser.TabReload)     // 刷新
		g.POST("/browser/tabs/:id/activate", browser.TabActivate) // 在 Chrome 里前置
		g.POST("/browser/tabs/:id/navigate", browser.TabNavigate) // 导航到 URL
		g.Any("/browser/cdp/*path", browser.DevToolsProxy)        // 反代 Chrome 自带 DevTools(F12) + CDP ws
		g.GET("/stream/status", hub.Status)
		g.GET("/logs/:name", hub.Logs)
	}

	mountWeb(r, cfg.FrontendDir)
	return r
}

func fileExists(p string) bool {
	if p == "" {
		return false
	}
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func mountWeb(r *gin.Engine, frontendDir string) {
	indexPath := filepath.Join(frontendDir, "index.html")
	useReact := fileExists(indexPath)

	if useReact {
		r.Static("/assets", filepath.Join(frontendDir, "assets"))
		log.Printf("前端: React (磁盘 %s)", frontendDir)
	} else {
		log.Printf("前端: 内嵌回退页 —— 运行 ./start-all.sh 会构建 React")
	}

	serve := func(c *gin.Context) {
		c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
		if useReact {
			c.File(indexPath)
			return
		}
		c.Data(http.StatusOK, "text/html; charset=utf-8", fallbackHTML)
	}
	r.GET("/", serve)
	r.NoRoute(func(c *gin.Context) {
		p := c.Request.URL.Path
		if strings.HasPrefix(p, "/api") {
			c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": "NOT_FOUND"}})
			return
		}
		// public 下的静态文件（logo、favicon、manifest 等）：存在就直接返回
		if useReact && p != "/" {
			fp := filepath.Join(frontendDir, filepath.Clean("/"+p))
			if strings.HasPrefix(fp, frontendDir) && fileExists(fp) {
				c.File(fp)
				return
			}
		}
		serve(c) // 否则按 SPA history 路由回退到 index.html
	})
}
