// 工作区空间状态：Page / Split / Focus 三态与 Dock 宽度（14 设计 §4.1–§4.3）。
//
// 这里只有尺寸与状态，不含任何 JSX——分栏契约是纯算术，值得单独测。
//
// 旧实现的问题是**主次颠倒**：页宽按页面类型写死（files 520–900 / sessions 420 /
// 其余 300），终端 `minWidth: 480` 拿走剩余全部。用户从项目页开个终端，项目上下文
// 就被压成 300px。新契约反过来：Canvas 最小 560、Dock 最小 480，谁也不能把对方
// 挤破；空间不够就整体切 Focus，绝不横向溢出。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLayout } from '../layout'
import { usePreferences, saveWorkspace } from '../preferences'

/** 尺寸契约，与 index.css 的 --canvas-min / --dock-* 同源（14 §8.2）。 */
export const CANVAS_MIN = 560
export const DOCK_MIN = 480
export const DOCK_MAX = 880
export const SPLIT_RAIL = 8
export const NAV_WIDTH = 224
export const NAV_RAIL = 64

export type SpaceMode = 'page' | 'split' | 'focus'
export type FocusTarget = 'none' | 'page' | 'dock'

/**
 * Dock 宽度上界：可用宽减去 Canvas 最小宽和分隔条。
 *
 * 不钳这一下就会横向溢出——1280 展开侧栏时 `42vw = 538`，Canvas 只剩 510，
 * 自己先破 560 的契约。**拖拽、双击复位、恢复偏好三条路径都必须过这个函数**，
 * 这是「不制造横向滚动」的唯一保证（14 §4.2）。
 */
export function dockBounds(workspaceWidth: number): { min: number; max: number } {
  const room = workspaceWidth - SPLIT_RAIL - CANVAS_MIN
  return { min: DOCK_MIN, max: Math.max(DOCK_MIN, Math.min(DOCK_MAX, room)) }
}

/** 该档的默认 Dock 宽度：clamp(480, 42vw, 880)，再过一次上界钳制。 */
export function defaultDockWidth(viewportWidth: number, workspaceWidth: number): number {
  const wish = Math.round(viewportWidth * 0.42)
  const { min, max } = dockBounds(workspaceWidth)
  return Math.max(min, Math.min(max, wish))
}

/** 并排是否成立：Canvas 560 + rail 8 + Dock 480（不含导航）。 */
export function canSplit(workspaceWidth: number): boolean {
  return workspaceWidth >= CANVAS_MIN + SPLIT_RAIL + DOCK_MIN
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
  toggleDock: () => void
  setDockOpen: (open: boolean) => void
  setDockWidth: (width: number) => void
  resetDockWidth: () => void
  setFocus: (target: FocusTarget) => void
  toggleFocus: () => void
  setNavCollapsed: (collapsed: boolean) => void
  /** 供分隔条读：当前允许拖到的区间 */
  bounds: { min: number; max: number }
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
  const hydrated = useRef(false)

  // 偏好从服务端到达后同步一次（首屏时 usePreferences 还是默认值）
  useEffect(() => {
    if (hydrated.current) return
    hydrated.current = true
    setDockOpenLocal(ws.dockOpen)
    setFocusLocal(ws.workspaceFocus)
    setNavCollapsedLocal(ws.navCollapsed)
    setWidthLocal(ws.dockWidth || 0)
  }, [ws.dockOpen, ws.workspaceFocus, ws.navCollapsed, ws.dockWidth])

  const splitCapable = layout.size === 'large'
  const navWidth = splitCapable ? (navCollapsed ? NAV_RAIL : NAV_WIDTH) : NAV_RAIL
  const workspaceWidth = Math.max(0, viewport - navWidth)
  const bounds = useMemo(() => dockBounds(workspaceWidth), [workspaceWidth])

  // 恢复偏好时先钳制：换到小窗口不能拿旧大屏的宽度把 Canvas 挤爆（14 §9.3）
  const dockWidth = useMemo(() => {
    const wish = width || defaultDockWidth(viewport, workspaceWidth)
    return Math.max(bounds.min, Math.min(bounds.max, wish))
  }, [width, viewport, workspaceWidth, bounds])

  const roomForSplit = splitCapable && canSplit(workspaceWidth)
  const mode: SpaceMode = !hasTerms || !dockOpen
    ? 'page'
    : focus !== 'none'
      ? 'focus'
      : roomForSplit ? 'split' : 'focus'

  const setDockOpen = useCallback((open: boolean) => {
    setDockOpenLocal(open)
    saveWorkspace({ dockOpen: open })
  }, [])

  const setFocus = useCallback((target: FocusTarget) => {
    setFocusLocal(target)
    saveWorkspace({ workspaceFocus: target })
  }, [])

  const setDockWidth = useCallback((next: number) => {
    const { min, max } = dockBounds(workspaceWidth)
    const clamped = Math.round(Math.max(min, Math.min(max, next)))
    setWidthLocal(clamped)
    saveWorkspace({ dockWidth: clamped })
  }, [workspaceWidth])

  const setNavCollapsed = useCallback((collapsed: boolean) => {
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
    bounds,
    toggleDock: () => setDockOpen(!dockOpen),
    setDockOpen,
    setDockWidth,
    resetDockWidth: () => { setWidthLocal(0); saveWorkspace({ dockWidth: 0 }) },
    setFocus,
    toggleFocus: () => setFocus(focus === 'dock' ? 'none' : 'dock'),
    setNavCollapsed,
  }
}
