// Package phone 把一台「手机」（虚拟机/模拟器/真机）的画面镜像到浏览器端，并转发点按/输入。
//
// 与 browser 包同构：browser 镜像 Chrome（CDP），phone 镜像手机。后端由设置页选的「模式」决定：
//   - local/remote/device → Android（adb；本地/远程 redroid、Android 真机）
//   - ios                 → iOS 模拟器（simctl + idb，仅 macOS）
//
// 不自造 CLI：agent 直接用原生 adb/simctl/idb（模型对其理解更好）。本包只做「画面镜像 +
// Web 端输入 + 设备生命周期」，具体自动化命令交给模型。
package phone

import "errors"

// Status 是设备可用性，回显到 UI（连不上时 Error 给原因）。
type Status struct {
	OK       bool   `json:"ok"`
	Platform string `json:"platform"`         // android | ios | unsupported
	Device   string `json:"device,omitempty"` // 目标标识：型号 / serial / udid
	Error    string `json:"error,omitempty"`
}

// App 是一个可启动的应用。
type App struct {
	ID   string `json:"id"`             // 包名 / bundleId
	Name string `json:"name,omitempty"` // 展示名（取不到时前端回落到 ID）
}

// Element 是屏幕上的一个 UI 元素（来自 uiautomator dump / idb describe-all），
// 给 agent「看结构算坐标」用，比纯像素猜更可靠。
type Element struct {
	Text      string `json:"text,omitempty"`
	Desc      string `json:"desc,omitempty"`  // content-desc / 无障碍标签
	Class     string `json:"class,omitempty"` // 控件类型
	Clickable bool   `json:"clickable"`
	X         int    `json:"x"`      // 中心点 X（设备像素，可直接 tap）
	Y         int    `json:"y"`      // 中心点 Y
	Bounds    [4]int `json:"bounds"` // [left, top, right, bottom]
}

// Device 是平台无关的手机后端。两个实现：androidDevice / iosDevice。
type Device interface {
	Ensure() error                                              // 拉起/附着设备，轮询就绪
	Health() Status                                             // 可用性 + 平台 + 目标标识
	CaptureJPEG(quality int) (jpeg []byte, w, h int, err error) // 截一帧并编码为 JPEG
	Tap(x, y int) error
	Swipe(x1, y1, x2, y2, ms int) error
	Text(s string) error
	Key(name string) error // back | home | enter | recents | power
	Apps() ([]App, error)
	Launch(id string) error
	UIDump() ([]Element, error) // 屏幕元素树
}

// 两个后端都无状态（按 config 动态取目标），用包级单例即可。
var (
	androidImpl = newAndroidDevice()
	iosImpl     = newIOSDevice()
)

// Current 按设置页选的模式返回设备后端：
//   - mode=ios          → iOS（simctl + idb，仅 macOS 可用）
//   - local/remote/device → Android（adb，Linux/macOS 均有 adb）
//
// 注意：后端由「模式」决定而非主机系统——这样 Mac 上既能选 iOS 模拟器，也能选远程 redroid/Android 真机；
// Linux 上选 iOS 会在 Ensure/Health 明确报「未找到 xcrun」。
func Current() Device {
	switch getConfig().Active {
	case "ios":
		return iosImpl
	case "android":
		return androidImpl
	default: // "" = 两个开关都关 → 未启用
		return disabledDevice{}
	}
}

// disabledDevice：手机未启用（设置里 Android/iOS 开关都关）时的占位，所有操作给清晰提示。
var errDisabled = errors.New("手机未启用（在设置里打开 Android 或 iOS）")

type disabledDevice struct{}

func (disabledDevice) Ensure() error { return errDisabled }
func (disabledDevice) Health() Status {
	return Status{OK: false, Platform: "none", Error: errDisabled.Error()}
}
func (disabledDevice) CaptureJPEG(int) ([]byte, int, int, error) { return nil, 0, 0, errDisabled }
func (disabledDevice) Tap(int, int) error                        { return errDisabled }
func (disabledDevice) Swipe(int, int, int, int, int) error       { return errDisabled }
func (disabledDevice) Text(string) error                         { return errDisabled }
func (disabledDevice) Key(string) error                          { return errDisabled }
func (disabledDevice) Apps() ([]App, error)                      { return nil, errDisabled }
func (disabledDevice) Launch(string) error                       { return errDisabled }
func (disabledDevice) UIDump() ([]Element, error)                { return nil, errDisabled }
