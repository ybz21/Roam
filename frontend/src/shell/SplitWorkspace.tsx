// Canvas ｜ 8px 分隔条 ｜ Dock 的并排容器（14 设计 §4.1 / §4.3）。
//
// 替掉的是那条 18px 全高把手：它把屏高切成三段——上半"向左扩展"、中间拖拽、
// 下半"向右收起"，还配竖排文字。一条 18px 的常驻噪音同时承担四种语义，
// 鼠标过去得先辨认方向而不是直接拖；而且操作对象其实是"页面宽"，
// 用户心里想的却是"调终端宽"。
//
// 现在只剩一件事：拖。视觉 8px、命中区左右各扩 6px（--split-hit 20），
// 双击复位，方向键 16px 一档，Home/End 到最小/最大。开合走 Command Center
// 的按钮或 ⌘J，不再在这条上叠第三种语义。
import { useCallback, useRef, type ReactNode } from 'react'
import { useI18n } from '../i18n'

export function SplitWorkspace({ canvas, dock, dockWidth, bounds, onResize, onReset }: {
  canvas: ReactNode
  dock: ReactNode
  dockWidth: number
  bounds: { min: number; max: number }
  onResize: (width: number) => void
  onReset: () => void
}) {
  const { t } = useI18n()
  const drag = useRef<{ x: number; width: number } | null>(null)
  const railRef = useRef<HTMLDivElement>(null)

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, width: dockWidth }
    railRef.current?.setPointerCapture(e.pointerId)
    // 拖拽期间禁选，否则会把页面文字一路刷蓝
    document.body.style.userSelect = 'none'
  }, [dockWidth])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    // 往左拖 = 终端变宽，所以是减
    onResize(drag.current.width - (e.clientX - drag.current.x))
  }, [onResize])

  const endDrag = useCallback(() => {
    drag.current = null
    document.body.style.userSelect = ''
  }, [])

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') onResize(dockWidth + 16)
    else if (e.key === 'ArrowRight') onResize(dockWidth - 16)
    else if (e.key === 'Home') onResize(bounds.min)
    else if (e.key === 'End') onResize(bounds.max)
    else return
    e.preventDefault()
  }, [dockWidth, bounds, onResize])

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
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onReset}
        onKeyDown={onKeyDown}
        className="tt-split-rail"
      />

      <div style={{
        flex: `0 0 ${dockWidth}px`, width: dockWidth, minWidth: 0,
        height: '100dvh', overflow: 'hidden', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-term)',
        transition: drag.current ? 'none' : 'flex-basis .2s, width .2s',
      }}>
        {dock}
      </div>
    </div>
  )
}
