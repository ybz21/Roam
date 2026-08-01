// 分栏契约是纯算术，值得单独锁死：Canvas ≥560、Dock ≥480，谁也不能把对方挤破。
// 这几条断言直接对应 14 设计 §11 验收清单里的前两行。
import { describe, it, expect } from 'vitest'
import {
  dockBounds, defaultDockWidth, canSplit,
  CANVAS_MIN, DOCK_MIN, DOCK_MAX, SPLIT_RAIL, NAV_WIDTH, NAV_RAIL,
} from './useWorkspaceLayout'

/** 工作区宽 = 视口 - 导航（导航展开与否影响很大，1280 档尤其） */
const workspace = (viewport: number, navExpanded = true) => viewport - (navExpanded ? NAV_WIDTH : NAV_RAIL)

describe('Dock 宽度钳制', () => {
  it('上界永远给 Canvas 留够 560', () => {
    for (const viewport of [1280, 1366, 1440, 1600, 1920, 2560]) {
      for (const navExpanded of [true, false]) {
        const w = workspace(viewport, navExpanded)
        const { max } = dockBounds(w)
        expect(w - SPLIT_RAIL - max).toBeGreaterThanOrEqual(CANVAS_MIN)
      }
    }
  })

  it('1280 展开侧栏时，42vw 的默认值会被压回去', () => {
    // 42vw = 538，但 1280-224-8-538 = 510 < 560 —— 不钳就横向溢出
    const w = workspace(1280)
    expect(Math.round(1280 * 0.42)).toBe(538)
    const dock = defaultDockWidth(1280, w)
    expect(dock).toBeLessThan(538)
    expect(w - SPLIT_RAIL - dock).toBeGreaterThanOrEqual(CANVAS_MIN)
  })

  it('1280 收起侧栏后，默认 42vw 放得下', () => {
    const w = workspace(1280, false)
    expect(defaultDockWidth(1280, w)).toBe(538)
    expect(w - SPLIT_RAIL - 538).toBeGreaterThanOrEqual(CANVAS_MIN)
  })

  it('大屏封顶 880，不让终端无限长胖', () => {
    expect(defaultDockWidth(2560, workspace(2560))).toBe(DOCK_MAX)
    expect(dockBounds(workspace(3840)).max).toBe(DOCK_MAX)
  })

  it('下界始终是 480，哪怕算出来的余量更小', () => {
    // 极端窄的工作区：max 会被 min 顶住，而不是给出一个比 480 还小的上界
    const { min, max } = dockBounds(600)
    expect(min).toBe(DOCK_MIN)
    expect(max).toBe(DOCK_MIN)
  })
})

describe('并排是否成立', () => {
  it('1048 是不含导航的临界值', () => {
    expect(CANVAS_MIN + SPLIT_RAIL + DOCK_MIN).toBe(1048)
    expect(canSplit(1047)).toBe(false)
    expect(canSplit(1048)).toBe(true)
  })

  it('1280 + 展开侧栏刚好成立（1272 ≤ 1280）', () => {
    expect(canSplit(workspace(1280))).toBe(true)
    expect(NAV_WIDTH + CANVAS_MIN + SPLIT_RAIL + DOCK_MIN).toBe(1272)
  })

  it('expanded 档即使收起导航也不并排——这是设计决定，不是算不出来', () => {
    // 1279 收起导航后 1215 ≥ 1048，几何上放得下，但挤出来的 Canvas 只有 727，
    // 正是 14 §2.2 要消灭的「页面被压成预览条」。所以这一档走覆盖式（13 §13.1）。
    expect(canSplit(workspace(1279, false))).toBe(true)
    const canvas = workspace(1279, false) - SPLIT_RAIL - DOCK_MIN
    expect(canvas).toBeLessThan(CANVAS_MIN + 200)
  })
})
