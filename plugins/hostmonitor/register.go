// 自注册:manifest 与实现同住本包,import 即生效(见 sdk.RegisterBuiltin)。
package hostmonitor

import (
	"ttmux-cli-go/pkg/plugin/manifest"
	"ttmux-cli-go/pkg/plugin/sdk"
)

func init() { sdk.RegisterBuiltin(Manifest(), Activate) }

// Manifest declares the plugin (docs/design/plugin/05-manifest.md).
func Manifest() manifest.Manifest {
	return manifest.Manifest{
		ManifestVersion: 1,
		ID:              "roam.host-monitor",
		Publisher:       "roam",
		Name:            "host-monitor",
		DisplayName:     manifest.LocaleText{"zh-CN": "主机监控", "en-US": "Host Monitor"},
		Version:         "0.1.0",
		Description: manifest.LocaleText{
			"zh-CN": "宿主机资源监控:CPU/GPU/内存/磁盘/网络实时快照与趋势,Web 插件页内置仪表盘",
			"en-US": "Host machine monitoring: real-time CPU/GPU/memory/disk/network snapshots and trends, with a built-in dashboard on the plugins page",
		},
		Runtime: manifest.Runtime{Kind: "builtin"},
		Permissions: manifest.Perms{
			// 采样读本机 /proc;GPU 经 nvidia-smi(声明白名单,采集不走宿主 API)
			Commands: manifest.CommandPerms{Allow: []string{"nvidia-smi"}},
		},
		ActivationEvents: []string{"onCommand:host-monitor.stats"},
		Contributes: manifest.Contribs{
			Commands: []manifest.CommandContrib{
				{ID: "host-monitor.stats", Title: manifest.LocaleText{"zh-CN": "采集一次资源快照(含近期趋势)", "en-US": "Take a resource snapshot (with recent trend)"}},
			},
			StatusItems: statusItems(),
		},
	}
}

// statusItems 是底部状态条上的六格(docs/design/web/20-status-bar)。
//
// 这里只声明「取哪个字段、怎么画、什么算越线」——采集逻辑一行没动,值就是
// stats 命令本来就在返回的那份快照。六格 Command 相同,宿主合并成一次调用。
// 阈值由宿主判:插件报数,不报颜色。
func statusItems() []manifest.StatusItem {
	const cmd = "host-monitor.stats"
	src := func(path string) manifest.StatusSrc {
		return manifest.StatusSrc{Command: cmd, Refresh: 3, Path: path}
	}
	view := &manifest.StatusAct{Kind: "pluginView", ID: "roam.host-monitor"}
	thr := func(warn, danger float64, sustain int) *manifest.StatusThr {
		return &manifest.StatusThr{Warn: &warn, Danger: &danger, SustainSec: sustain}
	}
	return []manifest.StatusItem{
		{
			ID: "cpu", Title: manifest.LocaleText{"zh-CN": "CPU", "en-US": "CPU"},
			Align: "left", Prio: 60, Tier: 2, Render: "gauge", Unit: "percent",
			// 60s 滞后:编译和跑测试天天把 CPU 顶到 100%,按瞬时值上色两天内
			// 就没人再看这条了,连带旁边真的内存告警一起被无视。
			Source: src("cpu.usagePercent"), Thresh: thr(70, 95, 60), Click: view,
		},
		{
			ID: "memory", Title: manifest.LocaleText{"zh-CN": "内存", "en-US": "Memory"},
			Align: "left", Prio: 55, Tier: 1, Render: "gauge", Unit: "percent",
			Source: src("memory.usagePercent"), Thresh: thr(80, 92, 0), Click: view,
		},
		{
			ID: "disk", Title: manifest.LocaleText{"zh-CN": "磁盘", "en-US": "Disk"},
			Align: "left", Prio: 50, Tier: 3, Render: "text", Unit: "percent",
			Source: src("disks[0].usagePercent"), Thresh: thr(85, 95, 0), Click: view,
		},
		{
			ID: "temp", Title: manifest.LocaleText{"zh-CN": "温度", "en-US": "Temp"},
			Align: "left", Prio: 45, Tier: 3, Render: "text", Unit: "celsius",
			// 90°C 是 Jetson 的降频线
			Source: src("cpu.tempC"), Thresh: thr(80, 90, 0), Click: view,
		},
		{
			ID: "gpu", Title: manifest.LocaleText{"zh-CN": "GPU", "en-US": "GPU"},
			Align: "left", Prio: 40, Tier: 3, Render: "gauge", Unit: "percent",
			Source: src("gpus[0].utilPercent"), Thresh: thr(95, 99, 60), Click: view,
		},
		{
			ID: "net", Title: manifest.LocaleText{"zh-CN": "网络", "en-US": "Net"},
			Align: "left", Prio: 35, Tier: 4, Render: "text", Unit: "bytesPerSec",
			Source: src("network.rxBytesPerSec"), Click: view,
		},
	}
}
