// 分栏契约是纯算术，值得单独锁死：Canvas ≥560、Dock ≥480，谁也不能把对方挤破。
// 这几条断言直接对应 14 设计 §11 验收清单里的前两行。
import { describe, it, expect } from 'vitest'
import {
  dockBounds, defaultDockWidth, canSplit, resolveMode, dragMaxWidth, shouldFocusAt,
  canvasFitsWith, effectiveDockWidth, inspectorBounds,
  CANVAS_MIN, DOCK_MIN, DOCK_MAX, SPLIT_RAIL, NAV_WIDTH, NAV_RAIL, OVERLAY_DOCK,
  INSPECTOR_MIN, INSPECTOR_DEFAULT, INSPECTOR_MAX,
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

  it('880 是「默认给多宽」，不是「最多能拖多宽」', () => {
    // 默认值封顶 880，不让终端一开就无限长胖
    expect(defaultDockWidth(2560, workspace(2560))).toBe(DOCK_MAX)
    expect(defaultDockWidth(3840, workspace(3840))).toBe(DOCK_MAX)
    // 但拖拽/恢复的上界只受 Canvas 最小宽约束——用户显式拖到 1200 就该是 1200。
    // 之前这里也压 880，导致 1440 屏上「往左拖」拖到 648 就顶死不动。
    expect(dockBounds(workspace(3840)).max).toBeGreaterThan(DOCK_MAX)
    expect(dockBounds(workspace(3840)).max).toBe(workspace(3840) - SPLIT_RAIL - CANVAS_MIN)
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

describe('拖过头落进 Focus（1440 屏上只能拖 43px 的病根）', () => {
  it('拖拽上界是 Canvas 归零处，不是 splitMax', () => {
    const w = workspace(1440)                       // 1440 - 224 = 1216
    expect(dockBounds(w).max).toBe(1216 - SPLIT_RAIL - CANVAS_MIN)   // 648：能并排的最宽
    expect(dragMaxWidth(w)).toBe(1216 - SPLIT_RAIL)                  // 1208：能拖到的最远
  })

  it('松手时 Canvas 不足 560 就该藏页面，而不是留一条废条', () => {
    const w = workspace(1440)
    expect(shouldFocusAt(w, 648)).toBe(false)   // 正好 560，还能并排
    expect(shouldFocusAt(w, 649)).toBe(true)    // 差一像素就该整页藏起来
    expect(shouldFocusAt(w, 1208)).toBe(true)
  })
})

describe('四态判定', () => {
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

  it('覆盖式面板 480，与 Dock 下界同宽', () => {
    // 这一档 Canvas 最窄是 905-64=841，扣掉 480 还剩 361 的可见页面 —— 遮罩下仍看得见上下文
    expect(OVERLAY_DOCK).toBe(DOCK_MIN)
    expect(905 - NAV_RAIL - OVERLAY_DOCK).toBeGreaterThan(0)
  })
})


// Inspector（Git / Worktree 列）的让位次序，见 14-desktop-workspace/panels-desktop.html。
// 规则是两步：**先从 Dock 借宽，借不够再让 Canvas**。初版写死「让页面不让终端」，
// 实测 1920 上页面照样整个消失——因为默认 Dock 是 42vw，拿它去判永远凑不齐三列。
describe('Inspector 让位次序', () => {
  const ins = INSPECTOR_DEFAULT

  it('宽屏：从 Dock 借宽，三列都在，页面保住 560', () => {
    const w = workspace(1920) // 1696
    expect(canvasFitsWith({ workspaceWidth: w, inspectorWidth: ins, hasDock: true })).toBe(true)
    const dock = effectiveDockWidth({
      workspaceWidth: w, dockWidth: defaultDockWidth(1920, w), inspectorWidth: ins, inspectorOpen: true,
    })
    expect(dock).toBeGreaterThanOrEqual(DOCK_MIN)
    expect(w - dock - SPLIT_RAIL * 2 - ins).toBeGreaterThanOrEqual(CANVAS_MIN)
  })

  it('1440：借不够，Canvas 让位，终端长满它腾出来的宽度', () => {
    const w = workspace(1440) // 1216
    expect(canvasFitsWith({ workspaceWidth: w, inspectorWidth: ins, hasDock: true })).toBe(false)
    const mine = defaultDockWidth(1440, w)
    const dock = effectiveDockWidth({ workspaceWidth: w, dockWidth: mine, inspectorWidth: ins, inspectorOpen: true })
    expect(dock).toBeGreaterThan(mine)                  // 守着原宽 = 右边留一条黑边
    expect(dock + SPLIT_RAIL * 2 + ins).toBe(w)         // 正好铺满
  })

  it('借宽绝不越过用户拖出来的宽度，也绝不低于 480', () => {
    for (const viewport of [1280, 1440, 1680, 1920, 2560]) {
      const w = workspace(viewport)
      for (const mine of [DOCK_MIN, 600, 880]) {
        const got = effectiveDockWidth({ workspaceWidth: w, dockWidth: mine, inspectorWidth: ins, inspectorOpen: true })
        // 「不越过原宽」是**借宽**这一步的约束（第 1 步，Canvas 还在）。Canvas 让掉之后
        // 走的是第 2 步「长满」，那里越过原宽正是要的结果。
        if (canvasFitsWith({ workspaceWidth: w, inspectorWidth: ins, hasDock: true })) {
          expect(got).toBeLessThanOrEqual(mine)
        }
        expect(got).toBeGreaterThanOrEqual(DOCK_MIN)
      }
    }
  })

  it('没开 Inspector 时 Dock 宽度原样返回', () => {
    expect(effectiveDockWidth({ workspaceWidth: 1216, dockWidth: 605, inspectorWidth: ins, inspectorOpen: false }))
      .toBe(605)
  })

  it('Inspector 区间：下界 360、上界按终端让到 480 之后的余量算', () => {
    for (const viewport of [1280, 1440, 1920]) {
      const w = workspace(viewport)
      const b = inspectorBounds({ workspaceWidth: w, hasDock: true })
      expect(b.min).toBe(INSPECTOR_MIN)
      expect(b.max).toBeLessThanOrEqual(INSPECTOR_MAX)
      expect(b.max).toBeGreaterThanOrEqual(INSPECTOR_MIN)
      // 上界拿满时终端刚好停在自己的下限，且不撑破工作区
      const dock = effectiveDockWidth({ workspaceWidth: w, dockWidth: dockBounds(w).max, inspectorWidth: b.max, inspectorOpen: true })
      expect(dock).toBeGreaterThanOrEqual(DOCK_MIN)
      expect(dock + SPLIT_RAIL * 2 + b.max).toBeLessThanOrEqual(w)
    }
  })

  // 抽屉两层加起来能到一千出头（Git 的「改动列表 ｜ diff」、文件的「树 ｜ 预览」）。
  // 终端一寸不让的话那个宽度永远只是愿望：上界把它钳回剩余空间，diff 永远挤在四五百里。
  it('抽屉要得比剩余空间多时，终端让位——让到 480 为止，且不溢出', () => {
    const w = workspace(1600, false) // 1536：会话页导航是收起的轨
    const mine = dockBounds(w).max   // 用户把终端拖到了最宽
    const want = 945                 // Git：列表 320 + 5 + diff 620

    expect(inspectorBounds({ workspaceWidth: w, hasDock: true }).max).toBeGreaterThanOrEqual(want)
    const dock = effectiveDockWidth({ workspaceWidth: w, dockWidth: mine, inspectorWidth: want, inspectorOpen: true })
    expect(dock).toBeLessThan(mine)                       // 终端确实退了
    expect(dock).toBeGreaterThanOrEqual(DOCK_MIN)         // 但不退过下限
    expect(dock + SPLIT_RAIL * 2 + want).toBeLessThanOrEqual(w)
  })

  it('Canvas 保得住时终端一寸不动——借宽只在真不够的时候发生', () => {
    const w = workspace(1600, false) // 1552
    const mine = 500
    expect(canvasFitsWith({ workspaceWidth: w, inspectorWidth: ins, hasDock: true })).toBe(true)
    const dock = effectiveDockWidth({ workspaceWidth: w, dockWidth: mine, inspectorWidth: ins, inspectorOpen: true })
    expect(dock).toBe(mine)
  })

  // 这次的 bug：Canvas 让掉之后那条宽度谁都没接，右边空出一道黑边（1366 笔记本上 192px）。
  // 三列几何的硬契约是**既不溢出、也不留白**——溢出招来 10px 文档滚动条，留白就是那张截图。
  it('Canvas 让位之后，Dock + Inspector 正好铺满工作区', () => {
    for (const viewport of [1280, 1366, 1440, 1600, 1920]) {
      for (const navExpanded of [true, false]) {
        const w = workspace(viewport, navExpanded)
        const cap = inspectorBounds({ workspaceWidth: w, hasDock: true }).max
        for (const want of [INSPECTOR_MIN, INSPECTOR_DEFAULT, 552, 945]) {
          const insW = Math.min(want, cap)
          if (canvasFitsWith({ workspaceWidth: w, inspectorWidth: insW, hasDock: true })) continue
          const dock = effectiveDockWidth({ workspaceWidth: w, dockWidth: DOCK_MIN, inspectorWidth: insW, inspectorOpen: true })
          expect(dock + SPLIT_RAIL * 2 + insW).toBe(w)
        }
      }
    }
  })
})
