// Package pty 桥接 tmux attach ↔ 浏览器 xterm.js（WebSocket + creack/pty）。
// 每个会话 = 一个实时命令行。关闭 WS 只 detach，不杀 session。
package pty

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"

	creackpty "github.com/creack/pty"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// tmuxScroll 通过 tmux copy-mode 滚动会话的真实历史（attach 用全屏，xterm 本地缓冲为空）。
func tmuxScroll(name, dir string, lines int) {
	if lines <= 0 {
		lines = 1
	}
	n := strconv.Itoa(lines)
	switch dir {
	case "up":
		_ = exec.Command("tmux", "copy-mode", "-t", name).Run()
		_ = exec.Command("tmux", "send-keys", "-t", name, "-N", n, "-X", "scroll-up").Run()
	case "down":
		_ = exec.Command("tmux", "send-keys", "-t", name, "-N", n, "-X", "scroll-down").Run()
	case "bottom":
		_ = exec.Command("tmux", "send-keys", "-t", name, "-X", "cancel").Run() // 退出 copy-mode 回到最新
	}
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// 同源校验：Origin 的 host 必须等于请求 Host（配合 SameSite Cookie 防跨站劫持）
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true // 非浏览器客户端
		}
		i := strings.Index(origin, "://")
		if i < 0 {
			return false
		}
		return origin[i+3:] == r.Host
	},
}

// Handler 处理 /api/term/:name 的 WebSocket 升级与 PTY 桥接。
func Handler(c *gin.Context) {
	name := c.Param("name")
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	cmd := exec.Command("tmux", "attach", "-t", name)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	ptmx, err := creackpty.Start(cmd)
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte("\r\n[无法连接会话: "+name+"]\r\n"))
		return
	}
	defer func() {
		_ = ptmx.Close()
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}()
	_ = creackpty.Setsize(ptmx, &creackpty.Winsize{Rows: 30, Cols: 100})

	// pty → ws
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				if werr := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
				conn.Close()
				return
			}
		}
	}()

	// ws → pty（文本帧若为 resize 控制消息则调整窗口大小，否则当作键入）
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if mt == websocket.TextMessage && len(data) > 0 && data[0] == '{' {
			var ctrl struct {
				Type  string `json:"type"`
				Cols  uint16 `json:"cols"`
				Rows  uint16 `json:"rows"`
				Dir   string `json:"dir"`
				Lines int    `json:"lines"`
			}
			if json.Unmarshal(data, &ctrl) == nil && ctrl.Type != "" {
				switch ctrl.Type {
				case "resize":
					_ = creackpty.Setsize(ptmx, &creackpty.Winsize{Rows: ctrl.Rows, Cols: ctrl.Cols})
					continue
				case "scroll":
					tmuxScroll(name, ctrl.Dir, ctrl.Lines)
					continue
				}
			}
		}
		if _, err := ptmx.Write(data); err != nil {
			return
		}
	}
}
