import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export type TermStatus = 'connecting' | 'connected' | 'closed'
export interface TermHandle {
  // keepFocus=true：发送但不把焦点抢回 xterm（移动端输入框流程用，避免软键盘被收起）
  send: (s: string, keepFocus?: boolean) => void
  fit: () => void
  copy: () => boolean
  reconnect: () => void
  scroll: (lines: number) => void
  toBottom: () => void
}

// xterm 不认 CSS var()，需具体色值：读 <html> 上的同名变量，随黑/白主题切换。
function xtermTheme() {
  const cs = getComputedStyle(document.documentElement)
  const bg = cs.getPropertyValue('--xterm-bg').trim() || '#06090d'
  const fg = cs.getPropertyValue('--xterm-fg').trim() || '#e6edf3'
  return { background: bg, foreground: fg, cursor: '#58a6ff' }
}

// 跨 http（局域网非安全上下文）也能用的复制
function copyText(s: string) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(s).catch(() => {})
    return
  }
  const ta = document.createElement('textarea')
  ta.value = s
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try { document.execCommand('copy') } catch {}
  document.body.removeChild(ta)
}

// 单个会话终端：xterm.js ↔ WebSocket(/api/term/:name) ↔ tmux attach
// 断线自动重连 / 字号调节 / 复制 / 父组件注入按键 / 可见时自动重排。
const Term = forwardRef<TermHandle, {
  name: string
  fontSize: number
  active: boolean
  onStatus?: (s: TermStatus) => void
}>(function Term({ name, fontSize, active, onStatus }, ref) {
  const elRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal>()
  const fitRef = useRef<FitAddon>()
  const wsRef = useRef<WebSocket>()
  const unmounted = useRef(false)
  const retry = useRef<any>()

  const sendResize = () => {
    const t = termRef.current, ws = wsRef.current, fit = fitRef.current
    if (!t || !fit) return
    try {
      fit.fit()
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }))
    } catch {}
  }

  // 通过 tmux copy-mode 滚动会话真实历史（attach 是全屏，xterm 本地缓冲为空）
  const sendScroll = (dir: string, lines: number) => {
    const ws = wsRef.current
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'scroll', dir, lines }))
  }

  const connect = () => {
    if (unmounted.current) return
    onStatus?.('connecting')
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/term/${encodeURIComponent(name)}`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws
    ws.onopen = () => { onStatus?.('connected'); termRef.current?.focus(); sendResize() }
    ws.onmessage = (e) => {
      const t = termRef.current
      if (!t) return
      if (typeof e.data === 'string') t.write(e.data)
      else t.write(new Uint8Array(e.data as ArrayBuffer))
    }
    ws.onclose = () => {
      onStatus?.('closed')
      if (unmounted.current) return
      retry.current = setTimeout(connect, 1200) // 断线自动重连
    }
  }

  useImperativeHandle(ref, () => ({
    send: (s, keepFocus) => { const ws = wsRef.current; if (ws && ws.readyState === 1) ws.send(s); if (!keepFocus) termRef.current?.focus() },
    fit: () => sendResize(),
    copy: () => {
      const sel = termRef.current?.getSelection() || ''
      if (sel) copyText(sel)
      return !!sel
    },
    reconnect: () => { try { wsRef.current?.close() } catch {} }, // onclose 触发自动重连
    scroll: (lines) => sendScroll(lines < 0 ? 'up' : 'down', Math.abs(lines)),
    toBottom: () => sendScroll('bottom', 0),
  }))

  useEffect(() => {
    unmounted.current = false
    const term = new Terminal({
      fontSize,
      cursorBlink: true,
      scrollback: 5000,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: xtermTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(elRef.current!)
    termRef.current = term
    fitRef.current = fit
    setTimeout(() => { try { fit.fit() } catch {} }, 0)

    // 跟随全局黑/白主题：监听 <html data-theme> 变化，热更新终端配色
    const themeObs = new MutationObserver(() => { try { term.options.theme = xtermTheme() } catch {} })
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    const dataDisp = term.onData((d) => { const ws = wsRef.current; if (ws && ws.readyState === 1) ws.send(d) })
    const ro = new ResizeObserver(() => sendResize())
    if (elRef.current) ro.observe(elRef.current)
    window.addEventListener('resize', sendResize)

    // 滚动 tmux 历史：触摸滑动 + 鼠标滚轮 → 发 scroll 控制（后端走 copy-mode）
    const el = elRef.current!
    let lastY = 0
    let acc = 0
    const lineH = () => (termRef.current?.options.fontSize || 13) * 1.3
    const onTS = (e: TouchEvent) => { lastY = e.touches[0].clientY; acc = 0 }
    // 捕获阶段 + stopPropagation：开了 tmux mouse 后，xterm 会把滚轮/触摸转成
    // 鼠标事件发给 tmux，与我们的 copy-mode 滚动重复。这里抢先独占，避免双重滚动。
    const onTM = (e: TouchEvent) => {
      const y = e.touches[0].clientY
      acc += (y - lastY) / lineH() // 下滑(dy>0)看更早；上滑看更新
      lastY = y
      const n = Math.trunc(acc)
      if (n !== 0) { acc -= n; sendScroll(n > 0 ? 'up' : 'down', Math.abs(n)) }
      e.preventDefault(); e.stopPropagation()
    }
    const onWheel = (e: WheelEvent) => {
      const n = Math.max(1, Math.round(Math.abs(e.deltaY) / lineH()))
      sendScroll(e.deltaY < 0 ? 'up' : 'down', n)
      e.preventDefault(); e.stopPropagation()
    }
    el.addEventListener('touchstart', onTS, { passive: true, capture: true })
    el.addEventListener('touchmove', onTM, { passive: false, capture: true })
    el.addEventListener('wheel', onWheel, { passive: false, capture: true })

    connect()

    return () => {
      unmounted.current = true
      clearTimeout(retry.current)
      ro.disconnect()
      themeObs.disconnect()
      window.removeEventListener('resize', sendResize)
      el.removeEventListener('touchstart', onTS, { capture: true } as any)
      el.removeEventListener('touchmove', onTM, { capture: true } as any)
      el.removeEventListener('wheel', onWheel, { capture: true } as any)
      dataDisp.dispose()
      try { wsRef.current?.close() } catch {}
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])

  useEffect(() => {
    const t = termRef.current
    if (t) { t.options.fontSize = fontSize; setTimeout(sendResize, 0) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize])

  useEffect(() => {
    if (active) setTimeout(() => { sendResize(); termRef.current?.focus() }, 40)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  return <div ref={elRef} style={{ width: '100%', height: '100%' }} />
})

export default Term
