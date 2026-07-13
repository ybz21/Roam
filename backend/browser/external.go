// external.go：把当前地址甩给宿主机的真实浏览器打开，与镜像 Chrome 无关。
// 镜像 Chrome 终究是后端管的一个无头/远程调试实例；WSL 下宿主机是 Windows，
// 需要单独一条路径唤起 Windows 侧浏览器（cmd.exe/wslview），而不是操作镜像那台。
package browser

import (
	"errors"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
)

var (
	wslOnce  sync.Once
	wslIsWSL bool
)

// isWSL 判断当前是否跑在 WSL 里：环境变量优先，兜底读 /proc/version 找 "microsoft" 标识。
func isWSL() bool {
	wslOnce.Do(func() {
		if os.Getenv("WSL_DISTRO_NAME") != "" || os.Getenv("WSL_INTEROP") != "" {
			wslIsWSL = true
			return
		}
		if b, err := os.ReadFile("/proc/version"); err == nil {
			wslIsWSL = strings.Contains(strings.ToLower(string(b)), "microsoft")
		}
	})
	return wslIsWSL
}

// wslStartCmd 组一条经 cmd.exe /c start 的调用：app 传具体程序名（走 Windows「App Paths」
// 注册表解析实际安装位置，不用自己猜路径），或传 "" 走系统默认浏览器。
func wslStartCmd(app, target string) (*exec.Cmd, error) {
	p, err := exec.LookPath("cmd.exe")
	if err != nil {
		return nil, errors.New("找不到 cmd.exe，无法唤起 Windows 浏览器（检查 WSL interop 是否开启）")
	}
	// start 的第一个引号参数会被当窗口标题，传空标题占位，避免把 app/URL 当标题吞掉。
	var cmd *exec.Cmd
	if app != "" {
		cmd = exec.Command(p, "/c", "start", "", app, target)
	} else {
		cmd = exec.Command(p, "/c", "start", "", target)
	}
	// 后端 cwd 是 WSL 里的 Linux 路径，cmd.exe 起时会把它映射成 UNC 路径当当前目录，
	// 报「无法将 UNC 路径用作当前目录」；显式切到一个 /mnt/c 下的原生路径规避这个警告。
	if _, err := os.Stat("/mnt/c/Windows"); err == nil {
		cmd.Dir = "/mnt/c/Windows"
	}
	return cmd, nil
}

// openInHostBrowser 把 target 交给宿主机的浏览器打开。
func openInHostBrowser(target string) error {
	switch {
	case isWSL():
		// 用户要的是「Chrome」而非随便什么默认浏览器：用 `start chrome <url>` 让 Windows 自己
		// 按注册表「App Paths\chrome.exe」解析实际安装位置（Program Files / 用户级安装 / 别的
		// 盘都覆盖），不猜、不硬编码具体路径。cmd.Start() 只报「cmd.exe 有没有起来」，
		// 不代表 chrome 一定被找到；但没装 Chrome 时任何路径都无解，不必为此加假的探测。
		if cmd, err := wslStartCmd("chrome", target); err == nil {
			return cmd.Start()
		}
		// 找不到 cmd.exe（WSL interop 没开）：retry wslview（wslu 包，读 Windows 默认浏览器）。
		if p, err := exec.LookPath("wslview"); err == nil {
			return exec.Command(p, target).Start()
		}
		return errors.New("找不到 cmd.exe 或 wslview，无法唤起 Windows 浏览器（检查 WSL interop 是否开启）")
	case runtime.GOOS == "darwin":
		return exec.Command("open", target).Start()
	case runtime.GOOS == "windows":
		return exec.Command("cmd", "/c", "start", "", target).Start()
	default:
		if p, err := exec.LookPath("xdg-open"); err == nil {
			return exec.Command(p, target).Start()
		}
		return errors.New("找不到 xdg-open，无法打开系统浏览器")
	}
}

// OpenExternal 把指定 URL 丢给宿主机真实浏览器打开。
func OpenExternal(c *gin.Context) {
	var body struct {
		URL string `json:"url"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.URL == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"message": "缺少 url"}})
		return
	}
	u, err := url.Parse(body.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"message": "url 必须是 http(s)"}})
		return
	}
	if err := openInHostBrowser(body.URL); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": gin.H{"message": err.Error()}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}
