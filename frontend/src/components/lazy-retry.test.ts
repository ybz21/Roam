// @vitest-environment jsdom
// 懒加载重试。这条护栏来自线上实测：中心日志里 217 次 `unknown certificate`，
// 其中用户那台机器**同一秒被拒 6 次**——自签证书下 Chrome 的「继续前往」只对已建立的连接
// 放行，而懒加载会为并行取 chunk 开新连接。于是「时好时坏」，点重试又往往就好了。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { lazyRetry } from './lazy-retry'

// React.lazy 只在渲染时才调 loader，这里直接把它交给 lazy 的那个函数拎出来跑：
// _payload._result 是 React 内部存 loader 的地方（版本相关，拿不到就跳过断言）。
function loaderOf(comp: any): (() => Promise<any>) | null {
  const p = comp?._payload
  return typeof p?._result === 'function' ? p._result : null
}

describe('懒加载重试', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('第一次握手失败、第二次成功 → 救回来，调用方无感', async () => {
    let n = 0
    const load = vi.fn(async () => {
      if (++n === 1) throw new Error('Failed to fetch dynamically imported module')
      return { default: (() => null) as any }
    })
    const loader = loaderOf(lazyRetry(load))
    expect(loader).toBeTruthy()
    const p = loader!()
    await vi.advanceTimersByTimeAsync(300)
    await expect(p).resolves.toHaveProperty('default')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('一直失败 → 最终抛出去给 ErrorBoundary，不是无限重试', async () => {
    const load = vi.fn(async () => { throw new Error('chunk 404') })
    const loader = loaderOf(lazyRetry(load))
    const p = loader!().catch((e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(2000)
    await expect(p).resolves.toBe('chunk 404')
    expect(load).toHaveBeenCalledTimes(3) // 首次 + 两次退避重试
  })

  it('一次就成的不会多调一次', async () => {
    const load = vi.fn(async () => ({ default: (() => null) as any }))
    const loader = loaderOf(lazyRetry(load))
    await loader!()
    expect(load).toHaveBeenCalledTimes(1)
  })
})
