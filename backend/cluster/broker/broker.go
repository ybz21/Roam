package broker

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"ttmux-web/cluster/tunnel"
)

// Broker 组合注册表 + 隧道服务端 + 反代，暴露一组 gin.HandlerFunc。
type Broker struct {
	reg *Registry
	up  websocket.Upgrader
}

// New 从 dir 加载注册表（nodes.json）。
func New(dir string) *Broker {
	return &Broker{
		reg: NewRegistry(dir),
		// 节点接入靠 token 鉴权（见 HandleTunnel），来源不是浏览器，放开 Origin 校验。
		up: websocket.Upgrader{ReadBufferSize: 4096, WriteBufferSize: 4096, CheckOrigin: func(*http.Request) bool { return true }},
	}
}

// 隧道接入 / 心跳协议里用到的头。
const (
	hdrEnroll = "X-Roam-Enroll"     // 一次性接入令牌（首次注册）
	hdrNodeID = "X-Roam-Node-Id"    // 长期节点 id（重连）
	hdrToken  = "X-Roam-Node-Token" // 长期节点凭证（重连；注册成功时经 101 响应头下发一次）
	hdrName   = "X-Roam-Node-Name"
	hdrGroup  = "X-Roam-Node-Group"
	hdrMeta   = "X-Roam-Node-Meta" // JSON(NodeMeta)
)

// HandleTunnel 是节点出站拨号的落点：先按 token 鉴权（enrollment 或长期凭证），
// 再升级为 WebSocket、包成 yamux 会话并登记。**不走用户会话鉴权**——它是节点在连，
// 不是浏览器。鉴权在 Upgrade 之前完成，避免给未授权连接升级协议。
func (b *Broker) HandleTunnel(c *gin.Context) {
	var meta NodeMeta
	if s := c.GetHeader(hdrMeta); s != "" {
		_ = json.Unmarshal([]byte(s), &meta)
	}

	var id, plainToken string
	respHeader := http.Header{}
	if enroll := c.GetHeader(hdrEnroll); enroll != "" {
		var ok bool
		id, plainToken, ok = b.reg.ConsumeEnrollment(enroll, c.GetHeader(hdrName), c.GetHeader(hdrGroup), meta)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": gin.H{"code": "ENROLL_INVALID"}})
			return
		}
		// 长期凭证经 101 响应头下发一次；节点收到后落盘 node.json，之后用它重连。
		respHeader.Set(hdrNodeID, id)
		respHeader.Set(hdrToken, plainToken)
	} else {
		id = c.GetHeader(hdrNodeID)
		if id == "" || !b.reg.AuthNode(id, c.GetHeader(hdrToken)) {
			c.JSON(http.StatusUnauthorized, gin.H{"error": gin.H{"code": "NODE_UNAUTHORIZED"}})
			return
		}
	}

	ws, err := b.up.Upgrade(c.Writer, c.Request, respHeader)
	if err != nil {
		return // Upgrade 内部已写响应
	}
	sess, err := tunnel.Server(ws)
	if err != nil {
		_ = ws.Close()
		return
	}
	b.reg.Attach(id, sess, meta)
	defer func() {
		b.reg.Detach(id, sess)
		_ = sess.Close()
	}()

	// 节点主动开的流是控制流（心跳）；前端请求走 Broker 主动 Open 的流（见 proxyNode）。
	for {
		st, err := sess.Accept()
		if err != nil {
			return // 会话断开
		}
		go b.readControl(id, st)
	}
}

// readControl 读一条控制流上换行分隔的心跳 JSON：{"sessionCount":n,"load":f}。
func (b *Broker) readControl(id string, conn net.Conn) {
	defer conn.Close()
	sc := bufio.NewScanner(conn)
	for sc.Scan() {
		var hb struct {
			SessionCount int     `json:"sessionCount"`
			Load         float64 `json:"load"`
		}
		if json.Unmarshal(sc.Bytes(), &hb) == nil {
			b.reg.Heartbeat(id, hb.SessionCount, hb.Load)
		}
	}
}

// Nodes 返回节点列表（/api/broker/nodes）。
func (b *Broker) Nodes(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"data": b.reg.List()})
}

// Bootstrap 返回控制台启动所需的最小信息（/api/broker/bootstrap）：可访问节点 +
// 推荐节点。**Broker 本地处理，不依赖 current node**，消除前端 currentNode 启动循环。
// 见 docs/design/cluster/多机切换交互设计.md §9.1。
func (b *Broker) Bootstrap(c *gin.Context) {
	nodes := b.reg.List()
	recommended := ""
	for _, n := range nodes {
		if n.Online {
			recommended = n.ID
			break
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"nodes": nodes, "recommended": recommended}})
}

// Enroll 签发一次性接入令牌并给出接入命令（POST /api/broker/enroll）。
func (b *Broker) Enroll(c *gin.Context) {
	var body struct{ Name, Group string }
	_ = c.ShouldBindJSON(&body)
	e := b.reg.CreateEnrollment(body.Name, body.Group, 0)
	scheme := "https"
	if c.Request.TLS == nil && c.GetHeader("X-Forwarded-Proto") != "https" {
		scheme = "http"
	}
	base := scheme + "://" + c.Request.Host
	cmd := "curl -fsSL " + base + "/install.sh | bash -s -- --broker " + base + " --token " + e.Token
	if body.Name != "" {
		cmd += " --name " + strconv.Quote(body.Name)
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"token": e.Token, "expiresAt": e.ExpiresAt, "command": cmd}})
}

// ProxyNode 把 /n/:nodeId/*path 反代进目标节点的隧道流（REST + WebSocket 升级）。
// 转发本体是 httputil.ReverseProxy（同 backend/browser/devtools.go），只是把底层连接
// 换成该节点隧道上 Open() 出来的 yamux 流。见架构文档 §7.2。
func (b *Broker) ProxyNode(c *gin.Context) {
	id := c.Param("nodeId")
	sess := b.reg.Session(id)
	if sess == nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": gin.H{"code": "NODE_OFFLINE"}})
		return
	}
	target := &url.URL{Scheme: "http", Host: "node"}
	rp := httputil.NewSingleHostReverseProxy(target)
	rp.Transport = &http.Transport{
		DialContext:           func(context.Context, string, string) (net.Conn, error) { return sess.Open() },
		ResponseHeaderTimeout: 30 * time.Second,
	}
	rp.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		w.WriteHeader(http.StatusBadGateway)
	}
	// 剥掉 /n/<id> 前缀，节点业务 Handler 只认 /api/...。
	c.Request.URL.Path = c.Param("path")
	c.Request.URL.RawPath = ""
	rp.ServeHTTP(c.Writer, c.Request)
}
