// GPU 采集:nvidia-smi 一次查询(无卡/无驱动返回空,面板显示未检测到)。
// AMD/集显暂不支持,留作后续增量。
package hostmonitor

import (
	"context"
	"os/exec"
	"time"
)

const smiQuery = "index,name,utilization.gpu,memory.used,memory.total," +
	"temperature.gpu,power.draw,power.limit,fan.speed"

func readGPUs() []GPUStat {
	path, err := exec.LookPath("nvidia-smi")
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path,
		"--query-gpu="+smiQuery, "--format=csv,noheader,nounits").Output()
	if err != nil {
		return nil
	}
	return parseNvidiaSMI(string(out))
}
