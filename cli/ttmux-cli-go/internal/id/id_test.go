package id

import (
	"testing"
	"time"
)

// 格式断言：与后端 backend/internal/id 同款，两边都有这条，防止格式漂。
func TestNewAtMatchesFormat(t *testing.T) {
	at := time.Date(2026, 7, 28, 11, 13, 0, 0, time.UTC)
	v := NewAt(at)
	if !Valid(v) {
		t.Fatalf("id %q 不符合 YYYY-MMDD-HHMM-rand4", v)
	}
	if v[:15] != "2026-0728-1113-" {
		t.Fatalf("id 前缀应是创建时刻，got %q", v)
	}
}

func TestValidRejectsOthers(t *testing.T) {
	for _, s := range []string{"", "swarm1", "2026-0728-1113", "2026-0728-1113-ASBD"} {
		if Valid(s) {
			t.Fatalf("不该认作 id: %q", s)
		}
	}
}
