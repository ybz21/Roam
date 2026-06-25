// Codex 集成：检测会话是否在跑 codex（OpenAI Codex CLI），并把其会话记录(rollout JSONL)
// 解析成可渲染的对话。机制与 claude.go 一致——只「读」记录渲染，「发」消息复用 ttmux send。
//
// rollout 文件位于 ~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl。
// 每行一个 JSON：response_item 承载对话主体（message/reasoning/function_call/...），
// event_msg 多为重复或噪声（仅 mcp_tool_call_end 无 response_item 对应，单独渲染）。
package api

import (
	"bufio"
	"encoding/json"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

// cmdlineHasCodex 判断进程命令行是否是交互式 codex CLI。
// 排除 codex-web（ttmux 自身）、mcp-server（Claude Code 会把 codex 当 MCP server 启动）、
// app-server（Codex 桌面端/VS Code 插件的后台服务）。
func cmdlineHasCodex(pid int) bool {
	cl := processCmdline(pid)
	return strings.Contains(cl, "codex") &&
		!strings.Contains(cl, "codex-web") &&
		!strings.Contains(cl, "mcp-server") &&
		!strings.Contains(cl, "app-server")
}

func codexSessionsRoot() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex", "sessions")
}

// listRollouts 返回所有 rollout-*.jsonl，按修改时间倒序（活跃会话排最前）。
func listRollouts() []string {
	root := codexSessionsRoot()
	type fm struct {
		path string
		mod  int64
	}
	var all []fm
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if !strings.HasPrefix(d.Name(), "rollout-") || !strings.HasSuffix(d.Name(), ".jsonl") {
			return nil
		}
		if info, e := d.Info(); e == nil {
			all = append(all, fm{p, info.ModTime().UnixNano()})
		}
		return nil
	})
	sort.Slice(all, func(i, j int) bool { return all[i].mod > all[j].mod })
	out := make([]string, len(all))
	for i, x := range all {
		out[i] = x.path
	}
	return out
}

// rolloutCwd 读取 rollout 首行 session_meta 的 cwd。
func rolloutCwd(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 8*1024*1024)
	if sc.Scan() {
		var raw struct {
			Type    string `json:"type"`
			Payload struct {
				Cwd string `json:"cwd"`
			} `json:"payload"`
		}
		if json.Unmarshal(sc.Bytes(), &raw) == nil && raw.Type == "session_meta" {
			return raw.Payload.Cwd
		}
	}
	return ""
}

// newestCodexRollout 选 cwd 匹配且最近修改的 rollout；无匹配则退回最近修改的（多半即活跃会话）。
func newestCodexRollout(cwd string) string {
	files := listRollouts()
	if len(files) == 0 {
		return ""
	}
	for i, p := range files {
		if i >= 200 { // 仅在最近的若干个里找匹配，避免遍历历史全量
			break
		}
		if rolloutCwd(p) == cwd {
			return p
		}
	}
	return files[0]
}

// CodexStatus GET /sessions/:name/codex —— 检测会话是否在跑 codex，并定位其 rollout。
func (a *API) CodexStatus(c *gin.Context) {
	dir := paneToolDir(c.Param("name"), cmdlineHasCodex)
	if dir == "" {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"running": false}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"running": true, "dir": dir, "file": newestCodexRollout(dir)}})
}

// ── rollout JSONL → 可渲染对话（复用 claude.go 的 cBlock/cMsg/clip）──

var codexExitRe = regexp.MustCompile(`(?i)(?:exit code|exited with code):?\s*(\d+)`)

// codexOutputIsError 从工具输出里识别非零退出码。
func codexOutputIsError(s string) bool {
	m := codexExitRe.FindStringSubmatch(s)
	return len(m) == 2 && m[1] != "0"
}

// codexOutputText 把工具输出（字符串或对象）抽成文本。
func codexOutputText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return string(raw)
}

// isCodexContextWrapper 判断用户消息是否为注入的上下文包裹（非用户真实输入），应隐藏。
func isCodexContextWrapper(t string) bool {
	for _, p := range []string{"<environment_context>", "<user_instructions>", "<permissions"} {
		if strings.HasPrefix(t, p) {
			return true
		}
	}
	return false
}

// parseCodexItem 解析 response_item 的 payload。
func parseCodexItem(payload json.RawMessage, ts string) *cMsg {
	var p struct {
		Type    string `json:"type"`
		Role    string `json:"role"`
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
		Summary []struct {
			Text string `json:"text"`
		} `json:"summary"`
		Name      string          `json:"name"`
		Arguments string          `json:"arguments"`
		Input     string          `json:"input"`
		Output    json.RawMessage `json:"output"`
		CallID    string          `json:"call_id"`
	}
	if json.Unmarshal(payload, &p) != nil {
		return nil
	}
	switch p.Type {
	case "message":
		if p.Role == "developer" { // 系统/权限指令，不展示
			return nil
		}
		var b strings.Builder
		for _, c := range p.Content {
			b.WriteString(c.Text)
		}
		t := strings.TrimSpace(b.String())
		if t == "" {
			return nil
		}
		role := "assistant"
		if p.Role == "user" {
			if isCodexContextWrapper(t) {
				return nil
			}
			role = "user"
		}
		return &cMsg{Role: role, Ts: ts, Blocks: []cBlock{{Kind: "text", Text: clip(t)}}}
	case "reasoning":
		var b strings.Builder
		for _, s := range p.Summary {
			b.WriteString(s.Text)
		}
		t := strings.TrimSpace(b.String())
		if t == "" { // 仅有 encrypted_content、无明文摘要时跳过
			return nil
		}
		return &cMsg{Role: "assistant", Ts: ts, Blocks: []cBlock{{Kind: "thinking", Text: clip(t)}}}
	case "function_call":
		return &cMsg{Role: "assistant", Ts: ts, Blocks: []cBlock{{Kind: "tool_use", Name: p.Name, Input: clip(p.Arguments), ID: p.CallID}}}
	case "custom_tool_call":
		return &cMsg{Role: "assistant", Ts: ts, Blocks: []cBlock{{Kind: "tool_use", Name: p.Name, Input: clip(p.Input), ID: p.CallID}}}
	case "function_call_output", "custom_tool_call_output":
		out := codexOutputText(p.Output)
		return &cMsg{Role: "tool", Ts: ts, Blocks: []cBlock{{Kind: "tool_result", Text: clip(out), ToolUseID: p.CallID, IsError: codexOutputIsError(out)}}}
	}
	return nil
}

// parseCodexEvent 解析 event_msg；仅 mcp_tool_call_end 无 response_item 对应，需在此渲染。
func parseCodexEvent(payload json.RawMessage, ts string) *cMsg {
	var p struct {
		Type       string `json:"type"`
		Invocation struct {
			Server    string          `json:"server"`
			Tool      string          `json:"tool"`
			Arguments json.RawMessage `json:"arguments"`
		} `json:"invocation"`
		Result json.RawMessage `json:"result"`
	}
	if json.Unmarshal(payload, &p) != nil || p.Type != "mcp_tool_call_end" {
		return nil
	}
	name := "mcp:" + p.Invocation.Server + "." + p.Invocation.Tool
	return &cMsg{Role: "tool", Ts: ts, Blocks: []cBlock{
		{Kind: "tool_use", Name: name, Input: clip(string(p.Invocation.Arguments))},
		{Kind: "tool_result", Text: clip(codexOutputText(p.Result))},
	}}
}

// parseCodexLine 把一行 rollout JSONL 解析成 cMsg；非对话行返回 nil。
func parseCodexLine(line string) *cMsg {
	var raw struct {
		Type    string          `json:"type"`
		Ts      string          `json:"timestamp"`
		Payload json.RawMessage `json:"payload"`
	}
	if json.Unmarshal([]byte(line), &raw) != nil {
		return nil
	}
	switch raw.Type {
	case "response_item":
		return parseCodexItem(raw.Payload, raw.Ts)
	case "event_msg":
		return parseCodexEvent(raw.Payload, raw.Ts)
	}
	return nil
}

// CodexTranscript GET /sessions/:name/codex-transcript?file=...&offset=N
// 与 ClaudeTranscript 同构：offset 为已消费物理行数，仅返回其后新内容（供增量轮询）。
func (a *API) CodexTranscript(c *gin.Context) {
	file := c.Query("file")
	if file == "" {
		if dir := paneToolDir(c.Param("name"), cmdlineHasCodex); dir != "" {
			file = newestCodexRollout(dir)
		}
	}
	// 安全：限制在 ~/.codex/sessions 下
	root := codexSessionsRoot()
	file = filepath.Clean(file)
	if file == "" || !strings.HasPrefix(file, root) {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"code": "BAD_FILE"}})
		return
	}
	offset, _ := strconv.Atoi(c.Query("offset"))

	f, err := os.Open(file)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"messages": []cMsg{}, "nextOffset": 0, "file": file}})
		return
	}
	defer f.Close()

	msgs := []cMsg{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 8*1024*1024)
	n := 0
	for sc.Scan() {
		n++
		if n <= offset {
			continue
		}
		if m := parseCodexLine(sc.Text()); m != nil {
			if m.ID == "" { // 行号作稳定 key（前端窗口化/折叠态持久化用）
				m.ID = strconv.Itoa(n)
			}
			msgs = append(msgs, *m)
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"messages": msgs, "nextOffset": n, "file": file}})
}
