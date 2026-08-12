package project

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"ttmux-web/internal/id"
)

func TestStorePersistAndConverge(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, nil)
	key := s.Touch("/tmp/demo-repo")
	if !id.Valid(key) {
		t.Fatalf("Touch 应发不可变 id，got %q", key)
	}
	if _, ok := s.Dir(key); !ok {
		t.Fatal("Touch 后应在册")
	}
	if key2 := s.Touch("/tmp/demo-repo"); key2 != key {
		t.Fatalf("同目录重复 Touch 必须复用同一 id: %q vs %q", key, key2)
	}
	if !s.SetPrefs(key, func(p *Prefs) { p.Pinned = true }) {
		t.Fatal("SetPrefs 在册 key 应成功")
	}
	// 重新加载：台账与偏好都持久化
	s2 := NewStore(dir, nil)
	e := s2.Entries()[key]
	if e.Dir != "/tmp/demo-repo" || !e.Pinned || e.ID != key {
		t.Fatalf("重载后丢数据: %+v", e)
	}
	s2.Remove(key)
	if _, ok := s2.Dir(key); ok {
		t.Fatal("Remove 后不应在册")
	}
	// 落盘的是原子替换后的完整文件
	if _, err := os.Stat(filepath.Join(dir, "projects.json")); err != nil {
		t.Fatal("projects.json 应存在")
	}
	if s3 := NewStore(dir, nil); len(s3.Entries()) != 0 {
		t.Fatal("Remove 也要持久化")
	}
}

func TestSetPrefsUnknownKey(t *testing.T) {
	s := NewStore(t.TempDir(), nil)
	if s.SetPrefs("nope-0000", func(p *Prefs) { p.Pinned = true }) {
		t.Fatal("不在册 key 必须拒绝（API 防任意路径探测的前提）")
	}
}

// 目录搬家（mv 项目 / worktree 子目录归位仓库根）：id 不变、偏好不丢。
func TestSetDirKeepsIdentity(t *testing.T) {
	s := NewStore(t.TempDir(), nil)
	k := s.Add("/repo/old", "我的项目")
	s.SetPrefs(k, func(p *Prefs) { p.Pinned = true })
	if got := s.SetDir(k, "/repo/new"); got != k {
		t.Fatalf("平移应保持 id: %q → %q", k, got)
	}
	e := s.Entries()[k]
	if e.Dir != "/repo/new" || !e.Pinned || e.DisplayName != "我的项目" {
		t.Fatalf("搬家后偏好丢了: %+v", e)
	}
	if k2 := s.Touch("/repo/new"); k2 != k { // byDir 索引跟着搬
		t.Fatalf("新目录应命中同一条目: %q vs %q", k, k2)
	}
	if _, ok := s.byDir["/repo/old"]; ok {
		t.Fatal("老目录索引应清掉")
	}
}

// 新目录已被别的条目占用 → 合并用户意志，被并掉的 id 变别名（老链接仍可解析）。
func TestSetDirMergesUserIntent(t *testing.T) {
	s := NewStore(t.TempDir(), nil)
	sub := s.Add("/repo/.worktrees", "")
	s.SetPrefs(sub, func(p *Prefs) { p.Pinned = true })
	root := s.Touch("/repo")
	if got := s.SetDir(sub, "/repo"); got != root {
		t.Fatalf("应并进根条目 %q，got %q", root, got)
	}
	e := s.Entries()[root]
	if !e.Pinned || e.Origin != "user" {
		t.Fatalf("合并须保留用户意志(置顶/origin=user): %+v", e)
	}
	if len(s.Entries()) != 1 {
		t.Fatalf("合并后应只剩一条: %+v", s.Entries())
	}
	if d, ok := s.Dir(sub); !ok || d != "/repo" { // 被合并的老 id 仍解析得到
		t.Fatalf("被合并的 id 应作为别名继续解析，got %q ok=%v", d, ok)
	}
}

// v1 文件（key = 目录名 slug + 路径 hash）迁移：发 id、老 key 留别名、偏好原样。
func TestLegacyKeyMigration(t *testing.T) {
	dir := t.TempDir()
	legacy := `{"repos":{"ttmux-3f2a":{"dir":"/home/u/codes/ttmux","origin":"user","pinned":true,"displayName":"Roam","firstSeen":100,"lastSeen":200}}}`
	if err := os.WriteFile(filepath.Join(dir, "projects.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	s := NewStore(dir, nil)
	ents := s.Entries()
	if len(ents) != 1 {
		t.Fatalf("迁移后应有 1 条: %+v", ents)
	}
	var newKey string
	for k := range ents {
		newKey = k
	}
	if !id.Valid(newKey) {
		t.Fatalf("迁移后 key 应是 id，got %q", newKey)
	}
	e := ents[newKey]
	if e.ID != newKey || e.Dir != "/home/u/codes/ttmux" || !e.Pinned || e.DisplayName != "Roam" || e.Origin != "user" || e.FirstSeen != 100 {
		t.Fatalf("迁移丢字段: %+v", e)
	}
	// 老书签 #/projects/ttmux-3f2a 仍能解析
	if d, ok := s.Dir("ttmux-3f2a"); !ok || d != "/home/u/codes/ttmux" {
		t.Fatalf("老 key 别名失效: %q ok=%v", d, ok)
	}
	if !s.SetPrefs("ttmux-3f2a", func(p *Prefs) { p.DefaultBase = "main" }) {
		t.Fatal("老 key 也应能改偏好")
	}
	// 迁移结果落盘：重开仍是 id 主键 + 别名可用
	s2 := NewStore(dir, nil)
	if _, ok := s2.Entries()[newKey]; !ok {
		t.Fatal("迁移未落盘")
	}
	if _, ok := s2.Dir("ttmux-3f2a"); !ok {
		t.Fatal("别名未落盘")
	}
	var f fileShape
	b, _ := os.ReadFile(filepath.Join(dir, "projects.json"))
	if json.Unmarshal(b, &f) != nil || f.Aliases["ttmux-3f2a"] != newKey {
		t.Fatalf("落盘文件缺 aliases: %s", b)
	}
	// 删除后别名一并清掉，不留悬空
	s2.Remove(newKey)
	if _, ok := s2.Dir("ttmux-3f2a"); ok {
		t.Fatal("条目删了别名还在")
	}
}

// 历史脏数据：两条条目指向同一目录 → 加载时合并成一条。
func TestLoadMergesDuplicateDirs(t *testing.T) {
	dir := t.TempDir()
	legacy := `{"repos":{
		"a-0001":{"dir":"/x","pinned":true,"firstSeen":50},
		"a-0002":{"dir":"/x","origin":"user","displayName":"X","firstSeen":10}}}`
	if err := os.WriteFile(filepath.Join(dir, "projects.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	s := NewStore(dir, nil)
	if len(s.Entries()) != 1 {
		t.Fatalf("同目录重复条目应合并: %+v", s.Entries())
	}
	for _, e := range s.Entries() {
		if !e.Pinned || e.Origin != "user" || e.DisplayName != "X" || e.FirstSeen != 10 {
			t.Fatalf("合并丢用户意志: %+v", e)
		}
	}
	for _, k := range []string{"a-0001", "a-0002"} {
		if d, ok := s.Dir(k); !ok || d != "/x" {
			t.Fatalf("老 key %s 应仍解析到 /x", k)
		}
	}
}
