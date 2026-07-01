// 手机镜像页：把后端手机（Linux→Android adb）的画面实时渲染到 <img>，并转发点按/滑动/输入。
// 协议见 backend/phone/screencast.go：
//   收 二进制帧 [w:u16][h:u16][seq:u16][jpeg...] | {type:'pong'|'error'|'level'}
//   发 {type:'ack',n} | {type:'ping',t} | {type:'tap'|'swipe'|'text'|'key'}
import { useEffect, useRef, useState } from 'react'
import { Button, Select, Space, Tag, App as AntApp } from 'antd'
import { api } from './api'
import { useI18n } from './i18n'

interface PhoneApp { id: string; name?: string }

// 与浏览器对齐：自动(自适应) / 标清 / 高清 / 超清（复用 browser.quality.* 文案）
type Quality = number | 'auto'
const QUALITY_OPTS: { labelKey: string; value: Quality }[] = [
  { labelKey: 'browser.quality.auto', value: 'auto' },
  { labelKey: 'browser.quality.standard', value: 50 },
  { labelKey: 'browser.quality.high', value: 80 },
  { labelKey: 'browser.quality.ultra', value: 92 },
]
const QKEY = 'ttmux.phone.quality'

function fmtRate(bps: number) {
  if (bps >= 1 << 20) return (bps / (1 << 20)).toFixed(1) + ' MB/s'
  return Math.round(bps / 1024) + ' KB/s'
}

export default function PhoneView() {
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  const imgRef = useRef<HTMLImageElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const sizeRef = useRef({ w: 1080, h: 2400 }) // 画面内在尺寸（设备像素）

  const [connected, setConnected] = useState(false)
  const [healthMsg, setHealthMsg] = useState('')
  const [quality, setQuality] = useState<Quality>(() => {
    const s = localStorage.getItem(QKEY)
    if (s == null || s === 'auto') return 'auto'
    return Number(s) || 'auto'
  })
  const [levelName, setLevelName] = useState('') // 自适应当前档名（auto 时显示）
  const [apps, setApps] = useState<PhoneApp[]>([])
  const [platform, setPlatform] = useState<'android' | 'ios'>('android')
  const [latency, setLatency] = useState<number | null>(null)
  const [bw, setBw] = useState(0)
  const [fps, setFps] = useState(0)
  const bytesRef = useRef(0)
  const framesRef = useRef(0)

  // 点击涟漪 + 拖动起点（用于区分 tap / swipe）
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([])
  const ripIdRef = useRef(0)
  const dragRef = useRef({ x: 0, y: 0, dx: 0, dy: 0, t: 0, active: false })

  const send = (o: any) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o))
  }

  // 屏幕坐标 → 设备像素（<img> 用 object-fit:contain，居中留黑边，先扣黑边再按比例缩放）
  const mapXY = (clientX: number, clientY: number) => {
    const r = stageRef.current!.getBoundingClientRect()
    const nw = sizeRef.current.w, nh = sizeRef.current.h
    const scale = Math.min(r.width / nw, r.height / nh)
    const dispW = nw * scale, dispH = nh * scale
    const padX = (r.width - dispW) / 2, padY = (r.height - dispH) / 2
    const fx = Math.max(0, Math.min(1, (clientX - r.left - padX) / dispW))
    const fy = Math.max(0, Math.min(1, (clientY - r.top - padY) / dispH))
    return { x: Math.round(fx * nw), y: Math.round(fy * nh) }
  }

  const addRipple = (clientX: number, clientY: number) => {
    const st = stageRef.current
    if (!st) return
    const r = st.getBoundingClientRect()
    const id = ++ripIdRef.current
    setRipples((rs) => [...rs, { id, x: clientX - r.left, y: clientY - r.top }])
    setTimeout(() => setRipples((rs) => rs.filter((p) => p.id !== id)), 450)
  }

  // 按下记起点；松开按位移/时长判定 tap 还是 swipe
  const onDown = (clientX: number, clientY: number) => {
    stageRef.current?.focus()
    const p = mapXY(clientX, clientY)
    dragRef.current = { x: p.x, y: p.y, dx: clientX, dy: clientY, t: performance.now(), active: true }
  }
  const onUp = (clientX: number, clientY: number) => {
    const d = dragRef.current
    if (!d.active) return
    d.active = false
    const p = mapXY(clientX, clientY)
    const moved = Math.abs(clientX - d.dx) + Math.abs(clientY - d.dy)
    const dt = performance.now() - d.t
    if (moved < 12) {
      addRipple(clientX, clientY)
      send({ type: 'tap', x: p.x, y: p.y })
    } else {
      send({ type: 'swipe', x1: d.x, y1: d.y, x2: p.x, y2: p.y, ms: Math.max(50, Math.min(800, Math.round(dt))) })
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    // 可打印字符 → text；功能键 → keyevent
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); send({ type: 'text', text: e.key }); return
    }
    const map: Record<string, string> = { Enter: 'enter', Backspace: 'del', Escape: 'back' }
    const name = map[e.key]
    if (name) { e.preventDefault(); send({ type: 'key', name }) }
  }

  // 拉取 App 列表
  const loadApps = async () => {
    try {
      const r = await api('GET', '/phone/apps')
      if (r?.data) setApps(r.data)
    } catch {}
  }
  useEffect(() => { loadApps() }, [])

  // 平台（android/ios）→ 底部导航键自适应。取 health.platform；连不上回落看 config.mode。
  useEffect(() => {
    api('GET', '/phone/health').then((r) => {
      const p = r?.data?.platform
      if (p === 'ios' || p === 'android') setPlatform(p)
    }).catch(() => {})
    api('GET', '/phone/config').then((r) => {
      if (r?.data?.platform === 'ios') setPlatform('ios')
    }).catch(() => {})
  }, [])

  const launch = (id: string) => { if (id) api('POST', `/phone/apps/${encodeURIComponent(id)}/launch`).catch(() => {}) }
  const pressKey = (name: string) => api('POST', '/phone/key', { name }).catch(() => {})

  // quality 变化才重建连接；断开(掉线/切设备/redroid 停起)自动重连，画面自愈无需刷新。
  useEffect(() => {
    let stopped = false
    let ws: WebSocket | null = null
    let objURL: string | null = null
    let retry: any = null
    const connect = () => {
      if (stopped) return
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const qParam = quality === 'auto' ? 'auto=1' : `q=${quality}`
      const sock = new WebSocket(`${proto}://${location.host}/api/phone/stream?control=1&${qParam}`)
      sock.binaryType = 'arraybuffer'
      ws = sock; wsRef.current = sock
      sock.onopen = () => { setConnected(true); setHealthMsg('') }
      sock.onclose = () => {
        setConnected(false)
        if (stopped) return
        api('GET', '/phone/health').then((r) => { if (!r?.data?.ok) setHealthMsg(r?.data?.error || '') }).catch(() => {})
        retry = setTimeout(connect, 1500) // 自动重连
      }
      sock.onmessage = (e) => {
        if (typeof e.data !== 'string') {
          if (!imgRef.current) return
          const buf = e.data as ArrayBuffer
          const dv = new DataView(buf)
          const w = dv.getUint16(0, true), h = dv.getUint16(2, true), seq = dv.getUint16(4, true)
          sizeRef.current = { w: w || 1080, h: h || 2400 }
          bytesRef.current += buf.byteLength
          framesRef.current++
          if (objURL) URL.revokeObjectURL(objURL)
          objURL = URL.createObjectURL(new Blob([new Uint8Array(buf, 6)], { type: 'image/jpeg' }))
          imgRef.current.src = objURL
          if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'ack', n: seq }))
          return
        }
        const msg = JSON.parse(e.data)
        if (msg.type === 'error') { setHealthMsg(msg.msg); return }
        if (msg.type === 'pong') { setLatency(Math.round(performance.now() - msg.t)); return }
        if (msg.type === 'level') { setLevelName(msg.name || ''); return }
      }
    }
    connect()
    const ping = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', t: performance.now() }))
    }, 1000)
    const meter = setInterval(() => {
      setBw(bytesRef.current); setFps(framesRef.current)
      bytesRef.current = 0; framesRef.current = 0
    }, 1000)
    return () => {
      stopped = true
      clearInterval(ping); clearInterval(meter); clearTimeout(retry)
      if (objURL) URL.revokeObjectURL(objURL)
      ws?.close()
    }
  }, [quality])

  const changeQuality = (v: Quality) => { setQuality(v); try { localStorage.setItem(QKEY, String(v)) } catch {} }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 第一栏：画质 + 连接状态 + 指标 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px 4px', flex: '0 0 auto', flexWrap: 'wrap' }}>
        <Space.Compact size="small">
          {QUALITY_OPTS.map((o) => {
            const on = quality === o.value
            return (
              <Button key={o.value} size="small" type={on ? 'primary' : 'default'} onClick={() => changeQuality(o.value)}
                style={on ? { background: '#1f6feb', borderColor: '#1f6feb', color: '#fff', fontWeight: 700 }
                  : { background: 'transparent', borderColor: 'var(--border)', color: 'var(--text-dim)' }}>
                {t(o.labelKey)}
              </Button>
            )
          })}
        </Space.Compact>
        <Tag color={connected ? 'green' : 'red'} style={{ marginInlineEnd: 0, marginLeft: 'auto' }}>
          {connected ? t('phone.connected') : t('phone.disconnected')}
        </Tag>
        <span style={{ color: 'var(--text-dim)', fontSize: 12, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {quality === 'auto' && levelName ? <span style={{ color: '#58a6ff' }}>{levelName} · </span> : null}
          {latency == null ? '—' : latency + 'ms'} · {fmtRate(bw)} · {fps}fps
        </span>
      </div>

      {/* 第二栏：打开应用 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px 8px', flex: '0 0 auto' }}>
        <Select
          size="small"
          showSearch
          placeholder={t('phone.launchApp')}
          style={{ width: 240 }}
          value={null}
          onChange={launch}
          onDropdownVisibleChange={(open) => { if (open) loadApps() }}
          filterOption={(input, opt) => String(opt?.value || '').toLowerCase().includes(input.toLowerCase())}
          options={apps.map((a) => ({ value: a.id, label: a.name || a.id }))}
        />
      </div>

      <style>{`
        .pv-ripple{position:absolute;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;
          border:2px solid #58a6ff;pointer-events:none;animation:pvRip .45s ease-out forwards;}
        @keyframes pvRip{from{transform:scale(.3);opacity:.9}to{transform:scale(2.6);opacity:0}}
      `}</style>

      {/* 画面舞台 */}
      <div
        ref={stageRef}
        tabIndex={0}
        onKeyDown={onKey}
        onMouseDown={(e) => { e.preventDefault(); onDown(e.clientX, e.clientY) }}
        onMouseUp={(e) => onUp(e.clientX, e.clientY)}
        onTouchStart={(e) => { const t0 = e.touches[0]; if (t0) onDown(t0.clientX, t0.clientY) }}
        onTouchEnd={(e) => { const t0 = e.changedTouches[0]; if (t0) onUp(t0.clientX, t0.clientY) }}
        style={{
          flex: 1, minHeight: 0, background: '#000', overflow: 'hidden', position: 'relative',
          display: 'flex', alignItems: 'center', justifyContent: 'center', outline: 'none', touchAction: 'none',
        }}
      >
        <img
          ref={imgRef}
          draggable={false}
          // 绝对填满舞台 + object-fit:contain：尺寸对着舞台的确定盒子解析，避免
          // maxHeight:100% 在 flex 列里初次布局拿不到确定高度→需 resize 才显示的 bug。
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', display: 'block', userSelect: 'none' }}
        />
        {ripples.map((p) => (<span key={p.id} className="pv-ripple" style={{ left: p.x, top: p.y }} />))}
        {!connected && healthMsg && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, pointerEvents: 'none' }}>
            <div style={{ maxWidth: 520, padding: '12px 16px', borderRadius: 8, background: 'rgba(0,0,0,.72)', border: '1px solid #f8514955', color: '#ffb4a8', fontSize: 13, lineHeight: 1.6, textAlign: 'center' }}>
              {t('phone.unavailable')}<br />{healthMsg}
            </div>
          </div>
        )}
      </div>

      {/* 底部导航键：Android=返回/主屏/多任务；iOS=主屏/锁屏/Siri（iOS 无系统返回键） */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 28, padding: '8px 0', flex: '0 0 auto', borderTop: '1px solid var(--border-subtle)' }}>
        {platform === 'ios' ? (
          <>
            <Button shape="circle" onClick={() => pressKey('home')} title={t('phone.home')}>○</Button>
            <Button shape="circle" onClick={() => pressKey('lock')} title={t('phone.lock')}>⏻</Button>
            <Button shape="circle" onClick={() => pressKey('siri')} title={t('phone.siri')}>◉</Button>
          </>
        ) : (
          <>
            <Button shape="circle" onClick={() => pressKey('back')} title={t('phone.back')}>◁</Button>
            <Button shape="circle" onClick={() => pressKey('home')} title={t('phone.home')}>○</Button>
            <Button shape="circle" onClick={() => pressKey('recents')} title={t('phone.recents')}>▭</Button>
          </>
        )}
      </div>
    </div>
  )
}
