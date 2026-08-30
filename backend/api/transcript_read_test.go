package api

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeLines(t *testing.T, lines ...string) *os.File {
	t.Helper()
	p := filepath.Join(t.TempDir(), "t.jsonl")
	body := ""
	for _, l := range lines {
		body += l + "\n"
	}
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

func texts(ls []transcriptLine) []string {
	out := make([]string, len(ls))
	for i, l := range ls {
		out[i] = string(l.Text)
	}
	return out
}

func TestReadTailTakesTheLastLines(t *testing.T) {
	f := writeLines(t, "a", "b", "c", "d", "e")
	lines, size, more, err := readTail(f, 2)
	if err != nil {
		t.Fatal(err)
	}
	if got := texts(lines); strings.Join(got, ",") != "d,e" {
		t.Fatalf("要最后两行，拿到 %v", got)
	}
	if !more {
		t.Fatal("前面还有 3 行，more 应当为真")
	}
	if size != 10 { // "a\n"…"e\n"
		t.Fatalf("size=%d", size)
	}
}

func TestReadTailShorterThanKeep(t *testing.T) {
	f := writeLines(t, "a", "b")
	lines, _, more, err := readTail(f, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 || more {
		t.Fatalf("整份都要得下，不该说「前面还有」：%v more=%v", texts(lines), more)
	}
}

func TestReadTailCrossesChunkBoundary(t *testing.T) {
	// 每行 ~4KB × 600 行 ≈ 2.4MB，跨过 1MiB 的块边界，逼它多读一块
	big := strings.Repeat("x", 4000)
	lines := make([]string, 600)
	for i := range lines {
		lines[i] = fmt.Sprintf("%d%s", i, big)
	}
	f := writeLines(t, lines...)
	got, _, more, err := readTail(f, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 5 || !more {
		t.Fatalf("要 5 行拿到 %d", len(got))
	}
	if !strings.HasPrefix(string(got[4].Text), "599") {
		t.Fatalf("最后一行不对：%.10s", got[4].Text)
	}
	if !strings.HasPrefix(string(got[0].Text), "595") {
		t.Fatalf("第一行不对：%.10s", got[0].Text)
	}
}

func TestOffsetsPointAtLineStarts(t *testing.T) {
	// 偏移既当续读位置，也当 ID 兜底——首屏和增量两条路必须算出同一个值
	f := writeLines(t, "aa", "bbb", "c")
	tail, size, _, _ := readTail(f, 3)
	inc, _ := readFrom(f, 0, size)
	if len(tail) != len(inc) {
		t.Fatalf("两条路行数不一致 %d vs %d", len(tail), len(inc))
	}
	for i := range tail {
		if tail[i].At != inc[i].At {
			t.Fatalf("第 %d 行偏移不一致：尾读 %d，全读 %d", i, tail[i].At, inc[i].At)
		}
	}
	if tail[0].At != 0 || tail[1].At != 3 || tail[2].At != 7 {
		t.Fatalf("偏移算错：%d %d %d", tail[0].At, tail[1].At, tail[2].At)
	}
}

func TestReadFromResumesAtByteOffset(t *testing.T) {
	f := writeLines(t, "a", "b", "c")
	_, size, _, _ := readTail(f, 3)
	// 从第二行开头续读
	got, err := readFrom(f, 2, size)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(texts(got), ",") != "b,c" {
		t.Fatalf("续读拿到 %v", texts(got))
	}
}

func TestReadFromMidLineSkipsToNextLine(t *testing.T) {
	// 旧前端传来的是**行号**，当字节偏移用会落在半行中间。
	// 那时必须跳到下一个换行，绝不能切出半条 JSON 扔给解析器。
	f := writeLines(t, "aaaa", "bbbb", "cccc")
	got, err := readFrom(f, 2, 15) // 落在第一行中间
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(texts(got), ",") != "bbbb,cccc" {
		t.Fatalf("应当跳过半行，拿到 %v", texts(got))
	}
}

func TestPartialLastLineIsHeldBack(t *testing.T) {
	// agent 正在写：最后一行还没有换行符。解析它只会得到半条 JSON，
	// 所以这一轮不要它，下一轮从它的行首重读。
	p := filepath.Join(t.TempDir(), "t.jsonl")
	os.WriteFile(p, []byte("a\nb\nhalf-writ"), 0o600)
	f, _ := os.Open(p)
	defer f.Close()

	lines, size, _, _ := readTail(f, 10)
	if strings.Join(texts(lines), ",") != "a,b" {
		t.Fatalf("半行不该被吐出来：%v", texts(lines))
	}
	next := lastComplete(lines, size)
	if next != 4 { // "a\nb\n"
		t.Fatalf("续读位置该停在完整行之后，得到 %d", next)
	}
	// 补完那一行之后，下一轮应当完整拿到它
	os.WriteFile(p, []byte("a\nb\nhalf-written\n"), 0o600)
	f2, _ := os.Open(p)
	defer f2.Close()
	st, _ := f2.Stat()
	got, _ := readFrom(f2, next, st.Size())
	if strings.Join(texts(got), ",") != "half-written" {
		t.Fatalf("补完之后该拿到整行，得到 %v", texts(got))
	}
}

func TestEmptyFile(t *testing.T) {
	f := writeLines(t)
	lines, size, more, err := readTail(f, 10)
	if err != nil || len(lines) != 0 || size != 0 || more {
		t.Fatalf("空文件不该报错：%v %d %v %v", texts(lines), size, more, err)
	}
}

func TestReadFromAtEOFReturnsNothing(t *testing.T) {
	// 轮询到没有新内容时的常态：一行不返回，也不该报错
	f := writeLines(t, "a", "b")
	got, err := readFrom(f, 4, 4)
	if err != nil || len(got) != 0 {
		t.Fatalf("没有新行时该空手而归：%v %v", texts(got), err)
	}
}
