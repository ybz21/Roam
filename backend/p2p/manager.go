// manager.go：一条信令 WS 内的 session + transfer 表；PC 生命周期。
//
// M0a 范围：收 offer→建 PeerConnection→SetRemoteDescription→CreateAnswer→回 answer；
// 转发 trickle ICE；连上后打印【选中候选对类型】并发 connected 给前端；
// DataChannel 打开后循环发【固定大小随机字节流】，发完发 {"t":"eof"}。
// 真实文件、背压、取消、goodput 留到 M0b/M1（代码结构预留 cancel/done 位）。
package p2p

import (
	"context"
	"log"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

// M0a 随机流参数：共发 8 MiB，每条 16 KiB。
const (
	spikeTotalBytes = 8 * 1024 * 1024
	spikeChunkBytes = 16 * 1024
)

// 资源限额（评审点8）：
const (
	// maxConcurrentTransfers 单会话（单条信令 WS）并发 transfer 上限；
	// 超限的 offer 直接拒（每下载一个独立 PC，防一条 WS 建海量 PC 耗尽 UDP/内存）。
	maxConcurrentTransfers = 8
	// pcIdleTimeout PC 空闲超时：建 PC 后若迟迟未连上（无 DataChannel/无数据）→ finish 拆掉，
	// 防半开 PC 泄漏。真正连上（PeerConnectionStateConnected）后不再受此限。
	pcIdleTimeout = 60 * time.Second
)

// transfer 是单次传输（每次下载一个独立 PC）。
// 建链/answer/ice/状态回调走共享底层 peer（pc.go）；transfer 只保留「临时生命周期 +
// 文件协议所需的 cancel/done」。connected 复用 peer.connected（空闲超时判活）。
type transfer struct {
	id     string
	*peer                     // 共享底层 PC（建链/answer/ice/classifyPath 唯一实现）
	cancel context.CancelFunc // 取消发送 goroutine（贯穿到 os.Open 读循环）
	done   int32              // 原子终结标志，回退/取消后忽略后续
}

// session 是一条 WS 的作用域：transferId → *transfer；class → *link（持久 PC）。
type session struct {
	hub  *Hub
	send func(SignalMsg) error

	mu    sync.Mutex
	tfrs  map[string]*transfer
	links map[string]*link // class（"control" 等）→ 会话级常驻 PC
}

func (h *Hub) newSession(send func(SignalMsg) error) *session {
	return &session{
		hub:   h,
		send:  send,
		tfrs:  make(map[string]*transfer),
		links: make(map[string]*link),
	}
}

func (s *session) get(id string) *transfer {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tfrs[id]
}

func (s *session) put(t *transfer) {
	s.mu.Lock()
	s.tfrs[t.id] = t
	s.mu.Unlock()
}

// finish 终结一个 transfer：置 done、cancel goroutine、关闭 PC。幂等。
func (s *session) finish(id string) {
	s.mu.Lock()
	t := s.tfrs[id]
	delete(s.tfrs, id)
	s.mu.Unlock()
	if t == nil {
		return
	}
	atomic.StoreInt32(&t.done, 1)
	if t.cancel != nil {
		t.cancel()
	}
	t.close() // 幂等关闭共享底层 PC
}

// closeAll 在 WS 断开时清理所有 transfer 与持久 link PC。
func (s *session) closeAll() {
	s.mu.Lock()
	ids := make([]string, 0, len(s.tfrs))
	for id := range s.tfrs {
		ids = append(ids, id)
	}
	links := make([]*link, 0, len(s.links))
	for _, l := range s.links {
		links = append(links, l)
	}
	s.links = make(map[string]*link)
	s.mu.Unlock()
	for _, id := range ids {
		s.finish(id)
	}
	for _, l := range links {
		l.close()
	}
}

// onSignal 分发一条信令消息。
//
// Phase 1a：class=="control"（及后续 media）走会话级常驻 link PC；
// class 为空或 "file" 走原有「每下载一个 file PC」逻辑，行为不变（向后兼容）。
func (s *session) onSignal(m SignalMsg) {
	if isLinkClass(m.Class) {
		s.onLinkSignal(m)
		return
	}
	switch m.Type {
	case "offer":
		s.startTransfer(m)
	case "ice":
		s.addICE(m)
	case "cancel", "fallback":
		s.finish(m.TransferID)
	}
}

// addICE 转发 trickle ICE 候选给对应 PC（走共享底层）。
func (s *session) addICE(m SignalMsg) {
	t := s.get(m.TransferID)
	if t == nil {
		return
	}
	s.addRemoteICE(t.peer, transferPeerConfig(m.TransferID), m.Candidate)
}

// transferPeerConfig 构造临时 file PC 的底层参数：按 transferId 定位、不逐条打印候选、
// 只在 Failed/Closed 拆（不理会 Disconnected，与收敛前一致）。onConnected/onDown/onDataChannel
// 在 startTransfer 里补齐（需捕获具体 *transfer 与 offer 里的 op/path）。
func transferPeerConfig(id string) peerConfig {
	return peerConfig{
		keyLog:             "transfer=" + id,
		signalKey:          id,
		byClass:            false,
		verboseCand:        false,
		downOnDisconnected: false,
	}
}

// startTransfer 建 PC、设远端 SDP、回 answer，并挂好回调。
func (s *session) startTransfer(m SignalMsg) {
	if s.get(m.TransferID) != nil {
		return // 重复 offer 忽略
	}
	// 并发限额（评审点8）：单会话在建 transfer 超上限则拒绝，避免一条 WS 建海量 PC。
	s.mu.Lock()
	over := len(s.tfrs) >= maxConcurrentTransfers
	s.mu.Unlock()
	if over {
		log.Printf("p2p: transfer=%s rejected: over concurrency limit %d", m.TransferID, maxConcurrentTransfers)
		_ = s.send(SignalMsg{Type: "fallback", TransferID: m.TransferID, Reason: "too-many-transfers"})
		return
	}
	id := m.TransferID
	cfg := transferPeerConfig(id)
	// Connected 回调：发 connected 信令（字段与收敛前一致）。
	cfg.onConnected = func(path string, local, remote *CandInfo, rtt int) {
		log.Printf("p2p: transfer=%s connected path=%s local=%+v remote=%+v", id, path, local, remote)
		_ = s.send(SignalMsg{
			Type:       "connected",
			TransferID: id,
			Path:       path,
			Local:      local,
			Remote:     remote,
			RTTMs:      rtt,
		})
	}
	cfg.onDown = func() { s.finish(id) }

	ctx, cancel := context.WithCancel(context.Background())
	// 对端（浏览器）建的 DataChannel：
	//   op=="spike" → transport 自测支路，发 8 MiB 随机数据 + eof（window.roamP2PSpike）；
	//   否则 → 真实文件（serveFile：共享校验 + 分块 + 背压 + 取消）。
	var op, path string
	if m.Transfer != nil {
		op = m.Transfer.Op
		path = m.Transfer.Path
	}

	p, err := s.newPeer(cfg)
	if err != nil {
		log.Printf("p2p: NewPeerConnection(%s): %v", id, err)
		cancel()
		return
	}
	t := &transfer{id: id, peer: p, cancel: cancel}
	// OnDataChannel 需捕获 t/ctx/op/path，故在 peer 建好、t 组装后再补挂（覆盖 newPeer 里的 nil）。
	p.pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if op == "spike" {
			serveSpike(ctx, dc, t)
			return
		}
		serveFile(ctx, dc, t, path)
	})
	s.put(t)

	// 空闲超时（评审点8）：建 PC 后若 pcIdleTimeout 内仍未连上 → 拆掉，防半开 PC 泄漏。
	// ctx 在 finish 时 cancel，故已完成/已连上时该 goroutine 直接退出。
	go func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(pcIdleTimeout):
			if atomic.LoadInt32(&t.connected) == 0 && atomic.LoadInt32(&t.done) == 0 {
				log.Printf("p2p: transfer=%s idle timeout (%s), tearing down", t.id, pcIdleTimeout)
				s.finish(t.id)
			}
		}
	}()

	// 设远端 offer、回 answer——建链样板走共享底层（pc.go）。失败即拆。
	// 非 trickle：answerOffer 会等 ICE gathering 完成后再回携带全部候选的完整 answer SDP，
	// 可能阻塞数秒。放到 goroutine 里执行，避免卡住信令 WS 读循环。
	go func() {
		if err := s.answerOffer(p, cfg, m.SDP); err != nil {
			s.finish(t.id)
		}
	}()
}

// classifyPath 尽力分类选中候选对的路径，并返回诊断信息。
//
// best-effort：优先 pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair()；
// 若拿不到则退回 pc.GetStats() 遍历 nominated candidate-pair；
// 再不行则只返回 unknown（connectionState 已单独打印）。
func classifyPath(pc *webrtc.PeerConnection, upnpIP string) (path string, local, remote *CandInfo, rttMs int) {
	// 主路径：SCTP → ICETransport → 选中对。
	if sctp := pc.SCTP(); sctp != nil {
		if tr := sctp.Transport(); tr != nil {
			if it := tr.ICETransport(); it != nil {
				if pair, err := it.GetSelectedCandidatePair(); err == nil && pair != nil {
					local = candFromICE(pair.Local)
					remote = candFromICE(pair.Remote)
					return pathFromCands(local, remote, upnpIP), local, remote, rttFromStats(pc)
				}
			}
		}
	}
	// 退路：GetStats 遍历 nominated candidate-pair。
	l, r, rtt := statsSelectedPair(pc)
	if l != nil {
		return pathFromCands(l, r, upnpIP), l, r, rtt
	}
	return "unknown", nil, nil, rtt
}

// candFromICE 把 pion 的 ICECandidate 转成诊断 CandInfo。
func candFromICE(c *webrtc.ICECandidate) *CandInfo {
	if c == nil {
		return nil
	}
	return &CandInfo{
		Type:   c.Typ.String(),
		Family: family(c.Address),
		Addr:   c.Address,
	}
}

// pathFromCands 据本端候选类型/地址族分类：ipv6-direct / lan / upnp / stun。
// upnpIP 为本次 UPnP 成功注入的公网 IP（未注入则为 ""）：UPnP 与 STUN 候选都是 srflx，
// 靠比对胜出 local 候选地址是否等于注入的映射 IP 来区分（评审点1）。故 upnp 须排在 stun 之前。
func pathFromCands(local, remote *CandInfo, upnpIP string) string {
	if local == nil {
		return "unknown"
	}
	switch {
	case local.Type == "host" && local.Family == "ipv6":
		return "ipv6-direct"
	case local.Type == "host":
		return "lan"
	case upnpIP != "" && local.Addr == upnpIP:
		return "upnp"
	case local.Type == "srflx" || local.Type == "prflx":
		return "stun"
	default:
		return local.Type
	}
}

// family 判定地址族：含 ':' 视为 IPv6。
func family(addr string) string {
	if ip := net.ParseIP(addr); ip != nil {
		if ip.To4() == nil {
			return "ipv6"
		}
		return "ipv4"
	}
	if strings.Contains(addr, ":") {
		return "ipv6"
	}
	return "ipv4"
}

// rttFromStats 从 GetStats 取选中对的 currentRoundTripTime（毫秒，仅诊断）。
func rttFromStats(pc *webrtc.PeerConnection) int {
	_, _, rtt := statsSelectedPair(pc)
	return rtt
}

// statsSelectedPair 遍历 GetStats 找 nominated 的 candidate-pair，
// 返回其本/远端候选诊断与 RTT（毫秒）。找不到返回 (nil,nil,0)。
func statsSelectedPair(pc *webrtc.PeerConnection) (local, remote *CandInfo, rttMs int) {
	report := pc.GetStats()
	// 先找 nominated candidate-pair。
	var pair *webrtc.ICECandidatePairStats
	for _, s := range report {
		if p, ok := s.(webrtc.ICECandidatePairStats); ok {
			if p.Nominated {
				cp := p
				pair = &cp
				break
			}
		}
	}
	if pair == nil {
		return nil, nil, 0
	}
	rttMs = int(pair.CurrentRoundTripTime * 1000)
	for _, s := range report {
		if cs, ok := s.(webrtc.ICECandidateStats); ok {
			ci := &CandInfo{Type: cs.CandidateType.String(), Family: family(cs.IP), Addr: cs.IP}
			if cs.ID == pair.LocalCandidateID {
				local = ci
			}
			if cs.ID == pair.RemoteCandidateID {
				remote = ci
			}
		}
	}
	return local, remote, rttMs
}
