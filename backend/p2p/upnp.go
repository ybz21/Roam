// upnp.go：M0b UPnP/NAT-PMP 端口映射（复用 github.com/libp2p/go-nat，不手写协议）。
//
// 评审点1（穿透 playbook §4.1-2）：SetNAT1To1IPs 只替换 candidate 的 IP、不改端口，
// 无法表达「external port ≠ ICE 本地端口」。故必须先固定内部端口(UDPMux)，再申请把
// 同一个 external port 映射到该内部端口——**只有 external==internal 才能宣称该 srflx**，
// 否则广播出去的 公网IP:本地端口 是错的、打不通，必须跳过。
//
// 任何一步失败都只 log + 返回 (_, false)，绝不 fatal：穿透是纯增益，失败要能回退 frp。
package p2p

import (
	"context"
	"log"
	"time"

	gonat "github.com/libp2p/go-nat"
)

// mapUPnP 尝试把 UDP 内部端口 port 映射成同号的 external port。
// 成功（external==internal 且拿到公网 IP）返回 (公网IP字符串, true)；任何情况失败返回 ("", false)。
func mapUPnP(port int) (extIP string, ok bool) {
	// 发现网关：UPnP/NAT-PMP/PCP 三协议自动探测，给个短超时避免卡启动。
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	nat, err := gonat.DiscoverGateway(ctx)
	if err != nil {
		log.Printf("p2p upnp: discover gateway failed: %v, skipping", err)
		return "", false
	}

	ip, err := nat.GetExternalAddress()
	if err != nil {
		log.Printf("p2p upnp: get external address failed: %v, skipping", err)
		return "", false
	}

	// 申请 UDP 端口映射；go-nat 返回真正被网关分配的 external port（可能 != 内部端口）。
	mctx, mcancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer mcancel()
	extPort, err := nat.AddPortMapping(mctx, "udp", port, "roam-p2p", 2*time.Hour)
	if err != nil {
		log.Printf("p2p upnp: add port mapping udp %d failed: %v, skipping", port, err)
		return "", false
	}

	// 评审点1 核心：端口必须一致才能宣称。
	if extPort != port {
		log.Printf("p2p upnp: external port %d != internal %d, skipping (SetNAT1To1IPs 只改 IP 不改端口)", extPort, port)
		return "", false
	}

	extIP = ip.String()
	log.Printf("p2p upnp: mapped external=%s:%d == internal, injected srflx", extIP, extPort)
	return extIP, true
}
