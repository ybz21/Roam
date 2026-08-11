package hub

import (
	"bufio"
	"context"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
)

// 中心自己的健康数据与事件流。
//
// 为什么要有：2026-08-11 中心因为一个 goroutine 泄漏卡死了十几个小时，是部署时碰巧撞见的——
// 界面上没有任何地方会说「中心不健康」。当时能查靠的是我临时在服务器上手写的 cron + curl，
// 换台机器就没有、重装一次就丢。所以采样放进程内：任何一台中心都自带这条曲线。
//
// 单点数字说明不了问题（20 个 goroutine 是「稳在 20」还是「正在爬」看不出来），所以留的是
// **序列**：5 分钟一采、留 24 小时。事故当天的曲线长这样——
//   09:50 goroutine 1518 → 09:55 2667 → 10:00 7126 → 10:20 18298
// 一眼就是泄漏，而任何单个时刻的数字都只是「有点多」。

const (
	sampleEvery = 5 * time.Minute
	sampleKeep  = 288 // 24 小时
	eventKeep   = 200
)

// Sample 是一次采样。累计量（requests）存原值不存速率：速率由前端按相邻两点差分算，
// 这样重启后曲线自然断开，而不是画出一段假的「零流量」。
type Sample struct {
	At         int64 `json:"at"` // unix 秒
	RSS        int64 `json:"rss"`
	Goroutines int   `json:"goroutines"`
	Heap       int64 `json:"heap"`
	Tunnels    int   `json:"tunnels"`
	Requests   int64 `json:"requests"`
}

// Event 是一条集群事件。文案不在这里拼——后端只给结构化字段，翻译归前端（i18n）。
type Event struct {
	At   int64  `json:"at"`
	Kind string `json:"kind"`           // hub_start | node_up | node_down | enroll
	Node string `json:"node,omitempty"` // 机器显示名
	Secs int64  `json:"secs,omitempty"` // node_up 时表示中断了多久
}

type selfStats struct {
	mu       sync.Mutex
	samples  []Sample
	events   []Event
	started  time.Time
	requests atomic.Int64
	// 节点最后一次掉线时刻，用来算重连中断了多久
	downAt map[string]time.Time
}

func newSelfStats() *selfStats {
	return &selfStats{started: time.Now(), downAt: map[string]time.Time{}}
}

func (s *selfStats) addEvent(e Event) {
	e.At = time.Now().Unix()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, e)
	if len(s.events) > eventKeep {
		s.events = s.events[len(s.events)-eventKeep:]
	}
}

// nodeUp / nodeDown 由隧道接入/断开处调用；nodeUp 顺带算出「中断了多久」——
// 「重连成功 · 中断 6 秒」比单纯的「上线」有用得多：前者说明它抖了一下，后者看不出抖过。
func (s *selfStats) nodeUp(name string) {
	s.mu.Lock()
	var secs int64
	if t, ok := s.downAt[name]; ok {
		secs = int64(time.Since(t).Seconds())
		delete(s.downAt, name)
	}
	s.mu.Unlock()
	s.addEvent(Event{Kind: "node_up", Node: name, Secs: secs})
}

func (s *selfStats) nodeDown(name string) {
	s.mu.Lock()
	s.downAt[name] = time.Now()
	s.mu.Unlock()
	s.addEvent(Event{Kind: "node_down", Node: name})
}

func (s *selfStats) snapshot(tunnels int) Sample {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return Sample{
		At:         time.Now().Unix(),
		RSS:        rssBytes(),
		Goroutines: runtime.NumGoroutine(),
		Heap:       int64(m.HeapAlloc),
		Tunnels:    tunnels,
		Requests:   s.requests.Load(),
	}
}

func (s *selfStats) push(sm Sample) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.samples = append(s.samples, sm)
	if len(s.samples) > sampleKeep {
		s.samples = s.samples[len(s.samples)-sampleKeep:]
	}
}

// rssBytes 读本进程的常驻内存。只有 Linux 有 /proc；别的平台返回 0，前端按「没有这项」画。
// 不用 runtime.MemStats 代替：Go 还给系统的内存不算在 RSS 里，而卡死那次的关键正是
// **RSS 一直不降**（被 cgroup 压在 300MB 反复回收），堆的数字反而看不出严重性。
func rssBytes() int64 {
	f, err := os.Open("/proc/self/status")
	if err != nil {
		return 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "VmRSS:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return 0
		}
		kb, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil {
			return 0
		}
		return kb * 1024
	}
	return 0
}

// StartSampling 起采样循环。**由装配处调用，不在 New() 里起**——测试会造很多个 Hub，
// 每个都拖一条后台 goroutine 的话，goroutine 泄漏的回归用例自己就先花了。
func (b *Hub) StartSampling(ctx context.Context) {
	b.self.addEvent(Event{Kind: "hub_start"})
	b.self.push(b.self.snapshot(b.reg.TunnelCount()))
	go func() {
		t := time.NewTicker(sampleEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				b.self.push(b.self.snapshot(b.reg.TunnelCount()))
			}
		}
	}()
}

// Self 回答「中心自己怎么样」（GET /api/hub/self）。
//
// 诊断口（pprof）**不经这里**：它只绑回环，页面上只告诉你怎么 ssh -L 转发。
// 把 heap/goroutine dump 挂到公网接口上，等于把内存内容和打垮进程的入口一起送出去。
func (b *Hub) Self(c *gin.Context) {
	b.self.mu.Lock()
	samples := append([]Sample(nil), b.self.samples...)
	events := append([]Event(nil), b.self.events...)
	started := b.self.started
	b.self.mu.Unlock()

	now := b.self.snapshot(b.reg.TunnelCount())
	nodes := b.reg.List()
	online := 0
	for _, n := range nodes {
		if n.Online {
			online++
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"version":     b.version,
		"startedAt":   started.Unix(),
		"uptimeSecs":  int64(time.Since(started).Seconds()),
		"pprof":       os.Getenv("ROAM_PPROF"),
		"now":         now,
		"nodes":       len(nodes),
		"nodesOnline": online,
		"samples":     samples,
		"events":      events,
	}})
}
