// Package agent 是「一型 agent 与 Roam 的契约」。
//
// Roam 要对一个 agent 做三件事：把它拉起来、记住它这段对话是哪一段、
// 会话被机器重启带走后把那段对话接回来。这三件事每一型的做法都不同：
//
//	                 指定对话 id            接回一段对话
//	claude   --session-id <uuid>（我们指定）  claude --resume <id>
//	codex    不支持（只能事后认）             codex resume <id>
//
// 从前这些差异散成一串 `if kind == "codex"`（spawn/agent.go、revive、collect
// 各判一次），加一型就得把这些地方全找一遍，漏一处就是那一型在某条路上悄悄失效——
// codex 的 resume 早就能用了，而 revive 里一直写着「codex 没有对应参数」把它跳过。
//
// 现在收成一个接口 + 一张注册表：**新增一型只要实现 Agent 并 Register，
// 恢复、列表、spawn 三条路自动都认得它。**
package agent

import (
	"sort"
	"strings"
	"sync"
)

// Agent 一型 agent 的契约。实现放在同包下的 <kind>.go 里。
type Agent interface {
	// Kind 类型名，也是台账 sessions.agent_kind 的取值。全小写、稳定不变——
	// 它会被写进数据库，改名等于让老数据认不出自己。
	Kind() string

	// DisplayName 给人看的名字（"Claude Code" / "Codex"）。
	DisplayName() string

	// Bin 默认可执行名。调用方可用配置覆盖。
	Bin() string

	// PinsConversationID 启动时能否**指定**对话 id。
	//
	// 能（claude 的 --session-id）：关联由构造保证，最可靠。
	// 不能（codex）：只能靠 DetectConversationID 事后认，或者干脆认不出——
	// 那样这一型的会话恢复出来就只有壳，没有对话。
	PinsConversationID() bool

	// StartArgs 拉起它的参数（不含 Bin 本身）。
	// convID 非空且 PinsConversationID() 为真时，实现要把它注入进去。
	StartArgs(opt StartOpts) []string

	// ResumeCommand 在 shell 里敲什么能接回 convID 那段对话。
	// 返回空串 = 这一型接不回（调用方据此只开壳，不硬编一条命令上去）。
	ResumeCommand(convID string) string

	// DetectConversationID 事后认出某个工作目录下最近开的那段对话。
	// 只有 PinsConversationID() 为假的实现才需要认真做；返回空串表示认不出。
	//
	// 「认」天生带推断成分（同目录并发跑两个就可能认错），所以调用方应当
	// 只在无歧义时采信 —— 宁可没有对话 id，也别接回别人的对话。
	DetectConversationID(cwd string) string
}

// StartOpts 拉起 agent 时的可变部分。
type StartOpts struct {
	// ConvID 想指定的对话 id（PinsConversationID() 为假时实现应忽略它）。
	ConvID string
	// Model 模型名，空则用 agent 自己的默认。
	Model string
	// Permission 权限档（claude 的 --dangerously-skip-permissions 之类）。
	Permission string
	// Interactive 常驻 TUI（true）还是一次性任务（false）。
	Interactive bool
	// Prompt 首个提示词，可空。
	Prompt string
}

var (
	mu       sync.RWMutex
	registry = map[string]Agent{}
)

// Register 注册一型。同名重复注册会覆盖——init() 里各注册各的，正常不会撞。
func Register(a Agent) {
	mu.Lock()
	defer mu.Unlock()
	registry[a.Kind()] = a
}

// Get 按类型名取。认不出返回 nil —— 调用方**必须**处理这种情况：
// 台账里可能存着旧版本写下的、或者别人手工改进去的 kind。
func Get(kind string) Agent {
	mu.RLock()
	defer mu.RUnlock()
	return registry[strings.ToLower(strings.TrimSpace(kind))]
}

// Kinds 已注册的类型名（有序，供 UI 列选项、CLI 校验参数用）。
func Kinds() []string {
	mu.RLock()
	defer mu.RUnlock()
	out := make([]string, 0, len(registry))
	for k := range registry {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Default 默认那一型。没有 claude 就退回排序第一个，一个都没有返回 nil。
func Default() Agent {
	if a := Get("claude"); a != nil {
		return a
	}
	if ks := Kinds(); len(ks) > 0 {
		return Get(ks[0])
	}
	return nil
}

// ResumeCommandFor 是给调用方的便捷入口：认不出类型、或这一型接不回，都返回空串。
//
// **接不回时返回空串而不是猜一条命令**：敲一条错的恢复命令比不敲更糟——
// 用户看到终端里跑起了什么，会以为对话接上了。
func ResumeCommandFor(kind, convID string) string {
	if convID == "" {
		return ""
	}
	a := Get(kind)
	if a == nil {
		return ""
	}
	return a.ResumeCommand(convID)
}
