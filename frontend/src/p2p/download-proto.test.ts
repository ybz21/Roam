import { describe, it, expect } from 'vitest'
import {
  parseDataFrame,
  SeqValidator,
  validateFinalSize,
  WriteChain,
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
