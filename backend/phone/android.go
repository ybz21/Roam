// android.go：Android 后端，全部经 adb。
//
// 设备选择：默认用 adb 当前唯一设备；多设备时设 ANDROID_SERIAL（adb 原生约定）指定。
// MVP 不负责拉起模拟器/容器（redroid/emulator 由用户或 start 脚本起好），只「附着 + 操作」。
package phone

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"image/jpeg"
	"image/png"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// androidDevice 无状态：每次按设置页的 phone-config 决定目标设备（serial）。
type androidDevice struct{}

func newAndroidDevice() *androidDevice { return &androidDevice{} }

// target 返回当前要操作的 adb 设备标识：
// 配置里的 Address（host:port 即 adb connect 后的 serial，或 USB serial）；
// 留空则回落 ANDROID_SERIAL（device 模式默认单设备时为空 = adb 默认设备）。
func (d *androidDevice) target() string {
	if a := androidCfg().Address; a != "" {
		return a
	}
	return os.Getenv("ANDROID_SERIAL")
}

// adbArgs 在命令前插入 -s <target>（有目标才插）。
func (d *androidDevice) adbArgs(args ...string) []string {
	if t := d.target(); t != "" {
		return append([]string{"-s", t}, args...)
	}
	return args
}

// run 执行 adb 命令（带 -s 目标作用域），合并返回 stdout（出错带 stderr 摘要）。
func (d *androidDevice) run(timeout time.Duration, args ...string) ([]byte, error) {
	return d.execAdb(timeout, true, args...)
}

// execAdb 执行 adb；scoped=true 时带 -s 目标，false 时不带（用于 connect/devices 这类全局命令）。
func (d *androidDevice) execAdb(timeout time.Duration, scoped bool, args ...string) ([]byte, error) {
	a := args
	if scoped {
		a = d.adbArgs(args...)
	}
	cmd := exec.Command("adb", a...)
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("adb 启动失败（未安装？）: %w", err)
	}
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			msg := strings.TrimSpace(errb.String())
			if msg == "" {
				msg = err.Error()
			}
			return out.Bytes(), fmt.Errorf("%s", msg)
		}
		return out.Bytes(), nil
	case <-time.After(timeout):
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("adb 超时（%s）", strings.Join(args, " "))
	}
}

func (d *androidDevice) shell(timeout time.Duration, args ...string) ([]byte, error) {
	return d.run(timeout, append([]string{"shell"}, args...)...)
}

// SetResolution 按预设改设备显示尺寸/密度(adb wm size/density)。
// preset 空 / "phone" → 还原原生(wm size/density reset)；未知预设忽略。
// 密度要随分辨率一起调，否则只放大尺寸 UI 会被等比放大，得不到平板版式。
func (d *androidDevice) SetResolution(preset string) error {
	if preset == "" || preset == "phone" {
		_, _ = d.shell(6*time.Second, "wm", "size", "reset")
		_, err := d.shell(6*time.Second, "wm", "density", "reset")
		return err
	}
	p, ok := ResolutionPresets[preset]
	if !ok {
		return nil
	}
	if _, err := d.shell(6*time.Second, "wm", "size", p.Size); err != nil {
		return err
	}
	_, err := d.shell(6*time.Second, "wm", "density", p.Density)
	return err
}

// state 返回 adb get-state（device 表示已就绪）。
func (d *androidDevice) state() string {
	out, err := d.run(3*time.Second, "get-state")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// connectIfNetwork 对 host:port 形式的目标先做幂等 `adb connect`（本地/远程 redroid、无线真机）。
// USB serial（不含冒号）跳过。
func (d *androidDevice) connectIfNetwork() {
	t := d.target()
	if strings.Contains(t, ":") {
		_, _ = d.execAdb(8*time.Second, false, "connect", t)
	}
}

// keepAwake 让被镜像设备保持常亮：USB/充电时不灭屏，避免锁屏导致镜像黑屏。
// best-effort，不阻断（真机需已授权 USB 调试；redroid 上同样无害）。
func (d *androidDevice) keepAwake() {
	_, _ = d.shell(3*time.Second, "svc", "power", "stayon", "true")
}

func (d *androidDevice) Ensure() error {
	if _, err := exec.LookPath("adb"); err != nil {
		return errors.New("未找到 adb（装 Android SDK platform-tools）")
	}
	d.connectIfNetwork()
	if d.state() != "device" {
		// 没就绪：再连一次 + 等一小会（远程/无线可能正在连）。不主动拉起模拟器。
		d.connectIfNetwork()
		_, _ = d.run(8*time.Second, "wait-for-device")
		if d.state() != "device" {
			return errors.New("无已就绪的 Android 设备（adb devices 看不到 device；先连真机或起模拟器/redroid）")
		}
		// 等开机完成，避免黑屏帧
		for i := 0; i < 20; i++ {
			out, _ := d.shell(3*time.Second, "getprop", "sys.boot_completed")
			if strings.TrimSpace(string(out)) == "1" {
				break
			}
			time.Sleep(300 * time.Millisecond)
		}
	}
	d.keepAwake() // 连上即设常亮，镜像不因锁屏黑屏
	return nil
}

func (d *androidDevice) Health() Status {
	if _, err := exec.LookPath("adb"); err != nil {
		return Status{OK: false, Platform: "android", Error: "未找到 adb（装 Android SDK platform-tools）"}
	}
	// Health 只查状态、不主动 adb connect（保持轻快，供状态轮询）；连接由 /phone/connect 或 Ensure 做。
	ac := androidCfg()
	if d.state() != "device" {
		where := ac.Address
		if where == "" {
			where = "默认设备"
		}
		return Status{OK: false, Platform: "android", Error: "连不上 Android（" + modeLabel(ac.Mode) + "：" + where + "）"}
	}
	model := ""
	if out, err := d.shell(3*time.Second, "getprop", "ro.product.model"); err == nil {
		model = strings.TrimSpace(string(out))
	}
	id := d.target()
	if model != "" {
		id = model + " (" + id + ")"
	}
	return Status{OK: true, Platform: "android", Device: id}
}

func modeLabel(m string) string {
	switch m {
	case "remote":
		return "远程 redroid"
	case "device":
		return "真机"
	default:
		return "本地 redroid"
	}
}

// CaptureJPEG 截一帧 PNG（screencap -p）后转码 JPEG。exec-out 避免落盘、直出二进制。
func (d *androidDevice) CaptureJPEG(quality int) ([]byte, int, int, error) {
	raw, err := d.run(6*time.Second, "exec-out", "screencap", "-p")
	if err != nil {
		return nil, 0, 0, err
	}
	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, 0, 0, fmt.Errorf("解码截图失败: %w", err)
	}
	if quality < 10 {
		quality = 10
	} else if quality > 100 {
		quality = 100
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, 0, 0, err
	}
	b := img.Bounds()
	return buf.Bytes(), b.Dx(), b.Dy(), nil
}

func (d *androidDevice) Tap(x, y int) error {
	_, err := d.shell(4*time.Second, "input", "tap", strconv.Itoa(x), strconv.Itoa(y))
	return err
}

func (d *androidDevice) Swipe(x1, y1, x2, y2, ms int) error {
	if ms <= 0 {
		ms = 300
	}
	_, err := d.shell(6*time.Second, "input", "swipe",
		strconv.Itoa(x1), strconv.Itoa(y1), strconv.Itoa(x2), strconv.Itoa(y2), strconv.Itoa(ms))
	return err
}

// Text 输入文字。adb input text 用 %s 表示空格，且对部分符号敏感——MVP 做基本转义。
func (d *androidDevice) Text(s string) error {
	if s == "" {
		return nil
	}
	esc := s
	esc = strings.ReplaceAll(esc, " ", "%s")
	// 转义对 shell 有特殊含义的字符
	for _, ch := range []string{"\"", "'", "(", ")", "<", ">", "&", "|", ";", "*", "\\", "`", "$"} {
		esc = strings.ReplaceAll(esc, ch, "\\"+ch)
	}
	_, err := d.shell(5*time.Second, "input", "text", esc)
	return err
}

// Key 映射常用系统键到 keyevent。
func (d *androidDevice) Key(name string) error {
	var code string
	switch name {
	case "back":
		code = "4"
	case "home":
		code = "3"
	case "enter":
		code = "66"
	case "del", "backspace":
		code = "67"
	case "recents", "appswitch":
		code = "187"
	case "power":
		code = "26"
	case "volup":
		code = "24"
	case "voldown":
		code = "25"
	default:
		return fmt.Errorf("未知按键: %s", name)
	}
	_, err := d.shell(4*time.Second, "input", "keyevent", code)
	return err
}

// Apps 列第三方应用包名（-3 过滤系统包，避免几百个噪声）。
func (d *androidDevice) Apps() ([]App, error) {
	out, err := d.shell(6*time.Second, "pm", "list", "packages", "-3")
	if err != nil {
		return nil, err
	}
	var apps []App
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "package:"))
		if line != "" {
			apps = append(apps, App{ID: line})
		}
	}
	return apps, nil
}

// Launch 启动 App：先解析其 launcher activity 用 am start（干净、能拿到真实错误）；
// 解析不出再回退 monkey。注意不能直接拿 monkey 的退出码/stderr 当错误——它常打无害噪声
// （如 "SYS_KEYS has no physical keys"）却仍算失败，会误报。
func (d *androidDevice) Launch(id string) error {
	if id == "" {
		return errors.New("缺少包名")
	}
	if out, err := d.shell(5*time.Second, "cmd", "package", "resolve-activity", "--brief", id); err == nil {
		lines := strings.Split(strings.TrimSpace(string(out)), "\n")
		comp := strings.TrimSpace(lines[len(lines)-1])
		if strings.Contains(comp, "/") { // 形如 pkg/.MainActivity
			_, err = d.shell(6*time.Second, "am", "start", "-n", comp)
			return err
		}
	}
	// 回退：monkey 按 LAUNCHER 类别启动；吞掉其噪声输出，尽力而为。
	_, _ = d.shell(6*time.Second, "monkey", "-p", id, "-c", "android.intent.category.LAUNCHER", "1")
	return nil
}

// ── uiautomator dump 解析 ──

type uiNode struct {
	Bounds    string   `xml:"bounds,attr"`
	Text      string   `xml:"text,attr"`
	Desc      string   `xml:"content-desc,attr"`
	Class     string   `xml:"class,attr"`
	Clickable string   `xml:"clickable,attr"`
	Nodes     []uiNode `xml:"node"`
}

var boundsRe = regexp.MustCompile(`\[(\d+),(\d+)\]\[(\d+),(\d+)\]`)

func parseBounds(s string) ([4]int, bool) {
	m := boundsRe.FindStringSubmatch(s)
	if m == nil {
		return [4]int{}, false
	}
	var b [4]int
	for i := 0; i < 4; i++ {
		b[i], _ = strconv.Atoi(m[i+1])
	}
	return b, true
}

func flattenUI(n uiNode, out *[]Element) {
	b, ok := parseBounds(n.Bounds)
	hasLabel := strings.TrimSpace(n.Text) != "" || strings.TrimSpace(n.Desc) != ""
	if ok && (hasLabel || n.Clickable == "true") {
		*out = append(*out, Element{
			Text:      strings.TrimSpace(n.Text),
			Desc:      strings.TrimSpace(n.Desc),
			Class:     n.Class,
			Clickable: n.Clickable == "true",
			X:         (b[0] + b[2]) / 2,
			Y:         (b[1] + b[3]) / 2,
			Bounds:    b,
		})
	}
	for _, c := range n.Nodes {
		flattenUI(c, out)
	}
}

// UIDump 返回当前界面的元素列表（带坐标/文案/可点性），供 agent 看结构算坐标。
func (d *androidDevice) UIDump() ([]Element, error) {
	// dump 到 stdout（/dev/tty 让其直接输出而非写文件，部分机型也支持 `-`）
	out, err := d.shell(8*time.Second, "uiautomator", "dump", "/dev/tty")
	xmlStart := bytes.IndexByte(out, '<')
	if err != nil || xmlStart < 0 {
		// 回退：dump 到文件再 cat（更兼容）
		if _, e2 := d.shell(8*time.Second, "uiautomator", "dump", "/sdcard/ttmux_ui.xml"); e2 == nil {
			out, err = d.shell(5*time.Second, "cat", "/sdcard/ttmux_ui.xml")
			xmlStart = bytes.IndexByte(out, '<')
		}
		if err != nil || xmlStart < 0 {
			if err == nil {
				err = errors.New("uiautomator dump 无 XML 输出")
			}
			return nil, err
		}
	}
	var root uiNode
	dec := xml.NewDecoder(bytes.NewReader(out[xmlStart:]))
	// hierarchy 根下是一串 node；用一个壳解析
	var wrap struct {
		Nodes []uiNode `xml:"node"`
	}
	if err := dec.Decode(&wrap); err != nil {
		// 再试把整体当 hierarchy
		dec = xml.NewDecoder(bytes.NewReader(out[xmlStart:]))
		if err2 := dec.Decode(&root); err2 != nil {
			return nil, fmt.Errorf("解析 UI XML 失败: %w", err)
		}
		wrap.Nodes = root.Nodes
	}
	var els []Element
	for _, n := range wrap.Nodes {
		flattenUI(n, &els)
	}
	return els, nil
}
