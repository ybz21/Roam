package hostmonitor

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"ttmux-cli-go/pkg/plugin/sdk"
)

// 清空交换空间：`swapoff -a` 把换出去的页全部读回内存,`swapon -a` 再挂回来。
//
// 为什么值得做一个按钮:swap 用满是**整机卡死的前兆**——换页无处可去,内核就在直接
// 回收里空转,ping 还通(内核收发 ICMP 不换页)但 ssh 再也进不来,只能按电源键。
// 本机 2026-08-12 那次就是这么冻的。而在冻住之前,把换出去的页拉回内存能立刻缓解。
//
// 但这条命令自己就能把机器打死:swapoff 是**同步**的,它要把已用的 swap 一次性读回
// 内存;装不下的时候 OOM killer 当场开枪,而它挑的多半是最大的那个进程——也就是你正
// 在跑的 agent。所以判据必须在动手之前算清楚,而不是「试试看」。

// 读回来之后至少要给系统留这么多余量。1 GiB 是拍的,但拍在保守那一边:
// 判定和执行之间隔着几秒,这几秒里内存还在动。
const swapHeadroomBytes = uint64(1) << 30

// SwapPlan 是「能不能清」的判定结果,也是确认框上要给人看的三个数。
type SwapPlan struct {
	SwapUsed  uint64 `json:"swapUsed"`
	Available uint64 `json:"available"` // MemAvailable
	Headroom  uint64 `json:"headroom"`  // 读回来之后还剩多少
	OK        bool   `json:"ok"`
	Reason    string `json:"reason,omitempty"` // ok=false 时的机器可读原因
}

// planSwapClear 是纯函数:喂两个数就能断言,不必真去动 swap。
func planSwapClear(swapUsed, memAvailable uint64) SwapPlan {
	p := SwapPlan{SwapUsed: swapUsed, Available: memAvailable}
	if swapUsed == 0 {
		p.Reason = "empty"
		return p
	}
	// 无符号数:先比较再相减,否则装不下的时候会绕回一个巨大的 Headroom
	if memAvailable < swapUsed+swapHeadroomBytes {
		p.Reason = "wont-fit"
		return p
	}
	p.Headroom = memAvailable - swapUsed
	p.OK = true
	return p
}

// swapClear 是 host-monitor.swap-clear 命令。
//
// dryRun(默认)只回判定,给确认框用;真干要显式 apply=1——**默认不动手**,因为这条
// 命令的代价是不可撤销的(被 OOM 杀掉的进程回不来)。
func swapClear(ctx *sdk.Ctx, args map[string]string) (any, error) {
	mem, err := currentMem()
	if err != nil {
		return nil, err
	}
	plan := planSwapClear(mem.SwapUsed, mem.Available)
	if args["apply"] != "1" {
		return plan, nil
	}
	if !plan.OK {
		return plan, fmt.Errorf("swap-clear refused: %s", plan.Reason)
	}
	if err := runSwapCycle(); err != nil {
		return plan, err
	}
	// 回读:不信退出码,看 /proc/meminfo 里 swap 是不是真的空了
	after, err := currentMem()
	if err != nil {
		return plan, nil
	}
	plan.SwapUsed = after.SwapUsed
	plan.Available = after.Available
	return plan, nil
}

// runSwapCycle 走 sudo -n。**不接口令**:插件进程没有终端,交互式 sudo 只会挂死;
// 而把口令放进配置项是另一个更糟的主意。没开免密时给出那一行 sudoers,让人自己开。
func runSwapCycle() error {
	for _, argv := range [][]string{{"swapoff", "-a"}, {"swapon", "-a"}} {
		cmd := exec.Command("sudo", append([]string{"-n"}, argv...)...)
		out, err := cmd.CombinedOutput()
		if err == nil {
			continue
		}
		msg := strings.TrimSpace(string(out))
		if strings.Contains(msg, "password") || strings.Contains(msg, "口令") || msg == "" {
			return fmt.Errorf("need-sudo")
		}
		return fmt.Errorf("%s failed: %s", strings.Join(argv, " "), msg)
	}
	return nil
}

// currentMem 读一次 /proc/meminfo。判定用的是**此刻**的数,不用采样缓存里那份——
// 缓存最久可能是 3 秒前的,而这三秒里 swap 可能又涨了几百兆。
func currentMem() (MemStat, error) {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return MemStat{}, err
	}
	return parseMeminfo(string(b)), nil
}
