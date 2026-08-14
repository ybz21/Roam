package phone

// 设备列表的解析与判据：不需要真 adb，喂 `adb devices -l` 的原样输出。

import "testing"

const adbOut = `* daemon not running; starting now at tcp:5037
* daemon started successfully
List of devices attached
216d6a43               device usb:1-10 product:ginkgo model:Redmi_Note_8 device:ginkgo transport_id:1
emulator-5554          device product:sdk_google_atv64_x86_64 model:sdk_google_atv64_x86_64 transport_id:2
192.168.120.241:5555   unauthorized transport_id:3
localhost:5555         offline
`

func TestParseAdbDevices(t *testing.T) {
	got := parseAdbDevices(adbOut)
	if len(got) != 4 {
		t.Fatalf("要 4 台（含未就绪的），得到 %d: %+v", len(got), got)
	}
	// adb 把 model 里的空格编码成下划线，展示前要还原
	if got[0].Serial != "216d6a43" || got[0].Model != "Redmi Note 8" || got[0].State != "device" {
		t.Errorf("USB 真机解析错: %+v", got[0])
	}
	// 没 model: 字段的行退回用 serial 当名字
	if got[3].Serial != "localhost:5555" || got[3].Model != "localhost:5555" || got[3].State != "offline" {
		t.Errorf("离线目标解析错: %+v", got[3])
	}
	if got[2].State != "unauthorized" {
		t.Errorf("未授权那台要保留状态: %+v", got[2])
	}
}

func TestAndroidKind(t *testing.T) {
	for serial, want := range map[string]string{
		"emulator-5554":        "avd", // 在跑的本机模拟器
		"avd:xh_tv1080p":       "avd", // 还没起的本机模拟器：带前缀，不能被当成 host:port
		"192.168.120.241:5555": "network",
		"localhost:5555":       "network",
		"216d6a43":             "usb",
	} {
		if got := androidKind(serial); got != want {
			t.Errorf("androidKind(%q)=%q，要 %q", serial, got, want)
		}
	}
}

func TestSoleReadyAndAmbiguousTarget(t *testing.T) {
	all := parseAdbDevices(adbOut)
	// 两台就绪(真机+模拟器)：没有「默认那台」，且必须给出选一台的准话
	if s := soleReady(all); s != "" {
		t.Errorf("两台就绪时不该有默认设备，得到 %q", s)
	}
	if e := ambiguousTarget("", all); e == "" {
		t.Error("没指定目标 + 多台就绪，要报「请先选一台」")
	}
	// 指定了目标就不含糊，哪怕挂着多台
	if e := ambiguousTarget("216d6a43", all); e != "" {
		t.Errorf("指定目标后不该报含糊: %q", e)
	}

	// 只有一台就绪：它就是 adb 默认设备（未就绪的不算）
	one := parseAdbDevices("List of devices attached\n216d6a43 device model:Redmi_Note_8\n192.168.1.9:5555 offline\n")
	if s := soleReady(one); s != "216d6a43" {
		t.Errorf("唯一就绪设备要被认成默认设备，得到 %q", s)
	}
	if e := ambiguousTarget("", one); e != "" {
		t.Errorf("只有一台就绪不该报含糊: %q", e)
	}

	// 一台都没有：也不含糊——那是「没设备」，另有其说法
	if e := ambiguousTarget("", nil); e != "" {
		t.Errorf("无设备不该报含糊: %q", e)
	}
}
