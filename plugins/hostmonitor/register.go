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
		},
	}
}
