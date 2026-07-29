import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { CSSProperties, TouchEvent as RTouchEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
// 版本必须与 @xterm/xterm 主版本配对（本仓库 xterm 5.5 → addon-webgl 0.18.x，peerDeps 写的 ^5）。
// 0.19+ 是给 xterm 6 内核的：卸载时读 `_core._store._isDisposed` 判断内核有没有拆，
// 5.5 内核根本没有 `_store` → 每次拆终端必抛 TypeError（升级前先确认这个字段还在）。
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
// 终端符号补字集（约 46KB，仅覆盖框线/箭头/技术符号等区段）：见 FONT_FAMILY 的说明
import './assets/fonts/roam-symbols.css'

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
  // 尺寸抖动(cols−1→cols)触发两次 SIGWINCH，逼全屏 TUI 整屏重排重绘。
  // 窄屏(手机)下 Claude Code 等 ink TUI 折行重绘错位会满屏堆叠垃圾行，等价于「拖一下窗口就好了」。
  redraw: () => void
}

// ── 渲染器坏掉时的自救 ─────────────────────────────────────────────────────
// 终端「字糊成小点 / 几乎全没了、只剩残影」这类故障出在**本地渲染器**：WebGL 渲染器把字形
// 烤进纹理图集(texture atlas)，图集或画布状态一旦坏掉，后端再画一遍也没用——tmux 送来的还是
// 同样的字符，只是本地把它们画丢了。所以「重绘(SIGWINCH)」「重连(WebSocket)」都救不回来，
// 用户只能刷新整页。下面两处专治这个：
//   1. dpr 变化（桌面浏览器缩放/换显示器、手机页面缩放）后重建渲染器——xterm 在这条路径上
//      要按新 dpr 重建图集和画布，是已知的易碎点；
//   2. 「重连」升级成整机重建（拆掉 xterm 实例重新 open + 重新 attach），等价于刷新整页，
//      但只重建这一个标签、不动其它会话。
// 出问题时可在控制台执行 __roamTermDiag() 把渲染状态打出来（见文件末尾）。
const liveTerms = new Set<{ name: string; term: Terminal; el: HTMLDivElement | null; webgl: () => boolean }>()

// 符号补字集整页只预热一次：纹理图集是**所有终端共用**的（xterm 按字体/字号/dpr/配色做 key），
// 每开一个标签就 clearTextureAtlas() 一次，等于把其它终端已缓存的字形反复作废，纯属白干。
let fontsWarmed: Promise<void> | undefined
let atlasClearedForFonts = false

// 终端字体栈：正文一律用各平台的系统默认等宽字体（mac→SF Mono/Menlo、Windows→Consolas、
// Linux/Android→系统 monospace），不自带正文字体。
// 唯一自带的是 "Roam Symbols"——只覆盖框线/箭头/技术符号等区段的补字集（见 assets/fonts）。
// 它排在通用 monospace 之前，是为了兜住系统等宽字体缺的那些符号：缺字会回退到彩色 emoji 一类
// 非等宽字体，字形宽度 ≠ 单元格宽度，误差沿行累积就是「同一行后半段错位、字形互相压盖」。
// 剩下确实超宽的字形（emoji 等）由 rescaleOverlappingGlyphs 压回单元格（需 WebGL 渲染器）。
const FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Roam Symbols", monospace'

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

// 终端单元格坐标（0 基，含端点）
type Cell = { col: number; row: number }
const cmpCell = (a: Cell, b: Cell) => a.row - b.row || a.col - b.col

// 触摸长按选词的分词符（近似 xterm 双击选词 wordSeparator 的缺省值）
const WORD_SEPS = new Set([' ', '\t', '(', ')', '[', ']', '{', '}', "'", '"', '`', ',', ';', '|'])

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
  const webglRef = useRef<WebglAddon>()
  // 自增一次 = 拆掉 xterm 实例重建（渲染器/纹理图集/WebSocket 全新），效果等同刷新整页
  const [gen, setGen] = useState(0)

  // 已上报给后端的尺寸。相同尺寸重复上报没有意义，却会让后端 Setsize → SIGWINCH →
  // tmux 整屏重排 → 肉眼一闪，所以这里做去重闸门。新连接时清零以强制重报（新 tmux 客户端要知道尺寸）。
  const lastSent = useRef({ cols: 0, rows: 0 })
  const resizeTimer = useRef<any>()

  const applyResize = () => {
    const t = termRef.current, ws = wsRef.current, fit = fitRef.current, el = elRef.current
    if (!t || !fit || !el) return
    // 未激活的标签是 display:none、尺寸为 0：此时 fit 拿不到真实宽度，会让终端停在默认 80 列，
    // tmux 便渲染成左侧窄条。隐藏或尚未布局时跳过，等可见(切回标签)再 fit。
    if (el.offsetParent === null || el.clientWidth === 0 || el.clientHeight === 0) return
    try {
      const dims = fit.proposeDimensions()
      if (!dims || !isFinite(dims.cols) || !isFinite(dims.rows) || dims.cols < 2 || dims.rows < 2) return
      fit.fit()
      if (!ws || ws.readyState !== 1) return
      if (t.cols === lastSent.current.cols && t.rows === lastSent.current.rows) return
      lastSent.current = { cols: t.cols, rows: t.rows }
      ws.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }))
    } catch {}
  }

  // 高频尺寸变化合并成一次。手机上触发源极密集：软键盘弹出/收起的动画每帧一次、地址栏随页面
  // 滚动收缩展开、横竖屏旋转，逐帧上报会让 tmux 连续整屏重排（就是用户看到的持续闪烁）。
  const scheduleResize = (delay = 150) => {
    clearTimeout(resizeTimer.current)
    resizeTimer.current = setTimeout(applyResize, delay)
  }

  // 滚动会话历史：attach 是全屏、xterm 本地缓冲为空，统一交后端处理——
  // 普通屏走 tmux copy-mode，备用屏(全屏 TUI)由后端合成滚轮序列喂给应用滚自己的缓冲。
  const sendScroll = (dir: string, lines: number) => {
    const ws = wsRef.current
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'scroll', dir, lines }))
  }

  // 单元格像素尺寸：优先取 xterm 渲染器的真实值（私有 API，升级失效则回退按容器等分——
  // 容器右/下常留半格空白，等分会向右下略漂）
  const cellSize = () => {
    const t = termRef.current, el = elRef.current
    if (!t || !el || t.cols <= 0 || t.rows <= 0) return null
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const cell = (t as any)._core?._renderService?.dimensions?.css?.cell
    if (cell?.width > 0 && cell?.height > 0) return { rect, cw: cell.width as number, ch: cell.height as number }
    return { rect, cw: rect.width / t.cols, ch: rect.height / t.rows }
  }

  // 视口像素坐标 → 终端单元格坐标（与 tmux 窗口坐标一致）
  const cellAt = (clientX: number, clientY: number): Cell | null => {
    const t = termRef.current, m = cellSize()
    if (!t || !m) return null
    return {
      col: Math.max(0, Math.min(t.cols - 1, Math.floor((clientX - m.rect.left) / m.cw))),
      row: Math.max(0, Math.min(t.rows - 1, Math.floor((clientY - m.rect.top) / m.ch))),
    }
  }

  // 上次 attach 成功时的尺寸，用于判断重连后是否真需要抖动重绘（见 ws.onopen）
  const lastAttach = useRef<{ cols: number; rows: number } | null>(null)

  // 尺寸抖动重绘：cols−1 再复原，两次 SIGWINCH 让 TUI(ink) 整屏重排、清掉错位堆积的垃圾行。
  // 后端 resize 有 cols<20 保护，抖动后一定复原到真实尺寸。
  const jiggleResize = () => {
    const t = termRef.current, ws = wsRef.current
    if (!t || !ws || ws.readyState !== 1 || t.cols <= 21 || t.rows < 6) return
    ws.send(JSON.stringify({ type: 'resize', cols: t.cols - 1, rows: t.rows }))
    setTimeout(() => {
      const t2 = termRef.current, ws2 = wsRef.current
      if (!t2 || !ws2 || ws2.readyState !== 1) return
      ws2.send(JSON.stringify({ type: 'resize', cols: t2.cols, rows: t2.rows }))
    }, 150)
  }

  const selectPaneAtClient = (clientX: number, clientY: number) => {
    const ws = wsRef.current, cell = cellAt(clientX, clientY)
    if (!cell || !ws || ws.readyState !== 1) return
    ws.send(JSON.stringify({ type: 'select-pane', ...cell }))
  }
  const selectPaneAt = (e: MouseEvent) => { if (e.button === 0) selectPaneAtClient(e.clientX, e.clientY) }

  // 单击/轻点把远端光标移到点按的格子：镜像终端的光标在远端 TUI/shell 手里，点击本身移不动
  // （此前只能靠丝带/键盘方向键一格格挪）。后端按 tmux 真实光标位置合成方向键，
  // 对齐原生输入框「点哪光标到哪」的体验。
  const sendMoveCursor = (clientX: number, clientY: number) => {
    const t = termRef.current, ws = wsRef.current, cell = cellAt(clientX, clientY)
    if (!t || !cell || !ws || ws.readyState !== 1) return
    // 本地视口不在底部时行号对不上远端屏幕坐标（正常不会发生：滚动都交后端）
    if (t.buffer.active.viewportY !== t.buffer.active.baseY) return
    ws.send(JSON.stringify({ type: 'move-cursor', ...cell }))
  }

  // ── 触摸选区：手机长按选词 → 按住拖动扩选 → 松手自动复制，随后留手柄微调 ──
  // xterm 自身不处理触摸，且 touchmove 被滚动手势独占，手机上原本完全无法选中终端文本。
  const [handles, setHandles] = useState<{ sx: number; sy: number; ex: number; ey: number } | null>(null)
  const touchRangeRef = useRef<{ start: Cell; end: Cell } | null>(null)
  const suppressCtx = useRef(0) // 长按选词/拖手柄期间，屏蔽长按呼出的 contextmenu 菜单

  const applyTouchRange = (r: { start: Cell; end: Cell }) => {
    const t = termRef.current
    if (!t) return
    const len = (r.end.row - r.start.row) * t.cols + (r.end.col - r.start.col) + 1
    if (len <= 0) return
    touchRangeRef.current = r
    t.select(r.start.col, t.buffer.active.viewportY + r.start.row, len)
  }

  const updateHandles = () => {
    const m = cellSize(), r = touchRangeRef.current
    if (!m || !r) { setHandles(null); return }
    setHandles({
      sx: r.start.col * m.cw, sy: (r.start.row + 1) * m.ch,
      ex: (r.end.col + 1) * m.cw, ey: (r.end.row + 1) * m.ch,
    })
  }

  const clearTouchSel = () => {
    touchRangeRef.current = null
    setHandles(null)
    termRef.current?.clearSelection()
  }

  // 长按点位所在的「词」：以分词符为界向两侧扩展。宽字符(CJK)右半格 getWidth()=0，归属左边字符
  const wordRangeAt = (cell: Cell): { start: Cell; end: Cell } => {
    const t = termRef.current
    const line = t?.buffer.active.getLine(t.buffer.active.viewportY + cell.row)
    if (!t || !line) return { start: cell, end: cell }
    const isWord = (x: number) => {
      const c = line.getCell(x)
      if (!c) return false
      if (c.getWidth() === 0) return true
      const s = c.getChars()
      return !!s && !WORD_SEPS.has(s)
    }
    if (!isWord(cell.col)) return { start: cell, end: cell }
    let s = cell.col, e = cell.col
    while (s > 0 && isWord(s - 1)) s--
    while (e < t.cols - 1 && isWord(e + 1)) e++
    return { start: { col: s, row: cell.row }, end: { col: e, row: cell.row } }
  }

  // 拖选区手柄微调：固定另一端、跟随手指重选，松手自动复制（原生手机文本选择体验）
  const dragHandle = (which: 'start' | 'end') => (e: RTouchEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const r0 = touchRangeRef.current
    if (!r0) return
    const fixed = which === 'start' ? r0.end : r0.start
    suppressCtx.current = performance.now() + 1500
    const onMove = (ev: TouchEvent) => {
      ev.preventDefault()
      const cell = cellAt(ev.touches[0].clientX, ev.touches[0].clientY)
      if (!cell) return
      applyTouchRange(cmpCell(cell, fixed) < 0 ? { start: cell, end: fixed } : { start: fixed, end: cell })
      updateHandles()
      suppressCtx.current = performance.now() + 1500
    }
    const onEnd = () => {
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
      const sel = termRef.current?.getSelection() || ''
      if (sel.trim()) onSelectionMenu?.({ x: 0, y: 0, selection: sel })
    }
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onEnd)
    window.addEventListener('touchcancel', onEnd)
  }

  const connect = () => {
    if (unmounted.current) return
    onStatus?.('connecting')
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    // 带上当前尺寸：后端据此建 pty，tmux attach 首帧就按真实尺寸画，省掉「先按 80x24 画完再跳一次」
    const t0 = termRef.current
    const q = t0 && t0.cols > 1 && t0.rows > 1 ? `?cols=${t0.cols}&rows=${t0.rows}` : ''
    const ws = new WebSocket(`${proto}://${location.host}/api/term/${encodeURIComponent(name)}${q}`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws
    ws.onopen = () => {
      onStatus?.('connected'); termRef.current?.focus()
      lastSent.current = { cols: 0, rows: 0 } // 新 tmux 客户端要重新告知尺寸，绕过去重闸门
      applyResize()
      // attach 尺寸常与上个客户端不同(桌面↔手机)，宽行重折行会在 TUI 屏上留错位垃圾；
      // 等首次 resize 生效后自动抖动重绘一次，进来就是干净画面。
      // 但尺寸与上次 attach 相同时不抖：手机切后台/锁屏/网络抖动会频繁断线重连，
      // 每次都抖两下 SIGWINCH 就成了周期性闪烁，而同尺寸重连本来就没有折行垃圾要清。
      setTimeout(() => {
        const t = termRef.current
        if (!t) return
        const prev = lastAttach.current
        lastAttach.current = { cols: t.cols, rows: t.rows }
        if (prev && prev.cols === t.cols && prev.rows === t.rows) return
        jiggleResize()
      }, 600)
    }
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
    fit: () => applyResize(),
    copy: () => {
      const sel = termRef.current?.getSelection() || ''
      if (sel) copyText(sel)
      return !!sel
    },
    selection: () => termRef.current?.getSelection() || '',
    clearSelection: () => termRef.current?.clearSelection(),
    // 「重连」= 把这个标签整个重建：拆掉 xterm 实例（渲染器/纹理图集一并丢弃）再重新 open +
    // 重新 attach。等价于刷新整页，但只重建这一个会话。渲染器坏掉导致的「字糊/字没了」
    // 只有这一招能救——重绘(SIGWINCH)和单纯重连 WebSocket 都改不了本地图集。
    reconnect: () => setGen((g) => g + 1),
    scroll: (lines) => sendScroll(lines < 0 ? 'up' : 'down', Math.abs(lines)),
    toBottom: () => sendScroll('bottom', 0),
    selectPaneAt: (clientX, clientY) => selectPaneAtClient(clientX, clientY),
    redraw: () => jiggleResize(),
  }))

  useEffect(() => {
    unmounted.current = false
    const term = new Terminal({
      fontSize,
      cursorBlink: true,
      scrollback: 5000,
      fontFamily: FONT_FAMILY,
      // emoji / powerline / nerd 字形常比单元格宽，会压到右邻格上（手机上尤其明显，因为很多
      // 字形来自非等宽的回退字体）。开启后 xterm 把超宽字形横向压回单元格。仅对 WebGL/Canvas
      // 渲染器生效，DOM 渲染器下无效——所以下面必须把 WebGL 渲染器挂上。
      rescaleOverlappingGlyphs: true,
      theme: xtermTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(elRef.current!)
    termRef.current = term
    fitRef.current = fit
    const diagEntry = { name, term, el: elRef.current, webgl: () => !!webglRef.current }
    liveTerms.add(diagEntry)

    // WebGL 渲染器：默认的 DOM 渲染器每格一个 span，单元格宽是分数像素，手机 dpr 常为 2.625/3
    // 这类非整数，亚像素误差累积会裁字/叠字，整屏重绘也更容易看到闪烁。WebGL 按纹理网格绘制，
    // 顺带让 rescaleOverlappingGlyphs 生效。
    // 上下文丢失（后台切回/GPU 回收/同页 WebGL 上下文超上限被回收最老的那个）时**先试着重建**，
    // 连着重建都失败才退回 DOM 渲染器——旧写法一丢就永久 dispose，此后这个标签一直是降级渲染。
    let lostAt = 0
    const mountWebgl = () => {
      if (unmounted.current) return
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          try { webgl.dispose() } catch {}
          webglRef.current = undefined
          const now = performance.now()
          // 10s 内又丢一次 = 这台机器/这个页面的 WebGL 不稳，别再来回折腾，就用 DOM 渲染器
          if (now - lostAt < 10000) return
          lostAt = now
          setTimeout(() => { if (!unmounted.current && termRef.current === term) mountWebgl() }, 500)
        })
        term.loadAddon(webgl)
        webglRef.current = webgl
      } catch { /* 不支持 WebGL 的浏览器继续用 DOM 渲染器 */ }
    }
    mountWebgl()

    // 渲染器就地重建：拆掉 WebGL addon 再挂一个新的，纹理图集/画布随之重建，然后整屏重画。
    // 不重连、不动后端，只修「本地画丢了」这一类故障。
    const rebuildRenderer = () => {
      if (unmounted.current || termRef.current !== term) return
      try { webglRef.current?.dispose() } catch {}
      webglRef.current = undefined
      mountWebgl()
      applyResize()
      try { term.refresh(0, term.rows - 1) } catch {}
    }

    // dpr 变化（桌面浏览器缩放 Ctrl+± / 拖到另一块缩放比不同的屏、手机页面缩放/横竖屏）：
    // xterm 要按新 dpr 重建纹理图集与画布，这条路径上偶发整屏画空，且后端重绘救不回来。
    // matchMedia 的 resolution 查询只对「当前这个 dpr」成立，所以每次变化后要重新挂一条。
    let dprMq: MediaQueryList | undefined
    const armDprWatch = () => {
      try {
        dprMq?.removeEventListener('change', onDpr)
        dprMq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
        dprMq.addEventListener('change', onDpr)
      } catch {}
    }
    const onDpr = () => {
      armDprWatch()
      // 等 xterm 自己那套 dpr 处理跑完再重建，避免和它抢同一帧
      setTimeout(rebuildRenderer, 120)
    }
    armDprWatch()

    // 切后台再回来（手机上最常见：用一会 → 回桌面/切 App → 过一阵再回来 → 整屏花）。
    // 后台标签的 GPU 资源会被系统回收，纹理图集/画布随之作废；回到前台时 xterm 不一定收得到
    // contextlost（安卓上常常是「画布还在、内容是坏的」），于是没人来修，用户只能刷新整页。
    // 这里在回前台时主动重建一次渲染器再整屏重画。只在真的离开过一会儿才做：短暂切窗口
    // （<1.5s）画面还好好的，重建纯属浪费还会闪一下。
    let hiddenAt = 0
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = performance.now(); return }
      if (!hiddenAt) return
      const away = performance.now() - hiddenAt
      hiddenAt = 0
      if (away > 1500) setTimeout(rebuildRenderer, 60)
    }
    document.addEventListener('visibilitychange', onVisibility)
    // 从 bfcache 恢复（安卓返回键、iOS 侧滑返回）不一定走 visibilitychange，单独兜一次
    const onPageShow = (e: PageTransitionEvent) => { if (e.persisted) setTimeout(rebuildRenderer, 60) }
    window.addEventListener('pageshow', onPageShow)

    setTimeout(() => { try { fit.fit() } catch {} }, 0)

    // 预热符号补字集。两点必须注意：
    //   1. 带 unicode-range 的 webfont 是「按需加载」的，而 WebGL/Canvas 渲染器是把字形画进
    //      纹理图集，canvas 绘制**不会**触发这种按需下载——不显式 load 的话符号永远是 tofu，
    //      document.fonts.ready 也会立刻 resolve（它只等已经在下载的字体）。
    //   2. 每个 @font-face 各自按 unicode-range 匹配，所以要给出覆盖两个面的字符。
    if (!fontsWarmed) {
      fontsWarmed = document.fonts
        ? Promise.all([
          document.fonts.load(`${fontSize}px "Roam Symbols"`, '─'),  // 框线/箭头/几何 那一面
          document.fonts.load(`${fontSize}px "Roam Symbols"`, '⏵'),  // 技术/杂项/装饰符号 那一面
        ]).then(() => document.fonts.ready).then(() => {})
        : Promise.resolve()
    }
    fontsWarmed.then(() => {
      if (unmounted.current) return
      // 字体到位后清一次纹理图集重画，否则之前用回退字体量出的字形会一直错到下次刷新。
      // 只清这一次：图集是全页共用的，后开的标签再清就是把别人已缓存的字形白白作废。
      if (!atlasClearedForFonts) {
        atlasClearedForFonts = true
        try { term.clearTextureAtlas() } catch {}
      }
      applyResize()
    }).catch(() => {})

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
    const onViewportChange = () => scheduleResize()
    const ro = new ResizeObserver(onViewportChange)
    if (elRef.current) ro.observe(elRef.current)
    window.addEventListener('resize', onViewportChange)
    // 手机软键盘弹收 / 地址栏收缩只改 visualViewport，不一定触发上面两个；统一走同一个防抖入口，
    // 保证一次手势最终只上报一次尺寸。
    window.visualViewport?.addEventListener('resize', onViewportChange)

    // 滚动会话历史：触摸滑动 + 鼠标滚轮 → 发 scroll 控制（后端按普通屏/备用屏分流，见 sendScroll）
    const el = elRef.current!
    let lastY = 0
    let acc = 0
    const lineH = () => (termRef.current?.options.fontSize || 13) * 1.3
    // 轻点/单击(非拖选)判定用：起点坐标 + 触屏结束时间(去重触屏后浏览器补发的合成 mouse 事件)
    let tapStart: { x: number; y: number } | null = null
    let mouseDownAt: { x: number; y: number } | null = null
    let lastTouchEndAt = 0
    // 长按选词手势：400ms 未移动进入，之后 touchmove 变扩选、touchend 自动复制
    let lpTimer: any = null
    let touchSelecting = false
    let selAnchor: { start: Cell; end: Cell } | null = null
    const onTS = (e: TouchEvent) => {
      lastY = e.touches[0].clientY; acc = 0
      clearTimeout(lpTimer)
      tapStart = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null
      if (tapStart) {
        const { x, y } = tapStart
        lpTimer = setTimeout(() => {
          const cell = cellAt(x, y)
          if (!cell) return
          touchSelecting = true
          suppressCtx.current = performance.now() + 1500
          try { navigator.vibrate?.(15) } catch {}
          selAnchor = wordRangeAt(cell)
          applyTouchRange(selAnchor)
        }, 400)
      }
      // 触摸目标(xterm 内层 span/decoration)在手势中途被重绘移除时，后续 touchmove/touchend
      // 仍派发到已脱离的旧节点、不再冒泡到容器——手势断在半路（长按松手不复制、滚动卡住）。
      // 终端常态在重绘(TUI spinner)，这里在目标上补挂监听，仅当目标已脱离(冒泡断链)时代为转发。
      const tgt = e.target as HTMLElement | null
      if (tgt && tgt !== el) {
        const cleanup = () => {
          tgt.removeEventListener('touchmove', fm)
          tgt.removeEventListener('touchend', fe)
          tgt.removeEventListener('touchcancel', fc)
        }
        const fm = (ev: TouchEvent) => { if (!el.contains(tgt)) onTM(ev) }
        const fe = (ev: TouchEvent) => { if (!el.contains(tgt)) onTouchEnd(ev); cleanup() }
        const fc = () => { if (!el.contains(tgt)) onTouchCancel(); cleanup() }
        tgt.addEventListener('touchmove', fm, { passive: false })
        tgt.addEventListener('touchend', fe)
        tgt.addEventListener('touchcancel', fc)
      }
    }
    // 捕获阶段 + stopPropagation：开了 tmux mouse 后，xterm 会把滚轮/触摸转成
    // 鼠标事件发给 tmux，与我们的 copy-mode 滚动重复。这里抢先独占，避免双重滚动。
    const onTM = (e: TouchEvent) => {
      const x = e.touches[0].clientX, y = e.touches[0].clientY
      if (touchSelecting) {
        // 长按选词后不抬手直接拖：从锚点词向两侧扩选（跟随手指，不再滚动）
        const cell = cellAt(x, y)
        if (cell && selAnchor) {
          applyTouchRange(cmpCell(cell, selAnchor.start) < 0 ? { start: cell, end: selAnchor.end }
            : cmpCell(cell, selAnchor.end) > 0 ? { start: selAnchor.start, end: cell } : selAnchor)
        }
        e.preventDefault(); e.stopPropagation()
        return
      }
      if (tapStart && Math.hypot(x - tapStart.x, y - tapStart.y) > 10) clearTimeout(lpTimer) // 明显位移=滚动，取消长按
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
      if (sel.trim()) {
        onSelectionMenu?.({ x: e.clientX, y: e.clientY, selection: sel })
        mouseDownAt = null
        return
      }
      // 左键单击(无拖选、无修饰键、几乎未移动) → 移光标到点按处；触屏 tap 已在 touchend 处理，
      // 靠时间窗滤掉其后补发的合成 mouseup，避免重复移动。
      if (e.button === 0 && mouseDownAt && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
        && performance.now() - lastTouchEndAt > 700
        && Math.abs(e.clientX - mouseDownAt.x) < 5 && Math.abs(e.clientY - mouseDownAt.y) < 5) {
        sendMoveCursor(e.clientX, e.clientY)
      }
      mouseDownAt = null
    }
    const onTouchEnd = (e: TouchEvent) => {
      clearTimeout(lpTimer)
      lastTouchEndAt = performance.now()
      const sel = termRef.current?.getSelection() || ''
      const t = e.changedTouches[0]
      if (touchSelecting) {
        // 长按选区手势结束：有选中即自动复制（同桌面拖选），并留下手柄供微调
        touchSelecting = false
        selAnchor = null
        if (sel.trim() && t) { onSelectionMenu?.({ x: t.clientX, y: t.clientY, selection: sel }); updateHandles() }
        else clearTouchSel()
        tapStart = null
        return
      }
      if (sel.trim()) {
        // 已有选区时点按空白：仅清除选区/手柄，不复制不移光标（原生输入框行为）
        clearTouchSel()
        tapStart = null
        return
      }
      // 单指轻点(所有手指已离屏、几乎未移动、无选区) → 移光标到点按处
      if (t && tapStart && e.touches.length === 0
        && Math.hypot(t.clientX - tapStart.x, t.clientY - tapStart.y) < 12) {
        sendMoveCursor(t.clientX, t.clientY)
      }
      tapStart = null
    }
    const onTouchCancel = () => { clearTimeout(lpTimer); touchSelecting = false; selAnchor = null }
    // 右键改为 Roam 菜单：有选区时优先复制；无选区时提供粘贴/重连/tmux 常用动作。
    const onCtx = (e: MouseEvent) => {
      e.preventDefault()
      // 触屏长按已是「选词」手势，屏蔽随之而来的 contextmenu，避免菜单盖住选区
      if (touchSelecting || performance.now() < suppressCtx.current) return
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
      if (e.button === 1) {
        // 中键粘贴，对齐 Linux 终端习惯：拖选已自动进剪贴板，中键≈primary selection 粘贴。
        // 点哪先激活哪个 pane 再贴（X11 point-to-paste）；preventDefault 拦掉浏览器中键自动滚屏。
        e.preventDefault()
        e.stopPropagation()
        selectPaneAtClient(e.clientX, e.clientY)
        onPaste?.()
        return
      }
      if (e.button === 0) mouseDownAt = { x: e.clientX, y: e.clientY }
      selectPaneAt(e)
    }
    el.addEventListener('touchstart', onTS, { passive: true, capture: true })
    el.addEventListener('touchmove', onTM, { passive: false, capture: true })
    el.addEventListener('wheel', onWheel, { passive: false, capture: true })
    el.addEventListener('mousedown', onMouseDownCapture, { capture: true })
    el.addEventListener('mouseup', onMouseUp)
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchCancel)
    el.addEventListener('contextmenu', onCtx)
    // 选区被外部清掉（重连/resize/复制后 clearSelection 等）时，同步撤掉触摸手柄
    const selDisp = term.onSelectionChange(() => {
      if (touchRangeRef.current && !term.hasSelection()) { touchRangeRef.current = null; setHandles(null) }
    })
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
      window.removeEventListener('resize', onViewportChange)
      window.visualViewport?.removeEventListener('resize', onViewportChange)
      clearTimeout(resizeTimer.current)
      el.removeEventListener('touchstart', onTS, { capture: true } as any)
      el.removeEventListener('touchmove', onTM, { capture: true } as any)
      el.removeEventListener('wheel', onWheel, { capture: true } as any)
      el.removeEventListener('mousedown', onMouseDownCapture, { capture: true } as any)
      el.removeEventListener('mouseup', onMouseUp)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchCancel)
      el.removeEventListener('contextmenu', onCtx)
      clearTimeout(lpTimer)
      selDisp.dispose()
      el.removeEventListener('paste', onPasteCapture, { capture: true } as any)
      el.removeEventListener('drop', onDropGuard)
      if (textarea) {
        textarea.removeEventListener('compositionstart', onCompStart)
        textarea.removeEventListener('compositionend', onCompEnd)
      }
      dataDisp.dispose()
      try { dprMq?.removeEventListener('change', onDpr) } catch {}
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', onPageShow)
      liveTerms.delete(diagEntry)
      try { wsRef.current?.close() } catch {}
      // 拆终端务必吞异常：这里是 React 的 effect cleanup，抛出去会顺着卸载流程把整棵树炸掉
      // （整页黑屏，而不只是这一个标签坏掉）。xterm 的 WebGL addon 就踩过——它按新版内核的
      // 私有字段做卸载判断，配到旧内核上必抛 TypeError，于是「关一个会话/改一次名」就黑屏。
      // 先单独拆 WebGL addon，再拆终端本体，各自兜住，任一步失败都不影响另一步和其他标签。
      try { webglRef.current?.dispose() } catch {}
      webglRef.current = undefined
      try { term.dispose() } catch {}
    }
    // gen 变化 = 整机重建（见 TermHandle.reconnect）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, gen])

  useEffect(() => {
    const t = termRef.current
    if (t) { t.options.fontSize = fontSize; setTimeout(applyResize, 0) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize])

  // 切回该标签：display 从 none → block，需在浏览器完成布局后再 fit。单次 setTimeout 易踩竞态，
  // 用 rAF 连续重试几帧，确保可见终端按真实宽度铺满（修复"会话变窄条"）。
  useEffect(() => {
    if (!active) return
    let raf = 0, n = 0
    // applyResize 自带尺寸去重，连打几帧只会真发一次
    const tick = () => { applyResize(); if (n === 0) termRef.current?.focus(); if (++n < 4) raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // 触摸选区手柄（Android 风格泪滴）：start 挂在选区首字符左下、end 挂在末字符右下，可拖动微调
  const handleStyle = (which: 'start' | 'end'): CSSProperties => ({
    position: 'absolute',
    left: which === 'start' ? (handles?.sx ?? 0) - 22 : handles?.ex ?? 0,
    top: (which === 'start' ? handles?.sy : handles?.ey) ?? 0,
    width: 22, height: 22, zIndex: 6, touchAction: 'none',
    background: '#58a6ff',
    border: '1.5px solid rgba(255,255,255,.9)',
    boxShadow: '0 1px 4px rgba(0,0,0,.4)',
    borderRadius: which === 'start' ? '50% 0 50% 50%' : '0 50% 50% 50%',
  })
  return (
    // isolation:isolate —— 必须有。xterm 内部的画布层(.xterm-link-layer 等)带正 z-index，而本容器
    // 只是 position:relative（z-index:auto 不成层叠上下文），那些画布就会「逃」到外层去，压在同级
    // 后面的兄弟节点之上：Claude/Codex 对话面板正是这样被一层**透明**画布盖住的——看得见、点不着，
    // 表现为对话区滑不动历史、发送/停止按不动（画布吃掉了所有 pointer/touch）。isolate 把这些
    // z-index 关回终端自己这一层，覆盖层就能正常接事件。
    <div style={{ position: 'relative', width: '100%', height: '100%', isolation: 'isolate', WebkitTouchCallout: 'none' } as CSSProperties}>
      <div ref={elRef} style={{ width: '100%', height: '100%' }} />
      {handles && (['start', 'end'] as const).map((which) => (
        <div key={which} onTouchStart={dragHandle(which)} style={handleStyle(which)} />
      ))}
    </div>
  )
})

// 渲染故障排查用：终端画糊/画空时在浏览器控制台执行 __roamTermDiag()，把每个终端的渲染状态
// （渲染器类型、dpr、单元格与画布尺寸、行列数、字形是否还在图集里）打出来。纯调试接口，无 UI 文案。
;(window as any).__roamTermDiag = () => [...liveTerms].map(({ name, term, el, webgl }) => {
  const core: any = (term as any)._core
  const dims = core?._renderService?.dimensions
  const canvases = el ? [...el.querySelectorAll('canvas')].map((c) => `${c.width}x${c.height} css ${c.style.width}x${c.style.height}`) : []
  return {
    name,
    renderer: webgl() ? 'webgl' : (el?.querySelector('.xterm-rows') ? 'dom' : 'unknown'),
    dpr: window.devicePixelRatio,
    cols: term.cols,
    rows: term.rows,
    fontSize: term.options.fontSize,
    cssCell: dims?.css?.cell,
    deviceCell: dims?.device?.cell,
    deviceCanvas: dims?.device?.canvas,
    canvases,
    clientSize: el ? `${el.clientWidth}x${el.clientHeight}` : '',
    viewportY: term.buffer.active.viewportY,
    baseY: term.buffer.active.baseY,
  }
})

export default Term
