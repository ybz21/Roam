package phone

import (
	"errors"
	"reflect"
	"testing"
)

func TestGroupPending(t *testing.T) {
	const gid, gidStr = 993, "993"
	cases := []struct {
		name     string
		procGIDs []int
		userGIDs []string
		want     bool
	}{
		{"组数据库里有、本进程没带上 —— 就是加完组没重新登录那一格", nil, []string{"1000", "993"}, true},
		{"本进程已经带着 kvm 组：开不了就不是组的事，别乱指路", []int{1000, 993}, []string{"1000", "993"}, false},
		{"压根没加过组：该让用户去跑那条 sudo", []int{1000}, []string{"1000"}, false},
	}
	for _, c := range cases {
		if got := groupPending(gid, gidStr, c.procGIDs, c.userGIDs); got != c.want {
			t.Errorf("%s: 得到 %v，想要 %v", c.name, got, c.want)
		}
	}
}

func TestShJoinQuotes(t *testing.T) {
	// sg -c 收的是一行字符串不是 argv：路径里一个空格就能把命令拦腰截断。
	got := shJoin([]string{"/opt/Android Sdk/emulator/emulator", "-avd", "xh_tv4k"})
	want := `'/opt/Android Sdk/emulator/emulator' '-avd' 'xh_tv4k'`
	if got != want {
		t.Errorf("得到 %s，想要 %s", got, want)
	}
	if got := shJoin([]string{"a'b"}); got != `'a'\''b'` {
		t.Errorf("单引号没转义: %s", got)
	}
}

func TestKvmSpawnOnlyWrapsPendingGroup(t *testing.T) {
	args := []string{"-avd", "xh_tv4k", "-no-window"}

	// 能直接开就别套 sg：多一层 shell 就多一处能出错的地方，也让日志里的进程树变形。
	bin, got := kvmSpawn(kvmOK, "/sdk/emulator", args)
	if bin != "/sdk/emulator" || !reflect.DeepEqual(got, args) {
		t.Errorf("kvmOK 不该改命令，得到 %s %v", bin, got)
	}

	bin, got = kvmSpawn(kvmViaGroup, "/sdk/emulator", args)
	if bin == "/sdk/emulator" {
		t.Fatalf("kvmViaGroup 应该套 sg（本机若没装 sg 则跳过）")
	}
	want := []string{"kvm", "-c", `'/sdk/emulator' '-avd' 'xh_tv4k' '-no-window'`}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("得到 %v，想要 %v", got, want)
	}
}

func TestSgCommandFallsBackWhenSgMissing(t *testing.T) {
	// shadow-utils 没装的机器上不能因此起不来：原样返回，让 emulator 自己去报权限错。
	missing := func(string) (string, error) { return "", errors.New("not found") }
	bin, args := sgCommand(missing, "kvm", "/sdk/emulator", []string{"-avd", "x"})
	if bin != "/sdk/emulator" || len(args) != 2 {
		t.Errorf("没有 sg 时应原样返回，得到 %s %v", bin, args)
	}
}

func TestLinuxGPUModeHeadless(t *testing.T) {
	intel := []string{"0x8086"}
	nvidia := []string{"0x10de"}

	// 无头是判据的第一位：显卡在，能画的那块屏不在。
	// roam 后端常年是 systemd 用户服务（DISPLAY 空），从前这里回 host，
	// emulator 拿不到 EGL display 直接死，UI 上只剩一句「启动超时」。
	if got := linuxGPUMode("", "", intel); got != "swiftshader_indirect" {
		t.Errorf("无头 + 核显应软件渲染，得到 %s", got)
	}
	if got := linuxGPUMode("", "", nvidia); got != "swiftshader_indirect" {
		t.Errorf("无头 + 独显也一样，得到 %s", got)
	}

	// 有显示才谈硬件加速
	if got := linuxGPUMode(":0", "", intel); got != "host" {
		t.Errorf("有 X 显示 + 核显应走 host，得到 %s", got)
	}
	if got := linuxGPUMode("", "wayland-0", []string{"0x1002"}); got != "host" {
		t.Errorf("Wayland + AMD 应走 host，得到 %s", got)
	}
	// NVIDIA 专有驱动下 SurfaceFlinger 常起不来，有显示也躲开
	if got := linuxGPUMode(":0", "", nvidia); got != "swiftshader_indirect" {
		t.Errorf("NVIDIA 应躲开 host，得到 %s", got)
	}
}
