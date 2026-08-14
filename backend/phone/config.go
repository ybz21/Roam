// config.go：手机后端配置，持久化到 <dataDir>/phone-config.json，由设置页两张卡片管理。
//
// 嵌套结构：Android 与 iOS 各存各的设置（互不覆盖），Active 决定哪个平台在驱动镜像。
//
//	Android: mode=avd|network|device + address(adb serial/host:port) + avd(AVD 名)
//	iOS:     mode=simulator|device + address(模拟器/设备 UDID)
//	Active:  android|ios|""（空=都不启用）
//
// 三种来源的分界线是「谁能起停它」：avd 我们能起能停，network 只能连和断，device 只能连。
// 曾有 local/remote 两档 redroid（docker 容器），已下线——它把成本压在宿主内核上（binder 要
// sudo modprobe、无 ashmem 就封顶 Android 15），却拿不出 TV/Wear/GMS 镜像。旧配置由
// sanitizeAndroid 自动迁移，见那里的注释。
package phone

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// AndroidCfg 是 Android 卡片的设置。
type AndroidCfg struct {
	Mode    string `json:"mode"`    // avd | network | device
	Address string `json:"address"` // adb serial：emulator-xxxx / host:port / USB serial
	// Avd 是 AVD 名。没跑起来的模拟器没有 serial，只有名字指得动它——所以 Address 之外还要这一个。
	Avd string `json:"avd,omitempty"`
}

// IOSCfg 是 iOS 卡片的设置。
type IOSCfg struct {
	Mode    string `json:"mode"`    // simulator | device
	Address string `json:"address"` // 模拟器/真机 UDID（空=booted/未选）
}

type Config struct {
	Active  string     `json:"active"` // android | ios | ""（驱动镜像的平台）
	Android AndroidCfg `json:"android"`
	IOS     IOSCfg     `json:"ios"`
}

var cfgStore struct {
	mu   sync.Mutex
	file string
	cur  Config
}

// 默认：macOS 默认激活 iOS；其它默认激活 Android（本机模拟器）。两边都给好默认子配置。
// 地址留空 = adb 默认设备：插着的那台真机也能直接用，不像旧的 localhost:5555 那样开箱即「连不上」。
func defaultConfig() Config {
	c := Config{
		Android: AndroidCfg{Mode: "avd"},
		IOS:     IOSCfg{Mode: "simulator"},
	}
	if runtime.GOOS == "darwin" {
		c.Active = "ios"
	} else {
		c.Active = "android"
	}
	return c
}

// InitConfig 加载配置：新结构(含 android 键)直接用；旧扁平结构(含 platform 键)迁移；都没有用默认。
func InitConfig(dataDir string) {
	cfgStore.mu.Lock()
	defer cfgStore.mu.Unlock()
	// 无论走哪条分支(新结构/旧迁移/默认)，落定前都自愈一遍脏配置。
	defer func() { cfgStore.cur.Android = sanitizeAndroid(cfgStore.cur.Android) }()
	cfgStore.cur = defaultConfig()
	if dataDir == "" {
		return
	}
	_ = os.MkdirAll(dataDir, 0o755)
	cfgStore.file = filepath.Join(dataDir, "phone-config.json")
	b, err := os.ReadFile(cfgStore.file)
	if err != nil {
		return
	}
	var probe map[string]json.RawMessage
	_ = json.Unmarshal(b, &probe)
	if _, isNew := probe["android"]; isNew {
		var c Config
		if json.Unmarshal(b, &c) == nil {
			cfgStore.cur = c
		}
		return
	}
	if _, isOld := probe["platform"]; isOld { // 迁移旧扁平 {platform,mode,address,resolution}
		var old struct{ Platform, Mode, Address string }
		_ = json.Unmarshal(b, &old)
		c := defaultConfig()
		c.Active = old.Platform // ""→未启用
		switch old.Platform {
		case "ios":
			c.IOS.Mode = "simulator"
			c.IOS.Address = old.Address
		case "android":
			if old.Mode != "" {
				c.Android.Mode = old.Mode
			}
			if old.Address != "" {
				c.Android.Address = old.Address
			}
		}
		cfgStore.cur = c
	}
}

// sanitizeAndroid 归一化 Android 子配置：迁移旧的 redroid 两档，再消除模式/地址/分辨率互相串档
// 导致的连不上或分辨率错乱。幂等：加载(InitConfig)与保存(setConfig)都调，脏配置无需任何 UI 操作即自愈。
//
// 迁移（redroid 下线）：
//   - local(localhost:5555) → avd + 清地址：容器不再受 ttmux 管理，指着 loopback 的地址已无意义；
//     留空即 adb 默认设备，同时保住「能起停」这层语义。
//   - remote(host:port)     → network，地址原样留着：传输方式没变，只是不再叫 redroid，
//     用户的远端设备不该因为我们改名而断。
//   - device + emulator-xxx → avd：它本来就是模拟器，只是过去无处安放。
//
// 归一（纯函数，不探测宿主）：
//   - 全字段去空白："localhost:5555  " 这类尾随空格会让 adb connect / adb -s 失败。
//   - avd：地址只收 emulator-xxxx 或空，带冒号是 redroid 残留 → 丢弃。
//   - network：地址必须带冒号，否则不是网络目标 → 丢弃。
//   - device(真机)：地址不收 host:port。
func sanitizeAndroid(a AndroidCfg) AndroidCfg {
	a.Mode = strings.TrimSpace(a.Mode)
	a.Address = strings.TrimSpace(a.Address)
	a.Avd = strings.TrimSpace(a.Avd)
	switch a.Mode {
	case "local":
		a.Mode, a.Address = "avd", ""
	case "remote":
		a.Mode = "network"
	case "device":
		if strings.HasPrefix(a.Address, "emulator-") {
			a.Mode = "avd"
		}
	}
	switch a.Mode {
	case "network":
		if !strings.Contains(a.Address, ":") {
			a.Address = ""
		}
		a.Avd = ""
	case "device":
		if strings.Contains(a.Address, ":") {
			a.Address = ""
		}
		a.Avd = ""
	default: // avd（也兜住空串与任何没见过的取值）
		a.Mode = "avd"
		if strings.Contains(a.Address, ":") {
			a.Address = ""
		}
	}
	return a
}

func getConfig() Config {
	cfgStore.mu.Lock()
	defer cfgStore.mu.Unlock()
	return cfgStore.cur
}

// 当前激活平台的子配置便捷读取（Device 实现 / handlers 用）。
func androidCfg() AndroidCfg { return getConfig().Android }
func iosCfg() IOSCfg         { return getConfig().IOS }

func setConfig(c Config) {
	if c.Android.Mode == "" {
		c.Android.Mode = "avd"
	}
	if c.IOS.Mode == "" {
		c.IOS.Mode = "simulator"
	}
	c.Android = sanitizeAndroid(c.Android)
	cfgStore.mu.Lock()
	cfgStore.cur = c
	f := cfgStore.file
	cfgStore.mu.Unlock()
	if f != "" {
		if b, err := json.MarshalIndent(c, "", "  "); err == nil {
			_ = os.WriteFile(f, b, 0o600)
		}
	}
}
