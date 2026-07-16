// 自注册:manifest 与实现同住本包,import 即生效(见 sdk.RegisterBuiltin)。
package cron

import (
	"ttmux-cli-go/pkg/plugin/manifest"
	"ttmux-cli-go/pkg/plugin/sdk"
)

func init() { sdk.RegisterBuiltin(Manifest(), Activate) }

// Manifest declares the plugin (docs/design/plugin/05-manifest.md).
//
// 定位:v1 的 watcher 调度器(manifest watchers + onSchedule)尚未落地,本插件
// 用「常驻会话跑调度循环」的既有形态(同 review-mesh.watch / im.listen)自带
// 一个 cron 调度器——用户在 storage 里登记若干定时任务,由 cron.serve 常驻
// 会话按点触发,或让系统 crontab 周期性调 cron.tick 无常驻触发。
func Manifest() manifest.Manifest {
	return manifest.Manifest{
		ManifestVersion: 1,
		ID:              "roam.cron",
		Publisher:       "roam",
		Name:            "cron",
		DisplayName:     manifest.LocaleText{"zh-CN": "定时任务", "en-US": "Cron"},
		Version:         "0.1.0",
		Description: manifest.LocaleText{
			"zh-CN": "定时任务调度:按「每隔 N」或「每天 HH:MM」触发——发通知提醒、拉 Agent 干活、或给会话发消息;常驻 cron.serve 巡检,也可让系统 crontab 调 cron.tick",
			"en-US": "Scheduled tasks: fire on an interval or a daily time to send a notification, spawn an agent, or message a session; run cron.serve resident, or drive cron.tick from system crontab",
		},
		Runtime: manifest.Runtime{Kind: "builtin"},
		Permissions: manifest.Perms{
			// notify 动作发通知;agent 动作拉 Agent 会话;send 动作给会话发消息。
			// 不声明 command.exec:任意命令白名单无从收窄,定时跑 shell 请用系统 crontab。
			Notifications: []string{"publish"},
			Agents:        []string{"spawn"},
			Sessions:      []string{"read", "write"},
		},
		ActivationEvents: []string{
			"onCommand:cron.add", "onCommand:cron.list", "onCommand:cron.remove",
			"onCommand:cron.run", "onCommand:cron.tick", "onCommand:cron.serve",
		},
		Contributes: manifest.Contribs{
			Commands: []manifest.CommandContrib{
				{ID: "cron.add", Title: manifest.LocaleText{"zh-CN": "添加/更新一个定时任务", "en-US": "Add or update a scheduled task"}},
				{ID: "cron.list", Title: manifest.LocaleText{"zh-CN": "列出定时任务与下次触发时间", "en-US": "List scheduled tasks and next run times"}},
				{ID: "cron.remove", Title: manifest.LocaleText{"zh-CN": "删除一个定时任务", "en-US": "Remove a scheduled task"}},
				{ID: "cron.run", Title: manifest.LocaleText{"zh-CN": "立即触发一个任务(不改动排期)", "en-US": "Run a task now (schedule untouched)"}},
				{ID: "cron.tick", Title: manifest.LocaleText{"zh-CN": "巡检一次并触发所有到期任务", "en-US": "Fire all due tasks once"}},
				{ID: "cron.serve", Title: manifest.LocaleText{"zh-CN": "常驻调度器:按点持续触发到期任务", "en-US": "Resident scheduler loop"}},
			},
		},
	}
}
