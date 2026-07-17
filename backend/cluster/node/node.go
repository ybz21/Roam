// Package node 是标准节点的出站隧道客户端：拨号云端 Broker、注册 / 重连、把 Broker
// 转发进来的业务请求交给本机业务 Handler、并定期上报心跳。对现有业务 handler 零改动
// ——只是把「本机 loopback」换成「隧道」。见 docs/design/cluster/客户端-服务端横向扩展设计.md §4。
package node

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"time"

	"github.com/gorilla/websocket"
	"ttmux-web/auth"
	"ttmux-web/cluster/tunnel"
)

// 与 broker 侧约定的接入头（见 cluster/broker/broker.go）。
const (
	hdrEnroll = "X-Roam-Enroll"
	hdrNodeID = "X-Roam-Node-Id"
	hdrToken  = "X-Roam-Node-Token"
	hdrName   = "X-Roam-Node-Name"
	hdrGroup  = "X-Roam-Node-Group"
	hdrMeta   = "X-Roam-Node-Meta"
)

// Client 是节点侧隧道客户端。
type Client struct {
	Broker   string       // 云端 Broker 地址，如 https://broker:443
	Token    string       // 一次性 enrollment token（首次注册用）
	Name     string       // 节点显示名
	Group    string       // 分组
	Insecure bool         // 跳过 Broker TLS 校验（自签调试）
	Version  string       // 本机 Roam 版本
	CredPath string       // node.json 落盘路径
	Handler  http.Handler // 本机业务 Handler（server.New 返回的引擎）
}

func (cl *Client) meta() map[string]any {
	host, _ := os.Hostname()
	return map[string]any{
		"hostname":     host,
		"os":           runtime.GOOS,
		"version":      cl.Version,
		"capabilities": []string{"term", "files", "git", "browser", "phone", "swarm"},
	}
}

// Run 持续维持到 Broker 的隧道：断线指数退避重连，直到 ctx 取消。
func (cl *Client) Run(ctx context.Context) {
	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return
		}
		if err := cl.connectOnce(ctx); err != nil {
			log.Printf("[cluster] 连接 Broker 失败: %v（%s 后重试）", err, backoff)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

// connectOnce 建立一次隧道并服务，直到会话断开才返回。
func (cl *Client) connectOnce(ctx context.Context) error {
	u, err := url.Parse(cl.Broker)
	if err != nil {
		return err
	}
	switch u.Scheme {
	case "https", "wss":
		u.Scheme = "wss"
	default:
		u.Scheme = "ws"
	}
	u.Path = "/cluster/tunnel"

	metaJSON, _ := json.Marshal(cl.meta())
	header := http.Header{}
	header.Set(hdrMeta, string(metaJSON))
	if cl.Name != "" {
		header.Set(hdrName, cl.Name)
	}
	if cl.Group != "" {
		header.Set(hdrGroup, cl.Group)
	}
	creds, _ := loadCreds(cl.CredPath)
	enrolling := creds == nil
	if enrolling {
		if cl.Token == "" {
			return errNoToken
		}
		header.Set(hdrEnroll, cl.Token)
	} else {
		header.Set(hdrNodeID, creds.ID)
		header.Set(hdrToken, creds.Token)
	}

	d := websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	if cl.Insecure {
		d.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} // #nosec G402 —— 仅自签调试
	}
	ws, resp, err := d.Dial(u.String(), header)
	if err != nil {
		return err
	}
	if enrolling && resp != nil {
		// 注册成功：从 101 响应头取长期节点凭证并落盘，之后用它重连。
		id, tok := resp.Header.Get(hdrNodeID), resp.Header.Get(hdrToken)
		if id != "" && tok != "" {
			if err := saveCreds(cl.CredPath, &creds2{ID: id, Token: tok}); err != nil {
				log.Printf("[cluster] 保存节点凭证失败: %v", err)
			}
			log.Printf("[cluster] 已注册为节点 %s", id)
		}
	}

	sess, err := tunnel.Client(ws)
	if err != nil {
		_ = ws.Close()
		return err
	}
	defer sess.Close()
	log.Printf("[cluster] 已连上 Broker %s", cl.Broker)

	go cl.heartbeat(ctx, sess)

	// Broker 主动 Open 的流是转发进来的前端业务请求；用本机业务 Handler 服务它们。
	// 隧道流已由 Broker 完成用户会话校验，标记为内部主体（进程内、不可伪造）后放行本地鉴权。
	internal := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cl.Handler.ServeHTTP(w, auth.WithInternal(r))
	})
	return http.Serve(sess, internal) // 会话断开即返回
}

// heartbeat 开一条控制流，定期上报换行分隔的心跳 JSON。
func (cl *Client) heartbeat(ctx context.Context, sess sessionOpener) {
	st, err := sess.Open()
	if err != nil {
		return
	}
	defer st.Close()
	enc := json.NewEncoder(st)
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		// TODO(P2): 上报真实会话数 / 负载（现从 ttmux 查）。
		if err := enc.Encode(map[string]any{"sessionCount": 0, "load": 0.0}); err != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
