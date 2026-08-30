package hostmonitor

import "testing"

func TestParseProcStatAndUsage(t *testing.T) {
	before := "cpu  100 0 100 700 100 0 0 0 0 0\n" +
		"cpu0 50 0 50 350 50 0 0 0 0 0\n" +
		"cpu1 50 0 50 350 50 0 0 0 0 0\n"
	after := "cpu  200 0 200 750 150 0 0 0 0 0\n" +
		"cpu0 100 0 100 375 75 0 0 0 0 0\n" +
		"cpu1 100 0 100 375 75 0 0 0 0 0\n"
	prevAll, prevCores := parseProcStat(before)
	curAll, curCores := parseProcStat(after)
	if len(prevCores) != 2 || len(curCores) != 2 {
		t.Fatalf("expected 2 cores, got %d/%d", len(prevCores), len(curCores))
	}
	// Δtotal=300 Δidle=100 → 66.7%
	if got := usagePercent(prevAll, curAll); got != 66.7 {
		t.Errorf("usagePercent = %v, want 66.7", got)
	}
	if got := usagePercent(curAll, prevAll); got != -1 {
		t.Errorf("backwards counters should be invalid, got %v", got)
	}
}

func TestParseMeminfo(t *testing.T) {
	m := parseMeminfo("MemTotal:       16384000 kB\nMemFree:         1000000 kB\n" +
		"MemAvailable:    8192000 kB\nSwapTotal:       4096000 kB\nSwapFree:        3096000 kB\n")
	if m.Total != 16384000*1024 || m.Available != 8192000*1024 {
		t.Fatalf("total/available wrong: %+v", m)
	}
	if m.Used != m.Total-m.Available || m.UsagePercent != 50.0 {
		t.Errorf("used/percent wrong: %+v", m)
	}
	if m.SwapUsed != 1000000*1024 {
		t.Errorf("swap used wrong: %+v", m)
	}
}

func TestParseNetDevSkipsVirtual(t *testing.T) {
	rx, tx := parseNetDev(`Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  999999    100    0    0    0     0          0         0   999999    100    0    0    0     0       0          0
  eth0:    1000     10    0    0    0     0          0         0     2000     20    0    0    0     0       0          0
vethabc:  555555     55    0    0    0     0          0         0   555555     55    0    0    0     0       0          0
 wlan0:     500      5    0    0    0     0          0         0      700      7    0    0    0     0       0          0
`)
	if rx != 1500 || tx != 2700 {
		t.Errorf("rx/tx = %d/%d, want 1500/2700 (lo/veth excluded)", rx, tx)
	}
}

func TestParseCPUInfo(t *testing.T) {
	model, cores := parseCPUInfo("processor\t: 0\nmodel name\t: AMD Ryzen 9 5950X 16-Core Processor\n\nprocessor\t: 1\nmodel name\t: AMD Ryzen 9 5950X 16-Core Processor\n")
	if model != "AMD Ryzen 9 5950X 16-Core Processor" || cores != 2 {
		t.Errorf("got %q/%d", model, cores)
	}
}

func TestParseNvidiaSMI(t *testing.T) {
	gpus := parseNvidiaSMI("0, NVIDIA GeForce RTX 4090, 35, 8192, 24564, 61, 150.25, 450.00, 30\n" +
		"1, NVIDIA GeForce RTX 4090, 0, 2, 24564, 40, [N/A], 450.00, [N/A]\n")
	if len(gpus) != 2 {
		t.Fatalf("expected 2 gpus, got %d", len(gpus))
	}
	g := gpus[0]
	if g.Name != "NVIDIA GeForce RTX 4090" || g.UtilPercent != 35 || g.TempC != 61 {
		t.Errorf("gpu0 wrong: %+v", g)
	}
	if g.MemUsed != 8192<<20 || g.MemTotal != 24564<<20 {
		t.Errorf("gpu0 mem wrong: %+v", g)
	}
	if g.MemUsagePerc < 33 || g.MemUsagePerc > 34 {
		t.Errorf("gpu0 mem percent wrong: %v", g.MemUsagePerc)
	}
	if gpus[1].PowerW != 0 || gpus[1].FanPercent != 0 {
		t.Errorf("[N/A] fields should parse as 0: %+v", gpus[1])
	}
}

func TestParseLoadAvg(t *testing.T) {
	l1, l5, l15 := parseLoadAvg("0.52 1.10 2.30 2/1234 56789\n")
	if l1 != 0.52 || l5 != 1.10 || l15 != 2.30 {
		t.Errorf("got %v %v %v", l1, l5, l15)
	}
}

// 状态条那六格必须过 manifest 校验:builtin 上限正好是 6,再加一格就该报错。
// 校验发生在注册期,漏了的话是启动时才炸,不是这里。
func TestStatusItemsValid(t *testing.T) {
	m := Manifest()
	if err := m.Validate(); err != nil {
		t.Fatalf("host-monitor manifest invalid: %v", err)
	}
	if n := len(m.Contributes.StatusItems); n != 6 {
		t.Fatalf("want 6 status items, got %d", n)
	}
}

// ── 清 swap 的判定(swap.go)────────────────────────────────────────────────
//
// 这条命令自己就能把机器打死:swapoff 是同步的,要把已用的 swap 一次性读回内存,
// 装不下的时候 OOM killer 当场开枪,挑的多半是最大的那个进程——也就是正在跑的
// agent。所以判据必须在动手之前算清楚。

const gib = uint64(1) << 30

func TestSwapPlanRefusesWhenItWontFit(t *testing.T) {
	// 换出 7G,可用 5G —— 读回来直接爆
	p := planSwapClear(7*gib, 5*gib)
	if p.OK || p.Reason != "wont-fit" {
		t.Fatalf("装不下却放行了: %+v", p)
	}
}

func TestSwapPlanKeepsHeadroom(t *testing.T) {
	// 换出 7G,可用 7.5G:塞得下,但一点余量都不剩 —— 也不干
	if p := planSwapClear(7*gib, 7*gib+gib/2); p.OK {
		t.Fatalf("余量不足却放行了: %+v", p)
	}
	// 换出 7G,可用 11G:留得下 1G 余量,放行
	p := planSwapClear(7*gib, 11*gib)
	if !p.OK {
		t.Fatalf("装得下却拒绝了: %+v", p)
	}
	if p.Headroom != 4*gib {
		t.Fatalf("余量算错: %d", p.Headroom)
	}
}

func TestSwapPlanEmptyIsNotAnError(t *testing.T) {
	p := planSwapClear(0, 11*gib)
	if p.OK || p.Reason != "empty" {
		t.Fatalf("swap 本来就是空的,应当直说: %+v", p)
	}
}

func TestSwapPlanNoUnsignedWraparound(t *testing.T) {
	// 无符号数先减后比会绕回一个巨大的 Headroom,于是「装不下」被算成「余量充足」
	p := planSwapClear(8*gib, 1*gib)
	if p.OK || p.Headroom != 0 {
		t.Fatalf("无符号回绕: %+v", p)
	}
}
