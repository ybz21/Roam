// 浏览器镜像页：把后端全局 Chrome 的画面实时渲染到 <img>，可选「接管」转发输入。
// 协议见 backend/browser/screencast.go：
//   收 {type:'frame', data, w, h} | {type:'pong', t} | {type:'error', msg}
//   发 {type:'nav', url} | {type:'ping', t} | {type:'mouse'|'wheel'|'key', ...}（输入仅 control=1 生效）
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Space, Tag, App as AntApp } from 'antd'
import { api } from './api'

interface TabInfo { id: string; title: string; url: string }

// 单个标签：固定宽度 + 关闭按钮常驻（active 仅改颜色，不改尺寸 → 切换不回流/不易位）
function BrowserTab({ tab, active, onSelect, onClose }: {
  tab: TabInfo; active: boolean; onSelect: () => void; onClose: () => void
}) {
  return (
    <div
      onClick={onSelect}
      title={tab.url}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, width: 150, flex: '0 0 auto', height: 28,
        padding: '0 8px', borderRadius: 6, cursor: 'pointer', userSelect: 'none', fontSize: 12,
        background: active ? '#283039' : 'transparent',
        color: active ? 'var(--text-bright)' : '#9aa4ae',
        border: '1px solid ' + (active ? '#3d444d' : 'transparent'),
      }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {tab.title || tab.url || 'about:blank'}
      </span>
      <span
        onClick={(e) => { e.stopPropagation(); onClose() }}
        onMouseDown={(e) => e.stopPropagation()}
        style={{ flex: '0 0 auto', width: 16, height: 16, lineHeight: '15px', textAlign: 'center', borderRadius: 4, color: 'var(--text-dim)' }}
      >×</span>
    </div>
  )
}

// 标签栏：左=可横向滚动的标签 + 新建，右=固定区域(extra)。两侧宽度独立，互不挤占。
function TabBar({ tabs, active, onSelect, onClose, onAdd, extra }: {
  tabs: TabInfo[]; active: string
  onSelect: (id: string) => void; onClose: (id: string) => void; onAdd: () => void; extra: ReactNode
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px 0', flex: '0 0 auto' }}>
      <div style={{ display: 'flex', gap: 4, overflowX: 'auto', flex: 1, minWidth: 0 }}>
        {tabs.map((t) => (
          <BrowserTab key={t.id} tab={t} active={t.id === active} onSelect={() => onSelect(t.id)} onClose={() => onClose(t.id)} />
        ))}
        <button
          onClick={onAdd}
          title="新建标签"
          style={{ flex: '0 0 auto', width: 28, height: 28, border: 'none', background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 16, borderRadius: 6 }}
        >+</button>
      </div>
      <div style={{ flex: '0 0 auto' }}>{extra}</div>
    </div>
  )
}

// 清晰度档位（栏目级配置，存 localStorage）。'auto'=自适应，数字=固定 JPEG 质量
type Quality = number | 'auto'
const QKEY = 'ttmux.browser.quality'
const RKEY = 'ttmux.browser.rotate' // 画面旋转角度（0/90/180/270），手机竖屏看横屏用
const QUALITY_OPTS: { label: string; value: Quality }[] = [
  { label: '自动', value: 'auto' },
  { label: '标清', value: 50 },
  { label: '高清', value: 80 },
  { label: '超清', value: 92 },
]

function fmtRate(bytesPerSec: number) {
  if (bytesPerSec >= 1 << 20) return (bytesPerSec / (1 << 20)).toFixed(1) + ' MB/s'
  return Math.round(bytesPerSec / 1024) + ' KB/s'
}

// 地址栏自适应 http/https：本机/内网地址默认 http，其余默认 https。
// 已带 scheme 的原样返回；避免内网 IP / localhost 被强转 https 连不上。
function smartUrl(input: string): string {
  const s = input.trim()
  if (/^[a-z]+:\/\//i.test(s)) return s            // 已有 http(s):// 等协议，尊重用户
  const host = s.split('/')[0].split(':')[0].toLowerCase()
  const local =
    host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' ||
    host.endsWith('.local') ||                       // .local 局域网域名（mDNS）
    /^10\./.test(host) ||                            // 10.0.0.0/8
    /^192\.168\./.test(host) ||                      // 192.168.0.0/16
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)          // 172.16.0.0/12
  return (local ? 'http://' : 'https://') + s
}

// 固定宽度数字槽：右对齐 + 等宽数字，数值变化不改变总宽（避免挤占/回流）
function cell(text: string, w: number) {
  return <span style={{ display: 'inline-block', width: w, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{text}</span>
}

// Chrome 的 /json(标签页)顺序不稳定：激活/聚焦/新开都会重排，直接用它每 3s 一刷新
// tab 就乱跳，新开的还常被排到最前(左侧冒出来)。这里维持一份稳定的客户端顺序：
// 已有 tab 保持原位(仅更新标题/url)，真正新开的追加到末尾(右侧)，消失的移除。
function mergeTabs(prev: TabInfo[], incoming: TabInfo[]): TabInfo[] {
  const byId = new Map(incoming.map((t) => [t.id, t]))
  const out: TabInfo[] = []
  for (const p of prev) {            // 1) 旧 tab 按原顺序保留，取最新标题/url
    const cur = byId.get(p.id)
    if (cur) { out.push(cur); byId.delete(p.id) }
  }
  for (const t of incoming) {        // 2) 新 tab 追加到右侧(按后端相对顺序)
    if (byId.has(t.id)) out.push(t)
  }
  return out
}

export default function BrowserView() {
  const { message } = AntApp.useApp()
  const imgRef = useRef<HTMLImageElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const sizeRef = useRef({ w: 1280, h: 800 }) // 画面内在尺寸（CDP 设备像素）
  const control = true // 始终接管（鼠标/键盘转发给 Chrome）
  const controlRef = useRef(true)
  const [connected, setConnected] = useState(false)
  const [url, setUrl] = useState('')
  const addrFocused = useRef(false) // 地址栏聚焦时不被轮询回写覆盖
  // 标签页（复用同一台 Chrome）
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [target, setTarget] = useState('') // 当前镜像的标签页 id；空 = 第一个
  // 导航起始页地址（后端 /api/me 提供，形如 http://127.0.0.1:<port>/home）；
  // 新标签默认开它、可点「主页」回到它。默认值按当前端口兜底。
  const [home, setHome] = useState(`http://127.0.0.1:${location.port || '8080'}/home`)
  // 栏目级清晰度配置（持久化）；默认自适应
  const [quality, setQuality] = useState<Quality>(() => {
    const s = localStorage.getItem(QKEY)
    if (s == null || s === 'auto') return 'auto'
    return Number(s) || 'auto'
  })
  const [levelName, setLevelName] = useState('') // 服务端当前生效档位名（自适应时显示）
  // 画面旋转：0/90/180/270，持久化。手机竖屏看横屏浏览器时转 90°
  const [rotation, setRotation] = useState<number>(() => Number(localStorage.getItem(RKEY)) || 0)
  const [stage, setStage] = useState({ w: 0, h: 0 }) // 舞台尺寸，旋转时需据此对调 <img> 盒子宽高
  // 实时指标
  const [latency, setLatency] = useState<number | null>(null)
  const [bw, setBw] = useState(0)   // 字节/秒
  const [fps, setFps] = useState(0)
  const bytesRef = useRef(0)
  const framesRef = useRef(0)
  // 点击涟漪（乐观反馈，不等帧回来）+ 移动/滚轮节流
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([])
  const ripIdRef = useRef(0)
  const lastMoveRef = useRef(0)
  const wheelRef = useRef({ x: 0, y: 0, dx: 0, dy: 0, m: 0, timer: 0 as any })

  // control 开关用 ref 同步，供事件回调读取最新值
  useEffect(() => { controlRef.current = control }, [control])

  // 跟踪舞台尺寸：旋转 90/270 时 <img> 盒子宽高要对调，才能铺满竖屏
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 旋转：每次 +90°，循环 0→90→180→270→0，持久化
  const rotate = () => setRotation((r) => { const n = (r + 90) % 360; localStorage.setItem(RKEY, String(n)); return n })
  const rotated = rotation === 90 || rotation === 270

  // 取导航起始页地址（后端按 TTMUX_HOME_BIND 算出）
  useEffect(() => {
    api('GET', '/me').then((r) => { if (r?.data?.browserHome) setHome(r.data.browserHome) }).catch(() => {})
  }, [])

  // 拉取标签页列表（每 3s 刷新，反映 agent 自己开的标签页/标题变化）
  const loadTabs = async () => {
    try {
      const r = await api('GET', '/browser/tabs')
      const list: TabInfo[] = r?.data || []
      setTabs((prev) => mergeTabs(prev, list)) // 稳定顺序，避免后端重排导致 tab 乱跳
      // 当前 target 已不存在 → 切到第一个
      setTarget((t) => (list.some((x) => x.id === t) ? t : (list[0]?.id || '')))
    } catch {}
  }
  useEffect(() => {
    loadTabs()
    const t = setInterval(loadTabs, 3000)
    return () => clearInterval(t)
  }, [])

  const newTab = async () => {
    try {
      const known = new Set(tabs.map((t) => t.id)) // 记下创建前的 id，用于定位新开的那个
      await api('POST', '/browser/tabs', { url: home }) // 新标签默认开导航起始页
      const r = await api('GET', '/browser/tabs')
      const list: TabInfo[] = r?.data || []
      setTabs((prev) => mergeTabs(prev, list))
      const fresh = list.find((t) => !known.has(t.id)) // 真正新增的(在右侧)，而非后端顺序的末位
      setTarget(fresh?.id || list[list.length - 1]?.id || '')
    } catch (e: any) { message.error(e.message) }
  }
  const closeTab = async (id: string) => {
    try { await api('DELETE', `/browser/tabs/${id}`); await loadTabs() }
    catch (e: any) { message.error(e.message) }
  }

  // 地址栏跟随当前标签页真实 URL（聚焦编辑时不覆盖；about:blank 显示为空）
  useEffect(() => {
    if (addrFocused.current) return
    const t = tabs.find((x) => x.id === target)
    if (t) setUrl(t.url === 'about:blank' ? '' : t.url)
  }, [target, tabs])

  // 切换标签：镜像该 tab + 在 Chrome 里把它前置（让 agent 前台焦点一致）
  const switchTab = (id: string) => {
    setTarget(id)
    api('POST', `/browser/tabs/${id}/activate`).catch(() => {})
  }

  // 作用于当前标签的导航控制
  const act = async (suffix: string, body?: any) => {
    if (!target) return
    try { await api('POST', `/browser/tabs/${target}/${suffix}`, body) }
    catch (e: any) { message.error(e.message) }
  }

  // control / quality 变化都要重连（后端按 query 决定输入转发与画质）
  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const params = new URLSearchParams()
    if (control) params.set('control', '1')
    if (quality === 'auto') params.set('auto', '1')
    else params.set('q', String(quality))
    if (target) params.set('target', target)
    const ws = new WebSocket(`${proto}://${location.host}/api/browser/stream?${params}`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws
    let objURL: string | null = null
    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onmessage = (e) => {
      // 二进制 = 一帧：[w:u16][h:u16][seq:u16][jpeg...]；显示后回 ack 归还信用
      if (typeof e.data !== 'string') {
        if (!imgRef.current) return
        const buf = e.data as ArrayBuffer
        const dv = new DataView(buf)
        const w = dv.getUint16(0, true), h = dv.getUint16(2, true), seq = dv.getUint16(4, true)
        sizeRef.current = { w: w || 1280, h: h || 800 }
        bytesRef.current += buf.byteLength
        framesRef.current++
        if (objURL) URL.revokeObjectURL(objURL)
        objURL = URL.createObjectURL(new Blob([new Uint8Array(buf, 6)], { type: 'image/jpeg' }))
        imgRef.current.src = objURL
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ack', n: seq }))
        return
      }
      const msg = JSON.parse(e.data)
      if (msg.type === 'error') { message.error(msg.msg); return }
      if (msg.type === 'pong') { setLatency(Math.round(performance.now() - msg.t)); return }
      if (msg.type === 'level') { setLevelName(msg.name || ''); return }
    }
    // 每秒打一次 ping 测 RTT，并结算带宽/帧率
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', t: performance.now() }))
    }, 1000)
    const meter = setInterval(() => {
      setBw(bytesRef.current); setFps(framesRef.current)
      bytesRef.current = 0; framesRef.current = 0
    }, 1000)
    return () => {
      clearInterval(ping); clearInterval(meter)
      if (objURL) URL.revokeObjectURL(objURL)
      ws.close()
    }
  }, [control, quality, target])

  const send = (o: any) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o))
  }

  const navigate = () => {
    if (!url) return
    act('navigate', { url: smartUrl(url) })
  }

  const changeQuality = (v: Quality) => { setQuality(v); localStorage.setItem(QKEY, String(v)) }

  // F12：打开 Chrome 自带 DevTools（经后端反代 /api/browser/cdp/*，直连该 tab 的 CDP）。
  // https 页面必须用 wss= 参数，否则 DevTools 起 ws:// 连接会被混合内容拦截。
  const openDevtools = () => {
    if (!target) { message.warning('没有可调试的标签页'); return }
    const wsParam = location.protocol === 'https:' ? 'wss' : 'ws'
    const u = `${location.origin}/api/browser/cdp/devtools/inspector.html`
      + `?${wsParam}=${location.host}/api/browser/cdp/devtools/page/${target}`
    window.open(u, `ttmux-devtools-${target}`, 'width=1100,height=720')
  }

  // 把鼠标坐标换算成 CDP 期望的页面 CSS 像素坐标。
  // 关键：<img> 用 object-fit: contain（居中留黑边）且可能被旋转，
  // 所以先把屏幕点平移到舞台中心相对、再逆旋转回画面坐标系，最后扣黑边按真实显示区缩放。
  const mapXY = (e: React.MouseEvent) => {
    const r = stageRef.current!.getBoundingClientRect()
    const nw = sizeRef.current.w, nh = sizeRef.current.h
    // 旋转 90/270 时画面盒子宽高对调
    const boxW = rotated ? r.height : r.width
    const boxH = rotated ? r.width : r.height
    const scale = Math.min(boxW / nw, boxH / nh) // contain 缩放比
    const dispW = nw * scale, dispH = nh * scale // 画面实际显示尺寸
    const padX = (boxW - dispW) / 2, padY = (boxH - dispH) / 2 // 黑边
    // 屏幕点 → 舞台中心相对
    const dx = e.clientX - (r.left + r.width / 2)
    const dy = e.clientY - (r.top + r.height / 2)
    // 逆旋转（R(-θ)）还原到未旋转的画面盒子坐标
    const rad = (rotation * Math.PI) / 180
    const cos = Math.cos(rad), sin = Math.sin(rad)
    const lx = dx * cos + dy * sin + boxW / 2
    const ly = -dx * sin + dy * cos + boxH / 2
    const fx = Math.max(0, Math.min(1, (lx - padX) / dispW))
    const fy = Math.max(0, Math.min(1, (ly - padY) / dispH))
    // 缩放到 CDP 页面坐标系（设备 CSS 像素）
    return { x: fx * nw, y: fy * nh }
  }

  // CDP 修饰键位掩码：Alt=1 Ctrl=2 Meta=4 Shift=8
  const mods = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
    (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)

  // 乐观点击反馈：在点击处画一圈扩散涟漪，不等画面回来 → 主观"秒响应"
  const addRipple = (e: React.MouseEvent) => {
    const st = stageRef.current
    if (!st) return
    const r = st.getBoundingClientRect()
    const id = ++ripIdRef.current
    setRipples((rs) => [...rs, { id, x: e.clientX - r.left, y: e.clientY - r.top }])
    setTimeout(() => setRipples((rs) => rs.filter((p) => p.id !== id)), 450)
  }
  const onMouse = (sub: string) => (e: React.MouseEvent) => {
    if (!controlRef.current) return
    e.preventDefault()
    if (sub === 'down') { stageRef.current?.focus(); addRipple(e) } // 拿焦点 + 涟漪
    send({ type: 'mouse', sub, ...mapXY(e), button: 'left', modifiers: mods(e) })
  }
  // 移动节流：低带宽下高频 move 会挤占上行，限到 ~45ms 一发
  const onMove = (e: React.MouseEvent) => {
    if (!controlRef.current) return
    const now = performance.now()
    if (now - lastMoveRef.current < 45) return
    lastMoveRef.current = now
    send({ type: 'mouse', sub: 'move', ...mapXY(e), modifiers: mods(e) })
  }
  // 滚轮合并：40ms 窗口内累加 delta 后一次性发，避免滚动时刷爆上行
  const onWheel = (e: React.WheelEvent) => {
    if (!controlRef.current) return
    const { x, y } = mapXY(e as any)
    // 画面旋转后，屏幕滚动方向也要逆旋转回页面坐标系，手势才跟视觉一致
    const rad = (rotation * Math.PI) / 180
    const cos = Math.cos(rad), sin = Math.sin(rad)
    const ddx = e.deltaX * cos + e.deltaY * sin
    const ddy = -e.deltaX * sin + e.deltaY * cos
    const w = wheelRef.current
    w.x = x; w.y = y; w.dx += ddx; w.dy += ddy; w.m = mods(e)
    if (!w.timer) {
      w.timer = setTimeout(() => {
        send({ type: 'wheel', x: w.x, y: w.y, deltaX: w.dx, deltaY: w.dy, modifiers: w.m })
        w.dx = 0; w.dy = 0; w.timer = 0
      }, 40)
    }
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (!controlRef.current) return
    e.preventDefault()
    // 可打印字符（无 Ctrl/Meta 组合）→ insertText；其余 → 特殊键事件
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      send({ type: 'key', sub: 'char', text: e.key })
      return
    }
    send({ type: 'key', sub: 'down', key: e.key, modifiers: mods(e) })
    send({ type: 'key', sub: 'up', key: e.key, modifiers: mods(e) })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 图标用的金属高光渐变（银色 chrome 质感，与品牌 mark 一致） */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <linearGradient id="metalIcon" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f2f5f9" />
            <stop offset="0.45" stopColor="#c4cbd4" />
            <stop offset="0.55" stopColor="#878f9b" />
            <stop offset="1" stopColor="#b3bbc6" />
          </linearGradient>
        </defs>
      </svg>
      {/* 标签栏：左=标签页(自定义固定宽度，切换不易位)，右=接管/清晰度/状态/指标 */}
      <TabBar
        tabs={tabs}
        active={target}
        onSelect={switchTab}
        onClose={closeTab}
        onAdd={newTab}
        extra={
          <Space size={10} style={{ paddingRight: 4 }}>
            <Button size="small" onClick={rotate} title="旋转画面 90°（手机竖屏看横屏）"
              style={rotation ? { color: '#58a6ff', borderColor: '#58a6ff66' } : undefined}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {/* 屏幕旋转图标（倾斜设备框 + 对角双箭头），明显区别于刷新的环形箭头 */}
                <svg viewBox="0 0 24 24" width={15} height={15} fill="url(#metalIcon)" style={{ display: 'block' }}>
                  <path d="M16.48 2.52c3.27 1.55 5.61 4.72 5.97 8.48h1.5C23.44 4.84 18.29 0 12 0l-.66.03 3.81 3.81 1.33-1.32zM10.23 1.75c-.59-.59-1.54-.59-2.12 0L1.75 8.11c-.59.59-.59 1.54 0 2.12l12.02 12.02c.59.59 1.54.59 2.12 0l6.36-6.36c.59-.59.59-1.54 0-2.12L10.23 1.75zm4.6 19.44L2.81 9.17l6.36-6.36 12.02 12.02-6.36 6.36zM7.52 21.48C4.25 19.94 1.91 16.76 1.55 13H.05C.56 19.16 5.71 24 12 24l.66-.03-3.81-3.81-1.33 1.32z" />
                </svg>
                {rotation ? <span>{rotation}°</span> : null}
              </span>
            </Button>
            {/* 清晰度：选中档亮蓝底 + 白字加粗 + 辉光，未选中压暗，对比鲜明 */}
            <Space.Compact size="small">
              {QUALITY_OPTS.map((o) => {
                const on = quality === o.value
                return (
                  <Button
                    key={String(o.value)}
                    size="small"
                    type={on ? 'primary' : 'default'}
                    onClick={() => changeQuality(o.value)}
                    style={on
                      ? { background: '#1f6feb', borderColor: '#1f6feb', color: '#fff', fontWeight: 700, boxShadow: '0 0 0 2px rgba(31,111,235,.35)', zIndex: 1 }
                      : { background: 'transparent', borderColor: 'var(--border)', color: 'var(--text-dim)' }}
                  >{o.label}</Button>
                )
              })}
            </Space.Compact>
            <Tag color={connected ? 'green' : 'red'} style={{ marginInlineEnd: 0 }}>{connected ? '已连接' : '未连接'}</Tag>
            <span style={{ color: 'var(--text-dim)', fontSize: 12, whiteSpace: 'nowrap' }}>
              {quality === 'auto' && levelName ? <span style={{ color: '#58a6ff' }}>{levelName} ·</span> : null}
              {cell(latency == null ? '—' : latency + 'ms', 48)} ·{cell(fmtRate(bw), 70)} ·{cell(fps + 'fps', 42)}
            </span>
          </Space>
        }
      />
      {/* 地址栏：紧凑一行，地址框自适应铺满 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', flex: '0 0 auto' }}>
        <Button.Group size="small">
          <Button onClick={() => act('back')} title="后退">←</Button>
          <Button onClick={() => act('forward')} title="前进">→</Button>
          <Button onClick={() => act('reload')} title="刷新">⟳</Button>
          <Button onClick={() => act('navigate', { url: home })} title="导航起始页">
            <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="url(#metalIcon)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
              <path d="M3 11.5 L12 4 L21 11.5" />
              <path d="M5.5 10 V19.5 H18.5 V10" />
            </svg>
          </Button>
        </Button.Group>
        <Input
          size="small"
          placeholder="输入网址回车导航，如 example.com"
          value={url}
          style={{ flex: 1 }}
          onChange={(e) => setUrl(e.target.value)}
          onFocus={() => { addrFocused.current = true }}
          onBlur={() => { addrFocused.current = false }}
          onPressEnter={navigate}
        />
        <Button size="small" onClick={navigate}>前往</Button>
        <Button size="small" onClick={openDevtools} title="打开调试工具 (F12 / DevTools)">调试</Button>
      </div>
      <style>{`
        .bv-ripple{position:absolute;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;
          border:2px solid #58a6ff;pointer-events:none;animation:bvRip .45s ease-out forwards;}
        @keyframes bvRip{from{transform:scale(.3);opacity:.9}to{transform:scale(2.6);opacity:0}}
      `}</style>
      <div
        ref={stageRef}
        tabIndex={0}
        onKeyDown={onKey}
        onWheel={onWheel}
        style={{
          flex: 1, minHeight: 0, background: '#000', overflow: 'hidden', position: 'relative',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: control ? 'default' : 'not-allowed', outline: 'none',
        }}
      >
        <img
          ref={imgRef}
          draggable={false}
          onMouseDown={onMouse('down')}
          onMouseUp={onMouse('up')}
          onMouseMove={onMove}
          style={{
            // 绝对居中 + 旋转；旋转 90/270 时盒子宽高对调以铺满舞台
            position: 'absolute', left: '50%', top: '50%',
            width: rotated ? stage.h : stage.w,
            height: rotated ? stage.w : stage.h,
            objectFit: 'contain',
            transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
          }}
        />
        {ripples.map((p) => (
          <span key={p.id} className="bv-ripple" style={{ left: p.x, top: p.y }} />
        ))}
      </div>
    </div>
  )
}
