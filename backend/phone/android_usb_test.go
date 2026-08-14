package phone

import "testing"

// 挑地址：优先 wlan，其次任意非回环；一个都没有就是「没连 Wi-Fi」，得让用户知道。
func TestParseDeviceIP(t *testing.T) {
	const out = `1: lo    inet 127.0.0.1/8 scope host lo\       valid_lft forever
3: rmnet0    inet 10.12.34.56/30 scope global rmnet0\       valid_lft forever
4: wlan0    inet 192.168.1.23/24 brd 192.168.1.255 scope global wlan0\       valid_lft forever`
	if got := parseDeviceIP(out); got != "192.168.1.23" {
		t.Errorf("要挑 wlan0 的地址，得到 %q", got)
	}
	// 没有 wlan 就退而求其次（有些设备走 eth0/usb 网卡也连得上）
	if got := parseDeviceIP("1: lo    inet 127.0.0.1/8 scope host lo\n2: eth0    inet 10.0.0.5/24 scope global eth0"); got != "10.0.0.5" {
		t.Errorf("无 wlan 时该回退到非回环网卡，得到 %q", got)
	}
	// 只有回环 = 没有可用地址
	if got := parseDeviceIP("1: lo    inet 127.0.0.1/8 scope host lo"); got != "" {
		t.Errorf("只有回环时应回空，得到 %q", got)
	}
	if got := parseDeviceIP(""); got != "" {
		t.Errorf("空输出应回空，得到 %q", got)
	}
}

func TestSwitchToWirelessRejectsNetworkTarget(t *testing.T) {
	// 已经是 host:port 的目标再「转无线」没有意义，别去重启人家的 adbd
	if _, err := switchToWireless("192.168.1.23:5555"); err == nil {
		t.Error("对网络设备应直接拒绝")
	}
	if _, err := switchToWireless(""); err == nil {
		t.Error("空 serial 应报错")
	}
}
