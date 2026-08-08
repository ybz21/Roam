// Package tunnel 把一条 WebSocket 连接包成可多路复用的双向隧道（yamux over wss），
// 供云端 Broker 与标准节点共用。一条隧道里能并发开多条逻辑流：一条终端会话、一次
// 文件下载、一次 CDP 反代各占一条流，互不阻塞；心跳走单独的控制流。
//
// 载体用项目已有的 gorilla/websocket（走 443/wss 对企业防火墙最友好），多路复用用
// hashicorp/yamux。见 docs/design/cluster/客户端-服务端横向扩展设计.md §7.1。
package tunnel

import (
	"io"
	"net"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hashicorp/yamux"
)

// wsConn 把 *websocket.Conn 适配成 net.Conn，让 yamux 能在其上跑。
// gorilla 允许「一个并发读 + 一个并发写」，正好匹配 yamux 的单读单写循环。
type wsConn struct {
	ws *websocket.Conn
	r  io.Reader // 当前 binary message 的 reader（跨 Read 调用续读）
}

func (c *wsConn) Read(p []byte) (int, error) {
	for {
		if c.r == nil {
			mt, r, err := c.ws.NextReader()
			if err != nil {
				return 0, err
			}
			if mt != websocket.BinaryMessage {
				continue // 忽略非二进制帧（如对端的 ping/close 由 gorilla 内部处理）
			}
			c.r = r
		}
		n, err := c.r.Read(p)
		if err == io.EOF {
			c.r = nil // 当前 message 读完，等下一帧
			if n > 0 {
				return n, nil
			}
			continue
		}
		return n, err
	}
}

func (c *wsConn) Write(p []byte) (int, error) {
	if err := c.ws.WriteMessage(websocket.BinaryMessage, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (c *wsConn) Close() error                       { return c.ws.Close() }
func (c *wsConn) LocalAddr() net.Addr                { return c.ws.LocalAddr() }
func (c *wsConn) RemoteAddr() net.Addr               { return c.ws.RemoteAddr() }
func (c *wsConn) SetReadDeadline(t time.Time) error  { return c.ws.SetReadDeadline(t) }
func (c *wsConn) SetWriteDeadline(t time.Time) error { return c.ws.SetWriteDeadline(t) }

func (c *wsConn) SetDeadline(t time.Time) error {
	if err := c.ws.SetReadDeadline(t); err != nil {
		return err
	}
	return c.ws.SetWriteDeadline(t)
}

func yamuxCfg() *yamux.Config {
	cfg := yamux.DefaultConfig()
	cfg.EnableKeepAlive = true
	cfg.KeepAliveInterval = 15 * time.Second
	cfg.ConnectionWriteTimeout = 20 * time.Second
	cfg.LogOutput = io.Discard
	return cfg
}

// Server 在 Broker 侧把接受到的节点长连包成 yamux 会话（server 端）。
// 返回的 *yamux.Session 既能 Open() 出流（转发前端请求给节点），也实现 net.Listener
// 接口，Accept() 出节点主动开的控制流（心跳）。
func Server(ws *websocket.Conn) (*yamux.Session, error) {
	return yamux.Server(&wsConn{ws: ws}, yamuxCfg())
}

// Client 在节点侧把出站长连包成 yamux 会话（client 端）。节点用它 Accept() 出
// Broker 转发进来的业务请求流（交给本机业务 Handler），并 Open() 控制流上报心跳。
func Client(ws *websocket.Conn) (*yamux.Session, error) {
	return yamux.Client(&wsConn{ws: ws}, yamuxCfg())
}
