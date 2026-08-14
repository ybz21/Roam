package api

import (
	"bufio"
	"strings"
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

// 取尾部：只留最后 keep 行，并如实报出「第一行是第几行」与总行数——
// 行号是前端的稳定 key，错一位就会在增量轮询时和新行撞车。
func TestTailLines(t *testing.T) {
	mk := func(s string) *bufio.Scanner { return bufio.NewScanner(strings.NewReader(s)) }
	lines, first, total := tailLines(mk("a\nb\nc\nd\ne\n"), 2)
	if len(lines) != 2 || lines[0] != "d" || lines[1] != "e" || first != 4 || total != 5 {
		t.Fatalf("尾部取错: %v first=%d total=%d", lines, first, total)
	}
	// 不足 keep 行：全给，且从第 1 行起
	lines, first, total = tailLines(mk("a\nb\n"), 10)
	if len(lines) != 2 || first != 1 || total != 2 {
		t.Errorf("不足 keep 时该全给: %v first=%d total=%d", lines, first, total)
	}
	// 空文件
	if lines, first, total = tailLines(mk(""), 5); len(lines) != 0 || total != 0 || first != 1 {
		t.Errorf("空文件: %v first=%d total=%d", lines, first, total)
	}
	// 末行没有换行符也算一行（转录正被写入时就是这样）
	if _, _, total = tailLines(mk("a\nb"), 5); total != 2 {
		t.Errorf("末行无换行也要算: total=%d", total)
	}
}
