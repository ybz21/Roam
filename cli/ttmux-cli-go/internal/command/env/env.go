package env

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"ttmux-cli-go/internal/runtime"
)

type entry struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

func Run(rt runtime.Runtime, args []string, w io.Writer) error {
	if err := rt.EnsureDirs(); err != nil {
		return err
	}
	subcmd := "list"
	if len(args) > 0 {
		subcmd = args[0]
		args = args[1:]
	}
	switch subcmd {
	case "ls", "list":
		if len(args) > 0 && args[0] == "--json" {
			return ListJSON(rt, w)
		}
		return rt.Shell(append([]string{"env", subcmd}, args...)...)
	case "--json":
		return ListJSON(rt, w)
	case "set":
		if len(args) < 1 {
			return fmt.Errorf("usage: ttmux env set KEY=VALUE")
		}
		return Set(rt, args[0], w)
	case "rm", "del", "delete":
		if len(args) < 1 {
			return fmt.Errorf("usage: ttmux env rm KEY")
		}
		return Remove(rt, args[0], w)
	case "clear":
		return Clear(rt, w)
	case "push":
		return rt.Shell("env", "push")
	default:
		if strings.Contains(subcmd, "=") {
			return Set(rt, subcmd, w)
		}
		return fmt.Errorf("unknown subcommand: env %s", subcmd)
	}
}

func ListJSON(rt runtime.Runtime, w io.Writer) error {
	entries := []entry{}
	for _, line := range readEnvLines(rt) {
		k, v, ok := strings.Cut(line, "=")
		if ok {
			entries = append(entries, entry{Key: k, Value: v})
		}
	}
	return json.NewEncoder(w).Encode(entries)
}

func Set(rt runtime.Runtime, kv string, w io.Writer) error {
	if !strings.Contains(kv, "=") {
		return fmt.Errorf("usage: ttmux env set KEY=VALUE")
	}
	key, _, _ := strings.Cut(kv, "=")
	lines := readEnvLines(rt)
	out := make([]string, 0, len(lines)+1)
	for _, line := range lines {
		k, _, ok := strings.Cut(line, "=")
		if ok && k == key {
			continue
		}
		out = append(out, line)
	}
	out = append(out, kv)
	if err := os.WriteFile(rt.EnvFile, []byte(strings.Join(out, "\n")+"\n"), 0o644); err != nil {
		return err
	}
	_, err := fmt.Fprintf(w, "设置 %s\n", kv)
	return err
}

func Remove(rt runtime.Runtime, key string, w io.Writer) error {
	if _, err := os.Stat(rt.EnvFile); err != nil {
		_, err := fmt.Fprintln(w, "无环境变量配置")
		return err
	}
	lines := readEnvLines(rt)
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		k, _, ok := strings.Cut(line, "=")
		if ok && k == key {
			continue
		}
		out = append(out, line)
	}
	if err := os.WriteFile(rt.EnvFile, []byte(strings.Join(out, "\n")+"\n"), 0o644); err != nil {
		return err
	}
	_, err := fmt.Fprintf(w, "已删除 %s\n", key)
	return err
}

func Clear(rt runtime.Runtime, w io.Writer) error {
	if err := os.RemoveAll(rt.EnvFile); err != nil {
		return err
	}
	_, err := fmt.Fprintln(w, "全局环境变量已清空")
	return err
}

func readEnvLines(rt runtime.Runtime) []string {
	b, err := os.ReadFile(rt.EnvFile)
	if err != nil {
		return nil
	}
	var lines []string
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		lines = append(lines, line)
	}
	return lines
}
