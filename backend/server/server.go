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
	Password    string
	LockAfter   int
	LockSecs    int
}

func New(cfg Config) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	tt := ttmux.New(cfg.TTmuxBin)
	a := auth.New(cfg.Password, cfg.LockAfter, cfg.LockSecs)
	h := api.New(tt, cfg.KannaURL)
	hub := stream.New(tt, cfg.LogsDir)

	// 公开端点
	r.POST("/api/login", a.Login)
	r.POST("/api/logout", a.Logout)

	// 受保护端点
	g := r.Group("/api", a.Middleware())
	{
		g.GET("/me", h.Me)
		g.GET("/info", h.Info)

		g.GET("/fs", h.FS)

		g.GET("/sessions", h.Sessions)
		g.POST("/sessions", h.NewSession)
		g.DELETE("/sessions/:name", h.KillSession)
		g.GET("/sessions/:name/capture", h.Capture)

		g.GET("/tasks", h.Tasks)
		g.POST("/tasks", h.Spawn)
		g.GET("/tasks/:g", h.TaskStatus)
		g.GET("/tasks/:g/collect", h.TaskCollect)
		g.DELETE("/tasks/:g", h.TaskKill)
		g.POST("/tasks/:g/send", h.Send)

		g.GET("/env", h.Env)
		g.PUT("/env", h.EnvSet)
		g.DELETE("/env/:key", h.EnvDelete)
		g.POST("/env/push", h.EnvPush)

		// 实时通道
		g.GET("/term/:name", pty.Handler)
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
		if strings.HasPrefix(c.Request.URL.Path, "/api") {
			c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": "NOT_FOUND"}})
			return
		}
		serve(c) // SPA history 路由回退
	})
}
