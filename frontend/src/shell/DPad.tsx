// 方向键簇（13 设计 §5.3）。
//
// 今天 `↑ ↓ ← →` 是快捷键条里四个 32px 的按钮，夹在十几个按钮中间。在 TUI 里
// （Claude/Codex 的选项列表、tmux copy-mode）选一项要连点五六次，每次都得先在
// 横滑条里把那个键找回来——而现在快捷键条只在输入态出现，不打字时它根本不在。
//
// 所以方向键单独拎出来常驻：右下角十字簇，48×48，长按连发。
// 「让键盘根本不必弹起」是这块的全部意义——键盘一弹就吃掉半屏。
import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, EnterIcon } from '../icons'

/** 首发 400ms 后进入连发，之后 90ms 一次（13 §5.3） */
const REPEAT_DELAY = 400
const REPEAT_EVERY = 90

const SEQ = {
  up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', enter: '\r',
} as const

export function DPad({ side, onSend, onHide }: {
  side: 'left' | 'right'
  onSend: (seq: string) => void
  /** 长按中心 = 收起 */
  onHide: () => void
}) {
  const { t } = useI18n()
  const timers = useRef<{ delay?: number; every?: number; hold?: number }>({})

  const stop = useCallback(() => {
    const { delay, every, hold } = timers.current
    if (delay) clearTimeout(delay)
    if (every) clearInterval(every)
    if (hold) clearTimeout(hold)
    timers.current = {}
  }, [])
  useEffect(() => stop, [stop])

  const press = useCallback((seq: string) => (e: React.PointerEvent) => {
    // preventDefault 挡住合成的 mouse 事件与长按选词，否则一次长按会同时触发两条路径
    e.preventDefault()
    stop()
    onSend(seq)
    timers.current.delay = window.setTimeout(() => {
      timers.current.every = window.setInterval(() => onSend(seq), REPEAT_EVERY)
    }, REPEAT_DELAY)
  }, [onSend, stop])

  const pressCenter = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    stop()
    // 中心不连发：回车连发的代价太高（连着提交十几次），改成长按 = 收起簇
    timers.current.hold = window.setTimeout(() => { stop(); onHide() }, 650)
  }, [onHide, stop])

  const releaseCenter = useCallback(() => {
    if (timers.current.hold) { clearTimeout(timers.current.hold); timers.current.hold = undefined; onSend(SEQ.enter) }
    stop()
  }, [onSend, stop])

  const key = (cls: string, seq: string, label: ReactNode, aria: string) => (
    <button type="button" className={`k ${cls}`} aria-label={aria}
      onPointerDown={press(seq)} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}>{label}</button>
  )

  return (
    <div className="tt-dpad" data-side={side} role="group" aria-label={t('mobile.dpad')}>
      {key('u', SEQ.up, <ChevronUp size={18} />, t('mobile.dpadUp'))}
      {key('l', SEQ.left, <ChevronLeft size={18} />, t('mobile.dpadLeft'))}
      <button type="button" className="k c" aria-label={t('mobile.dpadEnter')}
        onPointerDown={pressCenter} onPointerUp={releaseCenter}
        onPointerLeave={stop} onPointerCancel={stop}
        onContextMenu={(e) => e.preventDefault()}><EnterIcon size={18} /></button>
      {key('r', SEQ.right, <ChevronRight size={18} />, t('mobile.dpadRight'))}
      {key('d', SEQ.down, <ChevronDown size={18} />, t('mobile.dpadDown'))}
    </div>
  )
}
