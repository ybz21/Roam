// screencast_ws.go：手机镜像传输的 gorilla WebSocket sink（/api/phone/stream）。
//
// 这是 P2P 之前的原路径，也是 media PC 建不起来时的回退路径——行为与 P2P 化之前完全一致：
//
//   - 信用背压 window=2：有信用才截一帧（按需截屏），客户端每显示一帧回 {type:'ack',n:seq}
//     归还信用 → 慢链路自然降帧不堆积。
//   - deliveryMs（发出→ack 耗时）作为自适应码率的控制信号，喂回核心的 ewma。
package phone

import (
	"net/http"
	"strings"
	"sync"

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

// wsWindow 是在途帧上限（与原实现一致）。
const wsWindow = 2

// wsSink 用一条 gorilla WebSocket 承载帧与控制，实现 phoneFrameSink。
type wsSink struct {
	conn *websocket.Conn

	wmu sync.Mutex // gorilla 写非并发安全：帧/控制/pong 串行

	mu      sync.Mutex
	cond    *sync.Cond
	credits int              // 可发帧的信用，占一帧 -1，收到 ack +1
	seq     uint16           // 帧序号（与 ack 对应）
	sentAt  map[uint16]int64 // seq → 发出时刻，用于算 deliveryMs
	isClose bool

	ctrl     func([]byte)
	ctrlOnce sync.Once
	ctrlSet  chan struct{} // 关闭后读循环开始喂消息（onCtrl 注册或 close 触发，均只关一次）
	done     chan struct{} // 读循环退出后关闭 → wait() 返回
}

func newWSSink(conn *websocket.Conn) *wsSink {
	s := &wsSink{
		conn:    conn,
		credits: wsWindow,
		sentAt:  map[uint16]int64{},
		ctrlSet: make(chan struct{}),
		done:    make(chan struct{}),
	}
	s.cond = sync.NewCond(&s.mu)
	return s
}

func (s *wsSink) writeBinary(b []byte) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	return s.conn.WriteMessage(websocket.BinaryMessage, b)
}

func (s *wsSink) writeText(v any) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	return s.conn.WriteJSON(v)
}

func (s *wsSink) onCtrl(fn func([]byte)) {
	s.ctrl = fn
	s.ctrlOnce.Do(func() { close(s.ctrlSet) })
}

func (s *wsSink) closed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.isClose
}

func (s *wsSink) close() {
	s.mu.Lock()
	if s.isClose {
		s.mu.Unlock()
		return
	}
	s.isClose = true
	s.cond.Broadcast()
	s.mu.Unlock()
	// 解锁读循环：核心可能在注册 ctrl 前就早退（Ensure 失败），此时 ctrlSet 尚未关闭，
	// 读循环会一直阻塞在 <-ctrlSet；这里补关一次，令其继续并从已关闭的 conn 读到错误后退出。
	s.ctrlOnce.Do(func() { close(s.ctrlSet) })
	_ = s.conn.Close()
}

func (s *wsSink) wait() { <-s.done }

// awaitSlot 阻塞到有信用可截并发下一帧，占用一份信用并分配 seq、记录发出时刻。
// closed 时返回 (0,false)。WS 无「丢帧跳过」语义（背压靠信用等待），故 ok 恒 true（除非关闭）。
func (s *wsSink) awaitSlot() (uint16, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for s.credits <= 0 && !s.isClose {
		s.cond.Wait()
	}
	if s.isClose {
		return 0, false
	}
	s.credits--
	s.seq++
	seq := s.seq
	s.sentAt[seq] = nowMs()
	return seq, true
}

// releaseSlot 归还一份信用（核心占了 slot 但本帧未发，如截图失败）。同时撤销该 seq 的发出记账。
func (s *wsSink) releaseSlot() {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sentAt, s.seq)
	if s.credits < wsWindow {
		s.credits++
	}
	s.cond.Signal()
}

// onAck 归还一份信用并返回该帧的 deliveryMs（发出→ack 耗时）。
func (s *wsSink) onAck(n uint16) (float64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var d float64
	matched := false
	if ts, ok := s.sentAt[n]; ok {
		d = float64(nowMs() - ts)
		delete(s.sentAt, n)
		matched = true
	}
	if s.credits < wsWindow {
		s.credits++
	}
	s.cond.Signal()
	return d, matched
}

// Handler 处理 /api/phone/stream 的 WebSocket 升级并驱动手机镜像核心（回退路径）。
func Handler(c *gin.Context) {
	front, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}

	sink := newWSSink(front)
	opts := scOptions{
		control: c.Query("control") == "1",
		auto:    c.Query("auto") == "1",
		q:       atoiDefault(c.Query("q"), 50),
	}

	// 读循环：把前端控制消息喂给核心；读错误 = 断开 → close sink（核心随之停机）。
	go func() {
		defer close(sink.done)
		<-sink.ctrlSet // 等核心注册好 ctrl 回调
		for {
			_, data, err := front.ReadMessage()
			if err != nil {
				sink.close()
				return
			}
			if sink.ctrl != nil {
				sink.ctrl(data)
			}
		}
	}()

	runPhoneStream(sink, opts)
	sink.close() // 兜底：核心早退（Ensure 失败，未注册 ctrl）也关连接，避免读循环泄漏
}
