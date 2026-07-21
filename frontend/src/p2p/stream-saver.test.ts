import { describe, it, expect } from 'vitest'
import { CreditController } from './stream-saver'
import { resetSinkForFallback, type RewindableSink } from './download-proto'

describe('CreditController (P1-4: StreamSaver 消费信用背压)', () => {
  it('acquire resolves immediately while credit is available', async () => {
    const c = new CreditController()
    c.grant(2)
    expect(c.available).toBe(2)
    await c.acquire()
    await c.acquire()
    expect(c.available).toBe(0)
  })

  it('acquire blocks when out of credit, then unblocks on grant (真背压)', async () => {
    const c = new CreditController()
    let unblocked = false
    const p = c.acquire().then(() => { unblocked = true })
    // 无信用 → 挂起。
    await Promise.resolve()
    expect(unblocked).toBe(false)
    expect(c.pending).toBe(1)
    // SW 回一个信用 → 放行。
    c.grant(1)
    await p
    expect(unblocked).toBe(true)
    expect(c.pending).toBe(0)
  })

  it('a single grant unblocks exactly one waiter (信用逐块发放)', async () => {
    const c = new CreditController()
    const flags = [false, false, false]
    const ps = flags.map((_, i) => c.acquire().then(() => { flags[i] = true }))
    await Promise.resolve()
    expect(flags).toEqual([false, false, false])
    c.grant(1)
    await ps[0]
    expect(flags).toEqual([true, false, false]) // 只放行一个
    c.grant(2)
    await Promise.all(ps)
    expect(flags).toEqual([true, true, true])
  })

  it('release drains all waiters (取消/关闭不永久挂起)', async () => {
    const c = new CreditController()
    let a = false
    let b = false
    const pa = c.acquire().then(() => { a = true })
    const pb = c.acquire().then(() => { b = true })
    c.release()
    await Promise.all([pa, pb])
    expect(a && b).toBe(true)
  })

  it('after release, further acquire is a no-op (不再堆积)', async () => {
    const c = new CreditController()
    c.release()
    await c.acquire() // resolves immediately, no throw
    expect(c.pending).toBe(0)
  })
})

// 可倒带 mock sink：模拟 picker 的 FileSystemWritableFileStream —— 有 cursor/truncate/seek。
class MockRewindableSink implements RewindableSink {
  buf: number[] = []
  private cursor = 0
  async write(chunk: number[]): Promise<void> {
    for (let i = 0; i < chunk.length; i++) this.buf[this.cursor + i] = chunk[i]
    this.cursor += chunk.length
  }
  async truncate(size: number): Promise<void> { this.buf.length = size }
  async seek(offset: number): Promise<void> { this.cursor = offset }
}

describe('resetSinkForFallback (P0-1: 回退前复位，绝不 P2P 前缀 + HTTP 全量)', () => {
  it('truncate(0)+seek(0) wipes the P2P prefix so HTTP writes from the top', async () => {
    const sink = new MockRewindableSink()
    // P2P 已写了部分前缀。
    await sink.write([0xaa, 0xbb, 0xcc])
    expect(sink.buf).toEqual([0xaa, 0xbb, 0xcc])

    // 回退：复位 sink。
    await resetSinkForFallback(sink)
    expect(sink.buf).toEqual([]) // 前缀已清

    // HTTP 全量从头写入。
    await sink.write([1, 2, 3, 4])
    expect(sink.buf).toEqual([1, 2, 3, 4]) // 只有 HTTP 全量，无 [P2P前缀]+[HTTP] 拼接
  })

  it('without reset the file would be corrupted (对照：证明复位必要)', async () => {
    const sink = new MockRewindableSink()
    await sink.write([0xaa, 0xbb, 0xcc]) // P2P 前缀
    // 不复位就接 HTTP 全量（旧 bug 行为）→ 损坏。
    await sink.write([1, 2, 3, 4])
    expect(sink.buf).toEqual([0xaa, 0xbb, 0xcc, 1, 2, 3, 4]) // 前缀 + 全量 = 坏文件
    expect(sink.buf).not.toEqual([1, 2, 3, 4])
  })
})
