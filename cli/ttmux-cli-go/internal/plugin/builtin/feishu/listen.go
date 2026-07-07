// listen.go 实现飞书入站方向(设计见 docs/design/plugin/08-roadmap.md 阶段 3):
// 以自建应用的长连接模式(WebSocket,免公网回调)订阅 im.message.receive_v1,
// 群里 @应用机器人 说话即可驱动 Roam——「帮助/状态」直接应答,其余文本当作
// 任务派给一次性 Agent 会话,会话结束由 plugind 的 agent.exited 事件把结果
// 回报到原会话(见 feishu.go 的 onAgentExited)。
//
// 注意:入站走的是「应用机器人」(app_id/app_secret),与出站通知的「群自定义
// 机器人」(webhook)是两个群成员;应用需开通 im:message 收发权限并订阅
// 「接收群聊中@机器人的消息」事件,再把应用机器人拉进群。
package feishu

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	lark "github.com/larksuite/oapi-sdk-go/v3"
	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
	"github.com/larksuite/oapi-sdk-go/v3/event/dispatcher"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"

	"ttmux-cli-go/internal/plugin/sdk"
)

// listen 命令:前台长连接监听(plugind 会把它托管在 _ttmux-feishu 会话里,
// 掉线/回收后 3s 内自动重拉;手动跑 `ttmux plugin run feishu-bridge.listen`
// 也可以,面板即界面)。
func listen(ctx *sdk.Ctx, args map[string]string) (any, error) {
	appID, appSecret := ctx.Config["app_id"], ctx.Config["app_secret"]
	if appID == "" || appSecret == "" {
		return nil, fmt.Errorf("app_id/app_secret 未配置(飞书开放平台建自建应用后: ttmux plugin config feishu-bridge set app_id <cli_xxx> && set app_secret <secret>)")
	}
	fmt.Fprintf(os.Stderr, "== feishu-bridge 长连接监听 ==\n@应用机器人 说「帮助」看用法;其余文本将派给 Agent 干活\n")

	seen := &seenSet{ids: map[string]struct{}{}}
	handler := dispatcher.NewEventDispatcher("", "").
		OnP2MessageReceiveV1(func(_ context.Context, ev *larkim.P2MessageReceiveV1) error {
			// RPC 连接支持并发调用;回调里不做重活,避免阻塞 ws 心跳
			go handleMessage(ctx, seen, ev)
			return nil
		})
	cli := larkws.NewClient(appID, appSecret,
		larkws.WithEventHandler(handler),
		// SDK 默认 logger 写 stdout,而插件进程的 stdout 是 JSON-RPC 通道,
		// 必须改道 stderr(进面板/日志),否则污染协议流且排障全盲
		larkws.WithLogger(stderrLogger{}),
		larkws.WithLogLevel(larkcore.LogLevelInfo))
	if err := cli.Start(context.Background()); err != nil {
		return nil, fmt.Errorf("feishu 长连接失败(检查 app 凭据与「事件订阅-长连接」开关): %w", err)
	}
	return map[string]string{"stopped": "ws closed"}, nil
}

// stderrLogger routes lark SDK logs to stderr(stdout 被 RPC 占用)。
type stderrLogger struct{}

func (stderrLogger) Debug(_ context.Context, a ...interface{}) { logLine("DEBUG", a...) }
func (stderrLogger) Info(_ context.Context, a ...interface{})  { logLine("INFO", a...) }
func (stderrLogger) Warn(_ context.Context, a ...interface{})  { logLine("WARN", a...) }
func (stderrLogger) Error(_ context.Context, a ...interface{}) { logLine("ERROR", a...) }

func logLine(level string, a ...interface{}) {
	fmt.Fprintf(os.Stderr, "[lark %s] %s\n", level, fmt.Sprint(a...))
}

// seenSet 是消息级去重(飞书事件可能重投)。
type seenSet struct {
	mu  sync.Mutex
	ids map[string]struct{}
}

func (s *seenSet) firstTime(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.ids[id]; ok {
		return false
	}
	if len(s.ids) > 1024 { // 简单封顶,长连接进程日级回收,无需 LRU
		s.ids = map[string]struct{}{}
	}
	s.ids[id] = struct{}{}
	return true
}

var mentionKeyRe = regexp.MustCompile(`@_user_\d+`)

func handleMessage(ctx *sdk.Ctx, seen *seenSet, ev *larkim.P2MessageReceiveV1) {
	msg := ev.Event.Message
	if msg == nil || msg.ChatId == nil {
		return
	}
	chatID := *msg.ChatId
	if msg.MessageId != nil && !seen.firstTime(*msg.MessageId) {
		return
	}
	// 先记日志再过滤:排障时能看到"收到了但被谁拦下"
	ctx.Logf("feishu inbound: chat=%s type=%s msgType=%s mentions=%d",
		chatID, strVal(msg.ChatType), strVal(msg.MessageType), len(msg.Mentions))
	// 群聊只响应 @机器人(订阅范围建议也只勾「群聊中@机器人的消息」);单聊全收
	if strVal(msg.ChatType) != "p2p" && len(msg.Mentions) == 0 {
		return
	}
	if strVal(msg.MessageType) != "text" {
		replyText(ctx, chatID, "目前只认识文字消息;@我 说「帮助」看用法。")
		return
	}
	var content struct {
		Text string `json:"text"`
	}
	_ = json.Unmarshal([]byte(strVal(msg.Content)), &content)
	text := strings.TrimSpace(mentionKeyRe.ReplaceAllString(content.Text, ""))
	ctx.Logf("feishu inbound text (%s): %s", chatID, text)

	switch strings.ToLower(text) {
	case "", "hi", "hello", "你好", "help", "帮助", "?", "？":
		replyText(ctx, chatID, "我是 Roam 机器人,@我 之后:\n"+
			"· 帮助 —— 看这份说明\n"+
			"· 状态 —— 看我派出去的任务会话\n"+
			"· 绑定通知 —— Roam 系统通知(互审结果、告警)以后发到本群\n"+
			"· 结束 —— 收掉当前任务会话\n"+
			"· 其他任何话 —— 派给 Agent 干活;它会主动汇报进度、有疑问会反问你,你的回复我会转给它")
	case "状态", "status":
		replyText(ctx, chatID, statusText(ctx))
	case "绑定通知", "bind":
		if err := ctx.StorageSet("notify_chat", chatID); err != nil {
			replyText(ctx, chatID, "绑定失败: "+err.Error())
			return
		}
		replyText(ctx, chatID, "已绑定 ✅ Roam 系统通知(互审结果、blocking finding、告警)以后发到本群;「解绑通知」可取消。")
	case "解绑通知", "unbind":
		_ = ctx.StorageSet("notify_chat", "")
		replyText(ctx, chatID, "已解绑,Roam 系统通知不再发送(重新绑定:任意群里说「绑定通知」)。")
	case "结束", "stop", "exit":
		if sess := activeTask(ctx, chatID); sess != "" {
			_ = ctx.SessionSend(sess, "/exit")
			replyText(ctx, chatID, "已请求结束会话 "+sess+"。")
		} else {
			replyText(ctx, chatID, "当前没有进行中的任务会话。")
		}
	default:
		// 有进行中的任务会话:你的话是给它的(追问/答复/新指示),直接转进去
		if sess := activeTask(ctx, chatID); sess != "" {
			if err := ctx.SessionSend(sess, text); err != nil {
				replyText(ctx, chatID, "转达失败: "+err.Error())
				return
			}
			ctx.Logf("feishu forwarded to %s: %s", sess, text)
			return
		}
		dispatchTask(ctx, chatID, text)
	}
}

// activeTask 返回该飞书会话当前存活的任务会话(最近优先)。
func activeTask(ctx *sdk.Ctx, chatID string) string {
	rows, err := ctx.SessionList()
	if err != nil {
		return ""
	}
	for i := len(rows) - 1; i >= 0; i-- {
		r := rows[i]
		if r.Labels["feishu:chat"] == chatID && r.Labels["role"] == "feishu-task" && ctx.SessionAlive(r.Session) {
			return r.Session
		}
	}
	return ""
}

// dispatchTask 拉一个交互式 Agent 会话干活:对话主导权在 Agent——prompt 注入
// 「feishu-bridge.send」用法,由它自己决定何时汇报、提问、收尾;用户的后续
// 消息经 handleMessage 路由回该会话(task_mode=oneshot 退回老的一次性模式)。
func dispatchTask(ctx *sdk.Ctx, chatID, text string) {
	workdir := ctx.Config["workdir"]
	if workdir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			replyText(ctx, chatID, "派活失败:未配置 workdir 且拿不到家目录")
			return
		}
		workdir = home
	}
	sess := "feishu-" + time.Now().Format("0102-150405")
	interactive := ctx.Config["task_mode"] != "oneshot"
	var prompt string
	if interactive {
		prompt = fmt.Sprintf(`你在为一位飞书用户干活。与 TA 沟通的唯一渠道是执行这条命令(用 Bash):
  ttmux plugin run feishu-bridge.send --chat %s --text '要发的内容'
沟通规则:
- 开工时先发一条简短消息说明你的理解和计划;
- 缺信息或需要用户拍板时,发消息提问后停下等待,用户的回复会作为新消息直接出现在本对话里;
- 干活过程中关键节点可发简短进度;
- 完成后必须发一条最终总结(做了什么、结果、涉及路径),控制在几百字内;
- 发完最终总结后执行 Bash 命令 tmux kill-session -t %s 结束本会话(这就是"交活"信号)。
用户的任务:
%s`, chatID, sess, text)
	} else {
		prompt = text + "\n\n(此任务来自飞书群 @机器人 派活;完成后请输出一段简明的结果总结,便于转发回群。)"
	}
	name, err := ctx.AgentSpawn(sdk.SpawnReq{
		Provider:    ctx.Config["provider"],
		Prompt:      prompt,
		SessionName: sess,
		Workdir:     workdir,
		Interactive: interactive,
		Labels: map[string]string{"feishu:chat": chatID, "role": "feishu-task",
			"feishu:mode": map[bool]string{true: "interactive", false: "oneshot"}[interactive]},
	})
	if err != nil {
		ctx.Logf("feishu task spawn failed: %v", err)
		replyText(ctx, chatID, "派活失败: "+err.Error())
		return
	}
	ctx.Logf("feishu task spawned: session=%s workdir=%s interactive=%v", name, workdir, interactive)
	if !interactive {
		replyText(ctx, chatID, fmt.Sprintf("已开工 🛠️\n会话: %s\n目录: %s\n围观: ttmux a %s\n完成后我会在这里回报结果。", name, workdir, name))
	}
	// 交互模式不由插件发「已开工」——Agent 自己会先打招呼说明计划
}

func statusText(ctx *sdk.Ctx) string {
	rows, err := ctx.SessionList()
	if err != nil {
		return "查询失败: " + err.Error()
	}
	var b strings.Builder
	n := 0
	for i := len(rows) - 1; i >= 0 && n < 8; i-- {
		r := rows[i]
		if r.Labels["role"] != "feishu-task" {
			continue
		}
		fmt.Fprintf(&b, "· %s [%s]\n", r.Session, r.Status)
		n++
	}
	if n == 0 {
		return "还没有派过任务;@我 直接说要干什么即可。"
	}
	return "最近的任务会话:\n" + strings.TrimRight(b.String(), "\n")
}

// send 命令:供派活 Agent 在任务里主动给用户发消息(进度、提问、总结)。
// `ttmux plugin run feishu-bridge.send --chat <chat_id> --text '...'`
func send(ctx *sdk.Ctx, args map[string]string) (any, error) {
	chat, text := args["chat"], args["text"]
	if chat == "" {
		chat = notifyChat(ctx) // 不指定就发到绑定的通知群
	}
	if chat == "" || text == "" {
		return nil, fmt.Errorf("usage: ttmux plugin run feishu-bridge.send --chat <chat_id> --text <文本>(chat 可省略,默认绑定的通知群)")
	}
	content, _ := json.Marshal(map[string]string{"text": text})
	if err := sendAppMessage(ctx, chat, "text", string(content)); err != nil {
		return nil, err
	}
	return map[string]string{"sent": "ok", "chat": chat}, nil
}

// replyText 经应用机器人把文本发回会话(出站通知的 webhook 只绑一个群,
// 这里必须按 chat_id 定向)。
func replyText(ctx *sdk.Ctx, chatID, text string) {
	content, _ := json.Marshal(map[string]string{"text": text})
	if err := sendAppMessage(ctx, chatID, "text", string(content)); err != nil {
		ctx.Logf("feishu reply failed: %v", err)
	}
}

// replyCard 发卡片(任务完成回报用,复用出站卡片的排版)。
func replyCard(ctx *sdk.Ctx, chatID string, c card) {
	content, err := json.Marshal(cardContent(c))
	if err != nil {
		return
	}
	if err := sendAppMessage(ctx, chatID, "interactive", string(content)); err != nil {
		ctx.Logf("feishu card reply failed: %v", err)
	}
}

func sendAppMessage(ctx *sdk.Ctx, chatID, msgType, content string) error {
	appID, appSecret := ctx.Config["app_id"], ctx.Config["app_secret"]
	if appID == "" || appSecret == "" {
		return fmt.Errorf("app_id/app_secret not configured")
	}
	client := lark.NewClient(appID, appSecret, lark.WithLogger(stderrLogger{}))
	req := larkim.NewCreateMessageReqBuilder().
		ReceiveIdType("chat_id").
		Body(larkim.NewCreateMessageReqBodyBuilder().
			ReceiveId(chatID).MsgType(msgType).Content(content).Build()).
		Build()
	cctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	resp, err := client.Im.Message.Create(cctx, req)
	if err != nil {
		return fmt.Errorf("feishu send failed: %w", err)
	}
	if !resp.Success() {
		return fmt.Errorf("feishu send rejected: code=%d msg=%s", resp.Code, resp.Msg)
	}
	ctx.Logf("feishu message sent: chat=%s type=%s", chatID, msgType)
	return nil
}

func strVal(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
