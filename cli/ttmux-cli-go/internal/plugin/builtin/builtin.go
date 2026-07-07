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
		Version:         "0.3.0",
		Description: plugin.LocaleText{
			"zh-CN": "双向飞书桥:@机器人 的消息进常驻管家 Agent,简单问题直接答,复杂任务委派 worker 会话干活并回报;Roam 通知推送到绑定的群",
			"en-US": "Two-way Feishu bridge: messages go to a resident concierge agent that answers directly or delegates worker sessions; Roam notifications go to the bound chat",
		},
		Runtime: plugin.Runtime{Kind: "builtin"},
		Permissions: plugin.Perms{
			Notifications: []string{"subscribe"},
			// 入站派活:@机器人 的消息进常驻管家会话,由它委派 worker
			Agents: []string{"spawn"},
			// write 为高危能力:listener 向管家会话投递收件通知(session.send)、
			// graceful recycle 收会话(session.kill,仅限本插件会话)都要它;
			// 每次调用均过宿主审计日志
			Sessions: []string{"read", "write"},
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
				{ID: "feishu-bridge.bind-token", Title: plugin.LocaleText{"zh-CN": "生成 owner 绑定口令(10 分钟有效)", "en-US": "Generate an owner bind token (valid 10 min)"}},
				{ID: "feishu-bridge.delegate", Title: plugin.LocaleText{"zh-CN": "委派 worker 会话(管家的打包派活命令)", "en-US": "Delegate a worker session (concierge's packaged dispatch)"}},
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
					Description: plugin.LocaleText{"zh-CN": "留空=concierge:常驻管家接管全部消息,自答或委派 worker;interactive:每任务一个 Agent 会话;oneshot:一次性跑完,日志截尾回报", "en-US": "Empty = concierge: a resident agent handles all messages, answering or delegating workers; interactive: one agent session per task; oneshot: run once and report the log tail"},
					Options:     []string{"", "concierge", "interactive", "oneshot"}},
				{Key: "workspace", Group: "task",
					Title:       plugin.LocaleText{"zh-CN": "管家工作目录", "en-US": "Concierge workspace"},
					Description: plugin.LocaleText{"zh-CN": "常驻管家的家:AGENT.md(角色与协议,可自行修改)、MEMORY.md、tasks/ 台账、inbox.jsonl 收件箱都在这里", "en-US": "Home of the resident concierge: AGENT.md (role & protocol, editable), MEMORY.md, tasks/ ledger and inbox.jsonl live here"},
					Placeholder: "~/.ttmux/plugins/feishu/workspace"},
				{Key: "tick_interval", Group: "task",
					Title:       plugin.LocaleText{"zh-CN": "心跳巡逻间隔", "en-US": "Patrol tick interval"},
					Description: plugin.LocaleText{"zh-CN": "每隔这么久给管家投一次 tick,它会巡检超时 worker、跟进悬置事项;如 10m/30m,填 off 关闭", "en-US": "Interval between patrol ticks (e.g. 10m/30m); the concierge checks stalled workers and pending items; 'off' disables"},
					Placeholder: "10m"},
				{Key: "recycle_at", Group: "task",
					Title:       plugin.LocaleText{"zh-CN": "每日重建时刻", "en-US": "Daily recycle time"},
					Description: plugin.LocaleText{"zh-CN": "HH:MM(如 04:00)优雅重建管家会话防上下文膨胀:先通知写 checkpoint、等空闲再收;留空不自动重建", "en-US": "HH:MM (e.g. 04:00) to gracefully rebuild the concierge (checkpoint → idle → recycle); empty disables"},
					Placeholder: "04:00"},
				{Key: "owner_open_id", Group: "inbound",
					Title:       plugin.LocaleText{"zh-CN": "Owner open_id", "en-US": "Owner open_id"},
					Description: plugin.LocaleText{"zh-CN": "唯一能指挥管家的主人;推荐经绑定流程自动写入:本机执行 ttmux plugin run feishu-bridge.bind-token 拿一次性口令,再在飞书里说「绑定通知 <口令>」", "en-US": "The only user who commands the concierge; prefer the bind flow: run feishu-bridge.bind-token locally, then say \"绑定通知 <token>\" in Feishu"},
					Placeholder: "ou_xxxxxxxx"},
				{Key: "allow_users", Group: "inbound",
					Title:       plugin.LocaleText{"zh-CN": "额外允许的用户", "en-US": "Additional allowed users"},
					Description: plugin.LocaleText{"zh-CN": "除 owner 外可指挥管家的用户 open_id,逗号分隔;其他人 @机器人 会被拒绝", "en-US": "open_ids (comma-separated) allowed besides the owner; anyone else is refused"},
					Placeholder: "ou_aaa,ou_bbb"},
				{Key: "allow_chats", Group: "inbound",
					Title:       plugin.LocaleText{"zh-CN": "允许的会话", "en-US": "Allowed chats"},
					Description: plugin.LocaleText{"zh-CN": "限定只在这些 chat_id 里响应(逗号分隔);留空=不按会话限制(仍按用户白名单校验)", "en-US": "Restrict to these chat_ids (comma-separated); empty = no chat restriction (user whitelist still applies)"},
					Placeholder: "oc_xxx,oc_yyy"},
			},
		},
	}
}
