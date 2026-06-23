package group

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"ttmux-cli-go/internal/runtime"
)

type groupInfo struct {
	Group  string `json:"group"`
	Total  int    `json:"total"`
	Alive  int    `json:"alive"`
	Status string `json:"status"`
}

type groupStatus struct {
	Group string     `json:"group"`
	Tasks []taskInfo `json:"tasks"`
}

type taskInfo struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Status   string `json:"status"`
	Process  string `json:"process"`
	ExitCode string `json:"exit_code"`
	Task     string `json:"task"`
}

type collectResult struct {
	Group   string         `json:"group"`
	Results []collectEntry `json:"results"`
}

type collectEntry struct {
	Task   string `json:"task"`
	Type   string `json:"type"`
	Prompt string `json:"prompt"`
	Output string `json:"output"`
}

func ListJSON(rt runtime.Runtime, w io.Writer) error {
	matches, _ := filepath.Glob(filepath.Join(rt.GroupsDir, "*.group"))
	var groups []groupInfo
	for _, f := range matches {
		name := strings.TrimSuffix(filepath.Base(f), ".group")
		sessions, err := rt.GroupSessions(name)
		if err != nil {
			continue
		}
		alive := 0
		for _, s := range sessions {
			if rt.HasSession(s) {
				alive++
			}
		}
		status := "done"
		if alive == len(sessions) && len(sessions) > 0 {
			status = "running"
		} else if alive > 0 {
			status = "partial"
		}
		groups = append(groups, groupInfo{Group: name, Total: len(sessions), Alive: alive, Status: status})
	}
	return json.NewEncoder(w).Encode(groups)
}

func StatusJSON(rt runtime.Runtime, group string, w io.Writer) error {
	sessions, err := rt.GroupSessions(group)
	if err != nil {
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "group not found"})
		return fmt.Errorf("group not found: %s", group)
	}
	res := groupStatus{Group: group, Tasks: []taskInfo{}}
	for _, sess := range sessions {
		item := taskInfo{Name: sess, Type: rt.TaskType(sess), Status: "exited", Task: rt.TaskDesc(sess)}
		if rt.HasSession(sess) {
			item.Process = strings.TrimSpace(must(rt.TmuxOutput("display-message", "-t", sess, "-p", "#{pane_current_command}")))
			dead := strings.TrimSpace(must(rt.TmuxOutput("display-message", "-t", sess, "-p", "#{pane_dead}")))
			if dead == "1" {
				item.Status = "done"
				item.ExitCode = strings.TrimSpace(must(rt.TmuxOutput("display-message", "-t", sess, "-p", "#{pane_dead_status}")))
			} else {
				item.Status = "running"
			}
		}
		res.Tasks = append(res.Tasks, item)
	}
	return json.NewEncoder(w).Encode(res)
}

func CollectJSON(rt runtime.Runtime, group string, w io.Writer) error {
	sessions, err := rt.GroupSessions(group)
	if err != nil {
		return fmt.Errorf("group not found: %s", group)
	}
	res := collectResult{Group: group, Results: []collectEntry{}}
	for _, sess := range sessions {
		output := ""
		logPath := filepath.Join(rt.LogsDir, sess+".log")
		if b, err := os.ReadFile(logPath); err == nil {
			output = tailString(string(b), 200)
		} else if out, err := rt.ReadCapture(sess, "200"); err == nil {
			output = out
		}
		res.Results = append(res.Results, collectEntry{
			Task:   sess,
			Type:   rt.TaskType(sess),
			Prompt: rt.TaskDescRaw(sess),
			Output: output,
		})
	}
	return json.NewEncoder(w).Encode(res)
}

func tailString(s string, n int) string {
	lines := strings.Split(s, "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

func must(s string, _ error) string {
	return s
}
