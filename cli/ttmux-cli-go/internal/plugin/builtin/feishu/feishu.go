// Package feishu is the builtin 双向飞书桥(设计见 docs/design/plugin/
// 03-stories.md 故事三与 08-roadmap 阶段 3):基于飞书自建应用——
//
//   - 入站:长连接订阅 @机器人 消息,把任务派给交互式 Agent 会话,由 Agent
//     经 feishu-bridge.send 主导对话(汇报/提问/总结),用户回复自动转回会话
//     (见 listen.go);
//   - 出站:作为 notification sink 把 Roam 通知(互审结果、告警)渲染成卡片
//     发到「绑定通知」记下的会话。
package feishu

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"ttmux-cli-go/internal/plugin/sdk"
)

// Activate registers commands + the notification sink handler.
func Activate(ctx *sdk.Ctx) sdk.Plugin {
	return sdk.Plugin{
		Commands: map[string]sdk.CommandHandler{
			"test":   test,
			"listen": listen,
			"send":   send,
		},
		Events: map[string]sdk.EventHandler{
			"notification": onNotification,
			// @机器人 派出去的任务会话结束 → 结果回报原会话(listen.go)
			"session:agent.exited": onAgentExited,
		},
	}
}

// onAgentExited 把 feishu 派活会话的收尾结果发回原飞书会话。
func onAgentExited(ctx *sdk.Ctx, payload json.RawMessage) error {
	var ev struct {
		Session string            `json:"session"`
		Labels  map[string]string `json:"labels"`
	}
	if err := json.Unmarshal(payload, &ev); err != nil {
		return err
	}
	chatID := ev.Labels["feishu:chat"]
	if chatID == "" {
		return nil // 不是 feishu 派的活
	}
	if ev.Labels["feishu:mode"] == "interactive" {
		// 交互模式:总结由 Agent 自己经 feishu-bridge.send 发,这里只补一条
		// 会话关闭的确认(TUI 画面日志不适合直接进卡片)
		replyText(ctx, chatID, "✅ 任务会话 "+ev.Session+" 已结束。")
		return nil
	}
	logText, err := ctx.SessionLog(ev.Session)
	if err != nil {
		replyText(ctx, chatID, fmt.Sprintf("任务会话 %s 已结束,但读取结果失败: %v", ev.Session, err))
		return nil
	}
	replyCard(ctx, chatID, card{
		Title:    "任务完成: " + ev.Session,
		Severity: "info",
		Body:     tailForCard(logText, 1200),
		Source:   "feishu-bridge.task",
	})
	return nil
}

// ansiRe 覆盖 CSI(含 ?/> 私有模式,如换行粘贴的 [?2004h)、OSC、字符集
// 切换与回车;漏掉私有模式会让卡片开头结尾各挂一坨乱码。
var ansiRe = regexp.MustCompile(`\x1b(?:\[[0-9;?>=<]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()][0-9A-Za-z]|[@-_])|\r`)

var mdHeadingRe = regexp.MustCompile(`(?m)^#{1,6}\s+(.+)$`)

// tailForCard 把会话日志清洗成卡片正文:剥终端控制序列、掐掉启动命令回显
// 与收尾的 exit/logout、markdown 标题降级为加粗(飞书卡片不认 #),再截尾。
func tailForCard(s string, maxRunes int) string {
	s = ansiRe.ReplaceAllString(s, "")
	// 日志开头是 send-keys 敲进去的启动命令回显(… < 'xxx.prompt'; exit),
	// 掐到该行为止,只留 Agent 的真实输出
	if i := strings.Index(s, ".prompt'; exit"); i >= 0 {
		if j := strings.IndexByte(s[i:], '\n'); j >= 0 {
			s = s[i+j+1:]
		}
	}
	s = strings.TrimSpace(s)
	for _, suffix := range []string{"logout", "exit"} {
		s = strings.TrimSpace(strings.TrimSuffix(s, suffix))
	}
	s = mdHeadingRe.ReplaceAllString(s, "**$1**")
	r := []rune(s)
	if len(r) > maxRunes {
		return "…" + string(r[len(r)-maxRunes:])
	}
	if s == "" {
		return "(会话没有留下输出)"
	}
	return s
}

func test(ctx *sdk.Ctx, args map[string]string) (any, error) {
	title := args["title"]
	if title == "" {
		title = "Roam 测试消息"
	}
	c := card{
		Title:    title,
		Severity: "info",
		Body:     "这是一条来自 roam.feishu-bridge 插件的测试卡片。\n发送时间: " + time.Now().Format("2006-01-02 15:04:05"),
		Source:   "feishu-bridge.test",
	}
	chat := notifyChat(ctx)
	if chat == "" {
		return nil, fmt.Errorf("未绑定通知会话:群里 @机器人 说「绑定通知」,或配置 notify_chat")
	}
	content, err := json.Marshal(cardContent(c))
	if err != nil {
		return nil, err
	}
	if err := sendAppMessage(ctx, chat, "interactive", string(content)); err != nil {
		return nil, err
	}
	return map[string]string{"sent": "ok", "chat": chat}, nil
}

func onNotification(ctx *sdk.Ctx, payload json.RawMessage) error {
	var n struct {
		Type     string `json:"type"`
		Severity string `json:"severity"`
		Title    string `json:"title"`
		Body     string `json:"body"`
		Source   string `json:"source"`
	}
	if err := json.Unmarshal(payload, &n); err != nil {
		return err
	}
	c := card{
		Title:    n.Title,
		Severity: n.Severity,
		Body:     n.Body,
		Source:   fmt.Sprintf("%s · %s", n.Source, n.Type),
	}
	// 发到「绑定通知」记下的会话(或配置的 notify_chat);未绑定则静默跳过,
	// sink 不该因为没接飞书就给每条通知刷错误日志(test 命令仍显式报错引导)。
	chat := notifyChat(ctx)
	if chat == "" {
		ctx.Logf("notify chat not bound; notification skipped (群里 @机器人 说「绑定通知」)")
		return nil
	}
	replyCard(ctx, chat, c)
	return nil
}

// notifyChat 返回系统通知的目标会话:配置项优先,其次「绑定通知」记录。
func notifyChat(ctx *sdk.Ctx) string {
	if v := ctx.Config["notify_chat"]; v != "" {
		return v
	}
	v, _ := ctx.StorageGet("notify_chat")
	return v
}

type card struct {
	Title    string
	Severity string
	Body     string
	Source   string
}

// cardContent renders the shared interactive-card JSON(webhook 出站与应用
// 机器人回复共用一套排版)。
func cardContent(c card) map[string]any {
	template := map[string]string{"high": "red", "warning": "orange", "info": "blue"}[c.Severity]
	if template == "" {
		template = "blue"
	}
	body := c.Body
	if body == "" {
		body = "(无正文)"
	}
	return map[string]any{
		"header": map[string]any{
			"title":    map[string]any{"tag": "plain_text", "content": c.Title},
			"template": template,
		},
		"elements": []any{
			map[string]any{"tag": "markdown", "content": body},
			map[string]any{"tag": "note", "elements": []any{
				map[string]any{"tag": "plain_text", "content": "Roam · " + c.Source},
			}},
		},
	}
}
