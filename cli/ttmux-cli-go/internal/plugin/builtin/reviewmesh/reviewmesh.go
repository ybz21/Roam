// Package reviewmesh is the builtin peer-review plugin case(设计见
// docs/design/plugin/03-stories.md 故事一与 docs/design/智能评审插件设计.md):
// 对当前工作区 diff 拉起一个 reviewer Agent(codex 优先),解析其结构化
// findings 写回 Finding API,并发布通知(飞书 sink 会转发)。
package reviewmesh

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"ttmux-cli-go/internal/plugin/sdk"
)

const (
	findingsBegin = "TTMUX_FINDINGS_BEGIN"
	findingsEnd   = "TTMUX_FINDINGS_END"
)

// Activate registers the plugin's commands (sdk.Serve 的入口).
func Activate(ctx *sdk.Ctx) sdk.Plugin {
	return sdk.Plugin{
		Commands: map[string]sdk.CommandHandler{
			"review": review,
			"status": status,
		},
		Events: map[string]sdk.EventHandler{
			// wait=false 模式下由 plugind watcher 在会话退出时唤醒收尾
			"session:agent.exited": onAgentExited,
		},
	}
}

func onAgentExited(ctx *sdk.Ctx, payload json.RawMessage) error {
	var ev struct {
		Session string            `json:"session"`
		Job     string            `json:"job"`
		Labels  map[string]string `json:"labels"`
	}
	if err := json.Unmarshal(payload, &ev); err != nil {
		return err
	}
	if ev.Labels["role"] != "reviewer" {
		return nil // 不是本插件的 reviewer 会话,忽略
	}
	res, err := finalize(ctx, ev.Job, ev.Session)
	if err != nil {
		return err
	}
	ctx.Logf("job %s finalized asynchronously: %d findings (%d blocking)", ev.Job, len(res.Findings), res.Blocking)
	return nil
}

type reviewResult struct {
	Job      string        `json:"job"`
	Session  string        `json:"session"`
	Provider string        `json:"provider"`
	Findings []sdk.Finding `json:"findings,omitempty"`
	Blocking int           `json:"blocking"`
	Summary  string        `json:"summary,omitempty"`
	Waited   bool          `json:"waited"`
}

func review(ctx *sdk.Ctx, args map[string]string) (any, error) {
	diff, err := ctx.WorkspaceDiff()
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(diff.Diff) == "" {
		return nil, fmt.Errorf("workspace has no reviewable diff")
	}

	provider := args["provider"]
	if provider == "" {
		provider = pickProvider(ctx)
	}
	jobID := fmt.Sprintf("j%d", time.Now().Unix()%1000000)
	session := fmt.Sprintf("review-mesh-%s-rv1", jobID)

	sess, err := ctx.AgentSpawn(sdk.SpawnReq{
		Provider:    provider,
		Prompt:      reviewerPrompt(diff),
		SessionName: session,
		Job:         jobID,
		Labels:      map[string]string{"job": jobID, "role": "reviewer"},
	})
	if err != nil {
		return nil, err
	}
	ctx.Logf("job %s: reviewer %s spawned in session %s", jobID, provider, sess)

	res := reviewResult{Job: jobID, Session: sess, Provider: provider}
	if args["wait"] == "false" {
		// 不等待:留给 plugind watcher 在 agent.exited 时收尾(daemon 模式)。
		return res, nil
	}

	done, err := ctx.SessionWait(sess, 1800)
	if err != nil {
		return nil, err
	}
	if !done {
		return nil, fmt.Errorf("reviewer session %s did not finish in time (attach with: ttmux a %s)", sess, sess)
	}
	fin, err := finalize(ctx, jobID, sess)
	if err != nil {
		return nil, err
	}
	fin.Provider = provider
	fin.Waited = true
	return fin, nil
}

// finalize parses the reviewer session output, persists findings and
// publishes the summary notification. 同步(--wait)与异步(watcher 事件)
// 两条路径共用。
func finalize(ctx *sdk.Ctx, jobID, sess string) (*reviewResult, error) {
	logText, err := ctx.SessionLog(sess)
	if err != nil {
		return nil, err
	}
	findings, summary, err := ParseFindings(logText)
	if err != nil {
		return nil, fmt.Errorf("reviewer output not parseable: %w (inspect: ttmux capture %s)", err, sess)
	}
	res := &reviewResult{Job: jobID, Session: sess, Summary: summary}
	for i := range findings {
		findings[i].Job = jobID
		id, err := ctx.FindingCreate(findings[i])
		if err != nil {
			return nil, err
		}
		findings[i].ID = id
		if findings[i].Severity == "high" {
			res.Blocking++
		}
	}
	res.Findings = findings

	notifType := "review.completed"
	severity := "info"
	title := fmt.Sprintf("互审完成:%d 个 finding", len(findings))
	if res.Blocking > 0 {
		notifType = "finding.blocking"
		severity = "high"
		title = fmt.Sprintf("互审发现 %d 个 blocking finding(共 %d 个)", res.Blocking, len(findings))
	}
	body := summary
	for _, f := range findings {
		body += fmt.Sprintf("\n- [%s] %s", f.Severity, f.Title)
	}
	if err := ctx.NotificationPublish(sdk.Notification{
		Type: notifType, Severity: severity, Title: title,
		Body: strings.TrimSpace(body), DedupeKey: "review-mesh." + jobID,
	}); err != nil {
		ctx.Logf("notification publish failed: %v", err)
	}
	return res, nil
}

func status(ctx *sdk.Ctx, args map[string]string) (any, error) {
	findings, err := ctx.FindingList(args["job"], args["status"])
	if err != nil {
		return nil, err
	}
	open, blocking := 0, 0
	for _, f := range findings {
		if f.Status == "open" {
			open++
			if f.Severity == "high" {
				blocking++
			}
		}
	}
	return map[string]any{
		"total": len(findings), "open": open, "blocking": blocking,
		"findings": findings,
	}, nil
}

func pickProvider(ctx *sdk.Ctx) string {
	providers, err := ctx.AgentProviders()
	if err == nil {
		// codex 审 claude 的活,反向互审是默认策略(智能评审插件设计 §3)
		if providers["codex"] {
			return "codex"
		}
		if providers["claude"] {
			return "claude"
		}
	}
	return "claude"
}

func reviewerPrompt(diff sdk.DiffResult) string {
	var b strings.Builder
	b.WriteString("你是一名严格的资深代码评审员,对下面的变更做 peer review。\n")
	b.WriteString("要求:\n")
	b.WriteString("- 只报告真实、可定位的问题(bug、安全、数据丢失、明显性能问题),不要风格意见。\n")
	b.WriteString("- 每个问题给出文件路径与行号(基于 diff 的新文件行号)。\n")
	b.WriteString("- severity 取 high(必须阻塞合并)/ medium / low。\n")
	b.WriteString("- 没有问题就输出空数组,不要编造。\n\n")
	b.WriteString("输出格式(严格遵守,便于机器解析):\n")
	b.WriteString("1) 先输出一行总结:REVIEW_SUMMARY: <一句话结论>\n")
	b.WriteString(fmt.Sprintf("2) 然后在 %s 与 %s 两个标记行之间输出 JSON 数组,元素形如:\n", findingsBegin, findingsEnd))
	b.WriteString(`   {"severity":"high","title":"...","file":"path/to/file.go","line":42,"detail":"..."}` + "\n\n")
	b.WriteString(fmt.Sprintf("当前分支: %s\n变更统计:\n%s\n", diff.Branch, diff.Stat))
	b.WriteString("完整 diff:\n```diff\n" + diff.Diff + "\n```\n")
	return b.String()
}

var summaryRe = regexp.MustCompile(`REVIEW_SUMMARY:\s*(.+)`)

// ParseFindings extracts the fenced findings JSON and summary line from the
// reviewer session log. Exported for unit tests.
func ParseFindings(logText string) ([]sdk.Finding, string, error) {
	summary := ""
	// 取最后一次匹配:会话日志里 prompt 回显也含 REVIEW_SUMMARY 占位行
	if ms := summaryRe.FindAllStringSubmatch(logText, -1); len(ms) > 0 {
		summary = strings.TrimSpace(ms[len(ms)-1][1])
	}
	if strings.HasPrefix(summary, "<") { // reviewer 未输出总结时残留占位符
		summary = ""
	}
	begin := strings.LastIndex(logText, findingsBegin)
	end := strings.LastIndex(logText, findingsEnd)
	if begin < 0 || end < 0 || end <= begin {
		return nil, summary, fmt.Errorf("markers %s/%s not found", findingsBegin, findingsEnd)
	}
	raw := logText[begin+len(findingsBegin) : end]
	// 剥掉可能的代码栅栏与终端噪音,定位第一个 [ 到最后一个 ]
	i, j := strings.Index(raw, "["), strings.LastIndex(raw, "]")
	if i < 0 || j <= i {
		return []sdk.Finding{}, summary, nil // 空数组:reviewer 没发现问题
	}
	var findings []sdk.Finding
	if err := json.Unmarshal([]byte(raw[i:j+1]), &findings); err != nil {
		return nil, summary, fmt.Errorf("findings JSON invalid: %w", err)
	}
	for k := range findings {
		if findings[k].Severity == "" {
			findings[k].Severity = "medium"
		}
	}
	return findings, summary, nil
}
