package memguard

import (
	"os"
	"strings"
	"testing"
)

func TestFromEnvDefaults(t *testing.T) {
	t.Setenv("ROAM_SESSION_MEM_MAX", "")
	t.Setenv("ROAM_SESSION_MEM_HIGH", "")
	t.Setenv("ROAM_SESSION_MEM_SWAP", "")
	l := FromEnv()
	if l.Off() {
		t.Fatal("默认额度不该是 Off")
	}
	max, ok := parseBytes(l.Max)
	if !ok {
		t.Fatalf("默认 Max 解析不出: %q", l.Max)
	}
	// 下限保证小内存机器也有个说得过去的额度；上限避免大内存机器给到几十 G 等于没设。
	if max < defaultFloor || max > defaultCeil {
		t.Fatalf("默认 Max = %d，超出 [%d,%d]", max, defaultFloor, defaultCeil)
	}
	// 本仓库 npm run build 实测峰值 7.4G。默认额度低于它就会误伤正常构建，
	// 而那种死法很隐蔽（V8 自己 abort，cgroup 的 oom_kill 计数是 0）。
	if total := totalMemory(); total >= 20<<30 && max < 8<<30 {
		t.Fatalf("20G+ 的机器默认只给 %d 字节，连一次前端构建都跑不完", max)
	}
	high, ok := parseBytes(l.High)
	if !ok || high >= max {
		t.Fatalf("软限 %q 必须严格低于硬顶 %q，否则没有 throttle 的窗口", l.High, l.Max)
	}
	if swap, ok := parseBytes(l.Swap); !ok || swap > max {
		t.Fatalf("swap 额度 %q 不该超过内存额度 %q", l.Swap, l.Max)
	}
}

func TestDefaultMaxScalesWithRAM(t *testing.T) {
	// 读不到 /proc/meminfo 的环境（非 Linux、受限容器）也必须给出一个能用的值。
	if _, ok := parseBytes(DefaultMax()); !ok {
		t.Fatalf("DefaultMax() 返回了解析不出的值: %q", DefaultMax())
	}
}

// 「显式不限」是给「我就是要跑个吃 20G 的东西」留的门，几种写法都得认。
func TestFromEnvOff(t *testing.T) {
	for _, v := range []string{"0", "off", "OFF", "none", "unlimited"} {
		t.Setenv("ROAM_SESSION_MEM_MAX", v)
		if l := FromEnv(); !l.Off() {
			t.Fatalf("ROAM_SESSION_MEM_MAX=%q 应当关闭护栏，得到 %+v", v, l)
		}
	}
}

func TestFromEnvOverride(t *testing.T) {
	t.Setenv("ROAM_SESSION_MEM_MAX", "4G")
	t.Setenv("ROAM_SESSION_MEM_HIGH", "3500M")
	t.Setenv("ROAM_SESSION_MEM_SWAP", "1G")
	l := FromEnv()
	if l.Max != "4G" || l.High != "3500M" || l.Swap != "1G" {
		t.Fatalf("显式设的值被改写了: %+v", l)
	}
}

func TestScaleBytes(t *testing.T) {
	cases := []struct{ in, want string }{
		{"8G", "6G"},
		{"4G", "3G"},
		{"2000M", "1500M"},
		{"1G", "0G"}, // 太小的额度缩完是 0——调用方给的值本身就不合理，不在这里替他兜
		{"", ""},
		{"G", ""},   // 认不出就返回空，宁可不设软限也别设错
		{"abc", ""}, //
		{"8GiB", "6GiB"},
	}
	for _, c := range cases {
		if got := scaleBytes(c.in, highRatio); got != c.want {
			t.Errorf("scaleBytes(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// ScopeOf 读的是真 /proc。跑在 systemd 用户会话里就该拿到 .scope，
// 其他环境（容器、CI）拿到空串——两种都是正确行为，不该 panic 或返回垃圾。
func TestScopeOfSelf(t *testing.T) {
	unit := ScopeOf(os.Getpid())
	if unit != "" && !strings.HasSuffix(unit, ".scope") {
		t.Fatalf("ScopeOf 返回了不像 scope 的东西: %q", unit)
	}
	if unit != "" && strings.ContainsAny(unit, "/ \t\n") {
		t.Fatalf("scope 单元名不该含路径或空白: %q", unit)
	}
}

func TestScopeOfMissingPID(t *testing.T) {
	if got := ScopeOf(-1); got != "" {
		t.Fatalf("不存在的 pid 应当返回空串，得到 %q", got)
	}
}

// 护栏装不上时必须静默降级——绝不能因此中断建会话。
func TestApplyOffIsNoop(t *testing.T) {
	if err := Apply(os.Getpid(), Limits{}); err != nil {
		t.Fatalf("Off 额度应当直接返回 nil，得到 %v", err)
	}
	if err := Apply(-1, Limits{Max: "1G"}); err != nil {
		t.Fatalf("拿不到 scope 应当静默跳过，得到 %v", err)
	}
}

func TestCurrentMissingPID(t *testing.T) {
	if _, _, ok := Current(-1); ok {
		t.Fatal("不存在的 pid 不该报告成功")
	}
	if n := OOMKilled(-1); n != 0 {
		t.Fatalf("不存在的 pid 的 oom_kill 应当是 0，得到 %d", n)
	}
}
