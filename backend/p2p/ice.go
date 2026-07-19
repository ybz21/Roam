// ice.go：构建 pion WebRTC API（SettingEngine）与 rtcConfig。
//
// M0a 范围：STUN-only，IPv4+IPv6 network types 都开。
// M0b 杠杆全部 gate 在配置后：默认配置(P2PUDPPort=0、P2PUPnP=false)与 M0a 逐字节一致——
// 不设 UDPMux、不触发 UPnP。mDNS 默认开（对 localhost/LAN 无害有益，可用 P2PMDNS 关）。
package p2p

import (
	"log"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

// iceOptions 是 buildAPI 的输入，来自 config.Web 的 P2P* 字段（由 Hub 透传）。
type iceOptions struct {
	udpPort int  // >0：固定 UDP 端口 + UDPMux；0=走 M0a 路径（不设 mux）
	upnp    bool // 仅当 udpPort>0 时才尝试 UPnP 映射
	mdns    bool // 解析浏览器 .local mDNS 候选
}

// buildAPI 用 SettingEngine 构造 *webrtc.API，并返回注入的 UPnP 公网 IP（未注入则为 ""）。
//
// injectedUPnPIP 供 classifyPath 区分 upnp/stun（两者都是 srflx，靠比对本端地址区分）。
func buildAPI(opt iceOptions) (api *webrtc.API, injectedUPnPIP string) {
	se := webrtc.SettingEngine{}

	// IPv4 + IPv6 都收集候选（IPv6 直连是评审点1的价值来源）。
	se.SetNetworkTypes([]webrtc.NetworkType{
		webrtc.NetworkTypeUDP4,
		webrtc.NetworkTypeUDP6,
	})

	// mDNS：解析浏览器藏成 xxxx.local 的私网候选（同 LAN 快速通道）。默认开。
	if opt.mdns {
		se.SetICEMulticastDNSMode(ice.MulticastDNSModeQueryAndGather)
	}

	// 固定 UDP 端口 + UDPMux：仅在配置端口>0 时启用。端口=0 完全走 M0a 路径。
	// NewMultiUDPMuxFromPort 自动处理多网卡 + v4/v6。
	if opt.udpPort > 0 {
		if mux, err := ice.NewMultiUDPMuxFromPort(opt.udpPort); err != nil {
			// 绑定失败（端口占用等）：log + 跳过，退回随机端口（M0a 行为），绝不 fatal。
			log.Printf("p2p udpmux: bind port %d failed: %v, falling back to ephemeral", opt.udpPort, err)
		} else {
			se.SetICEUDPMux(mux)
			log.Printf("p2p udpmux: bound fixed UDP port %d (v4+v6, all interfaces)", opt.udpPort)

			// UPnP：仅当固定端口成立且开关打开时才尝试；只有 external==internal 才注入 srflx。
			if opt.upnp {
				if extIP, ok := mapUPnP(opt.udpPort); ok {
					se.SetNAT1To1IPs([]string{extIP}, webrtc.ICECandidateTypeSrflx)
					injectedUPnPIP = extIP
				}
			}
		}
	}

	return webrtc.NewAPI(webrtc.WithSettingEngine(se)), injectedUPnPIP
}

// rtcConfiguration 从配置的 ICE server 列表构造 webrtc.Configuration。
// M0a：STUN-only，不建 TURN（无 Username/Credential）。
func rtcConfiguration(iceServers []string) webrtc.Configuration {
	if len(iceServers) == 0 {
		return webrtc.Configuration{}
	}
	return webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: iceServers},
		},
	}
}
