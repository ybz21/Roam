// Package browser 把一台全局 Chrome 的可视画面镜像到浏览器端。
//
// 不引入额外依赖：Chrome DevTools 协议(CDP)本身就是 WebSocket JSON-RPC，
// 直接用项目已有的 gorilla/websocket 桥接即可。
//
// 单实例模型：全局只对接一台 Chrome（调试端口默认 127.0.0.1:9222）。
//   - 若该端口已有 Chrome（比如 agent 自己起的），直接附着，不重复拉起；
//   - 若没有，本进程拉起一个带远程调试端口的 Chrome。
package browser

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// CDPBase 是 Chrome 远程调试根地址，可用环境变量 TTMUX_CHROME_CDP 覆盖。
var CDPBase = envOr("TTMUX_CHROME_CDP", "http://127.0.0.1:9222")

// 仅登记「本进程亲手拉起」的 Chrome，用于退出时回收；附着到已存在的 Chrome 时为 nil，不回收。
var (
	procMu sync.Mutex
	chrome *exec.Cmd
)

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func chromeExecutable() string {
	if v := os.Getenv("CHROME_BIN"); v != "" {
		if _, err := os.Stat(v); err == nil {
			return v
		}
	}
	for _, name := range []string{"google-chrome", "chromium", "chromium-browser"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	for _, p := range []string{
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
	} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "google-chrome"
}

type target struct {
	ID                   string `json:"id"`
	Type                 string `json:"type"`
	Title                string `json:"title"`
	URL                  string `json:"url"`
	WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
}

// ensureChrome 确保调试端口可用；不可用则尝试拉起一个 Chrome。
func ensureChrome() error {
	if alive() {
		return nil
	}
	args := []string{
		"--remote-debugging-port=9222",
		"--remote-debugging-address=127.0.0.1",
		"--remote-allow-origins=*",
		"--user-data-dir=/tmp/ttmux-chrome",
		"--no-first-run", "--no-default-browser-check",
		// 高 DPI 渲染：像素密度翻倍但 CSS 布局不变 → 画面更清晰（可用 TTMUX_CHROME_SCALE 调）
		"--force-device-scale-factor=" + envOr("TTMUX_CHROME_SCALE", "2"),
	}
	if runtime.GOOS != "darwin" && os.Getenv("DISPLAY") == "" { // 无显示器（服务器）→ 无头，screencast 同样可用
		args = append(args, "--headless=new", "--window-size=1280,800")
	}
	args = append(args, "about:blank")
	cmd := exec.Command(chromeExecutable(), args...)
	// 不继承本进程的 stdout/stderr：避免 Chrome 日志刷屏，也避免持有管道导致父进程读阻塞
	cmd.Stdout = nil
	cmd.Stderr = nil
	// 自成进程组：回收时可整组 kill（含 zygote/gpu/renderer/crashpad 等子进程）
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("拉起 Chrome 失败: %w", err)
	}
	procMu.Lock()
	chrome = cmd
	procMu.Unlock()
	go cmd.Wait()             // 收尸，避免 Chrome 自行退出后留下僵尸
	for i := 0; i < 50; i++ { // 最多等 5s
		if alive() {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("Chrome 调试端口 %s 未就绪", CDPBase)
}

// Shutdown 回收本进程拉起的 Chrome（整进程组）。附着到外部 Chrome 时为空操作。
// 由 main 在收到 SIGINT/SIGTERM 时调用。
func Shutdown() {
	procMu.Lock()
	defer procMu.Unlock()
	if chrome == nil || chrome.Process == nil {
		return
	}
	if pgid, err := syscall.Getpgid(chrome.Process.Pid); err == nil {
		_ = syscall.Kill(-pgid, syscall.SIGKILL) // 负 pgid = 杀整组
	} else {
		_ = chrome.Process.Kill()
	}
	chrome = nil
}

func alive() bool {
	resp, err := http.Get(CDPBase + "/json/version")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// browserUA 取这台 Chrome 的原生 User-Agent（/json/version 的 "User-Agent" 字段）。
// 用于手机模式切回桌面时复位 UA——CDP 没有 clearUserAgentOverride，只能再 set 回默认值。
func browserUA() string {
	resp, err := http.Get(CDPBase + "/json/version")
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var v struct {
		UserAgent string `json:"User-Agent"`
	}
	_ = json.Unmarshal(b, &v)
	return v.UserAgent
}

// listPages 返回所有 page 类型的标签页（过滤掉 service worker / iframe 等其它 target）。
func listPages() []target {
	resp, err := http.Get(CDPBase + "/json")
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var ts []target
	if json.Unmarshal(b, &ts) != nil {
		return nil
	}
	pages := ts[:0]
	for _, t := range ts {
		if t.Type == "page" {
			pages = append(pages, t)
		}
	}
	return pages
}

// targetWS 返回指定标签页的 CDP WebSocket 地址。
// id 为空 → 取第一个 page；一个 page 都没有时新建一个空白页。
func targetWS(id string) (string, error) {
	pages := listPages()
	for _, t := range pages {
		if t.WebSocketDebuggerURL == "" {
			continue
		}
		if id == "" || t.ID == id {
			return t.WebSocketDebuggerURL, nil
		}
	}
	if id != "" {
		return "", fmt.Errorf("标签页不存在: %s", id)
	}
	// 没有任何 page，开一个空白页再找
	_ = newTab("about:blank")
	for _, t := range listPages() {
		if t.WebSocketDebuggerURL != "" {
			return t.WebSocketDebuggerURL, nil
		}
	}
	return "", fmt.Errorf("找不到可用的 page 目标")
}

// newTab 新建一个标签页（Chrome ≥111 要求 PUT /json/new）。
func newTab(rawURL string) error {
	u := CDPBase + "/json/new"
	if rawURL != "" {
		u += "?" + rawURL
	}
	req, _ := http.NewRequest(http.MethodPut, u, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("新建标签页失败: %s", resp.Status)
	}
	return nil
}

// closeTab 关闭指定标签页。
func closeTab(id string) error {
	resp, err := http.Get(CDPBase + "/json/close/" + id)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// activateTab 把指定标签页在 Chrome 里前置（让 agent 的前台焦点与正在镜像的一致）。
func activateTab(id string) error {
	resp, err := http.Get(CDPBase + "/json/activate/" + id)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// call 发一条 CDP 命令并等待匹配 id 的响应（仅用于一次性专用连接，与帧 goroutine 不共用读端）。
func (c *cdp) call(method string, params map[string]any) (json.RawMessage, error) {
	c.mu.Lock()
	c.id++
	id := c.id
	err := c.ws.WriteJSON(map[string]any{"id": id, "method": method, "params": params})
	c.mu.Unlock()
	if err != nil {
		return nil, err
	}
	_ = c.ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, data, err := c.ws.ReadMessage()
		if err != nil {
			return nil, err
		}
		var r struct {
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &r) != nil || r.ID != id {
			continue // 事件(无 id)或其它响应，跳过
		}
		if r.Error != nil {
			return nil, fmt.Errorf("%s", r.Error.Message)
		}
		return r.Result, nil
	}
}

// withTab 临时连到某标签页的 CDP，执行 fn 后断开。
func withTab(id string, fn func(*cdp) error) error {
	ws, err := targetWS(id)
	if err != nil {
		return err
	}
	back, _, err := websocket.DefaultDialer.Dial(ws, nil)
	if err != nil {
		return err
	}
	defer back.Close()
	return fn(&cdp{ws: back})
}

func tabReload(id string) error {
	return withTab(id, func(c *cdp) error { _, err := c.call("Page.reload", nil); return err })
}

func tabNavigate(id, url string) error {
	return withTab(id, func(c *cdp) error {
		_, err := c.call("Page.navigate", map[string]any{"url": url})
		return err
	})
}

// tabHistory 按 delta（-1 后退 / +1 前进）走导航历史；到边界则静默不动。
func tabHistory(id string, delta int) error {
	return withTab(id, func(c *cdp) error {
		res, err := c.call("Page.getNavigationHistory", nil)
		if err != nil {
			return err
		}
		var h struct {
			CurrentIndex int `json:"currentIndex"`
			Entries      []struct {
				ID int `json:"id"`
			} `json:"entries"`
		}
		if err := json.Unmarshal(res, &h); err != nil {
			return err
		}
		i := h.CurrentIndex + delta
		if i < 0 || i >= len(h.Entries) {
			return nil // 无可后退/前进
		}
		_, err = c.call("Page.navigateToHistoryEntry", map[string]any{"entryId": h.Entries[i].ID})
		return err
	})
}
