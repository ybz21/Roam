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
	Name     string `json:"name"`
	Windows  int    `json:"windows"`
	Created  string `json:"created"`
	Attached int    `json:"attached"`
}

type infoJSON struct {
	Version  string `json:"version"`
	Tmux     string `json:"tmux_version"`
	DataDir  string `json:"data_dir"`
	Sessions int    `json:"sessions"`
	Groups   int    `json:"groups"`
}

func ListJSON(rt runtime.Runtime, exclude map[string]bool, w io.Writer) error {
	out, err := rt.TmuxOutput("list-sessions", "-F", "#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}")
	if err != nil && strings.TrimSpace(out) == "" {
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
		sessions = append(sessions, sessionInfo{
			Name:     parts[0],
			Windows:  windows,
			Created:  parts[2],
			Attached: attached,
		})
	}
	return json.NewEncoder(w).Encode(sessions)
}

func InfoJSON(rt runtime.Runtime, version string, exclude map[string]bool, w io.Writer) error {
	sessions := 0
	out, _ := rt.TmuxOutput("list-sessions", "-F", "#{session_name}")
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if name := strings.TrimSpace(line); name != "" && !exclude[name] {
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
	target := args[0]
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

func must(s string, _ error) string {
	return s
}

func IsTerminal() bool {
	info, err := os.Stdout.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}
