// Package memthrottle 是总量闸：每个会话都守着自己的上限、加起来仍然把机器压垮的那一档。
//
// # 为什么不是原设计的那两行
//
// 图纸上的 L2 是给 user@<uid>.service 设 MemoryHigh/MemoryMax（见
// scripts/dev/install-memory-guard.sh）。那条路需要 root，而且**没有 root 时会
// 骗人**：用户实例照样能写下 drop-in、systemctl show 也报得出值，只有去看
// /sys/fs/cgroup/.../user@1000.service/memory.high 才发现还是 "max" ——
// 用户切片根节点的限额文件属主是 root，那正是 cgroup 委派的安全边界
// （否则用户能自己解开父级给的限制）。装上一个不生效的护栏比没有更糟。
//
// 这里做同一件事的用户权限版。会话自己的 scope 在委派子树里，我们改得动：
// 机器快没内存时，给**当时最大的那个会话**单独踩一脚软刹车（memory.high），
// 把总量压回线下。软限只让内核激进回收 + throttle 住分配，不触发 OOM kill ——
// 「先减速，留出反应时间」的那一步就是这一下。
//
// # 与 L1 的分工
//
//	memguard（L1）  单个会话失控        → 硬顶 memory.max，只杀它自己
//	本包（L2）      每个都合规、加起来超 → 软限 memory.high，踩最大的那个
//
// L1 的硬顶一动不动：踩刹车不该改变「撞顶时谁死」这件事。
package memthrottle

import (
	"os"
	"strconv"
	"strings"

	"ttmux-cli-go/internal/memguard"
)

// Host 这一轮看到的全机内存状况。
type Host struct {
	Total int64 // 物理内存
	Avail int64 // MemAvailable（内核估的可用余量，含可回收的 page cache）
}

// Sample 一个会话此刻的内存画像。PIDs 是它各个 pane 的进程号 —— 一个会话可能有
// 多个 pane，各在自己的 scope 里，踩刹车要挨个踩。
type Sample struct {
	Session string
	Label   string // 给人看的名字（通知里用）
	PIDs    []int
	Cur     int64 // anon（不含 page cache，page cache 是全局共享的，算进来会高估）
	High    int64 // 当前软限（0 = 未设限）
	Max     int64 // 硬顶（0 = 未设限）
}

// Decision 对一个会话的处置。松开时 High 是 **L1 的默认软限**，不是 0 ——
// 0 会被写成 infinity，把 L1 那道软限也一并撤掉，会话从此没有任何软限。
// 只有硬顶本来就没设的会话（老 scope、护栏装不上的机器）松开时才是 0。
type Decision struct {
	Session string
	Label   string
	PIDs    []int
	High    int64
	Brake   bool // true 踩下、false 松开
}

const (
	// availLow 可用内存低于全机这个比例，就认为机器已经在换页边缘。
	// 12% 是留给内核和系统服务的余量 —— 低于它，下一次分配就可能触发全局 OOM，
	// 而全局 OOM 会在**全机范围**选 victim，整个桌面跟着僵死。
	availLow = 0.12
	// availOK 回到这个比例以上才松刹车。和 availLow 之间那段是滞后区：
	// 两条线贴在一起的话，回收刚见效就松开、松开立刻又越线，
	// 会话在 throttle 和放开之间反复横跳，比一直踩着还慢。
	availOK = 0.20
	// minShare 这些会话至少得占到全机这个比例，才轮得到踩它们。
	// 内存是别人（浏览器、docker）吃掉的时候，踩我们自己既不解决问题，
	// 又白白让 agent 变慢 —— 那种情况该报给人，不该自己动手。
	minShare = 0.35
	// brakeKeep 踩下去之后保留当前用量的比例。留 15% 的回收空间：
	// 直接踩到当前用量会让内核在每一次分配上都做回收，进程近乎停死。
	brakeKeep = 0.85
	// brakeBelowDefault 踩下去至少要压到 L1 默认软限的这个比例以下，
	// 才算得上「踩过」—— 留出的余量要大于 Braked() 那 2% 的容差。
	brakeBelowDefault = 0.90
	// brakeFloor 再怎么踩也不低于 1 GiB，也不去踩比这更小的会话 ——
	// 小会话踩了腾不出多少，代价却是把它拖垮。
	brakeFloor = 1 << 30
)

// 三条线的环境变量覆盖。一台 128G 的机器上 12% 是 15G 余量，早得没必要；
// 一台 8G 的机器上 12% 只剩 1G，已经太晚。默认值按常见的 16–64G 台式机定，
// 偏离这个区间的机器该自己调。
const (
	EnvAvailLow = "ROAM_MEM_BRAKE_LOW"
	EnvAvailOK  = "ROAM_MEM_BRAKE_OK"
	EnvMinShare = "ROAM_MEM_BRAKE_SHARE"
)

// Thresholds 判据三条线。作为参数传进 Plan 而不是让 Plan 自己读环境变量：
// 阈值逻辑是这个包里最该单测的部分，而读环境变量的函数测不动。
type Thresholds struct {
	AvailLow float64 // 低于这个比例踩下
	AvailOK  float64 // 高于这个比例松开
	MinShare float64 // 这些会话至少占到这个比例才轮得到踩它们
}

// Defaults 默认三条线。
func Defaults() Thresholds {
	return Thresholds{AvailLow: availLow, AvailOK: availOK, MinShare: minShare}
}

// FromEnv 读环境变量覆盖；认不出、超出 (0,1) 的值一律退回默认 ——
// 把 AvailLow 写成 "80" 而不是 "0.8" 的话，机器会被永久踩着刹车。
func FromEnv() Thresholds {
	t := Defaults()
	t.AvailLow = ratio(EnvAvailLow, t.AvailLow)
	t.AvailOK = ratio(EnvAvailOK, t.AvailOK)
	t.MinShare = ratio(EnvMinShare, t.MinShare)
	// 松开线必须严格高于踩下线，否则没有滞后区，会话在两态之间反复横跳。
	if t.AvailOK <= t.AvailLow {
		t.AvailOK = t.AvailLow * 1.5
	}
	return t
}

func ratio(env string, def float64) float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(os.Getenv(env)), 64)
	if err != nil || v <= 0 || v >= 1 {
		return def
	}
	return v
}

// Braked 这个会话此刻是不是踩着刹车：软限被压到了 L1 默认（max×HighRatio）之下。
//
// 「当前是不是踩着」从内核读，不自己记 —— CLI 每次调用都是一个新进程，
// 记在内存里的状态活不过这一轮，落盘又要多一张表。内核里那个数就是唯一真相。
func (s Sample) Braked() bool {
	if s.High <= 0 || s.Max <= 0 {
		return false
	}
	// 留 2% 容差：L1 那个默认值是按比例算出来再取整的，精确相等靠不住。
	return float64(s.High) < float64(s.Max)*memguard.HighRatio*0.98
}

// DefaultHigh L1 给这个硬顶配的默认软限。松开刹车就是回到这里，
// 而不是回到「无软限」—— 那会把 L1 的护栏一起拆掉。
func DefaultHigh(max int64) int64 {
	if max <= 0 {
		return 0
	}
	return int64(float64(max) * memguard.HighRatio)
}

// Plan 算出这一轮该踩谁、该松谁。纯函数，所有判据都从参数来 —— 阈值逻辑值得单测，
// 而它最容易错的地方（滞后区、占比不够时不动手）恰恰是最难在真机上复现的：
// 要在真机上看见踩下，得先把机器压到快卡死，而那正是这段代码要避免的事。
func Plan(h Host, t Thresholds, samples []Sample) []Decision {
	if h.Total <= 0 || h.Avail <= 0 {
		return nil // 读不到就不下判断，别在盲态里踩刹车
	}
	avail := float64(h.Avail) / float64(h.Total)

	// 机器缓过来了：把踩着的全松开。这一步不看占比 —— 松刹车永远是安全的，
	// 卡在踩下状态的会话会一直慢下去，而没人会去手工松它。
	if avail >= t.AvailOK {
		var out []Decision
		for _, s := range samples {
			if s.Braked() {
				out = append(out, Decision{Session: s.Session, Label: s.Label, PIDs: s.PIDs, High: DefaultHigh(s.Max)})
			}
		}
		return out
	}
	if avail >= t.AvailLow {
		return nil // 滞后区：既不踩也不松
	}

	var total int64
	for _, s := range samples {
		total += s.Cur
	}
	if float64(total)/float64(h.Total) < t.MinShare {
		return nil // 内存不是我们吃的
	}

	// 每轮只踩一个：踩下去要等内核回收见效，一口气踩完所有会话等于把整台机器
	// 一起拖慢，而通常压垮机器的就是最大的那一个。下一轮如果还不够，再踩第二大的。
	var top *Sample
	for i := range samples {
		s := &samples[i]
		if s.Braked() || s.Cur < brakeFloor || len(s.PIDs) == 0 {
			continue
		}
		if top == nil || s.Cur > top.Cur {
			top = s
		}
	}
	if top == nil {
		return nil
	}
	high := int64(float64(top.Cur) * brakeKeep)
	// 还得**明显低于** L1 的默认软限。会话用量接近硬顶时（cur ≈ 0.88×max），
	// cur×0.85 和 max×0.75 只差几个页面 —— 那一脚等于没踩，更糟的是下一轮
	// Braked() 认不出它被踩过（判据就是「低于默认」），于是每一轮都重踩它一次。
	// 真机演练里踩出过 9978507264 对 9978511360，差 4096 字节。
	if d := DefaultHigh(top.Max); d > 0 && high > int64(float64(d)*brakeBelowDefault) {
		high = int64(float64(d) * brakeBelowDefault)
	}
	if high < brakeFloor {
		high = brakeFloor
	}
	return []Decision{{Session: top.Session, Label: top.Label, PIDs: top.PIDs, High: high, Brake: true}}
}

// Apply 执行处置。set 注入是为了能测「决策 → 调用」这一段而不真去动 cgroup。
// 返回真正落下去的那些（set 失败的不算）—— 调用方据此决定要不要告诉用户。
func Apply(ds []Decision, set func(pid int, high int64) error) []Decision {
	var done []Decision
	for _, d := range ds {
		ok := false
		for _, pid := range d.PIDs {
			if err := set(pid, d.High); err == nil {
				ok = true // 一个会话多个 pane，落下一个就算这个会话动了
			}
		}
		if ok {
			done = append(done, d)
		}
	}
	return done
}

// SetHigh 是 Apply 的默认执行器。
func SetHigh(pid int, high int64) error { return memguard.SetHigh(pid, high) }
