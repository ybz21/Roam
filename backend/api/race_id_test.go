package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"ttmux-web/internal/id"
)

// 老竞赛记录（race-<纳秒>）加载时统一重写成可读 id；老 id 落 legacyId，
// 已经打开的页面按老 id 还能找到本场竞赛。
func TestRaceStoreNormalizesLegacyIDs(t *testing.T) {
	dir := t.TempDir()
	legacy := `[{"id":"race-1753670000000000000","name":"demo","dir":"/repo","status":"running","contestants":[]}]`
	if err := os.WriteFile(filepath.Join(dir, "races.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	s := NewRaceStore(dir, nil)
	if len(s.races) != 1 {
		t.Fatalf("races = %+v", s.races)
	}
	r := s.races[0]
	if !id.Valid(r.ID) {
		t.Fatalf("id 应重写成可读格式，got %q", r.ID)
	}
	if r.LegacyID != "race-1753670000000000000" {
		t.Fatalf("legacyId = %q", r.LegacyID)
	}
	if s.get("race-1753670000000000000") == nil || s.get(r.ID) == nil {
		t.Fatal("新老 id 都应能查到")
	}
	// 重写落盘：重开不再二次改写
	s2 := NewRaceStore(dir, nil)
	if s2.races[0].ID != r.ID {
		t.Fatalf("重写未落盘或被二次改写: %q vs %q", s2.races[0].ID, r.ID)
	}
	var raw []map[string]any
	b, _ := os.ReadFile(filepath.Join(dir, "races.json"))
	if json.Unmarshal(b, &raw) != nil || raw[0]["legacyId"] != "race-1753670000000000000" {
		t.Fatalf("落盘内容缺 legacyId: %s", b)
	}
}
