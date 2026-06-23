package spawn

import (
	"os/exec"
	"strings"
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
}

// DefaultAgentConfig mirrors _agent_defaults.
func DefaultAgentConfig(workdir string) AgentConfig {
	return AgentConfig{
		ClaudeBin:  lookPath("claude"),
		CodexBin:   lookPath("codex"),
		Kind:       "claude",
		Permission: "dangerously-skip-permissions",
		Workdir:    workdir,
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

func (c AgentConfig) claudeCommand(task string) string {
	bin := orDefault(c.ClaudeBin, "claude")
	if c.Interactive {
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
		b.WriteString(" " + shellQuote(task))
		return b.String()
	}
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
	b.WriteString(heredoc(task))
	return b.String()
}

func (c AgentConfig) codexCommand(task string) string {
	bin := orDefault(c.CodexBin, "codex")
	if c.Interactive {
		var b strings.Builder
		b.WriteString("cd '" + c.Workdir + "' && " + bin)
		if c.Model != "" {
			b.WriteString(" -m " + c.Model)
		}
		b.WriteString(" " + shellQuote(task))
		return b.String()
	}
	var b strings.Builder
	b.WriteString("cd '" + c.Workdir + "' && " + bin + " exec --skip-git-repo-check")
	if c.Model != "" {
		b.WriteString(" -m " + c.Model)
	}
	if c.Permission == "dangerously-skip-permissions" || c.Permission == "auto" {
		b.WriteString(" --dangerously-bypass-approvals-and-sandbox")
	}
	b.WriteString(" -")
	b.WriteString(heredoc(task))
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
