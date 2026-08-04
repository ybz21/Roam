// 工作区容器：Canvas ｜ Dock 的四种几何（14 设计 §4.1–§4.3 / 13 §13.1）。
//
// **一个组件管四态，是为了让终端永远不换挂载点。**上一版把 split 和其余三态分成
// 两棵不同的 JSX 树，于是每按一次 ⌘J，React 都在同一位置看到不同的组件类型 →
// 卸载重建 → 终端连接跟着断一次。现在 {canvas} 和 {dock} 在四态里都是同一个位置，
// 变的只有它们的样式。
//
//   page     Canvas 铺满，Dock 宽度 0（仍挂载）
//   split    Canvas ｜ 8px 分隔条 ｜ Dock（large 档，≥1280）
//   overlay  Canvas 铺满不动，Dock 从右侧覆盖 480 + 遮罩（expanded 档，905–1279）
//   focus    Canvas 归零，Dock 铺满（用户显式 ⌘⇧J）
//
// overlay 的关键是 Dock **脱离文档流**：终端开合前后 Canvas 宽度一模一样，
// 概览的容器查询不会因为开个终端就跳列（13 §13.1）。
//
// 分隔条替掉的是那条 18px 全高把手：它把屏高切成三段——上半"向左扩展"、中间拖拽、
// 下半"向右收起"，还配竖排文字。一条 18px 的常驻噪音同时承担四种语义，
// 鼠标过去得先辨认方向而不是直接拖；而且操作对象其实是"页面宽"，
// 用户心里想的却是"调终端宽"。现在只剩一件事：拖。
//
// 拖拽有两条硬约束，都是踩出来的账：
//
// ① **指针要能穿过 iframe**（#140）：iframe 有独立 document，普通 window
//    pointermove/up 在指针进入 iframe 后就断。走 usePointerResize —— pointer
//    capture 连续跟踪 + body portal 遮罩兜底。
//
// ② **拖动期间不许改布局**（#139）：每帧改页面/终端宽度会让 HTML iframe 高频
//    重排、ResizeObserver 反复 fit → SIGWINCH → tmux 整屏重排，肉眼就是闪屏。
//    所以拖动时**只移动一条引导线**，`pointerup` 才提交一次宽度。
import { useCallback, useRef, type CSSProperties, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import { PointerResizeShield, usePointerResize } from '../PointerResize'
import { OVERLAY_DOCK, type SpaceMode } from './useWorkspaceLayout'

export function Workspace({ mode, canvas, dock, dockWidth, bounds, splitMax, onResize, onReset, onFocus, onDismiss, capsule }: {
  mode: SpaceMode
  canvas: ReactNode
  dock: ReactNode
  dockWidth: number
  /** 拖拽区间，上界 = Canvas 归零处 */
  bounds: { min: number; max: number }
  /** 超过它 Canvas 就不足 560：松手时落进 Focus 而不是留一条废条 */
  splitMax: number
  onResize: (width: number) => void
  onReset: () => void
  /** 拖过头：页面藏起来，终端铺满 */
  onFocus: () => void
  /** 覆盖态点遮罩收起 */
  onDismiss: () => void
  /** 覆盖态收起时右下角的会话胶囊（13 §13.1）；其余档传 null */
  capsule?: ReactNode
}) {
  const { t } = useI18n()
  const { active, start } = usePointerResize()
  const railRef = useRef<HTMLDivElement>(null)
  const guideRef = useRef<HTMLDivElement>(null)
  const pending = useRef<number | null>(null)

  const clamp = useCallback(
    (w: number) => Math.round(Math.max(bounds.min, Math.min(bounds.max, w))),
    [bounds],
  )

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const rail = railRef.current
    const guide = guideRef.current
    if (!rail) return
    const startX = e.clientX
    const startWidth = dockWidth
    const railCenter = rail.getBoundingClientRect().left + rail.offsetWidth / 2
    if (guide) {
      guide.style.display = 'block'
      guide.style.left = `${railCenter}px`
    }
    start(e, {
      onMove: (ev) => {
        // 往左拖 = 终端变宽，所以是减；钳制交给 clamp，引导线也就停在边界上
        const next = clamp(startWidth - (ev.clientX - startX))
        pending.current = next
        // 分隔条最终会左移 (next - startWidth)，引导线按这个位移走
        if (guide) {
          guide.style.left = `${railCenter - (next - startWidth)}px`
          // 越过 splitMax 换色：松手不是"再宽一点"，而是"整页藏起来"，得先说一声
          guide.dataset.focus = next > splitMax ? '1' : ''
        }
      },
      onEnd: () => {
        if (guide) guide.style.display = 'none'
        const next = pending.current
        pending.current = null
        if (next == null) return
        // 拖过 splitMax = Canvas 已经不足 560：与其留一条 300px 的废页面，不如整页藏起来。
        // 这样「一直往左拖」这个动作有终点，而不是拖到某处就顶死不动。
        if (next > splitMax) onFocus()
        else onResize(next)
      },
    })
  }, [dockWidth, clamp, onResize, onFocus, splitMax, start])

  // 键盘调宽是一次一档，不存在高频重排，直接提交
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') {
      const next = clamp(dockWidth + 16)
      if (next > splitMax) onFocus(); else onResize(next)
    }
    else if (e.key === 'ArrowRight') onResize(clamp(dockWidth - 16))
    else if (e.key === 'Home') onResize(bounds.min)
    else if (e.key === 'End') onFocus()
    else return
    e.preventDefault()
  }, [dockWidth, bounds, splitMax, clamp, onResize, onFocus])

  const focus = mode === 'focus'
  const overlay = mode === 'overlay'

  const dockStyle: CSSProperties = overlay
    ? {
        // 脱离文档流：Canvas 宽度不受影响，这是覆盖式的全部意义
        position: 'absolute', top: 0, right: 0, bottom: 0,
        width: `min(${OVERLAY_DOCK}px, 100%)`,
        zIndex: 'var(--z-sheet)' as unknown as number,
        boxShadow: '-12px 0 32px rgba(1,4,9,.45)',
        borderLeft: '1px solid var(--border-subtle)',
        display: 'flex', flexDirection: 'column', minWidth: 0,
        background: 'var(--bg-term)',
        animation: 'ttDockIn .2s cubic-bezier(.2,.85,.3,1)',
      }
    : {
        flex: mode === 'split' ? `0 0 ${dockWidth}px` : focus ? '1 1 auto' : '0 0 0px',
        width: mode === 'split' ? dockWidth : focus ? undefined : 0,
        minWidth: 0, height: '100%', minHeight: 0, overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        background: 'var(--bg-term)',
        transition: active ? 'none' : 'flex-basis .2s, width .2s',
      }

  return (
    // 这里**不能**写 height:100dvh：这一层挂在 40px 的 Command Center 下面，
    // 100dvh 会让整列比可视区高出正好一个顶栏，最底下那条快捷键条只露得出几像素
    // （终端也跟着多算 40px，最后一行同样看不见）。跟着 Layout 的列走 flex:1 即可。
    <div style={{ position: 'relative', display: 'flex', height: '100%', minHeight: 0, minWidth: 0, flex: 1 }}>
      <div style={{
        flex: focus ? '0 0 0px' : '1 1 auto', width: focus ? 0 : undefined,
        minWidth: 0, height: '100%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column',
      }}>
        {canvas}
      </div>

      {mode === 'split' && (
        <div
          ref={railRef}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('workspace.resizeDock')}
          aria-valuemin={bounds.min}
          aria-valuemax={bounds.max}
          aria-valuenow={dockWidth}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onDoubleClick={onReset}
          onKeyDown={onKeyDown}
          className="tt-split-rail"
        />
      )}

      {/* 遮罩只盖 Canvas，不盖导航轨和顶栏——「上下文不消失」也适用于覆盖态 */}
      {overlay && <div className="tt-dock-scrim" onClick={onDismiss} aria-hidden="true" />}

      <div style={dockStyle}
        role={overlay ? 'dialog' : undefined}
        aria-label={overlay ? t('workspace.terminalPanel') : undefined}>
        {dock}
      </div>

      {capsule}

      {/* 拖动期间只有这条线跟着指针走，布局纹丝不动 */}
      <div ref={guideRef} data-dock-resize-guide aria-hidden="true" style={{
        display: 'none', position: 'fixed', top: 0, bottom: 0, width: 2,
        zIndex: 1000, pointerEvents: 'none',
      }} className="tt-dock-guide" />
      <PointerResizeShield active={active} />
    </div>
  )
}

/**
 * 会话胶囊（13 §13.1）：覆盖式面板收起后，右下角留一枚 50 高的入口，
 * 等价于手机上的会话坞——否则这一档收起面板，终端就"消失"了。
 */
export function SessionCapsule({ label, count, onOpen, title }: {
  label: string; count: number; onOpen: () => void; title: string
}) {
  return (
    <button type="button" className="tt-session-capsule" onClick={onOpen} title={title} aria-label={title}>
      <span className="d" />
      <span className="nm">{label}</span>
      {count > 1 && <span className="n">{count}</span>}
    </button>
  )
}
