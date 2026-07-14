//go:build !linux

// 非 Linux 平台的降级实现:只报主机名/架构,其余留空(面板显示为不可用)。
package hostmonitor

import (
	"os"
	"runtime"
	"time"
)

func collect(prev *counters, now time.Time) (Snapshot, *counters) {
	var s Snapshot
	s.Host.Hostname, _ = os.Hostname()
	s.Host.Arch = runtime.GOARCH
	s.CPU.Cores = runtime.NumCPU()
	return s, &counters{Time: now.UnixMilli()}
}
