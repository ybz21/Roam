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
	quality := atoiQuery(c, "q", 50)

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
	shutdown := func() {
		mu.Lock()
		if !closed {
			closed = true
			cond.Broadcast()
		}
		mu.Unlock()
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

	// 截屏推流：有信用才截一帧（按需截屏 = 天然背压）。两帧间留最小间隔，避免空跑刷 adb。
	const minInterval = 90 * time.Millisecond
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
		mu.Unlock()

		start := time.Now()
		jpg, w, h, err := dev.CaptureJPEG(quality)
		if err != nil {
			// 截图失败（设备掉线等）：还回信用，提示前端，稍候重试
			mu.Lock()
			credits++
			mu.Unlock()
			_ = writeJSON(map[string]any{"type": "error", "msg": err.Error()})
			time.Sleep(500 * time.Millisecond)
			continue
		}
		seq++
		if writeBin(buildFrame(jpg, w, h, seq)) != nil {
			return
		}
		if d := time.Since(start); d < minInterval {
			time.Sleep(minInterval - d)
		}
	}
}
