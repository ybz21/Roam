// screencast.go：/api/phone/stream 的 WebSocket 桥。
//
// 复用 browser 那套传输设计：
//   - 二进制帧：[w:u16 LE][h:u16 LE][seq:u16 LE][jpeg...]（与 browser 同格式，前端解码一致）
//   - 信用背压：在途帧上限 window，慢链路自然降帧——这里更简单，采用「按需截屏」：
//     有信用才截一帧（adb screencap），收到 ack 归还信用 → 客户端越慢截得越少，不堆积。
//
// 输入（仅 ?control=1）：前端发 {type:'tap'|'swipe'|'text'|'key'|'ack'|'ping'}，转成 adb 操作。
package phone

import (
	"encoding/binary"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 1 << 16,
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		i := strings.Index(origin, "://")
		return i >= 0 && origin[i+3:] == r.Host
	},
}

func buildFrame(jpeg []byte, w, h int, seq uint16) []byte {
	b := make([]byte, 6+len(jpeg))
	binary.LittleEndian.PutUint16(b[0:], uint16(w))
	binary.LittleEndian.PutUint16(b[2:], uint16(h))
	binary.LittleEndian.PutUint16(b[4:], seq)
	copy(b[6:], jpeg)
	return b
}

func nowMs() int64 { return time.Now().UnixMilli() }

// lvl 是一档自适应参数：JPEG 质量 + 两帧最小间隔(控帧率)。与 browser 对齐（自动/标清/高清/超清）。
// 手机这边只调质量+帧率（不改分辨率，避免每帧 resize 的 CPU）。
type lvl struct {
	q, interval int
	name        string
}

var ladder = []lvl{
	{30, 220, "省流"},
	{45, 150, "流畅"},
	{60, 110, "标清"},
	{78, 90, "高清"},
	{90, 75, "超清"},
}

const autoStart = 2 // 自适应初始档（标清）

func atoiQuery(c *gin.Context, key string, def int) int {
	if v := c.Query(key); v != "" {
		n := 0
		neg := false
		for i, ch := range v {
			if i == 0 && ch == '-' {
				neg = true
				continue
			}
			if ch < '0' || ch > '9' {
				return def
			}
			n = n*10 + int(ch-'0')
		}
		if neg {
			n = -n
		}
		return n
	}
	return def
}

// inMsg 是前端 → 后端的控制消息（鸭子类型，按 type 取用字段）。
type inMsg struct {
	Type string  `json:"type"`
	N    uint16  `json:"n"` // ack 帧号
	T    float64 `json:"t"` // ping 时间戳（回 pong 原样带回）
	X    int     `json:"x"`
	Y    int     `json:"y"`
	X1   int     `json:"x1"`
	Y1   int     `json:"y1"`
	X2   int     `json:"x2"`
	Y2   int     `json:"y2"`
	Ms   int     `json:"ms"`
	Text string  `json:"text"`
	Name string  `json:"name"`
}

// Handler 处理 /api/phone/stream：截屏推流 + 输入转发。
func Handler(c *gin.Context) {
	front, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer front.Close()

	dev := Current()
	if err := dev.Ensure(); err != nil {
		_ = front.WriteJSON(map[string]any{"type": "error", "msg": err.Error()})
		return
	}
	control := c.Query("control") == "1"
	auto := c.Query("auto") == "1"
	manualQ := atoiQuery(c, "q", 50)

	// gorilla 不支持并发写：帧/pong 经此串行
	var wmu sync.Mutex
	writeJSON := func(v any) error {
		wmu.Lock()
		defer wmu.Unlock()
		return front.WriteJSON(v)
	}
	writeBin := func(b []byte) error {
		wmu.Lock()
		defer wmu.Unlock()
		return front.WriteMessage(websocket.BinaryMessage, b)
	}

	const window = 2 // 在途帧上限
	var mu sync.Mutex
	cond := sync.NewCond(&mu)
	credits := window
	closed := false
	// 自适应状态（mu 保护）：level=当前档；ewma=送达耗时滑动平均；sentAt=帧发出时刻。
	level := autoStart
	var ewma float64
	sentAt := map[uint16]int64{}
	shutdown := func() {
		mu.Lock()
		if !closed {
			closed = true
			cond.Broadcast()
		}
		mu.Unlock()
	}
	// curParams 取当前该用的质量与帧间隔：auto 走阶梯，否则用手动 q。
	curParams := func() (int, time.Duration) {
		if auto {
			l := ladder[level]
			return l.q, time.Duration(l.interval) * time.Millisecond
		}
		return manualQ, 90 * time.Millisecond
	}

	// 读循环：ack 归还信用 + 处理输入 + pong
	go func() {
		defer shutdown()
		for {
			var m inMsg
			if err := front.ReadJSON(&m); err != nil {
				return
			}
			switch m.Type {
			case "ack":
				mu.Lock()
				if credits < window {
					credits++
				}
				if t0, ok := sentAt[m.N]; ok { // 送达耗时 → ewma（自适应信号）
					d := float64(nowMs() - t0)
					if ewma == 0 {
						ewma = d
					} else {
						ewma = ewma*0.7 + d*0.3
					}
					delete(sentAt, m.N)
				}
				cond.Signal()
				mu.Unlock()
			case "ping":
				_ = writeJSON(map[string]any{"type": "pong", "t": m.T})
			case "tap":
				if control {
					_ = dev.Tap(m.X, m.Y)
				}
			case "swipe":
				if control {
					_ = dev.Swipe(m.X1, m.Y1, m.X2, m.Y2, m.Ms)
				}
			case "text":
				if control {
					_ = dev.Text(m.Text)
				}
			case "key":
				if control {
					_ = dev.Key(m.Name)
				}
			}
		}
	}()

	// 自适应控制环（仅 auto）：按 ewma 升降档，并把当前档名推给前端显示。
	if auto {
		_ = writeJSON(map[string]any{"type": "level", "name": ladder[level].name})
		go func() {
			t := time.NewTicker(1500 * time.Millisecond)
			defer t.Stop()
			up := 0
			for range t.C {
				mu.Lock()
				if closed {
					mu.Unlock()
					return
				}
				e, lv := ewma, level
				mu.Unlock()
				if e == 0 {
					continue
				}
				next := lv
				switch {
				case e > 350 && lv > 0: // 太慢 → 立刻降档
					next, up = lv-1, 0
				case e < 130 && lv < len(ladder)-1: // 有余量 → 连两次才升档（防抖）
					if up++; up >= 2 {
						next, up = lv+1, 0
					}
				default:
					up = 0
				}
				if next != lv {
					mu.Lock()
					level, ewma = next, 0
					mu.Unlock()
					_ = writeJSON(map[string]any{"type": "level", "name": ladder[next].name})
				}
			}
		}()
	}

	// 截屏推流：有信用才截一帧（按需截屏 = 天然背压）。两帧间留间隔控帧率。
	var seq uint16
	for {
		mu.Lock()
		for credits <= 0 && !closed {
			cond.Wait()
		}
		if closed {
			mu.Unlock()
			return
		}
		credits--
		q, interval := curParams()
		mu.Unlock()

		start := time.Now()
		jpg, w, h, err := dev.CaptureJPEG(q)
		if err != nil {
			// 截图失败（设备掉线等）：还回信用，提示前端，稍候重试
			mu.Lock()
			credits++
			mu.Unlock()
			_ = writeJSON(map[string]any{"type": "error", "msg": err.Error()})
			time.Sleep(500 * time.Millisecond)
			continue
		}
		mu.Lock()
		seq++
		s := seq
		sentAt[s] = nowMs()
		mu.Unlock()
		if writeBin(buildFrame(jpg, w, h, s)) != nil {
			return
		}
		if d := time.Since(start); d < interval {
			time.Sleep(interval - d)
		}
	}
}
