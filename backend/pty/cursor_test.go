package pty

import "testing"

// 单击移光标的钳位：建议提示（暗色/灰色）不算真实字符，否则 → 会替用户接受它。
func TestLastRealCol(t *testing.T) {
	cases := []struct {
		name string
		line string
		want int
	}{
		{"空行", "", -1},
		{"纯文字", "hello", 4},
		{"尾随空格不算", "hello   ", 4},
		{"整行都是暗色建议", "\x1b[2m! git push -u fork chore/sync-latest\x1b[0m", -1},
		{"文字后接暗色建议", "abc \x1b[2mghost\x1b[22m", 2},
		{"灰色 90 后又有正常字", "abc\x1b[90m gray\x1b[39m x", 9},
		{"256 色灰", "\x1b[38;5;242mdim\x1b[0m", -1},
		{"256 色正常色", "\x1b[38;5;75mblue\x1b[0m", 3},
		{"真彩灰", "\x1b[38;2;120;120;120mgray\x1b[0m", -1},
		{"真彩非灰", "\x1b[38;2;200;80;80mred\x1b[0m", 2},
		{"加粗不算暗", "\x1b[1mbold\x1b[0m", 3},
		{"中文占两列", "你好", 3},
		{"提示符加中文", "> 修一下\x1b[2m 建议\x1b[0m", 7},
		{"SGR 0 复位后正常", "\x1b[2mx\x1b[0my", 1},
	}
	for _, c := range cases {
		if got := lastRealCol(c.line); got != c.want {
			t.Errorf("%s: lastRealCol(%q) = %d, want %d", c.name, c.line, got, c.want)
		}
	}
}
