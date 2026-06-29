// config.go：手机后端配置，持久化到 <dataDir>/phone-config.json，由设置页两张卡片管理。
//
// 嵌套结构：Android 与 iOS 各存各的设置（互不覆盖），Active 决定哪个平台在驱动镜像。
//
//	Android: mode=local|remote|device + address(adb host:port/serial) + resolution
//	iOS:     mode=simulator|device + address(模拟器/设备 UDID)
//	Active:  android|ios|""（空=都不启用）
package phone

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

// AndroidCfg 是 Android 卡片的设置。
type AndroidCfg struct {
	Mode       string `json:"mode"`    // local | remote | device
	Address    string `json:"address"` // adb host:port / USB serial
	Resolution string `json:"resolution,omitempty"`
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

// resPreset 是一组 adb wm size/density 取值。
type resPreset struct{ Size, Density string }

// ResolutionPresets: 设置页可选的设备分辨率档(平板等)。key 不在表里(含 "" / "phone")= 还原原生。
var ResolutionPresets = map[string]resPreset{
	"tablet":       {Size: "1200x1920", Density: "240"},
	"tablet-land":  {Size: "1920x1200", Density: "240"},
	"tablet-large": {Size: "2560x1600", Density: "280"},
}

var cfgStore struct {
	mu   sync.Mutex
	file string
	cur  Config
}

// 默认：macOS 默认激活 iOS；其它默认激活 Android（本地 redroid）。两边都给好默认子配置。
func defaultConfig() Config {
	c := Config{
		Android: AndroidCfg{Mode: "local", Address: "localhost:5555"},
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
		var old struct{ Platform, Mode, Address, Resolution string }
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
			c.Android.Resolution = old.Resolution
		}
		cfgStore.cur = c
	}
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
		c.Android.Mode = "local"
	}
	if c.IOS.Mode == "" {
		c.IOS.Mode = "simulator"
	}
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
