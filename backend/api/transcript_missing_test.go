package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// agent 刚起、一句没说（比如还卡在启动的信任确认框上）时根本没有转录文件。
// 那是正常起步态：必须回 200 + 空列表，不能回 400 —— 前端会把 BAD_FILE 当报错，
// 在输入框上方挂一行红字，而且成功轮询不会把它擦掉。
func TestTranscriptNoFileIsEmptyNotError(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &API{}
	for _, tc := range []struct {
		name    string
		route   string
		handler gin.HandlerFunc
	}{
		{"claude", "/sessions/:name/transcript", a.ClaudeTranscript},
		{"codex", "/sessions/:name/codex-transcript", a.CodexTranscript},
	} {
		r := gin.New()
		r.GET(tc.route, tc.handler)
		path := "/sessions/2026-0101-0000-zzzz/" + strings.TrimPrefix(tc.route, "/sessions/:name/")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("%s: want 200, got %d: %s", tc.name, w.Code, w.Body.String())
		}
		var got struct {
			Data struct {
				Messages []json.RawMessage `json:"messages"`
				File     string            `json:"file"`
			} `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if len(got.Data.Messages) != 0 || got.Data.File != "" {
			t.Fatalf("%s: 该是空转录，got %+v", tc.name, got.Data)
		}

		// 明确指名一个越界路径仍是坏请求
		w = httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path+"?file=/etc/passwd", nil))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s: 越界路径该 400，got %d", tc.name, w.Code)
		}
	}
}
