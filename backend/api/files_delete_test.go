package api

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestFileDeleteRecursive(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &API{}
	r := gin.New()
	r.DELETE("/file", a.FileDelete)

	dir := t.TempDir()
	sub := filepath.Join(dir, "sub")
	os.MkdirAll(filepath.Join(sub, "nested"), 0o755)
	os.WriteFile(filepath.Join(sub, "nested", "f.txt"), []byte("x"), 0o644)

	// 非空 + 无 recursive → 400 DIR_NOT_EMPTY
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("DELETE", "/file?path="+url.QueryEscape(sub), nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d: %s", w.Code, w.Body.String())
	}

	// 非空 + recursive=1 → 200 且目录消失
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("DELETE", "/file?path="+url.QueryEscape(sub)+"&recursive=1", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(sub); !os.IsNotExist(err) {
		t.Fatalf("dir still exists: %v", err)
	}
}
