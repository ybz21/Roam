// P2P 直连传输的线协议类型（照 tech 拆解 §2）。
// M0a spike 只用到其中一部分（offer/answer/ice/connected 信令 + meta/eof 控制帧），
// 其余字段（fallback/cancel/local/remote/rttMs）先按规格声明，供后续里程碑复用。

// —— 信令（JSON，走 /api/p2p/signal WS，每消息带 transferId）——
// link：Phase 1a 通用传输，会话级 control/media/file 常驻 PC 的链路态（左边栏全局状态）。
export type SignalType = 'offer' | 'answer' | 'ice' | 'connected' | 'fallback' | 'cancel' | 'link'

// 流量类：control|media|file；空=file（现有下载，向后兼容）。
export type SignalClass = 'control' | 'media' | 'file'

// connected 的 path：ipv6-direct | upnp | stun | lan
export type PathKind = 'ipv6-direct' | 'upnp' | 'stun' | 'lan'

export interface CandInfo {
  type: string   // srflx | host | prflx
  family: string // ipv4 | ipv6
  addr: string
}

export interface TransferReq {
  path: string // 绝对路径（op=spike 时忽略）
  op: 'download' | 'spike' // download=真实文件；spike=后端 serveSpike 发随机数据（自测）
}

export interface SignalMsg {
  type: SignalType
  transferId: string
  class?: SignalClass    // control|media|file；空=file（现有下载，向后兼容）
  sdp?: string
  candidate?: RTCIceCandidateInit
  transfer?: TransferReq // 仅 offer
  path?: string          // connected/link: ipv6-direct|upnp|stun|lan
  local?: CandInfo
  remote?: CandInfo
  rttMs?: number
  reason?: string        // fallback|cancel
  state?: 'up' | 'down'  // link: 链路上/下（左边栏状态）
}

// —— 传输（DataChannel 之上，保留消息边界）——
// 控制帧 = text message（JSON），数据帧 = binary message（[seq:u32 LE][payload]）。
export interface Meta {
  t: 'meta'
  transferId: string
  name: string
  size: number
  mtime: number
  chunk: number
}
export interface Eof {
  t: 'eof'
}
export interface CtrlError {
  t: 'error'
  msg: string
}
export type CtrlFrame = Meta | Eof | CtrlError
