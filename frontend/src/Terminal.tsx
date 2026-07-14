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
  selection: () => string
  clearSelection: () => void
  reconnect: () => void
  scroll: (lines: number) => void
  toBottom: () => void
  // 按视口坐标激活该处的 tmux pane（分窗时拖放/点击定位到正确窗格）
  selectPaneAt: (clientX: number, clientY: number) => void
}

// xterm 不认 CSS var()，需具体色值：读 <html> 上的同名变量，随黑/白主题切换。
function xtermTheme() {
  const cs = getComputedStyle(document.documentElement)
  const bg = cs.getPropertyValue('--xterm-bg').trim() || '#06090d'
  const fg = cs.getPropertyValue('--xterm-fg').trim() || '#e6edf3'
  return { background: bg, foreground: fg, cursor: '#58a6ff' }
}

// 滤掉应用(Claude Code/Codex/vim 等)开启「鼠标上报」的 DECSET 序列 ESC[?1000/1001/1002/1003h。
// 否则 xterm 会把鼠标事件转发给应用，本地拖选失效 → 选不中文本、无法复制。
// 只滤显示流：应用自身仍以为鼠标开着，后端合成的滚轮(sendScroll)不受影响。
// 字节级处理，不解码，避免拆断跨帧的多字节 UTF-8。
const MOUSE_ON = new Set(['1000', '1001', '1002', '1003'])
function stripMouseEnableBytes(buf: Uint8Array): Uint8Array {
  let hit = false
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x1b && buf[i + 1] === 0x5b && buf[i + 2] === 0x3f) { hit = true; break }
  }
  if (!hit) return buf // 常见情况：无 ESC[? 直接原样返回，零拷贝
  const out: number[] = []
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x1b && buf[i + 1] === 0x5b && buf[i + 2] === 0x3f) {
      let j = i + 3, num = ''
      while (j < buf.length && buf[j] >= 0x30 && buf[j] <= 0x39) { num += String.fromCharCode(buf[j]); j++ }
      if (j < buf.length && buf[j] === 0x68 /* 'h' */ && MOUSE_ON.has(num)) { i = j; continue } // 跳过整段
    }
    out.push(buf[i])
  }
  return new Uint8Array(out)
}
const stripMouseEnableStr = (s: string) => s.replace(/\x1b\[\?(?:1000|1001|1002|1003)h/g, '')

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
  onContextMenu?: (e: { x: number; y: number; selection: string }) => void
  onSelectionMenu?: (e: { x: number; y: number; selection: string }) => void
  onPaste?: () => void // Ctrl+Shift+V / Cmd+V：交父组件走应用粘贴（读剪贴板→失败弹手动框）
  onImagePaste?: (files: File[]) => void // 粘贴事件含图片时回调（绕过键盘拦截时的兜底）
}>(function Term({ name, fontSize, active, onStatus, onContextMenu, onSelectionMenu, onPaste, onImagePaste }, ref) {
  const elRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal>()
  const fitRef = useRef<FitAddon>()
  const wsRef = useRef<WebSocket>()
  const unmounted = useRef(false)
  const retry = useRef<any>()

  const sendResize = () => {
    const t = termRef.current, ws = wsRef.current, fit = fitRef.current, el = elRef.current
    if (!t || !fit || !el) return
    // 未激活的标签是 display:none、尺寸为 0：此时 fit 拿不到真实宽度，会让终端停在默认 80 列，
    // tmux 便渲染成左侧窄条。隐藏或尚未布局时跳过，等可见(切回标签)再 fit。
    if (el.offsetParent === null || el.clientWidth === 0 || el.clientHeight === 0) return
    try {
      const dims = fit.proposeDimensions()
      if (!dims || !isFinite(dims.cols) || !isFinite(dims.rows) || dims.cols < 2 || dims.rows < 2) return
      fit.fit()
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }))
    } catch {}
  }

  // 滚动会话历史：attach 是全屏、xterm 本地缓冲为空，统一交后端处理——
  // 普通屏走 tmux copy-mode，备用屏(全屏 TUI)由后端合成滚轮序列喂给应用滚自己的缓冲。
  const sendScroll = (dir: string, lines: number) => {
    const ws = wsRef.current
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'scroll', dir, lines }))
  }

  const selectPaneAtClient = (clientX: number, clientY: number) => {
    const t = termRef.current, el = elRef.current, ws = wsRef.current
    if (!t || !el || !ws || ws.readyState !== 1 || t.cols <= 0 || t.rows <= 0) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const col = Math.max(0, Math.min(t.cols - 1, Math.floor(((clientX - rect.left) / rect.width) * t.cols)))
    const row = Math.max(0, Math.min(t.rows - 1, Math.floor(((clientY - rect.top) / rect.height) * t.rows)))
    ws.send(JSON.stringify({ type: 'select-pane', col, row }))
  }
  const selectPaneAt = (e: MouseEvent) => { if (e.button === 0) selectPaneAtClient(e.clientX, e.clientY) }

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
      if (typeof e.data === 'string') t.write(stripMouseEnableStr(e.data))
      else t.write(stripMouseEnableBytes(new Uint8Array(e.data as ArrayBuffer)))
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
    selection: () => termRef.current?.getSelection() || '',
    clearSelection: () => termRef.current?.clearSelection(),
    reconnect: () => { try { wsRef.current?.close() } catch {} }, // onclose 触发自动重连
    scroll: (lines) => sendScroll(lines < 0 ? 'up' : 'down', Math.abs(lines)),
    toBottom: () => sendScroll('bottom', 0),
    selectPaneAt: (clientX, clientY) => selectPaneAtClient(clientX, clientY),
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

    // Ctrl/Cmd+C 智能复制：有选区 → 复制并清除选区（交上层弹「已复制」），无选区 → 放行发 ^C 中断。
    // Ctrl/Cmd+Shift+C 始终复制（与浏览器习惯一致）。返回 false 表示该按键不再发给终端。
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      // Shift+Enter → CSI u 序列 \x1b[13;2u：让 Claude Code / Codex 等 TUI 识别为换行而非提交。
      // 需配合后端 tmux set-option extended-keys always。
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault()
        const ws = wsRef.current
        if (ws && ws.readyState === 1) ws.send('\x1b[13;2u')
        return false
      }
      // Ctrl+Shift+V / Cmd+V：接管粘贴。xterm 原生 paste 依赖浏览器 paste 事件，在局域网
      // http(非安全上下文)读不到剪贴板，这里统一交给应用：能读则读、读不到弹手动粘贴框。
      const isV = e.key === 'v' || e.key === 'V'
      if (isV && ((e.ctrlKey && e.shiftKey && !e.altKey) || (e.metaKey && !e.ctrlKey && !e.altKey))) {
        e.preventDefault()
        onPaste?.()
        return false // 吞掉，避免 xterm 再触发一次原生 paste 造成重复
      }
      const isC = e.key === 'c' || e.key === 'C'
      if (!isC) return true
      const copyCombo = (e.ctrlKey && e.shiftKey) || (e.metaKey && !e.ctrlKey) // Ctrl+Shift+C 或 Cmd+C
      const plainCtrlC = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey
      if (!copyCombo && !plainCtrlC) return true
      const sel = term.getSelection()
      if (sel && sel.trim()) {
        onSelectionMenu?.({ x: 0, y: 0, selection: sel })
        term.clearSelection()
        return false // 已复制，不把按键发给终端
      }
      // 无选区：复制组合键吞掉（避免误发中断），普通 Ctrl+C 放行去中断进程
      return !copyCombo
    })

    // 跟随全局黑/白主题：监听 <html data-theme> 变化，热更新终端配色
    const themeObs = new MutationObserver(() => { try { term.options.theme = xtermTheme() } catch {} })
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    // ponytail: IME 切英文时 macOS commit 未选中拼音（"s c p"），xterm 发给 pty 造成垃圾。
    // composition 期间吞掉所有 onData；compositionend 后吞掉 xterm 延迟发出的 finalize 数据，
    // 如果是纯拼音则去空格重发，中文则原样放行。
    // 升级路径：patch xterm CompositionHelper。
    const textarea = elRef.current!.querySelector('textarea')
    let composing = false
    let pendingReplace: string | null = null // compositionend 后等待替换的拼音
    const onCompStart = () => { composing = true; pendingReplace = null }
    const onCompEnd = (e: CompositionEvent) => {
      composing = false
      const data = e.data || ''
      // 纯 ASCII 字母+空格 = 拼音未选中候选词（切换输入法触发）
      if (data && /^[a-zA-Z][a-zA-Z ]*$/.test(data)) {
        pendingReplace = data.replace(/ /g, '')
      }
      // 中文：pendingReplace 保持 null，xterm finalize 的 onData 正常放行
    }
    if (textarea) {
      textarea.addEventListener('compositionstart', onCompStart)
      textarea.addEventListener('compositionend', onCompEnd)
    }

    const dataDisp = term.onData((d) => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== 1) return
      if (composing) return // composition 期间吞掉（xterm 中间态）
      if (pendingReplace !== null) {
        // compositionend 后 xterm finalize 发出的数据 → 替换为去空格版
        const replace = pendingReplace
        pendingReplace = null
        ws.send(replace)
        return
      }
      ws.send(d)
    })
    const ro = new ResizeObserver(() => sendResize())
    if (elRef.current) ro.observe(elRef.current)
    window.addEventListener('resize', sendResize)

    // 滚动会话历史：触摸滑动 + 鼠标滚轮 → 发 scroll 控制（后端按普通屏/备用屏分流，见 sendScroll）
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
    const onMouseUp = (e: MouseEvent) => {
      const sel = termRef.current?.getSelection() || ''
      if (sel.trim()) onSelectionMenu?.({ x: e.clientX, y: e.clientY, selection: sel })
    }
    const onTouchEnd = (e: TouchEvent) => {
      const sel = termRef.current?.getSelection() || ''
      const t = e.changedTouches[0]
      if (sel.trim() && t) onSelectionMenu?.({ x: t.clientX, y: t.clientY, selection: sel })
    }
    // 右键改为 Roam 菜单：有选区时优先复制；无选区时提供粘贴/重连/tmux 常用动作。
    const onCtx = (e: MouseEvent) => {
      e.preventDefault()
      const sel = termRef.current?.getSelection() || ''
      onContextMenu?.({ x: e.clientX, y: e.clientY, selection: sel })
    }
    // 捕获阶段独占右键 mousedown，阻止 xterm 把它转发给 tmux（tmux 鼠标模式开时会另弹一个菜单）。
    // 这样无论后端鼠标模式开关，右键都只剩前端这一个菜单。
    const onMouseDownCapture = (e: MouseEvent) => {
      if (e.button === 2) {
        // 右键菜单里有「关闭当前窗格」等动作，得先把 tmux 服务端 active pane
        // 同步到右键点击位置，否则菜单操作的还是上一次左键选中的旧 pane。
        selectPaneAtClient(e.clientX, e.clientY)
        e.stopPropagation()
        return
      }
      selectPaneAt(e)
    }
    el.addEventListener('touchstart', onTS, { passive: true, capture: true })
    el.addEventListener('touchmove', onTM, { passive: false, capture: true })
    el.addEventListener('wheel', onWheel, { passive: false, capture: true })
    el.addEventListener('mousedown', onMouseDownCapture, { capture: true })
    el.addEventListener('mouseup', onMouseUp)
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('contextmenu', onCtx)
    const onPasteCapture = (e: ClipboardEvent) => {
      if (!e.clipboardData?.items) return
      // 一次粘贴只取一张图：同一张截图常以多种 MIME(image/png + image/jpeg…)重复出现，
      // 全收会重复上传 → 终端里出现两次 @路径。取到第一张就停。
      let file: File | null = null
      for (let i = 0; i < e.clipboardData.items.length; i++) {
        if (e.clipboardData.items[i].type.startsWith('image/')) {
          const f = e.clipboardData.items[i].getAsFile()
          if (f) { file = f; break }
        }
      }
      if (file) {
        e.preventDefault()
        e.stopPropagation()
        onImagePaste?.([file])
      }
    }
    el.addEventListener('paste', onPasteCapture, { capture: true })
    // 拖文件落进终端的兜底：xterm 会把隐藏 helper textarea 挪到「终端光标所在格」（正好是
    // TUI 输入行、用户拖放的落点）。若 drop 默认行为没被上层拦掉，Chrome 会把 text/plain
    // 原生插进这个 textarea——xterm 只认 insertText，不处理 insertFromDrop、也不清值，
    // 残留路径随后会被中文输入法(keydown 229)的差分逻辑整段重放进终端，淹没正在输入的字。
    // 这里对容器内所有 drop 统一 preventDefault（不拦冒泡，上层注入 @路径/上传照常）并清残值。
    const onDropGuard = (e: DragEvent) => {
      e.preventDefault()
      if (textarea && !composing) textarea.value = ''
    }
    el.addEventListener('drop', onDropGuard)

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
      el.removeEventListener('mousedown', onMouseDownCapture, { capture: true } as any)
      el.removeEventListener('mouseup', onMouseUp)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('contextmenu', onCtx)
      el.removeEventListener('paste', onPasteCapture, { capture: true } as any)
      el.removeEventListener('drop', onDropGuard)
      if (textarea) {
        textarea.removeEventListener('compositionstart', onCompStart)
        textarea.removeEventListener('compositionend', onCompEnd)
      }
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

  // 切回该标签：display 从 none → block，需在浏览器完成布局后再 fit。单次 setTimeout 易踩竞态，
  // 用 rAF 连续重试几帧，确保可见终端按真实宽度铺满（修复"会话变窄条"）。
  useEffect(() => {
    if (!active) return
    let raf = 0, n = 0
    const tick = () => { sendResize(); if (n === 0) termRef.current?.focus(); if (++n < 4) raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  return <div ref={elRef} style={{ width: '100%', height: '100%' }} />
})

export default Term
