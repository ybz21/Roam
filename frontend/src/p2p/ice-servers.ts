// STUN 列表：文本 ↔ URL 数组的解析，和设置页下拉里那几台公共服务。
//
// 多写几台不是冗余：浏览器并行查询全部 STUN，谁先回谁先给出 srflx 候选，一台不可达只是
// 少一条候选、不阻塞其余（实测见 docs/design/p2p/stun-servers.md）。

// 一台一条 RTCIceServer，不把多个 URL 挤进同一条：同一条里的 URL 共享凭据，
// 将来混进 TURN 会连坐（与后端 p2p/ice.go 的 rtcConfiguration 同构）。
export function toIceServers(urls: string[]): RTCIceServer[] {
  return urls.map((u) => ({ urls: u }))
}

// 补 stun: 前缀：漏掉 scheme 的写法太自然，而浏览器会把整条丢掉——
// 一台配了却从不生效的 STUN 比没配更难查。
export function normalizeStun(url: string): string {
  const u = url.trim()
  if (!u || !u.includes(':')) return ''
  return /^stuns?:|^turns?:/.test(u) ? u : `stun:${u}`
}

// 偏好里存的是一行逗号/空格分隔的文本（沿用既有 p2pStunServers 类型，不做迁移）。
export function parseStunList(text: string | undefined): string[] {
  const out: string[] = []
  for (const raw of (text || '').split(/[\s,]+/)) {
    const u = normalizeStun(raw)
    if (u && !out.includes(u)) out.push(u)
  }
  return out
}

// 设置页下拉的候选。都是公共服务，只做 NAT 映射发现、不承载数据字节。
// 前两台国内直连快（本机实测 3~10ms，Google 那几台 100~180ms），排前面。
export const STUN_PRESETS: { value: string; brand: string }[] = [
  { value: 'stun:stun.miwifi.com:3478', brand: 'Xiaomi' },
  { value: 'stun:stun.chat.bilibili.com:3478', brand: 'Bilibili' },
  { value: 'stun:stun.l.google.com:19302', brand: 'Google' },
  { value: 'stun:stun1.l.google.com:19302', brand: 'Google' },
  { value: 'stun:global.stun.twilio.com:3478', brand: 'Twilio' },
  { value: 'stun:stun.cloudflare.com:3478', brand: 'Cloudflare' },
  { value: 'stun:stun.relay.metered.ca:80', brand: 'Metered' },
  { value: 'stun:stun.nextcloud.com:3478', brand: 'Nextcloud' },
  { value: 'stun:stun.hot-chilli.net:3478', brand: 'Hot-Chilli' },
]
