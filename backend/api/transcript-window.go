package api

// transcript-window.go：转录首屏的尾部滑窗。
//
// 一卷转录能长到几万条（本机最大的 JSONL 已经 155MB），而对话界面开屏只渲染最近一屏。
// 把整卷搬过去纯属白搬：实测一个 3542 条的会话首屏要传 3MB、等 4.6s，其中 94% 的消息
// 前端拿到就扔。tail=N 让首屏只带最近 N 条，增量轮询照旧按 offset 走（那时一条都不能丢）。

import (
	"bufio"
	"strconv"

	"github.com/gin-gonic/gin"
)

const maxTranscriptTail = 2000

// tailLimit 读 ?tail=N：只在首屏(offset=0)生效，增量轮询必须原样返回新行。
func tailLimit(c *gin.Context, offset int) int {
	if offset != 0 {
		return 0
	}
	n, err := strconv.Atoi(c.Query("tail"))
	if err != nil || n <= 0 {
		return 0
	}
	if n > maxTranscriptTail {
		return maxTranscriptTail
	}
	return n
}

// transcriptWindow 累积消息但只留最后 limit 条；limit<=0 表示不限。
type transcriptWindow struct {
	limit   int
	msgs    []cMsg
	dropped bool // 真丢过东西：前端据此显示「加载更早」
}

func newTranscriptWindow(limit int) *transcriptWindow {
	return &transcriptWindow{limit: limit, msgs: []cMsg{}}
}

func (w *transcriptWindow) add(m cMsg) {
	w.msgs = append(w.msgs, m)
	if w.limit <= 0 || len(w.msgs) <= 2*w.limit {
		return
	}
	// 攒到两倍再压一次：每加一条就重切，底层数组会一直跟着最长的那次不放。
	w.msgs = append(w.msgs[:0], w.msgs[len(w.msgs)-w.limit:]...)
	w.dropped = true
}

// out 返回要发出去的消息与「是否截过头」。
func (w *transcriptWindow) out() ([]cMsg, bool) {
	if w.limit > 0 && len(w.msgs) > w.limit {
		return w.msgs[len(w.msgs)-w.limit:], true
	}
	return w.msgs, w.dropped
}

// 一条消息通常不止一行（thinking / tool_result 之类的行不产出消息），
// 所以按行取尾时多带几倍，尽量凑够要的条数。
const tailLineFactor = 4

// tailLines 扫完整份转录，但只留最后 keep 行原文，不解析 JSON。
// 首屏那几秒的大头是「整卷 JSON 解析」而不是传输：一个 7185 行的会话，
// 全量解析 3.4s、传 3MB，而前端只渲染最后一屏。这里把解析量压到尾部那几百行。
// 返回：尾部行、其中第一行的行号(1-based)、文件总行数。
func tailLines(sc *bufio.Scanner, keep int) (lines []string, firstLine int, total int) {
	if keep <= 0 {
		return nil, 0, 0
	}
	ring := make([]string, keep)
	for sc.Scan() {
		ring[total%keep] = sc.Text()
		total++
	}
	n := keep
	if total < keep {
		n = total
	}
	out := make([]string, 0, n)
	start := total - n
	for i := start; i < total; i++ {
		out = append(out, ring[i%keep])
	}
	return out, start + 1, total
}
