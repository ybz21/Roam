package im

import (
	"strings"
	"testing"
)

// 样例仿真会话日志:bracketed-paste 等私有模式序列 + 启动命令回显 +
// markdown 标题 + 收尾 exit/logout,应全部被清洗掉。
func TestTailForCard(t *testing.T) {
	log := "\x1b[?2004h(ai@host)$ cd '/home/ai' && claude -p --output-format text < '/x/logs/feishu-1.prompt'; exit\n" +
		"## 负载概况\n" +
		"CPU 正常\x1b[0m\n" +
		"\x1b[?1006l\x1b[?1002l\nexit\nlogout"
	got := tailForCard(log, 500)
	for _, banned := range []string{"?2004h", "?1006l", ".prompt", "logout", "## "} {
		if strings.Contains(got, banned) {
			t.Fatalf("cleaned output still contains %q:\n%s", banned, got)
		}
	}
	if !strings.Contains(got, "**负载概况**") {
		t.Fatalf("heading not downgraded to bold:\n%s", got)
	}
	if !strings.Contains(got, "CPU 正常") {
		t.Fatalf("real content lost:\n%s", got)
	}
}

func TestTailForCardTruncates(t *testing.T) {
	got := tailForCard(strings.Repeat("x", 3000), 100)
	if r := []rune(got); len(r) != 101 || !strings.HasPrefix(got, "…") {
		t.Fatalf("want …+100 runes, got %d", len(r))
	}
}
