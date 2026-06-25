// screencast.go：/api/browser/stream 的 WebSocket 桥。
//
// 传输优化（针对 frp / 低带宽场景）：
//
//   - 二进制帧：JPEG 字节直接走 WS binary（省掉 base64 的 33% 膨胀 + 两端编解码）
//     帧格式 = [w:u16 LE][h:u16 LE][seq:u16 LE][jpeg...]
//
//   - 信用背压：服务端只保留「最新一帧」，慢链路时丢弃中间帧；客户端每显示一帧回
//     {type:'ack',n:seq} 归还信用，服务端凭信用发下一帧 → 端到端在途帧被限在 window 内，
//     杜绝旧帧在内核/frp 缓冲里排队回放（"越点越卡"的根因）。
//
//   - 自适应码率（?auto=1）：以「发出→收到 ack」的耗时(deliveryMs)为信号，太慢降档、
//     有余量升档，动态调 JPEG 质量 / 分辨率(maxWidth/Height) / everyNthFrame。
//
//     CDP  → 前端：Page.startScreencast 的 JPEG 帧（二进制）
//     前端 → CDP：鼠标/键盘/滚轮/导航（仅 ?control=1 时转发输入；默认只读镜像）
package browser

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 1 << 16,
	// 同源校验：抄 pty/stream 那套（Origin host 必须等于请求 Host）
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		i := strings.Index(origin, "://")
		return i >= 0 && origin[i+3:] == r.Host
	},
}

// browserClip 是「浏览器内部剪贴板」：Ctrl+C 存远端当前选区，Ctrl+V 在前端读不到本机剪贴板
// （无权限/非安全上下文）时用它兜底 insertText。全局共享 → A 标签复制、B 标签粘贴也通。
var browserClip struct {
	mu   sync.Mutex
	text string
}

// cdp 是到单个 page 目标的 CDP 连接；WriteJSON 非并发安全，故加锁串行写。
type cdp struct {
	ws *websocket.Conn
	mu sync.Mutex
	id int
}

func (c *cdp) send(method string, params map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.id++
	_ = c.ws.WriteJSON(map[string]any{"id": c.id, "method": method, "params": params})
}

// sendID 同 send，但返回本次请求的 CDP id，用于在响应读取循环里匹配回包（复制选区取返回值）。
func (c *cdp) sendID(method string, params map[string]any) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.id++
	id := c.id
	_ = c.ws.WriteJSON(map[string]any{"id": id, "method": method, "params": params})
	return id
}

func fail(front *websocket.Conn, msg string) {
	_ = front.WriteJSON(map[string]any{"type": "error", "msg": msg})
}

func atoiDefault(s string, d int) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return d
}

func atofDefault(s string, d float64) float64 {
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return f
	}
	return d
}

// lvl 是一档画质/分辨率/帧率组合；自适应在 ladder 上上下移动。
type lvl struct {
	q, w, h, nth int
	name         string
}

// 自适应档位阶梯：从省流到超清。低档降分辨率/降质/抽帧，保「跟手」；高档保清晰。
var ladder = []lvl{
	{28, 960, 600, 2, "省流"},
	{40, 1280, 800, 2, "流畅"},
	{52, 1280, 800, 1, "标清"},
	{64, 1600, 1000, 1, "清晰"},
	{76, 1920, 1200, 1, "高清"},
	{86, 2560, 1600, 1, "超清"},
}

const autoStart = 2 // 自适应初始档（标清，快速起步再按链路上探）

// keyInfo 把 DOM KeyboardEvent.key 映射到 CDP 需要的 (code, windowsVirtualKeyCode, text)。
// 只覆盖非可打印的常用键；可打印字符走 Input.insertText，不经过这里。
func keyInfo(key string) (code string, vk int, text string) {
	switch key {
	case "Enter":
		return "Enter", 13, "\r"
	case "Tab":
		return "Tab", 9, "\t"
	case "Backspace":
		return "Backspace", 8, ""
	case "Delete":
		return "Delete", 46, ""
	case "Escape":
		return "Escape", 27, ""
	case "ArrowLeft":
		return "ArrowLeft", 37, ""
	case "ArrowUp":
		return "ArrowUp", 38, ""
	case "ArrowRight":
		return "ArrowRight", 39, ""
	case "ArrowDown":
		return "ArrowDown", 40, ""
	case "Home":
		return "Home", 36, ""
	case "End":
		return "End", 35, ""
	case "PageUp":
		return "PageUp", 33, ""
	case "PageDown":
		return "PageDown", 34, ""
	}
	return "", 0, ""
}

// buildFrame 打包一帧为二进制：[w][h][seq] 各 2 字节小端 + JPEG 原始字节。
func buildFrame(jpeg []byte, w, h int, seq uint16) []byte {
	b := make([]byte, 6+len(jpeg))
	binary.LittleEndian.PutUint16(b[0:], uint16(w))
	binary.LittleEndian.PutUint16(b[2:], uint16(h))
	binary.LittleEndian.PutUint16(b[4:], seq)
	copy(b[6:], jpeg)
	return b
}

func nowMs() int64 { return time.Now().UnixMilli() }

// Handler 处理 /api/browser/stream 的 WebSocket 升级与 CDP 桥接。
func Handler(c *gin.Context) {
	front, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer front.Close()

	if err := ensureChrome(); err != nil {
		fail(front, err.Error())
		return
	}
	wsURL, err := targetWS(c.Query("target")) // 空 = 第一个标签页
	if err != nil {
		fail(front, err.Error())
		return
	}
	back, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		fail(front, "连接 Chrome 失败: "+err.Error())
		return
	}
	defer back.Close()
	conn := &cdp{ws: back}
	control := c.Query("control") == "1"
	auto := c.Query("auto") == "1"
	defaultUA := browserUA() // 浏览器原生 UA，切回桌面时用它复位（CDP 没有 clearUserAgentOverride）

	// gorilla 不支持并发写同一连接：帧/控制/pong 都经此串行化
	var fmu sync.Mutex
	writeJSON := func(v any) error {
		fmu.Lock()
		defer fmu.Unlock()
		return front.WriteJSON(v)
	}
	writeBin := func(b []byte) error {
		fmu.Lock()
		defer fmu.Unlock()
		return front.WriteMessage(websocket.BinaryMessage, b)
	}

	// ── 信用背压 + 自适应共享状态 ──
	const window = 2 // 在途帧上限（兼顾隐藏 RTT 与不堆积）
	var mu sync.Mutex
	cond := sync.NewCond(&mu)
	type pend struct {
		b64  string
		w, h int
	}
	var (
		pending   *pend                // 最新一帧（未发出的），新帧覆盖旧帧 = latest-only 丢帧
		credits   = window             // 可发帧的信用，发一帧 -1，收到 ack +1
		seq       uint16               // 帧序号（与 ack 对应）
		sentAt    = map[uint16]int64{} // seq → 发出时刻，用于算 deliveryMs
		ewma      float64              // deliveryMs 的指数滑动平均（自适应控制信号）
		level     = autoStart          // 当前档位（仅 auto 模式移动）
		closed    bool
		copyReqID int // 复制选区的 Runtime.evaluate 请求 id；读取循环据此匹配回包(0=无在途)
	)

	// 初始档：auto 用阶梯，手动用前端给的 q（分辨率给足，质量听用户）
	cur := ladder[autoStart]
	if !auto {
		q := atoiDefault(c.Query("q"), 80)
		if q < 10 {
			q = 10
		} else if q > 100 {
			q = 100
		}
		cur = lvl{q: q, w: 2560, h: 1600, nth: 1, name: "手动"}
	}
	applyLevel := func(l lvl) {
		conn.send("Page.startScreencast", map[string]any{
			"format": "jpeg", "quality": l.q,
			"maxWidth": l.w, "maxHeight": l.h, "everyNthFrame": l.nth,
		})
	}
	conn.send("Page.enable", nil)

	// 手机模式：把本镜像连接对应的渲染器切到移动视口（设备指标/触摸/UA 覆盖作用于整个
	// page 渲染，故镜像里看到的就是真实移动端布局，agent 用 chrome-cli 截同一页也是移动端）。
	//
	// 关键设计：设备切换【不重连】，由前端在本条 WS 上发 {type:'emulate'} 消息现场切换。
	// 因为 CDP 的 setDeviceMetricsOverride 是「会话级」——clearDeviceMetricsOverride 只能撤销
	// 【本会话】设的覆盖，撤不掉别会话留的。若每次切换都重连，旧会话的 defer 清理与新连接会
	// 抢跑（来回切尤其容易卡住）。改成同一会话 set/clear，既不泄漏也无竞态。
	applyMobile := func(mw, mh int, dpr float64, ua string) {
		conn.send("Emulation.setDeviceMetricsOverride", map[string]any{
			"width": mw, "height": mh, "deviceScaleFactor": dpr, "mobile": true,
			"screenWidth": mw, "screenHeight": mh,
		})
		conn.send("Emulation.setTouchEmulationEnabled", map[string]any{"enabled": true, "maxTouchPoints": 5})
		conn.send("Emulation.setEmitTouchEventsForMouse", map[string]any{"enabled": true, "configuration": "mobile"})
		if ua != "" { // 设备 UA 由前端按机型下发，后端只透传
			conn.send("Emulation.setUserAgentOverride", map[string]any{"userAgent": ua})
		}
	}
	// 桌面模式：用观看端的原生尺寸（前端下发的 CSS 宽高 + 真实 DPR）覆盖视口，使镜像里的
	// 桌面布局与你屏幕一致、随窗口大小自适应——不再被 Chrome 启动时的 --window-size(1280×800) 限死。
	// w<=0 时退化为 clearMobile（彻底不覆盖，用 Chrome 原生窗口尺寸）。
	applyDesktop := func(w, h int, dpr float64) {
		if w <= 0 || h <= 0 {
			conn.send("Emulation.clearDeviceMetricsOverride", nil)
		} else {
			conn.send("Emulation.setDeviceMetricsOverride", map[string]any{
				"width": w, "height": h, "deviceScaleFactor": dpr, "mobile": false,
				"screenWidth": w, "screenHeight": h,
			})
		}
		conn.send("Emulation.setTouchEmulationEnabled", map[string]any{"enabled": false})
		conn.send("Emulation.setEmitTouchEventsForMouse", map[string]any{"enabled": false})
		if defaultUA != "" { // 复位 UA，否则从手机切回桌面 navigator.userAgent 还卡在手机 UA
			conn.send("Emulation.setUserAgentOverride", map[string]any{"userAgent": defaultUA})
		}
	}
	clearAll := func() {
		conn.send("Emulation.clearDeviceMetricsOverride", nil)
		conn.send("Emulation.setTouchEmulationEnabled", map[string]any{"enabled": false})
		conn.send("Emulation.setEmitTouchEventsForMouse", map[string]any{"enabled": false})
		if defaultUA != "" {
			conn.send("Emulation.setUserAgentOverride", map[string]any{"userAgent": defaultUA})
		}
	}
	overrideOn := false // 本会话当前是否设了任何视口覆盖；仅在主消息 goroutine 与其后的 defer 读写
	// prevMobile/prevUA 记当前生效的「机型态」，用于判断 emulate 是否真切换了设备/UA → 需要
	// reload 页面让 UA 嗅探的站点改出移动版（仅尺寸变化即桌面 resize 不 reload，避免刷屏）。
	prevMobile, prevUA := false, ""
	if c.Query("mobile") == "1" { // 初始态兜底（一般由前端连上后发 emulate 决定）
		applyMobile(atoiDefault(c.Query("mw"), 390), atoiDefault(c.Query("mh"), 844), atofDefault(c.Query("dpr"), 3), c.Query("ua"))
		overrideOn = true
		prevMobile, prevUA = true, c.Query("ua")
	}
	// 断开前清掉本会话覆盖（在 back.Close 之前，conn 仍可写）→ 不泄漏给后续镜像 / chrome-cli / DevTools。
	defer func() {
		if overrideOn {
			clearAll()
		}
	}()
	applyLevel(cur)

	shutdown := func() {
		mu.Lock()
		closed = true
		cond.Broadcast()
		mu.Unlock()
	}

	// CDP → 服务端：收帧即 ack Chrome（保持产帧、画面最新），最新帧塞进单槽（丢旧帧）
	go func() {
		defer shutdown()
		for {
			_, data, err := back.ReadMessage()
			if err != nil {
				return
			}
			var msg struct {
				ID     int    `json:"id"`
				Method string `json:"method"`
				Params struct {
					Data      string `json:"data"`
					SessionID int    `json:"sessionId"`
					Metadata  struct {
						DeviceWidth  float64 `json:"deviceWidth"`
						DeviceHeight float64 `json:"deviceHeight"`
					} `json:"metadata"`
				} `json:"params"`
				Result struct {
					Result struct {
						Value string `json:"value"`
					} `json:"result"`
				} `json:"result"`
			}
			if json.Unmarshal(data, &msg) != nil {
				continue
			}
			if msg.Method != "Page.screencastFrame" {
				// 被镜像页打开新窗口/标签（target=_blank、window.open、表单提交等）→ 通知前端跟过去
				if msg.Method == "Page.windowOpen" {
					_ = writeJSON(map[string]any{"type": "newtab"})
					continue
				}
				// 非帧消息：可能是「复制选区」的 Runtime.evaluate 回包，按 id 匹配后转发给前端
				if msg.ID != 0 {
					mu.Lock()
					hit := copyReqID != 0 && msg.ID == copyReqID
					if hit {
						copyReqID = 0
					}
					mu.Unlock()
					if hit {
						txt := msg.Result.Result.Value
						browserClip.mu.Lock() // 存进浏览器内部剪贴板，供 Ctrl+V 兜底（不依赖本机剪贴板）
						browserClip.text = txt
						browserClip.mu.Unlock()
						_ = writeJSON(map[string]any{"type": "copied", "text": txt})
					}
				}
				continue
			}
			conn.send("Page.screencastFrameAck", map[string]any{"sessionId": msg.Params.SessionID})
			mu.Lock()
			pending = &pend{b64: msg.Params.Data, w: int(msg.Params.Metadata.DeviceWidth), h: int(msg.Params.Metadata.DeviceHeight)}
			cond.Signal()
			mu.Unlock()
		}
	}()

	// 服务端 → 前端：有信用且有帧才发；解码放到发送时刻（被丢弃的帧不白解）
	go func() {
		for {
			mu.Lock()
			for (pending == nil || credits <= 0) && !closed {
				cond.Wait()
			}
			if closed {
				mu.Unlock()
				return
			}
			p := pending
			pending = nil
			mu.Unlock()

			raw, derr := base64.StdEncoding.DecodeString(p.b64)
			if derr != nil {
				continue // 解码失败：未占用信用，跳过
			}
			mu.Lock()
			credits--
			seq++
			s := seq
			sentAt[s] = nowMs()
			mu.Unlock()

			if writeBin(buildFrame(raw, p.w, p.h, s)) != nil {
				shutdown()
				return
			}
		}
	}()

	// 自适应控制环：按 deliveryMs 升降档（仅 auto）
	if auto {
		go func() {
			t := time.NewTicker(1500 * time.Millisecond)
			defer t.Stop()
			up := 0
			for {
				<-t.C
				mu.Lock()
				if closed {
					mu.Unlock()
					return
				}
				e := ewma
				lv := level
				mu.Unlock()
				if e == 0 {
					continue // 还没有测量样本
				}
				next := lv
				switch {
				case e > 350 && lv > 0: // 帧到达太慢 → 立刻降档保跟手
					next = lv - 1
					up = 0
				case e < 130 && lv < len(ladder)-1: // 有余量 → 连续两次才升档（防抖）
					up++
					if up >= 2 {
						next = lv + 1
						up = 0
					}
				default:
					up = 0
				}
				if next != lv {
					mu.Lock()
					level = next
					ewma = 0 // 换档后重新测量
					mu.Unlock()
					applyLevel(ladder[next])
					_ = writeJSON(map[string]any{"type": "level", "q": ladder[next].q, "name": ladder[next].name})
				}
			}
		}()
	} else {
		_ = writeJSON(map[string]any{"type": "level", "q": cur.q, "name": cur.name})
	}

	// 前端 → CDP：导航任何模式都允许；鼠标/键盘仅 control 模式转发
	defer shutdown()
	for {
		_, data, err := front.ReadMessage()
		if err != nil {
			return
		}
		var ev struct {
			Type      string  `json:"type"`
			Sub       string  `json:"sub"`
			X         float64 `json:"x"`
			Y         float64 `json:"y"`
			Button    string  `json:"button"`
			Buttons   int     `json:"buttons"` // 当前按下的鼠标键位掩码(1=左)，move 带上才算拖动
			X1        float64 `json:"x1"`      // select：拖动起点（页面 CSS 坐标）
			Y1        float64 `json:"y1"`
			X2        float64 `json:"x2"` // select：拖动当前点/终点
			Y2        float64 `json:"y2"`
			DeltaX    float64 `json:"deltaX"`
			DeltaY    float64 `json:"deltaY"`
			Key       string  `json:"key"`
			Text      string  `json:"text"`
			Modifiers int     `json:"modifiers"`
			URL       string  `json:"url"`
			T         float64 `json:"t"`
			N         uint16  `json:"n"`      // ack 的帧序号
			Mobile    bool    `json:"mobile"` // emulate：true=手机模式
			MW        int     `json:"mw"`     // 移动视口宽（CSS px）
			MH        int     `json:"mh"`     // 移动视口高
			DPR       float64 `json:"dpr"`    // 设备像素比
			UA        string  `json:"ua"`     // 移动 UA
		}
		if json.Unmarshal(data, &ev) != nil {
			continue
		}
		switch ev.Type {
		case "ping": // 测延迟：原样回带客户端时间戳
			writeJSON(map[string]any{"type": "pong", "t": ev.T})
			continue
		case "ack": // 归还信用 + 记 deliveryMs
			mu.Lock()
			if ts, ok := sentAt[ev.N]; ok {
				d := float64(nowMs() - ts)
				delete(sentAt, ev.N)
				if ewma == 0 {
					ewma = d
				} else {
					ewma = ewma*0.7 + d*0.3
				}
			}
			if credits < window {
				credits++
			}
			cond.Signal()
			mu.Unlock()
			continue
		case "nav":
			if ev.URL != "" {
				conn.send("Page.navigate", map[string]any{"url": ev.URL})
			}
			continue
		case "emulate": // 设备切换：同一会话现场 set/clear，不重连 → 无泄漏/无竞态
			// 机型/UA 真变了才 reload（让 UA 嗅探站点切移动/桌面版）；纯尺寸变化(桌面 resize)不 reload
			needReload := ev.Mobile != prevMobile || ev.UA != prevUA
			if ev.Mobile {
				mw, mh, dpr := ev.MW, ev.MH, ev.DPR
				if mw == 0 {
					mw = 390
				}
				if mh == 0 {
					mh = 844
				}
				if dpr == 0 {
					dpr = 3
				}
				applyMobile(mw, mh, dpr, ev.UA)
				overrideOn = true
			} else { // 桌面：按观看端原生尺寸覆盖视口（mw/mh<=0 则彻底清除覆盖）
				dpr := ev.DPR
				if dpr == 0 {
					dpr = 1
				}
				applyDesktop(ev.MW, ev.MH, dpr)
				overrideOn = ev.MW > 0 && ev.MH > 0
			}
			prevMobile, prevUA = ev.Mobile, ev.UA
			if needReload { // UA 已先于此设好，reload 的首个请求即带新 UA → 服务端出对应版本
				conn.send("Page.reload", nil)
			}
			continue
		}
		if !control {
			continue
		}
		switch ev.Type {
		case "paste": // 把文本写进远端当前焦点元素（比模拟按键更可靠）
			text := ev.Text
			if text == "" { // 前端没带本机剪贴板文本（读不到/无权限）→ 用浏览器内部剪贴板兜底（内部 Ctrl+C 存的）
				browserClip.mu.Lock()
				text = browserClip.text
				browserClip.mu.Unlock()
			}
			if text != "" {
				conn.send("Input.insertText", map[string]any{"text": text})
			}
			continue
		case "copy": // 浏览器 → 本地：取远端页面当前选区文本，回包后前端写进本机剪贴板
			id := conn.sendID("Runtime.evaluate", map[string]any{
				// 取页面当前选区：① window 选区(选正文，最常见) ② 焦点 input/textarea 选区
				// ③ 兜底扫描所有 input/textarea——表单控件选区不进 window.getSelection，且失焦后
				//    selectionStart/End 仍留在元素上，故按元素扫描比依赖 activeElement 当前聚焦更稳。
				"expression": `(function(){var s=window.getSelection().toString();if(s)return s;` +
					`function pick(a){return a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA')&&a.selectionStart!=null&&a.selectionEnd>a.selectionStart?a.value.substring(a.selectionStart,a.selectionEnd):'';}` +
					`var r=pick(document.activeElement);if(r)return r;` +
					`var els=document.querySelectorAll('input,textarea');` +
					`for(var i=0;i<els.length;i++){r=pick(els[i]);if(r)return r;}return '';})()`,
				"returnByValue": true,
			})
			mu.Lock()
			copyReqID = id
			mu.Unlock()
			continue
		case "mouse":
			t := map[string]string{"down": "mousePressed", "up": "mouseReleased", "move": "mouseMoved"}[ev.Sub]
			if t == "" {
				continue
			}
			p := map[string]any{"type": t, "x": ev.X, "y": ev.Y, "modifiers": ev.Modifiers}
			if ev.Sub != "move" {
				btn := ev.Button
				if btn == "" {
					btn = "left"
				}
				p["button"] = btn
				p["buttons"] = 1
				p["clickCount"] = 1
			} else {
				// 移动时带住按下的键位（1=左键），否则 Chrome 当成悬停 → 拖滑块/画布/拖拽都失效
				p["buttons"] = ev.Buttons
			}
			conn.send("Input.dispatchMouseEvent", p)
		case "select": // 拖动框选：headless 下合成鼠标拖选无效，改用 caretRangeFromPoint 按起止坐标在远端建 Range
			conn.send("Runtime.evaluate", map[string]any{
				"expression": fmt.Sprintf(`(function(x1,y1,x2,y2){var s=window.getSelection();s.removeAllRanges();`+
					`var a=document.caretRangeFromPoint(x1,y1),b=document.caretRangeFromPoint(x2,y2);if(!a||!b)return;`+
					`var r=document.createRange();r.setStart(a.startContainer,a.startOffset);r.setEnd(b.startContainer,b.startOffset);`+
					`if(r.collapsed){r.setStart(b.startContainer,b.startOffset);r.setEnd(a.startContainer,a.startOffset);}`+
					`s.addRange(r);})(%g,%g,%g,%g)`, ev.X1, ev.Y1, ev.X2, ev.Y2),
			})
		case "wheel":
			conn.send("Input.dispatchMouseEvent", map[string]any{
				"type": "mouseWheel", "x": ev.X, "y": ev.Y,
				"deltaX": ev.DeltaX, "deltaY": ev.DeltaY, "modifiers": ev.Modifiers,
			})
		case "key":
			// 可打印字符直接 insertText（最可靠，能写进输入框/contenteditable）
			if ev.Sub == "char" {
				if ev.Text != "" {
					conn.send("Input.insertText", map[string]any{"text": ev.Text})
				}
				continue
			}
			// 特殊键（回车/退格/方向键/带修饰键的组合）走 dispatchKeyEvent + 虚拟键码
			typ := "keyDown"
			if ev.Sub == "up" {
				typ = "keyUp"
			}
			code, vk, text := keyInfo(ev.Key)
			p := map[string]any{
				"type": typ, "key": ev.Key, "code": code,
				"windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk,
				"modifiers": ev.Modifiers,
			}
			if text != "" {
				p["text"] = text
			}
			conn.send("Input.dispatchKeyEvent", p)
		}
	}
}
