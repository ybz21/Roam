package api

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPickTranscript(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "11111111-1111-1111-1111-111111111111.jsonl")
	if err := os.WriteFile(old, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Hour)
	_ = os.Chtimes(old, past, past)
	start := time.Now().Add(-10 * time.Minute)

	// 新开的 claude：目录里只有上一段的旧文件 → 不认，等它自己写
	if got := pickTranscript(dir, []string{"node", "claude"}, start); got != "" {
		t.Fatalf("新开不该认旧文件: %q", got)
	}
	// --continue：就要最新那份
	if got := pickTranscript(dir, []string{"claude", "--continue"}, start); got != old {
		t.Fatalf("--continue 该取最新: %q", got)
	}
	// --resume <id>：指名道姓
	if got := pickTranscript(dir, []string{"claude", "--resume", "11111111-1111-1111-1111-111111111111"}, start); got != old {
		t.Fatalf("--resume 该取指定那份: %q", got)
	}
	// 新开之后它自己写了文件 → 认这一份
	fresh := filepath.Join(dir, "22222222-2222-2222-2222-222222222222.jsonl")
	if err := os.WriteFile(fresh, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := pickTranscript(dir, []string{"node", "claude"}, start); got != fresh {
		t.Fatalf("新开写了文件后该认它: %q", got)
	}
	// 启动时刻未知（零值）：退回取最新
	if got := pickTranscript(dir, []string{"claude"}, time.Time{}); got != fresh {
		t.Fatalf("零值该退回最新: %q", got)
	}
}
