// screencast.go：手机镜像的截屏桥核心 + 传输 sink 抽象。
//
// 完全照 browser 那套（screencast.go/_ws.go/_dc.go）的分层：核心 runPhoneStream 只产帧、
// 做背压调度、处理输入控制，不感知底层是 gorilla WebSocket 还是 WebRTC DataChannel。
//
//   - 二进制帧：[w:u16 LE][h:u16 LE][seq:u16 LE][jpeg...]（与 browser 同格式，前端解码一致）
//   - 背压：由 sink 决定何时可发下一帧——
//     · wsSink（screencast_ws.go）：信用·ack 背压，「按需截屏」= 有信用才截一帧，慢链路
//     自然降帧不堆积。P2P 回退路径，行为逐字节不变。
//     · dcSink（screencast_dc.go）：WebRTC DataChannel（media PC），不可靠·无序通道，背压用
//     dc.BufferedAmount() 丢帧优于阻塞。
//   - 自适应（?auto=1）：以「发出→ack」耗时为信号，太慢降档、有余量升档，调 JPEG 质量+帧率。
//   - 输入（仅 control=1）：前端发 {type:'tap'|'swipe'|'text'|'key'|'ack'|'ping'}，转 adb 操作。
package phone

import (
	"encoding/binary"
	"encoding/json"
	"sync"
	"time"
)

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

func atoiDefault(s string, d int) int {
	if s == "" {
		return d
	}
	n := 0
	neg := false
	for i, ch := range s {
		if i == 0 && ch == '-' {
			neg = true
			continue
		}
		if ch < '0' || ch > '9' {
			return d
		}
		n = n*10 + int(ch-'0')
	}
	if neg {
		n = -n
	}
	return n
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

// scOptions 是一次镜像会话的入参（从 WS query 或 DataChannel label 的 query 解析）。
// 与底层传输无关，故 WS handler 与 DataChannel handler 共用。
type scOptions struct {
	control bool // 是否转发 tap/swipe/text/key 输入（默认只读镜像）
	auto    bool // 自适应码率
	q       int  // 手动模式初始 JPEG 质量（auto 时忽略）
}

// phoneFrameSink 是手机镜像传输层抽象：核心只用它「写帧 / 写控制 / 收控制 / 背压 / 关闭」，
// 不感知底层是 gorilla WebSocket 还是 WebRTC DataChannel。语义与 browser.frameSink 一致。
//
//   - writeBinary(frame)：发一帧（二进制）；出错返回 err → 核心停机。
//   - writeText(v)：发一条控制 JSON（level/pong/error）。
//   - onCtrl(fn)：注册入站控制回调（前端发来的 JSON 文本，逐条喂 fn）。
//   - awaitSlot()：阻塞直到「可以截并发下一帧」——WS 有信用即可，DC 用 BufferedAmount 限流
//     （水位过高就跳过：返回 ok=false，核心本轮不截图不发）。返回的 seq 是本帧序号（帧头用）。
//   - onAck(n)：ack 一帧（归还信用 / 记 deliveryMs 供自适应）。WS/DC 都调，DC 无信用只记时延。
//   - releaseSlot()：核心占了 slot 但本帧未发（截图失败）时归还——WS 归还信用，DC 无操作。
//   - closed()：sink 是否已关闭（读循环退出/对端断）。
//   - close()：主动关闭 sink。
//   - wait()：阻塞直到 sink 关闭，作为 runPhoneStream 的生命周期驱动。
type phoneFrameSink interface {
	writeBinary(b []byte) error
	writeText(v any) error
	onCtrl(fn func([]byte))
	close()
	closed() bool
	wait()

	awaitSlot() (seq uint16, ok bool)
	onAck(n uint16) (deliveryMs float64, matched bool)
	releaseSlot()
}

// runPhoneStream 是手机镜像核心：截屏推流 + 输入转发 + 自适应调档。
// 不感知底层传输（WS/DataChannel）——只调 sink 的 writeBinary/writeText/awaitSlot 等。
// 阻塞直到 sink 关闭。
func runPhoneStream(sink phoneFrameSink, opts scOptions) {
	dev := Current()
	if err := dev.Ensure(); err != nil {
		_ = sink.writeText(map[string]any{"type": "error", "msg": err.Error()})
		return
	}
	control := opts.control
	auto := opts.auto
	manualQ := opts.q
	if manualQ == 0 {
		manualQ = 50
	}

	// 自适应状态（mu 保护）：level=当前档；ewma=送达耗时滑动平均。背压/信用记账在 sink 内。
	var mu sync.Mutex
	level := autoStart
	var ewma float64

	// curParams 取当前该用的质量与帧间隔：auto 走阶梯，否则用手动 q。
	curParams := func() (int, time.Duration) {
		mu.Lock()
		lv := level
		mu.Unlock()
		if auto {
			l := ladder[lv]
			return l.q, time.Duration(l.interval) * time.Millisecond
		}
		return manualQ, 90 * time.Millisecond
	}

	// 入站控制消息处理：ack/ping + control 模式下的 tap/swipe/text/key。
	// WS 由自身读循环喂、DC 由 OnMessage 喂；逻辑同一份。
	handleCtrl := func(data []byte) {
		var m inMsg
		if json.Unmarshal(data, &m) != nil {
			return
		}
		switch m.Type {
		case "ack":
			if d, matched := sink.onAck(m.N); matched {
				mu.Lock()
				if ewma == 0 {
					ewma = d
				} else {
					ewma = ewma*0.7 + d*0.3
				}
				mu.Unlock()
			}
		case "ping":
			_ = sink.writeText(map[string]any{"type": "pong", "t": m.T})
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
	sink.onCtrl(handleCtrl)

	// 自适应控制环（仅 auto）：按 ewma 升降档，并把当前档名推给前端显示。
	if auto {
		_ = sink.writeText(map[string]any{"type": "level", "name": ladder[level].name})
		go func() {
			t := time.NewTicker(1500 * time.Millisecond)
			defer t.Stop()
			up := 0
			for range t.C {
				if sink.closed() {
					return
				}
				mu.Lock()
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
					_ = sink.writeText(map[string]any{"type": "level", "name": ladder[next].name})
				}
			}
		}()
	}

	// 截屏推流：sink.awaitSlot() 决定何时可截并发（WS 有信用 / DC 水位够）。有槽才截一帧
	// （按需截屏 = 天然背压）。两帧间留间隔控帧率。生命周期由此循环驱动（sink 关 → awaitSlot
	// 返回 ok=false 且 closed → 退出）。
	go func() {
		for {
			seq, ok := sink.awaitSlot()
			if sink.closed() {
				return
			}
			if !ok {
				continue // 背压：本轮跳过（DC 水位过高），不截图不发送
			}
			q, interval := curParams()

			start := time.Now()
			jpg, w, h, err := dev.CaptureJPEG(q)
			if err != nil {
				// 截图失败（设备掉线等）：归还 slot，提示前端，稍候重试
				sink.releaseSlot()
				_ = sink.writeText(map[string]any{"type": "error", "msg": err.Error()})
				time.Sleep(500 * time.Millisecond)
				continue
			}
			if sink.writeBinary(buildFrame(jpg, w, h, seq)) != nil {
				sink.close()
				return
			}
			if d := time.Since(start); d < interval {
				time.Sleep(interval - d)
			}
		}
	}()

	// 生命周期：阻塞到 sink 关闭（WS 读循环退出 / DC 关闭）。
	sink.wait()
}
