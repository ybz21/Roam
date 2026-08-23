package agent

import (
	"strings"

	"ttmux-cli-go/internal/id"
)

func init() { Register(claude{}) }

// claude 是 Claude Code。
//
// 它是三件事都齐的那一型：能在启动时**指定**对话 id（--session-id），
// 于是「哪份 transcript 属于哪个会话」由构造保证，不用事后猜。
type claude struct{}

func (claude) Kind() string        { return "claude" }
func (claude) DisplayName() string { return "Claude Code" }
func (claude) Bin() string         { return "claude" }

// 靠 --session-id 指定。这是它和 codex 最要紧的区别：
// 关联由构造保证，会话死了、目录里又开过别的 agent，也认得回来。
func (claude) PinsConversationID() bool { return true }

func (claude) StartArgs(opt StartOpts) []string {
	var a []string
	if opt.Permission != "" {
		a = append(a, "--"+opt.Permission)
	}
	if opt.Model != "" {
		a = append(a, "--model", opt.Model)
	}
	if opt.ConvID != "" {
		a = append(a, "--session-id", opt.ConvID)
	}
	if opt.Prompt != "" {
		a = append(a, opt.Prompt)
	}
	return a
}

func (c claude) ResumeCommand(convID string) string {
	if strings.TrimSpace(convID) == "" {
		return ""
	}
	return c.Bin() + " --resume " + convID
}

// 用不上：这一型的 id 是我们指定的，不需要事后认。
func (claude) DetectConversationID(string) string { return "" }

// NewConversationID 生成一个待指定的对话 id。
// 成本为零，而少了它，会话死后就再也认不出「那段对话是哪一份 jsonl」。
func NewConversationID() string { return id.UUID() }
