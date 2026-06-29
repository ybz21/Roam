package phone

// 联机测试：需有一台真 Android 设备/redroid（adb 可见）。无设备时自动跳过。
// 跑：cd backend && go test ./phone/ -run TestLive -v

import (
	"os"
	"testing"
)

func liveDev(t *testing.T) *androidDevice {
	d := newAndroidDevice()
	if d.state() != "device" {
		t.Skip("无已连接 Android 设备，跳过联机测试")
	}
	return d
}

func TestLiveHealth(t *testing.T) {
	d := liveDev(t)
	s := d.Health()
	if !s.OK {
		t.Fatalf("Health 不 OK: %+v", s)
	}
	t.Logf("Health: platform=%s device=%q", s.Platform, s.Device)
}

func TestLiveCapture(t *testing.T) {
	d := liveDev(t)
	jpg, w, h, err := d.CaptureJPEG(50)
	if err != nil {
		t.Fatalf("CaptureJPEG: %v", err)
	}
	if w == 0 || h == 0 || len(jpg) == 0 {
		t.Fatalf("空帧: w=%d h=%d bytes=%d", w, h, len(jpg))
	}
	t.Logf("截图 OK: %dx%d, JPEG %d 字节", w, h, len(jpg))
	if out := os.Getenv("PHONE_SHOT"); out != "" {
		_ = os.WriteFile(out, jpg, 0o644)
		t.Logf("已写出 %s", out)
	}
}

func TestLiveApps(t *testing.T) {
	d := liveDev(t)
	apps, err := d.Apps()
	if err != nil {
		t.Fatalf("Apps: %v", err)
	}
	t.Logf("第三方 App 数: %d", len(apps))
	for i, a := range apps {
		if i >= 5 {
			break
		}
		t.Logf("  - %s", a.ID)
	}
}

func TestLiveTapAndKey(t *testing.T) {
	d := liveDev(t)
	if err := d.Tap(360, 640); err != nil {
		t.Fatalf("Tap: %v", err)
	}
	if err := d.Key("home"); err != nil {
		t.Fatalf("Key home: %v", err)
	}
	t.Log("Tap + Key(home) OK")
}

func TestLiveUIDump(t *testing.T) {
	d := liveDev(t)
	els, err := d.UIDump()
	if err != nil {
		t.Fatalf("UIDump: %v", err)
	}
	t.Logf("UI 元素数: %d", len(els))
	for i, e := range els {
		if i >= 8 {
			break
		}
		t.Logf("  [%d,%d] clickable=%v text=%q desc=%q", e.X, e.Y, e.Clickable, e.Text, e.Desc)
	}
}
