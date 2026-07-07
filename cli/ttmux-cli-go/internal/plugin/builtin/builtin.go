// Package builtin registers the official builtin plugins (Go 实现,编译进
// ttmux 单二进制,由隐藏子命令 _plugin-host 以子进程 + stdio JSON-RPC 拉起,
// 与第三方插件走完全相同的协议;见 docs/design/plugin/04 第 3 节)。
package builtin

import (
	"ttmux-cli-go/internal/plugin"
	"ttmux-cli-go/internal/plugin/builtin/feishu"
	"ttmux-cli-go/internal/plugin/builtin/reviewmesh"
	"ttmux-cli-go/internal/plugin/sdk"
)

// Builtin pairs a manifest with its activation entry.
type Builtin struct {
	Manifest plugin.Manifest
	Activate func(ctx *sdk.Ctx) sdk.Plugin
}

func init() {
	for _, b := range All() {
		plugin.RegisterBuiltinManifest(b.Manifest)
	}
}

// All returns every builtin plugin.
func All() []Builtin {
	return []Builtin{
		{Manifest: reviewMeshManifest(), Activate: reviewmesh.Activate},
		{Manifest: feishuManifest(), Activate: feishu.Activate},
	}
}

// Find resolves a builtin by full id.
func Find(id string) (Builtin, bool) {
	for _, b := range All() {
		if b.Manifest.ID == id {
			return b, true
		}
	}
	return Builtin{}, false
}

func reviewMeshManifest() plugin.Manifest {
	return plugin.Manifest{
		ManifestVersion: 1,
		ID:              "roam.review-mesh",
		Publisher:       "roam",
		Name:            "review-mesh",
		DisplayName:     plugin.LocaleText{"zh-CN": "智能互审", "en-US": "Review Mesh"},
		Version:         "0.1.0",
		Description: plugin.LocaleText{
			"zh-CN": "对当前工作区变更拉起 reviewer Agent(codex/claude),产出结构化 finding 并发布通知",
			"en-US": "Peer-review the current diff with a reviewer agent, producing structured findings",
		},
		Runtime: plugin.Runtime{Kind: "builtin"},
		Permissions: plugin.Perms{
			Workspace: []string{"read"},
			Agents:    []string{"spawn"},
			// write:互审意见回灌开发会话(session.send),高危已声明
			Sessions:      []string{"read", "write"},
			Findings:      []string{"read", "write"},
			Notifications: []string{"publish"},
		},
		ActivationEvents: []string{
			"onCommand:review-mesh.review",
			"onCommand:review-mesh.status",
			"onCommand:review-mesh.watch",
		},
		Contributes: plugin.Contribs{
			Commands: []plugin.CommandContrib{
				{ID: "review-mesh.review", Title: plugin.LocaleText{"zh-CN": "互审当前变更", "en-US": "Review current changes"}},
				{ID: "review-mesh.status", Title: plugin.LocaleText{"zh-CN": "互审状态", "en-US": "Review status"}},
				{ID: "review-mesh.watch", Title: plugin.LocaleText{"zh-CN": "陪跑监控会话(空闲即互审)", "en-US": "Watch a session (review on idle)"}},
			},
			ConfigFields: []plugin.ConfigField{
				{Key: "provider",
					Title:       plugin.LocaleText{"zh-CN": "默认评审 Agent", "en-US": "Default reviewer agent"},
					Description: plugin.LocaleText{"zh-CN": "留空则自动选择(codex 优先)", "en-US": "Empty = auto (prefer codex)"},
					Options:     []string{"", "codex", "claude"}},
			},
		},
	}
}

func feishuManifest() plugin.Manifest {
	return plugin.Manifest{
		ManifestVersion: 1,
		ID:              "roam.feishu-bridge",
		Publisher:       "roam",
		Name:            "feishu-bridge",
		DisplayName:     plugin.LocaleText{"zh-CN": "飞书机器人", "en-US": "Feishu Bridge"},
		Version:         "0.2.0",
		Description: plugin.LocaleText{
			"zh-CN": "双向飞书桥(自建应用):群里 @机器人 派活给 Agent、对话式协作;Roam 通知推送到绑定的群",
			"en-US": "Two-way Feishu bridge (self-built app): @ the bot to dispatch agent tasks and collaborate; Roam notifications go to the bound chat",
		},
		Runtime: plugin.Runtime{Kind: "builtin"},
		Permissions: plugin.Perms{
			Notifications: []string{"subscribe"},
			// 入站派活:@机器人 的文本转成一次性 Agent 会话,结束后读日志回报
			Agents:   []string{"spawn"},
			Sessions: []string{"read"},
			Network:  plugin.NetworkPerms{AllowedDomains: []string{"https://open.feishu.cn"}},
			Secrets:  []string{"app_secret"},
		},
		ActivationEvents: []string{
			"onNotification:*",
			"onCommand:feishu-bridge.test",
			"onCommand:feishu-bridge.listen",
		},
		Contributes: plugin.Contribs{
			Commands: []plugin.CommandContrib{
				{ID: "feishu-bridge.test", Title: plugin.LocaleText{"zh-CN": "发送测试卡片", "en-US": "Send test card"}},
				{ID: "feishu-bridge.listen", Title: plugin.LocaleText{"zh-CN": "长连接监听 @机器人(plugind 自动托管)", "en-US": "Listen for @bot messages (managed by plugind)"}},
				{ID: "feishu-bridge.send", Title: plugin.LocaleText{"zh-CN": "发消息到飞书会话(派活 Agent 的汇报通道)", "en-US": "Send a message to a Feishu chat (agent reporting channel)"}},
			},
			NotificationSinks: []plugin.SinkContrib{
				{ID: "feishu.send", Events: []string{"finding.blocking", "review.completed", "monitor.alert", "*"}},
			},
			ConfigGroups: []plugin.ConfigGroup{
				{Key: "inbound",
					Title: plugin.LocaleText{"zh-CN": "自建应用(双向通道)", "en-US": "Self-built app (two-way channel)"},
					Description: plugin.LocaleText{
						"zh-CN": "配好后群里 @应用机器人 即可查状态、派活给 Agent、干完回报;再说一句「绑定通知」,Roam 系统通知(互审结果、告警)也发到该群。\n1. open.feishu.cn → 创建「企业自建应用」,取 App ID / App Secret\n2. 权限管理:开通 im:message(获取与发送单聊、群组消息)\n3. 事件订阅:选「使用长连接接收事件」,订阅「接收消息 im.message.receive_v1」\n4. 发布版本,把应用机器人拉进群\n5. 保存后 plugind 自动拉起监听(tmux 会话 _ttmux-feishu),群里 @它 说「帮助」验证",
						"en-US": "Once configured, @ the app bot in a group to check status, dispatch agent tasks and get results back; say \"bind\" and Roam system notifications also go to that chat.\n1. open.feishu.cn → create a self-built app, get App ID / App Secret\n2. Scopes: enable im:message (receive & send)\n3. Events: choose long-connection mode, subscribe to im.message.receive_v1\n4. Release the app and add its bot to the group\n5. Save; plugind auto-starts the listener (tmux session _ttmux-feishu) — @ the bot with \"help\" to verify"},
				},
				{Key: "task",
					Title: plugin.LocaleText{"zh-CN": "派活设置", "en-US": "Task settings"},
					Description: plugin.LocaleText{
						"zh-CN": "@机器人 的非指令文本会变成一次性 Agent 会话,干完把结果卡片发回群。",
						"en-US": "Non-command @bot messages become one-shot agent sessions; results are posted back to the chat."},
				},
			},
			ConfigFields: []plugin.ConfigField{
				{Key: "app_id", Group: "inbound",
					Title:       plugin.LocaleText{"zh-CN": "App ID", "en-US": "App ID"},
					Placeholder: "cli_xxxxxxxxxxxxxxxx"},
				{Key: "app_secret", Group: "inbound", Secret: true,
					Title: plugin.LocaleText{"zh-CN": "App Secret", "en-US": "App Secret"}},
				{Key: "notify_chat", Group: "inbound",
					Title:       plugin.LocaleText{"zh-CN": "通知群 chat_id", "en-US": "Notification chat_id"},
					Description: plugin.LocaleText{"zh-CN": "系统通知发到哪个群;一般不用手填——群里 @机器人 说「绑定通知」会自动记录", "en-US": "Target chat for system notifications; usually auto-set by @bot \"bind\" in the group"},
					Placeholder: "oc_xxxxxxxx(可留空,由「绑定通知」自动记录)"},
				{Key: "workdir", Group: "task",
					Title:       plugin.LocaleText{"zh-CN": "默认工作目录", "en-US": "Default workdir"},
					Description: plugin.LocaleText{"zh-CN": "派下来的任务在哪个目录干活;留空用家目录", "en-US": "Where dispatched tasks run; empty = home dir"},
					Placeholder: "/home/you/codes/xxx"},
				{Key: "provider", Group: "task",
					Title:       plugin.LocaleText{"zh-CN": "执行 Agent", "en-US": "Agent"},
					Description: plugin.LocaleText{"zh-CN": "留空用 claude", "en-US": "Empty = claude"},
					Options:     []string{"", "claude", "codex"}},
				{Key: "task_mode", Group: "task",
					Title:       plugin.LocaleText{"zh-CN": "任务模式", "en-US": "Task mode"},
					Description: plugin.LocaleText{"zh-CN": "留空=interactive:Agent 主导对话(主动汇报/提问,你的回复会转给它);oneshot:一次性跑完,日志截尾回报", "en-US": "Empty = interactive: the agent drives the conversation (reports/asks, your replies are forwarded); oneshot: run once and report the log tail"},
					Options:     []string{"", "interactive", "oneshot"}},
			},
		},
	}
}
