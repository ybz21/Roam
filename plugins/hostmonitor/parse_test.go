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
