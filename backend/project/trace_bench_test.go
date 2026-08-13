package project

import (
	"fmt"
	"testing"
)

// 留痕长到轮转阈值时读最近 50 条。
//
// 改成尾部回读之前是整文件解析：同一份数据上 35.9ms → 0.10ms（约 350 倍），
// 而项目活动页每打开一次就付一遍。这条基准留着，免得哪天又被改回全量读。
func BenchmarkReadTraceLargeLog(b *testing.B) {
	dir := b.TempDir()
	s := NewStore(dir, nil)
	for i := 0; i < 20000; i++ {
		s.Trace(TraceEntry{Repo: "/repo/a", Branch: fmt.Sprintf("feat/branch-name-%d", i), Action: "merged"})
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if got := s.ReadTrace("/repo/a", 50); len(got) != 50 {
			b.Fatalf("got %d", len(got))
		}
	}
}
