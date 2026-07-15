package project

import (
	"os"
	"path/filepath"
	"testing"
)

func TestKeyFor(t *testing.T) {
	k := KeyFor("/home/u/codes/My App")
	if len(k) < 6 || k[:7] != "my-app-" {
		t.Fatalf("KeyFor slug 化目录名 + 短 hash，got %q", k)
	}
	if KeyFor("/a/repo") == KeyFor("/b/repo") {
		t.Fatal("同名不同路径必须得到不同 key")
	}
	if KeyFor("/a/repo") != KeyFor("/a/repo") {
		t.Fatal("KeyFor 必须稳定")
	}
}

func TestStorePersistAndConverge(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	key := s.Touch("/tmp/demo-repo")
	if _, ok := s.Dir(key); !ok {
		t.Fatal("Touch 后应在册")
	}
	if !s.SetPrefs(key, func(p *Prefs) { p.Pinned = true }) {
		t.Fatal("SetPrefs 在册 key 应成功")
	}
	// 重新加载：台账与偏好都持久化
	s2 := NewStore(dir)
	e := s2.Entries()[key]
	if e.Dir != "/tmp/demo-repo" || !e.Pinned {
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
	if s3 := NewStore(dir); len(s3.Entries()) != 0 {
		t.Fatal("Remove 也要持久化")
	}
}

func TestSetPrefsUnknownKey(t *testing.T) {
	s := NewStore(t.TempDir())
	if s.SetPrefs("nope-0000", func(p *Prefs) { p.Pinned = true }) {
		t.Fatal("不在册 key 必须拒绝（API 防任意路径探测的前提）")
	}
}
