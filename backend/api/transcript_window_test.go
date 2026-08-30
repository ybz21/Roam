package api

import (
	"testing"
)

// 尾部滑窗：首屏只要最近 N 条，且要如实说「截过头」——前端据此决定显不显示「加载更早」。
func TestTranscriptWindow(t *testing.T) {
	w := newTranscriptWindow(3)
	for i := 0; i < 10; i++ {
		w.add(cMsg{ID: string(rune('a' + i))})
	}
	msgs, truncated := w.out()
	if len(msgs) != 3 || !truncated {
		t.Fatalf("要留最后 3 条且标记截断，得到 %d 条 truncated=%v", len(msgs), truncated)
	}
	if msgs[0].ID != "h" || msgs[2].ID != "j" {
		t.Errorf("留错了段：%s..%s，要 h..j", msgs[0].ID, msgs[2].ID)
	}
	// 没超上限就不该说自己截过
	w2 := newTranscriptWindow(5)
	w2.add(cMsg{ID: "x"})
	if msgs, truncated := w2.out(); len(msgs) != 1 || truncated {
		t.Errorf("没截却报截断: %d %v", len(msgs), truncated)
	}
	// limit<=0 = 不限（增量轮询那条路，一条都不能丢）
	w3 := newTranscriptWindow(0)
	for i := 0; i < 50; i++ {
		w3.add(cMsg{})
	}
	if msgs, truncated := w3.out(); len(msgs) != 50 || truncated {
		t.Errorf("不限模式不该丢: %d %v", len(msgs), truncated)
	}
	// 空窗口也要回 []（前端按数组用，null 会炸）
	if msgs, _ := newTranscriptWindow(10).out(); msgs == nil {
		t.Error("空窗口要回 []，不能是 nil")
	}
}

// tailLines 已经退役：它扫全文件、每行一次字符串分配，而 offset 是行号，
// 逼着每次轮询从第 1 行重数。改成按字节偏移读之后，尾部读取与续读的用例都在
// transcript_read_test.go 里（含旧实现的一个 bug：末行没写完时，半条 JSON 解析
// 失败不产出消息，而 offset 已经跨过去了——那条消息就永远丢了）。
