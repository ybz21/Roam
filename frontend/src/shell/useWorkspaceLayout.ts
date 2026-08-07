// 工作区空间状态：Page / Split / Focus 三态与 Dock 宽度（14 设计 §4.1–§4.3）。
//
// 这里只有尺寸与状态，不含任何 JSX——分栏契约是纯算术，值得单独测。
//
// 旧实现的问题是**主次颠倒**：页宽按页面类型写死（files 520–900 / sessions 420 /
// 其余 300），终端 `minWidth: 480` 拿走剩余全部。用户从项目页开个终端，项目上下文
// 就被压成 300px。新契约反过来：Canvas 最小 560、Dock 最小 480，谁也不能把对方
// 挤破；空间不够就整体切 Focus，绝不横向溢出。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLayout, type WindowSize } from '../layout'
import { usePreferences, preferencesLoaded, saveWorkspace } from '../preferences'
import { useInspectorOpen, useInspectorWantWidth } from './inspector'

/** 尺寸契约，与 index.css 的 --canvas-min / --dock-* 同源（14 §8.2）。 */
export const CANVAS_MIN = 560
export const DOCK_MIN = 480
export const DOCK_MAX = 880
export const SPLIT_RAIL = 8
export const NAV_WIDTH = 224
export const NAV_RAIL = 64
/** expanded 档覆盖式终端面板的宽度（13 §13.1）。 */
export const OVERLAY_DOCK = 480

/** Inspector（Git / Worktree 列）的尺寸契约，见 14-desktop-workspace/panels-desktop.html */
export const INSPECTOR_MIN = 360
export const INSPECTOR_DEFAULT = 420
export const INSPECTOR_MAX = 880
/** 面板内左右分栏（列表 ｜ diff）的阈值：280 列表 + 8 + 400 diff + 32 padding */
export const INSPECTOR_SPLIT = 720

export type SpaceMode = 'page' | 'split' | 'focus' | 'overlay'
export type FocusTarget = 'none' | 'page' | 'dock'

/**
 * Dock 宽度上界：可用宽减去 Canvas 最小宽和分隔条。
 *
 * 不钳这一下就会横向溢出——1280 展开侧栏时 `42vw = 538`，Canvas 只剩 510，
 * 自己先破 560 的契约。**拖拽、双击复位、恢复偏好三条路径都必须过这个函数**，
 * 这是「不制造横向滚动」的唯一保证（14 §4.2）。
 *
 * 这里**不再压 880**：880 是"默认给多宽"（见 defaultDockWidth），不该同时充当
 * "用户最多能拖多宽"。用户显式拖到 1200，就该是 1200。
 */
export function dockBounds(workspaceWidth: number): { min: number; max: number } {
  const room = workspaceWidth - SPLIT_RAIL - CANVAS_MIN
  return { min: DOCK_MIN, max: Math.max(DOCK_MIN, room) }
}

/**
 * 拖拽能到的最远处：Canvas 归零。
 *
 * 只让拖到 `dockBounds().max` 的话，1440 屏（侧栏 224）上界就是 648——用户想把终端
 * 再拉宽一点，界面直接不动了，除非他知道还有个「终端聚焦」按钮。现在允许一路拖过去，
 * 松手时若 Canvas 已经低于 560 就落进 Focus：**页面要么 ≥560，要么干脆藏起来，
 * 不留一条 300px 的废条**——这正是 CANVAS_MIN 想守的东西，只是换成了拖拽也能表达。
 */
export function dragMaxWidth(workspaceWidth: number): number {
  return Math.max(DOCK_MIN, workspaceWidth - SPLIT_RAIL)
}

/** 松手时该不该落进 Focus：Canvas 已经不足最小宽 */
export function shouldFocusAt(workspaceWidth: number, dockWidth: number): boolean {
  return workspaceWidth - SPLIT_RAIL - dockWidth < CANVAS_MIN
}

/**
 * 该档的默认 Dock 宽度：clamp(480, 42vw, 880)，再过一次几何上界。
 *
 * **880 只在这里**：它是"默认给多宽"，不是"用户最多能拖多宽"。dockBounds 不再压它。
 */
export function defaultDockWidth(viewportWidth: number, workspaceWidth: number): number {
  const wish = Math.min(DOCK_MAX, Math.round(viewportWidth * 0.42))
  const { min, max } = dockBounds(workspaceWidth)
  return Math.max(min, Math.min(max, wish))
}

/**
 * Inspector 打开之后，Canvas 还保不保得住 560。
 *
 * 判据用 **Dock 的下限**而不是它当前的宽度：宽屏上默认 Dock 是 42vw（1920 上 806），
 * 拿当前宽度判的话三列永远凑不齐——1920 都要把页面整个让掉，而那正是买大屏要避免的。
 * 所以顺序是「**先从 Dock 借，借不够再让 Canvas**」，见 effectiveDockWidth。
 */
export function canvasFitsWith(o: {
  workspaceWidth: number; inspectorWidth: number; hasDock: boolean
}): boolean {
  const used = (o.hasDock ? DOCK_MIN + SPLIT_RAIL : 0) + o.inspectorWidth + SPLIT_RAIL
  return o.workspaceWidth - used >= CANVAS_MIN
}

/**
 * Inspector 打开时 Dock 实际渲染多宽。
 *
 * 保得住 Canvas 就从 Dock 借到刚好（不低于 480、也不超过用户拖出来的宽度）；
 * 保不住就不折腾终端——Canvas 反正要整个让掉，Dock 用回用户那个宽度。
 * 借宽会让终端 fit 一次，但「终端窄 13%」远好过「页面整个消失」。
 */
export function effectiveDockWidth(o: {
  workspaceWidth: number; dockWidth: number; inspectorWidth: number; inspectorOpen: boolean
}): number {
  if (!o.inspectorOpen) return o.dockWidth
  if (!canvasFitsWith({ workspaceWidth: o.workspaceWidth, inspectorWidth: o.inspectorWidth, hasDock: true })) {
    return o.dockWidth
  }
  const room = o.workspaceWidth - CANVAS_MIN - SPLIT_RAIL * 2 - o.inspectorWidth
  return Math.max(DOCK_MIN, Math.min(o.dockWidth, room))
}

/** Inspector 的拖拽区间：下界 360，上界不能把 Dock 挤破 */
export function inspectorBounds(o: {
  workspaceWidth: number; dockWidth: number; hasDock: boolean
}): { min: number; max: number } {
  const room = o.workspaceWidth - SPLIT_RAIL - (o.hasDock ? o.dockWidth + SPLIT_RAIL : 0)
  return { min: INSPECTOR_MIN, max: Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, room)) }
}

/** 并排是否成立：Canvas 560 + rail 8 + Dock 480（不含导航）。 */
export function canSplit(workspaceWidth: number): boolean {
  return workspaceWidth >= CANVAS_MIN + SPLIT_RAIL + DOCK_MIN
}

/**
 * 四态判定（14 §4.1 + 13 §13.1）。抽成纯函数是因为它已经不止两个分支了，
 * 而「哪一档进哪一态」正是这次最容易改错的地方。
 *
 * expanded（905–1279）走 **overlay**：这一档并排最多只能挤出 561–735 的 Canvas，
 * 正是 14 §2.2 要消灭的「页面被压成预览条」。覆盖式面板换来的是 Canvas 布局在
 * 终端开合前后完全不变——概览的项目卡不会因为开个终端就跳列。
 *
 * Focus 仍然优先于一切：它是用户显式按 ⌘⇧J 要的，不该被档位悄悄改掉。
 */
export function resolveMode(o: {
  hasTerms: boolean; dockOpen: boolean; focus: FocusTarget
  size: WindowSize; workspaceWidth: number
}): SpaceMode {
  if (!o.hasTerms || !o.dockOpen) return 'page'
  if (o.focus !== 'none') return 'focus'
  if (o.size === 'large' && canSplit(o.workspaceWidth)) return 'split'
  if (o.size === 'expanded') return 'overlay'
  return 'focus'
}

export type WorkspaceLayout = {
  /** 当前空间状态 */
  mode: SpaceMode
  /** Dock 实际宽度 px（mode !== 'split' 时无意义） */
  dockWidth: number
  /** 终端区是否可见（split 或 dock-focus 或手机全屏） */
  dockVisible: boolean
  focus: FocusTarget
  navCollapsed: boolean
  /** 这一档是否允许并排（expanded 及以下一律覆盖式，见 13 §13.1） */
  splitCapable: boolean
  /** 这一档的终端是覆盖式面板：收起时右下角留会话胶囊（13 §13.1） */
  overlayCapable: boolean
  toggleDock: () => void
  setDockOpen: (open: boolean) => void
  setDockWidth: (width: number) => void
  resetDockWidth: () => void
  setFocus: (target: FocusTarget) => void
  toggleFocus: () => void
  setNavCollapsed: (collapsed: boolean) => void
  /** 供分隔条读：当前允许拖到的区间（上界 = Canvas 归零处） */
  bounds: { min: number; max: number }
  /** 超过这个宽度就该落进 Focus（Canvas 会低于 560） */
  splitMax: number
  /** Inspector 列宽（Git / Worktree），已按当前几何钳过 */
  inspectorWidth: number
  inspectorBounds: { min: number; max: number }
  setInspectorWidth: (width: number) => void
  resetInspectorWidth: () => void
  /** Inspector 打开时 Canvas 还够不够 560——不够就让位 */
  canvasFitsInspector: boolean
  /** Dock 实际渲染宽度：Inspector 打开时可能被借走一部分 */
  dockRenderWidth: number
}

/**
 * @param hasTerms 是否有已打开的终端；没有就永远是 Page 态
 */
export function useWorkspaceLayout(hasTerms: boolean): WorkspaceLayout {
  const layout = useLayout()
  const [prefs] = usePreferences()
  const ws = prefs.workspace

  const [viewport, setViewport] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth))
  useEffect(() => {
    const on = () => setViewport(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])

  // 本地态先行、偏好后写：拖拽时每帧都写服务端偏好会打爆 PUT
  const [dockOpen, setDockOpenLocal] = useState(ws.dockOpen)
  const [focus, setFocusLocal] = useState<FocusTarget>(ws.workspaceFocus)
  const [navCollapsed, setNavCollapsedLocal] = useState(ws.navCollapsed)
  const [width, setWidthLocal] = useState(ws.dockWidth || 0)
  const [insWidth, setInsWidthLocal] = useState(ws.inspectorWidth || 0)
  const hydrated = useRef(false)

  /**
   * 偏好从服务端到达后同步一次。
   *
   * 判「到达」必须问 `preferencesLoaded()`，不能拿"effect 跑过一次"充数：偏好是
   * 异步 GET 的，mount 那一跑手里还是默认值，旧写法在那时就把 hydrated 置了位，
   * 真正带着用户宽度的那一跑被 early-return 挡掉——**拖过的分隔条存了却从没读回来**，
   * 每次刷新都弹回 42vw 默认位。
   *
   * 用户已经动过手（拖/收/聚焦）之后就不再回填：偏好 GET 与他的操作可能撞在一起，
   * 那时候盖回去等于当着面把他刚拖的位置抹掉。
   */
  useEffect(() => {
    if (hydrated.current || !preferencesLoaded()) return
    hydrated.current = true
    setDockOpenLocal(ws.dockOpen)
    setFocusLocal(ws.workspaceFocus)
    setNavCollapsedLocal(ws.navCollapsed)
    setWidthLocal(ws.dockWidth || 0)
    setInsWidthLocal(ws.inspectorWidth || 0)
  }, [ws])

  const splitCapable = layout.size === 'large'
  const navWidth = splitCapable ? (navCollapsed ? NAV_RAIL : NAV_WIDTH) : NAV_RAIL
  const workspaceWidth = Math.max(0, viewport - navWidth)
  const bounds = useMemo(() => ({ min: DOCK_MIN, max: dragMaxWidth(workspaceWidth) }), [workspaceWidth])
  const splitMax = useMemo(() => dockBounds(workspaceWidth).max, [workspaceWidth])

  // 恢复偏好时先钳制：换到小窗口不能拿旧大屏的宽度把 Canvas 挤爆（14 §9.3）
  const dockWidth = useMemo(() => {
    const wish = width || defaultDockWidth(viewport, workspaceWidth)
    const b = dockBounds(workspaceWidth)
    return Math.max(b.min, Math.min(b.max, wish))
  }, [width, viewport, workspaceWidth])

  const mode = resolveMode({ hasTerms, dockOpen, focus, size: layout.size, workspaceWidth })

  // Inspector 宽度同样先钳后用：换到窄窗口不能拿旧大屏的宽度把 Dock 挤破
  const hasDock = mode === 'split'
  const inspectorOpen = useInspectorOpen() && splitCapable
  const insBounds = useMemo(
    () => inspectorBounds({ workspaceWidth, dockWidth, hasDock }),
    [workspaceWidth, dockWidth, hasDock],
  )
  const inspectorWidth = useMemo(() => {
    const wish = insWidth || INSPECTOR_DEFAULT
    return Math.max(insBounds.min, Math.min(insBounds.max, wish))
  }, [insWidth, insBounds])

  const setDockOpen = useCallback((open: boolean) => {
    hydrated.current = true
    setDockOpenLocal(open)
    saveWorkspace({ dockOpen: open })
  }, [])

  const setFocus = useCallback((target: FocusTarget) => {
    hydrated.current = true
    setFocusLocal(target)
    saveWorkspace({ workspaceFocus: target })
  }, [])

  const setDockWidth = useCallback((next: number) => {
    hydrated.current = true
    const { min, max } = dockBounds(workspaceWidth)
    const clamped = Math.round(Math.max(min, Math.min(max, next)))
    setWidthLocal(clamped)
    saveWorkspace({ dockWidth: clamped })
  }, [workspaceWidth])

  // 打开 Inspector 时先从 Dock 借宽；借不够时 Canvas 让位（此时 Dock 用回原宽）
  const dockRenderWidth = effectiveDockWidth({ workspaceWidth, dockWidth, inspectorWidth, inspectorOpen: inspectorOpen && hasDock })

  const setInspectorWidth = useCallback((next: number) => {
    hydrated.current = true
    const clamped = Math.round(Math.max(insBounds.min, Math.min(insBounds.max, next)))
    setInsWidthLocal(clamped)
    saveWorkspace({ inspectorWidth: clamped })
  }, [insBounds])

  // 面板自己要求的最小列宽（文件抽屉展开预览时）：只加宽，不缩窄。
  // 只在真有这一列的档位生效——手机走全屏二级页，没有列，不该被它改掉这份偏好。
  const wantInspector = useInspectorWantWidth()
  useEffect(() => {
    if (!splitCapable) return
    if (wantInspector > 0 && wantInspector > inspectorWidth) setInspectorWidth(wantInspector)
  }, [wantInspector, inspectorWidth, setInspectorWidth, splitCapable])

  const setNavCollapsed = useCallback((collapsed: boolean) => {
    hydrated.current = true
    setNavCollapsedLocal(collapsed)
    saveWorkspace({ navCollapsed: collapsed })
  }, [])

  return {
    mode,
    dockWidth,
    dockVisible: hasTerms && dockOpen,
    focus,
    navCollapsed: splitCapable ? navCollapsed : true,
    splitCapable,
    overlayCapable: layout.size === 'expanded',
    bounds,
    splitMax,
    inspectorWidth,
    inspectorBounds: insBounds,
    setInspectorWidth,
    resetInspectorWidth: () => { hydrated.current = true; setInsWidthLocal(0); saveWorkspace({ inspectorWidth: 0 }) },
    canvasFitsInspector: canvasFitsWith({ workspaceWidth, inspectorWidth, hasDock }),
    dockRenderWidth,
    toggleDock: () => setDockOpen(!dockOpen),
    setDockOpen,
    setDockWidth,
    resetDockWidth: () => { hydrated.current = true; setWidthLocal(0); saveWorkspace({ dockWidth: 0 }) },
    setFocus,
    toggleFocus: () => setFocus(focus === 'dock' ? 'none' : 'dock'),
    setNavCollapsed,
  }
}
