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
		Version:         "0.1.0",
		Description: plugin.LocaleText{
			"zh-CN": "把 Roam 通知(finding、review、告警)推送到飞书群自定义机器人,支持加签",
			"en-US": "Forward Roam notifications to a Feishu group bot webhook (with signing)",
		},
		Runtime: plugin.Runtime{Kind: "builtin"},
		Permissions: plugin.Perms{
			Notifications: []string{"subscribe"},
			Network:       plugin.NetworkPerms{AllowedDomains: []string{"https://open.feishu.cn"}},
			Secrets:       []string{"webhook", "secret"},
		},
		ActivationEvents: []string{
			"onNotification:*",
			"onCommand:feishu-bridge.test",
		},
		Contributes: plugin.Contribs{
			Commands: []plugin.CommandContrib{
				{ID: "feishu-bridge.test", Title: plugin.LocaleText{"zh-CN": "发送测试卡片", "en-US": "Send test card"}},
			},
			NotificationSinks: []plugin.SinkContrib{
				{ID: "feishu.send", Events: []string{"finding.blocking", "review.completed", "monitor.alert", "*"}},
			},
			ConfigFields: []plugin.ConfigField{
				{Key: "webhook", Secret: true,
					Title:       plugin.LocaleText{"zh-CN": "群机器人 Webhook", "en-US": "Group bot webhook"},
					Description: plugin.LocaleText{"zh-CN": "飞书群 → 设置 → 群机器人 → 自定义机器人的 Webhook 地址", "en-US": "Feishu group → Settings → Bots → Custom bot webhook URL"},
					Placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/..."},
				{Key: "secret", Secret: true,
					Title:       plugin.LocaleText{"zh-CN": "加签密钥", "en-US": "Signing secret"},
					Description: plugin.LocaleText{"zh-CN": "机器人开启「加签」时填写,否则留空", "en-US": "Only when the bot enables signature verification"}},
			},
		},
	}
}
