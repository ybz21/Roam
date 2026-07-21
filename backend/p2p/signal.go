// signal.go：P2P 信令 WS（GET /api/p2p/signal）+ 消息编解码。
//
// 挂在已鉴权的 /api 组，cookie 自动校验，handler 内不再验。
// WS 库复用 gorilla/websocket（同 browser/screencast.go 范式）；
// gorilla 的写非并发安全，故所有 WriteJSON 走 sync.Mutex 串行。
package p2p

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

// maxSignalMsgBytes 是单条信令消息（含 SDP）的大小上限（评审点8：防超大 JSON）。
const maxSignalMsgBytes = 256 * 1024

// upgrader 复用 screencast 同款：同源校验（Origin host 必须等于请求 Host）。
var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 1 << 16,
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		i := strings.Index(origin, "://")
		return i >= 0 && origin[i+3:] == r.Host
	},
}

// SignalMsg 是信令线协议（JSON，走 /api/p2p/signal），每消息带 transferId。
// 见 p2p-direct-transfer-tech.md §2.1。M0a 只用到 offer/answer/ice/connected/cancel。
type SignalMsg struct {
	Type       string           `json:"type"`            // offer|answer|ice|connected|fallback|cancel|link
	TransferID string           `json:"transferId"`      //
	Class      string           `json:"class,omitempty"` // control|media|file；空=file（现有下载，向后兼容）
	SDP        string           `json:"sdp,omitempty"`
	Candidate  *json.RawMessage `json:"candidate,omitempty"`
	Transfer   *TransferReq     `json:"transfer,omitempty"` // 仅 offer
	Path       string           `json:"path,omitempty"`     // connected: ipv6-direct|lan|stun
	Local      *CandInfo        `json:"local,omitempty"`
	Remote     *CandInfo        `json:"remote,omitempty"`
	RTTMs      int              `json:"rttMs,omitempty"`
	Reason     string           `json:"reason,omitempty"` // fallback|cancel
	State      string           `json:"state,omitempty"`  // link: up|down（left rail 状态）
}

// TransferReq 仅在 offer 携带：{path:/abs, op:"download"}。
// M0a 不读真实文件，此处仅透传占位。
type TransferReq struct {
	Path string `json:"path"`
	Op   string `json:"op"`
}

// CandInfo 是候选诊断信息（best-effort，仅用于打印/展示）。
type CandInfo struct {
	Type   string `json:"type"`   // host|srflx|prflx|relay
	Family string `json:"family"` // ipv4|ipv6
	Addr   string `json:"addr"`
}

// HubConfig 是 Hub 的构造参数（由 server.Config 的 P2P* 字段透传）。
type HubConfig struct {
	Enabled    bool
	ICEServers []string
	UDPPort    int    // M0b：>0 时固定 UDP 端口 + UDPMux；0=M0a 随机端口
	UPnP       bool   // M0b：仅 UDPPort>0 时尝试 UPnP 映射
	MDNS       bool   // M0b：解析浏览器 .local mDNS 候选（默认 true）
	DataDir    string // M2：埋点 JSONL sink 所在目录（空则只 log，不落盘）
}

// Hub 承载 P2P 信令的全局状态：复用一份 webrtc.API 与 rtcConfig。
type Hub struct {
	api       *webrtc.API
	rtcConfig webrtc.Configuration
	enabled   bool
	// upnpIP 是本次启动 UPnP 成功注入的公网 IP（未注入则为 ""）。
	// 供 classifyPath 区分 upnp/stun（两者候选都是 srflx）。
	upnpIP string
	// dataDir 是 M2 埋点 JSONL sink 目录（空则只 log，不落盘）。
	dataDir string
}

// NewHub 构造 Hub。配置来自 config.Web 的 P2P* 字段。
// Enabled=false 时 SignalHandler 直接拒绝升级（灰度总开关）。
func NewHub(cfg HubConfig) *Hub {
	api, upnpIP := buildAPI(iceOptions{
		udpPort: cfg.UDPPort,
		upnp:    cfg.UPnP,
		mdns:    cfg.MDNS,
	})
	return &Hub{
		api:       api,
		rtcConfig: rtcConfiguration(cfg.ICEServers),
		enabled:   cfg.Enabled,
		upnpIP:    upnpIP,
		dataDir:   cfg.DataDir,
	}
}

// SignalHandler 是 GET /api/p2p/signal 的 gorilla WS handler。
// 一条 WS 可服务多个 transferId（session 维护 transfer 表）。
func (h *Hub) SignalHandler(c *gin.Context) {
	if !h.enabled {
		c.String(http.StatusForbidden, "p2p disabled")
		return
	}
	ws, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer ws.Close()

	// 控制帧大小上限（评审点8）：防超大 JSON 信令撑爆内存。SDP 可达数 KB，
	// 留 256 KiB 余量足够 offer/answer/ice，超限 ReadJSON 直接报错、循环退出。
	ws.SetReadLimit(maxSignalMsgBytes)

	var wmu sync.Mutex // gorilla 写串行
	send := func(m SignalMsg) error {
		wmu.Lock()
		defer wmu.Unlock()
		return ws.WriteJSON(m)
	}

	sess := h.newSession(send)
	defer sess.closeAll()

	for {
		var m SignalMsg
		if err := ws.ReadJSON(&m); err != nil {
			return
		}
		if m.Type == "" {
			continue
		}
		sess.onSignal(m)
	}
}
