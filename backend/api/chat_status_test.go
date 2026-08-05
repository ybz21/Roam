package api

import "testing"

// 样本取自真实转录（~/.claude/projects 与 ~/.codex/sessions），字段名和嵌套层级照抄，
// 不是手编的——这两个解析器唯一的风险就是「上游换了字段名而我们不知道」。

func TestScanStatusClaude(t *testing.T) {
	st := cStatus{}
	// 改权限模式当场落一行（实测一份转录里有 16 条这样的行）
	st = scanStatus(`{"type":"permission-mode","permissionMode":"plan"}`, st)
	if st.Mode != "plan" {
		t.Fatalf("mode = %q, want plan", st.Mode)
	}
	// assistant 行带模型、推理档与 usage
	line := `{"type":"assistant","effort":"high","message":{"model":"claude-opus-5","usage":` +
		`{"input_tokens":2,"cache_creation_input_tokens":2634,"cache_read_input_tokens":269173,"output_tokens":723}}}`
	st = scanStatus(line, st)
	if st.Model != "claude-opus-5" {
		t.Errorf("model = %q", st.Model)
	}
	if st.Effort != "high" {
		t.Errorf("effort = %q", st.Effort)
	}
	// 上下文占用 = 新增 + 写缓存 + 读缓存（输出不算，它不占下一轮的输入窗口）
	if want := 2 + 2634 + 269173; st.Used != want {
		t.Errorf("used = %d, want %d", st.Used, want)
	}
	if st.Window != 200000 {
		t.Errorf("window = %d, want 200000", st.Window)
	}
	// 后来的模式覆盖先前的
	st = scanStatus(`{"type":"permission-mode","permissionMode":"bypassPermissions"}`, st)
	if st.Mode != "bypassPermissions" {
		t.Errorf("mode = %q", st.Mode)
	}
	// 非状态行不该动任何字段
	before := st
	st = scanStatus(`{"type":"summary","summary":"x"}`, st)
	if st != before {
		t.Errorf("非状态行改了状态: %+v -> %+v", before, st)
	}
	// 坏行不能 panic，也不该清空已有状态
	st = scanStatus(`{not json`, st)
	if st != before {
		t.Errorf("坏行改了状态: %+v", st)
	}
}

func TestClaudeWindow(t *testing.T) {
	cases := map[string]int{
		"claude-opus-5[1m]": 1000000,
		"claude-opus-5-1m":  1000000,
		"claude-opus-5":     200000,
		"claude-sonnet-5":   200000,
		"":                  200000, // 认不出按 200k 保守算：宁可百分比偏高
	}
	for model, want := range cases {
		if got := claudeWindow(model); got != want {
			t.Errorf("claudeWindow(%q) = %d, want %d", model, got, want)
		}
	}
}

func TestScanCodexStatus(t *testing.T) {
	st := cStatus{}
	quota := 0.0
	turn := `{"type":"turn_context","payload":{"model":"gpt-5.6-sol","approval_policy":"never",` +
		`"sandbox_policy":{"type":"danger-full-access"},` +
		`"collaboration_mode":{"mode":"default","settings":{"reasoning_effort":"high"}}}}`
	st = scanCodexStatus(turn, st, &quota)
	if st.Model != "gpt-5.6-sol" || st.Effort != "high" || st.Mode != "default" {
		t.Fatalf("turn_context 解析错: %+v", st)
	}

	// token_count 直接给窗口，不用按模型 id 猜
	tok := `{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":` +
		`{"total_tokens":16543},"model_context_window":258400},` +
		`"rate_limits":{"primary":{"used_percent":44.0}}}}`
	st = scanCodexStatus(tok, st, &quota)
	if st.Used != 16543 || st.Window != 258400 {
		t.Errorf("token_count 解析错: used=%d window=%d", st.Used, st.Window)
	}
	if quota != 44.0 {
		t.Errorf("quota = %v, want 44", quota)
	}

	// 没有协作模式时退回沙箱策略——「它现在能不能动我的盘」比模式名更要紧
	st2 := scanCodexStatus(`{"type":"turn_context","payload":{"sandbox_policy":{"type":"read-only"}}}`, cStatus{}, &quota)
	if st2.Mode != "read-only" {
		t.Errorf("回退沙箱策略失败: %q", st2.Mode)
	}

	// 别的 event_msg（本文件里最常见的一类）不该动状态
	before := st
	st = scanCodexStatus(`{"type":"event_msg","payload":{"type":"agent_message","message":"hi"}}`, st, &quota)
	if st != before {
		t.Errorf("无关事件改了状态: %+v -> %+v", before, st)
	}
}

func TestClipUsesSentinel(t *testing.T) {
	long := make([]byte, blockCap+10)
	for i := range long {
		long[i] = 'x'
	}
	out := clip(string(long))
	// 截断标记必须是哨兵而非中文：它会直接进 API 响应，文案由前端出译文
	if got := out[len(out)-len(clipMark):]; got != clipMark {
		t.Errorf("截断标记 = %q, want %q", got, clipMark)
	}
	if len(out) != blockCap+len(clipMark) {
		t.Errorf("截断长度 = %d", len(out))
	}
	if s := "短文本"; clip(s) != s {
		t.Errorf("没超长的不该动")
	}
}
