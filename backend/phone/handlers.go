// handlers.go：/api/phone/* 的 REST 处理器（健康/App/按键/UI 结构）。
// 画面与连续输入走 WS（screencast.go）；这些是离散的一次性操作。
package phone

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

func inPath(name string) bool { _, err := exec.LookPath(name); return err == nil }

// findScript 定位 scripts/<name>（cwd 优先，再试可执行文件相邻 / 上级）。
func findScript(name string) string {
	cands := []string{filepath.Join("scripts", name)}
	if exe, err := os.Executable(); err == nil {
		d := filepath.Dir(exe)
		cands = append(cands, filepath.Join(d, "scripts", name), filepath.Join(d, "..", "scripts", name))
	}
	for _, p := range cands {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

// platformInstalled 判断某平台依赖是否就绪(插件化:开关据此显示已装/未装)。
func platformInstalled(p string) bool {
	if p == "ios" {
		return inPath("idb") && inPath("xcrun")
	}
	return inPath("adb")
}

// Platforms 报告各平台的安装/支持状态 + 当前激活平台(供设置页两张卡片)。
func Platforms(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"active":  getConfig().Active,
		"android": gin.H{"installed": platformInstalled("android")},
		"ios":     gin.H{"installed": platformInstalled("ios"), "supported": runtime.GOOS == "darwin"},
	}})
}

// Install 按需(插件化)安装某平台依赖:开关打开时由前端触发,跑 scripts/phone/install-phone.sh <platform>。
func Install(c *gin.Context) {
	var body struct {
		Platform string `json:"platform"`
	}
	_ = c.ShouldBindJSON(&body)
	if body.Platform != "android" && body.Platform != "ios" {
		c.JSON(http.StatusOK, gin.H{"error": "platform 须为 android | ios"})
		return
	}
	if platformInstalled(body.Platform) {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"installed": true, "log": "依赖已就绪"}})
		return
	}
	script := findScript("phone/install-phone.sh")
	if script == "" {
		c.JSON(http.StatusOK, gin.H{"error": "找不到 scripts/phone/install-phone.sh,请手动安装依赖（Android: adb；iOS: idb）"})
		return
	}
	out, _ := runCmd(180*time.Second, "bash", script, body.Platform)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"installed": platformInstalled(body.Platform), "log": string(out)}})
}

// redroidRunning 判断本地 redroid 容器是否在运行。
func redroidRunning() bool {
	out, err := runCmd(5*time.Second, "docker", "ps", "--filter", "name=ttmux-redroid", "--format", "{{.Names}}")
	return err == nil && strings.Contains(string(out), "ttmux-redroid")
}

// runRedroid 跑 scripts/phone/android-redroid.sh <action>（up 含开机等待故超时给足）。
func runRedroid(c *gin.Context, action string, timeout time.Duration) {
	if !inPath("docker") {
		c.JSON(http.StatusOK, gin.H{"error": "未找到 docker（本地 redroid 需要）"})
		return
	}
	s := findScript("phone/android-redroid.sh")
	if s == "" {
		c.JSON(http.StatusOK, gin.H{"error": "找不到 scripts/phone/android-redroid.sh"})
		return
	}
	out, _ := runCmd(timeout, "bash", s, action)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"log": string(out), "running": redroidRunning()}})
}

// iosSimBooted 当前是否有已启动的 iOS 模拟器。
func iosSimBooted() bool {
	out, err := runCmd(4*time.Second, "xcrun", "simctl", "list", "devices", "booted")
	return err == nil && strings.Contains(string(out), "Booted")
}

// canStartStop：只有「本机能起停的设备」才有启动/停止语义——本地 redroid 容器、iOS 模拟器。
func canStartStop(cfg Config) bool {
	return (cfg.Active == "android" && cfg.Android.Mode == "local") || (cfg.Active == "ios" && cfg.IOS.Mode == "simulator")
}

// isNetworkTarget：host:port 形式（远程 redroid / 无线真机 / 本地 redroid）需要 adb connect/disconnect。
func isNetworkTarget(cfg Config) bool {
	return cfg.Active == "android" && strings.Contains(cfg.Android.Address, ":")
}

// activeSource 返回当前激活平台的来源(mode)。
func activeSource(cfg Config) string {
	if cfg.Active == "ios" {
		return cfg.IOS.Mode
	}
	return cfg.Android.Mode
}

// StatusInfo 单一状态源：依赖/运行/连接三层 + 设备名 + 错误，供设置页动作条与状态灯。
func StatusInfo(c *gin.Context) {
	cfg := getConfig()
	data := gin.H{
		"enabled":      cfg.Active != "",
		"platform":     cfg.Active,
		"source":       activeSource(cfg),
		"installed":    cfg.Active != "" && platformInstalled(cfg.Active),
		"canStartStop": canStartStop(cfg),
		"running":      nil,
	}
	if cfg.Active == "android" && cfg.Android.Mode == "local" {
		data["running"] = redroidRunning()
	} else if cfg.Active == "ios" && cfg.IOS.Mode == "simulator" {
		data["running"] = iosSimBooted()
	}
	h := Current().Health() // android Health 现已轻快（不主动 connect）
	data["connected"] = h.OK
	data["device"] = h.Device
	data["error"] = h.Error
	c.JSON(http.StatusOK, gin.H{"data": data})
}

// Start 运行层：起设备。本地 redroid→脚本 up；iOS 模拟器→simctl boot；其余来源无此语义。
func Start(c *gin.Context) {
	cfg := getConfig()
	switch {
	case cfg.Active == "android" && cfg.Android.Mode == "local":
		runRedroid(c, "up", 240*time.Second)
	case cfg.Active == "ios" && cfg.IOS.Mode == "simulator":
		udid := strings.TrimSpace(cfg.IOS.Address)
		if udid == "" {
			c.JSON(http.StatusOK, gin.H{"error": "请先从设备列表选择模拟器 UDID"})
			return
		}
		o1, _ := runCmd(60*time.Second, "xcrun", "simctl", "boot", udid)
		o2, _ := runCmd(120*time.Second, "xcrun", "simctl", "bootstatus", udid, "-b")
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"log": string(o1) + string(o2), "running": iosSimBooted()}})
	default:
		c.JSON(http.StatusOK, gin.H{"error": "该来源无需启动（真机/远程在外部运行）"})
	}
}

// Stop 运行层：停设备。本地 redroid→脚本 down；iOS 模拟器→simctl shutdown。
func Stop(c *gin.Context) {
	cfg := getConfig()
	switch {
	case cfg.Active == "android" && cfg.Android.Mode == "local":
		runRedroid(c, "down", 30*time.Second)
	case cfg.Active == "ios" && cfg.IOS.Mode == "simulator":
		udid := strings.TrimSpace(cfg.IOS.Address)
		if udid == "" {
			udid = "booted"
		}
		out, _ := runCmd(30*time.Second, "xcrun", "simctl", "shutdown", udid)
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"log": string(out), "running": iosSimBooted()}})
	default:
		c.JSON(http.StatusOK, gin.H{"error": "该来源无需停止"})
	}
}

// Connect 连接层：网络目标做 adb connect，再 Ensure + 回健康。
func Connect(c *gin.Context) {
	cfg := getConfig()
	if isNetworkTarget(cfg) {
		_, _ = runCmd(8*time.Second, "adb", "connect", cfg.Android.Address)
	}
	_ = Current().Ensure()
	c.JSON(http.StatusOK, gin.H{"data": Current().Health()})
}

// Disconnect 连接层：网络目标 adb disconnect。
func Disconnect(c *gin.Context) {
	cfg := getConfig()
	if isNetworkTarget(cfg) {
		_, _ = runCmd(5*time.Second, "adb", "disconnect", cfg.Android.Address)
	}
	c.JSON(http.StatusOK, gin.H{"data": Current().Health()})
}

// Test 测试连接：Ensure（必要时 connect/boot）+ 回健康。
func Test(c *gin.Context) {
	_ = Current().Ensure()
	c.JSON(http.StatusOK, gin.H{"data": Current().Health()})
}

// Auto 一键：按需 装依赖 → 起设备 → 连接 → 测试，回日志 + 健康。
func Auto(c *gin.Context) {
	cfg := getConfig()
	if cfg.Active == "" {
		c.JSON(http.StatusOK, gin.H{"error": "未启用任何平台"})
		return
	}
	log := ""
	// 1. 依赖
	if !platformInstalled(cfg.Active) {
		if s := findScript("phone/install-phone.sh"); s != "" {
			out, _ := runCmd(180*time.Second, "bash", s, cfg.Active)
			log += string(out) + "\n"
		}
	}
	// 2. 起设备（仅能起停的来源）
	if cfg.Active == "android" && cfg.Android.Mode == "local" && !redroidRunning() {
		if s := findScript("phone/android-redroid.sh"); s != "" {
			out, _ := runCmd(240*time.Second, "bash", s, "up")
			log += string(out) + "\n"
		}
	} else if cfg.Active == "ios" && cfg.IOS.Mode == "simulator" {
		if udid := strings.TrimSpace(cfg.IOS.Address); udid != "" {
			_, _ = runCmd(60*time.Second, "xcrun", "simctl", "boot", udid)
			_, _ = runCmd(120*time.Second, "xcrun", "simctl", "bootstatus", udid, "-b")
		}
	}
	// 3. 连接
	if isNetworkTarget(cfg) {
		_, _ = runCmd(8*time.Second, "adb", "connect", cfg.Android.Address)
	}
	// 4. 测试
	_ = Current().Ensure()
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"log": log, "health": Current().Health()}})
}

// Devices 列出当前平台可用的目标设备（给设置页下拉选，免手敲 UDID/serial）。
func Devices(c *gin.Context) {
	type dev struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Kind string `json:"kind"` // android | simulator | device
	}
	var list []dev
	plat := c.Query("platform")
	if plat == "" {
		plat = getConfig().Active
	}
	if plat == "ios" {
		if inPath("idb") { // idb list-targets：Name | UDID | state | type | os
			out, _ := runCmd(8*time.Second, "idb", "list-targets")
			for _, ln := range strings.Split(string(out), "\n") {
				p := strings.Split(ln, "|")
				if len(p) >= 4 {
					list = append(list, dev{ID: strings.TrimSpace(p[1]), Name: strings.TrimSpace(p[0]), Kind: strings.TrimSpace(p[3])})
				}
			}
		}
	} else {
		out, _ := runCmd(5*time.Second, "adb", "devices", "-l")
		for _, ln := range strings.Split(string(out), "\n") {
			ln = strings.TrimSpace(ln)
			if ln == "" || strings.HasPrefix(ln, "List of") {
				continue
			}
			f := strings.Fields(ln)
			if len(f) >= 2 && f[1] == "device" {
				name := f[0]
				for _, x := range f {
					if strings.HasPrefix(x, "model:") {
						name = strings.TrimPrefix(x, "model:")
					}
				}
				list = append(list, dev{ID: f[0], Name: name, Kind: "android"})
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": list})
}

// Health 返回设备可用性 + 平台 + 目标标识。连不上时前端据 Error 显示原因。
func Health(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"data": Current().Health()})
}

// Apps 列出可启动应用。
func Apps(c *gin.Context) {
	apps, err := Current().Apps()
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": apps})
}

// Launch 启动指定 App（路径参数 id = 包名/bundleId）。
func Launch(c *gin.Context) {
	if err := Current().Launch(c.Param("id")); err != nil {
		c.JSON(http.StatusOK, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}

// Key 发系统键（body: {name: back|home|enter|recents|power}）。
func Key(c *gin.Context) {
	var body struct {
		Name string `json:"name"`
	}
	_ = c.ShouldBindJSON(&body)
	if err := Current().Key(body.Name); err != nil {
		c.JSON(http.StatusOK, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}

// GetConfig 返回当前手机后端配置（模式 + 地址）。
func GetConfig(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"data": getConfig()})
}

// SetConfig 保存配置并立即尝试连接，回显健康状态（设置页「保存并连接」）。
func SetConfig(c *gin.Context) {
	var body Config
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusOK, gin.H{"error": "无效配置"})
		return
	}
	setConfig(body)
	// 只存配置 + 应用分辨率，不主动连接（连接交给 /phone/connect 或 /phone/auto）。
	if getConfig().Active == "android" {
		_ = androidImpl.SetResolution(getConfig().Android.Resolution)
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"config": getConfig(), "health": Current().Health()}})
}

// UI 返回当前屏幕的元素结构（给 agent 看结构算坐标）。
func UI(c *gin.Context) {
	els, err := Current().UIDump()
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": els})
}
