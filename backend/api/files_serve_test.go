package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestFileServeDoesNotRedirectIndexHTML(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &API{}
	r := gin.New()
	r.GET("/file/serve/*path", a.FileServe)

	path := filepath.Join(t.TempDir(), "index.html")
	const content = "<!doctype html><title>preview works</title>"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/file/serve"+filepath.ToSlash(path), nil))

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
	if location := w.Header().Get("Location"); location != "" {
		t.Fatalf("index.html unexpectedly redirected to %q", location)
	}
	if contentType := w.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "text/html") {
		t.Fatalf("want text/html content type, got %q", contentType)
	}
	if got := w.Body.String(); got != content {
		t.Fatalf("unexpected body: %q", got)
	}
}
