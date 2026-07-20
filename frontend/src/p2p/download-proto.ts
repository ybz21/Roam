// P2P 下载「协议正确性」纯逻辑层（可单测，无 DOM / 无 RTC / 无 fetch）。
//
// 把评审 P0/P1 里「靠推理就能验」的部分抽成纯函数/纯类，供 download-proto.test.ts 直接跑：
//   - parseDataFrame / SeqValidator ：数据帧 [seq:u32 LE][payload] 解析 + 连续递增校验（P1-5）。
//   - validateFinalSize             ：EOF 时 written === meta.size 校验（P1-5）。
//   - WriteChain                    ：把每次 write 串成一条 Promise 链，EOF 前 await 全部完成（P0-3）。
//
// download.ts 只负责把它们接到真实 sink / transport / fetch 上；协议判定全在这里，便于测试。

// —— 数据帧解析（[seq:u32 LE][payload]）—— //
export interface DataFrame {
  seq: number
  payload: Uint8Array
}

// 解析一个二进制数据帧：前 4 字节 = seq(u32 LE)，其余 = payload。
// 帧长 < 4 视为损坏（抛错，调用方 → 回退）。
export function parseDataFrame(buf: ArrayBuffer): DataFrame {
  if (buf.byteLength < 4) throw new Error(`data frame too short: ${buf.byteLength} bytes`)
  const seq = new DataView(buf).getUint32(0, true) // little-endian，与后端一致
  const payload = new Uint8Array(buf, 4)
  return { seq, payload }
}

// —— seq 连续/递增校验（P1-5）—— //
// 后端从 0 起按 +1 连续发 seq。乱序 / 缺号 / 重复都判失败，触发回退（不能静默拼错文件）。
export class SeqValidator {
  private next = 0
  // 校验下一帧 seq 是否是期望值（= 上一帧 +1）。返回 null 表示 OK，否则返回错误说明。
  check(seq: number): string | null {
    if (!Number.isInteger(seq) || seq < 0) return `bad seq ${seq}`
    if (seq !== this.next) return `seq gap: expected ${this.next}, got ${seq}`
    this.next += 1
    return null
  }
  // 已成功收到的帧数（= 期望的下一个 seq）。
  get count(): number { return this.next }
}

// —— EOF 落盘字节数校验（P1-5）—— //
// EOF 时若 meta 给了 size，则必须 written === size；不等即源文件中途截断/多写，判失败。
// meta.size 缺省（undefined）时无从校验，放行（返回 null）。
export function validateFinalSize(written: number, expected: number | undefined): string | null {
  if (expected == null) return null
  if (written !== expected) return `size mismatch: wrote ${written}, expected ${expected}`
  return null
}

// —— 写入串行链（P0-3）—— //
// tp.onmessage 里 sink.write 返回 Promise，若直接 void 掉，EOF 可能 close 早于末尾 write，
// 且 write reject 无人接。WriteChain 把每次 write 串成一条链：
//   - enqueue(fn)：把一次写操作排到链尾，返回该操作完成的 Promise（用于按序累加 written / 捕获 reject）。
//   - drain()    ：await 到「当前排入的所有写」都完成（EOF 时先 drain 再 validate 再 close）。
//   - 任一写 reject 后，链进入 failed 态，后续 enqueue 直接拒（不再发起新写），错误经 drain 抛出。
export class WriteChain {
  private tail: Promise<void> = Promise.resolve()
  private failure: unknown = null

  // 排入一次写操作。fn 只有在前一操作 resolve 后才被调用（严格串行）。
  // 返回的 Promise 在「本次写成功」后 resolve —— 调用方据此在成功后才累加 written。
  enqueue(fn: () => Promise<void>): Promise<void> {
    if (this.failure != null) return Promise.reject(this.failure)
    const run = this.tail.then(() => {
      if (this.failure != null) throw this.failure // 前序已失败：不再发起新写
      return fn()
    })
    // tail 吞掉 rejection 只用于「串行推进」，真实错误记到 failure，由 enqueue 返回值 / drain 暴露。
    this.tail = run.then(
      () => {},
      (e) => { if (this.failure == null) this.failure = e },
    )
    return run
  }

  // 等到目前排入的所有写都完成。若链中出现过失败，drain reject 该错误。
  async drain(): Promise<void> {
    await this.tail
    if (this.failure != null) throw this.failure
  }

  // 是否已进入失败态。
  get failed(): boolean { return this.failure != null }
}

// —— 回退时把「可倒带 sink」复位到干净起点（P0-1）—— //
// 抽出这一步纯逻辑，便于对 mock sink 单测「truncate(0)+seek(0) 清掉 P2P 前缀，再从头写 HTTP 全量」
// 的语义（绝不出现 [P2P前缀]+[HTTP全量] 的拼接）。sink 必须同时提供 truncate/seek 才可倒带。
export interface RewindableSink {
  truncate(size: number): Promise<void>
  seek(offset: number): Promise<void>
}

export async function resetSinkForFallback(sink: RewindableSink): Promise<void> {
  await sink.truncate(0) // 丢掉已写的 P2P 前缀
  await sink.seek(0)     // 光标回到文件头
}

// —— P2P 下载测速自适应回退：判定纯函数（可单测，无 DOM / 无计时器）—— //
//
// 背景：跨网 STUN 打洞能连上，但国内运营商对跨网 P2P UDP 大流量限速——实测直连可能只有
// ~48 K/s，比 frp 中转(~450 K/s)还慢 10 倍。所以「跨网也盲目坚持 P2P」是错的：P2P 直连
// 平均落盘速率长期低于阈值时应自动切回 frp。同网(path==='lan')千兆不受限，不测不回退。
//
// 把「是否应回退」的判定抽成纯函数，输入落盘字节的时间序列 + 阈值 + 宽限 + 窗口，输出决策；
// download.ts 只负责按 goodput 周期喂样本并在返回 true 时调 toFallback('slow')。

// 一个 (时刻ms, 累计落盘字节) 采样点。
export interface ByteSample {
  atMs: number
  bytes: number
}

export interface SlowFallbackConfig {
  path: string           // 连上后的实际路径；'lan' 直接不判（同网必快）
  minBps: number         // 最低平均落盘速率(bytes/s)；0=禁用测速回退，永远坚持 P2P
  graceMs: number        // 宽限期(ms)：连上后前这么久不判（让它 ramp）
  windowMs: number       // 滚动评估窗口(ms)：窗口内平均 goodput 低于 minBps 才回退
}

// 判定「P2P 直连是否太慢、应回退 frp」。samples 为连上以来按时间递增的 (atMs, bytes) 序列
// （bytes = 该时刻累计落盘字节，单调不减）。返回 true 表示应触发一次回退。
//
// 规则（全部满足才回退）：
//   1. minBps > 0                         —— 阈值 0 视为禁用，永不回退。
//   2. path !== 'lan'                     —— 同网千兆不受限，不测不回退。
//   3. 已过宽限期（末样本 - 首样本 ≥ graceMs）—— 前 graceMs 让连接 ramp，不误判。
//   4. 存在一段覆盖 ≥ windowMs 的评估区间   —— 至少攒够一个完整窗口才有统计意义。
//   5. 该窗口内平均 goodput < minBps        —— (末字节-窗口起字节)/(末时刻-窗口起时刻) < minBps。
export function shouldFallbackSlow(samples: ByteSample[], cfg: SlowFallbackConfig): boolean {
  if (cfg.minBps <= 0) return false          // 禁用
  if (cfg.path === 'lan') return false        // 同网不判
  if (samples.length < 2) return false        // 不够两点算不出速率
  const first = samples[0]
  const last = samples[samples.length - 1]
  // 宽限期：连上后前 graceMs 内一律放行（让直连 ramp 到稳定速率）。
  if (last.atMs - first.atMs < cfg.graceMs) return false
  // 找覆盖 ≥ windowMs 的窗口起点：从末样本往前推 windowMs，取第一个 atMs ≤ (last - windowMs) 的样本。
  // 该样本即窗口左端；若不存在（序列还没跨满一个窗口）则不判。
  const windowStartMs = last.atMs - cfg.windowMs
  let startIdx = -1
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i].atMs <= windowStartMs) { startIdx = i; break }
  }
  if (startIdx < 0) return false              // 还没攒够一个完整窗口
  const start = samples[startIdx]
  const dtMs = last.atMs - start.atMs
  if (dtMs <= 0) return false
  const avgBps = ((last.bytes - start.bytes) * 1000) / dtMs
  return avgBps < cfg.minBps
}
