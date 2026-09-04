package api

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// syncClaudeTheme 把 Roam 的主题写进 Claude Code 自己的 ~/.claude/settings.json（theme 键）。
// Claude Code 按自己的主题吐 24 位色，深色配色落在白底上靠 xterm 拉对比度怎么都勉强：
// 选中行和别的行要么一起淡、要么一起灰。让它自己换配色才是正路。
// 只在文件已存在、值确实不同时改写；改不动就算了，不影响偏好保存。
func syncClaudeTheme(theme string) {
	if theme != "dark" && theme != "light" {
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	file := filepath.Join(home, ".claude", "settings.json")
	b, err := os.ReadFile(file)
	if err != nil {
		return
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(b, &m) != nil || m == nil {
		return
	}
	var cur string
	_ = json.Unmarshal(m["theme"], &cur)
	if cur == theme {
		return
	}
	m["theme"], _ = json.Marshal(theme)
	out, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return
	}
	tmp := file + ".roam-tmp"
	if os.WriteFile(tmp, append(out, '\n'), 0o600) == nil {
		_ = os.Rename(tmp, file)
	}
}

// prefsClaudeTheme 从偏好 JSON 里取该同步给 Claude Code 的主题；没开跟随（默认开）就返回空。
func prefsClaudeTheme(raw []byte) string {
	var p struct {
		Theme string `json:"theme"`
		Sync  *bool  `json:"claudeThemeSync"`
	}
	if json.Unmarshal(raw, &p) != nil || (p.Sync != nil && !*p.Sync) {
		return ""
	}
	return p.Theme
}
