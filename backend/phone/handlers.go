// handlers.go：/api/phone/* 的 REST 处理器（健康/App/按键/UI 结构）。
// 画面与连续输入走 WS（screencast.go）；这些是离散的一次性操作。
package phone

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/gin-gonic/gin"
)

func inPath(name string) bool { _, err := exec.LookPath(name); return err == nil }

// findInstallScript 定位 scripts/install-phone.sh（cwd 优先，再试可执行文件相邻 / 上级）。
func findInstallScript() string {
	cands := []string{"scripts/install-phone.sh"}
	if exe, err := os.Executable(); err == nil {
		d := filepath.Dir(exe)
		cands = append(cands, filepath.Join(d, "scripts", "install-phone.sh"),
			filepath.Join(d, "..", "scripts", "install-phone.sh"))
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

// Platforms 报告各平台的安装/支持状态 + 当前激活平台(供设置页两个开关)。
func Platforms(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"active":  getConfig().Platform,
		"android": gin.H{"installed": platformInstalled("android")},
		"ios":     gin.H{"installed": platformInstalled("ios"), "supported": runtime.GOOS == "darwin"},
	}})
}

// Install 按需(插件化)安装某平台依赖:开关打开时由前端触发,跑 scripts/install-phone.sh <platform>。
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
	script := findInstallScript()
	if script == "" {
		c.JSON(http.StatusOK, gin.H{"error": "找不到 scripts/install-phone.sh,请手动安装依赖（Android: adb；iOS: idb）"})
		return
	}
	out, _ := runCmd(180*time.Second, "bash", script, body.Platform)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"installed": platformInstalled(body.Platform), "log": string(out)}})
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
	dev := Current()
	_ = dev.Ensure()
	// Android 才按设置的分辨率预设改设备显示(wm size/density)。
	if getConfig().Platform == "android" {
		_ = androidImpl.SetResolution(getConfig().Resolution)
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"config": getConfig(), "health": dev.Health()}})
}

// Connect 按当前配置重连并回健康（设置页「测试连接」）。
func Connect(c *gin.Context) {
	_ = Current().Ensure()
	c.JSON(http.StatusOK, gin.H{"data": Current().Health()})
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
