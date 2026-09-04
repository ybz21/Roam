package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSyncClaudeThemeRewritesOnlyThemeKey(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".claude")
	_ = os.MkdirAll(dir, 0o755)
	file := filepath.Join(dir, "settings.json")
	_ = os.WriteFile(file, []byte(`{"theme":"dark","hooks":{"a":[1,2]},"model":"x"}`), 0o600)

	syncClaudeTheme("light")
	var m map[string]any
	b, _ := os.ReadFile(file)
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if m["theme"] != "light" || m["model"] != "x" || m["hooks"] == nil {
		t.Fatalf("只该改 theme，其余保留: %s", b)
	}
	// 文件不存在：不创建
	_ = os.Remove(file)
	syncClaudeTheme("dark")
	if _, err := os.Stat(file); err == nil {
		t.Fatal("没有 settings.json 时不该凭空建一个")
	}
}

func TestPrefsClaudeTheme(t *testing.T) {
	if got := prefsClaudeTheme([]byte(`{"theme":"light"}`)); got != "light" {
		t.Fatalf("默认跟随: %q", got)
	}
	if got := prefsClaudeTheme([]byte(`{"theme":"light","claudeThemeSync":false}`)); got != "" {
		t.Fatalf("关了跟随就不同步: %q", got)
	}
}
