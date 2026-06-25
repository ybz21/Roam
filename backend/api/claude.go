// Claude Code 集成：检测会话是否在跑 claude，并把其对话记录(JSONL)解析成可渲染的对话。
//
// 机制：会话里运行的是交互式 claude（一个进程）。本模块只「读」它的 JSONL 记录渲染成
// 对话气泡；「发」消息复用 ttmux send（send-keys 注入该会话），不另起 claude 进程，避免冲突。
package api

import (
	"bufio"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

// 工作目录 → ~/.claude/projects 下的目录名（非字母数字一律换成 -，与 Claude Code 一致）
var nonAlnum = regexp.MustCompile(`[^a-zA-Z0-9]`)

func encodeProject(dir string) string { return nonAlnum.ReplaceAllString(dir, "-") }

// procChildren 扫描 /proc，构建 ppid → []pid 的子进程映射。
func procChildren() map[int][]int {
	m := map[int][]int{}
	ents, err := os.ReadDir("/proc")
	if err == nil {
		for _, e := range ents {
			pid, err := strconv.Atoi(e.Name())
			if err != nil {
				continue
			}
			// /proc/<pid>/stat: "pid (comm) state ppid ..."，comm 可能含空格/括号，取末尾 ')' 后再切
			b, err := os.ReadFile(filepath.Join("/proc", e.Name(), "stat"))
			if err != nil {
				continue
			}
			s := string(b)
			i := strings.LastIndexByte(s, ')')
			if i < 0 || i+2 >= len(s) {
				continue
			}
			fields := strings.Fields(s[i+2:]) // state ppid ...
			if len(fields) < 2 {
				continue
			}
			ppid, err := strconv.Atoi(fields[1])
			if err != nil {
				continue
			}
			m[ppid] = append(m[ppid], pid)
		}
		return m
	}

	out, err := exec.Command("ps", "-axo", "pid=", "-o", "ppid=").Output()
	if err != nil {
		return m
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		ppid, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		m[ppid] = append(m[ppid], pid)
	}
	return m
}

func processCmdline(pid int) string {
	b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "cmdline"))
	if err == nil {
		return strings.ToLower(strings.ReplaceAll(string(b), "\x00", " "))
	}
	out, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "command=").Output()
	if err != nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(string(out)))
}

// cmdlineHasClaude 判断进程命令行是否是 claude。
func cmdlineHasClaude(pid int) bool {
	cl := processCmdline(pid)
	// 命令行里出现独立的 claude 段（claude / .../claude / node ... claude）
	return strings.Contains(cl, "claude") && !strings.Contains(cl, "claude-code-webui")
}

// treeMatch 从 pid 起 DFS 子进程树，任一进程命中 match 即返回 true。
func treeMatch(pid int, children map[int][]int, depth int, match func(int) bool) bool {
	if depth > 12 {
		return false
	}
	if match(pid) {
		return true
	}
	for _, ch := range children[pid] {
		if treeMatch(ch, children, depth+1, match) {
			return true
		}
	}
	return false
}

// paneToolDir 返回会话中进程树命中 match（某交互式 CLI）的 pane 的工作目录；没有则返回 ""。
func paneToolDir(name string, match func(int) bool) string {
	out, err := exec.Command("tmux", "list-panes", "-t", name, "-F", "#{pane_pid}\t#{pane_current_path}").Output()
	if err != nil {
		return ""
	}
	children := procChildren()
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 {
			continue
		}
		pid, err := strconv.Atoi(parts[0])
		if err != nil {
			continue
		}
		if treeMatch(pid, children, 0, match) {
			return parts[1]
		}
	}
	return ""
}

// paneClaudeDir 返回会话中正在跑 claude 的 pane 的工作目录；没有则返回 ""。
func paneClaudeDir(name string) string { return paneToolDir(name, cmdlineHasClaude) }

// newestJSONL 返回目录中最近修改的 .jsonl（即当前活跃会话记录）。
func newestJSONL(dir string) string {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	best, bestMod := "", int64(0)
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		if m := fi.ModTime().UnixNano(); m > bestMod {
			bestMod, best = m, filepath.Join(dir, e.Name())
		}
	}
	return best
}

// ClaudeStatus GET /sessions/:name/claude —— 检测会话是否在跑 claude，并定位其 JSONL。
func (a *API) ClaudeStatus(c *gin.Context) {
	name := sessionParam(c)
	dir := paneClaudeDir(name)
	if dir == "" {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"running": false}})
		return
	}
	home, _ := os.UserHomeDir()
	pdir := filepath.Join(home, ".claude", "projects", encodeProject(dir))
	file := newestJSONL(pdir)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"running": true, "dir": dir, "file": file}})
}

// ── JSONL → 可渲染对话 ──

type cBlock struct {
	Kind      string `json:"kind"`                // text | thinking | tool_use | tool_result
	Text      string `json:"text,omitempty"`      // text/thinking/tool_result 文本
	Name      string `json:"name,omitempty"`      // tool_use 工具名
	Input     string `json:"input,omitempty"`     // tool_use 入参(JSON 字符串)
	ID        string `json:"id,omitempty"`        // tool_use 的 id（供前端把结果挂到调用下）
	ToolUseID string `json:"toolUseId,omitempty"` // tool_result 对应的 tool_use id
	IsError   bool   `json:"isError,omitempty"`   // tool_result 是否报错
}

type cMsg struct {
	Role   string   `json:"role"` // user | assistant | tool
	Blocks []cBlock `json:"blocks"`
	Ts     string   `json:"ts,omitempty"`
	ID     string   `json:"id,omitempty"` // 行 uuid，供前端做稳定 key（保住折叠态）
}

const blockCap = 6000 // 单块文本上限，避免巨大 tool 输出撑爆响应

func clip(s string) string {
	if len(s) > blockCap {
		return s[:blockCap] + "\n…(已截断)"
	}
	return s
}

// rawContentText 把 tool_result 的 content（字符串或 [{type:text,text}]）抽成纯文本。
func rawContentText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var arr []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &arr) == nil {
		var b strings.Builder
		for _, x := range arr {
			switch x.Type {
			case "image":
				b.WriteString("[图片]\n")
			default:
				b.WriteString(x.Text)
			}
		}
		return strings.TrimRight(b.String(), "\n")
	}
	// 其它结构（对象等）：原样回退为紧凑 JSON，至少不丢信息
	return string(raw)
}

// parseLine 把一行 JSONL 解析成 cMsg；非对话行（mode/snapshot/system 等）返回 nil。
func parseLine(line string) *cMsg {
	var raw struct {
		Type    string `json:"type"`
		Ts      string `json:"timestamp"`
		UUID    string `json:"uuid"`
		Message struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal([]byte(line), &raw) != nil {
		return nil
	}
	if raw.Type != "user" && raw.Type != "assistant" {
		return nil
	}

	// content 可能是纯字符串（用户键入）
	var str string
	if json.Unmarshal(raw.Message.Content, &str) == nil {
		str = strings.TrimSpace(str)
		if str == "" {
			return nil
		}
		return &cMsg{Role: "user", Ts: raw.Ts, ID: raw.UUID, Blocks: []cBlock{{Kind: "text", Text: clip(str)}}}
	}

	// 否则是块数组
	var arr []struct {
		Type      string          `json:"type"`
		Text      string          `json:"text"`
		Thinking  string          `json:"thinking"`
		Name      string          `json:"name"`
		Input     json.RawMessage `json:"input"`
		Content   json.RawMessage `json:"content"`
		ID        string          `json:"id"`
		ToolUseID string          `json:"tool_use_id"`
		IsError   bool            `json:"is_error"`
	}
	if json.Unmarshal(raw.Message.Content, &arr) != nil {
		return nil
	}

	role := raw.Type
	var blocks []cBlock
	for _, b := range arr {
		switch b.Type {
		case "text":
			if t := strings.TrimSpace(b.Text); t != "" {
				blocks = append(blocks, cBlock{Kind: "text", Text: clip(t)})
			}
		case "thinking":
			if t := strings.TrimSpace(b.Thinking); t != "" {
				blocks = append(blocks, cBlock{Kind: "thinking", Text: clip(t)})
			}
		case "redacted_thinking":
			blocks = append(blocks, cBlock{Kind: "thinking", Text: "（思考内容已加密，无法展示）"})
		case "tool_use":
			blocks = append(blocks, cBlock{Kind: "tool_use", Name: b.Name, Input: clip(string(b.Input)), ID: b.ID})
		case "tool_result":
			role = "tool"
			blocks = append(blocks, cBlock{Kind: "tool_result", Text: clip(rawContentText(b.Content)), ToolUseID: b.ToolUseID, IsError: b.IsError})
		}
	}
	if len(blocks) == 0 {
		return nil
	}
	return &cMsg{Role: role, Ts: raw.Ts, ID: raw.UUID, Blocks: blocks}
}

// ClaudeTranscript GET /sessions/:name/transcript?file=...&offset=N
// 解析 JSONL 为对话；offset 为已消费的物理行数，仅返回其后的新内容（供前端增量轮询）。
func (a *API) ClaudeTranscript(c *gin.Context) {
	file := c.Query("file")
	if file == "" { // 未传则按会话现场定位
		if dir := paneClaudeDir(sessionParam(c)); dir != "" {
			home, _ := os.UserHomeDir()
			file = newestJSONL(filepath.Join(home, ".claude", "projects", encodeProject(dir)))
		}
	}
	// 安全：限制在 ~/.claude/projects 下
	home, _ := os.UserHomeDir()
	root := filepath.Join(home, ".claude", "projects")
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
	sc.Buffer(make([]byte, 1024*1024), 8*1024*1024) // 容纳长行
	n := 0
	for sc.Scan() {
		n++
		if n <= offset {
			continue
		}
		if m := parseLine(sc.Text()); m != nil {
			if m.ID == "" { // uuid 缺失时用行号兜底，保证稳定 key
				m.ID = strconv.Itoa(n)
			}
			msgs = append(msgs, *m)
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"messages": msgs, "nextOffset": n, "file": file}})
}
