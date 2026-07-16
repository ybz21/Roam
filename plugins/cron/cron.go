// Package cron is the builtin scheduled-task plugin. 它在插件私有 storage 里
// 维护一张定时任务表,由常驻会话 cron.serve 按点巡检触发(或系统 crontab 周期
// 调 cron.tick 无常驻触发)。每个任务到点执行三类动作之一:发通知、拉 Agent
// 会话干活、给已有会话发消息。
//
// 为什么不用 manifest 的 watchers/onSchedule:那套宿主调度器(docs/design/
// plugin/08-roadmap.md 阶段 2)尚未落地。本插件复用既有的「常驻会话跑循环」
// 形态(同 review-mesh.watch、im.listen),宿主代码零改动。
package cron

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"ttmux-cli-go/pkg/plugin/sdk"
)

// storeKey 是任务表在插件 KV 里的键(整表一个 JSON 数组,同 review-mesh 存法)。
const storeKey = "jobs"

// tickInterval 是 cron.serve 常驻循环的巡检周期。到期判定精度即此粒度。
const tickInterval = 15 * time.Second

// Job 是一条定时任务。every 与 at 二选一(见 validateSchedule)。
type Job struct {
	Name    string `json:"name"`
	Every   string `json:"every,omitempty"` // 间隔型:Go duration,如 5m / 1h
	At      string `json:"at,omitempty"`    // 每日型:HH:MM(本机时区)
	Action  string `json:"action"`          // notify | agent | send
	Enabled bool   `json:"enabled"`

	// action=notify
	Title string `json:"title,omitempty"`
	Body  string `json:"body,omitempty"`
	// action=agent
	Provider string `json:"provider,omitempty"`
	Prompt   string `json:"prompt,omitempty"`
	Workdir  string `json:"workdir,omitempty"`
	// action=send
	Session string `json:"session,omitempty"`
	Text    string `json:"text,omitempty"`

	NextRun int64 `json:"nextRun,omitempty"` // 下次触发(unix 秒)
	LastRun int64 `json:"lastRun,omitempty"` // 上次触发(unix 秒)
	Runs    int   `json:"runs,omitempty"`    // 累计触发次数
}

// Activate registers the plugin's commands (sdk.Serve 的入口)。
func Activate(ctx *sdk.Ctx) sdk.Plugin {
	return sdk.Plugin{
		Commands: map[string]sdk.CommandHandler{
			"add":    add,
			"list":   list,
			"remove": remove,
			"run":    runNow,
			"tick":   tick,
			"serve":  serve,
		},
	}
}

// ── 任务表存取(整表一个 JSON,读改写)──

func loadJobs(ctx *sdk.Ctx) ([]Job, error) {
	raw, err := ctx.StorageGet(storeKey)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var jobs []Job
	if err := json.Unmarshal([]byte(raw), &jobs); err != nil {
		return nil, fmt.Errorf("任务表损坏,无法解析: %w", err)
	}
	return jobs, nil
}

func saveJobs(ctx *sdk.Ctx, jobs []Job) error {
	b, err := json.Marshal(jobs)
	if err != nil {
		return err
	}
	return ctx.StorageSet(storeKey, string(b))
}

// ── 命令 handler ──

// add 添加或(按 name)更新一条定时任务。
func add(ctx *sdk.Ctx, args map[string]string) (any, error) {
	name := strings.TrimSpace(args["name"])
	if name == "" {
		return nil, fmt.Errorf("usage: cron.add --name <名> (--every <间隔>|--at HH:MM) [--action notify|agent|send] ...")
	}
	if err := validateSchedule(args["every"], args["at"]); err != nil {
		return nil, err
	}
	action := args["action"]
	if action == "" {
		action = "notify"
	}
	job := Job{
		Name:     name,
		Every:    strings.TrimSpace(args["every"]),
		At:       strings.TrimSpace(args["at"]),
		Action:   action,
		Enabled:  true,
		Title:    args["title"],
		Body:     args["body"],
		Provider: args["provider"],
		Prompt:   args["prompt"],
		Workdir:  args["workdir"],
		Session:  args["session"],
		Text:     args["text"],
	}
	if err := validateAction(job); err != nil {
		return nil, err
	}
	next, err := nextAfter(job, time.Now())
	if err != nil {
		return nil, err
	}
	job.NextRun = next.Unix()

	jobs, err := loadJobs(ctx)
	if err != nil {
		return nil, err
	}
	replaced := false
	for i := range jobs {
		if jobs[i].Name == name {
			// 更新时保留累计计数,其余字段整体替换
			job.Runs, job.LastRun = jobs[i].Runs, jobs[i].LastRun
			jobs[i] = job
			replaced = true
			break
		}
	}
	if !replaced {
		jobs = append(jobs, job)
	}
	if err := saveJobs(ctx, jobs); err != nil {
		return nil, err
	}
	verb := "已添加"
	if replaced {
		verb = "已更新"
	}
	ctx.Logf("%s定时任务 %s(%s),下次触发 %s", verb, name, scheduleDesc(job), time.Unix(job.NextRun, 0).Format("2006-01-02 15:04:05"))
	return jobView(job), nil
}

// list 列出全部任务及下次触发时间(按下次触发时间升序)。
func list(ctx *sdk.Ctx, args map[string]string) (any, error) {
	jobs, err := loadJobs(ctx)
	if err != nil {
		return nil, err
	}
	sort.Slice(jobs, func(i, j int) bool { return jobs[i].NextRun < jobs[j].NextRun })
	views := make([]map[string]any, 0, len(jobs))
	for _, j := range jobs {
		views = append(views, jobView(j))
	}
	return map[string]any{"count": len(views), "jobs": views}, nil
}

// remove 按 name 删除一条任务。
func remove(ctx *sdk.Ctx, args map[string]string) (any, error) {
	name := strings.TrimSpace(args["name"])
	if name == "" {
		return nil, fmt.Errorf("usage: cron.remove --name <名>")
	}
	jobs, err := loadJobs(ctx)
	if err != nil {
		return nil, err
	}
	kept := jobs[:0]
	removed := false
	for _, j := range jobs {
		if j.Name == name {
			removed = true
			continue
		}
		kept = append(kept, j)
	}
	if !removed {
		return nil, fmt.Errorf("没有名为 %q 的定时任务", name)
	}
	if err := saveJobs(ctx, kept); err != nil {
		return nil, err
	}
	ctx.Logf("已删除定时任务 %s", name)
	return map[string]any{"removed": name}, nil
}

// runNow 立即触发一条任务一次,不改动它的排期(NextRun 不变),便于验证配置。
func runNow(ctx *sdk.Ctx, args map[string]string) (any, error) {
	name := strings.TrimSpace(args["name"])
	if name == "" {
		return nil, fmt.Errorf("usage: cron.run --name <名>")
	}
	jobs, err := loadJobs(ctx)
	if err != nil {
		return nil, err
	}
	for i := range jobs {
		if jobs[i].Name != name {
			continue
		}
		res, ferr := fireJob(ctx, &jobs[i])
		if ferr != nil {
			return nil, ferr
		}
		if err := saveJobs(ctx, jobs); err != nil {
			return nil, err
		}
		return map[string]any{"fired": name, "result": res}, nil
	}
	return nil, fmt.Errorf("没有名为 %q 的定时任务", name)
}

// tick 巡检一次:触发所有已启用且到期的任务,并把它们排到下一次。
// 无常驻场景可让系统 crontab 周期性调它(如每分钟一次)。幂等:未到期不动。
func tick(ctx *sdk.Ctx, args map[string]string) (any, error) {
	fired, err := tickOnce(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{"fired": fired, "count": len(fired)}, nil
}

// serve 常驻调度器:每 tickInterval 巡检一次,直到进程被回收(plugin run 的
// invoke 上限 24h)。跑在专用 tmux 会话里可 attach 看日志:
//
//	tmux new-session -d -s _ttmux-cron 'ttmux plugin run cron.serve'
func serve(ctx *sdk.Ctx, args map[string]string) (any, error) {
	fmt.Fprintf(os.Stderr, "[%s] cron 调度器启动,每 %s 巡检一次\n", now(), tickInterval)
	ctx.Logf("scheduler loop started (tick=%s)", tickInterval)
	for {
		fired, err := tickOnce(ctx)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[%s] 巡检出错: %v\n", now(), err)
		} else if len(fired) > 0 {
			fmt.Fprintf(os.Stderr, "[%s] 触发 %d 个任务: %s\n", now(), len(fired), strings.Join(fired, ", "))
		}
		time.Sleep(tickInterval)
	}
}

// ── 调度核心 ──

// tickOnce 触发所有到期任务并推进排期,返回本轮触发的任务名。
func tickOnce(ctx *sdk.Ctx) ([]string, error) {
	jobs, err := loadJobs(ctx)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	fired := []string{}
	changed := false
	for i := range jobs {
		j := &jobs[i]
		if !j.Enabled || j.NextRun == 0 || time.Unix(j.NextRun, 0).After(now) {
			continue
		}
		if _, ferr := fireJob(ctx, j); ferr != nil {
			// 单个任务触发失败不阻断其余;记日志,排期照常推进避免热循环重试
			fmt.Fprintf(os.Stderr, "[%s] 任务 %s 触发失败: %v\n", nowStr(now), j.Name, ferr)
		} else {
			fired = append(fired, j.Name)
		}
		next, nerr := advancePast(*j, now)
		if nerr != nil {
			fmt.Fprintf(os.Stderr, "[%s] 任务 %s 排期推进失败,禁用: %v\n", nowStr(now), j.Name, nerr)
			j.Enabled = false
		} else {
			j.NextRun = next.Unix()
		}
		changed = true
	}
	if changed {
		if err := saveJobs(ctx, jobs); err != nil {
			return fired, err
		}
	}
	return fired, nil
}

// fireJob 执行一条任务的动作,并就地更新其 LastRun/Runs 计数。
func fireJob(ctx *sdk.Ctx, j *Job) (any, error) {
	j.Runs++
	j.LastRun = time.Now().Unix()
	switch j.Action {
	case "notify":
		return fireNotify(ctx, j)
	case "agent":
		return fireAgent(ctx, j)
	case "send":
		return fireSend(ctx, j)
	default:
		return nil, fmt.Errorf("未知动作 %q", j.Action)
	}
}

func fireNotify(ctx *sdk.Ctx, j *Job) (any, error) {
	if err := ctx.NotificationPublish(sdk.Notification{
		Type:     "cron.reminder",
		Severity: "info",
		Title:    j.Title,
		Body:     j.Body,
		// 每次触发一个唯一 dedupeKey,否则同标题的周期提醒会被通知层去重吞掉
		DedupeKey: fmt.Sprintf("cron.%s.%d", j.Name, j.Runs),
	}); err != nil {
		return nil, err
	}
	ctx.Logf("任务 %s 已发通知: %s", j.Name, j.Title)
	return map[string]any{"action": "notify", "title": j.Title}, nil
}

func fireAgent(ctx *sdk.Ctx, j *Job) (any, error) {
	// 会话名带触发次数,避免同名会话已存在导致 spawn 失败
	sessName := fmt.Sprintf("cron-%s-%d", j.Name, j.Runs)
	session, err := ctx.AgentSpawn(sdk.SpawnReq{
		Provider:    j.Provider,
		Prompt:      j.Prompt,
		SessionName: sessName,
		Workdir:     j.Workdir,
		Job:         "cron:" + j.Name,
		Labels:      map[string]string{"cron": j.Name, "role": "cron-task"},
	})
	if err != nil {
		return nil, err
	}
	ctx.Logf("任务 %s 已拉起 Agent 会话 %s", j.Name, session)
	return map[string]any{"action": "agent", "session": session}, nil
}

func fireSend(ctx *sdk.Ctx, j *Job) (any, error) {
	if !ctx.SessionAlive(j.Session) {
		return nil, fmt.Errorf("目标会话 %s 不在,跳过", j.Session)
	}
	if err := ctx.SessionSend(j.Session, j.Text); err != nil {
		return nil, err
	}
	ctx.Logf("任务 %s 已向会话 %s 发送消息", j.Name, j.Session)
	return map[string]any{"action": "send", "session": j.Session}, nil
}

// ── 校验与展示 ──

// validateAction 校验动作类型及其必填字段。
func validateAction(j Job) error {
	switch j.Action {
	case "notify":
		if strings.TrimSpace(j.Title) == "" {
			return fmt.Errorf("action=notify 需要 --title <标题>")
		}
	case "agent":
		if strings.TrimSpace(j.Prompt) == "" {
			return fmt.Errorf("action=agent 需要 --prompt <给 Agent 的指令>")
		}
	case "send":
		if strings.TrimSpace(j.Session) == "" || strings.TrimSpace(j.Text) == "" {
			return fmt.Errorf("action=send 需要 --session <会话名> 与 --text <消息>")
		}
	default:
		return fmt.Errorf("action 只能是 notify | agent | send,得到 %q", j.Action)
	}
	return nil
}

// scheduleDesc 把排期渲染成一句人话。
func scheduleDesc(j Job) string {
	if j.Every != "" {
		return "每隔 " + j.Every
	}
	return "每天 " + j.At
}

// jobView 是给 CLI/Web 展示的任务视图(含格式化的下次触发时间)。
func jobView(j Job) map[string]any {
	v := map[string]any{
		"name":     j.Name,
		"schedule": scheduleDesc(j),
		"action":   j.Action,
		"enabled":  j.Enabled,
		"runs":     j.Runs,
	}
	if j.NextRun > 0 {
		v["nextRunAt"] = time.Unix(j.NextRun, 0).Format("2006-01-02 15:04:05")
	}
	if j.LastRun > 0 {
		v["lastRunAt"] = time.Unix(j.LastRun, 0).Format("2006-01-02 15:04:05")
	}
	return v
}

func now() string { return time.Now().Format("15:04:05") }

func nowStr(t time.Time) string { return t.Format("15:04:05") }
