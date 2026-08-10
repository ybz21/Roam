package config

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"strings"
)

// SaveCluster 把 cluster 段写回 config.yaml。
//
// **按行改写而不是 yaml.Marshal 全量重写**：模板里那些解释性注释（每个字段是干什么的、
// 什么时候该填）是用户手改配置时唯一的说明书，整份 Marshal 一次就全没了。所以这里
// 只替换 cluster: 段内已存在的键值行，缺的键追加在段尾，段外的一个字节都不碰。
func SaveCluster(path string, c Cluster) error {
	if path == "" {
		path = ResolvePath()
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	// 写空字符串等于「删掉这个设置」：留一行 hub: "" 会让人以为配过又没生效。
	fields := []struct {
		key string
		val string
		raw bool // 布尔不加引号：insecure: "true" 是字符串，YAML 解出来不是 bool
	}{
		{"mode", c.Mode, false},
		{"hub", c.Hub, false},
		// 旧键：这套东西一度叫 broker。值恒为空 = 每次写回都把它删掉，
		// 免得 hub: 和 broker: 并存，越留越乱。
		{"broker", "", false},
		{"token", c.Token, false},
		{"name", c.Name, false},
		{"group", c.Group, false},
		{"insecure", boolStr(c.Insecure), true},
	}

	write := func(w *bytes.Buffer, key, val string, raw bool) {
		if raw {
			fmt.Fprintf(w, "  %s: %s\n", key, val)
			return
		}
		fmt.Fprintf(w, "  %s: %s\n", key, yamlQuote(val))
	}

	var out bytes.Buffer
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	inCluster := false
	seen := map[string]bool{}
	hasCluster := false

	flush := func() {
		// 段落结束前把没出现过的键补上
		for _, f := range fields {
			if !seen[f.key] && f.val != "" {
				write(&out, f.key, f.val, f.raw)
			}
		}
	}

	for sc.Scan() {
		line := sc.Text()
		trimmed := strings.TrimSpace(line)

		if !inCluster {
			if trimmed == "cluster:" || strings.HasPrefix(trimmed, "cluster:") && !strings.HasPrefix(line, " ") {
				inCluster, hasCluster = true, true
				out.WriteString(line + "\n")
				continue
			}
			out.WriteString(line + "\n")
			continue
		}

		// 段内：遇到下一个顶格非空行就说明 cluster 段结束了
		if trimmed != "" && !strings.HasPrefix(line, " ") && !strings.HasPrefix(trimmed, "#") {
			flush()
			inCluster = false
			out.WriteString(line + "\n")
			continue
		}

		replaced := false
		for _, f := range fields {
			// 只认「(可选缩进)key:」这种形状，注释行原样保留
			if strings.HasPrefix(trimmed, f.key+":") && !strings.HasPrefix(trimmed, "#") {
				seen[f.key] = true
				if f.val != "" {
					write(&out, f.key, f.val, f.raw)
				}
				// 值为空 = 删掉这一行
				replaced = true
				break
			}
		}
		if !replaced {
			out.WriteString(line + "\n")
		}
	}
	if inCluster {
		flush()
	}
	if !hasCluster {
		out.WriteString("\n# ── 多机：本机角色与接入（由设置页写入）──\ncluster:\n")
		for _, f := range fields {
			if f.val != "" {
				write(&out, f.key, f.val, f.raw)
			}
		}
	}
	return os.WriteFile(path, out.Bytes(), 0o600)
}

// boolStr 只在 true 时落盘：false 是默认值，写出来只是噪音。
func boolStr(v bool) string {
	if v {
		return "true"
	}
	return ""
}
