// 超时预算的账要算在插件头上，不能算在「上面刚渲染完」头上。
// 这条正是六格主机监控经常整体消失的原因（budgetedAbort 的注释里有真机数据）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { budgetedAbort } from './status-poll'

/** 主线程被占住 ms 毫秒：钟往前走了，可挂着的定时器一个都没轮到执行 */
function block(ms: number) {
  vi.setSystemTime(Date.now() + ms)
}

describe('一次调用的超时预算', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('线程没卡的时候，到点就掐', () => {
    const { signal } = budgetedAbort(3000)
    vi.advanceTimersByTime(2999)
    expect(signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(signal.aborted).toBe(true)
  })

  it('主线程被占住的那段不算数：卡完重新给一整段预算', () => {
    const { signal } = budgetedAbort(3000)
    block(5000)          // 编辑器/终端重渲染，5 秒里定时器一次都没跑
    vi.advanceTimersByTime(3000) // 到点的定时器这才轮到 —— 晚了 5 秒
    expect(signal.aborted).toBe(false)
    vi.advanceTimersByTime(2999)
    expect(signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(signal.aborted).toBe(true)
  })

  it('顺延有上限：插件真挂住了，不能靠页面一直卡着续命', () => {
    const { signal } = budgetedAbort(1000)
    for (let i = 0; i < 6; i++) {
      block(5000)
      vi.advanceTimersByTime(1000)
    }
    expect(signal.aborted).toBe(true)
  })

  it('clear 之后不再掐 —— 请求已经正常回来了', () => {
    const { signal, clear } = budgetedAbort(1000)
    clear()
    vi.advanceTimersByTime(10_000)
    expect(signal.aborted).toBe(false)
  })
})
