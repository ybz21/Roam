//go:build linux

// Linux 采集器:/proc + statfs + hwmon。速率(CPU 利用率/网络吞吐)优先
// 用上次调用持久化的计数器差分;首次调用退化为进程内 250ms 双采样。
package hostmonitor

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// collect fills everything except GPUs/History and returns the counters to
// persist for the next call's rate window.
func collect(prev *counters, now time.Time) (Snapshot, *counters) {
	var s Snapshot

	all, perCore := readCPUTicks()
	rx, tx := readNetDev()
	cur := &counters{Time: now.UnixMilli(), CPU: all, PerCore: perCore, NetRx: rx, NetTx: tx}

	if prev == nil || usagePercent(prev.CPU, all) < 0 {
		// 无有效上次计数器:短窗双采样,本次窗口 250ms
		time.Sleep(250 * time.Millisecond)
		prev = cur
		all, perCore = readCPUTicks()
		rx, tx = readNetDev()
		cur = &counters{Time: time.Now().UnixMilli(), CPU: all, PerCore: perCore, NetRx: rx, NetTx: tx}
	}

	s.CPU.UsagePercent = maxf(usagePercent(prev.CPU, all), 0)
	if len(prev.PerCore) == len(perCore) {
		for i := range perCore {
			s.CPU.PerCore = append(s.CPU.PerCore, maxf(usagePercent(prev.PerCore[i], perCore[i]), 0))
		}
	}
	if b, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		s.CPU.Model, s.CPU.Cores = parseCPUInfo(string(b))
	}
	if s.CPU.Cores == 0 {
		s.CPU.Cores = runtime.NumCPU()
	}
	s.CPU.TempC = readCPUTemp()

	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		s.Memory = parseMeminfo(string(b))
	}
	s.Disks = readDisks()

	if dt := float64(cur.Time-prev.Time) / 1000; dt > 0 && cur.NetRx >= prev.NetRx && cur.NetTx >= prev.NetTx {
		s.Network.RxBytesPerSec = round1(float64(cur.NetRx-prev.NetRx) / dt)
		s.Network.TxBytesPerSec = round1(float64(cur.NetTx-prev.NetTx) / dt)
	}

	s.Host = readHostInfo()
	return s, cur
}

func maxf(v, floor float64) float64 {
	if v < floor {
		return floor
	}
	return v
}

func readCPUTicks() (cpuTicks, []cpuTicks) {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return cpuTicks{}, nil
	}
	return parseProcStat(string(b))
}

func readNetDev() (uint64, uint64) {
	b, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return 0, 0
	}
	return parseNetDev(string(b))
}

func readHostInfo() HostInfo {
	var h HostInfo
	h.Hostname, _ = os.Hostname()
	h.Arch = runtime.GOARCH
	if b, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		h.Kernel = strings.TrimSpace(string(b))
	}
	if b, err := os.ReadFile("/etc/os-release"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if v, ok := strings.CutPrefix(line, "PRETTY_NAME="); ok {
				h.OS = strings.Trim(v, `"`)
				break
			}
		}
	}
	if b, err := os.ReadFile("/proc/uptime"); err == nil {
		if fields := strings.Fields(string(b)); len(fields) > 0 {
			up, _ := strconv.ParseFloat(fields[0], 64)
			h.UptimeSec = int64(up)
		}
	}
	if b, err := os.ReadFile("/proc/loadavg"); err == nil {
		h.Load1, h.Load5, h.Load15 = parseLoadAvg(string(b))
	}
	return h
}

// readDisks lists real block-device mounts(/dev/* 且非 squashfs 快照盘),
// 同一设备多个挂载点(bind/子卷)只留挂载路径最短的一个。
func readDisks() []DiskStat {
	b, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return nil
	}
	byDev := map[string]DiskStat{}
	for _, line := range strings.Split(string(b), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		dev, mount, fstype := fields[0], fields[1], fields[2]
		mount = strings.ReplaceAll(mount, `\040`, " ") // /proc/mounts 空格转义
		if !strings.HasPrefix(dev, "/dev/") || strings.HasPrefix(dev, "/dev/loop") || fstype == "squashfs" {
			continue
		}
		if old, ok := byDev[dev]; ok && len(old.Mount) <= len(mount) {
			continue
		}
		var fs syscall.Statfs_t
		if syscall.Statfs(mount, &fs) != nil || fs.Blocks == 0 {
			continue
		}
		bsize := uint64(fs.Bsize)
		d := DiskStat{
			Device: dev,
			Mount:  mount,
			FSType: fstype,
			Total:  fs.Blocks * bsize,
			Free:   fs.Bavail * bsize,
		}
		d.Used = (fs.Blocks - fs.Bfree) * bsize
		if inUse := d.Used + fs.Bavail*bsize; inUse > 0 {
			// df 口径:百分比按 used/(used+avail),根分区含 root 预留块
			d.UsagePercent = round1(100 * float64(d.Used) / float64(inUse))
		}
		byDev[dev] = d
	}
	disks := make([]DiskStat, 0, len(byDev))
	for _, d := range byDev {
		disks = append(disks, d)
	}
	sort.Slice(disks, func(i, j int) bool { return disks[i].Mount < disks[j].Mount })
	return disks
}

// readCPUTemp best-effort 读 hwmon 里 CPU 温度(coretemp/k10temp 等);
// 找不到返回 0,前端按未知处理。
func readCPUTemp() float64 {
	hwmons, _ := filepath.Glob("/sys/class/hwmon/hwmon*")
	cpuNames := map[string]bool{"coretemp": true, "k10temp": true, "zenpower": true, "cpu_thermal": true, "cpu-thermal": true}
	for _, dir := range hwmons {
		name, err := os.ReadFile(filepath.Join(dir, "name"))
		if err != nil || !cpuNames[strings.TrimSpace(string(name))] {
			continue
		}
		inputs, _ := filepath.Glob(filepath.Join(dir, "temp*_input"))
		max := 0.0
		for _, in := range inputs {
			b, err := os.ReadFile(in)
			if err != nil {
				continue
			}
			if v, err := strconv.ParseFloat(strings.TrimSpace(string(b)), 64); err == nil && v/1000 > max {
				max = v / 1000
			}
		}
		if max > 0 {
			return round1(max)
		}
	}
	return 0
}
