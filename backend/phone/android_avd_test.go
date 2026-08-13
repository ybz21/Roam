package phone

// AVD 那套的纯函数：配置迁移（redroid 下线后老配置怎么落地）、新建校验、目录解析。
// 都不碰真 SDK，喂原样输出即可。

import "testing"

func TestSanitizeAndroidMigratesRedroid(t *testing.T) {
	cases := []struct {
		name string
		in   AndroidCfg
		want AndroidCfg
	}{
		{"本地 redroid → 模拟器档且丢掉 loopback 地址",
			AndroidCfg{Mode: "local", Address: "localhost:5555"},
			AndroidCfg{Mode: "avd"}},
		{"远程 redroid → 远程设备，地址原样留着（传输方式没变，不该因改名而断）",
			AndroidCfg{Mode: "remote", Address: "192.168.1.9:5555"},
			AndroidCfg{Mode: "network", Address: "192.168.1.9:5555"}},
		{"真机档里的模拟器 → 归位到模拟器档",
			AndroidCfg{Mode: "device", Address: "emulator-5554"},
			AndroidCfg{Mode: "avd", Address: "emulator-5554"}},
		{"USB 真机不动，且恒原生",
			AndroidCfg{Mode: "device", Address: "216d6a43", Resolution: "tablet"},
			AndroidCfg{Mode: "device", Address: "216d6a43"}},
		{"模拟器档里的 host:port 是 redroid 残留 → 丢弃",
			AndroidCfg{Mode: "avd", Address: "localhost:5555", Resolution: "tv"},
			AndroidCfg{Mode: "avd", Resolution: "tv"}},
		{"远程档里的裸 serial 不是网络目标 → 丢弃",
			AndroidCfg{Mode: "network", Address: "216d6a43", Avd: "x"},
			AndroidCfg{Mode: "network"}},
		{"去空白：尾随空格会让 adb -s 找不到设备",
			AndroidCfg{Mode: " avd ", Address: " emulator-5554 ", Avd: " tv1080p "},
			AndroidCfg{Mode: "avd", Address: "emulator-5554", Avd: "tv1080p"}},
		{"空模式回落模拟器档", AndroidCfg{}, AndroidCfg{Mode: "avd"}},
	}
	for _, c := range cases {
		got := sanitizeAndroid(c.in)
		if got != c.want {
			t.Errorf("%s: sanitizeAndroid(%+v)=%+v，要 %+v", c.name, c.in, got, c.want)
		}
		// 幂等：加载与保存都会调，第二遍不能再变
		if again := sanitizeAndroid(got); again != got {
			t.Errorf("%s: 不幂等，第二遍变成 %+v", c.name, again)
		}
	}
}

func TestValidateCreate(t *testing.T) {
	const pkg = "system-images;android-36;android-tv;x86_64"
	ok := avdCreateReq{Name: "tv_1080p_api36", Pkg: pkg}
	if err := validateCreate(ok, []string{"other"}, true); err != nil {
		t.Errorf("正常输入不该报错: %v", err)
	}
	// avdmanager 只收 [A-Za-z0-9._-]，空格/中文会失败——就地拦，不要留给后端报天书
	for _, bad := range []string{"", "my avd", "电视", "a/b"} {
		if err := validateCreate(avdCreateReq{Name: bad, Pkg: pkg}, nil, true); err == nil {
			t.Errorf("名称 %q 应被拒", bad)
		}
	}
	// 重名必须拒：avdmanager --force 会连同已有 AVD 的数据一起覆盖
	if err := validateCreate(ok, []string{"tv_1080p_api36"}, true); err == nil {
		t.Error("重名应被拒，绝不覆盖")
	}
	if err := validateCreate(avdCreateReq{Name: "x", Pkg: "platforms;android-36"}, nil, true); err == nil {
		t.Error("非 system-images 包名应被拒")
	}
	// 没装镜像 = 要下载 = 必须用户先点过「接受许可」
	if err := validateCreate(ok, nil, false); err == nil {
		t.Error("镜像未安装且未接受许可时应被拒")
	}
	yes := ok
	yes.AcceptLicense = true
	if err := validateCreate(yes, nil, false); err != nil {
		t.Errorf("接受许可后应放行: %v", err)
	}
}

func TestParseImagePkg(t *testing.T) {
	got, ok := parseImagePkg("system-images;android-36;android-tv;x86_64")
	if !ok || got.API != "36" || got.Variant != "android-tv" || got.ABI != "x86_64" {
		t.Fatalf("拆包名错: %+v ok=%v", got, ok)
	}
	// 扩展 API（android-35-ext14）原样留着，别自作聪明截断
	if got, _ := parseImagePkg("system-images;android-35-ext14;google_apis_playstore;arm64-v8a"); got.API != "35-ext14" {
		t.Errorf("扩展 API 要原样保留，得到 %q", got.API)
	}
	for _, bad := range []string{"", "platforms;android-36", "system-images;android-36;android-tv"} {
		if _, ok := parseImagePkg(bad); ok {
			t.Errorf("%q 不该被当成镜像包", bad)
		}
	}
}

func TestParseDeviceProfiles(t *testing.T) {
	const out = `Available devices definitions:
id: 4 or "medium_phone"
    Name: Medium Phone
    OEM : Generic
---------
id: 39 or "tv_1080p"
    Name: Television (1080p)
    OEM : Google
    Tag : android-tv
---------
`
	got := parseDeviceProfiles(out)
	if len(got) != 2 {
		t.Fatalf("要 2 个机型档，得到 %d: %+v", len(got), got)
	}
	if got[0].ID != "medium_phone" || got[0].Name != "Medium Phone" || got[0].Tag != "" {
		t.Errorf("手机档解析错: %+v", got[0])
	}
	// Tag 决定用途过滤：TV 只该列 android-tv 的档
	if got[1].ID != "tv_1080p" || got[1].Tag != "android-tv" || got[1].Name != "Television (1080p)" {
		t.Errorf("电视档解析错: %+v", got[1])
	}
}
