// 工作区几何的纯算术（useWorkspaceLayout.ts）：三态判定与右栏让位。
// 14 稿的 split 并排（Dock 宽度钳制、拖过头落 Focus）已按 22 D1 作废，那些测试随之删了。
import { describe, expect, it } from 'vitest'
import {
  CANVAS_MIN, RAIL, NAV_WIDTH, NAV_RAIL, OVERLAY_DOCK, INSPECTOR_MIN, INSPECTOR_MAX,
  canvasFitsWith, inspectorBounds, resolveMode,
} from './useWorkspaceLayout'

const workspace = (viewport: number, navExpanded = true) => viewport - (navExpanded ? NAV_WIDTH : NAV_RAIL)

describe('三态判定', () => {
  const at = (size: 'medium' | 'expanded' | 'large', o: Partial<Parameters<typeof resolveMode>[0]> = {}) =>
    resolveMode({
      hasTerms: true, dockOpen: true, focus: 'none', size,
      workspaceWidth: size === 'large' ? workspace(1440) : workspace(1024, false),
      ...o,
    })

  it('没有终端、或 Dock 收起，一律是 Page', () => {
    expect(at('large', { hasTerms: false })).toBe('page')
    expect(at('large', { dockOpen: false })).toBe('page')
    expect(at('expanded', { dockOpen: false })).toBe('page')
  })

  it('large 档页面态永远是整块页面，不并排（22 设计 D1）；expanded 仍是覆盖', () => {
    expect(at('large')).toBe('page')
    expect(at('large', { focus: 'dock' })).toBe('page')
    expect(at('large', { workspaceWidth: 1047 })).toBe('page')
    expect(at('expanded')).toBe('overlay')
  })

  it('任务视图直接落 focus：中间整块给标签工作区，不看终端有没有、Dock 开没开', () => {
    expect(at('large', { taskView: true })).toBe('focus')
    expect(at('large', { taskView: true, hasTerms: false, dockOpen: false })).toBe('focus')
  })

  it('expanded 档 Focus 是用户显式要的，优先于覆盖', () => {
    expect(at('expanded', { focus: 'dock' })).toBe('focus')
  })

  it('覆盖式面板 480：这一档 Canvas 最窄 905-48，扣掉面板仍看得见上下文', () => {
    expect(905 - NAV_RAIL - OVERLAY_DOCK).toBeGreaterThan(0)
  })
})

describe('右栏让位', () => {
  it('区间：下界 280、上界不超过 1200 也不撑破工作区', () => {
    for (const viewport of [1280, 1440, 1920, 2560]) {
      const b = inspectorBounds({ workspaceWidth: workspace(viewport) })
      expect(b.min).toBe(INSPECTOR_MIN)
      expect(b.max).toBeLessThanOrEqual(INSPECTOR_MAX)
      expect(b.max + RAIL).toBeLessThanOrEqual(workspace(viewport))
    }
  })

  it('右栏拖到页面不足 560 就整页让位，而不是留一条废条', () => {
    const w = workspace(1440) // 1160
    expect(canvasFitsWith({ workspaceWidth: w, inspectorWidth: 350 })).toBe(true)
    expect(canvasFitsWith({ workspaceWidth: w, inspectorWidth: w - RAIL - CANVAS_MIN })).toBe(true)
    expect(canvasFitsWith({ workspaceWidth: w, inspectorWidth: w - RAIL - CANVAS_MIN + 1 })).toBe(false)
  })
})
