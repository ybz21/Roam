package browser

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// 假 Chrome：/json 列出 targets，/json/close 一律回 "Target is closing"（真 Chrome 对
// 关不掉的浏览器界面页也是这么回的），关掉与否由 gone 决定。
func fakeChrome(t *testing.T, id string, gone *atomic.Bool) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/json":
			if gone.Load() {
				fmt.Fprint(w, `[]`)
				return
			}
			fmt.Fprintf(w, `[{"id":%q,"type":"page","url":"chrome://omnibox-popup.top-chrome/","webSocketDebuggerUrl":"ws://x"}]`, id)
		default:
			fmt.Fprint(w, "Target is closing")
		}
	}))
	t.Cleanup(srv.Close)
	old := CDPBase
	CDPBase = srv.URL
	t.Cleanup(func() { CDPBase = old })
}

func TestCloseTabReportsWhenTargetSurvives(t *testing.T) {
	var gone atomic.Bool
	fakeChrome(t, "abc", &gone)
	if err := closeTab("abc"); !errors.Is(err, ErrNotClosable) {
		t.Fatalf("关不掉的页应报 ErrNotClosable，得到 %v", err)
	}
}

func TestCloseTabOKWhenTargetGone(t *testing.T) {
	var gone atomic.Bool
	gone.Store(true)
	fakeChrome(t, "abc", &gone)
	if err := closeTab("abc"); err != nil {
		t.Fatalf("目标已消失应视为关闭成功，得到 %v", err)
	}
}

// 关不掉的那一页也不该出现在标签条上——两道防线各测各的。
func TestListPagesDropsBrowserUI(t *testing.T) {
	var gone atomic.Bool
	fakeChrome(t, "abc", &gone)
	if pages := listPages(); len(pages) != 0 {
		t.Fatalf("chrome://*.top-chrome/ 不该进标签列表，得到 %+v", pages)
	}
	if !targetExists("abc") {
		t.Fatal("targetExists 必须问未过滤的原始列表，否则关闭确认永远以为已经关掉了")
	}
}
