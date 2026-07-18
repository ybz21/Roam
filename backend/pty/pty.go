// Package pty 桥接 tmux attach ↔ 浏览器 xterm.js（WebSocket + creack/pty）。
// 每个会话 = 一个实时命令行。关闭 WS 只 detach，不杀 session。
package pty

import (
	"encoding/json"
	"fmt"
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

// paneAltSize 读活动 pane 是否处于备用屏(alternate screen)及其尺寸。
// alternate_on=1 表示当前跑的是全屏 TUI（Claude Code / Codex / vim / less 等）。
func paneAltSize(name string) (alt bool, w, h int) {
	out, err := exec.Command("tmux", "display-message", "-p", "-t", name, "-F", "#{alternate_on} #{pane_width} #{pane_height}").Output()
	if err != nil {
		return false, 0, 0
	}
	parts := strings.Fields(strings.TrimSpace(string(out)))
	if len(parts) != 3 {
		return false, 0, 0
	}
	w, _ = strconv.Atoi(parts[1])
	h, _ = strconv.Atoi(parts[2])
	return parts[0] == "1", w, h
}

// altScreenWheel 给备用屏 TUI 合成 SGR 滚轮序列并作为输入发给应用，让它滚自己的缓冲。
// 备用屏没有 tmux scrollback，copy-mode 滚不动；而全屏 TUI（Claude/Codex）普遍开了
// SGR 鼠标上报(1006)，直接喂滚轮字节即可。坐标取 pane 中心；wheel 只有按下(M)无释放。
func altScreenWheel(name, dir string, notches, w, h int) {
	btn := 64 // wheel up
	if dir != "up" {
		btn = 65 // wheel down
	}
	col, row := w/2, h/2
	if col < 1 {
		col = 1
	}
	if row < 1 {
		row = 1
	}
	seq := fmt.Sprintf("\x1b[<%d;%d;%dM", btn, col, row)
	_ = exec.Command("tmux", "send-keys", "-t", name, "-l", "--", strings.Repeat(seq, notches)).Run()
}

// tmuxScroll 滚动会话历史，返回本连接是否仍停在 tmux copy-mode（供 handler 决定真实键入前是否需退出）。
//   - 普通屏：走 tmux copy-mode 滚真实 scrollback（attach 全屏，xterm 本地缓冲为空）。
//   - 备用屏(全屏 TUI)：copy-mode 无效，改合成滚轮序列发给应用，让它滚自己的对话缓冲。
func tmuxScroll(name, dir string, lines int) (inCopyMode bool) {
	if lines <= 0 {
		lines = 1
	}
	if alt, w, h := paneAltSize(name); alt {
		switch dir {
		case "up", "down":
			altScreenWheel(name, dir, lines, w, h)
		case "bottom":
			// 全屏 TUI 无统一「到底」键；连发若干次向下滚轮，应用会在底部自然钳住。
			altScreenWheel(name, "down", 200, w, h)
		}
		return false // 没进 tmux copy-mode
	}
	n := strconv.Itoa(lines)
	switch dir {
	case "up":
		_ = exec.Command("tmux", "copy-mode", "-t", name).Run()
		_ = exec.Command("tmux", "send-keys", "-t", name, "-N", n, "-X", "scroll-up").Run()
		return true
	case "down":
		_ = exec.Command("tmux", "send-keys", "-t", name, "-N", n, "-X", "scroll-down").Run()
		return true
	case "bottom":
		_ = exec.Command("tmux", "send-keys", "-t", name, "-X", "cancel").Run() // 退出 copy-mode 回到最新
	}
	return false
}

// tmuxSelectPaneAt 把前端点击的单元格坐标(col,row)映射到所在 pane 并激活它。
// 因为关掉了 tmux 鼠标模式（保住 xterm 本地拖选复制），点击切换 pane 失效；这里在前端
// 单击(非拖选)时按坐标补回「点哪个 pane 就切到哪个」。divider 上的点击不命中任何 pane → 忽略。
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

// tmuxMoveCursorAt 把前端「单击/轻点」的窗口格子坐标翻译成方向键，移动点中 pane 里应用的
// 输入光标，对齐原生输入框「点哪光标到哪」的体验——镜像终端的光标在远端 TUI/shell 手里，
// 点击本身移不动，此前只能靠丝带/键盘上的方向键一格格挪。
//   - 备用屏(全屏 TUI：Claude Code/Codex/vim)：只发水平 ←/→，绝不发竖直 ↑/↓——TUI 输入框里
//     ↑/↓ 普遍绑了历史/滚动(上翻/下翻)，点按稍一偏行就会误触；竖直定位交键盘方向键。
//     竖直距离过远(>8 行)视为点在对话区/输出区（非输入行），整体忽略。
//   - 普通屏(shell readline)：↑/↓ 会翻命令历史，绝不能发；把竖直距离按 pane 宽折算成
//     字符数（折行的长命令 ←/→ 本就会跨行走），只发 ←/→，越过行首行尾由 readline 钳住。
//   - pane 处于 copy-mode 等模式时不动作（按键会被导航吃掉）。
func tmuxMoveCursorAt(name string, col, row int) {
	if col < 0 || row < 0 {
		return
	}
	out, err := exec.Command("tmux", "list-panes", "-t", name, "-F",
		"#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{alternate_on}\t#{cursor_x}\t#{cursor_y}\t#{pane_in_mode}").Output()
	if err != nil {
		return
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.Split(line, "\t")
		if len(parts) != 9 {
			continue
		}
		nums := make([]int, 8)
		ok := true
		for i := 1; i < len(parts); i++ {
			n, err := strconv.Atoi(parts[i])
			if err != nil {
				ok = false
				break
			}
			nums[i-1] = n
		}
		if !ok {
			continue
		}
		left, top, width, height := nums[0], nums[1], nums[2], nums[3]
		alt, cx, cy, inMode := nums[4] == 1, nums[5], nums[6], nums[7] == 1
		if col < left || col >= left+width || row < top || row >= top+height {
			continue
		}
		if inMode {
			return
		}
		dx, dy := (col-left)-cx, (row-top)-cy
		if alt {
			// 点在对话/输出区（离输入行太远）忽略；否则只按水平差移光标，竖直不动。
			if dy > 8 || dy < -8 {
				return
			}
			sendArrows(parts[0], 0, dx)
		} else {
			if dy > 3 || dy < -3 {
				return
			}
			sendArrows(parts[0], 0, dy*width+dx)
		}
		return
	}
}

// sendArrows 先竖直后水平发方向键。用 tmux 命名键(Up/Down/Left/Right)而非裸序列，
// 让 tmux 按应用的光标键模式(DECCKM)选 CSI/SS3 编码。
func sendArrows(pane string, dy, dx int) {
	send := func(key string, n int) {
		if n > 0 {
			_ = exec.Command("tmux", "send-keys", "-t", pane, "-N", strconv.Itoa(n), key).Run()
		}
	}
	if dy > 0 {
		send("Down", dy)
	} else {
		send("Up", -dy)
	}
	if dx > 0 {
		send("Right", dx)
	} else {
		send("Left", -dx)
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
					// 普通屏走 copy-mode 才需在真实键入前退出；备用屏 TUI 喂的是滚轮，inCopyMode=false。
					inCopy = tmuxScroll(name, ctrl.Dir, ctrl.Lines)
					continue
				case "select-pane":
					tmuxSelectPaneAt(name, ctrl.Col, ctrl.Row)
					continue
				case "move-cursor":
					// 若 pane 停在 copy-mode(含本连接滚动进入的)，内部会跳过，不打断浏览历史。
					tmuxMoveCursorAt(name, ctrl.Col, ctrl.Row)
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
