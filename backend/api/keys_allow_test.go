package api

import "testing"

// 对话页「+」里的「权限模式」发的就是 BTab（tmux 对 Shift+Tab 的叫法）：
// Claude Code 与 Codex 都用它轮换权限/审批档。这一枚掉出白名单，那一行就静默失效
// ——按钮照点、请求 400、界面什么也不说，正是最难发现的那种坏法。
func TestAllowedKeysHasBTab(t *testing.T) {
	for _, k := range []string{"BTab", "Up", "Down", "Enter", "Escape"} {
		if !allowedKeys[k] {
			t.Errorf("allowedKeys[%q] = false, want true", k)
		}
	}
	// 白名单仍然是白名单：控制序列不在里面（单字符另有分支放行）
	for _, k := range []string{"C-c", "C-d", "M-x", ""} {
		if allowedKeys[k] {
			t.Errorf("allowedKeys[%q] = true, want false", k)
		}
	}
}
