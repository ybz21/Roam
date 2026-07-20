// ice.go：构建 pion WebRTC API（SettingEngine）与 rtcConfig。
//
// M0a 范围：STUN-only，IPv4+IPv6 network types 都开。
// M0b 杠杆全部 gate 在配置后：默认配置(P2PUDPPort=0、P2PUPnP=false)与 M0a 逐字节一致——
// 不设 UDPMux、不触发 UPnP。mDNS 默认开（对 localhost/LAN 无害有益，可用 P2PMDNS 关）。
package p2p

import (
	"log"
	"net"

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

	// SCTP 接收缓冲：默认 1 MiB 在高 RTT 跨网链路上会把吞吐限在 缓冲/RTT（BDP 限制，
	// 如 100ms RTT 下 1MiB≈10MB/s）。调大到 16 MiB 让高延迟链路也能跑满窗口。
	// 注意：仅影响 pion 侧接收（浏览器→服务器 上传方向）；下载(服务器→浏览器)受浏览器 SCTP 窗口限制。
	se.SetSCTPMaxReceiveBufferSize(16 * 1024 * 1024)

	// 网络类型：始终开 UDP4；仅当本机存在可路由的全局 IPv6（非 fe80 链路本地、非 ::1、
	// 非 ULA fc00::/7）时才加 UDP6。没有全局 v6 却开 UDP6，pion 会对着无出口的 v6 地址
	// 反复尝试 gather，刷 "udp6 network unreachable" 日志并拖慢/干扰 v4 侧 srflx 收集。
	netTypes := []webrtc.NetworkType{webrtc.NetworkTypeUDP4}
	if hasGlobalIPv6() {
		netTypes = append(netTypes, webrtc.NetworkTypeUDP6)
		log.Printf("p2p ice: global IPv6 present, enabling UDP4+UDP6")
	} else {
		log.Printf("p2p ice: no global IPv6, enabling UDP4 only")
	}
	se.SetNetworkTypes(netTypes)

	// mDNS：只「解析」浏览器藏成 xxxx.local 的私网候选，但服务器自身**播报真实 LAN IP**
	// （QueryOnly，不 Gather）——否则服务器 host 候选是 xxxx.local，跨子网/远端浏览器解析不了，
	// 白白丢掉同网 host↔host 直连的机会。服务器不是隐私敏感端，播报真实内网 IP 更有用。
	if opt.mdns {
		se.SetICEMulticastDNSMode(ice.MulticastDNSModeQueryOnly)
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

// hasGlobalIPv6 报告本机是否有可路由的全局 IPv6 地址（可作为直连候选的那种）。
// 排除：环回(::1)、链路本地(fe80::/10)、唯一本地(ULA fc00::/7)、以及 IPv4/映射地址。
// 仅统计 up 且非 loopback 网卡上的地址。
func hasGlobalIPv6() bool {
	ifaces, err := net.Interfaces()
	if err != nil {
		return false
	}
	for _, ifi := range ifaces {
		if ifi.Flags&net.FlagUp == 0 || ifi.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifi.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.To4() != nil {
				continue // 非 IPv6
			}
			if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
				continue
			}
			// ULA fc00::/7（IsPrivate 对 v6 即判 ULA）：不是全局可路由，跳过。
			if ip.IsPrivate() {
				continue
			}
			if ip.IsGlobalUnicast() {
				return true
			}
		}
	}
	return false
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
