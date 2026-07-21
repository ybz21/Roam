// 纯文本解析(/proc/* 与 nvidia-smi 输出),不碰真实系统,便于单测。
package hostmonitor

import (
	"strconv"
	"strings"
)

// cpuTicks is one cumulative /proc/stat cpu line (jiffies).
type cpuTicks struct {
	Total uint64 `json:"total"`
	Idle  uint64 `json:"idle"` // idle + iowait
}

// parseProcStat extracts the aggregate line and per-core lines of /proc/stat.
func parseProcStat(content string) (all cpuTicks, perCore []cpuTicks) {
	for _, line := range strings.Split(content, "\n") {
		if !strings.HasPrefix(line, "cpu") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		var t cpuTicks
		for i, f := range fields[1:] {
			v, err := strconv.ParseUint(f, 10, 64)
			if err != nil {
				continue
			}
			t.Total += v
			if i == 3 || i == 4 { // idle + iowait
				t.Idle += v
			}
		}
		if fields[0] == "cpu" {
			all = t
		} else {
			perCore = append(perCore, t)
		}
	}
	return all, perCore
}

// usagePercent 由两次累积计数差分得利用率;窗口无效(重启/回绕)返回 -1。
func usagePercent(prev, cur cpuTicks) float64 {
	if cur.Total <= prev.Total || cur.Idle < prev.Idle {
		return -1
	}
	dTotal := cur.Total - prev.Total
	dIdle := cur.Idle - prev.Idle
	if dIdle > dTotal {
		return -1
	}
	return round1(100 * float64(dTotal-dIdle) / float64(dTotal))
}

// parseMeminfo reads /proc/meminfo (kB values) into a MemStat (bytes).
func parseMeminfo(content string) MemStat {
	kb := map[string]uint64{}
	for _, line := range strings.Split(content, "\n") {
		key, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		if v, err := strconv.ParseUint(fields[0], 10, 64); err == nil {
			kb[key] = v * 1024
		}
	}
	m := MemStat{
		Total:     kb["MemTotal"],
		Available: kb["MemAvailable"],
		SwapTotal: kb["SwapTotal"],
	}
	if m.Available == 0 { // 老内核无 MemAvailable,退化 free+cached
		m.Available = kb["MemFree"] + kb["Cached"]
	}
	if m.Total >= m.Available {
		m.Used = m.Total - m.Available
	}
	if m.Total > 0 {
		m.UsagePercent = round1(100 * float64(m.Used) / float64(m.Total))
	}
	if m.SwapTotal >= kb["SwapFree"] {
		m.SwapUsed = m.SwapTotal - kb["SwapFree"]
	}
	return m
}

// parseNetDev sums rx/tx bytes of physical-ish interfaces in /proc/net/dev.
// lo 与常见虚拟网卡(veth/docker/网桥)不计,避免容器流量双份计入。
func parseNetDev(content string) (rx, tx uint64) {
	for _, line := range strings.Split(content, "\n") {
		name, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		if skipIface(name) {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) < 9 {
			continue
		}
		r, _ := strconv.ParseUint(fields[0], 10, 64)
		t, _ := strconv.ParseUint(fields[8], 10, 64)
		rx += r
		tx += t
	}
	return rx, tx
}

func skipIface(name string) bool {
	for _, p := range []string{"lo", "veth", "docker", "br-", "virbr", "vnet"} {
		if name == p || (len(p) > 2 && strings.HasPrefix(name, p)) {
			return true
		}
	}
	return false
}

// parseLoadAvg reads the first three fields of /proc/loadavg.
func parseLoadAvg(content string) (l1, l5, l15 float64) {
	fields := strings.Fields(content)
	if len(fields) >= 3 {
		l1, _ = strconv.ParseFloat(fields[0], 64)
		l5, _ = strconv.ParseFloat(fields[1], 64)
		l15, _ = strconv.ParseFloat(fields[2], 64)
	}
	return
}

// parseCPUInfo returns the model name and logical core count.
func parseCPUInfo(content string) (model string, cores int) {
	for _, line := range strings.Split(content, "\n") {
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		switch strings.TrimSpace(key) {
		case "processor":
			cores++
		case "model name", "Model", "Hardware":
			if model == "" {
				model = strings.TrimSpace(val)
			}
		}
	}
	return model, cores
}

// parseNvidiaSMI parses `nvidia-smi --query-gpu=... --format=csv,noheader,nounits`.
// 字段可能是 "[N/A]"(如无风扇的卡),按 0 处理。
func parseNvidiaSMI(output string) []GPUStat {
	var gpus []GPUStat
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		parts := strings.Split(line, ",")
		if len(parts) < 9 {
			continue
		}
		num := func(i int) float64 {
			v, err := strconv.ParseFloat(strings.TrimSpace(parts[i]), 64)
			if err != nil {
				return 0
			}
			return v
		}
		g := GPUStat{
			Index:       int(num(0)),
			Name:        strings.TrimSpace(parts[1]),
			UtilPercent: num(2),
			MemUsed:     uint64(num(3)) << 20, // MiB → bytes
			MemTotal:    uint64(num(4)) << 20,
			TempC:       num(5),
			PowerW:      round1(num(6)),
			PowerLimitW: round1(num(7)),
			FanPercent:  num(8),
		}
		if g.MemTotal > 0 {
			g.MemUsagePerc = round1(100 * float64(g.MemUsed) / float64(g.MemTotal))
		}
		gpus = append(gpus, g)
	}
	return gpus
}

func round1(f float64) float64 {
	return float64(int(f*10+0.5)) / 10
}
