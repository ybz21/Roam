package spawn

import (
	"os/exec"

	"strings"
	"ttmux-cli-go/internal/id"
)

// AgentConfig captures the knobs lib/agent.sh exposed via AGENT_* env vars.
type AgentConfig struct {
	ClaudeBin   string
	CodexBin    string
	Kind        string // claude | codex
	Interactive bool   // resident TUI member (vs one-shot task)
	Permission  string
	Model       string
	Workdir     string
	MaxTurns    string
	// SessionUUID 让我们**指定** Claude Code 那一侧的对话 id（--session-id）。
	// 不指定的话，「哪份 transcript 属于哪个会话」只能靠 cwd + 取最新文件猜，
	// 而会话一死这个猜法就失准（同目录的别的会话会赢）。指定之后关联由构造保证，
	// 台账把它记下来，M3 的「重开并接回原对话」才有依据。codex 没有对应参数，忽略。
	SessionUUID string
}

// withSessionID 在 claude 命令后追加 --session-id（只对 claude 有意义）。
func (c AgentConfig) withSessionID(b *strings.Builder) {
	if c.Kind != "codex" && c.SessionUUID != "" {
		b.WriteString(" --session-id " + c.SessionUUID)
	}
}

// DefaultAgentConfig mirrors _agent_defaults.
func DefaultAgentConfig(workdir string) AgentConfig {
	return AgentConfig{
		ClaudeBin:  lookPath("claude"),
		CodexBin:   lookPath("codex"),
		Kind:       "claude",
		Permission: "dangerously-skip-permissions",
		Workdir:    workdir,
		// 每个 agent 会话都自带一个对话 id。生成成本为零，而少了它，
		// 会话死后就再也认不出「那段对话是哪一份 jsonl」。
		SessionUUID: id.UUID(),
	}
}

func lookPath(bin string) string {
	if p, err := exec.LookPath(bin); err == nil {
		return p
	}
	return bin
}

// Command builds the shell command line that launches the agent, mirroring
// _agent_cmd → _agent_claude_cmd / _agent_codex_cmd.
func (c AgentConfig) Command(task string) string {
	if c.Kind == "codex" {
		return c.codexCommand(task)
	}
	return c.claudeCommand(task)
}

// CommandFromPromptFile builds the one-shot launch command with the task fed
// from a file on stdin. tmux send-keys 有命令长度上限(整段 diff 内联会报
// "command too long"),经会话拉起 Agent 的调用方必须用这个短命令形态。
func (c AgentConfig) CommandFromPromptFile(path string) string {
	if c.Kind == "codex" {
		return c.codexOneShotPrefix() + " < " + shellQuote(path)
	}
	return c.claudeOneShotPrefix() + " < " + shellQuote(path)
}

// InteractiveFromPromptFile builds the interactive-TUI launch command with the
// initial prompt read from a file("$(cat …)" 注入,同 swarm members 的手法:
// 多行 prompt 内联会被 send-keys 的换行当回车拆碎)。
func (c AgentConfig) InteractiveFromPromptFile(path string) string {
	bin := orDefault(c.ClaudeBin, "claude")
	var b strings.Builder
	if c.Kind == "codex" {
		bin = orDefault(c.CodexBin, "codex")
		b.WriteString("cd '" + c.Workdir + "' && " + bin)
		if c.Model != "" {
			b.WriteString(" -m " + c.Model)
		}
	} else {
		b.WriteString("cd '" + c.Workdir + "' && " + bin)
		if c.Model != "" {
			b.WriteString(" --model " + c.Model)
		}
		if c.Permission == "dangerously-skip-permissions" {
			b.WriteString(" --dangerously-skip-permissions")
		} else {
			b.WriteString(" --permission-mode " + c.Permission)
		}
	}
	c.withSessionID(&b)
	b.WriteString(` "$(cat ` + shellQuote(path) + `)"`)
	return b.String()
}

func (c AgentConfig) claudeCommand(task string) string {
	if c.Interactive {
		bin := orDefault(c.ClaudeBin, "claude")
		var b strings.Builder
		b.WriteString("cd '" + c.Workdir + "' && " + bin)
		if c.Model != "" {
			b.WriteString(" --model " + c.Model)
		}
		if c.Permission == "dangerously-skip-permissions" {
			b.WriteString(" --dangerously-skip-permissions")
		} else {
			b.WriteString(" --permission-mode " + c.Permission)
		}
		c.withSessionID(&b)
		b.WriteString(" " + shellQuote(task))
		return b.String()
	}
	return c.claudeOneShotPrefix() + heredoc(task)
}

func (c AgentConfig) claudeOneShotPrefix() string {
	bin := orDefault(c.ClaudeBin, "claude")
	var b strings.Builder
	b.WriteString("cd '" + c.Workdir + "' && " + bin + " -p")
	if c.Model != "" {
		b.WriteString(" --model " + c.Model)
	}
	if c.Permission == "dangerously-skip-permissions" {
		b.WriteString(" --dangerously-skip-permissions")
	} else {
		b.WriteString(" --permission-mode " + c.Permission)
	}
	if c.MaxTurns != "" {
		b.WriteString(" --max-turns " + c.MaxTurns)
	}
	b.WriteString(" --output-format text")
	return b.String()
}

func (c AgentConfig) codexCommand(task string) string {
	if c.Interactive {
		bin := orDefault(c.CodexBin, "codex")
		var b strings.Builder
		b.WriteString("cd '" + c.Workdir + "' && " + bin)
		if c.Model != "" {
			b.WriteString(" -m " + c.Model)
		}
		b.WriteString(" " + shellQuote(task))
		return b.String()
	}
	return c.codexOneShotPrefix() + heredoc(task)
}

func (c AgentConfig) codexOneShotPrefix() string {
	bin := orDefault(c.CodexBin, "codex")
	var b strings.Builder
	b.WriteString("cd '" + c.Workdir + "' && " + bin + " exec --skip-git-repo-check")
	if c.Model != "" {
		b.WriteString(" -m " + c.Model)
	}
	if c.Permission == "dangerously-skip-permissions" || c.Permission == "auto" {
		b.WriteString(" --dangerously-bypass-approvals-and-sandbox")
	}
	b.WriteString(" -")
	return b.String()
}

// heredoc appends a `<<'TTMUX_TASK_EOF'` block carrying the task verbatim,
// avoiding any quoting of the prompt body (matches lib/agent.sh).
func heredoc(task string) string {
	return " <<'TTMUX_TASK_EOF'\n" + task + "\nTTMUX_TASK_EOF"
}

// shellQuote single-quotes a string POSIX-safely (replacement for printf %q in
// the interactive path; single-quote wrapping is portable across shells).
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}
