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

// utf8Env 保证 tmux 客户端 locale 为 UTF-8。tmux 按客户端 LC_ALL/LC_CTYPE/LANG 是否含 UTF-8
// 决定能否渲染中文等宽字符，pane 里的 ls 也依赖它正确输出文件名；后端进程常跑在 C/POSIX
// locale 下（服务化部署），不补就会满屏乱码。仅在现有 locale 非 UTF-8 时追加 C.UTF-8，尊重已有设置。
func utf8Env(env []string) []string {
	get := func(k string) (string, bool) {
		p := k + "="
		for i := len(env) - 1; i >= 0; i-- { // 后出现的覆盖前面的
			if strings.HasPrefix(env[i], p) {
				return env[i][len(p):], true
			}
		}
		return "", false
	}
	eff := ""
	if v, ok := get("LC_ALL"); ok && v != "" {
		eff = v
	} else if v, ok := get("LC_CTYPE"); ok && v != "" {
		eff = v
	} else if v, ok := get("LANG"); ok {
		eff = v
	}
	u := strings.ToUpper(eff)
	if strings.Contains(u, "UTF-8") || strings.Contains(u, "UTF8") {
		return env
	}
	return append(env, "LC_ALL=C.UTF-8")
}

// SanitizeSessionName 替换 tmux 会话名中的 '.' 和 ':'，避免 -t 解析出错。
func SanitizeSessionName(name string) string {
	return strings.NewReplacer(".", "_", ":", "_").Replace(name)
}

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

func tmuxSelectPaneAt(name string, col, row int) {
	if col < 0 || row < 0 {
		return
	}
	out, err := exec.Command("tmux", "list-panes", "-t", name, "-F", "#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}").Output()
	if err != nil {
		return
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.Split(line, "\t")
		if len(parts) != 5 {
			continue
		}
		left, err1 := strconv.Atoi(parts[1])
		top, err2 := strconv.Atoi(parts[2])
		width, err3 := strconv.Atoi(parts[3])
		height, err4 := strconv.Atoi(parts[4])
		if err1 != nil || err2 != nil || err3 != nil || err4 != nil {
			continue
		}
		if col >= left && col < left+width && row >= top && row < top+height {
			_ = exec.Command("tmux", "select-pane", "-t", parts[0]).Run()
			return
		}
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
	name := SanitizeSessionName(c.Param("name"))
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	// 关闭 tmux 鼠标模式，保留浏览器/xterm 原生拖选复制体验。
	// Web 端需要点击切换 pane 时，会发送 select-pane 控制消息，由后端按点击坐标选择窗格。
	_ = exec.Command("tmux", "set-option", "-t", name, "mouse", "off").Run()

	// 窗口尺寸跟随「最近活跃的客户端」，而非被所有 attach 客户端里最小的那个限制。
	// 同一会话被多处 attach（网页多标签 / 手机+桌面 / CLI）时，默认会缩到最小客户端，
	// 表现为当前这个明明很宽却渲染成左侧窄条；latest + aggressive-resize 让在用的客户端尺寸生效。
	_ = exec.Command("tmux", "set-option", "-t", name, "window-size", "latest").Run()
	_ = exec.Command("tmux", "set-window-option", "-t", name, "aggressive-resize", "on").Run()
	// extended-keys always: 让 tmux 接受并透传 CSI u 修饰键序列（如 Shift+Enter = \x1b[13;2u），
	// 使 Claude Code / Codex 等 TUI 能区分 Enter(提交) 与 Shift+Enter(换行)。
	_ = exec.Command("tmux", "set-option", "-t", name, "extended-keys", "always").Run()

	// 新连接一律退出可能残留的 copy-mode：copy-mode 是会话级状态，会跨 attach/重连存活。
	// 上次滚动历史进了 copy-mode 后断线重连时，本连接的 inCopy 会重置为 false，但 tmux 仍停在
	// copy-mode，键入被导航键吃掉到不了 shell（表现为「要先按底才能输入」）。这里让新客户端
	// 一律从实时提示符开始。
	_ = exec.Command("tmux", "send-keys", "-t", name, "-X", "cancel").Run()

	cmd := exec.Command("tmux", "attach", "-t", name)
	cmd.Env = utf8Env(append(os.Environ(), "TERM=xterm-256color"))
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

	// 跟踪本连接是否处于 tmux copy-mode（向上滚动会进入）。一旦进入，键入会被 copy-mode
	// 当导航键吃掉、到不了 shell，且新输出不再跟随到底。所以真实键入前先退出 copy-mode，
	// 让任意按键都像真实终端那样跳回实时提示符。
	inCopy := false

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
				Col   int    `json:"col"`
				Row   int    `json:"row"`
			}
			if json.Unmarshal(data, &ctrl) == nil && ctrl.Type != "" {
				switch ctrl.Type {
				case "resize":
					// 防御异常尺寸：前端布局未就绪 / 面板折叠 / 离屏挂载时可能发来极窄的 cols(如 2)。
					// 因 window-size=latest，这会把共享会话挤成「窄条」，且客户端断开后仍卡住——
					// swarm 的 leader/成员会话(claude/codex TUI)会因此渲染崩坏，连 @leader 的消息都进不了输入框。
					// 低于阈值视为无效，忽略本次 resize（保持原尺寸，不被挤窄）。
					if ctrl.Cols < 20 || ctrl.Rows < 6 {
						continue
					}
					_ = creackpty.Setsize(ptmx, &creackpty.Winsize{Rows: ctrl.Rows, Cols: ctrl.Cols})
					continue
				case "scroll":
					tmuxScroll(name, ctrl.Dir, ctrl.Lines)
					inCopy = ctrl.Dir != "bottom" // up/down 仍在 copy-mode；bottom 已 cancel 退出
					continue
				case "select-pane":
					tmuxSelectPaneAt(name, ctrl.Col, ctrl.Row)
					continue
				}
			}
		}
		// 有真实键入：若还停在 copy-mode，先退出回到底部，否则按键会被吃掉、打不到 shell。
		if inCopy {
			tmuxScroll(name, "bottom", 0)
			inCopy = false
		}
		if _, err := ptmx.Write(data); err != nil {
			return
		}
	}
}
