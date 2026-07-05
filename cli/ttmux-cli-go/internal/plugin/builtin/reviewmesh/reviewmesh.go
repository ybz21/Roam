// Package reviewmesh is the builtin peer-review plugin case(设计见
// docs/design/plugin/03-stories.md 故事一与 docs/design/智能评审插件设计.md):
// 对当前工作区 diff 拉起一个 reviewer Agent(codex 优先),解析其结构化
// findings 写回 Finding API,并发布通知(飞书 sink 会转发)。
package reviewmesh

import (
	"crypto/sha1"
	"encoding/json"
	"fmt"
	"os"
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
			"watch":  watch,
		},
		Events: map[string]sdk.EventHandler{
			// wait=false 模式下由 plugind watcher 在会话退出时唤醒收尾
			"session:agent.exited": onAgentExited,
		},
	}
}

// watch 在独立监控会话里陪跑一个开发会话(建会话勾「自动互审」时由
// plugin track 拉起):画面静止 ≥30s 判定"一轮对话结束"→ 互审 → 意见
// send 回原会话让 Agent 修改 → 修完再次空闲则复审;同一份 diff 只审一次,
// 最多 maxAutoRounds 轮(防互相无限循环,智能评审插件设计 §10.1)。
func watch(ctx *sdk.Ctx, args map[string]string) (any, error) {
	dev, workdir := args["session"], args["workdir"]
	if dev == "" || workdir == "" {
		return nil, fmt.Errorf("usage: review-mesh.watch --session <dev> --workdir <abs-dir>")
	}
	ctx.Logf("watch: monitoring %s (workdir %s)", dev, workdir)
	fmt.Fprintf(os.Stderr, "== review-mesh 监控 %s ==\n对话空闲 30s 即互审;意见自动回灌;同一 diff 只审一次,最多 %d 轮\n", dev, maxAutoRounds)

	lastPane, stableSince := "", time.Time{}
	for {
		out, err := ctx.SessionCapture(dev, 40)
		if err != nil { // 会话没了:收尾前做最后一轮兜底互审
			fmt.Fprintf(os.Stderr, "[%s] 开发会话已结束,做收尾检查\n", time.Now().Format("15:04:05"))
			_, _ = autoReviewOnce(ctx, dev, workdir, true)
			return map[string]string{"stopped": "session exited"}, nil
		}
		sum := fmt.Sprintf("%x", sha1.Sum([]byte(out)))
		if sum != lastPane {
			lastPane, stableSince = sum, time.Now()
		} else if time.Since(stableSince) >= 30*time.Second {
			reviewed, err := autoReviewOnce(ctx, dev, workdir, true)
			if err != nil {
				fmt.Fprintf(os.Stderr, "[%s] 互审失败: %v\n", time.Now().Format("15:04:05"), err)
			}
			if reviewed {
				lastPane = "" // 回灌后画面会变;重置指纹等下一轮
			}
		}
		time.Sleep(5 * time.Second)
	}
}

const maxAutoRounds = 3

type autoState struct {
	LastDiff string `json:"lastDiff"`
	Rounds   int    `json:"rounds"`
}

// autoReviewOnce 对 dev 会话的 workdir 做一轮受控互审:diff 为空/未变化/
// 轮次用尽都跳过;wait 时等 reviewer 收尾并把 findings send 回 dev 会话,
// 不 wait 则只拉起(收尾由 reviewer 退出事件完成)。返回是否真的审了。
func autoReviewOnce(ctx *sdk.Ctx, dev, workdir string, wait bool) (bool, error) {
	diff, err := ctx.WorkspaceDiff(workdir)
	if err != nil {
		return false, err
	}
	if strings.TrimSpace(diff.Diff) == "" {
		return false, nil
	}
	diffSum := fmt.Sprintf("%x", sha1.Sum([]byte(diff.Diff)))

	stateKey := "auto:" + dev
	st := autoState{}
	if raw, err := ctx.StorageGet(stateKey); err == nil && raw != "" {
		_ = json.Unmarshal([]byte(raw), &st)
	}
	if st.LastDiff == diffSum {
		return false, nil // 这份变更已审过(空闲但没新改动,或复审后未再动)
	}
	if st.Rounds >= maxAutoRounds {
		fmt.Fprintf(os.Stderr, "[%s] 已达 %d 轮上限,不再自动复审(手动: ttmux plugin run review-mesh.review --workdir %s)\n",
			time.Now().Format("15:04:05"), maxAutoRounds, workdir)
		return false, nil
	}

	fmt.Fprintf(os.Stderr, "[%s] 第 %d 轮互审开始…\n", time.Now().Format("15:04:05"), st.Rounds+1)
	res, err := launchReviewManaged(ctx, workdir, "", wait)
	if err != nil {
		return false, err
	}
	st.LastDiff, st.Rounds = diffSum, st.Rounds+1
	raw, _ := json.Marshal(st)
	_ = ctx.StorageSet(stateKey, string(raw))
	if !wait {
		return true, nil
	}

	done, err := ctx.SessionWait(res.Session, 1800)
	if err != nil || !done {
		return true, fmt.Errorf("reviewer %s 未在时限内完成", res.Session)
	}
	fin, err := finalize(ctx, res.Job, res.Session)
	if err != nil {
		return true, err
	}
	fmt.Fprintf(os.Stderr, "[%s] 第 %d 轮完成:%d 个 finding(blocking %d)\n",
		time.Now().Format("15:04:05"), st.Rounds, len(fin.Findings), fin.Blocking)

	if len(fin.Findings) > 0 && ctx.SessionAlive(dev) {
		msg := fixPrompt(res.Job, fin.Findings)
		if err := ctx.SessionSend(dev, msg); err != nil {
			fmt.Fprintf(os.Stderr, "回灌失败: %v\n", err)
		} else {
			fmt.Fprintf(os.Stderr, "[%s] 意见已回灌 %s,等待修复后复审\n", time.Now().Format("15:04:05"), dev)
		}
	}
	return true, nil
}

// fixPrompt 是回灌给开发会话的单行修复指令(交互 TUI 里换行即提交)。
func fixPrompt(job string, findings []sdk.Finding) string {
	var b strings.Builder
	fmt.Fprintf(&b, "【review-mesh 互审 %s】发现 %d 个问题,请逐一修复: ", job, len(findings))
	for i, f := range findings {
		loc := f.File
		if f.Line > 0 {
			loc = fmt.Sprintf("%s:%d", f.File, f.Line)
		}
		fmt.Fprintf(&b, "%d) [%s] %s(%s)— %s ", i+1, f.Severity, f.Title, loc, oneline(f.Detail, 160))
	}
	b.WriteString("。修复完成后简要说明即可,我会自动复审。")
	return b.String()
}

func oneline(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) > max {
		return string(r[:max]) + "…"
	}
	return s
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
	switch {
	case ev.Labels["role"] == "reviewer":
		if ev.Labels["managed"] == "watch" {
			return nil // watch 陪跑在同步收尾,这里不重复 finalize(防双份 finding/通知)
		}
		// 自己 spawn 的 reviewer 完成 → 收尾(解析 findings、落库、发通知)
		res, err := finalize(ctx, ev.Job, ev.Session)
		if err != nil {
			return err
		}
		ctx.Logf("job %s finalized asynchronously: %d findings (%d blocking)", ev.Job, len(res.Findings), res.Blocking)
		return nil
	case ev.Labels["review:auto"] == "true":
		// 被跟踪的开发会话消亡:兜底一轮互审(监控会话在位时通常已审过,
		// 同一 diff 由存储哈希去重)。不等待收尾——reviewer 退出后走上面分支。
		workdir := ev.Labels["workdir"]
		if workdir == "" {
			ctx.Logf("auto-review skipped for %s: no workdir label", ev.Session)
			return nil
		}
		reviewed, err := autoReviewOnce(ctx, ev.Session, workdir, false)
		if err != nil {
			ctx.Logf("auto-review for %s (%s): %v", ev.Session, workdir, err)
			return nil // 无 diff 等情况不算错误,不重试
		}
		if reviewed {
			ctx.Logf("final auto-review launched for exited session %s", ev.Session)
		}
		return nil
	}
	return nil // 与本插件无关的会话,忽略
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
	res, err := launchReview(ctx, args["workdir"], args["provider"])
	if err != nil {
		return nil, err
	}
	if args["wait"] == "false" {
		// 不等待:留给 plugind watcher 在 agent.exited 时收尾(daemon 模式)。
		return res, nil
	}

	done, err := ctx.SessionWait(res.Session, 1800)
	if err != nil {
		return nil, err
	}
	if !done {
		return nil, fmt.Errorf("reviewer session %s did not finish in time (attach with: ttmux a %s)", res.Session, res.Session)
	}
	fin, err := finalize(ctx, res.Job, res.Session)
	if err != nil {
		return nil, err
	}
	fin.Provider = res.Provider
	fin.Waited = true
	return fin, nil
}

// launchReview takes the workspace diff (workdir 为空时用宿主注入的工作区)
// and spawns a reviewer agent session. 命令(--wait)与自动互审共用。
func launchReview(ctx *sdk.Ctx, workdir, provider string) (*reviewResult, error) {
	return launchReviewManaged(ctx, workdir, provider, false)
}

// launchReviewManaged 额外标记 reviewer 是否由 watch 同步收尾(managed=watch):
// plugind 的 reviewer 退出事件看到该标记会跳过 finalize,避免双份收尾。
func launchReviewManaged(ctx *sdk.Ctx, workdir, provider string, managedByWatch bool) (*reviewResult, error) {
	diff, err := ctx.WorkspaceDiff(workdir)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(diff.Diff) == "" {
		return nil, fmt.Errorf("workspace has no reviewable diff")
	}
	if provider == "" {
		provider = ctx.Config["provider"] // 设置页配置的默认 reviewer
	}
	if provider == "" {
		provider = pickProvider(ctx)
	}
	jobID := fmt.Sprintf("j%d", time.Now().Unix()%1000000)
	session := fmt.Sprintf("review-mesh-%s-rv1", jobID)

	labels := map[string]string{"job": jobID, "role": "reviewer"}
	if managedByWatch {
		labels["managed"] = "watch"
	}
	sess, err := ctx.AgentSpawn(sdk.SpawnReq{
		Provider:    provider,
		Prompt:      reviewerPrompt(diff),
		SessionName: session,
		Workdir:     workdir,
		Job:         jobID,
		Labels:      labels,
	})
	if err != nil {
		return nil, err
	}
	ctx.Logf("job %s: reviewer %s spawned in session %s", jobID, provider, sess)
	return &reviewResult{Job: jobID, Session: sess, Provider: provider}, nil
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
