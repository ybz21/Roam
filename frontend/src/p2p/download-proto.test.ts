import { describe, it, expect } from 'vitest'
import {
  parseDataFrame,
  SeqValidator,
  shouldFallbackSlow,
  validateFinalSize,
  WriteChain,
  type ByteSample,
} from './download-proto'

// 构造一个数据帧：[seq:u32 LE][payload]。
function frame(seq: number, payload: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(4 + payload.length)
  new DataView(buf).setUint32(0, seq, true)
  new Uint8Array(buf, 4).set(payload)
  return buf
}

describe('parseDataFrame', () => {
  it('parses seq (u32 LE) and payload', () => {
    const f = parseDataFrame(frame(258, [1, 2, 3]))
    expect(f.seq).toBe(258) // 0x0102 LE
    expect([...f.payload]).toEqual([1, 2, 3])
  })

  it('handles empty payload', () => {
    const f = parseDataFrame(frame(0, []))
    expect(f.seq).toBe(0)
    expect(f.payload.byteLength).toBe(0)
  })

  it('throws on frame shorter than the 4-byte seq header', () => {
    expect(() => parseDataFrame(new ArrayBuffer(3))).toThrow(/too short/)
  })
})

describe('SeqValidator (P1-5: seq 连续/递增)', () => {
  it('accepts strictly consecutive seq from 0', () => {
    const v = new SeqValidator()
    expect(v.check(0)).toBeNull()
    expect(v.check(1)).toBeNull()
    expect(v.check(2)).toBeNull()
    expect(v.count).toBe(3)
  })

  it('rejects a gap (missing seq)', () => {
    const v = new SeqValidator()
    expect(v.check(0)).toBeNull()
    expect(v.check(2)).toMatch(/gap: expected 1, got 2/)
  })

  it('rejects out-of-order / going backwards', () => {
    const v = new SeqValidator()
    expect(v.check(0)).toBeNull()
    expect(v.check(1)).toBeNull()
    expect(v.check(1)).toMatch(/gap: expected 2, got 1/) // 重复
  })

  it('rejects a non-zero first seq', () => {
    const v = new SeqValidator()
    expect(v.check(1)).toMatch(/gap: expected 0, got 1/)
  })

  it('rejects negative / non-integer seq', () => {
    const v = new SeqValidator()
    expect(v.check(-1)).toMatch(/bad seq/)
    expect(v.check(1.5)).toMatch(/bad seq/)
  })
})

describe('validateFinalSize (P1-5: EOF written === meta.size)', () => {
  it('passes when written matches expected', () => {
    expect(validateFinalSize(100, 100)).toBeNull()
  })

  it('fails on short write (源中途截断)', () => {
    expect(validateFinalSize(90, 100)).toMatch(/size mismatch: wrote 90, expected 100/)
  })

  it('fails on over-write', () => {
    expect(validateFinalSize(110, 100)).toMatch(/size mismatch/)
  })

  it('passes (no check) when meta.size is unknown', () => {
    expect(validateFinalSize(123, undefined)).toBeNull()
  })
})

describe('WriteChain (P0-3: 写入串行 + EOF 前 drain)', () => {
  it('runs writes strictly in order, never overlapping', async () => {
    const chain = new WriteChain()
    const order: string[] = []
    let active = 0
    let maxActive = 0
    const mk = (label: string, delay: number) => () =>
      new Promise<void>((resolve) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        setTimeout(() => {
          order.push(label)
          active -= 1
          resolve()
        }, delay)
      })

    // 故意让先入队的更慢：若并发执行，快的会先完成 → 顺序错乱。
    chain.enqueue(mk('a', 30))
    chain.enqueue(mk('b', 5))
    chain.enqueue(mk('c', 1))
    await chain.drain()

    expect(order).toEqual(['a', 'b', 'c']) // 严格 FIFO
    expect(maxActive).toBe(1) // 任一时刻至多一个写在跑（串行）
  })

  it('drain awaits all pending writes (EOF 不早于末尾 write)', async () => {
    const chain = new WriteChain()
    let finished = false
    chain.enqueue(() => new Promise<void>((r) => setTimeout(() => { finished = true; r() }, 20)))
    expect(finished).toBe(false) // drain 前还没完成
    await chain.drain()
    expect(finished).toBe(true) // drain 后一定完成
  })

  it('accumulates written only after each write resolves', async () => {
    const chain = new WriteChain()
    let written = 0
    const sizes = [10, 20, 30]
    for (const s of sizes) {
      // written 只在 resolve 后累加（模拟 download.ts 里 .then 累加语义）。
      void chain.enqueue(() => new Promise<void>((r) => setTimeout(r, 5))).then(() => { written += s })
    }
    expect(written).toBe(0) // 尚未 resolve
    await chain.drain()
    expect(written).toBe(60)
  })

  it('surfaces a write rejection through drain and enters failed state', async () => {
    const chain = new WriteChain()
    const boom = new Error('sink write failed')
    void chain.enqueue(() => Promise.reject(boom)).catch(() => {})
    await expect(chain.drain()).rejects.toBe(boom)
    expect(chain.failed).toBe(true)
  })

  it('does not run later writes after a failure (no P2P-prefix + more writes)', async () => {
    const chain = new WriteChain()
    let ranSecond = false
    void chain.enqueue(() => Promise.reject(new Error('x'))).catch(() => {})
    await expect(
      chain.enqueue(() => { ranSecond = true; return Promise.resolve() }),
    ).rejects.toThrow()
    expect(ranSecond).toBe(false)
  })
})

describe('shouldFallbackSlow (P2P 测速自适应回退判定)', () => {
  const GRACE = 3_000
  const WINDOW = 5_000
  const MIN = 200 * 1024 // 200 KB/s 阈值(bytes/s)

  // 生成一段等间隔样本：从 0ms 起每 stepMs 一个点，每步累加 bytesPerStep 字节。
  function ramp(bytesPerStep: number, stepMs: number, steps: number): ByteSample[] {
    const out: ByteSample[] = []
    let bytes = 0
    for (let i = 0; i <= steps; i++) {
      out.push({ atMs: i * stepMs, bytes })
      bytes += bytesPerStep
    }
    return out
  }

  const cfg = (over: Partial<Parameters<typeof shouldFallbackSlow>[1]> = {}) => ({
    path: 'stun', minBps: MIN, graceMs: GRACE, windowMs: WINDOW, ...over,
  })

  it('path==="lan" 永不回退（同网千兆不受限）', () => {
    // 慢到极点(1KB/s)但同网 → 不判。
    const samples = ramp(1024, 1_000, 12) // 12s, 1KB/s
    expect(shouldFallbackSlow(samples, cfg({ path: 'lan' }))).toBe(false)
  })

  it('minBps===0 禁用看门狗（永远坚持 P2P）', () => {
    const samples = ramp(1024, 1_000, 12)
    expect(shouldFallbackSlow(samples, cfg({ minBps: 0 }))).toBe(false)
  })

  it('快速直连不回退（远超阈值）', () => {
    // 1MB/s，远超 200KB/s，跑满宽限+窗口也不判。
    const samples = ramp(1024 * 1024, 1_000, 12)
    expect(shouldFallbackSlow(samples, cfg())).toBe(false)
  })

  it('宽限期内不判（哪怕很慢也放行让它 ramp）', () => {
    // 只有前 2s 的慢速样本(<graceMs) → 还在宽限期，不回退。
    const samples = ramp(1024, 1_000, 2) // 0..2s
    expect(samples[samples.length - 1].atMs - samples[0].atMs).toBeLessThan(GRACE)
    expect(shouldFallbackSlow(samples, cfg())).toBe(false)
  })

  it('还没攒够一个完整窗口不判', () => {
    // 已过宽限(4s>3s)但总时长 4s < windowMs(5s) → 无完整窗口，不判。
    const samples = ramp(1024, 1_000, 4) // 0..4s
    expect(shouldFallbackSlow(samples, cfg())).toBe(false)
  })

  it('慢速超过窗口 → 触发回退（跨网被限速场景）', () => {
    // 48 KB/s 持续 12s（远低于 200KB/s，且跨过宽限+满一个窗口）→ 回退。
    const samples = ramp(48 * 1024, 1_000, 12)
    expect(shouldFallbackSlow(samples, cfg())).toBe(true)
  })

  it('刚好压线不回退，略低于阈值回退（窗口平均边界）', () => {
    // 恰好 200KB/s → 不小于阈值，不回退。
    expect(shouldFallbackSlow(ramp(200 * 1024, 1_000, 12), cfg())).toBe(false)
    // 199KB/s → 略低于阈值，回退。
    expect(shouldFallbackSlow(ramp(199 * 1024, 1_000, 12), cfg())).toBe(true)
  })

  it('先慢后快：只看末尾滚动窗口，近端已提速则不回退', () => {
    // 前段慢(48KB/s 4s)，随后提速到 1MB/s；末尾窗口平均已达标 → 不回退。
    const samples: ByteSample[] = []
    let bytes = 0
    for (let i = 0; i <= 4; i++) { samples.push({ atMs: i * 1000, bytes }); bytes += 48 * 1024 }
    for (let i = 5; i <= 12; i++) { samples.push({ atMs: i * 1000, bytes }); bytes += 1024 * 1024 }
    expect(shouldFallbackSlow(samples, cfg())).toBe(false)
  })

  it('样本不足两点不判', () => {
    expect(shouldFallbackSlow([], cfg())).toBe(false)
    expect(shouldFallbackSlow([{ atMs: 0, bytes: 0 }], cfg())).toBe(false)
  })
})
