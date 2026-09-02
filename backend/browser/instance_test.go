package browser

import "testing"

// 单实例判定的核心是这段 ps 解析。chrome CLI 的 _running_profile_port 是同一套规则的 awk 版本。
func TestParseProfilePort(t *testing.T) {
	ps := `/usr/lib/systemd/systemd --user
/opt/google/chrome/chrome --remote-debugging-port=9333 --user-data-dir=/tmp/other --headless=new about:blank
/opt/google/chrome/chrome --type=renderer --user-data-dir=/tmp/mine --remote-debugging-port=9222 --lang=en-US
/opt/google/chrome/chrome --remote-debugging-port=9351 --remote-allow-origins=* --user-data-dir=/tmp/mine about:blank
`
	if got := parseProfilePort(ps, "/tmp/mine"); got != 9351 {
		t.Errorf("找的是浏览器进程那一行的端口: got %d, want 9351", got)
	}
	// 子串不算命中：/tmp/mine 不能匹配到 /tmp/mine-headed 那台
	headed := "/opt/google/chrome/chrome --remote-debugging-port=9444 --user-data-dir=/tmp/mine-headed about:blank\n"
	if got := parseProfilePort(headed, "/tmp/mine"); got != 0 {
		t.Errorf("profile 必须整段相等: got %d, want 0", got)
	}
	// 只有 renderer 子进程（浏览器进程已经没了）不算「实例在跑」
	onlyChild := "/opt/google/chrome/chrome --type=renderer --user-data-dir=/tmp/mine --remote-debugging-port=9222\n"
	if got := parseProfilePort(onlyChild, "/tmp/mine"); got != 0 {
		t.Errorf("带 --type= 的子进程不算: got %d, want 0", got)
	}
	if got := parseProfilePort(ps, ""); got != 0 {
		t.Errorf("空 profile 不该匹配任何东西: got %d", got)
	}
}

// 标签条上那条关不掉的「chrome://omnibox-popup.top-chrome/」：Chrome 自己的界面也报成 page。
func TestIsUserTab(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		{"https://example.com/", true},
		{"about:blank", true},
		{"chrome://settings/", true}, // 真页面，用户开的就该看得见、关得掉
		{"chrome://version/", true},
		{"chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html", false},
		{"chrome://tab-search.top-chrome/tab_search.html", false},
		{"devtools://devtools/bundled/devtools_app.html", false},
		{"chrome-untrusted://feed/", false},
	}
	for _, c := range cases {
		if got := isUserTab(target{URL: c.url}); got != c.want {
			t.Errorf("isUserTab(%q) = %v, want %v", c.url, got, c.want)
		}
	}
}
