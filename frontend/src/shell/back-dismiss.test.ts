// 返回键栈的行为契约（13 §4.3）。这里只测纯栈逻辑：history 用注入的假函数，
// 断言的是「谁被关掉了、发了几次 back」，不依赖 jsdom 的 history 实现。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { pushFrame, retireFrame, handlePop, handleHashChange, stackSize, resetStack } from './useBackDismiss'

describe('back-dismiss stack', () => {
  beforeEach(() => resetStack())

  const flush = () => new Promise<void>((r) => queueMicrotask(() => r()))

  it('UI 关闭会退掉自己压的那条记录，且迟到的 popstate 不再回调', async () => {
    const back = vi.fn()
    const dismiss = vi.fn()
    const id = pushFrame(dismiss, () => {})
    expect(stackSize()).toBe(1)

    retireFrame(id, back)
    expect(stackSize()).toBe(0)
    await flush()
    expect(back).toHaveBeenCalledTimes(1) // ← 漏了这一次就会留下死记录

    expect(handlePop()).toBeNull() // 自己发的 back 回来了，吞掉
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('返回键关闭：一次 popstate 只退一帧', () => {
    const a = vi.fn(); const b = vi.fn()
    pushFrame(a, () => {})
    pushFrame(b, () => {})

    handlePop()
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).not.toHaveBeenCalled()
    expect(stackSize()).toBe(1)

    handlePop()
    expect(a).toHaveBeenCalledTimes(1)
    expect(stackSize()).toBe(0)
  })

  it('被返回键关掉之后，组件卸载时的 retire 不再发 back', async () => {
    const back = vi.fn()
    const id = pushFrame(vi.fn(), () => {})
    handlePop()            // 用户按了返回
    retireFrame(id, back)  // 组件随后卸载
    await flush()
    expect(back).not.toHaveBeenCalled()
  })

  // StrictMode 开发态：mount → unmount → mount，退帧的 back() 还在路上时新帧已压好。
  // 按帧标记会把那条迟到的 popstate 当成用户返回，表现为「面板一打开就自己关了」。
  it('StrictMode 双挂载：同步 remount 复用记录，一次 history 都不发', async () => {
    const push = vi.fn(); const back = vi.fn()
    const id1 = pushFrame(vi.fn(), push)
    retireFrame(id1, back)         // 清理
    pushFrame(vi.fn(), push)       // 同一 tick 内重新挂载
    await flush()
    expect(push).toHaveBeenCalledTimes(1) // 第二次 push 复用了第一条记录
    expect(back).not.toHaveBeenCalled()   // 那条记录没被退掉，自然也不用补回来
    expect(stackSize()).toBe(1)
  })

  it('迟到的 popstate 不会关掉新帧', async () => {
    const second = vi.fn()
    const id1 = pushFrame(vi.fn(), () => {})
    retireFrame(id1, () => {})
    await flush()                  // back 真的发出去了
    pushFrame(second, () => {})    // 之后才重新挂载
    handlePop()                    // 第一次 back 的 popstate 迟到
    expect(second).not.toHaveBeenCalled()
    expect(stackSize()).toBe(1)
  })

  it('路由变了：所有存活帧一起关掉，且不动 history', () => {
    const a = vi.fn(); const b = vi.fn()
    pushFrame(a, () => {})
    pushFrame(b, () => {})
    handleHashChange()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(stackSize()).toBe(0)
  })

  it('关闭中间层：只摘帧，不动 history（back 会退掉别人的记录）', async () => {
    const back = vi.fn()
    const id1 = pushFrame(vi.fn(), () => {})
    pushFrame(vi.fn(), () => {})
    retireFrame(id1, back)
    await flush()
    expect(back).not.toHaveBeenCalled()
    expect(stackSize()).toBe(1)
  })
})
