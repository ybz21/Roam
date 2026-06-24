// 浏览器镜像页：把后端全局 Chrome 的画面实时渲染到 <img>，可选「接管」转发输入。
// 协议见 backend/browser/screencast.go：
//   收 {type:'frame', data, w, h} | {type:'pong', t} | {type:'error', msg}
//   发 {type:'nav', url} | {type:'ping', t} | {type:'mouse'|'wheel'|'key', ...}（输入仅 control=1 生效）
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Select, Space, Tag, App as AntApp } from 'antd'
import { api } from './api'
import { useI18n } from './i18n'

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
  const { t } = useI18n()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px 0', flex: '0 0 auto' }}>
      <div style={{ display: 'flex', gap: 4, overflowX: 'auto', flex: 1, minWidth: 0 }}>
        {tabs.map((t) => (
          <BrowserTab key={t.id} tab={t} active={t.id === active} onSelect={() => onSelect(t.id)} onClose={() => onClose(t.id)} />
        ))}
        <button
          onClick={onAdd}
          title={t('browser.newTab')}
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
const QUALITY_OPTS: { labelKey: string; value: Quality }[] = [
  { labelKey: 'browser.quality.auto', value: 'auto' },
  { labelKey: 'browser.quality.standard', value: 50 },
  { labelKey: 'browser.quality.high', value: 80 },
  { labelKey: 'browser.quality.ultra', value: 92 },
]

// 手机模式设备档（栏目级配置，存 localStorage）。空 key = 桌面（不模拟）。
// 维度是 CSS 像素视口，dpr 决定渲染像素密度；ua 让做 UA 嗅探的站点切到移动版。
// 后端 screencast.go 按 ?mobile/mw/mh/dpr/ua 下发 CDP Emulation 覆盖。
type Device = { key: string; nameKey: string; w: number; h: number; dpr: number; ua: string }
const DKEY = 'ttmux.browser.device'
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const DEVICES: Device[] = [
  { key: 'iphone', nameKey: 'browser.device.iphone', w: 390, h: 844, dpr: 3, ua: IOS_UA },
  { key: 'pixel', nameKey: 'browser.device.pixel', w: 412, h: 915, dpr: 2.625,
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
  { key: 'ipad', nameKey: 'browser.device.ipad', w: 820, h: 1180, dpr: 2,
    ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
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
  const { t } = useI18n()
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
  const tabsRef = useRef<TabInfo[]>([]) // 供 ws.onmessage 等闭包读到最新标签集（识别新开的那个）
  const [target, setTarget] = useState('') // 当前镜像的标签页 id；空 = 第一个
  // 导航起始页地址（后端 /api/me 提供，形如 http://127.0.0.1:<port>/home）；
  // 新标签默认开它、可点「主页」回到它。默认值按当前端口兜底。
  const [home, setHome] = useState(`${location.protocol}//127.0.0.1:${location.port || '8080'}/home`)
  // 栏目级清晰度配置（持久化）；默认自适应
  const [quality, setQuality] = useState<Quality>(() => {
    const s = localStorage.getItem(QKEY)
    if (s == null || s === 'auto') return 'auto'
    return Number(s) || 'auto'
  })
  const [levelName, setLevelName] = useState('') // 服务端当前生效档位名（自适应时显示）
  // 手机模式：空 = 桌面；否则模拟对应机型视口（持久化）。切换不重连，发 emulate 消息现场切换
  const [device, setDevice] = useState<string>(() => localStorage.getItem(DKEY) || '')
  const deviceRef = useRef(device) // 供 ws.onopen 等回调读最新设备态
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
  const dragRef = useRef({ x: 0, y: 0, active: false, moved: false }) // 拖动框选：起点(页面坐标)+是否真的移动过
  const wheelRef = useRef({ x: 0, y: 0, dx: 0, dy: 0, m: 0, timer: 0 as any })
  const touchRef = useRef({ x: 0, y: 0, t: 0, moved: false })

  // control 开关用 ref 同步，供事件回调读取最新值
  useEffect(() => { controlRef.current = control }, [control])
  useEffect(() => { deviceRef.current = device }, [device])
  useEffect(() => { tabsRef.current = tabs }, [tabs])

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

  // 被镜像页打开了新窗口/标签（后端 windowOpen 事件触发）：找出新出现的那个并把镜像切过去。
  // 新 target 可能略晚于事件才出现在 /json 列表里，故短重试几次。
  const followNewTab = async () => {
    const known = new Set(tabsRef.current.map((t) => t.id))
    for (let i = 0; i < 8; i++) {
      try {
        const r = await api('GET', '/browser/tabs')
        const list: TabInfo[] = r?.data || []
        const fresh = list.find((t) => !known.has(t.id))
        if (fresh) {
          setTabs((prev) => mergeTabs(prev, list))
          switchTab(fresh.id) // 切镜像 + 前置，画面随之跳到新标签
          return
        }
        setTabs((prev) => mergeTabs(prev, list))
      } catch {}
      await new Promise((res) => setTimeout(res, 200))
    }
  }

  // 作用于当前标签的导航控制
  const act = async (suffix: string, body?: any) => {
    if (!target) return
    try { await api('POST', `/browser/tabs/${target}/${suffix}`, body) }
    catch (e: any) { message.error(e.message) }
  }

  // 当前设备 → emulate 消息载荷。桌面用观看区(stage)的原生 CSS 尺寸 + 真实 DPR，
  // 镜像里的桌面布局就与你屏幕一致、随窗口自适应，不被 Chrome 启动窗口尺寸(1280×800)限死。
  const emulatePayload = () => {
    const dev = DEVICES.find((d) => d.key === deviceRef.current)
    if (dev) return { type: 'emulate', mobile: true, mw: dev.w, mh: dev.h, dpr: dev.dpr, ua: dev.ua }
    const el = stageRef.current
    return {
      type: 'emulate', mobile: false,
      mw: el ? Math.round(el.clientWidth) : 0,
      mh: el ? Math.round(el.clientHeight) : 0,
      dpr: window.devicePixelRatio || 1,
    }
  }

  // control / quality / target 变化才重连；设备/尺寸切换不重连（连上后发 emulate 消息）
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
    ws.onopen = () => { setConnected(true); ws.send(JSON.stringify(emulatePayload())) } // 连上即同步当前设备/尺寸
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
      // 被镜像页打开了新窗口/标签 → 镜像跟过去（点 target=_blank 链接、window.open 等）
      if (msg.type === 'newtab') { followNewTab(); return }
      // 复制选区回包：把远端页面当前选区文本写进本设备剪贴板（需安全上下文，HTTPS 默认已开）
      if (msg.type === 'copied') {
        const text: string = msg.text || ''
        if (!text) { message.info(t('browser.noSelection')); return }
        // 选区已存进后端「浏览器内部剪贴板」，Ctrl+V 必能用；这里顺手写本机剪贴板（成功则外部也能粘，失败忽略）
        navigator.clipboard?.writeText?.(text).catch(() => {})
        message.success(t('browser.copied'))
        return
      }
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
  }, [control, quality, target]) // device 切换不重连，靠下面的 emulate 消息现场切换

  const send = (o: any) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o))
  }

  // 设备切换 / 观看区尺寸变化：在现有连接上发 emulate（同一 CDP 会话 set/clear），不重连
  // → 无闪烁/无竞态，来回切也稳。桌面随窗口大小自适应（stage 变化即重发原生尺寸）。
  useEffect(() => {
    send(emulatePayload())
  }, [device, stage.w, stage.h])

  const navigate = () => {
    if (!url) return
    act('navigate', { url: smartUrl(url) })
  }

  const changeQuality = (v: Quality) => { setQuality(v); localStorage.setItem(QKEY, String(v)) }
  const changeDevice = (v: string) => { setDevice(v); localStorage.setItem(DKEY, v) }

  // F12：打开 Chrome 自带 DevTools（经后端反代 /api/browser/cdp/*，直连该 tab 的 CDP）。
  // https 页面必须用 wss= 参数，否则 DevTools 起 ws:// 连接会被混合内容拦截。
  const openDevtools = () => {
    if (!target) { message.warning(t('browser.noDebuggableTab')); return }
    const wsParam = location.protocol === 'https:' ? 'wss' : 'ws'
    const u = `${location.origin}/api/browser/cdp/devtools/inspector.html`
      + `?${wsParam}=${location.host}/api/browser/cdp/devtools/page/${target}`
    window.open(u, `ttmux-devtools-${target}`, 'width=1100,height=720')
  }

  // 把鼠标坐标换算成 CDP 期望的页面 CSS 像素坐标。
  // 关键：<img> 用 object-fit: contain（居中留黑边）且可能被旋转，
  // 所以先把屏幕点平移到舞台中心相对、再逆旋转回画面坐标系，最后扣黑边按真实显示区缩放。
  const mapClientXY = (clientX: number, clientY: number) => {
    const r = stageRef.current!.getBoundingClientRect()
    const nw = sizeRef.current.w, nh = sizeRef.current.h
    // 旋转 90/270 时画面盒子宽高对调
    const boxW = rotated ? r.height : r.width
    const boxH = rotated ? r.width : r.height
    const scale = Math.min(boxW / nw, boxH / nh) // contain 缩放比
    const dispW = nw * scale, dispH = nh * scale // 画面实际显示尺寸
    const padX = (boxW - dispW) / 2, padY = (boxH - dispH) / 2 // 黑边
    // 屏幕点 → 舞台中心相对
    const dx = clientX - (r.left + r.width / 2)
    const dy = clientY - (r.top + r.height / 2)
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
  const mapXY = (e: React.MouseEvent) => mapClientXY(e.clientX, e.clientY)

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
    const pt = mapXY(e)
    if (sub === 'down') { stageRef.current?.focus(); addRipple(e); dragRef.current = { x: pt.x, y: pt.y, active: true, moved: false } } // 拿焦点 + 涟漪 + 记拖动起点
    send({ type: 'mouse', sub, x: pt.x, y: pt.y, button: 'left', buttons: sub === 'down' ? 1 : 0, modifiers: mods(e) })
    if (sub === 'up') {
      const d = dragRef.current
      if (d.active && d.moved) send({ type: 'select', x1: d.x, y1: d.y, x2: pt.x, y2: pt.y }) // 拖动结束 → 定稿选区
      d.active = false
    }
  }
  // 移动节流：低带宽下高频 move 会挤占上行，限到 ~45ms 一发
  const onMove = (e: React.MouseEvent) => {
    if (!controlRef.current) return
    const now = performance.now()
    if (now - lastMoveRef.current < 45) return
    lastMoveRef.current = now
    const pt = mapXY(e)
    // buttons 透传：移动时带住左键 Chrome 才认作拖动（拖滑块/画布/框选都靠它）
    send({ type: 'mouse', sub: 'move', x: pt.x, y: pt.y, buttons: e.buttons, modifiers: mods(e) })
    // 按住左键拖动 → 实时框选（headless 合成拖选无效，发起止坐标让远端用 caretRangeFromPoint 建 Range）
    const d = dragRef.current
    if (d.active && (e.buttons & 1) && Math.abs(pt.x - d.x) + Math.abs(pt.y - d.y) > 3) {
      d.moved = true
      send({ type: 'select', x1: d.x, y1: d.y, x2: pt.x, y2: pt.y })
    }
  }
  const queueWheel = (x: number, y: number, deltaX: number, deltaY: number, modifiers = 0) => {
    // 画面旋转后，屏幕滚动方向也要逆旋转回页面坐标系，手势才跟视觉一致
    const rad = (rotation * Math.PI) / 180
    const cos = Math.cos(rad), sin = Math.sin(rad)
    const ddx = deltaX * cos + deltaY * sin
    const ddy = -deltaX * sin + deltaY * cos
    const w = wheelRef.current
    w.x = x; w.y = y; w.dx += ddx; w.dy += ddy; w.m = modifiers
    if (!w.timer) {
      w.timer = setTimeout(() => {
        send({ type: 'wheel', x: w.x, y: w.y, deltaX: w.dx, deltaY: w.dy, modifiers: w.m })
        w.dx = 0; w.dy = 0; w.timer = 0
      }, 40)
    }
  }
  // 滚轮合并：40ms 窗口内累加 delta 后一次性发，避免滚动时刷爆上行
  const onWheel = (e: React.WheelEvent) => {
    if (!controlRef.current) return
    const { x, y } = mapXY(e as any)
    queueWheel(x, y, e.deltaX, e.deltaY, mods(e))
  }
  const onTouchStart = (e: React.TouchEvent) => {
    if (!controlRef.current || e.touches.length !== 1) return
    const t = e.touches[0]
    touchRef.current = { x: t.clientX, y: t.clientY, t: performance.now(), moved: false }
    stageRef.current?.focus()
  }
  const onTouchMove = (e: React.TouchEvent) => {
    if (!controlRef.current || e.touches.length !== 1) return
    const t = e.touches[0]
    const last = touchRef.current
    const dx = t.clientX - last.x
    const dy = t.clientY - last.y
    if (Math.abs(dx) + Math.abs(dy) > 3) {
      e.preventDefault()
      last.moved = true
      const { x, y } = mapClientXY(t.clientX, t.clientY)
      // 手指上滑(dy<0) = 页面向下滚(deltaY>0)，保持移动端自然滚动方向。
      queueWheel(x, y, -dx, -dy, 0)
      last.x = t.clientX
      last.y = t.clientY
    }
  }
  const onTouchEnd = (e: React.TouchEvent) => {
    if (!controlRef.current) return
    const t = e.changedTouches[0]
    if (!t) return
    const last = touchRef.current
    const tap = !last.moved && performance.now() - last.t < 420
    if (!tap) return
    const { x, y } = mapClientXY(t.clientX, t.clientY)
    const st = stageRef.current
    if (st) {
      const r = st.getBoundingClientRect()
      const id = ++ripIdRef.current
      setRipples((rs) => [...rs, { id, x: t.clientX - r.left, y: t.clientY - r.top }])
      setTimeout(() => setRipples((rs) => rs.filter((p) => p.id !== id)), 450)
    }
    send({ type: 'mouse', sub: 'down', x, y, button: 'left', modifiers: 0 })
    send({ type: 'mouse', sub: 'up', x, y, button: 'left', modifiers: 0 })
  }
  // 复制选区：让后端取远端页面 window.getSelection()，回包后写进本设备剪贴板（见 onmessage 'copied'）
  const copySelection = () => send({ type: 'copy' })
  // 粘贴：读本机剪贴板发到远端焦点框。注意——画面是普通 <div>（非可编辑），浏览器不会给它派发
  // paste 事件，所以不能靠 onPaste；keydown 本身是用户手势，安全上下文下可直接 readText。
  const pasteFromClipboard = () => {
    // 先试本机剪贴板（外部复制的内容）；读不到/无权限/非安全上下文 → 发空 paste，
    // 后端用「浏览器内部剪贴板」兜底（内部 Ctrl+C 存的），所以内部复制粘贴永远能跑。
    const p = navigator.clipboard?.readText?.()
    if (!p) { send({ type: 'paste' }); return }
    p.then(
      (text) => send(text ? { type: 'paste', text } : { type: 'paste' }),
      () => send({ type: 'paste' }),
    )
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (!controlRef.current) return
    const mod = e.ctrlKey || e.metaKey
    // 复制/粘贴走「跨屏」桥，不把组合键转发给远端：用本机剪贴板，不碰远端那台机器的剪贴板
    if (mod && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); pasteFromClipboard(); return }
    if (mod && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); copySelection(); return }
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
            <Button size="small" onClick={rotate} title={t('browser.rotateTitle')}
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
                  >{t(o.labelKey)}</Button>
                )
              })}
            </Space.Compact>
            <Tag color={connected ? 'green' : 'red'} style={{ marginInlineEnd: 0 }}>{connected ? t('browser.connected') : t('browser.disconnected')}</Tag>
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
          <Button onClick={() => act('back')} title={t('file.back')}>←</Button>
          <Button onClick={() => act('forward')} title={t('file.forward')}>→</Button>
          <Button onClick={() => act('reload')} title={t('common.refresh')}>⟳</Button>
          <Button onClick={() => act('navigate', { url: home })} title={t('browser.home')}>
            <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="url(#metalIcon)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
              <path d="M3 11.5 L12 4 L21 11.5" />
              <path d="M5.5 10 V19.5 H18.5 V10" />
            </svg>
          </Button>
        </Button.Group>
        <Input
          size="small"
          placeholder={t('browser.urlPlaceholder')}
          value={url}
          style={{ flex: 1 }}
          onChange={(e) => setUrl(e.target.value)}
          onFocus={() => { addrFocused.current = true }}
          onBlur={() => { addrFocused.current = false }}
          onPressEnter={navigate}
        />
        <Button size="small" onClick={navigate}>{t('browser.go')}</Button>
        <Button size="small" onClick={openDevtools} title={t('browser.devtoolsTitle')}>{t('browser.debug')}</Button>
        {/* 手机模式：紧跟调试按钮。选机型即模拟移动视口（持久化、重连生效） */}
        <Select
          size="small"
          value={device}
          onChange={changeDevice}
          title={t('browser.deviceTitle')}
          style={{ width: 96, flex: '0 0 auto' }}
          options={[
            { value: '', label: t('browser.device.desktop') },
            ...DEVICES.map((d) => ({ value: d.key, label: t(d.nameKey) })),
          ]}
        />
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
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{
          flex: 1, minHeight: 0, background: '#000', overflow: 'hidden', position: 'relative',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: control ? 'default' : 'not-allowed', outline: 'none', touchAction: 'none',
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
