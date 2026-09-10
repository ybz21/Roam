// 逐台试一下这些 STUN 到底通不通、多快。
//
// 浏览器发不了裸 UDP，但能问出同一件事：只配这一台，开一个 RTCPeerConnection，
// 看多久拿到 srflx 候选。拿到 = 这台能给出你的公网映射；拿不到 = 它对你没用。
// 量的正是我们真正在乎的那个数——建链时「第一个 srflx 什么时候到」。
import { normalizeStun } from './ice-servers'

export interface StunResult {
  url: string
  ok: boolean
  /** 从发起收集到拿到第一个 srflx 的毫秒数；ok=false 时没有 */
  ms?: number
}

const DEFAULT_TIMEOUT_MS = 5000

export function probeStun(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<StunResult> {
  return new Promise((resolve) => {
    let pc: RTCPeerConnection
    try {
      pc = new RTCPeerConnection({ iceServers: [{ urls: url }] })
    } catch {
      resolve({ url, ok: false })
      return
    }
    let settled = false
    const t0 = performance.now()
    const finish = (r: StunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { pc.close() } catch { /* ignore */ }
      resolve(r)
    }
    const timer = setTimeout(() => finish({ url, ok: false }), timeoutMs)
    pc.onicecandidate = (e) => {
      // 收集结束（null）时还没见到 srflx，说明这台没回话——不必等满超时
      if (!e.candidate) { finish({ url, ok: false }); return }
      if (e.candidate.type === 'srflx') finish({ url, ok: true, ms: Math.round(performance.now() - t0) })
    }
    pc.createDataChannel('stun-probe')
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .catch(() => finish({ url, ok: false }))
  })
}

/** 并行探一整列。并行是对的：它们本来就是并行查询的，串行测出来的顺序不代表实际用起来的顺序。 */
export function probeAll(urls: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<StunResult[]> {
  const seen = new Set<string>()
  const list: string[] = []
  for (const u of urls) {
    const n = normalizeStun(u)
    if (n && !seen.has(n)) { seen.add(n); list.push(n) }
  }
  return Promise.all(list.map((u) => probeStun(u, timeoutMs)))
}

/**
 * 优选：通的里面按快慢取前 n 台。
 *
 * 不是「取最快那一台」——单台意味着它一挂就没有候选了，而多配几台不花时间（并行查询，
 * 谁先回用谁）。也不是全都要：列表越长，SDP 里的候选和连通性检查越多，而第 5 台之后
 * 对「第一个 srflx 什么时候到」已经没有贡献。
 */
export function pickFastest(results: StunResult[], n = 4): string[] {
  return results
    .filter((r) => r.ok && typeof r.ms === 'number')
    .sort((a, b) => (a.ms as number) - (b.ms as number))
    .slice(0, n)
    .map((r) => r.url)
}
