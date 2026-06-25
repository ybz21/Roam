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
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// CDPBase 是 Chrome 远程调试根地址。默认 127.0.0.1:9222；端口被占时会自动换一个空闲端口并记录复用。
// 设了环境变量 TTMUX_CHROME_CDP 则固定用它（不自动换端口）。
var (
	cdpFixed = os.Getenv("TTMUX_CHROME_CDP") != ""
	CDPBase  = envOr("TTMUX_CHROME_CDP", "http://127.0.0.1:9222")
)

// 仅登记「本进程亲手拉起」的 Chrome，用于退出时回收；附着到已存在的 Chrome 时为 nil，不回收。
var (
	procMu sync.Mutex
	chrome *exec.Cmd

	launchMu   sync.Mutex // 串行化拉起，避免并发/轮询同时各拉一个
	lastLaunch time.Time  // 上次拉起时刻，做冷却防抖（端口没起来时别每次轮询都重开）

	statusMu sync.Mutex // 保护 lastErr
	lastErr  string     // 最近一次 ensureChrome 失败原因，供 /browser/health 回显到 UI
)

func setLastErr(s string) { statusMu.Lock(); lastErr = s; statusMu.Unlock() }

// cdpPort 解析 CDPBase 里的端口；解析失败回落 9222。
func cdpPort() int {
	if u, err := url.Parse(CDPBase); err == nil {
		if _, p, err := net.SplitHostPort(u.Host); err == nil {
			if n, err := strconv.Atoi(p); err == nil {
				return n
			}
		}
	}
	return 9222
}

// setCDPPort 切到新端口并持久化记录（下次启动优先复用，避免反复换端口开多个 Chrome）。
func setCDPPort(port int) {
	CDPBase = fmt.Sprintf("http://127.0.0.1:%d", port)
	recordPort(port)
}

// portFree 探测某端口当前是否可监听（被占则 false）。
func portFree(port int) bool {
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}

// pickFreePort 让内核分配一个空闲端口。
func pickFreePort() (int, bool) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, false
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port, true
}

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
// 关键：串行 + 冷却 + 不重复拉起。否则在 macOS 上若拉起的 Chrome 没能在 9222 就绪，
// 每次 /browser/tabs 轮询(3s)都会再拉一个；而同 user-data-dir 的 Chrome 是单例，
// 第二个会把 about:blank 转发给已有实例后退出 → 表现为「不停弹 about:blank 窗口」。
func ensureChrome() error {
	if alive() {
		return nil
	}
	launchMu.Lock()
	defer launchMu.Unlock()
	if alive() { // 双检：等锁期间别的协程可能已拉起就绪
		return nil
	}
	// 已有本进程拉起的 Chrome 仍在运行，或刚拉起过(冷却内)：不再开新的，给端口一点时间起来。
	procMu.Lock()
	running := chrome != nil && chrome.Process != nil
	procMu.Unlock()
	if running || time.Since(lastLaunch) < 12*time.Second {
		for i := 0; i < 30; i++ {
			if alive() {
				return nil
			}
			time.Sleep(100 * time.Millisecond)
		}
		err := fmt.Errorf("Chrome 启动中或上次未就绪，调试端口 %s 暂未就绪", CDPBase)
		setLastErr(err.Error())
		return err
	}

	// 端口选择：当前端口被别的进程占着（且不是可用 Chrome，否则上面 alive 已 attach）→ 换一个空闲端口，
	// 并记录复用，避免反复换端口开出多个 Chrome。固定端口模式(TTMUX_CHROME_CDP)不自动换。
	port := cdpPort()
	if !cdpFixed && !portFree(port) {
		if p, ok := pickFreePort(); ok {
			port = p
			setCDPPort(port)
		}
	}

	cfg := effectiveConfig() // Settings 里存的值 > env > 默认
	args := []string{
		"--remote-debugging-port=" + strconv.Itoa(port),
		"--remote-debugging-address=127.0.0.1",
		"--remote-allow-origins=*",
		// profile 目录：默认隔离的临时 profile（不带你真实 Chrome 的登录/cookie/扩展）。
		// 想复用真实登录态：把 profile 指到真实目录，但需先完全退出你平时的 Chrome（同 profile
		// 不能两实例同时占用），且 Google 登录可能被「浏览器不安全」拦。
		"--user-data-dir=" + cfg.Profile,
		"--no-first-run", "--no-default-browser-check",
		// 高 DPI 渲染：像素密度翻倍但 CSS 布局不变 → 画面更清晰
		"--force-device-scale-factor=" + cfg.Scale,
	}
	// 无头/有头：auto=按有无显示器自动判断；on=强制无头；off=强制有头。
	// 强制有头但无显示器(DISPLAY 空)时 Chrome 会起不来——属用户显式选择。
	headless := cfg.Headless == "on" ||
		(cfg.Headless != "off" && runtime.GOOS != "darwin" && os.Getenv("DISPLAY") == "")
	if headless { // screencast 在无头下同样可用
		args = append(args, "--headless=new", "--window-size="+cfg.WindowSize)
	} else if cfg.Fullscreen != nil && *cfg.Fullscreen { // 有头：全屏启动，画面铺满宿主屏幕
		args = append(args, "--start-fullscreen")
	}
	args = append(args, "about:blank")
	exe := cfg.Bin
	if exe == "" {
		exe = chromeExecutable()
	}
	cmd := exec.Command(exe, args...)
	// 不继承本进程的 stdout/stderr：避免 Chrome 日志刷屏，也避免持有管道导致父进程读阻塞
	cmd.Stdout = nil
	cmd.Stderr = nil
	// 自成进程组：回收时可整组 kill（含 zygote/gpu/renderer/crashpad 等子进程）
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		e := fmt.Errorf("拉起 Chrome 失败(可执行路径 %s): %w", exe, err)
		setLastErr(e.Error())
		return e
	}
	lastLaunch = time.Now()
	procMu.Lock()
	chrome = cmd
	procMu.Unlock()
	// 收尸 + 退出即清空 chrome：让「chrome != nil」可靠表示「我们拉起的实例仍在运行」，
	// 进程退出后不再被误判为「还在跑」而长期不重拉。
	go func() {
		_ = cmd.Wait()
		procMu.Lock()
		if chrome == cmd {
			chrome = nil
		}
		procMu.Unlock()
	}()
	for i := 0; i < 50; i++ { // 最多等 5s
		if alive() {
			setLastErr("") // 就绪：清掉上次错误
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	// 没就绪：区分「进程已退出」(多半 profile 被占/参数不支持/可执行有问题) 与「还在慢启动」
	procMu.Lock()
	exited := chrome == nil
	procMu.Unlock()
	var e error
	if exited {
		e = fmt.Errorf("Chrome 启动后随即退出（常见：profile %q 被你平时的 Chrome 占用，或可执行路径/参数有误）", cfg.Profile)
	} else {
		e = fmt.Errorf("Chrome 调试端口 %s 未就绪（启动较慢或端口被防火墙拦）", CDPBase)
	}
	setLastErr(e.Error())
	return e
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
