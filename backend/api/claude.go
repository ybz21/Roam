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
	"sync"

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

// runningAgentSessions 一次性扫全部 pane 的进程树，返回跑着 claude / codex 的会话集合。
// 供项目列表批量判「活跃」——绿点语义（设计 W2）：agent 进程在跑才算活跃。避免前端
// 逐会话打 /claude+/codex（N×2 请求），也纠正原先拿 session_attached（有没有人 attach）
// 当活跃代理的误判：后台干活没人看=灰、开着终端却 idle=绿 的反相。
func runningAgentSessions() map[string]bool {
	out, err := exec.Command("tmux", "list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}").Output()
	if err != nil {
		return nil
	}
	children := procChildren()
	running := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 || running[parts[0]] {
			continue
		}
		pid, err := strconv.Atoi(parts[1])
		if err != nil {
			continue
		}
		if treeMatch(pid, children, 0, cmdlineHasClaude) || treeMatch(pid, children, 0, cmdlineHasCodex) {
			running[parts[0]] = true
		}
	}
	return running
}

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
	name := a.sessionTarget(c)
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

// 截断标记用哨兵而非中文：这条会直接进 API 响应给前端展示，文案必须由前端出译文
// （docs/development/i18n.md「会被前端直接展示的后端 API 消息」）。
const clipMark = "\n…[truncated]"

func clip(s string) string {
	if len(s) > blockCap {
		return s[:blockCap] + clipMark
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
				b.WriteString("[image]\n") // 同上：哨兵，前端出译文
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
			// 哨兵而非中文文案：这条会直接进 API 响应给前端展示，文案必须由前端出译文
			// （docs/development/i18n.md「会被前端直接展示的后端 API 消息」）
			blocks = append(blocks, cBlock{Kind: "thinking", Text: "[redacted_thinking]"})
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

// cStatus：会话的「当前状态」，随转录响应一起回给前端画状态条。
// 这些字段本来就躺在同一份 JSONL 里，只是此前 parseLine 一律返回 nil 丢掉了——
// 顺手在同一次扫描里捡出来，不额外开端点、不额外读一遍文件（见 15 设计 §11）。
type cStatus struct {
	Mode   string `json:"mode,omitempty"`   // default | plan | acceptEdits | bypassPermissions
	Model  string `json:"model,omitempty"`  // claude-opus-5 …
	Effort string `json:"effort,omitempty"` // 推理档
	Used   int    `json:"used,omitempty"`   // 已占上下文 token
	Window int    `json:"window,omitempty"` // 上下文窗口
	Branch string `json:"branch,omitempty"` // 当前 git 分支
	Cwd    string `json:"cwd,omitempty"`    // 工作目录
}

// 上下文窗口。**转录里的 message.model 靠不住**：它被剥成了 "claude-opus-5"，
// 不带 [1m] 变体标记，据它猜必然把 1M 会话算成 200k——实测本机 12 个会话里 11 个
// 的用量超过 200k（最高 999,263，顶在 1M 上但从没越过），全按 200k 算就是满屏 100%。
//
// 权威来源是 ~/.claude/settings.json 的 model 字段（形如 "opus[1m]"）。
// 前端还有一道兜底：真实用量超过后端给的窗口时自动升档，保证不会画出「100% 却还在涨」。
const defaultCtxWindow = 200000
const largeCtxWindow = 1000000

func hasOneM(model string) bool {
	return strings.Contains(model, "[1m]") || strings.Contains(model, "-1m")
}

// settings.json 每次请求都读一遍太浪费（对话页 1.5s 一轮），按 mtime 缓存。
var (
	settingsMu    sync.Mutex
	settingsModel string
	settingsMod   int64
)

func claudeSettingsModel() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	path := filepath.Join(home, ".claude", "settings.json")
	fi, err := os.Stat(path)
	if err != nil {
		return ""
	}
	mod := fi.ModTime().UnixNano()
	settingsMu.Lock()
	defer settingsMu.Unlock()
	if mod == settingsMod {
		return settingsModel
	}
	settingsMod, settingsModel = mod, ""
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var cfg struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(b, &cfg) == nil {
		settingsModel = cfg.Model
	}
	return settingsModel
}

func claudeWindow(model string) int {
	if hasOneM(model) || hasOneM(claudeSettingsModel()) {
		return largeCtxWindow
	}
	return defaultCtxWindow
}

// scanStatus 从一行 JSONL 里更新状态；不是状态行就原样返回。
func scanStatus(line string, st cStatus) cStatus {
	var raw struct {
		Type           string `json:"type"`
		PermissionMode string `json:"permissionMode"`
		Effort         string `json:"effort"`
		GitBranch      string `json:"gitBranch"`
		Cwd            string `json:"cwd"`
		Message        struct {
			Model string `json:"model"`
			Usage struct {
				Input      int `json:"input_tokens"`
				CacheRead  int `json:"cache_read_input_tokens"`
				CacheWrite int `json:"cache_creation_input_tokens"`
			} `json:"usage"`
		} `json:"message"`
	}
	if json.Unmarshal([]byte(line), &raw) != nil {
		return st
	}
	if raw.PermissionMode != "" {
		st.Mode = raw.PermissionMode
	}
	if raw.Effort != "" {
		st.Effort = raw.Effort
	}
	// 分支/工作目录挂在每条 user/assistant 行上，取最后一次即当前值
	if raw.GitBranch != "" {
		st.Branch = raw.GitBranch
	}
	if raw.Cwd != "" {
		st.Cwd = raw.Cwd
	}
	if raw.Type == "assistant" && raw.Message.Model != "" {
		st.Model = raw.Message.Model
		st.Window = claudeWindow(raw.Message.Model)
		// 上下文占用 = 本轮真正喂进去的量（新增 + 命中缓存 + 写入缓存）。
		// 压缩后 cache_read 归零重来，百分比自然回落，不用特殊处理。
		if u := raw.Message.Usage; u.Input+u.CacheRead+u.CacheWrite > 0 {
			st.Used = u.Input + u.CacheRead + u.CacheWrite
		}
	}
	return st
}

// ClaudeTranscript GET /sessions/:name/transcript?file=...&offset=N
// 解析 JSONL 为对话；offset 为已消费的物理行数，仅返回其后的新内容（供前端增量轮询）。
func (a *API) ClaudeTranscript(c *gin.Context) {
	file := c.Query("file")
	if file == "" { // 未传则按会话现场定位
		if dir := paneClaudeDir(a.sessionTarget(c)); dir != "" {
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
	st := cStatus{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 8*1024*1024) // 容纳长行
	n := 0
	for sc.Scan() {
		n++
		if n <= offset {
			continue
		}
		line := sc.Text()
		st = scanStatus(line, st)
		if m := parseLine(line); m != nil {
			if m.ID == "" { // uuid 缺失时用行号兜底，保证稳定 key
				m.ID = strconv.Itoa(n)
			}
			msgs = append(msgs, *m)
		}
	}
	// 这一轮没扫到新行时 status 是空的；前端 sticky 保留上一次的值。
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"messages": msgs, "nextOffset": n, "file": file, "status": st}})
}
