package session

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"ttmux-cli-go/internal/runtime"
)

type sessionInfo struct {
	// Name tmux 会话名 = 会话 id（新会话），也是所有 API/WS 的 handle。
	Name string `json:"name"`
	// Label 展示名（tmux 用户选项 @roam_name）：用户起的名字，可改、可重复，
	// 只用于展示（前端渲染成「名字（id）」）。没设过则回退成会话名。
	Label string `json:"label,omitempty"`
	// ID 可读会话 id（2026-0728-1150-0142）：会话名本身就是它；迁移前的老会话
	// 由 session_created + session_id 现算派生，与 TmuxID 一一对应。
	ID string `json:"id,omitempty"`
	// TmuxID 原始 #{session_id}（$142）：内部键（meta.db 主键、session-homes 的键）。
	TmuxID       string `json:"tmux_id,omitempty"`
	Windows      int    `json:"windows"`
	Created      string `json:"created"`
	Attached     int    `json:"attached"`
	LastActivity string `json:"last_activity"`
}

type infoJSON struct {
	Version  string `json:"version"`
	Tmux     string `json:"tmux_version"`
	DataDir  string `json:"data_dir"`
	Sessions int    `json:"sessions"`
	Groups   int    `json:"groups"`
}

func ListJSON(rt runtime.Runtime, exclude map[string]bool, w io.Writer) error {
	// window_activity 补上 session_activity 的盲区：tmux 只在 attach/输入/焦点变化时
	// 刷新 session_activity,后台无人 attach 的会话即便一直有输出(agent 干活)也不动;
	// window_activity 会随前台窗口的 pane 输出走。取两者较大值 = 真正的「最近活跃」。
	out, err := rt.TmuxOutput("list-sessions", "-F", "#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}\t#{session_activity}\t#{window_activity}\t#{session_id}\t#{"+runtime.LabelOption+"}")
	if err != nil {
		// tmux server 未启动时输出的是 stderr 错误文本（out 非空），只看 err
		_, _ = io.WriteString(w, "[]\n")
		return nil
	}
	sessions := []sessionInfo{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) < 4 {
			continue
		}
		if exclude[parts[0]] {
			continue
		}
		windows, _ := strconv.Atoi(parts[1])
		attached, _ := strconv.Atoi(parts[3])
		lastActivity := ""
		if len(parts) > 4 {
			lastActivity = parts[4]
		}
		if len(parts) > 5 {
			lastActivity = maxNumeric(lastActivity, parts[5]) // max(session_activity, window_activity)
		}
		tmuxID := ""
		if len(parts) > 6 {
			tmuxID = parts[6]
		}
		label := ""
		if len(parts) > 7 {
			label = strings.TrimSpace(parts[7])
		}
		created, _ := strconv.ParseInt(parts[2], 10, 64)
		row := runtime.SessionRow{Name: parts[0], Label: label, TmuxID: tmuxID, Created: created}
		sessions = append(sessions, sessionInfo{
			Name:         row.Name,
			Label:        row.DisplayLabel(),
			ID:           row.ID(),
			TmuxID:       tmuxID,
			Windows:      windows,
			Created:      parts[2],
			Attached:     attached,
			LastActivity: lastActivity,
		})
	}
	return json.NewEncoder(w).Encode(sessions)
}

func InfoJSON(rt runtime.Runtime, version string, exclude map[string]bool, w io.Writer) error {
	sessions := 0
	for _, name := range rt.Sessions() {
		if !exclude[name] {
			sessions++
		}
	}
	groups := 0
	matches, _ := filepath.Glob(filepath.Join(rt.GroupsDir, "*.group"))
	groups = len(matches)
	tmuxVersion := strings.TrimSpace(must(rt.TmuxOutput("-V")))
	return json.NewEncoder(w).Encode(infoJSON{
		Version:  version,
		Tmux:     strings.TrimPrefix(tmuxVersion, "tmux "),
		DataDir:  rt.DataDir,
		Sessions: sessions,
		Groups:   groups,
	})
}

func Capture(rt runtime.Runtime, args []string, w io.Writer) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: ttmux capture <session> [--lines N]")
	}
	target := rt.Resolve(args[0])
	lines := "200"
	for i := 1; i < len(args); i++ {
		switch args[i] {
		case "--lines", "-n":
			if i+1 < len(args) {
				lines = args[i+1]
				i++
			}
		}
	}
	if _, err := strconv.Atoi(lines); err != nil {
		return fmt.Errorf("invalid line count: %s", lines)
	}
	out, err := rt.ReadCapture(target, lines)
	if err != nil {
		return err
	}
	_, err = io.WriteString(w, out)
	if err == nil && !strings.HasSuffix(out, "\n") {
		_, err = io.WriteString(w, "\n")
	}
	return err
}

// Resolve 处理 `ttmux resolve <会话名|id|展示名> [--json]`：把任意 token 解析成
// tmux 会话名（= 会话 id）。后端与外部脚本靠它把用户输入/老书签换算成 handle。
func Resolve(rt runtime.Runtime, args []string, w io.Writer) error {
	var token string
	for _, a := range args {
		if !strings.HasPrefix(a, "--") && token == "" {
			token = a
		}
	}
	if token == "" {
		return fmt.Errorf("usage: ttmux resolve <会话名|id|展示名> [--json]")
	}
	name := rt.Resolve(token)
	if !rt.HasSession(name) {
		return fmt.Errorf("session not found: %s", token)
	}
	if has(args, "--json") {
		row := rt.SessionRow(name)
		return json.NewEncoder(w).Encode(map[string]string{
			"name": row.Name, "label": row.DisplayLabel(), "id": row.ID(), "tmux_id": row.TmuxID,
		})
	}
	_, err := io.WriteString(w, name+"\n")
	return err
}

func must(s string, _ error) string {
	return s
}

// maxNumeric returns whichever of two tmux epoch strings is the larger number,
// tolerating empty/garbage (parses as 0). Keeps the string form for the JSON.
func maxNumeric(a, b string) string {
	na, _ := strconv.ParseInt(strings.TrimSpace(a), 10, 64)
	nb, _ := strconv.ParseInt(strings.TrimSpace(b), 10, 64)
	if nb > na {
		return b
	}
	return a
}

func IsTerminal() bool {
	info, err := os.Stdout.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}
