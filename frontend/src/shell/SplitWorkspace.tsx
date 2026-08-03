// Canvas ｜ 8px 分隔条 ｜ Dock 的并排容器（14 设计 §4.1 / §4.3）。
//
// 替掉的是那条 18px 全高把手：它把屏高切成三段——上半"向左扩展"、中间拖拽、
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
import { useCallback, useRef, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import { PointerResizeShield, usePointerResize } from '../PointerResize'

export function SplitWorkspace({ canvas, dock, dockWidth, bounds, onResize, onReset }: {
  canvas: ReactNode
  dock: ReactNode
  dockWidth: number
  bounds: { min: number; max: number }
  onResize: (width: number) => void
  onReset: () => void
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
        if (guide) guide.style.left = `${railCenter - (next - startWidth)}px`
      },
      onEnd: () => {
        if (guide) guide.style.display = 'none'
        if (pending.current != null) {
          onResize(pending.current)
          pending.current = null
        }
      },
    })
  }, [dockWidth, clamp, onResize, start])

  // 键盘调宽是一次一档，不存在高频重排，直接提交
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') onResize(clamp(dockWidth + 16))
    else if (e.key === 'ArrowRight') onResize(clamp(dockWidth - 16))
    else if (e.key === 'Home') onResize(bounds.min)
    else if (e.key === 'End') onResize(bounds.max)
    else return
    e.preventDefault()
  }, [dockWidth, bounds, clamp, onResize])

  return (
    <div style={{ display: 'flex', height: '100dvh', minHeight: 0, minWidth: 0, flex: 1 }}>
      <div style={{ flex: '1 1 auto', minWidth: 0, height: '100dvh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {canvas}
      </div>

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

      <div style={{
        flex: `0 0 ${dockWidth}px`, width: dockWidth, minWidth: 0,
        height: '100dvh', overflow: 'hidden', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-term)',
        transition: active ? 'none' : 'flex-basis .2s, width .2s',
      }}>
        {dock}
      </div>

      {/* 拖动期间只有这条线跟着指针走，布局纹丝不动 */}
      <div ref={guideRef} data-dock-resize-guide aria-hidden="true" style={{
        display: 'none', position: 'fixed', top: 0, bottom: 0, width: 2,
        zIndex: 1000, pointerEvents: 'none',
        background: '#58a6ff', boxShadow: '0 0 0 1px rgba(88,166,255,.18)',
      }} />
      <PointerResizeShield active={active} />
    </div>
  )
}
