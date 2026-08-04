package search

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// mkdirAllFile 建出中间目录并落一个空文件。
func mkdirAllFile(p string) error {
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, nil, 0o644)
}

func TestScoreSubsequenceAndMiss(t *testing.T) {
	if _, ok := Score("ovw", "Overview.tsx"); !ok {
		t.Fatal("首字母缩写 ovw 应能命中 Overview.tsx")
	}
	if _, ok := Score("zzz", "Overview.tsx"); ok {
		t.Fatal("不存在的子序列不应命中")
	}
	if _, ok := Score("", "anything"); ok {
		t.Fatal("空查询不应命中")
	}
}

func TestScorePrefersWordBoundary(t *testing.T) {
	// 同样是子序列命中，词首（路径段开头）要压过散落在中间的巧合
	head, ok1 := Score("api", "backend/api/api.go")
	tail, ok2 := Score("api", "backend/xapixzz/notes.md")
	if !ok1 || !ok2 {
		t.Fatal("两个目标都应命中")
	}
	if head.Score <= tail.Score {
		t.Fatalf("词首命中应更高：%d vs %d", head.Score, tail.Score)
	}
}

func TestScorePrefersConsecutive(t *testing.T) {
	solid, _ := Score("search", "search.go")
	spread, _ := Score("search", "s_e_a_r_c_h.go")
	if solid.Score <= spread.Score {
		t.Fatalf("连续命中应更高：%d vs %d", solid.Score, spread.Score)
	}
}

func TestScoreCaseInsensitive(t *testing.T) {
	a, ok := Score("OVERVIEW", "overview.tsx")
	if !ok || a.Score <= 0 {
		t.Fatal("大小写不应影响命中")
	}
}

func TestScoreMultiTermIsAnd(t *testing.T) {
	if _, ok := Score("api search", "backend/api/search.go"); !ok {
		t.Fatal("两个词都在目标里应命中")
	}
	if _, ok := Score("api zzz", "backend/api/search.go"); ok {
		t.Fatal("有一个词不在目标里就不该命中")
	}
}

func TestScorePositionsAreValid(t *testing.T) {
	m, ok := Score("apgo", "backend/api/api.go")
	if !ok {
		t.Fatal("应命中")
	}
	if len(m.Positions) != 4 {
		t.Fatalf("位置数应等于查询字符数，得到 %d", len(m.Positions))
	}
	target := []rune("backend/api/api.go")
	want := []rune("apgo")
	for i, p := range m.Positions {
		if p < 0 || p >= len(target) {
			t.Fatalf("位置越界：%d", p)
		}
		if i > 0 && p <= m.Positions[i-1] {
			t.Fatalf("位置应严格递增：%v", m.Positions)
		}
		if target[p] != want[i] {
			t.Fatalf("位置 %d 指向 %q，期望 %q", p, string(target[p]), string(want[i]))
		}
	}
}

func TestScoreCJK(t *testing.T) {
	if _, ok := Score("概览", "概览页 Overview"); !ok {
		t.Fatal("中文子串应命中")
	}
	if _, ok := Score("概设", "概览设计"); !ok {
		t.Fatal("中文子序列应命中")
	}
}

func TestBestPrefersPrimaryField(t *testing.T) {
	// 名字命中打满分，路径命中打折：真叫 search.go 的那个要排在「路径里带 search」前面
	name, idx, ok := Best("search", "search.go", "/home/x/deep/nested/dir/search/other.go")
	if !ok || idx != 0 {
		t.Fatalf("应命中主字段，得到 idx=%d ok=%v", idx, ok)
	}
	sub, idx2, ok2 := Best("search", "other.go", "/home/x/search/other.go")
	if !ok2 || idx2 != 1 {
		t.Fatalf("主字段不匹配时应回落到副字段，得到 idx=%d ok=%v", idx2, ok2)
	}
	if sub.Score >= name.Score {
		t.Fatalf("副字段命中应低于主字段：%d vs %d", sub.Score, name.Score)
	}
}

func TestFileIndexWalk(t *testing.T) {
	root := t.TempDir()
	mk := func(rel string) {
		p := filepath.Join(root, rel)
		if err := mkdirAllFile(p); err != nil {
			t.Fatal(err)
		}
	}
	mk("src/app.tsx")
	mk("src/lib/util.go")
	mk("node_modules/pkg/index.js")
	mk(".git/config")
	mk("README.md")

	ix := NewFileIndex()
	files, truncated := ix.Rebuild(root) // 同步版：测遍历规则本身，不测后台调度
	if truncated {
		t.Fatal("小目录不该被截断")
	}
	got := map[string]bool{}
	for _, f := range files {
		got[filepath.ToSlash(f)] = true
	}
	for _, want := range []string{"src/app.tsx", "src/lib/util.go", "README.md"} {
		if !got[want] {
			t.Fatalf("清单缺 %s：%v", want, files)
		}
	}
	for _, skip := range []string{"node_modules/pkg/index.js", ".git/config"} {
		if got[skip] {
			t.Fatalf("%s 不该进索引", skip)
		}
	}
}

func TestFileIndexTruncates(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 20; i++ {
		if err := mkdirAllFile(filepath.Join(root, "f"+string(rune('a'+i))+".txt")); err != nil {
			t.Fatal(err)
		}
	}
	ix := NewFileIndex()
	ix.MaxFiles = 5
	files, truncated := ix.Rebuild(root)
	if !truncated {
		t.Fatal("超过上限应标记截断")
	}
	if len(files) > 5 {
		t.Fatalf("收录数不应超过上限，得到 %d", len(files))
	}
}

func TestFileIndexBuildsInBackground(t *testing.T) {
	root := t.TempDir()
	if err := mkdirAllFile(filepath.Join(root, "a.txt")); err != nil {
		t.Fatal(err)
	}
	ix := NewFileIndex()
	// 第一次问：立刻返回，清单还没建好
	if files, _, ready := ix.Files(root); ready || len(files) != 0 {
		t.Fatalf("首次调用应立刻返回空清单且 ready=false，得到 files=%v ready=%v", files, ready)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if files, _, ready := ix.Files(root); ready {
			if len(files) != 1 {
				t.Fatalf("建好后应有 1 个文件，得到 %v", files)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("后台索引没在 3 秒内建好")
}
