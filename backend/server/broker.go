package server

import (
	"net/http"
	"path/filepath"

	"github.com/gin-gonic/gin"
	"ttmux-web/auth"
	"ttmux-web/cluster/broker"
)

// NewBroker 装配**云端 Broker** 的 Gin 引擎。它**不复用 New()**——不构造业务 runtime、
// 不启动 SyncLoop、不初始化 browser / phone / pty，只做：用户认证入口、静态资源（控制台）、
// 节点隧道接入、Broker-local API（/api/broker/*）、以及把 /n/:nodeId/* 反代进目标节点。
// 见 docs/design/cluster/客户端-服务端横向扩展设计.md §4。
func NewBroker(cfg Config) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.UseRawPath = true
	r.Use(gin.Recovery())

	a := auth.New(cfg.Password, cfg.TOTPSecret, cfg.TOTPState, cfg.LockAfter, cfg.LockSecs, cfg.SavePassword)
	brk := broker.New(filepath.Join(cfg.DataDir, "cluster"))

	// 公开端点（与单机一致：登录 / 首次设置 / 版本 / 证书 / 导航页）
	mountPublic(r, a, cfg)

	// 节点出站隧道接入（token 鉴权，非用户会话）。
	r.GET("/cluster/tunnel", brk.HandleTunnel)

	// 用户会话下的最小 /api（控制台探活用；业务 API 一律经 /n/<id> 代理到节点）。
	g := r.Group("/api", a.Middleware())
	g.Use(func(c *gin.Context) { c.Header("Cache-Control", "no-store") })
	g.GET("/me", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}}) })

	// Broker-local API：节点列表 / bootstrap / 接入签发（用户会话鉴权）。
	bg := r.Group("/api/broker", a.Middleware())
	bg.Use(func(c *gin.Context) { c.Header("Cache-Control", "no-store") })
	bg.GET("/nodes", brk.Nodes)
	bg.GET("/bootstrap", brk.Bootstrap)
	bg.POST("/enroll", brk.Enroll)

	// 节点反代：/n/:nodeId/*path（用户会话鉴权后转发进目标节点隧道）。
	ng := r.Group("/n/:nodeId", a.Middleware())
	ng.Any("/*path", brk.ProxyNode)

	mountWeb(r, cfg.FrontendDir)
	return r
}
