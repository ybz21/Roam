// handlers.go：/api/phone/* 的 REST 处理器（健康/App/按键/UI 结构）。
// 画面与连续输入走 WS（screencast.go）；这些是离散的一次性操作。
package phone

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// installMu 串行化平台依赖安装：避免前端多次点/多标签并发触发多个 brew install，
// 互相撞下载锁导致全部失败、UI 卡住。第二个请求直接快速返回“安装进行中”。
var installMu sync.Mutex

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
	if !installMu.TryLock() {
		c.JSON(http.StatusOK, gin.H{"error": "已有依赖安装在进行中，请稍候（勿重复点击）"})
		return
	}
	defer installMu.Unlock()
	// 上锁后二次确认：可能刚好被上一个安装装好了，避免多余的一趟 brew。
	if platformInstalled(body.Platform) {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"installed": true, "log": "依赖已就绪"}})
		return
	}
	out, _ := runCmd(180*time.Second, "bash", script, body.Platform)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"installed": platformInstalled(body.Platform), "log": string(out)}})
}

// legacyRedroidRunning 探测遗留的 redroid 容器。ttmux 已不再管理它（那条路下线了），
// 但用户机器上可能还跑着一个占着 5555 端口——设置页据此提示一句，删不删由用户决定。
func legacyRedroidRunning() bool {
	if !inPath("docker") {
		return false
	}
	out, err := runCmd(5*time.Second, "docker", "ps", "--filter", "name=ttmux-redroid", "--format", "{{.Names}}")
	return err == nil && strings.Contains(string(out), "ttmux-redroid")
}

// currentAVD 返回当前配置指向的 AVD 名：显式选的优先，否则从 serial 反查。
func currentAVD(cfg Config) string {
	a := cfg.Android
	if a.Avd != "" {
		return a.Avd
	}
	if strings.HasPrefix(a.Address, "avd:") {
		return avdNameFromRef(a.Address)
	}
	if strings.HasPrefix(a.Address, "emulator-") {
		return avdOfSerial(a.Address)
	}
	return ""
}

// rememberAVDSerial 把刚起来的 serial 写回配置：后续每条 adb 命令就不必再问一遍控制台
// 「这台 AVD 现在是哪个 serial」（镜像按帧调 target()，那两次 adb 往返省不得）。
func rememberAVDSerial(name, serial string) {
	c := getConfig()
	if c.Android.Mode != "avd" || serial == "" {
		return
	}
	if c.Android.Address == serial && c.Android.Avd == name {
		return
	}
	c.Android.Avd, c.Android.Address = name, serial
	setConfig(c)
}

// iosSimBooted 当前是否有已启动的 iOS 模拟器。
func iosSimBooted() bool {
	out, err := runCmd(4*time.Second, "xcrun", "simctl", "list", "devices", "booted")
	return err == nil && strings.Contains(string(out), "Booted")
}

// canStartStop：只有「本机能起停的设备」才有启动/停止语义——本机模拟器(AVD)、iOS 模拟器。
// 这也是三种 Android 来源的分界线：avd 能起停，network 只能连断，device 只能连。
func canStartStop(cfg Config) bool {
	return (cfg.Active == "android" && cfg.Android.Mode == "avd") || (cfg.Active == "ios" && cfg.IOS.Mode == "simulator")
}

// isNetworkTarget：host:port 形式（无线调试真机 / 另一台机器上的安卓）需要 adb connect/disconnect。
// avd:<名> 也含冒号但不是网络目标，排除掉。
func isNetworkTarget(cfg Config) bool {
	a := cfg.Android.Address
	return cfg.Active == "android" && strings.Contains(a, ":") && !strings.HasPrefix(a, "avd:")
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
	if cfg.Active == "android" && cfg.Android.Mode == "avd" {
		if name := currentAVD(cfg); name != "" {
			data["running"] = serialOfAVD(name) != ""
			data["avd"] = name
		}
		data["legacyRedroid"] = legacyRedroidRunning()
	} else if cfg.Active == "ios" && cfg.IOS.Mode == "simulator" {
		data["running"] = iosSimBooted()
	}
	h := Current().Health() // android Health 现已轻快（不主动 connect）
	data["connected"] = h.OK
	data["device"] = h.Device
	data["error"] = h.Error
	c.JSON(http.StatusOK, gin.H{"data": data})
}

// Start 运行层：起设备。本机模拟器→emulator -avd；iOS 模拟器→simctl boot；其余来源无此语义。
// body 可带 {"name":"<AVD>","wipe":true}：不带就起当前选中的那台。
func Start(c *gin.Context) {
	cfg := getConfig()
	switch {
	case cfg.Active == "android" && cfg.Android.Mode == "avd":
		var body struct {
			Name string `json:"name"`
			Wipe bool   `json:"wipe"`
		}
		_ = c.ShouldBindJSON(&body)
		name := strings.TrimSpace(body.Name)
		if name == "" {
			name = currentAVD(cfg)
		}
		if name == "" {
			c.JSON(http.StatusOK, gin.H{"error": "请先从设备列表选择一台模拟器"})
			return
		}
		serial, err := startAVD(name, body.Wipe)
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"error": err.Error(), "data": gin.H{"log": avdLogTail(name, 4000)}})
			return
		}
		rememberAVDSerial(name, serial)
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"running": true, "device": serial, "health": Current().Health()}})
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
		c.JSON(http.StatusOK, gin.H{"error": "该来源无需启动（真机与远程设备在外部运行）"})
	}
}

// Stop 运行层：停设备。本机模拟器→adb emu kill（整机关机）；iOS 模拟器→simctl shutdown。
func Stop(c *gin.Context) {
	cfg := getConfig()
	switch {
	case cfg.Active == "android" && cfg.Android.Mode == "avd":
		var body struct {
			Name string `json:"name"`
		}
		_ = c.ShouldBindJSON(&body)
		name := strings.TrimSpace(body.Name)
		if name == "" {
			name = currentAVD(cfg)
		}
		serial := serialOfAVD(name)
		if serial == "" {
			c.JSON(http.StatusOK, gin.H{"error": "该模拟器没有在运行"})
			return
		}
		if err := stopAVD(serial); err != nil {
			c.JSON(http.StatusOK, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"running": false}})
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
	if cfg.Active == "android" && cfg.Android.Mode == "avd" {
		if name := currentAVD(cfg); name != "" && serialOfAVD(name) == "" {
			serial, err := startAVD(name, false)
			if err != nil {
				log += err.Error() + "\n" + avdLogTail(name, 2000)
			} else {
				rememberAVDSerial(name, serial)
				log += "模拟器 " + name + " 已就绪（" + serial + "）\n"
			}
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

// Devices 列出当前平台的目标设备（设置页与镜像页据此把设备摆出来、点一下就换）。
//
// Android 一台机器上模拟器与真机常常同时挂着，所以这里不做筛选：
//   - 未就绪的也报（offline / unauthorized），否则真机没授权 USB 调试时列表里凭空少一台，
//     用户只看到「连不上」而不知道是哪台、为什么；
//   - 配置里的目标即使 adb 看不见（远程设备还没 connect）也补一条，
//     不然「当前用的是哪台」会从 UI 上消失。
func Devices(c *gin.Context) {
	type dev struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Kind    string `json:"kind"`            // android: emulator|network|usb；ios: simulator|device
		State   string `json:"state,omitempty"` // device | offline | unauthorized
		Current bool   `json:"current,omitempty"`
	}
	list := []dev{}
	plat := c.Query("platform")
	if plat == "" {
		plat = getConfig().Active
	}
	if plat == "ios" {
		cur := strings.TrimSpace(getConfig().IOS.Address)
		if inPath("idb") { // idb list-targets：Name | UDID | state | type | os
			out, _ := runCmd(8*time.Second, "idb", "list-targets")
			for _, ln := range strings.Split(string(out), "\n") {
				p := strings.Split(ln, "|")
				if len(p) >= 4 {
					id := strings.TrimSpace(p[1])
					list = append(list, dev{ID: id, Name: strings.TrimSpace(p[0]), Kind: strings.TrimSpace(p[3]),
						State: strings.TrimSpace(p[2]), Current: id != "" && id == cur})
				}
			}
		}
		c.JSON(http.StatusOK, gin.H{"data": list})
		return
	}
	// 目标留空=adb 默认设备：把实际那台标成当前，否则「默认单设备」下列表里一台都不选中。
	cur := androidImpl.target()
	if cur == "" {
		cur = androidImpl.soleReadySerial()
	}
	attached := androidImpl.devices()
	running := runningAVDs(attached) // AVD 名 → serial
	bySerial := map[string]string{}
	for name, serial := range running {
		bySerial[serial] = name
	}
	curAVD := currentAVD(getConfig())
	seen := map[string]bool{}
	for _, a := range attached {
		seen[a.Serial] = true
		name := a.Model
		if n := bySerial[a.Serial]; n != "" {
			name = n // 模拟器报 AVD 名（xh_tv1080p）比报机型名（sdk_google_atv64_x86_64）认得出
		}
		list = append(list, dev{ID: a.Serial, Name: name, Kind: androidKind(a.Serial), State: a.State, Current: a.Serial == cur})
	}
	// 没跑起来的 AVD 也摆出来：只列 adb 看得见的，等于「停掉一台就从界面上消失」，
	// 用户于是又得回命令行去起它。
	for _, n := range listAVDs() {
		if _, on := running[n]; on {
			continue
		}
		list = append(list, dev{ID: avdRef(n), Name: n, Kind: "avd", State: "stopped", Current: n == curAVD})
	}
	if cur != "" && !seen[cur] && !strings.HasPrefix(cur, "avd:") {
		list = append(list, dev{ID: cur, Name: cur, Kind: androidKind(cur), State: "offline", Current: true})
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
	// 只存配置，不主动连接（连接交给 /phone/connect 或 /phone/auto）。
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"config": getConfig(), "health": Current().Health()}})
}

// ── 本机模拟器(AVD)：目录 / 新建 / 进度 / 删除 ──

// AVDCatalog 回新建向导要的全部选项：机型档、系统镜像、已有 AVD、工具链是否就位。
// ?remote=1 才去拉远端镜像目录（那趟要几十秒），默认只回本地扫得到的。
func AVDCatalog(c *gin.Context) {
	withRemote := c.Query("remote") == "1"
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"devices": deviceProfiles(),
		"images":  avdCatalog(withRemote),
		"avds":    listAVDs(),
		"remote":  withRemote,
		"abi":     hostABI(),
		"tools": gin.H{
			"emulator":   sdkTool("emulator") != "",
			"sdkmanager": sdkTool("sdkmanager") != "",
			"avdmanager": sdkTool("avdmanager") != "",
			"sdkRoot":    sdkRoot(),
		},
	}})
}

// AVDCreate 发号即返回：真正的活（下载镜像动辄几 GB）在后台任务里跑，进度走 AVDTask 的 SSE。
func AVDCreate(c *gin.Context) {
	var req avdCreateReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusOK, gin.H{"error": "无效参数"})
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.Pkg = strings.TrimSpace(req.Pkg)
	if err := validateCreate(req, listAVDs(), imageInstalled(req.Pkg)); err != nil {
		c.JSON(http.StatusOK, gin.H{"error": err.Error()})
		return
	}
	t := newTask()
	go runCreate(t, req)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"taskId": t.ID}})
}

// AVDTask 用 SSE 推创建进度：客户端关掉抽屉、重连、换页面都不影响后台任务，重连后从头补齐日志。
// 线格式与 /stream/status 一致（event + 多行 data），另起一份是为了不让 phone 依赖 stream 包。
func AVDTask(c *gin.Context) {
	t := getTask(c.Param("id"))
	if t == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "任务不存在或已过期"})
		return
	}
	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		c.Status(http.StatusInternalServerError)
		return
	}
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	sent := 0
	for {
		lines, pct, status, errMsg, wait := t.snapshot(sent)
		sent += len(lines)
		payload, _ := json.Marshal(gin.H{"lines": lines, "pct": pct, "status": status, "error": errMsg})
		writeAVDEvent(c, "task", string(payload))
		flusher.Flush()
		if status != "running" {
			return
		}
		select {
		case <-c.Request.Context().Done():
			return
		case <-wait:
		case <-time.After(20 * time.Second): // 心跳：别让中间代理掐掉闲置连接
		}
	}
}

func writeAVDEvent(c *gin.Context, event, data string) {
	io.WriteString(c.Writer, "event: "+event+"\n")
	for _, line := range strings.Split(data, "\n") {
		io.WriteString(c.Writer, "data: "+line+"\n")
	}
	io.WriteString(c.Writer, "\n")
}

// AVDDelete 删除一台模拟器（连同它的应用与数据）。运行中的会被拒绝。
func AVDDelete(c *gin.Context) {
	name := c.Param("name")
	if err := deleteAVD(name); err != nil {
		c.JSON(http.StatusOK, gin.H{"error": err.Error()})
		return
	}
	// 删的正好是当前选中的那台：把配置指针挪开，否则设置页会一直指着一台不存在的机器。
	cfg := getConfig()
	if currentAVD(cfg) == name {
		cfg.Android.Avd, cfg.Android.Address = "", ""
		setConfig(cfg)
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}

// ── USB 真机：救连接 / 转无线 ──

// DeviceReconnect POST /phone/device/reconnect {serial,state}
// 未授权/离线时让手机重弹授权框，其余情况让这台自己重连一次。
func DeviceReconnect(c *gin.Context) {
	var body struct{ Serial, State string }
	_ = c.ShouldBindJSON(&body)
	log, err := reconnectDevice(strings.TrimSpace(body.Serial), body.State)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"error": err.Error(), "data": gin.H{"log": log}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"log": log}})
}

// DeviceWireless POST /phone/device/wireless {serial}
// 把 USB 真机切到无线调试并连上；成功后把配置指向新地址，用户可以拔线了。
func DeviceWireless(c *gin.Context) {
	var body struct{ Serial string }
	_ = c.ShouldBindJSON(&body)
	addr, err := switchToWireless(strings.TrimSpace(body.Serial))
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"error": err.Error()})
		return
	}
	cfg := getConfig()
	cfg.Active = "android"
	cfg.Android.Mode, cfg.Android.Address, cfg.Android.Avd = "network", addr, ""
	setConfig(cfg)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"address": addr, "health": Current().Health()}})
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
