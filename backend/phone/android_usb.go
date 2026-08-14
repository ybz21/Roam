// android_usb.go：USB 真机独有的两个动作——把卡住的连接救回来，以及拔线改走无线。
//
// 真机的生死不归 ttmux 管（不像 AVD 能起能停），但它有两种「插着却用不了」的状态，
// 而用户在界面上完全使不上劲：授权弹窗错过了（unauthorized），或线松了/adbd 卡了（offline）。
// 这两种都能靠 adb reconnect 从这头救，不必让人回命令行。
package phone

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// reconnectDevice 让一台真机重新握手。
//   - unauthorized / offline：走 `adb reconnect offline`，手机上会重新弹授权框；
//   - 其余：让这台自己重连一次（线松、adbd 卡死之后最常用）。
//
// 回一行给 UI 显示的日志。
func reconnectDevice(serial, state string) (string, error) {
	if serial == "" {
		return "", errors.New("缺少设备 serial")
	}
	var out []byte
	var err error
	switch strings.ToLower(strings.TrimSpace(state)) {
	case "unauthorized", "offline":
		out, err = runCmd(15*time.Second, "adb", "reconnect", "offline")
	default:
		out, err = runCmd(15*time.Second, "adb", "-s", serial, "reconnect")
	}
	if err != nil {
		return string(out), err
	}
	return strings.TrimSpace(string(out)), nil
}

// ipAddrRe 匹配 `ip -o -4 addr show` 的一行：`2: wlan0    inet 192.168.1.23/24 brd …`
var ipAddrRe = regexp.MustCompile(`^\d+:\s*(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)`)

// parseDeviceIP 从 `ip -o -4 addr show` 的输出里挑一个能连的地址：优先 wlan*，
// 其次任意非回环网卡（有些设备走 eth0/usb 网卡也能连）。
func parseDeviceIP(out string) string {
	fallback := ""
	for _, ln := range strings.Split(out, "\n") {
		m := ipAddrRe.FindStringSubmatch(strings.TrimSpace(ln))
		if m == nil {
			continue
		}
		iface, ip := m[1], m[2]
		if strings.HasPrefix(iface, "lo") {
			continue
		}
		if strings.HasPrefix(iface, "wlan") {
			return ip
		}
		if fallback == "" {
			fallback = ip
		}
	}
	return fallback
}

// switchToWireless 把 USB 连着的真机切到无线调试，返回新的 adb 地址（host:port）。
// 切完这台机器在 adb 眼里是一台网络设备，线可以拔了。
//
// 顺序不能反：先读 IP 再 tcpip。`adb tcpip` 会重启设备上的 adbd，重启期间这台
// 从 adb 里短暂消失，那时候再去 shell 读 IP 就扑空。
func switchToWireless(serial string) (string, error) {
	if serial == "" {
		return "", errors.New("缺少设备 serial")
	}
	if strings.Contains(serial, ":") {
		return "", errors.New("这台已经是网络设备了")
	}
	out, err := runCmd(8*time.Second, "adb", "-s", serial, "shell", "ip", "-o", "-4", "addr", "show")
	if err != nil {
		return "", fmt.Errorf("读设备 IP 失败: %w", err)
	}
	ip := parseDeviceIP(string(out))
	if ip == "" {
		return "", errors.New("这台设备没有可用的局域网地址（先把它连上 Wi-Fi）")
	}
	if _, err := runCmd(15*time.Second, "adb", "-s", serial, "tcpip", "5555"); err != nil {
		return "", fmt.Errorf("切无线调试失败: %w", err)
	}
	addr := ip + ":5555"
	// adbd 重启要一会儿，连不上就再试几次——这里失败得给准话，否则用户以为线拔早了。
	var last error
	for i := 0; i < 6; i++ {
		time.Sleep(700 * time.Millisecond)
		o, err := runCmd(8*time.Second, "adb", "connect", addr)
		if err == nil && strings.Contains(string(o), "connected") {
			return addr, nil
		}
		if err != nil {
			last = err
		} else {
			last = fmt.Errorf("%s", strings.TrimSpace(string(o)))
		}
	}
	return "", fmt.Errorf("已切到无线但连不上 %s: %v", addr, last)
}
