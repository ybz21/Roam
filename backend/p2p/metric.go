// metric.go：M2 埋点接收端（POST /api/p2p/metric）。
//
// 前端一次传输结束（成功或回退）后 POST 一条 goodput 埋点。M2 目标只是能收集数据，
// 不做后台面板：主 sink 是结构化 log.Printf；可选再追加一行 JSONL 到 dataDir/p2p-metrics.jsonl。
// JSONL 落盘尽力而为——目录自建，任何失败仅 log 不影响响应。
package p2p

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// maxMetricBodyBytes 是埋点 body 大小上限（评审点8：防超大 JSON）。
// 一条 metric 只有几个数值字段 + 一个路径字符串，32 KiB 绰绰有余。
const maxMetricBodyBytes = 32 * 1024

// metricsFileName 是可选 JSONL sink 的文件名（落在 dataDir 下）。
const metricsFileName = "p2p-metrics.jsonl"

// MetricReq 是前端上报的埋点结构（§埋点）。
type MetricReq struct {
	TransferID    string  `json:"transferId"`
	Path          string  `json:"path"` // ipv6-direct|lan|upnp|stun|...
	AvgGoodputBps float64 `json:"avgGoodputBps"`
	SizeBytes     int64   `json:"sizeBytes"`
	FellBack      bool    `json:"fellBack"`
	DurationMs    int64   `json:"durationMs"`
}

// metricSink 串行化 JSONL 追加写（多请求并发时避免行交错）。
var metricSink sync.Mutex

// MetricHandler 接收一条 P2P 传输埋点：先结构化 log 作为主 sink，再可选追加 JSONL。
// dataDir 为空则跳过 JSONL 落盘（仅 log）。
func (h *Hub) MetricHandler(c *gin.Context) {
	// body 大小上限：超限读取即报错，返回 413。
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxMetricBodyBytes)
	var m MetricReq
	if err := c.ShouldBindJSON(&m); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad-metric"})
		return
	}

	// 主 sink：结构化日志（M2 靠 grep `p2p metric:` 收集）。
	log.Printf("p2p metric: transfer=%s path=%s goodput=%.0f size=%d fellBack=%v dur=%dms",
		m.TransferID, m.Path, m.AvgGoodputBps, m.SizeBytes, m.FellBack, m.DurationMs)

	// 可选 sink：追加一行 JSONL。失败仅 log，不影响响应。
	h.appendMetricJSONL(m)

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// appendMetricJSONL 尽力把一条埋点追加到 dataDir/p2p-metrics.jsonl（含 ts_ms 时间戳）。
// dataDir 为空则跳过。目录自建；任何错误仅 log。
func (h *Hub) appendMetricJSONL(m MetricReq) {
	if h.dataDir == "" {
		return
	}
	rec := struct {
		TsMs int64 `json:"tsMs"`
		MetricReq
	}{TsMs: time.Now().UnixMilli(), MetricReq: m}
	line, err := json.Marshal(rec)
	if err != nil {
		log.Printf("p2p metric: marshal jsonl: %v", err)
		return
	}
	line = append(line, '\n')

	metricSink.Lock()
	defer metricSink.Unlock()

	if err := os.MkdirAll(h.dataDir, 0o755); err != nil {
		log.Printf("p2p metric: mkdir %s: %v", h.dataDir, err)
		return
	}
	path := filepath.Join(h.dataDir, metricsFileName)
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		log.Printf("p2p metric: open %s: %v", path, err)
		return
	}
	defer f.Close()
	if _, err := f.Write(line); err != nil {
		log.Printf("p2p metric: write %s: %v", path, err)
	}
}
