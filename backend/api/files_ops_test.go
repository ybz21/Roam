package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
)

func postJSON(t *testing.T, r *gin.Engine, url string, body any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", url, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

func TestFileMove(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &API{}
	r := gin.New()
	r.POST("/file/move", a.FileMove)

	dir := t.TempDir()
	src := filepath.Join(dir, "a.txt")
	os.WriteFile(src, []byte("x"), 0o644)
	destDir := filepath.Join(dir, "sub")
	os.Mkdir(destDir, 0o755)

	// target 是已存在目录 → 移入目录内
	w := postJSON(t, r, "/file/move", gin.H{"path": src, "target": destDir})
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
	moved := filepath.Join(destDir, "a.txt")
	if _, err := os.Stat(moved); err != nil {
		t.Fatalf("moved file missing: %v", err)
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Fatalf("src still exists")
	}

	// 目标已存在同名 → 409
	os.WriteFile(src, []byte("y"), 0o644)
	w = postJSON(t, r, "/file/move", gin.H{"path": src, "target": moved})
	if w.Code != http.StatusConflict {
		t.Fatalf("want 409, got %d: %s", w.Code, w.Body.String())
	}

	// 目录移入自身 → 400
	w = postJSON(t, r, "/file/move", gin.H{"path": destDir, "target": filepath.Join(destDir, "inner")})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestFileCopyCleanupOnFailure(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root 不受权限限制，无法构造复制失败")
	}
	gin.SetMode(gin.TestMode)
	a := &API{}
	r := gin.New()
	r.POST("/file/copy", a.FileCopy)

	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	os.MkdirAll(src, 0o755)
	os.WriteFile(filepath.Join(src, "a.txt"), []byte("ok"), 0o644)
	bad := filepath.Join(src, "b.txt")
	os.WriteFile(bad, []byte("x"), 0o644)
	os.Chmod(bad, 0) // 中途读取失败 → 复制半途而废
	defer os.Chmod(bad, 0o644)

	dest := filepath.Join(dir, "dest")
	w := postJSON(t, r, "/file/copy", gin.H{"path": src, "target": dest})
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("want 500, got %d: %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatalf("partial dest not cleaned up")
	}
}

func TestRenameNoReplace(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.txt")
	os.WriteFile(src, []byte("s"), 0o644)

	// 目标不存在 → 正常改名
	dst := filepath.Join(dir, "dst.txt")
	if err := renameNoReplace(src, dst); err != nil {
		t.Fatalf("rename to free target: %v", err)
	}

	// 目标已存在(文件) → os.ErrExist，且目标内容不被覆盖
	other := filepath.Join(dir, "other.txt")
	os.WriteFile(other, []byte("keep"), 0o644)
	if err := renameNoReplace(dst, other); !os.IsExist(err) {
		t.Fatalf("want ErrExist, got %v", err)
	}
	if b, _ := os.ReadFile(other); string(b) != "keep" {
		t.Fatalf("target overwritten: %q", b)
	}

	// 目标已存在(目录) → os.ErrExist
	d1 := filepath.Join(dir, "d1")
	d2 := filepath.Join(dir, "d2")
	os.Mkdir(d1, 0o755)
	os.Mkdir(d2, 0o755)
	if err := renameNoReplace(d1, d2); !os.IsExist(err) {
		t.Fatalf("want ErrExist for dir, got %v", err)
	}
}

func TestFileTouch(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &API{}
	r := gin.New()
	r.POST("/file/touch", a.FileTouch)

	dir := t.TempDir()
	w := postJSON(t, r, "/file/touch", gin.H{"dir": dir, "name": "new.md"})
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
	if fi, err := os.Stat(filepath.Join(dir, "new.md")); err != nil || fi.Size() != 0 {
		t.Fatalf("empty file not created: %v", err)
	}

	// 已存在 → 409
	w = postJSON(t, r, "/file/touch", gin.H{"dir": dir, "name": "new.md"})
	if w.Code != http.StatusConflict {
		t.Fatalf("want 409, got %d: %s", w.Code, w.Body.String())
	}

	// 带路径成分的名字 → 400
	w = postJSON(t, r, "/file/touch", gin.H{"dir": dir, "name": "../evil"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d: %s", w.Code, w.Body.String())
	}
}
