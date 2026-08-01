// layout.ts 是全站唯一的断点入口——档位判错，四档形态全错。这里锁住三件事：
// ① 四档边界（600 / 905 / 1280）；② 软键盘噪声地板；③ 写到 <html> 上的 data-*。
//
// 不用 jsdom：只需要 matchMedia / visualViewport / documentElement 三个东西，
// 手搓桩比拉整套 DOM 更能说清依赖面。桩必须在 import 之前装好——
// layout.ts 模块初始化时就会读一次。
import { describe, it, expect, beforeEach, vi } from 'vitest'

type Stub = { width: number; height: number; vvHeight: number; coarse: boolean }
const env: Stub = { width: 1440, height: 900, vvHeight: 900, coarse: false }

function parseMinWidth(query: string): number | null {
  const m = /min-width:\s*(\d+)px/.exec(query)
  return m ? Number(m[1]) : null
}

function evaluate(query: string): boolean {
  const min = parseMinWidth(query)
  if (min !== null) return env.width >= min
  if (query.includes('pointer: coarse')) return env.coarse
  if (query.includes('max-height')) {
    const m = /max-height:\s*(\d+)px/.exec(query)
    return !!m && env.height <= Number(m[1]) && env.width > env.height
  }
  return false
}

const root = { dataset: {} as Record<string, string>, style: { setProperty: vi.fn() } }

;(globalThis as any).window = {
  matchMedia: (query: string) => ({
    matches: evaluate(query),
    addEventListener: () => {},
    addListener: () => {},
  }),
  addEventListener: () => {},
  get innerHeight() { return env.height },
  get visualViewport() { return { height: env.vvHeight, offsetTop: 0, addEventListener: () => {} } },
}
;(globalThis as any).document = { documentElement: root }
// node 的 globalThis.navigator 是只读 getter，覆盖要走 defineProperty
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true })

const { BREAKPOINTS, SPLIT_MIN_WIDTH } = await import('./layout')

// getLayout 走的是模块内缓存的 state，缓存只在事件里刷新；测试直接重新求值，
// 所以每个用例改完 env 后重新 import 一份干净的模块。
async function layoutAt(width: number, extra: Partial<Stub> = {}) {
  Object.assign(env, { width, height: 900, vvHeight: 900, coarse: false }, extra)
  vi.resetModules()
  const mod = await import('./layout')
  return mod.getLayout()
}

describe('useLayout 的四档判定', () => {
  beforeEach(() => { root.dataset = {} as Record<string, string> })

  it('按 600 / 905 / 1280 分四档', async () => {
    expect((await layoutAt(360)).size).toBe('compact')
    expect((await layoutAt(599)).size).toBe('compact')
    expect((await layoutAt(600)).size).toBe('medium')
    expect((await layoutAt(904)).size).toBe('medium')
    expect((await layoutAt(905)).size).toBe('expanded')
    expect((await layoutAt(1279)).size).toBe('expanded')
    expect((await layoutAt(1280)).size).toBe('large')
    expect((await layoutAt(1920)).size).toBe('large')
  })

  it('phone / desktop 是四档的二分，不是 768 那条老线', async () => {
    // 768 曾经算"桌面"，正是三栏在 iPad 竖屏溢出的根因（13 设计 §1.3）
    const ipadPortrait = await layoutAt(768)
    expect(ipadPortrait.phone).toBe(true)
    expect(ipadPortrait.desktop).toBe(false)

    const ipadLandscape = await layoutAt(1024)
    expect(ipadLandscape.phone).toBe(false)
    expect(ipadLandscape.desktop).toBe(true)
  })

  it('常驻分栏下界与 large 下界是同一个数', () => {
    expect(SPLIT_MIN_WIDTH).toBe(BREAKPOINTS.large)
    // 14 §4.2：Canvas 560 + rail 8 + Dock 480 + 侧栏 224 = 1272，落在 1280 之内
    expect(560 + 8 + 480 + 224).toBeLessThanOrEqual(SPLIT_MIN_WIDTH)
  })

  it('手机横屏按姿态判定，不按宽度', async () => {
    expect((await layoutAt(844, { height: 390 })).landscape).toBe(true)
    expect((await layoutAt(390, { height: 844 })).landscape).toBe(false)
  })

  it('粗指针与档位无关：1024 的平板也可以是 coarse', async () => {
    expect((await layoutAt(1024, { coarse: true })).coarse).toBe(true)
    expect((await layoutAt(1024, { coarse: true })).size).toBe('expanded')
  })
})

describe('软键盘高度', () => {
  it('30px 以内当作地址栏抖动，不算键盘', async () => {
    expect((await layoutAt(390, { height: 844, vvHeight: 820 })).keyboard).toBe(0)
  })

  it('真键盘弹起时给出高度', async () => {
    expect((await layoutAt(390, { height: 844, vvHeight: 544 })).keyboard).toBe(300)
  })
})

describe('写到 <html> 上的钩子', () => {
  it('data-size / data-pointer / --kb 三样都写', async () => {
    Object.assign(env, { width: 390, height: 844, vvHeight: 544, coarse: true })
    vi.resetModules()
    const mod = await import('./layout')
    mod.getLayout()
    expect(root.dataset.size).toBe('compact')
    expect(root.dataset.pointer).toBe('coarse')
    expect(root.style.setProperty).toHaveBeenCalledWith('--kb', '300px')
  })

  it('密度是另一个属性，不与 data-size 共用', async () => {
    // 「大屏 + 紧凑密度」是合法组合：档位是环境，密度是偏好（13 §13.4）
    Object.assign(env, { width: 1440, height: 900, vvHeight: 900, coarse: false })
    vi.resetModules()
    const mod = await import('./layout')
    mod.getLayout()
    mod.applyDensity('compact')
    expect(root.dataset.size).toBe('large')
    expect(root.dataset.density).toBe('compact')
  })
})
