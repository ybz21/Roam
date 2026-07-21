package p2p

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// newTestHub 造一个不依赖外部 STUN 的 Hub（随机端口、无 UPnP/mDNS），用于本地环回协商测试。
func newTestHub(t *testing.T) *Hub {
	t.Helper()
	return NewHub(HubConfig{Enabled: true})
}

// TestAnswerOfferNonTrickle 验证非 trickle answer 流程（P0-2）：
// answerOffer 走 SetRemote→CreateAnswer→SetLocal→等 gathering 完成→回一次性含全部候选的完整 answer SDP。
// 断言：回发的正是 answer；其 SDP 至少携带一条 host 候选（gathering 已完成，不是空描述）。
func TestAnswerOfferNonTrickle(t *testing.T) {
	hub := newTestHub(t)

	// 收集后端经 send 回发的信令。
	got := make(chan SignalMsg, 8)
	sess := hub.newSession(func(m SignalMsg) error {
		got <- m
		return nil
	})

	// 模拟前端：建一条 offer PC，等自己 gathering 完成后拿完整 offer SDP（非 trickle）。
	offerPC, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("offer NewPeerConnection: %v", err)
	}
	defer offerPC.Close()
	if _, err := offerPC.CreateDataChannel("control#control", nil); err != nil {
		t.Fatalf("CreateDataChannel: %v", err)
	}
	offer, err := offerPC.CreateOffer(nil)
	if err != nil {
		t.Fatalf("CreateOffer: %v", err)
	}
	gatherOffer := webrtc.GatheringCompletePromise(offerPC)
	if err := offerPC.SetLocalDescription(offer); err != nil {
		t.Fatalf("offer SetLocalDescription: %v", err)
	}
	<-gatherOffer
	fullOffer := offerPC.LocalDescription().SDP

	cfg := linkPeerConfig("control")
	p, err := sess.newPeer(cfg)
	if err != nil {
		t.Fatalf("newPeer: %v", err)
	}
	defer p.close()

	// answerOffer 内部会等自己 gathering 完成再 send；用 goroutine 跑，主测从 got 通道收结果。
	errc := make(chan error, 1)
	go func() { errc <- sess.answerOffer(p, cfg, fullOffer) }()

	var answer *SignalMsg
	deadline := time.After(15 * time.Second)
	for answer == nil {
		select {
		case m := <-got:
			if m.Type == "answer" {
				mm := m
				answer = &mm
			}
		case err := <-errc:
			if err != nil {
				t.Fatalf("answerOffer returned error: %v", err)
			}
		case <-deadline:
			t.Fatal("timed out waiting for answer signal")
		}
	}

	if answer.SDP == "" {
		t.Fatal("answer SDP is empty")
	}
	// 非 trickle 关键断言：answer 完整 SDP 里已内嵌本端候选（gathering 完成后才发）。
	if !strings.Contains(answer.SDP, "a=candidate:") {
		t.Fatalf("answer SDP carries no ICE candidate (non-trickle should embed all):\n%s", answer.SDP)
	}
	// 且信令定位字段走 Class（link 类），不是 TransferID。
	if answer.Class != "control" {
		t.Fatalf("answer Class = %q, want %q", answer.Class, "control")
	}
	if answer.TransferID != "" {
		t.Fatalf("link answer should not carry TransferID, got %q", answer.TransferID)
	}
}

// TestTransferAnswerUsesTransferID 验证 file 类（空 class）走 TransferID 定位、也走非 trickle 完整 answer。
func TestTransferAnswerUsesTransferID(t *testing.T) {
	hub := newTestHub(t)
	got := make(chan SignalMsg, 8)
	sess := hub.newSession(func(m SignalMsg) error { got <- m; return nil })

	offerPC, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("offer NewPeerConnection: %v", err)
	}
	defer offerPC.Close()
	if _, err := offerPC.CreateDataChannel("file", nil); err != nil {
		t.Fatalf("CreateDataChannel: %v", err)
	}
	offer, err := offerPC.CreateOffer(nil)
	if err != nil {
		t.Fatalf("CreateOffer: %v", err)
	}
	gather := webrtc.GatheringCompletePromise(offerPC)
	if err := offerPC.SetLocalDescription(offer); err != nil {
		t.Fatalf("SetLocalDescription: %v", err)
	}
	<-gather

	cfg := transferPeerConfig("t-123")
	p, err := sess.newPeer(cfg)
	if err != nil {
		t.Fatalf("newPeer: %v", err)
	}
	defer p.close()

	errc := make(chan error, 1)
	go func() { errc <- sess.answerOffer(p, cfg, offerPC.LocalDescription().SDP) }()

	deadline := time.After(15 * time.Second)
	for {
		select {
		case m := <-got:
			if m.Type != "answer" {
				continue
			}
			if m.TransferID != "t-123" {
				t.Fatalf("transfer answer TransferID = %q, want %q", m.TransferID, "t-123")
			}
			if m.Class != "" {
				t.Fatalf("transfer answer should not carry Class, got %q", m.Class)
			}
			return
		case err := <-errc:
			if err != nil {
				t.Fatalf("answerOffer error: %v", err)
			}
		case <-deadline:
			t.Fatal("timed out waiting for transfer answer")
		}
	}
}

// TestSignalMsgCodec 验证信令 JSON 编解码：offer 携 transfer、answer 携 sdp、link 携 state/path、
// omitempty 字段在缺省时不出现（线协议稳定）。
func TestSignalMsgCodec(t *testing.T) {
	cand := json.RawMessage(`{"candidate":"candidate:1 1 udp 2130706431 1.2.3.4 5000 typ host","sdpMid":"0"}`)
	in := SignalMsg{
		Type:       "offer",
		TransferID: "tid-1",
		SDP:        "v=0...",
		Candidate:  &cand,
		Transfer:   &TransferReq{Path: "/abs/f", Op: "download"},
	}
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out SignalMsg
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Type != in.Type || out.TransferID != in.TransferID || out.SDP != in.SDP {
		t.Fatalf("round-trip mismatch: %+v vs %+v", out, in)
	}
	if out.Transfer == nil || out.Transfer.Path != "/abs/f" || out.Transfer.Op != "download" {
		t.Fatalf("transfer round-trip mismatch: %+v", out.Transfer)
	}
	if out.Candidate == nil {
		t.Fatal("candidate lost in round-trip")
	}

	// omitempty：顶层 class/state/reason 缺省时不应出现在 JSON（transfer 内的 path 是另一层，不算）。
	s := string(raw)
	for _, k := range []string{`"class"`, `"state"`, `"reason"`} {
		if strings.Contains(s, k) {
			t.Fatalf("empty field %s should be omitted, got: %s", k, s)
		}
	}

	// link 消息：state/path 应保留。
	linkRaw, _ := json.Marshal(SignalMsg{Type: "link", Class: "control", State: "up", Path: "lan"})
	if !strings.Contains(string(linkRaw), `"state":"up"`) || !strings.Contains(string(linkRaw), `"path":"lan"`) {
		t.Fatalf("link fields lost: %s", linkRaw)
	}
}

// TestParseCandStr 验证候选串解析（诊断日志用）：typ 与连接地址抽取正确，短串安全返回空。
func TestParseCandStr(t *testing.T) {
	typ, addr := parseCandStr("candidate:842163049 1 udp 1677729535 203.0.113.5 54321 typ srflx raddr 0.0.0.0 rport 0")
	if typ != "srflx" || addr != "203.0.113.5" {
		t.Fatalf("parseCandStr = (%q,%q), want (srflx, 203.0.113.5)", typ, addr)
	}
	if typ, addr := parseCandStr("too short"); typ != "" || addr != "" {
		t.Fatalf("short candidate should parse empty, got (%q,%q)", typ, addr)
	}
}

// TestPathFromCands 验证路径分类（upnp 须排在 stun 前；host+ipv6=ipv6-direct）。
func TestPathFromCands(t *testing.T) {
	cases := []struct {
		local  *CandInfo
		upnpIP string
		want   string
	}{
		{&CandInfo{Type: "host", Family: "ipv6", Addr: "2001:db8::1"}, "", "ipv6-direct"},
		{&CandInfo{Type: "host", Family: "ipv4", Addr: "192.168.1.2"}, "", "lan"},
		{&CandInfo{Type: "srflx", Family: "ipv4", Addr: "203.0.113.9"}, "203.0.113.9", "upnp"},
		{&CandInfo{Type: "srflx", Family: "ipv4", Addr: "198.51.100.7"}, "", "stun"},
		{nil, "", "unknown"},
	}
	for i, c := range cases {
		if got := pathFromCands(c.local, nil, c.upnpIP); got != c.want {
			t.Fatalf("case %d: pathFromCands = %q, want %q", i, got, c.want)
		}
	}
}
