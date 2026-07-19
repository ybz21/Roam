// manager.go：一条信令 WS 内的 session + transfer 表；PC 生命周期。
//
// M0a 范围：收 offer→建 PeerConnection→SetRemoteDescription→CreateAnswer→回 answer；
// 转发 trickle ICE；连上后打印【选中候选对类型】并发 connected 给前端；
// DataChannel 打开后循环发【固定大小随机字节流】，发完发 {"t":"eof"}。
// 真实文件、背压、取消、goodput 留到 M0b/M1（代码结构预留 cancel/done 位）。
package p2p

import (
	"context"
	"encoding/json"
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
type transfer struct {
	id        string
	pc        *webrtc.PeerConnection
	cancel    context.CancelFunc // 取消发送 goroutine（贯穿到 os.Open 读循环）
	done      int32              // 原子终结标志，回退/取消后忽略后续
	connected int32              // 原子：已进入 Connected，空闲超时不再拆
}

// session 是一条 WS 的作用域：transferId → *transfer。
type session struct {
	hub  *Hub
	send func(SignalMsg) error

	mu   sync.Mutex
	tfrs map[string]*transfer
}

func (h *Hub) newSession(send func(SignalMsg) error) *session {
	return &session{hub: h, send: send, tfrs: make(map[string]*transfer)}
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
	if t.pc != nil {
		_ = t.pc.Close()
	}
}

// closeAll 在 WS 断开时清理所有 transfer。
func (s *session) closeAll() {
	s.mu.Lock()
	ids := make([]string, 0, len(s.tfrs))
	for id := range s.tfrs {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.finish(id)
	}
}

// onSignal 分发一条信令消息。
func (s *session) onSignal(m SignalMsg) {
	switch m.Type {
	case "offer":
		s.startTransfer(m)
	case "ice":
		s.addICE(m)
	case "cancel", "fallback":
		s.finish(m.TransferID)
	}
}

// addICE 转发 trickle ICE 候选给对应 PC。
func (s *session) addICE(m SignalMsg) {
	t := s.get(m.TransferID)
	if t == nil || m.Candidate == nil {
		return
	}
	var init webrtc.ICECandidateInit
	if err := json.Unmarshal(*m.Candidate, &init); err != nil {
		return
	}
	if err := t.pc.AddICECandidate(init); err != nil {
		log.Printf("p2p: AddICECandidate(%s): %v", m.TransferID, err)
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
	pc, err := s.hub.api.NewPeerConnection(s.hub.rtcConfig)
	if err != nil {
		log.Printf("p2p: NewPeerConnection(%s): %v", m.TransferID, err)
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	t := &transfer{id: m.TransferID, pc: pc, cancel: cancel}
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

	// trickle ICE：本端候选回传前端。
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		raw, err := json.Marshal(c.ToJSON())
		if err != nil {
			return
		}
		rm := json.RawMessage(raw)
		_ = s.send(SignalMsg{Type: "ice", TransferID: t.id, Candidate: &rm})
	})

	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		log.Printf("p2p: transfer=%s connectionState=%s", t.id, st.String())
		switch st {
		case webrtc.PeerConnectionStateConnected:
			atomic.StoreInt32(&t.connected, 1)
			path, local, remote, rtt := classifyPath(pc, s.hub.upnpIP)
			log.Printf("p2p: transfer=%s connected path=%s local=%+v remote=%+v", t.id, path, local, remote)
			_ = s.send(SignalMsg{
				Type:       "connected",
				TransferID: t.id,
				Path:       path,
				Local:      local,
				Remote:     remote,
				RTTMs:      rtt,
			})
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			s.finish(t.id)
		}
	})

	// 对端（浏览器）建的 DataChannel：
	//   op=="spike" → transport 自测支路，发 8 MiB 随机数据 + eof（window.roamP2PSpike）；
	//   否则 → 真实文件（serveFile：共享校验 + 分块 + 背压 + 取消）。
	var op, path string
	if m.Transfer != nil {
		op = m.Transfer.Op
		path = m.Transfer.Path
	}
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if op == "spike" {
			serveSpike(ctx, dc, t)
			return
		}
		serveFile(ctx, dc, t, path)
	})

	if err := pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  m.SDP,
	}); err != nil {
		log.Printf("p2p: SetRemoteDescription(%s): %v", m.TransferID, err)
		s.finish(t.id)
		return
	}
	ans, err := pc.CreateAnswer(nil)
	if err != nil {
		log.Printf("p2p: CreateAnswer(%s): %v", m.TransferID, err)
		s.finish(t.id)
		return
	}
	if err := pc.SetLocalDescription(ans); err != nil {
		log.Printf("p2p: SetLocalDescription(%s): %v", m.TransferID, err)
		s.finish(t.id)
		return
	}
	if err := s.send(SignalMsg{Type: "answer", TransferID: t.id, SDP: ans.SDP}); err != nil {
		log.Printf("p2p: send answer(%s): %v", m.TransferID, err)
		s.finish(t.id)
	}
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
