// 传输速率/诊断采样（评审点5）。
//
// 用户可见速率 = goodput = 已成功「落盘」字节的每秒增量（不是 candidate-pair 的
// bytesReceived，也不是 availableOutgoingBitrate —— 那些包含未落盘/未确认字节，会虚高，
// 不能当用户速率）。RTT 仅作诊断透出。
//
// 用法：
//   const stats = new GoodputMeter(() => writtenBytes, pc)
//   stats.onSample = (s) => { ...UI... }
//   stats.start(); ... stats.stop()

// 选中候选对（nominated candidate-pair）的诊断信息，仅进详情浮层，不当用户速率。
export interface PairDiag {
  // 往返时延（毫秒）；无数据时 undefined。
  rttMs?: number
  // 本地/远端候选类型（host | srflx | prflx | relay）。
  localType?: string
  remoteType?: string
  // 地址族（ipv4 | ipv6），由候选地址推断。
  localFamily?: string
  remoteFamily?: string
}

export interface GoodputSample {
  // 累计落盘字节（goodput 基准）。
  written: number
  // 最近一个采样周期内的落盘速率（bytes/s）。
  ratePerSec: number
  // 选中候选对的往返时延（毫秒），仅诊断；无数据时 undefined。
  rttMs?: number
  // 候选对完整诊断（type/family），仅详情浮层用。
  diag?: PairDiag
}

// 从候选地址粗判地址族：含 ':' 视作 IPv6，含 '.' 视作 IPv4。
function familyOf(addr: unknown): string | undefined {
  if (typeof addr !== 'string' || !addr) return undefined
  if (addr.includes(':')) return 'ipv6'
  if (addr.includes('.')) return 'ipv4'
  return undefined
}

export class GoodputMeter {
  onSample: (s: GoodputSample) => void = () => {}
  private timer = 0
  private lastWritten = 0
  private lastAt = 0

  // getWritten：读当前累计落盘字节；pc：可选，仅用于取 RTT 诊断。
  constructor(private getWritten: () => number, private pc?: RTCPeerConnection) {}

  start(intervalMs = 1000) {
    if (this.timer) return
    this.lastWritten = this.getWritten()
    this.lastAt = performance.now()
    this.timer = window.setInterval(() => this.tick(), intervalMs)
  }

  stop() {
    if (this.timer) {
      window.clearInterval(this.timer)
      this.timer = 0
    }
  }

  private tick() {
    const now = performance.now()
    const written = this.getWritten()
    const dt = (now - this.lastAt) / 1000
    const ratePerSec = dt > 0 ? (written - this.lastWritten) / dt : 0
    this.lastWritten = written
    this.lastAt = now

    if (!this.pc) {
      this.onSample({ written, ratePerSec })
      return
    }
    // RTT/候选对仅诊断：从选中(nominated)的 candidate-pair 取 RTT + 两端候选类型/地址族。
    this.pc.getStats().then((rs) => {
      const diag: PairDiag = {}
      let pair: any
      rs.forEach((r: any) => {
        if (r.type === 'candidate-pair' && (r.nominated || r.selected) && typeof r.currentRoundTripTime === 'number') {
          pair = r
        }
      })
      if (!pair) rs.forEach((r: any) => { if (r.type === 'candidate-pair' && (r.nominated || r.selected)) pair = r })
      if (pair) {
        if (typeof pair.currentRoundTripTime === 'number') diag.rttMs = pair.currentRoundTripTime * 1000
        const local = pair.localCandidateId ? rs.get(pair.localCandidateId) : undefined
        const remote = pair.remoteCandidateId ? rs.get(pair.remoteCandidateId) : undefined
        if (local) { diag.localType = local.candidateType; diag.localFamily = familyOf(local.address ?? local.ip) }
        if (remote) { diag.remoteType = remote.candidateType; diag.remoteFamily = familyOf(remote.address ?? remote.ip) }
      }
      this.onSample({ written, ratePerSec, rttMs: diag.rttMs, diag })
    }).catch(() => {
      this.onSample({ written, ratePerSec })
    })
  }
}
