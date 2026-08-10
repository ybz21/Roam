import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'

type ResizeHandlers = {
  onMove: (event: PointerEvent) => void
  onEnd?: () => void
}

// iframe 有独立的 document，普通 window pointermove/up 会在指针进入 iframe 后中断。
// Pointer capture 负责连续跟踪，body portal 遮罩兜底，并统一处理取消、失焦和卸载清理。
export function usePointerResize() {
  const [active, setActive] = useState(false)
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => () => cleanupRef.current?.(), [])

  const start = (event: ReactPointerEvent<HTMLElement>, handlers: ResizeHandlers) => {
    cleanupRef.current?.()
    event.preventDefault()

    const pointerId = event.pointerId
    const handle = event.currentTarget
    const previousUserSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor
    let ended = false

    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return
      next.preventDefault()
      handlers.onMove(next)
    }
    const end = (next?: Event) => {
      if (ended) return
      if (next && 'pointerId' in next && (next as PointerEvent).pointerId !== pointerId) return
      ended = true
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('blur', end)
      try {
        if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId)
      } catch {}
      document.body.style.userSelect = previousUserSelect
      document.body.style.cursor = previousCursor
      cleanupRef.current = null
      setActive(false)
      handlers.onEnd?.()
    }

    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    try { handle.setPointerCapture?.(pointerId) } catch {}
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    window.addEventListener('blur', end)
    cleanupRef.current = end
    setActive(true)
  }

  return { active, start }
}

export function PointerResizeShield({ active }: { active: boolean }) {
  if (!active || typeof document === 'undefined') return null
  return createPortal(
    <div data-pointer-resize-shield="true" aria-hidden="true" style={{
      position: 'fixed', inset: 0, zIndex: 2147483647,
      cursor: 'col-resize', touchAction: 'none', userSelect: 'none',
    }} />,
    document.body,
  )
}
