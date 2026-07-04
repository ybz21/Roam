// ttmux Web 控制台 — React + Vite + Antd（统一深色主题）
// 布局（见 docs/design/web/01-overview.md）：
//   电脑 ≥1200 → 三栏：导航 Sider | 列表(页面) | 终端面板(常驻, 多标签)
//   平板/手机   → 终端为全屏覆盖层；手机底部 Tab 导航
// 终端：多标签 / 字号调节 / 复制 / 更多快捷键 / 断线自动重连。
import { useEffect, useRef, useState } from 'react'
import {
  Layout, Menu, Button, Card, List, Tag, Form, Input, Select, Segmented, Tabs, Descriptions,
  Statistic, Row, Col, Space, Popconfirm, Empty, Modal, Grid, App as AntApp, Typography, Spin, Tooltip, Dropdown, Checkbox, Progress, AutoComplete, Radio, Switch,
} from 'antd'
import { QRCodeSVG } from 'qrcode.react'
import { api, upload, makeClipboardImageFile, setUnauthorizedHandler } from './api'
import Term, { TermHandle, TermStatus } from './Terminal'
import ClaudeChat from './ClaudeChat'
import CodexChat from './CodexChat'
import FileBrowser from './FileBrowser'
import FileWorkspace from './FileWorkspace'
import FloatingFileDrawer from './FloatingFileDrawer'
import GitPanel from './GitPanel'
import BrowserView from './BrowserView'
import PhoneView from './PhoneView'
import Swarm from './Swarm'
import UpdateBanner from './UpdateBanner'
import { useThemeMode } from './theme'
import { useI18n } from './i18n'
import { usePwaInstall } from './install'
import { usePreferences, savePreferences, loadPreferences } from './preferences'
import { PromptDialog, detectPrompt } from './prompt'
import { copyText } from './chat/blocks'
import { VoiceInput } from './chat/VoiceInput'

interface ClaudeInfo { running: boolean; file?: string; dir?: string }

const { Sider, Content } = Layout
const { useBreakpoint } = Grid
const { Text } = Typography

const NAV = [
  { key: 'overview', labelKey: 'nav.overview' },
  { key: 'sessions', labelKey: 'nav.sessions' },
  { key: 'swarm', labelKey: 'nav.swarm' },
  { key: 'files', labelKey: 'nav.files' },
  { key: 'browser', labelKey: 'nav.browser' },
  { key: 'phone', labelKey: 'nav.phone' },
  { key: 'settings', labelKey: 'nav.env' },
]

// 旧链接兼容：/#/env 重定向到 /#/settings
function normalizeRoute(raw: string): string {
  const route = raw.split('?')[0]
  if (route === 'env' || route.startsWith('env/')) return 'settings' + route.slice(3)
  return route
}

function getHashParams(): URLSearchParams {
  const h = location.hash
  const qi = h.indexOf('?')
  return new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : '')
}

function setHashParams(params: Record<string, string>) {
  const h = location.hash
  const base = (h.split('?')[0]) || '#/sessions'
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) { if (v) sp.set(k, v) }
  const qs = sp.toString()
  const next = qs ? base + '?' + qs : base
  if (h !== next) history.replaceState(null, '', next)
}

// 线性图标（无 emoji，currentColor 描边）
const svg = (paths: any) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths}</svg>
)
const ICONS: Record<string, any> = {
  overview: svg(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>),
  sessions: svg(<><polyline points="5 8 9 12 5 16" /><line x1="12" y1="16" x2="18" y2="16" /></>),
  swarm: svg(<><circle cx="12" cy="5" r="2.4" /><circle cx="5" cy="17" r="2.4" /><circle cx="19" cy="17" r="2.4" /><line x1="12" y1="7.4" x2="6.5" y2="14.8" /><line x1="12" y1="7.4" x2="17.5" y2="14.8" /></>),
  files: svg(<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M7 12h10" /><path d="M7 16h6" /></>),
  settings: svg(<><line x1="4" y1="7" x2="20" y2="7" /><circle cx="9" cy="7" r="2.3" /><line x1="4" y1="17" x2="20" y2="17" /><circle cx="15" cy="17" r="2.3" /></>),
  browser: svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><circle cx="6" cy="6.5" r="0.6" /><circle cx="8.4" cy="6.5" r="0.6" /></>),
  phone: svg(<><rect x="6" y="2" width="12" height="20" rx="2.5" /><line x1="10" y1="18.5" x2="14" y2="18.5" /></>),
  github: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.5 2.87 8.32 6.84 9.67.5.1.68-.22.68-.49 0-.24-.01-.87-.01-1.71-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.36-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.27 2.75 1.05a9.36 9.36 0 0 1 2.5-.34c.85 0 1.71.12 2.5.34 1.91-1.32 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.82 0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.26C22 6.58 17.52 2 12 2z" />
    </svg>
  ),
}


const KEYS: [string, string][] = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'],
  ['^C', '\x03'], ['^D', '\x04'], ['Space', ' '], ['y', 'y'], ['n', 'n'], ['/', '/'], ['q', 'q'],
]

// tmux 基操菜单：前缀键 C-b(\x02) + 命令键，直接发给 tmux attach
// （key 即要发送的字节序列，onClick 时原样发出）
const PFX = '\x02'
const tmuxMenu = (t: (key: string) => string) => [
  { type: 'group', label: t('tmux.split'), children: [
    { key: PFX + '%', label: t('tmux.splitVertical') },
    { key: PFX + '"', label: t('tmux.splitHorizontal') },
  ]},
  { type: 'group', label: t('tmux.pane'), children: [
    { key: PFX + 'o', label: t('tmux.nextPane') },
    { key: PFX + '\x1b[A', label: t('tmux.selectPaneUp') },
    { key: PFX + '\x1b[B', label: t('tmux.selectPaneDown') },
    { key: PFX + '\x1b[D', label: t('tmux.selectPaneLeft') },
    { key: PFX + '\x1b[C', label: t('tmux.selectPaneRight') },
    { key: PFX + 'z', label: t('tmux.zoomPane') },
    { key: PFX + ' ', label: t('tmux.switchLayout') },
    { key: PFX + 'x', label: t('tmux.closePane'), danger: true },
  ]},
  { type: 'group', label: t('tmux.window'), children: [
    { key: PFX + 'c', label: t('tmux.newWindow') },
    { key: PFX + 'n', label: t('tmux.nextWindow') },
    { key: PFX + 'p', label: t('tmux.prevWindow') },
    { key: PFX + 'w', label: t('tmux.windowList') },
    { key: PFX + ',', label: t('tmux.renameWindow') },
  ]},
  { type: 'group', label: t('tmux.other'), children: [
    { key: PFX + '[', label: t('tmux.copyMode') },
    { key: PFX + 'd', label: t('tmux.detach') },
    { key: PFX + 't', label: t('tmux.clock') },
  ]},
] as const

function StatusTag({ status, code }: { status?: string; code?: string }) {
  const { t } = useI18n()
  if (status === 'running') return <Tag color="processing">{t('common.running')}</Tag>
  if (status === 'done') return code && code !== '0' ? <Tag color="error">{t('session.status.failedWithCode', { code })}</Tag> : <Tag color="success">{t('common.done')}</Tag>
  return <Tag>{t('common.ended')}</Tag>
}
function TypeTag({ type }: { type?: string }) {
  const { t } = useI18n()
  return type === 'agent' ? <Tag color="blue">🤖 {t('session.type.agent')}</Tag> : <Tag>⌨️ {t('session.type.command')}</Tag>
}

function pathDirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

function pathBasename(path: string): string {
  return path.split('/').filter(Boolean).pop() || 'file'
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// tmux 给的是 Unix 秒。转成「刚刚 / N 分钟前 …」相对时间，title 里再挂绝对时间。
function relTime(sec: string | number | undefined, t: (k: string, v?: Record<string, string | number>) => string): string {
  const n = typeof sec === 'string' ? parseInt(sec, 10) : sec
  if (!n || !Number.isFinite(n)) return '—'
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - n))
  if (diff < 60) return t('time.justNow')
  if (diff < 3600) return t('time.minutesAgo', { count: Math.floor(diff / 60) })
  if (diff < 86400) return t('time.hoursAgo', { count: Math.floor(diff / 3600) })
  return t('time.daysAgo', { count: Math.floor(diff / 86400) })
}

function absTime(sec: string | number | undefined): string {
  const n = typeof sec === 'string' ? parseInt(sec, 10) : sec
  if (!n || !Number.isFinite(n)) return ''
  return new Date(n * 1000).toLocaleString()
}

function FilesPage({ openTerm }: { openTerm: (name: string) => void }) {
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  const [prefs] = usePreferences()
  const openAgent = async (kind: 'claude' | 'codex', file: string) => {
    const base = pathBasename(file).replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 28) || 'file'
    const name = `${kind}-${base}-${Date.now().toString(36).slice(-5)}`
    const dir = pathDirname(file)
    const prompt = `请打开并查看这个文件：${file}`
    const agentCmd = kind === 'claude' ? (prefs.claudeCommand || 'claude') : (prefs.codexCommand || 'codex')
    const cmd = `${agentCmd} ${shellQuote(prompt)}`
    try {
      const res = await api('POST', '/sessions', { name, dir })
      const actual = res.name || name
      await api('POST', '/tasks/_/send', { sess: actual, msg: cmd })
      message.success(t('file.openedInAgent', { agent: kind === 'claude' ? 'Claude Code' : 'Codex' }))
      openTerm(actual)
    } catch (e: any) {
      message.error(t('file.openFailed', { message: e.message }))
    }
  }
  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex' }}>
      <FileWorkspace dir="" accent="#58a6ff" onOpenAgent={openAgent} />
    </div>
  )
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [route, setRoute] = useState(() => normalizeRoute(location.hash.replace(/^#\/?/, '') || 'sessions'))
  const tab = route.split('/')[0]                                  // 基础页（swarm/leave → swarm）
  const swarmSub = tab === 'swarm' && route.includes('/') ? decodeURIComponent(route.slice(route.indexOf('/') + 1)) : '' // 深链选中的蜂群
  const go = (k: string) => {
    const qi = location.hash.indexOf('?')
    const qs = qi >= 0 ? location.hash.slice(qi) : ''
    location.hash = '#/' + k + qs
  }
  const { mode, toggle: toggleTheme } = useThemeMode()
  const { t } = useI18n()
  const themeIcon = mode === 'dark'
    ? svg(<><circle cx="12" cy="12" r="4.2" /><path d="M12 2v2.2M12 19.8V22M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2 12h2.2M19.8 12H22M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" /></>)
    : svg(<><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" /></>)
  const [collapsed, setCollapsed] = useState(false)
  const screens = useBreakpoint()
  const hasSider = !!screens.md
  const isMobile = !screens.md
  // 全屏（平板更易用：隐藏浏览器栏，等价 F11）。监听变化以同步按钮图标
  const [isFs, setIsFs] = useState(false)
  useEffect(() => {
    const on = () => setIsFs(!!(document.fullscreenElement || (document as any).webkitFullscreenElement))
    document.addEventListener('fullscreenchange', on)
    document.addEventListener('webkitfullscreenchange', on)
    return () => {
      document.removeEventListener('fullscreenchange', on)
      document.removeEventListener('webkitfullscreenchange', on)
    }
  }, [])

  // 多终端状态（从 URL 恢复）
  const [terms, setTerms] = useState<string[]>(() => {
    const t = getHashParams().get('terms')
    return t ? t.split(',').map(decodeURIComponent).filter(Boolean) : []
  })
  const [active, setActive] = useState<string | null>(() => {
    const a = getHashParams().get('active')
    return a ? decodeURIComponent(a) : null
  })
  const [overlay, setOverlay] = useState(false) // 手机/平板全屏终端
  const [dockOpen, setDockOpen] = useState(true) // 桌面：右侧终端停靠栏是否展开
  const [dockMax, setDockMax] = useState(false)  // 桌面：终端栏向左扩展（遮住会话列表）
  const [customDockWidth, setCustomDockWidth] = useState<number | null>(null)
  const resizing = useRef(false)
  const [fontSize, setFontSize] = useState(13)
  const [statusMap, setStatusMap] = useState<Record<string, TermStatus>>({})
  const termRefs = useRef<Record<string, TermHandle | null>>({})
  // Claude Code / Codex 检测（针对已打开的终端）+ 每个标签的「对话/终端」视图切换
  const [claudeMap, setClaudeMap] = useState<Record<string, ClaudeInfo>>({})
  const [claudeView, setClaudeView] = useState<Record<string, boolean>>({})
  const [codexMap, setCodexMap] = useState<Record<string, ClaudeInfo>>({})
  const [codexView, setCodexView] = useState<Record<string, boolean>>({})

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false))
    api('GET', '/me').then(() => {
      setAuthed(true); loadPreferences()
      navigator.clipboard?.readText?.().catch(() => {})
    }).catch(() => setAuthed(false))
  }, [])

  // 终端状态同步到 URL，刷新后可恢复
  useEffect(() => {
    setHashParams({
      terms: terms.map(encodeURIComponent).join(','),
      active: active ? encodeURIComponent(active) : '',
    })
  }, [terms, active])

  // hash 路由：URL #/xxx 与当前页同步（支持前进/后退、刷新保持、收藏分享）
  useEffect(() => {
    const apply = () => setRoute(normalizeRoute(location.hash.replace(/^#\/?/, '') || 'sessions'))
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [])

  // 轮询已打开终端是否在跑 claude / codex（决定是否提供对话入口）
  useEffect(() => {
    if (!authed || terms.length === 0) return
    let stop = false
    const check = () => terms.forEach(async (n) => {
      try { const r = await api('GET', `/sessions/${encodeURIComponent(n)}/claude`); if (!stop) setClaudeMap((m) => ({ ...m, [n]: r.data })) } catch {}
      try { const r = await api('GET', `/sessions/${encodeURIComponent(n)}/codex`); if (!stop) setCodexMap((m) => ({ ...m, [n]: r.data })) } catch {}
    })
    check()
    const t = setInterval(check, 5000)
    return () => { stop = true; clearInterval(t) }
  }, [authed, terms])

  if (authed === null) return <div style={{ height: '100dvh', display: 'grid', placeItems: 'center' }}><Spin size="large" /></div>
  if (!authed) return <Login onOk={() => { setAuthed(true); loadPreferences(); go('overview') }} />

  // 独立单终端页（新标签全屏打开）：hash 路由 #/term/<会话名>
  const soloName = tab === 'term' && route.includes('/') ? decodeURIComponent(route.slice(route.indexOf('/') + 1)) : ''
  if (soloName) return <SoloTerminal name={soloName} />

  const openTerm = (rawName: string) => {
    // tmux 自身会把 '.' ':' 替换为 '_'，前端也同步净化，
    // 确保标签名/WebSocket URL 与 tmux 实际 session 名一致。
    const name = rawName.replace(/[.:]/g, '_')
    setTerms((ts) => (ts.includes(name) ? ts : [...ts, name]))
    setActive(name)
    if (hasSider) { setDockOpen(true); setDockMax(false) } // 桌面：拉出右侧停靠栏（压缩页面到左）
    else setOverlay(true)           // 手机/平板：全屏
  }
  const renameOpenTerm = (oldName: string, newName: string) => {
    if (oldName === newName) return
    setTerms((ts) => Array.from(new Set(ts.map((t) => (t === oldName ? newName : t)))))
    setActive((a) => (a === oldName ? newName : a))
    setStatusMap((m) => {
      if (!(oldName in m)) return m
      const { [oldName]: oldValue, ...rest } = m
      return { ...rest, [newName]: oldValue }
    })
    setClaudeMap((m) => {
      if (!(oldName in m)) return m
      const { [oldName]: oldValue, ...rest } = m
      return { ...rest, [newName]: oldValue }
    })
    setClaudeView((m) => {
      if (!(oldName in m)) return m
      const { [oldName]: oldValue, ...rest } = m
      return { ...rest, [newName]: oldValue }
    })
    setCodexMap((m) => {
      if (!(oldName in m)) return m
      const { [oldName]: oldValue, ...rest } = m
      return { ...rest, [newName]: oldValue }
    })
    setCodexView((m) => {
      if (!(oldName in m)) return m
      const { [oldName]: oldValue, ...rest } = m
      return { ...rest, [newName]: oldValue }
    })
    if (termRefs.current[oldName]) {
      termRefs.current[newName] = termRefs.current[oldName]
      delete termRefs.current[oldName]
    }
  }
  const closeTerm = (name: string) => {
    setTerms((ts) => {
      const next = ts.filter((t) => t !== name)
      setActive((a) => (a === name ? (next[next.length - 1] || null) : a))
      if (next.length === 0) { setOverlay(false); setDockMax(false) }
      return next
    })
    delete termRefs.current[name]
  }
  const anyClaude = terms.some((t) => claudeMap[t]?.running || codexMap[t]?.running)
  const docked = hasSider && terms.length > 0 && dockOpen // 桌面停靠栏已展开
  const dockResizesPage = docked && tab !== 'browser'
  const filesDefaultWidth = typeof window === 'undefined' ? 640 : Math.round((window.innerWidth - (collapsed ? 64 : 208) - 18) * 0.5)
  const defaultDockWidth = tab === 'files' ? Math.max(520, Math.min(900, filesDefaultWidth)) : tab === 'sessions' || tab === 'overview' || tab === 'swarm' || tab === 'settings' || tab === 'phone' ? 420 : 300
  const dockPageWidth = customDockWidth ?? defaultDockWidth
  const setStatus = (name: string, s: TermStatus) => setStatusMap((m) => ({ ...m, [name]: s }))
  const sendKey = (seq: string) => active && termRefs.current[active]?.send(seq)


  // 全屏切换（标准 API + webkit 兜底）。不支持的浏览器（如 iOS Safari）隐藏按钮，改走「添加到主屏幕」
  const docEl: any = document.documentElement
  const fsSupported = !!(docEl.requestFullscreen || docEl.webkitRequestFullscreen)
  const toggleFs = () => {
    const doc: any = document
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc)
    } else {
      (docEl.requestFullscreen || docEl.webkitRequestFullscreen)?.call(docEl)
    }
  }
  const fsIcon = isFs
    ? svg(<><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="20" y2="4" /><line x1="4" y1="20" x2="10" y2="14" /></>)
    : svg(<><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></>)

  const termPane = (
    <TerminalPane
      terms={terms} active={active} setActive={setActive} closeTerm={closeTerm}
      fontSize={fontSize} setFontSize={setFontSize} statusMap={statusMap} setStatus={setStatus}
      termRefs={termRefs} sendKey={sendKey}
      claudeMap={claudeMap} claudeView={claudeView} setClaudeView={setClaudeView}
      codexMap={codexMap} codexView={codexView} setCodexView={setCodexView}
      onRename={renameOpenTerm}
      onCollapse={() => { setOverlay(false); setDockOpen(false) }}
    />
  )

  const pages: any = {
    overview: <Overview go={go} openTerm={openTerm} />,
    swarm: <Swarm openTerm={openTerm} initialSwarm={swarmSub || undefined} onNav={(n) => { location.hash = n ? '#/swarm/' + encodeURIComponent(n) : '#/swarm' }} />,
    sessions: <Sessions openTerm={openTerm} closeTerm={closeTerm} activeTerm={active} />,
    files: <FilesPage openTerm={openTerm} />,
    settings: <EnvPage />,
    browser: <BrowserView />,
    phone: <PhoneView />,
    about: <AboutPage />,
  }
  const page = pages[tab] || pages.sessions
  // browser 全幅(自带工具栏铺满)；phone 与概览/会话一致走 tt-page（同 16px 留白 + 满高，见 tt-page-phone）。
  const pageNode = tab === 'browser'
    ? page
    : <div className={`tt-page tt-page-${tab}${isMobile ? ' tt-page-mobile' : ''}`}>{page}</div>

  const menu = (
    <Menu
      theme={mode} mode="inline" selectedKeys={[tab]} onClick={(e) => go(e.key)}
      items={NAV.map((n) => ({ key: n.key, icon: ICONS[n.key], label: t(n.labelKey) }))}
      style={{ borderInlineEnd: 0, background: 'transparent' }}
    />
  )

  return (
    <Layout style={{ height: '100dvh', overflow: 'hidden', background: 'var(--bg-base)' }}>
      <UpdateBanner />
      {hasSider && !dockMax && (
        <Sider collapsible trigger={null} collapsed={collapsed} collapsedWidth={64}
          breakpoint="lg" onBreakpoint={(b) => setCollapsed(b)} width={208} theme={mode}
          style={{ position: 'sticky', top: 0, height: '100dvh', background: 'var(--bg-base)', borderRight: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: collapsed ? '18px 0 16px' : '18px 18px 16px', justifyContent: collapsed ? 'center' : 'flex-start' }}>
              <img src="/logo-mark.svg" width={34} height={34} alt="Roam"
                style={{ flex: '0 0 auto', borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,.5)' }} />
              {!collapsed && (
                <div style={{ lineHeight: 1.15 }}>
                  <div style={{
                    fontWeight: 800, fontSize: 19, letterSpacing: 0.5,
                    background: 'var(--brand-grad)',
                    WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent',
                  }}>Roam</div>
                  <div style={{ color: 'var(--text-dimmer)', fontSize: 10, letterSpacing: 1.5 }}>{t('app.tagline')}</div>
                </div>
              )}
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>{menu}</div>
            {/* 底部：收起 在上，其次 全屏，最后 退出，始终竖向堆叠（展开带文字，折叠仅图标居中）。*/}
            <div style={{ borderTop: '1px solid var(--border-subtle)', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Button type="text" block onClick={() => go('about')} title={t('nav.about')}
                style={{ color: tab === 'about' ? '#58a6ff' : 'var(--text-dim)', textAlign: collapsed ? 'center' : 'left' }}>
                {collapsed ? ICONS.github : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{ICONS.github}{t('nav.about')}</span>}
              </Button>
              <Button type="text" block onClick={() => setCollapsed((c) => !c)} style={{ color: 'var(--text-dim)', textAlign: collapsed ? 'center' : 'left' }}
                title={collapsed ? t('common.expand') : t('common.collapse')}>
                {(() => { const icon = svg(collapsed ? <><polyline points="9 6 15 12 9 18" /></> : <><polyline points="15 6 9 12 15 18" /></>)
                  return collapsed ? icon : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{icon}{t('common.collapse')}</span> })()}
              </Button>
              {fsSupported && (
                <Button type="text" block onClick={toggleFs} style={{ color: 'var(--text-dim)', textAlign: collapsed ? 'center' : 'left' }}
                  title={isFs ? t('common.exitFullscreen') : t('common.fullscreen')}>
                  {collapsed ? fsIcon : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{fsIcon}{isFs ? t('common.exitFullscreen') : t('common.fullscreen')}</span>}
                </Button>
              )}
              <Popconfirm title={t('common.logoutConfirm')} okText={t('common.logout')} cancelText={t('common.cancel')} onConfirm={logout} placement="topRight">
                <Button type="text" block style={{ color: 'var(--text-dim)', textAlign: collapsed ? 'center' : 'left' }} title={t('common.exit')}>
                  {(() => { const icon = svg(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>)
                    return collapsed ? icon : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{icon}{t('common.exit')}</span> })()}
                </Button>
              </Popconfirm>
            </div>
          </div>
        </Sider>
      )}

      {/* 主区：左侧页面 + 右侧可停靠终端栏（桌面）。开终端时页面向左压缩。*/}
      <Layout style={{ background: 'var(--bg-base)' }}>
        <div style={{ display: 'flex', height: '100dvh', minHeight: 0 }}>
          <Content style={{
            // 终端弹出时左侧页面保留可读宽度；继续向左扩展(dockMax)则收到 0、被终端遮住
            flex: dockResizesPage ? (dockMax ? '0 0 0px' : `0 0 ${dockPageWidth}px`) : 1,
            width: dockResizesPage ? (dockMax ? 0 : dockPageWidth) : 'auto', minWidth: 0,
            height: '100dvh', overflow: tab === 'browser' || tab === 'phone' || tab === 'files' ? 'hidden' : 'auto',
            padding: 0,
            transition: customDockWidth != null ? 'none' : 'flex-basis .2s, width .2s',
          }}>
            {pageNode}
          </Content>

          {/* 角标把手：上半=向左扩展（大点击区），中间细条=拖拽调宽，下半=向右收起（大点击区）。*/}
          {hasSider && terms.length > 0 && (
            <div style={{
              flex: '0 0 18px', background: 'var(--bg-container)', borderLeft: '1px solid var(--border)',
              display: 'flex', flexDirection: 'column', color: anyClaude ? '#58a6ff' : 'var(--text-dim)', userSelect: 'none',
            }}>
              {/* 上半：向左扩展 / 展开 —— 占据上半区，点击区大 */}
              <div onClick={() => (dockOpen ? setDockMax(true) : setDockOpen(true))}
                title={!dockOpen ? t('terminal.expandTitle') : t('terminal.expandLeftTitle')}
                style={{
                  flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5,
                  borderBottom: '1px solid var(--border)', cursor: dockMax ? 'default' : 'pointer', opacity: dockMax ? 0.3 : 1,
                }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 6 L7 12 L13 18" /><path d="M18 6 L12 12 L18 18" />
                </svg>
                <span style={{ writingMode: 'vertical-rl', letterSpacing: 1, fontSize: 11, fontWeight: 600 }}>{dockOpen ? t('common.extend') : t('common.expand')}</span>
                <span style={{ fontSize: 10, background: '#1f6feb', color: '#fff', borderRadius: 8, padding: '0 4px', lineHeight: 1.35 }}>{terms.length}</span>
              </div>
              {/* 中间：拖拽调整宽度（占中间 1/3，三等分） */}
              <div
                style={{ flex: 1, cursor: 'col-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', borderBottom: '1px solid var(--border)' }}
                title={t('common.dragToResize') || 'Drag to resize'}
                onMouseDown={(e) => {
                  e.preventDefault()
                  resizing.current = true
                  const siderWidth = collapsed ? 64 : 208
                  const startX = e.clientX
                  const startW = dockPageWidth
                  const onMove = (ev: MouseEvent) => {
                    if (!resizing.current) return
                    const delta = ev.clientX - startX
                    const next = Math.max(280, Math.min(window.innerWidth - siderWidth - 200, startW + delta))
                    setCustomDockWidth(next)
                  }
                  const onUp = () => { resizing.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
                  window.addEventListener('mousemove', onMove)
                  window.addEventListener('mouseup', onUp)
                }}
              >
                <svg width="6" height="48" viewBox="0 0 6 48" fill="currentColor" opacity="0.5">
                  <circle cx="1.5" cy="6" r="1.5" /><circle cx="4.5" cy="6" r="1.5" />
                  <circle cx="1.5" cy="14" r="1.5" /><circle cx="4.5" cy="14" r="1.5" />
                  <circle cx="1.5" cy="22" r="1.5" /><circle cx="4.5" cy="22" r="1.5" />
                  <circle cx="1.5" cy="30" r="1.5" /><circle cx="4.5" cy="30" r="1.5" />
                  <circle cx="1.5" cy="38" r="1.5" /><circle cx="4.5" cy="38" r="1.5" />
                </svg>
              </div>
              {/* 下半：向右收起 / 还原 —— 占据下半区，点击区大 */}
              <div onClick={() => (dockMax ? setDockMax(false) : setDockOpen(false))}
                title={dockMax ? t('terminal.restoreTitle') : t('terminal.collapseRightTitle')}
                style={{
                  flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5,
                  cursor: dockOpen ? 'pointer' : 'default', opacity: dockOpen ? 1 : 0.3,
                }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 6 L17 12 L11 18" /><path d="M6 6 L12 12 L6 18" />
                </svg>
                <span style={{ writingMode: 'vertical-rl', letterSpacing: 1, fontSize: 11, fontWeight: 600 }}>{dockMax ? t('common.restore') : t('common.collapse')}</span>
              </div>
            </div>
          )}

          {/* 右侧终端停靠栏（桌面）：常驻挂载以保留连接，收起时宽度归零 */}
          {hasSider && terms.length > 0 && (
            <div
              onTransitionEnd={() => window.dispatchEvent(new Event('resize'))}
              style={{
              flex: dockOpen ? 1 : '0 0 0px', minWidth: dockOpen ? 480 : 0,
              width: dockOpen ? 'auto' : 0, overflow: 'hidden', transition: 'flex-basis .2s, min-width .2s',
              display: 'flex', flexDirection: 'column', background: 'var(--bg-term)',
            }}>
              {termPane}
            </div>
          )}
        </div>
      </Layout>

      {isMobile && (
        <nav style={{ position: 'fixed', bottom: 0, left: 0, right: 0, display: 'flex', background: 'var(--bg-container)', borderTop: '1px solid var(--border)', zIndex: 50, paddingBottom: 'env(safe-area-inset-bottom)' }}>
          {NAV.map((n) => (
            <button key={n.key} onClick={() => go(n.key)}
              style={{ flex: 1, border: 0, background: 'none', color: tab === n.key ? '#58a6ff' : 'var(--text-dim)', padding: '8px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, fontSize: 11 }}>
              {ICONS[n.key]}{t(n.labelKey)}
            </button>
          ))}
          {/* 主题/全屏/退出折叠进「更多」，省出底栏空间 */}
          <Dropdown placement="top" trigger={['click']} menu={{ items: [
            { key: 'theme', icon: themeIcon, label: mode === 'dark' ? t('common.lightTheme') : t('common.darkTheme'), onClick: toggleTheme },
            ...(fsSupported ? [{ key: 'fs', icon: fsIcon, label: isFs ? t('common.exitFullscreen') : t('common.fullscreen'), onClick: toggleFs }] : []),
            { key: 'about', icon: ICONS.github, label: t('nav.about'), onClick: () => go('about') },
            { type: 'divider' as const },
            { key: 'logout', danger: true, label: t('common.logout'), onClick: () => Modal.confirm({ title: t('common.logoutConfirm'), okText: t('common.logout'), cancelText: t('common.cancel'), okButtonProps: { danger: true }, onOk: logout }) },
          ] }}>
            <button
              style={{ flex: 1, border: 0, background: 'none', color: 'var(--text-dim)', padding: '8px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, fontSize: 11 }}>
              {svg(<><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>)}{t('common.more')}
            </button>
          </Dropdown>
        </nav>
      )}

      {/* 手机/平板：全屏会话覆盖层（桌面用右侧停靠栏，不走这里）*/}
      {isMobile && overlay && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'var(--bg-term)', display: 'flex', flexDirection: 'column' }}>
          {termPane}
        </div>
      )}
    </Layout>
  )

  function logout() {
    api('POST', '/logout').catch(() => {}).finally(() => setAuthed(false))
  }
}

// ── 独立单终端页：新浏览器标签全屏打开单个会话（hash 路由 #/term/name）──
function SoloTerminal({ name }: { name: string }) {
  const [fontSize, setFontSize] = useState(13)
  const [statusMap, setStatusMap] = useState<Record<string, TermStatus>>({})
  const [claudeMap, setClaudeMap] = useState<Record<string, ClaudeInfo>>({})
  const [claudeView, setClaudeView] = useState<Record<string, boolean>>({})
  const [codexMap, setCodexMap] = useState<Record<string, ClaudeInfo>>({})
  const [codexView, setCodexView] = useState<Record<string, boolean>>({})
  const termRefs = useRef<Record<string, TermHandle | null>>({})

  useEffect(() => { document.title = `Roam · ${name}` }, [name])
  useEffect(() => {
    let stop = false
    const check = async () => {
      try { const r = await api('GET', `/sessions/${encodeURIComponent(name)}/claude`); if (!stop) setClaudeMap((m) => ({ ...m, [name]: r.data })) } catch {}
      try { const r = await api('GET', `/sessions/${encodeURIComponent(name)}/codex`); if (!stop) setCodexMap((m) => ({ ...m, [name]: r.data })) } catch {}
    }
    check()
    const t = setInterval(check, 5000)
    return () => { stop = true; clearInterval(t) }
  }, [name])

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg-term)', display: 'flex', flexDirection: 'column' }}>
      <TerminalPane
        terms={[name]} active={name} setActive={() => {}} closeTerm={() => window.close()}
        fontSize={fontSize} setFontSize={setFontSize}
        statusMap={statusMap} setStatus={(n, s) => setStatusMap((m) => ({ ...m, [n]: s }))}
        termRefs={termRefs} sendKey={(seq) => termRefs.current[name]?.send(seq)}
        claudeMap={claudeMap} claudeView={claudeView} setClaudeView={setClaudeView}
        codexMap={codexMap} codexView={codexView} setCodexView={setCodexView}
        onRename={(_, newName) => { location.hash = '#/term/' + encodeURIComponent(newName) }}
        fileDock="left"
      />
    </div>
  )
}

// ── 终端面板（多标签 + 工具栏 + 快捷键栏），桌面右栏与手机覆盖层共用 ──
function TerminalPane(props: {
  terms: string[]; active: string | null; setActive: (n: string) => void; closeTerm: (n: string) => void
  fontSize: number; setFontSize: (n: number) => void
  statusMap: Record<string, TermStatus>; setStatus: (n: string, s: TermStatus) => void
  termRefs: React.MutableRefObject<Record<string, TermHandle | null>>
  sendKey: (seq: string) => void; onCollapse?: () => void
  claudeMap: Record<string, ClaudeInfo>; claudeView: Record<string, boolean>; setClaudeView: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  codexMap: Record<string, ClaudeInfo>; codexView: Record<string, boolean>; setCodexView: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  onRename: (oldName: string, newName: string) => void
  fileDock?: 'right' | 'left'   // 文件面板停靠：'right'=右侧浮动抽屉（默认），'left'=左侧 VSCode 栏（新标签全屏页）
}) {
  const { terms, active, setActive, closeTerm, fontSize, setFontSize, statusMap, setStatus, termRefs, sendKey, onCollapse, claudeMap, claudeView, setClaudeView, codexMap, codexView, setCodexView, onRename } = props
  const fileDock = props.fileDock || 'right'
  const { message, modal } = AntApp.useApp()
  const { t } = useI18n()
  const st = active ? statusMap[active] : undefined
  const [termNeedsInput, setTermNeedsInput] = useState<Record<string, boolean>>({})
  const activeNeedsInput = !!(active && termNeedsInput[active])
  const dot = activeNeedsInput ? '#d29922' : st === 'connected' ? '#3fb950' : st === 'connecting' ? '#d29922' : '#f85149'
  // 当前标签是否在 Claude/Codex 对话视图：此时聊天 UI 自带输入框，
  // 终端那条移动输入条 + 快捷键栏要隐藏，否则手机上会出现两个输入框。
  const inChat = !!active && ((claudeView[active] && claudeMap[active]?.running) || (codexView[active] && codexMap[active]?.running))

  // 移动端可靠输入：xterm 隐藏 textarea 在软键盘/输入法「合成/预测词」下会把字留在
  // 合成缓冲里不提交，onData 不触发 → 打完字发不出去。触摸设备改用独立输入框：整行送 PTY。
  const isTouch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
  const [line, setLine] = useState('')
  const mobileInputRef = useRef<import('antd').InputRef>(null)
  const sendRaw = (s: string) => { if (active) termRefs.current[active]?.send(s, true) } // keepFocus：不抢 xterm 焦点 → 软键盘不收起
  // 滚上去看历史会让 tmux 进 copy-mode，此时输入被它截走（要先按「底」才生效）。
  // 输入框聚焦/发送前先回到底部退出 copy-mode，省去手动按「底」。
  const exitCopyMode = () => { if (active) termRefs.current[active]?.toBottom() }
  const flushLine = () => { if (line) { exitCopyMode(); sendRaw(line); setLine('') } }   // 把输入框待发文本先送出（不带回车）
  const submitLine = () => { exitCopyMode(); sendRaw(line + '\r'); setLine('') }          // 整行 + 回车
  const tapKey = (seq: string) => { flushLine(); if (isTouch) sendRaw(seq); else sendKey(seq) } // 控制键：先 flush 待发文本
  const noBlur = isTouch ? (e: React.MouseEvent) => e.preventDefault() : undefined        // 点按钮不夺走输入框焦点（软键盘保持）

  // 弹框提醒全局开关
  const [prefsData] = usePreferences()
  const promptOff = !!prefsData.promptPopupOff
  const togglePromptOff = () => savePreferences({ promptPopupOff: !promptOff })

  const showVoice = prefsData.showVoiceButton !== false
  const setShowVoice = (v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === 'function' ? v(showVoice) : v
    savePreferences({ showVoiceButton: next })
  }

  // 文件侧栏（终端视图下也可用）：定位到当前会话的工作目录。左侧停靠时默认展开。
  // 编辑器多 tab / 打开的文件 / 拖拽调宽等都下沉到 <FileWorkspace>（左侧停靠时用），这里只保留 showFiles。
  const [showFiles, setShowFiles] = useState(fileDock === 'left')
  const [showGit, setShowGit] = useState(false)
  const [cwd, setCwd] = useState('')
  // 文件栏与 Git 面板共用右侧抽屉位，互斥显示。
  const toggleFiles = () => setShowFiles((s) => { if (!s) setShowGit(false); return !s })
  const toggleGit = () => setShowGit((s) => { if (!s) setShowFiles(false); return !s })

  // 从文件/Git 面板把文件拖到终端 → 插入为 @绝对路径。
  const [dragOver, setDragOver] = useState(false)
  useEffect(() => {
    const clear = () => setDragOver(false)
    document.addEventListener('dragend', clear)
    document.addEventListener('drop', clear, true)
    return () => { document.removeEventListener('dragend', clear); document.removeEventListener('drop', clear, true) }
  }, [])
  // 拖拽载荷就是文件绝对路径，原样作为 @mention（不转相对路径）。
  const toMention = (raw: string) => {
    const p = raw.trim()
    return p ? '@' + p : ''
  }
  const readDropPath = (e: React.DragEvent) =>
    e.dataTransfer.getData('application/x-ttmux-path') || e.dataTransfer.getData('text/plain') || ''
  const isPathDrag = (e: React.DragEvent) => e.dataTransfer.types.includes('application/x-ttmux-path')
  const allowPathDrop = (e: React.DragEvent) => {
    if (!isPathDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  // 落点是否在终端区右半 → 让给 FileWorkspace 做分栏（VSCode 式：右半区拆栏，左/中区注入@）。
  const inTermSplitZone = (e: React.DragEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientX > r.left + r.width / 2
  }
  // 拖到终端区：直接把 @路径 送进当前会话（claude/codex TUI 或 shell 提示符的光标处）。
  const onTermDrop = (e: React.DragEvent) => {
    if (!isPathDrag(e)) return
    if (inTermSplitZone(e)) { setDragOver(false); return } // 右半区：不拦截，冒泡给 FileWorkspace 分栏
    e.preventDefault()
    e.stopPropagation() // 左/中区：拖到终端=注入@，不冒泡到分栏
    setDragOver(false)
    const mention = toMention(readDropPath(e))
    if (!mention || !active) return
    // 分窗(tmux split pane)时：先按落点坐标激活对应 pane，@路径才会注入到拖放的那个窗格。
    termRefs.current[active]?.selectPaneAt(e.clientX, e.clientY)
    exitCopyMode()
    termRefs.current[active]?.send(mention + ' ', true)
  }
  // 拖到移动端输入框：追加到待编辑文本，用户可改后再发。
  const onInputDrop = (e: React.DragEvent) => {
    if (!isPathDrag(e)) return
    e.preventDefault()
    const mention = toMention(readDropPath(e))
    if (mention) setLine((l) => (l ? l.replace(/\s*$/, ' ') : '') + mention + ' ')
  }
  const [ctx, setCtx] = useState<{ x: number; y: number; session: string; selection: string } | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteSession, setPasteSession] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [renameSession, setRenameSession] = useState<string | null>(null)
  useEffect(() => {
    if (!active) { setCwd(''); return }
    // 优先用 claude/codex 已知工作目录，否则查会话 pane 当前路径
    const known = claudeMap[active]?.dir || codexMap[active]?.dir
    if (known) { setCwd(known); return }
    let stop = false
    api('GET', `/sessions/${encodeURIComponent(active)}/cwd`).then((r) => { if (!stop) setCwd(r.data?.dir || '') }).catch(() => {})
    return () => { stop = true }
  }, [active, claudeMap, codexMap])

  useEffect(() => {
    if (!terms.length) { setTermNeedsInput({}); return }
    let stop = false
    const checkPrompts = async () => {
      const entries = await Promise.all(terms.map(async (name) => {
        try {
          const r = await api('GET', `/sessions/${encodeURIComponent(name)}/capture?lines=50`)
          return [name, !!detectPrompt(r.data || '')] as const
        } catch {
          return [name, false] as const
        }
      }))
      if (!stop) setTermNeedsInput(Object.fromEntries(entries))
    }
    checkPrompts()
    const t = setInterval(checkPrompts, 4000)
    return () => { stop = true; clearInterval(t) }
  }, [terms])

  const sendPaste = (session: string, text: string) => {
    if (!text) return
    termRefs.current[session]?.send(text.replace(/\r\n/g, '\n'), true)
  }
  const openManualPaste = (session: string) => {
    setPasteSession(session)
    setPasteText('')
    setPasteOpen(true)
  }
  const pasteImage = async (session: string, rawFiles: File[]) => {
    const files = rawFiles.map((f, i) => makeClipboardImageFile(f, f.type, i))
    message.loading({ content: t('terminal.imageUploading'), key: 'img-paste', duration: 0 })
    try {
      const res = await upload('/tmp', files)
      sendPaste(session, res.saved.map((p: string) => '@' + p).join(' '))
      message.success({ content: t('terminal.imagePasted', { count: files.length }), key: 'img-paste' })
    } catch (e: any) {
      message.error({ content: t('terminal.imageUploadFailed', { message: e.message }), key: 'img-paste' })
    }
  }
  const pasteClipboard = async (session: string) => {
    try {
      if (navigator.clipboard?.read) {
        try {
          const items = await navigator.clipboard.read()
          const imageFiles: File[] = []
          let text = ''
          for (const item of items) {
            for (const type of item.types) {
              if (type.startsWith('image/')) {
                const blob = await item.getType(type)
                imageFiles.push(new File([blob], 'image', { type }))
              } else if (type === 'text/plain') {
                text = await (await item.getType(type)).text()
              }
            }
          }
          if (imageFiles.length > 0) { pasteImage(session, imageFiles); return }
          if (text) { sendPaste(session, text); return }
        } catch { /* clipboard.read() failed — fall through to readText */ }
      }
      const text = await navigator.clipboard.readText()
      if (text) sendPaste(session, text)
      else openManualPaste(session)
    } catch {
      openManualPaste(session)
    }
  }
  const selText = ctx?.selection?.trim() || ''
  const selPreview = selText.replace(/\s+/g, ' ').slice(0, 28)
  const ctxItems = ctx ? [
    ...(selText ? [
      {
        key: 'copy',
        label: (
          <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontWeight: 600 }}>{t('terminal.copySelected')}</span>
            <span style={{ color: 'var(--text-dimmer)', fontSize: 12, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              “{selPreview}{selText.length > selPreview.length ? '…' : ''}”
            </span>
          </span>
        ),
      },
      { type: 'divider' as const },
    ] : []),
    { key: 'paste', label: t('terminal.pasteClipboard') },
    { key: 'manual-paste', label: t('terminal.manualPaste') },
    { type: 'divider' as const },
    { key: 'scroll-up', label: t('terminal.scrollHistory') },
    { key: 'bottom', label: t('terminal.toBottom') },
    { key: 'reconnect', label: t('terminal.reconnect') },
    { type: 'divider' as const },
    {
      key: 'tmux',
      label: 'tmux',
      children: [
        { key: PFX + '[', label: t('terminal.tmuxCopyMode') },
        { key: PFX + 'w', label: t('terminal.tmuxWindowList') },
        { key: PFX + '%', label: t('terminal.tmuxSplitVertical') },
        { key: PFX + '"', label: t('terminal.tmuxSplitHorizontal') },
      ],
    },
    { type: 'divider' as const },
    { key: 'cancel', label: t('common.cancel') },
  ] : []
  const onCtxClick = ({ key }: { key: string }) => {
    if (!ctx) return
    const h = termRefs.current[ctx.session]
    if (key === 'cancel') { /* 仅关闭菜单 */ }
    else if (key === 'copy') { copyText(ctx.selection); message.success(t('common.copied')); h?.clearSelection() }
    else if (key === 'paste') pasteClipboard(ctx.session)
    else if (key === 'manual-paste') openManualPaste(ctx.session)
    else if (key === 'scroll-up') h?.scroll(-12)
    else if (key === 'bottom') h?.toBottom()
    else if (key === 'reconnect') h?.reconnect()
    else h?.send(key)
    setCtx(null)
  }
  if (terms.length === 0) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-dim)' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 40 }}>▸</div>
          <div>{t('terminal.openHint', { terminal: t('common.terminal') })}</div>
        </div>
      </div>
    )
  }

  // ── 会话（终端）各部件抽成局部 JSX：左侧停靠走 <FileWorkspace> 的槽位，右侧抽屉走原地布局，二者共用同一份 ──
  const sessionTab = (
    <>
      <i style={{ width: 7, height: 7, borderRadius: '50%', background: active && statusMap[active] === 'connected' ? '#3fb950' : '#d29922' }} />
      {active}
    </>
  )
  const tabStrip = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', borderBottom: '1px solid var(--border)', overflowX: 'auto' }}>
      {onCollapse && <Button size="small" type="text" style={{ color: 'var(--text-dim)' }} onClick={onCollapse}>✕ {t('common.collapse')}</Button>}
      {terms.map((termName) => (
        <span key={termName} onClick={() => setActive(termName)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap',
            background: termName === active ? '#1f6feb33' : 'transparent', border: termName === active ? '1px solid #1f6feb' : '1px solid var(--border)', color: 'var(--text-bright)',
          }}>
          <i style={{ width: 7, height: 7, borderRadius: '50%', background: termNeedsInput[termName] ? '#d29922' : (statusMap[termName] === 'connected' ? '#3fb950' : statusMap[termName] === 'connecting' ? '#d29922' : '#f85149') }} />
          {termNeedsInput[termName] && <span title={t('prompt.confirmRequired')} style={{ color: '#d29922', fontSize: 12, fontWeight: 600 }}>{t('session.waiting')}</span>}
          {claudeMap[termName]?.running && <span title={t('session.runningClaude')} style={{ color: '#58a6ff' }}>✳</span>}
          {codexMap[termName]?.running && <span title={t('session.runningCodex')} style={{ color: '#10a37f' }}>✸</span>}
          {termName}
          <a onClick={(e) => { e.stopPropagation(); closeTerm(termName) }} style={{ color: 'var(--text-dim)' }}>×</a>
        </span>
      ))}
    </div>
  )
  const sessionToolbar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-dim)', fontSize: 12 }}>
        <i style={{ width: 8, height: 8, borderRadius: '50%', background: dot }} />
        {activeNeedsInput ? t('session.waiting') : st === 'connected' ? t('terminal.status.connected') : st === 'connecting' ? t('terminal.status.connecting') : t('terminal.status.disconnected')}
      </span>
      {active && claudeMap[active]?.running && (
        <Tooltip title={t('chat.switchToClaude')}>
          <Button size="small" type={claudeView[active] ? 'primary' : 'default'}
            onClick={() => setClaudeView((v) => ({ ...v, [active!]: !v[active!] }))}>✳ Claude</Button>
        </Tooltip>
      )}
      {active && codexMap[active]?.running && (
        <Tooltip title={t('chat.switchToCodex')}>
          <Button size="small" type={codexView[active] ? 'primary' : 'default'}
            style={codexView[active] ? { background: '#10a37f', borderColor: '#10a37f' } : {}}
            onClick={() => setCodexView((v) => ({ ...v, [active!]: !v[active!] }))}>✸ Codex</Button>
        </Tooltip>
      )}
      <Dropdown trigger={['click']} menu={{ items: tmuxMenu(t) as any, onClick: ({ key }) => sendKey(key) }} placement="bottomLeft">
        <Button size="small" type="primary" ghost>tmux ▾</Button>
      </Dropdown>
      {active && (
        <Tooltip title={t('terminal.openInNewTabTitle')}>
          <Button size="small" onClick={() => window.open(`/#/term/${encodeURIComponent(active)}`, '_blank')}>↗ {t('terminal.newTab')}</Button>
        </Tooltip>
      )}
      {active && <Button size="small" onClick={() => setRenameSession(active)}>{t('session.rename')}</Button>}
      <Tooltip title={promptOff ? t('prompt.popupOff') : t('prompt.popupOn')}>
        <Button size="small" type={promptOff ? 'default' : 'primary'} ghost={!promptOff} onClick={togglePromptOff}>{promptOff ? '🔕' : '🔔'} {t('prompt.popup')}</Button>
      </Tooltip>
      <Tooltip title={t('terminal.fileBrowserTitle')}>
        <Button size="small" type={showFiles ? 'primary' : 'default'} onClick={toggleFiles}>📁 {t('chat.files')}</Button>
      </Tooltip>
      <Tooltip title={t('terminal.gitPanelTitle')}>
        <Button size="small" type={showGit ? 'primary' : 'default'} onClick={toggleGit}
          icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-2px' }}><circle cx="6" cy="6" r="2.3" /><circle cx="6" cy="18" r="2.3" /><circle cx="18" cy="8" r="2.3" /><path d="M6 8.3v7.4" /><path d="M18 10.3a6 6 0 0 1-6 6H8.3" /></svg>}>
          {t('git.title')}
        </Button>
      </Tooltip>
      <Tooltip title={showVoice ? t('voice.hideButton') : t('voice.showButton')}>
        <Button size="small" type={showVoice ? 'primary' : 'default'} onClick={() => setShowVoice((v) => !v)}>🎤</Button>
      </Tooltip>
      <span style={{ flex: 1 }} />
      <Tooltip title={t('terminal.scrollHistory')}><Button size="small" onClick={() => active && termRefs.current[active]?.scroll(-12)}>▲</Button></Tooltip>
      <Tooltip title={t('terminal.toBottom')}><Button size="small" onClick={() => active && termRefs.current[active]?.toBottom()}>{t('terminal.bottomShort')}</Button></Tooltip>
      <Tooltip title={t('terminal.decreaseFont')}><Button size="small" onClick={() => setFontSize(Math.max(10, fontSize - 1))}>A-</Button></Tooltip>
      <Tooltip title={t('terminal.increaseFont')}><Button size="small" onClick={() => setFontSize(Math.min(22, fontSize + 1))}>A+</Button></Tooltip>
      <Tooltip title={t('terminal.reconnect')}><Button size="small" onClick={() => active && termRefs.current[active]?.reconnect()}>{t('terminal.reconnectShort')}</Button></Tooltip>
    </div>
  )
  const terminalArea = (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}
      onDragOver={(e) => {
        if (!isPathDrag(e)) return
        if (inTermSplitZone(e)) { setDragOver(false); return } // 右半区：让事件冒泡给 FileWorkspace 显示分栏提示
        e.stopPropagation(); allowPathDrop(e); setDragOver(true)
      }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false) }}
      onDrop={onTermDrop}>
      {dragOver && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 5, pointerEvents: 'none',
          border: '2px dashed #58a6ff', borderRadius: 8, background: 'rgba(88,166,255,.08)',
          display: 'grid', placeItems: 'center', color: '#58a6ff', fontSize: 14, fontWeight: 600,
        }}>{t('terminal.dropToMention')}</div>
      )}
      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        {terms.map((termName) => (
          <div key={termName} style={{ position: 'absolute', inset: 0, display: termName === active ? 'block' : 'none', padding: 6 }}>
            <Term ref={(h) => { termRefs.current[termName] = h }} name={termName} fontSize={fontSize} active={termName === active} onStatus={(s) => setStatus(termName, s)}
              onContextMenu={({ x, y, selection }) => { setActive(termName); setCtx({ x, y, session: termName, selection }) }}
              onSelectionMenu={({ selection }) => { setActive(termName); setCtx(null); if (selection.trim()) { copyText(selection); message.success(t('common.copied')) } }}
              onPaste={() => { setActive(termName); pasteClipboard(termName) }}
              onImagePaste={(files) => { setActive(termName); pasteImage(termName, files) }} />
            {claudeView[termName] && claudeMap[termName]?.running && (
              <div style={{ position: 'absolute', inset: 0 }}>
                <ClaudeChat name={termName} file={claudeMap[termName].file} dir={claudeMap[termName].dir} onBack={() => setClaudeView((v) => ({ ...v, [termName]: false }))} />
              </div>
            )}
            {codexView[termName] && codexMap[termName]?.running && (
              <div style={{ position: 'absolute', inset: 0 }}>
                <CodexChat name={termName} file={codexMap[termName].file} dir={codexMap[termName].dir} onBack={() => setCodexView((v) => ({ ...v, [termName]: false }))} />
              </div>
            )}
            {showVoice && !claudeView[termName] && !codexView[termName] && (
              <VoiceInput accent="#58a6ff" onResult={(text) => { api('POST', `/sessions/${encodeURIComponent(termName)}/type`, { text }).catch((e: any) => message.error(e.message)) }} />
            )}
          </div>
        ))}
      </div>
    </div>
  )
  const sessionBottom = (
    <>
      {isTouch && !inChat && (
        <div style={{ display: 'flex', gap: 6, padding: '8px 8px 0' }} onDragOver={allowPathDrop} onDrop={onInputDrop}>
          <Input ref={mobileInputRef} value={line} onFocus={exitCopyMode} onChange={(e) => setLine(e.target.value)}
            onPressEnter={(e) => { if ((e.nativeEvent as any).isComposing) return; submitLine() }}
            placeholder={t('terminal.mobileInputPlaceholder')} allowClear autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
          <Button type="primary" onMouseDown={noBlur} onClick={submitLine}>{t('common.send')}</Button>
        </div>
      )}
      {!inChat && (
        <div style={{ display: 'flex', gap: 6, padding: 8, borderTop: '1px solid var(--border)', overflowX: 'auto' }}>
          <Button type="primary" onMouseDown={noBlur} onClick={() => (isTouch ? submitLine() : sendKey('\r'))}>Enter</Button>
          {(prefsData.quickCommands || []).map((cmd) => (
            <Button key={cmd} onMouseDown={noBlur} onClick={() => { if (isTouch) { setLine(cmd); requestAnimationFrame(() => mobileInputRef.current?.focus()) } else { sendRaw(cmd) } }} style={{ flex: '0 0 auto' }}>{cmd}</Button>
          ))}
          {KEYS.map(([label, seq]) => (
            <Button key={label} onMouseDown={noBlur} onClick={() => tapKey(seq)} style={{ flex: '0 0 auto' }}>{label}</Button>
          ))}
          <Button onMouseDown={noBlur} style={{ flex: '0 0 auto', borderStyle: 'dashed' }} onClick={() => {
            let val = ''
            modal.confirm({
              title: t('settings.quickCommands'),
              content: <Input placeholder={t('settings.quickCommandPlaceholder')} onChange={(e) => (val = e.target.value)} autoFocus />,
              okText: t('quickCmd.addOk'),
              onOk: () => {
                const v = val.trim()
                if (!v) return
                if ((prefsData.quickCommands || []).includes(v)) return
                savePreferences({ quickCommands: [...(prefsData.quickCommands || []), v] })
              },
            })
          }}>{t('quickCmd.add')}</Button>
        </div>
      )}
    </>
  )

  return (
    // paddingBottom=env(keyboard-inset-height)：软键盘悬浮覆盖时(见 main.tsx/index.html)，
    // 把整块内容抬到键盘之上，让底部输入条/快捷键栏不被遮住。桌面无虚拟键盘 → 0，无影响。
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, paddingBottom: 'env(keyboard-inset-height, 0px)', transition: 'padding-bottom .15s ease-out' }}>
      {active && <PromptDialog name={active} accent={codexMap[active]?.running ? '#10a37f' : '#58a6ff'} enabled={!inChat && !promptOff} />}
      <Modal
        open={pasteOpen}
        title={t('terminal.pasteTitle')}
        okText={t('terminal.pasteAction')}
        cancelText={t('common.cancel')}
        destroyOnClose
        onCancel={() => setPasteOpen(false)}
        onOk={() => {
          sendPaste(pasteSession, pasteText)
          setPasteOpen(false)
          message.success(t('terminal.pasted'))
        }}
      >
        <Input.TextArea
          autoFocus
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          autoSize={{ minRows: 6, maxRows: 12 }}
          placeholder={t('terminal.pastePlaceholder')}
        />
        <div style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 8 }}>
          {t('terminal.pasteHelp')}
        </div>
      </Modal>
      <RenameSessionModal session={renameSession} onClose={() => setRenameSession(null)} onDone={onRename} />
      <Dropdown
        open={!!ctx}
        trigger={[]}
        menu={{ items: ctxItems as any, onClick: onCtxClick }}
        onOpenChange={(open) => { if (!open) setCtx(null) }}
        placement="bottomLeft"
      >
        <span style={{ position: 'fixed', left: ctx?.x ?? -1000, top: ctx?.y ?? -1000, width: 1, height: 1, pointerEvents: 'none' }} />
      </Dropdown>
      {/* 独立全屏页（左侧文件停靠）：顶部细标题栏显示会话名，横跨左右；下面才是「左文件 / 右会话」 */}
      {fileDock === 'left' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px', borderBottom: '1px solid var(--border)', minHeight: 32 }}>
          <span style={{ color: 'var(--text-bright)', fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{active || ''}</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.5, background: 'var(--brand-grad)', WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Roam</span>
        </div>
      )}
      {/* 内容主体：左侧走 <FileWorkspace>（文件树 + 编辑器多 tab）；右侧抽屉走原地布局。
          会话（终端）各部件用上面抽出的 sessionTab/sessionToolbar/terminalArea/sessionBottom 复用。 */}
      {fileDock === 'left' ? (
        <FileWorkspace
          dir={cwd} accent="#58a6ff"
          explorerOpen={showFiles} onExplorerClose={() => setShowFiles(false)}
          leadingTitle={active || ''} leadingTab={sessionTab}
          leadingContent={terminalArea} chrome={sessionToolbar} footer={sessionBottom}
        />
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {tabStrip}
            {sessionToolbar}
            {terminalArea}
            {sessionBottom}
          </div>
        </div>
      )}
      {fileDock === 'right' && (
        <FloatingFileDrawer open={showFiles}>
          <FileBrowser dir={cwd} accent="#58a6ff" onClose={() => setShowFiles(false)} />
        </FloatingFileDrawer>
      )}
      <FloatingFileDrawer open={showGit}>
        <GitPanel dir={cwd} accent="#58a6ff" onClose={() => setShowGit(false)} />
      </FloatingFileDrawer>
    </div>
  )
}

// ── 登录 ──
const PW_KEY = 'ttmux_pw' // 「记住密码」本地存储键
function Login({ onOk }: { onOk: () => void }) {
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  const [loading, setLoading] = useState(false)
  const [totp, setTotp] = useState(false) // 是否开启两步验证
  const saved = (() => { try { return localStorage.getItem(PW_KEY) || '' } catch { return '' } })()

  // 问后端是否要动态码（公开端点）
  useEffect(() => { api('GET', '/pubconfig').then((r) => setTotp(!!r?.data?.totp)).catch(() => {}) }, [])

  return (
    <div style={{ height: '100dvh', display: 'grid', placeItems: 'center', padding: 16, background: 'var(--bg-base)' }}>
      <Card style={{ width: 'min(360px,92vw)' }}>
        <div style={{ textAlign: 'center', marginBottom: 18 }}>
          <img src="/logo-mark.svg" width={64} height={64} alt="Roam" style={{ borderRadius: 14 }} />
          <div style={{
            fontSize: 30, fontWeight: 800, letterSpacing: 1, marginTop: 12,
            background: 'var(--brand-grad)',
            WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent',
          }}>Roam</div>
          <div style={{ color: 'var(--text-dimmer)', fontSize: 12, marginTop: 4, letterSpacing: 0.5 }}>{t('auth.tagline')}</div>
        </div>
        <Form
          initialValues={{ password: saved, remember: !!saved }}
          onFinish={async (v) => {
            setLoading(true)
            try {
              await api('POST', '/login', { password: v.password, code: (v.code || '').trim() })
              try { v.remember ? localStorage.setItem(PW_KEY, v.password) : localStorage.removeItem(PW_KEY) } catch {}
              onOk()
            }
            catch (e: any) {
              message.error(/BAD_CODE/.test(e.message) ? t('auth.badCode') : /LOCKED/.test(e.message) ? t('auth.locked') : t('auth.loginFailed'))
            } finally { setLoading(false) }
          }}
        >
          <Form.Item name="password" rules={[{ required: true, message: t('auth.passwordRequired') }]}>
            <Input.Password size="large" placeholder={t('auth.password')} autoFocus={!saved} />
          </Form.Item>
          {totp && (
            <Form.Item name="code" rules={[{ required: true, message: t('auth.codeRequired') }]}>
              <Input size="large" placeholder={t('auth.codePlaceholder')} inputMode="numeric" maxLength={6} autoFocus={!!saved} />
            </Form.Item>
          )}
          <Form.Item name="remember" valuePropName="checked" style={{ marginBottom: 12 }}>
            <Checkbox>{t('auth.rememberPassword')}</Checkbox>
          </Form.Item>
          <Button type="primary" size="large" block htmlType="submit" loading={loading}>{t('auth.login')}</Button>
        </Form>
      </Card>
    </div>
  )
}

// ── 概览（仪表盘）──
// 蜂群状态 → 颜色/中文
function SwarmStatusTag({ status }: { status?: string }) {
  const { t } = useI18n()
  const m: Record<string, [string, string]> = {
    planning: ['blue', t('swarm.status.planning')], running: ['processing', t('common.running')],
    integrating: ['gold', t('swarm.status.integrating')], done: ['success', t('common.done')], archived: ['default', t('swarm.status.archived')],
  }
  const [c, l] = m[status || ''] || ['default', status || '—']
  return <Tag color={c} style={{ margin: 0 }}>{l}</Tag>
}

// 统计磁贴：左侧色块图标 + 大数字 + 标签，可点跳转
function StatTile({ icon, label, value, accent, onClick }: {
  icon: any; label: string; value: any; accent: string; onClick?: () => void
}) {
  return (
    <Card size="small" hoverable={!!onClick} onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default', background: 'var(--bg-container)', borderColor: 'var(--border-subtle)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, flex: '0 0 auto', display: 'grid', placeItems: 'center', color: accent, background: accent + '22' }}>{icon}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.1, color: 'var(--text-bright)' }}>{value}</div>
          <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>{label}</div>
        </div>
      </div>
    </Card>
  )
}

function Overview({ go, openTerm }: { go: (k: string) => void; openTerm: (n: string) => void }) {
  const { t } = useI18n()
  const [info, setInfo] = useState<any>(null)
  const [swarms, setSwarms] = useState<any[]>([])
  const [sessions, setSessions] = useState<any[]>([])
  const load = () => {
    api('GET', '/info').then(setInfo).catch(() => {})
    api('GET', '/swarms').then((r) => setSwarms(Array.isArray(r) ? r : [])).catch(() => {})
    api('GET', '/sessions').then((r) => setSessions(Array.isArray(r) ? r : [])).catch(() => {})
  }
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t) }, [])

  const aliveMembers = swarms.reduce((n, x) => n + (x.alive || 0), 0)
  const pendingMembers = swarms.reduce((n, x) => n + (x.pending || 0), 0)
  const chip = { color: 'var(--text-dim)', background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', fontSize: 12 }

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      {/* Hero */}
      <div style={{ borderRadius: 14, padding: '22px 24px', background: 'linear-gradient(135deg,var(--bg-container) 0%,var(--bg-base) 100%)', border: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <img src="/logo-mark.svg" width={48} height={48} alt="Roam" style={{ flex: '0 0 auto', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,.5)' }} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-bright)' }}>{t('overview.welcome')}</div>
            <div style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 4 }}>{t('overview.subtitle')}</div>
          </div>
          <Space wrap>
            <Button type="primary" onClick={() => go('sessions')}>{t('overview.enterSessions')}</Button>
            <Button onClick={() => go('swarm')}>{t('overview.viewSwarm')}</Button>
          </Space>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          <Tag bordered={false} style={chip}>ttmux {info?.version || '—'}</Tag>
          <Tag bordered={false} style={chip}>tmux {info?.tmux_version || '—'}</Tag>
          {info?.data_dir && <Tag bordered={false} style={chip}>📁 {info.data_dir}</Tag>}
        </div>
      </div>

      {/* 统计磁贴 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
        {[
          { icon: ICONS.sessions, label: t('nav.sessions'), value: info?.sessions ?? sessions.length, accent: '#58a6ff', onClick: () => go('sessions') },
          { icon: ICONS.swarm, label: t('nav.swarm'), value: swarms.length, accent: '#58a6ff', onClick: () => go('swarm') },
          { icon: ICONS.swarm, label: t('overview.activeMembers'), value: aliveMembers, accent: '#3fb950', onClick: () => go('swarm') },
          { icon: ICONS.overview, label: t('overview.pendingUnlock'), value: pendingMembers, accent: '#d29922', onClick: () => go('swarm') },
        ].map((p, i) => <div key={i} style={{ flex: '1 1 140px', minWidth: 140 }}><StatTile {...p} /></div>)}
      </div>

      {/* 蜂群 + 会话 双栏 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
        <div style={{ flex: '1 1 360px', minWidth: 280 }}>
          <Card title={<Space><span style={{ color: '#58a6ff' }}>◆</span>{t('nav.swarm')}</Space>} extra={<a onClick={() => go('swarm')}>{t('common.all')} →</a>}>
            {swarms.length === 0 ? <Empty description={t('overview.noSwarms')} /> : (
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {swarms.slice(0, 5).map((s: any) => (
                  <div key={s.id || s.name} onClick={() => go('swarm')}
                    style={{ cursor: 'pointer', padding: '10px 12px', borderRadius: 10, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-bright)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                      <span style={{ flex: '0 0 auto' }}><SwarmStatusTag status={s.status} /></span>
                      {s.supervisor && <Text type="secondary" style={{ fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>◆{s.supervisor}</Text>}
                      <span style={{ flex: 1, minWidth: 8 }} />
                      <span style={{ color: 'var(--text-dim)', fontSize: 12, whiteSpace: 'nowrap', flex: '0 0 auto' }}>{t('overview.swarmCounts', { alive: s.alive, total: s.total })}{s.pending ? ` · ${t('overview.pendingShort', { count: s.pending })}` : ''}</span>
                    </div>
                    <div style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.goal || t('overview.noGoal')}</div>
                    <Progress percent={s.total ? Math.round((s.alive / s.total) * 100) : 0} showInfo={false} size="small" strokeColor="#58a6ff" trailColor="var(--border-subtle)" style={{ marginBottom: 0, marginTop: 6 }} />
                  </div>
                ))}
              </Space>
            )}
          </Card>
        </div>
        <div style={{ flex: '1 1 360px', minWidth: 280 }}>
          <Card title={t('nav.sessions')} extra={<a onClick={() => go('sessions')}>{t('common.all')} →</a>}>
            {sessions.length === 0 ? <Empty description={t('session.noActive')} /> : (
              <List size="small" dataSource={sessions.slice(0, 6)} renderItem={(s: any) => (
                <List.Item style={{ padding: '8px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minWidth: 0 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ color: 'var(--text-bright)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.name}>{s.name}</div>
                      <div style={{ color: 'var(--text-dim)', fontSize: 12, whiteSpace: 'nowrap' }} title={`${t('session.createdAt')} ${absTime(s.created)} · ${t('session.lastActivity')} ${absTime(s.last_activity)}`}>{t('session.windows', { count: s.windows })} · {s.attached == 1 ? t('terminal.status.connected') : t('terminal.status.idle')} · {t('session.lastActivity')} {relTime(s.last_activity, t)}</div>
                    </div>
                    <a onClick={() => openTerm(s.name)} style={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}>{t('common.terminal')}</a>
                  </div>
                </List.Item>
              )} />
            )}
          </Card>
        </div>
      </div>
    </Space>
  )
}

// ── 任务（命令 + Agent 统一） ──
function Tasks({ openTerm }: { openTerm: (n: string) => void }) {
  const [groups, setGroups] = useState<any[]>([])
  const [detail, setDetail] = useState<Record<string, any>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [spawn, setSpawn] = useState(false)
  const [send, setSend] = useState<any[] | null>(null)
  const [collect, setCollect] = useState<string | null>(null)
  const { message } = AntApp.useApp()
  const { t } = useI18n()

  const loadGroups = () => api('GET', '/tasks').then(setGroups).catch(() => {})
  const loadDetail = (g: string) => api('GET', '/tasks/' + encodeURIComponent(g)).then((d) => setDetail((s) => ({ ...s, [g]: d }))).catch(() => {})
  useEffect(() => { loadGroups() }, [])
  useEffect(() => {
    if (!open) return
    loadDetail(open)
    const t = setInterval(() => loadDetail(open), 3000)
    return () => clearInterval(t)
  }, [open])

  const kill = async (g: string) => {
    try { await api('DELETE', '/tasks/' + encodeURIComponent(g)); message.success(t('task.cleaned')); setOpen(null); loadGroups() }
    catch (e: any) { message.error(e.message) }
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <div><Button type="primary" onClick={() => setSpawn(true)}>+ {t('task.create')}</Button></div>
      {groups.length === 0 && <Empty description={t('task.noGroups')} />}
      {groups.map((g: any) => (
        <Card key={g.group} size="small"
          title={<span onClick={() => setOpen(open === g.group ? null : g.group)} style={{ cursor: 'pointer' }}>
            {g.group} <Text type="secondary" style={{ fontSize: 13 }}>{t('task.aliveCount', { alive: g.alive, total: g.total })}</Text></span>}
          extra={<Popconfirm title={t('task.cleanConfirm', { group: g.group })} onConfirm={() => kill(g.group)}><Button danger size="small">{t('task.clean')}</Button></Popconfirm>}
        >
          {open === g.group && (
            <>
              <List size="small" dataSource={detail[g.group]?.tasks || []} locale={{ emptyText: t('common.loading') }}
                renderItem={(t: any) => (
                  <List.Item actions={[
                    <a key="t" onClick={() => openTerm(t.name)}>{t('common.terminal')}</a>,
                  ]}>
                    <List.Item.Meta
                      title={<Space><span>{t.name}</span><TypeTag type={t.type} /><StatusTag status={t.status} code={t.exit_code} /></Space>}
                      description={t.task ? <Text type="secondary" style={{ fontSize: 12 }}>{t.task}</Text> : null}
                    />
                  </List.Item>
                )} />
              <Space style={{ marginTop: 10 }}>
                <Button size="small" onClick={() => setCollect(g.group)}>{t('task.collectOutput')}</Button>
                <Button size="small" onClick={() => setSend(detail[g.group]?.tasks || [])}>{t('task.appendInstruction')}</Button>
              </Space>
            </>
          )}
        </Card>
      ))}
      <SpawnModal open={spawn} onClose={() => setSpawn(false)} onDone={loadGroups} />
      <SendModal tasks={send} onClose={() => setSend(null)} />
      <CollectModal group={collect} onClose={() => setCollect(null)} />
    </Space>
  )
}

// ── 服务器目录选择器 ──
// 最近用过的工作目录（服务端偏好 + localStorage 兜底），作为目录选择器的快捷候选
import { getPreferences } from './preferences'
const RECENT_DIRS_KEY = 'ttmux_recent_dirs'
export function recentDirs(): string[] {
  const fromPrefs = getPreferences().recentDirs
  if (fromPrefs && fromPrefs.length > 0) return fromPrefs
  try { return JSON.parse(localStorage.getItem(RECENT_DIRS_KEY) || '[]') } catch { return [] }
}
export function pushRecentDir(d: string) {
  if (!d || !d.trim()) return
  const dirs = [d.trim(), ...recentDirs().filter((x) => x !== d.trim())].slice(0, 8)
  savePreferences({ recentDirs: dirs })
  try { localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(dirs)) } catch {}
}

export function DirPicker({ open, start, onPick, onClose }: { open: boolean; start?: string; onPick: (p: string) => void; onClose: () => void }) {
  const [data, setData] = useState<any>({ path: '', parent: '', dirs: [] })
  const [recent, setRecent] = useState<string[]>([])
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  const load = (p?: string) => api('GET', '/fs' + (p !== undefined ? '?path=' + encodeURIComponent(p) : '')).then((r) => setData(r.data)).catch((e) => message.error(e.message))
  useEffect(() => { if (open) { setRecent(recentDirs()); load(start || undefined) } }, [open])
  const enter = (d: string) => load((data.path === '/' ? '' : data.path) + '/' + d)
  const choose = (p: string) => { pushRecentDir(p); onPick(p) }
  return (
    <Modal open={open} onCancel={onClose} title={t('dirPicker.title')} zIndex={1100}
      footer={[<Button key="c" onClick={onClose}>{t('common.cancel')}</Button>, <Button key="o" type="primary" onClick={() => choose(data.path)}>{t('dirPicker.chooseCurrent')}</Button>]}>
      {/* 快捷候选：家目录 + 最近用过的目录 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        <Tag style={{ cursor: 'pointer', margin: 0 }} onClick={() => load(undefined)}>🏠 {t('dirPicker.home')}</Tag>
        {recent.map((d) => (
          <Tooltip key={d} title={d}>
            <Tag color="blue" style={{ cursor: 'pointer', margin: 0, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}
              onClick={() => load(d)} onDoubleClick={() => choose(d)}>
              {d.split('/').filter(Boolean).pop() || d}
            </Tag>
          </Tooltip>
        ))}
      </div>
      <div style={{ fontFamily: 'monospace', color: 'var(--text-dim)', marginBottom: 8, wordBreak: 'break-all' }}>{data.path || '…'}</div>
      <List size="small" style={{ maxHeight: '50vh', overflow: 'auto' }}
        dataSource={['..', ...(data.dirs || [])]}
        renderItem={(d: string) => (
          <List.Item style={{ cursor: 'pointer' }} onClick={() => (d === '..' ? load(data.parent) : enter(d))}>
            <span style={{ color: d === '..' ? 'var(--text-dim)' : 'var(--text-bright)' }}>{d === '..' ? `↑ ${t('file.parentDir')}` : '▸ ' + d}</span>
          </List.Item>
        )} />
    </Modal>
  )
}

// ── 新建会话（可选工作目录） ──
function NewSessionModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState('')
  const [dir, setDir] = useState('')
  const [pick, setPick] = useState(false)
  const [agent, setAgent] = useState<'none' | 'claude' | 'codex'>('none')
  const [worktree, setWorktree] = useState(false)
  const [isGitRepo, setIsGitRepo] = useState(false)
  const [creating, setCreating] = useState(false)
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  const [prefs] = usePreferences()
  useEffect(() => { if (open) { setName(''); setDir(''); setAgent('none'); setWorktree(false); setIsGitRepo(false) } }, [open])
  useEffect(() => {
    const d = dir.trim()
    if (!d) { setIsGitRepo(false); return }
    let cancelled = false
    api('GET', `/git/is-repo?path=${encodeURIComponent(d)}`).then((r) => {
      if (!cancelled) setIsGitRepo(!!r?.data?.repo)
    }).catch(() => { if (!cancelled) setIsGitRepo(false) })
    return () => { cancelled = true }
  }, [dir])
  const ok = async () => {
    if (!name.trim()) return message.error(t('session.nameRequired'))
    let worktreePath = ''
    try {
      setCreating(true)
      let sessionDir = dir.trim()
      if (worktree && isGitRepo && sessionDir) {
        const wt = await api('POST', '/git/worktree', { dir: sessionDir })
        worktreePath = wt?.data?.path || ''
        if (worktreePath) sessionDir = worktreePath
      }
      const res = await api('POST', '/sessions', { name: name.trim(), dir: sessionDir })
      const actual = res.name || name.trim()
      if (agent !== 'none') {
        const cmd = agent === 'claude' ? (prefs.claudeCommand || 'claude') : (prefs.codexCommand || 'codex')
        await api('POST', '/tasks/_/send', { sess: actual, msg: cmd })
      }
      pushRecentDir(dir); message.success(t('session.created')); onClose(); onDone(actual)
    }
    catch (e: any) {
      if (worktreePath) {
        api('POST', '/git/worktree/remove', { path: worktreePath }).catch(() => {})
      }
      message.error(e.message)
    }
    finally { setCreating(false) }
  }
  return (
    <>
      <Modal open={open} onCancel={onClose} onOk={ok} okText={t('file.create')} title={t('session.new')} destroyOnClose
        confirmLoading={creating}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input placeholder={t('session.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <Space.Compact style={{ width: '100%' }}>
            <AutoComplete style={{ flex: 1 }} value={dir} onChange={setDir}
              options={recentDirs().map((d) => ({ value: d }))}
              filterOption={(input, opt) => String(opt?.value).toLowerCase().includes(input.toLowerCase())}
              placeholder={t('session.dirPlaceholder')} />
            <Button onClick={() => setPick(true)}>{t('common.browse')}</Button>
          </Space.Compact>
          {recentDirs().length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {recentDirs().map((d) => (
                <Tooltip key={d} title={d}>
                  <Tag color={d === dir ? 'blue' : undefined} style={{ cursor: 'pointer', margin: 0, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}
                    onClick={() => setDir(d)}>
                    {d.split('/').filter(Boolean).pop() || d}
                  </Tag>
                </Tooltip>
              ))}
            </div>
          )}
          {isGitRepo && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Switch size="small" checked={worktree} onChange={setWorktree} />
              <span style={{ fontSize: 13 }}>{t('session.worktreeMode')}</span>
            </div>
          )}
          <Radio.Group value={agent} onChange={(e) => setAgent(e.target.value)} optionType="button" buttonStyle="solid"
            style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            <Radio.Button value="none">{t('session.agentNone')}</Radio.Button>
            <Radio.Button value="claude">{t('session.agentClaude')}</Radio.Button>
            <Radio.Button value="codex">{t('session.agentCodex')}</Radio.Button>
          </Radio.Group>
        </Space>
      </Modal>
      <DirPicker open={pick} start={dir || undefined} onPick={(p) => { setDir(p); setPick(false) }} onClose={() => setPick(false)} />
    </>
  )
}

function RenameSessionModal({ session, onClose, onDone }: { session: string | null; onClose: () => void; onDone: (oldName: string, newName: string) => void }) {
  const [name, setName] = useState('')
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  useEffect(() => { if (session) setName(session) }, [session])
  const ok = async () => {
    if (!session) return
    const next = name.trim()
    if (!next) return message.error(t('session.nameRequired'))
    try {
      const res = await api('PATCH', `/sessions/${encodeURIComponent(session)}`, { name: next })
      const actual = res.data?.name || next
      message.success(t('session.renamed'))
      onClose()
      onDone(session, actual)
    } catch (e: any) {
      message.error(e.message)
    }
  }
  return (
    <Modal open={!!session} onCancel={onClose} onOk={ok} okText={t('session.rename')} title={t('session.renameTitle')} destroyOnClose>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Input placeholder={t('session.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Space>
    </Modal>
  )
}

// ── 会话（可新建/指定目录 / 进终端 / 关闭） ──
function Sessions({ openTerm, closeTerm, activeTerm }: { openTerm: (n: string) => void; closeTerm: (n: string) => void; activeTerm: string | null }) {
  const [list, setList] = useState<any[]>([])
  const [cc, setCc] = useState<Record<string, boolean>>({})
  const [cx, setCx] = useState<Record<string, boolean>>({})
  const [needsInput, setNeedsInput] = useState<Record<string, boolean>>({})
  const [swarmMap, setSwarmMap] = useState<Record<string, { swarm: string; role: string }>>({})
  const [newOpen, setNewOpen] = useState(false)
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  const load = () => api('GET', '/sessions').then(setList).catch(() => {})
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t) }, [])
  // 拉取蜂群拓扑：哪些会话其实是蜂群的指挥/成员。会话页和蜂群页看到的是同一批 tmux 会话，
  // 这里据成员的真实 session 名(非前缀猜测)打标，并据此拦住「关闭」误把成员当完成解锁下游。
  useEffect(() => {
    let stop = false
    const loadSwarms = async () => {
      try {
        const swarms = await api('GET', '/swarms')
        if (!Array.isArray(swarms)) return
        const map: Record<string, { swarm: string; role: string }> = {}
        await Promise.all(swarms.map(async (sw: any) => {
          try {
            const st = await api('GET', `/swarms/${encodeURIComponent(sw.name)}`)
            if (st?.supervisor) map[st.supervisor] = { swarm: sw.name, role: 'leader' }
            for (const m of (st?.members || [])) {
              if (m?.session) map[m.session] = { swarm: sw.name, role: m.role === 'leader' || m.role === 'master' ? 'leader' : 'member' }
            }
          } catch {}
        }))
        if (!stop) setSwarmMap(map)
      } catch {}
    }
    loadSwarms()
    const t = setInterval(loadSwarms, 8000)
    return () => { stop = true; clearInterval(t) }
  }, [])
  // 标注哪些会话在跑 Claude Code
  useEffect(() => {
    let stop = false
    const check = () => list.forEach(async (s: any) => {
      try { const r = await api('GET', `/sessions/${encodeURIComponent(s.name)}/claude`); if (!stop) setCc((m) => ({ ...m, [s.name]: !!r.data?.running })) } catch {}
      try { const r = await api('GET', `/sessions/${encodeURIComponent(s.name)}/codex`); if (!stop) setCx((m) => ({ ...m, [s.name]: !!r.data?.running })) } catch {}
    })
    if (list.length) check()
    const t = setInterval(() => { if (list.length) check() }, 5000)
    return () => { stop = true; clearInterval(t) }
  }, [list])
  // 识别卡在人类决策/审批点的会话，列表上给出醒目标识，方便及时介入。
  useEffect(() => {
    if (!list.length) { setNeedsInput({}); return }
    let stop = false
    const checkPrompts = async () => {
      const entries = await Promise.all(list.map(async (s: any) => {
        try {
          const r = await api('GET', `/sessions/${encodeURIComponent(s.name)}/capture?lines=50`)
          return [s.name, !!detectPrompt(r.data || '')] as const
        } catch {
          return [s.name, false] as const
        }
      }))
      if (!stop) setNeedsInput(Object.fromEntries(entries))
    }
    checkPrompts()
    const t = setInterval(checkPrompts, 4000)
    return () => { stop = true; clearInterval(t) }
  }, [list])
  const kill = async (n: string) => { try { await api('DELETE', '/sessions/' + encodeURIComponent(n)); message.success(t('session.closed')); closeTerm(n); load() } catch (e: any) { message.error(e.message) } }
  const goSwarm = (sw: string) => { location.hash = '#/swarm/' + encodeURIComponent(sw) }

  // ── 筛选 / 搜索 ──
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'waiting' | 'claude' | 'codex' | 'swarm' | 'idle'>('all')
  const ql = q.trim().toLowerCase()
  const isSwarm = (s: any) => !!swarmMap[s.name]
  // 默认不展示蜂群会话（它们有专门的蜂群页）；仅「蜂群」筛选时才列出
  const match = (s: any, f: typeof filter) => {
    if (f === 'swarm') return isSwarm(s)
    if (f === 'waiting') return !!needsInput[s.name]
    if (isSwarm(s)) return false
    switch (f) {
      case 'claude': return !!cc[s.name]
      case 'codex': return !!cx[s.name]
      case 'idle': return !cc[s.name] && !cx[s.name]
      default: return true
    }
  }
  const filtered = list.filter((s: any) => (!ql || s.name.toLowerCase().includes(ql)) && match(s, filter))
  const cnt = (f: typeof filter) => list.filter((s: any) => match(s, f)).length

  // ── 排序：名称 / 创建时间 / 最后响应时间，可切升降序 ──
  const [sortBy, setSortBy] = useState<'name' | 'created' | 'activity'>('activity')
  const [sortAsc, setSortAsc] = useState(false)
  const num = (v: any) => parseInt(v, 10) || 0
  const sorted = [...filtered].sort((a: any, b: any) => {
    const d = sortBy === 'name'
      ? a.name.localeCompare(b.name)
      : num(a[sortBy === 'created' ? 'created' : 'last_activity']) - num(b[sortBy === 'created' ? 'created' : 'last_activity'])
    return sortAsc ? d : -d
  })

  return (
    <Card
      title={<Space size={8}>{t('nav.sessions')}<Tag style={{ margin: 0 }}>{cnt('all')}</Tag></Space>}
      extra={<Button type="primary" onClick={() => setNewOpen(true)}>+ {t('session.new')}</Button>}
    >
      {/* 工具条：搜索 + 排序同一行，类型筛选另起一行 */}
      <div style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Input allowClear value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('session.searchPlaceholder')}
            style={{ flex: 1, minWidth: 0 }}
            prefix={svg(<><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>)} />
          <Select value={sortBy} onChange={(v) => setSortBy(v)} title={t('session.sortBy')}
            style={{ width: 120, flex: '0 0 auto' }} options={[
              { label: t('session.sortActivity'), value: 'activity' },
              { label: t('session.sortCreated'), value: 'created' },
              { label: t('session.sortName'), value: 'name' },
            ]} />
          <Button onClick={() => setSortAsc((v) => !v)} style={{ flex: '0 0 auto' }}
            title={sortAsc ? t('session.sortAsc') : t('session.sortDesc')}>
            {sortAsc ? '↑' : '↓'}
          </Button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <Segmented block value={filter} onChange={(v) => setFilter(v as any)} size="small" options={[
            { label: `${t('common.all')} ${cnt('all')}`, value: 'all' },
            { label: `${t('session.waiting')} ${cnt('waiting')}`, value: 'waiting' },
            { label: `Claude ${cnt('claude')}`, value: 'claude' },
            { label: `Codex ${cnt('codex')}`, value: 'codex' },
            { label: `${t('nav.swarm')} ${cnt('swarm')}`, value: 'swarm' },
            { label: `${t('terminal.status.idle')} ${cnt('idle')}`, value: 'idle' },
          ]} />
        </div>
      </div>

      {list.length === 0 ? <Empty description={t('session.noActive')} />
        : filtered.length === 0 ? <Empty description={t('session.noMatches')} />
          : (
            <List dataSource={sorted} renderItem={(s: any) => {
              const sw = swarmMap[s.name]
              const connected = s.attached == 1
              const agent = cc[s.name] ? 'claude' : cx[s.name] ? 'codex' : null
              const waiting = !!needsInput[s.name]
              const activeRow = activeTerm === s.name
              return (
                // 整行点击直接进入终端；右侧操作区 stopPropagation 不触发进入
                <List.Item style={{
                  position: 'relative', overflow: 'hidden',
                  padding: '10px 8px 10px 12px', cursor: 'pointer', borderRadius: 8,
                  background: activeRow ? 'linear-gradient(90deg, rgba(31,111,235,.38), rgba(31,111,235,.16))' : undefined,
                  border: activeRow ? '1px solid #58a6ff' : '1px solid transparent',
                  boxShadow: activeRow ? '0 0 0 1px rgba(88,166,255,.18), 0 0 18px rgba(31,111,235,.14)' : undefined,
                }} onClick={() => openTerm(s.name)}>
                  {activeRow && <span aria-hidden style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: '#58a6ff' }} />}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                      <i title={waiting ? t('prompt.confirmRequired') : connected ? t('terminal.status.connected') : t('terminal.status.idle')} style={{ width: 8, height: 8, borderRadius: '50%', flex: '0 0 8px', background: waiting ? '#d29922' : connected ? '#3fb950' : 'var(--text-dimmer)' }} />
                      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 700, color: activeRow ? '#fff' : 'var(--text-bright)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.name}>{s.name}</span>
                          {sw && <Tag color="blue" style={{ margin: 0, flex: '0 0 auto' }}>{t('nav.swarm')}:{sw.swarm}{sw.role === 'leader' ? `·${t('swarm.master')}` : ''}</Tag>}
                          {waiting && <Tag color="warning" style={{ margin: 0, flex: '0 0 auto' }}>{t('session.waiting')}</Tag>}
                          {cc[s.name] && <Tag color="blue" style={{ margin: 0, flex: '0 0 auto' }}>✳ Claude</Tag>}
                          {cx[s.name] && <Tag color="green" style={{ margin: 0, flex: '0 0 auto' }}>✸ Codex</Tag>}
                          {!sw && !agent && <Tag style={{ margin: 0, flex: '0 0 auto' }}>{connected ? t('terminal.status.connected') : t('terminal.status.idle')}</Tag>}
                          <span style={{ color: 'var(--text-dim)', fontSize: 12, flex: '0 0 auto', whiteSpace: 'nowrap' }}>{t('session.windows', { count: s.windows })}</span>
                        </div>
                        <div style={{ color: 'var(--text-dimmer)', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <span title={absTime(s.created)}>{t('session.createdAt')} {relTime(s.created, t)}</span>
                          <span style={{ margin: '0 6px' }}>·</span>
                          <span title={absTime(s.last_activity)}>{t('session.lastActivity')} {relTime(s.last_activity, t)}</span>
                        </div>
                      </div>
                    </div>
                    <div onClick={(e) => e.stopPropagation()} style={{ marginLeft: 'auto', display: 'flex', gap: 14, alignItems: 'center', flex: '0 0 auto', whiteSpace: 'nowrap' }}>
                      {sw && <a onClick={() => goSwarm(sw.swarm)}>{t('session.swarmPage')}</a>}
                      {sw ? (
                        <Popconfirm
                          title={t('session.closeSwarmSessionTitle')}
                          description={<div style={{ maxWidth: 280 }}>{t('session.closeSwarmSessionDesc', { swarm: sw.swarm, role: sw.role === 'leader' ? t('swarm.master') : t('swarm.member') })}</div>}
                          okText={t('session.closeAnyway')} okButtonProps={{ danger: true }} cancelText={t('common.cancel')}
                          onConfirm={() => kill(s.name)}>
                          <a style={{ color: '#f85149' }}>{t('session.close')}</a>
                        </Popconfirm>
                      ) : (
                        <Popconfirm title={t('session.closeConfirm', { name: s.name })} onConfirm={() => kill(s.name)}>
                          <a style={{ color: '#f85149' }}>{t('session.close')}</a>
                        </Popconfirm>
                      )}
                    </div>
                  </div>
                </List.Item>
              )
            }} />
          )}
      <NewSessionModal open={newOpen} onClose={() => setNewOpen(false)} onDone={(name) => { load(); openTerm(name) }} />
    </Card>
  )
}

// ── Agent 命令配置 ──
function AgentCommandsCard() {
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  const [prefs, setPrefs] = usePreferences()
  const [claudeCmd, setClaudeCmd] = useState(prefs.claudeCommand || 'claude')
  const [codexCmd, setCodexCmd] = useState(prefs.codexCommand || 'codex')
  useEffect(() => { setClaudeCmd(prefs.claudeCommand || 'claude') }, [prefs.claudeCommand])
  useEffect(() => { setCodexCmd(prefs.codexCommand || 'codex') }, [prefs.codexCommand])
  const save = () => {
    setPrefs({ claudeCommand: claudeCmd.trim() || 'claude', codexCommand: codexCmd.trim() || 'codex' })
    message.success(t('settings.saved'))
  }
  return (
    <Card title={t('settings.agentCommands')}>
      <Space direction="vertical" size="small" style={{ width: '100%', maxWidth: 520 }}>
        <Input addonBefore="Claude" value={claudeCmd} onChange={(e) => setClaudeCmd(e.target.value)} />
        <Input addonBefore="Codex" value={codexCmd} onChange={(e) => setCodexCmd(e.target.value)} />
        <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('settings.agentCommandsHelp')}</span>
        <Button type="primary" onClick={save}>{t('settings.save')}</Button>
      </Space>
    </Card>
  )
}

function PromptPopupCard() {
  const { t } = useI18n()
  const [prefs, setPrefs] = usePreferences()
  return (
    <Card title={t('settings.promptPopupDefault')}>
      <Space align="center" wrap>
        <Switch checked={!prefs.promptPopupOff} onChange={(on) => setPrefs({ promptPopupOff: !on })} />
        <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('settings.promptPopupDefaultHelp')}</span>
      </Space>
    </Card>
  )
}

function QuickCommandsCard() {
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  const [prefs, setPrefs] = usePreferences()
  const [cmds, setCmds] = useState<string[]>(prefs.quickCommands || [])
  const [draft, setDraft] = useState('')
  useEffect(() => { setCmds(prefs.quickCommands || []) }, [prefs.quickCommands])
  const save = (next: string[]) => { setCmds(next); setPrefs({ quickCommands: next }); message.success(t('settings.saved')) }
  const add = () => { const v = draft.trim(); if (!v || cmds.includes(v)) return; save([...cmds, v]); setDraft('') }
  const remove = (i: number) => save(cmds.filter((_, j) => j !== i))
  return (
    <Card title={t('settings.quickCommands')}>
      <Space direction="vertical" size="small" style={{ width: '100%', maxWidth: 520 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {cmds.map((cmd, i) => (
            <Tag key={i} closable onClose={() => remove(i)} color="blue" style={{ margin: 0 }}>{cmd}</Tag>
          ))}
        </div>
        <Space.Compact style={{ width: '100%' }}>
          <Input value={draft} onChange={(e) => setDraft(e.target.value)}
            onPressEnter={add} placeholder={t('settings.quickCommandPlaceholder')} />
          <Button type="primary" onClick={add}>+</Button>
        </Space.Compact>
        <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('settings.quickCommandsHelp')}</span>
      </Space>
    </Card>
  )
}

// ── 偏好同步概览 ──
function PreferencesOverview() {
  const { t } = useI18n()
  const [prefs] = usePreferences()
  const items: { key: string; value: string }[] = [
    { key: 'theme', value: prefs.theme || 'dark' },
    { key: 'locale', value: prefs.locale || 'zh-CN' },
    { key: 'browserQuality', value: prefs.browserQuality || 'auto' },
    { key: 'browserDevice', value: prefs.browserDevice || t('common.empty') },
    { key: 'browserRotate', value: prefs.browserRotate || '0' },
    { key: 'claudeCommand', value: prefs.claudeCommand || 'claude' },
    { key: 'codexCommand', value: prefs.codexCommand || 'codex' },
    { key: 'quickCommands', value: (prefs.quickCommands || []).join(', ') || t('common.empty') },
    { key: 'showVoiceButton', value: String(prefs.showVoiceButton !== false) },
    { key: 'recentDirs', value: (prefs.recentDirs || []).join(', ') || t('common.empty') },
    { key: 'promptPopupOff', value: String(!!prefs.promptPopupOff) },
    { key: '_migrated', value: String(prefs._migrated ?? false) },
  ]
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('settings.prefsOverviewHelp')}</span>
      <Descriptions bordered size="small" column={1}>
        {items.map((it) => {
          const label = t(`prefs.${it.key}`)
          const translated = label !== `prefs.${it.key}`
          return (
          <Descriptions.Item key={it.key} label={<code>{translated ? `${label} (${it.key})` : it.key}</code>}>
            <code style={{ color: 'var(--text-dim)', wordBreak: 'break-all' }}>{it.value}</code>
          </Descriptions.Item>
          )
        })}
      </Descriptions>
    </Space>
  )
}

// ── 下载自签证书 + 安卓信任引导 ──
// 自签 HTTPS 下，安卓 Chrome 把站点判为不安全 → 不给「安装应用」、无法全屏 PWA。
// 把证书装为「受信任凭据」后即成安全上下文，便能装成全屏 PWA、用麦克风/剪贴板。
function CertDownloadButton() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const isHttps = typeof location !== 'undefined' && location.protocol === 'https:'
  const steps = [
    t('install.certStep1'),
    t('install.certStep2'),
    t('install.certStep3'),
    t('install.certStep4'),
  ]
  return (
    <>
      <Button onClick={() => setOpen(true)}>{t('install.downloadCert')}</Button>
      <Modal open={open} onCancel={() => setOpen(false)} title={t('install.certModalTitle')}
        footer={[
          <Button key="c" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>,
          <Button key="d" type="primary" href="/cert.crt" download="ttmux-ca.crt" onClick={() => { /* 浏览器直接下载 */ }}>{t('install.downloadCert')}</Button>,
        ]}>
        <div style={{ color: 'var(--text-dim)', fontSize: 13, lineHeight: 1.7 }}>
          <p style={{ marginTop: 0 }}>{t('install.certWhy')}</p>
          <ol style={{ paddingLeft: 20, margin: '8px 0' }}>
            {steps.map((s, i) => <li key={i} style={{ marginBottom: 4 }}>{s}</li>)}
          </ol>
          {!isHttps && <p style={{ color: '#d29922' }}>{t('install.certHttpNote')}</p>}
          <p style={{ marginBottom: 0, color: 'var(--text-dimmer)' }}>{t('install.certIosNote')}</p>
        </div>
      </Modal>
    </>
  )
}

// ── Env / Settings ──
// 手机/Android 后端配置：本地 redroid / 远程 redroid / 真机 三选一 + adb 地址。
type PhoneCfg = { active: '' | 'android' | 'ios'; android: { mode: string; address: string; resolution: string }; ios: { mode: string; address: string } }
const PHONE_DEFAULT: PhoneCfg = { active: 'android', android: { mode: 'local', address: 'localhost:5555', resolution: '' }, ios: { mode: 'simulator', address: '' } }

function PhoneSettingsCard() {
  // 两张卡片：Android / iOS，各自配置(互不覆盖)；active 决定哪个驱动镜像。
  const { t } = useI18n()
  const { message } = AntApp.useApp()
  const [cfg, setCfg] = useState<PhoneCfg>(PHONE_DEFAULT)
  const cfgRef = useRef(cfg)
  const [status, setStatus] = useState<any>({})
  const [devs, setDevs] = useState<{ android: any[]; ios: any[] }>({ android: [], ios: [] })
  const [plat, setPlat] = useState<{ android: { installed: boolean }; ios: { installed: boolean; supported: boolean } }>({ android: { installed: false }, ios: { installed: false, supported: false } })
  const [installing, setInstalling] = useState<'android' | 'ios' | null>(null)
  const [busy, setBusy] = useState('')
  const [log, setLog] = useState('')
  useEffect(() => { cfgRef.current = cfg }, [cfg])

  const loadStatus = () => api('GET', '/phone/status').then((r) => { if (r?.data) setStatus(r.data) }).catch(() => {})
  const loadDevices = (p: 'android' | 'ios') => api('GET', `/phone/devices?platform=${p}`).then((r) => { if (r?.data) setDevs((s) => ({ ...s, [p]: r.data })) }).catch(() => {})
  const loadPlatforms = () => api('GET', '/phone/platforms').then((r) => { if (r?.data) setPlat({ android: { installed: !!r.data.android?.installed }, ios: { installed: !!r.data.ios?.installed, supported: !!r.data.ios?.supported } }) }).catch(() => {})
  useEffect(() => {
    api('GET', '/phone/config').then((r) => { if (r?.data) setCfg({ ...PHONE_DEFAULT, ...r.data, android: { ...PHONE_DEFAULT.android, ...r.data.android }, ios: { ...PHONE_DEFAULT.ios, ...r.data.ios } }) }).catch(() => {})
    loadPlatforms(); loadStatus(); loadDevices('android'); loadDevices('ios')
    const iv = setInterval(loadStatus, 3000) // 状态灯后台自动刷新
    return () => clearInterval(iv)
  }, [])

  const persist = (next: PhoneCfg) => { setCfg(next); cfgRef.current = next; return api('PUT', '/phone/config', next).then(loadStatus).catch((e: any) => message.error(e.message)) }
  const patch = (p: 'android' | 'ios', d: any) => persist({ ...cfgRef.current, [p]: { ...cfgRef.current[p], ...d } })
  const editAddr = (p: 'android' | 'ios', a: string) => setCfg((c) => { const n = { ...c, [p]: { ...c[p], address: a } }; cfgRef.current = n; return n })
  const blurPersist = () => api('PUT', '/phone/config', cfgRef.current).then(loadStatus).catch(() => {})

  // 开关：开=激活(互斥+未装先装)；关=未启用。
  const toggle = async (p: 'android' | 'ios', on: boolean) => {
    if (busy || installing) return
    if (!on) { if (cfg.active === p) persist({ ...cfgRef.current, active: '' }); return }
    if (!plat[p].installed) {
      setInstalling(p); setLog('')
      try {
        const r = await api('POST', '/phone/install', { platform: p })
        setLog(r?.data?.log || r?.error || '')
        if (!r?.data?.installed) { message.error(t('phone.installFailed')); setInstalling(null); return }
        setPlat((s) => ({ ...s, [p]: { ...s[p], installed: true } }))
      } catch (e: any) { message.error(e.message); setInstalling(null); return }
      setInstalling(null)
    }
    persist({ ...cfgRef.current, active: p }); loadDevices(p)
  }
  const act = async (name: string, endpoint: string) => {
    setBusy(name); setLog('')
    try {
      const r = await api('POST', endpoint, {})
      if (r?.error) { message.error(r.error); setLog(r.error) }
      if (r?.data?.log) setLog(r.data.log)
      const h = r?.data?.health || r?.data
      if (h?.error) message.warning(h.error)
    } catch (e: any) { message.error(e.message) } finally { setBusy(''); loadStatus() }
  }
  const dim = { color: 'var(--text-dim)', fontSize: 12 }
  const st = status || {}

  const renderCard = (p: 'android' | 'ios') => {
    const c = cfg[p] as any
    const active = cfg.active === p
    const inst = plat[p].installed
    const sup = p === 'ios' ? plat.ios.supported : true
    const isA = p === 'android'
    const needAddr = isA ? c.mode !== 'local' : true
    const isNet = isA && (c.address || '').includes(':')
    const canSS = (isA && c.mode === 'local') || (!isA && c.mode === 'simulator')
    const sources = isA
      ? [{ label: t('phone.mode.local'), value: 'local' }, { label: t('phone.mode.remote'), value: 'remote' }, { label: t('phone.mode.device'), value: 'device' }]
      : [{ label: t('phone.ios.simulator'), value: 'simulator' }, { label: t('phone.ios.device'), value: 'device' }]
    const opts = (devs[p] || []).map((d: any) => ({ value: d.id, label: `${d.name} (${d.id})${d.kind && d.kind !== 'android' ? ' · ' + d.kind : ''}` }))
    const changeSrc = (m: string) => patch(p, isA && m === 'local' ? { mode: m, address: 'localhost:5555' } : { mode: m })
    return (
      <Card size="small" title={
        <Space align="center">
          <Switch checked={active} loading={installing === p} onChange={(on) => toggle(p, on)} />
          <b>{t('phone.platform.' + p)}</b>
          <Tag color={inst ? 'green' : 'default'}>{inst ? t('phone.installedTag') : t('phone.notInstalled')}</Tag>
          {p === 'ios' && !sup && <span style={dim}>{t('phone.iosMacOnly')}</span>}
        </Space>
      }>
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <span style={dim}>{t('phone.source')}</span>
            <Segmented value={c.mode} onChange={(v) => changeSrc(v as string)} options={sources} />
          </Space>
          {needAddr && (
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Space.Compact style={{ width: '100%', maxWidth: 380 }}>
                <AutoComplete value={c.address} onChange={(a) => editAddr(p, a)} onBlur={blurPersist} options={opts} style={{ width: '100%' }}
                  placeholder={isA ? t('phone.addrPlaceholder') : t('phone.addrPlaceholderIOS')}
                  filterOption={(i, o) => String(o?.value || '').toLowerCase().includes(i.toLowerCase())} />
                <Button onClick={() => loadDevices(p)}>{t('phone.refreshDevices')}</Button>
              </Space.Compact>
              <span style={dim}>{isA ? (c.mode === 'remote' ? t('phone.addrHelpRemote') : t('phone.addrHelpDevice')) : t('phone.addrHelpIOS')}</span>
            </Space>
          )}
          {isA && (
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <span style={dim}>{t('phone.resolution')}</span>
              <Segmented value={c.resolution || 'phone'} onChange={(v) => patch(p, { resolution: (v as string) === 'phone' ? '' : v })}
                options={[{ label: t('phone.res.phone'), value: 'phone' }, { label: t('phone.res.tablet'), value: 'tablet' },
                  { label: t('phone.res.tabletLand'), value: 'tablet-land' }, { label: t('phone.res.tabletLarge'), value: 'tablet-large' }]} />
            </Space>
          )}
          {/* 动作条 + 状态：仅激活卡片（动作作用于当前激活平台） */}
          {active ? (
            <>
              <Space wrap>
                <Button type="primary" loading={busy === 'auto'} onClick={() => act('auto', '/phone/auto')}>{t('phone.auto')}</Button>
                {canSS && <Button loading={busy === 'start'} disabled={st.running === true} onClick={() => act('start', '/phone/start')}>{t('phone.redroidStart')}</Button>}
                {canSS && <Button loading={busy === 'stop'} disabled={st.running === false} onClick={() => act('stop', '/phone/stop')}>{t('phone.redroidStop')}</Button>}
                {isNet && <Button loading={busy === 'connect'} onClick={() => act('connect', '/phone/connect')}>{t('phone.connect')}</Button>}
                {isNet && <Button loading={busy === 'disconnect'} onClick={() => act('disconnect', '/phone/disconnect')}>{t('phone.disconnect2')}</Button>}
                <Button loading={busy === 'test'} onClick={() => act('test', '/phone/test')}>{t('phone.test')}</Button>
              </Space>
              <Space wrap size={8}>
                <Tag color={st.connected ? 'green' : (st.error ? 'red' : 'default')}>
                  {st.connected ? '● ' + (st.device || t('phone.connected')) : (st.error || t('phone.disconnected'))}
                </Tag>
                {canSS && st.running != null && <Tag color={st.running ? 'blue' : 'default'}>{st.running ? t('phone.redroidRunning') : t('phone.redroidStopped')}</Tag>}
              </Space>
            </>
          ) : <span style={dim}>{t('phone.enableHint')}</span>}
        </Space>
      </Card>
    )
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {renderCard('android')}
      {renderCard('ios')}
      {log && <pre style={{ maxHeight: 160, overflow: 'auto', margin: 0, padding: 8, fontSize: 11, lineHeight: 1.5, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 6, whiteSpace: 'pre-wrap' }}>{log}</pre>}
    </Space>
  )
}

// 关于页：Logo / 版本号 / GitHub 仓库链接（版本取自 /api/info 的 ttmux CLI 版本）
function AboutPage() {
  const { t } = useI18n()
  const [version, setVersion] = useState('')
  useEffect(() => { api('GET', '/info').then((d: any) => setVersion(d?.version || '')).catch(() => {}) }, [])
  return (
    <Card style={{ maxWidth: 520, margin: '0 auto' }}>
      <Space direction="vertical" size={18} align="center" style={{ width: '100%', padding: '28px 0' }}>
        <img src="/logo-mark.svg" width={72} height={72} alt="Roam"
          style={{ borderRadius: 16, boxShadow: '0 2px 8px rgba(0,0,0,.5)' }} />
        <div style={{
          fontWeight: 800, fontSize: 28, letterSpacing: 0.5,
          background: 'var(--brand-grad)', WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent',
        }}>Roam</div>
        <p style={{ color: 'var(--text-dim)', fontSize: 13, lineHeight: 1.7, margin: 0, textAlign: 'left', maxWidth: 420 }}>
          {t('about.intro')}
        </p>
        {version && (
          <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>
            {t('settings.version')} <code>{version}</code>
          </div>
        )}
        <a href="https://github.com/ybz21/roam" target="_blank" rel="noreferrer"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--text-bright)', fontSize: 14 }}>
          {ICONS.github}<span>github.com/ybz21/roam</span>
        </a>
      </Space>
    </Card>
  )
}

function EnvPage() {
  const [list, setList] = useState<any[]>([])
  const { message, modal } = AntApp.useApp()
  const { mode, setMode } = useThemeMode()
  const { t, locale, setLocale } = useI18n()
  const { installed: pwaInstalled, install: doInstall, guide: installGuide } = usePwaInstall()
  const load = () => api('GET', '/env').then(setList).catch(() => {})
  useEffect(() => { load() }, [])
  const add = () => {
    let key = '', value = ''
    modal.confirm({
      title: t('env.addVariable'),
      content: (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input placeholder={t('env.keyPlaceholder')} onChange={(e) => (key = e.target.value)} />
          <Input placeholder={t('env.valuePlaceholder')} onChange={(e) => (value = e.target.value)} />
        </Space>
      ),
      okText: t('env.set'),
      onOk: async () => {
        if (!key.trim()) { message.error(t('env.keyRequired')); throw new Error('empty') }
        await api('PUT', '/env', { key: key.trim(), value }); message.success(t('env.setDone')); load()
      },
    })
  }
  return (
    <Tabs defaultActiveKey="general" style={{ width: '100%' }} items={[
      { key: 'general', label: t('settings.tabGeneral'), children: (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Card title={t('settings.appearance')}>
            <Space align="center" wrap>
              <Segmented
                value={mode}
                onChange={(v) => setMode(v as 'light' | 'dark')}
                options={[
                  { label: `☾ ${t('common.darkTheme')}`, value: 'dark' },
                  { label: `☀ ${t('common.lightTheme')}`, value: 'light' },
                ]}
              />
              <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('settings.themeHelp')}</span>
            </Space>
          </Card>
          <Card title={t('settings.language')}>
            <Space align="center" wrap>
              <Select
                value={locale}
                onChange={setLocale}
                options={[{ value: 'en-US', label: 'English' }, { value: 'zh-CN', label: '中文' }]}
                aria-label={t('settings.language')}
                style={{ width: 180 }}
              />
              <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('settings.languageHelp')}</span>
            </Space>
          </Card>
          <AgentCommandsCard />
          <QuickCommandsCard />
          <PromptPopupCard />
          <Card title={t('install.settingsTitle')}>
            <Space align="center" wrap>
              {pwaInstalled
                ? <span style={{ color: 'var(--text-bright)' }}>✓ {t('install.installed')}</span>
                : <Button type="primary" onClick={doInstall}>{t('install.button')}</Button>}
              <CertDownloadButton />
              <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('install.settingsHelp')}</span>
            </Space>
          </Card>
          {installGuide}
          <TwoFactorCard />
        </Space>
      )},
      { key: 'browser', label: t('settings.browser'), children: <BrowserCard /> },
      { key: 'phone', label: t('settings.phone'), children: <PhoneSettingsCard /> },
      { key: 'speech', label: t('settings.tabSpeech'), children: <SpeechCard /> },
      { key: 'preferences', label: t('settings.tabPreferences'), children: <PreferencesOverview /> },
      { key: 'env', label: t('settings.tabEnv'), children: (
        <Card title={t('env.globalVariables')} extra={<Space>
          <Button onClick={add}>+ {t('env.add')}</Button>
          <Button onClick={async () => { try { await api('POST', '/env/push'); message.success(t('env.pushed')) } catch (e: any) { message.error(e.message) } }}>{t('env.pushToSessions')}</Button>
        </Space>}>
          {list.length === 0 ? <Empty description={t('env.empty')} /> : (
            <List dataSource={list} renderItem={(kv: any) => (
              <List.Item actions={[<Popconfirm key="d" title={t('env.deleteConfirm')} onConfirm={async () => { try { await api('DELETE', '/env/' + encodeURIComponent(kv.key)); message.success(t('file.deleted')); load() } catch (e: any) { message.error(e.message) } }}><a style={{ color: '#f85149' }}>{t('file.delete')}</a></Popconfirm>]}>
                <List.Item.Meta title={<code>{kv.key}</code>} description={<code style={{ color: 'var(--text-dim)' }}>{kv.value}</code>} />
              </List.Item>
            )} />
          )}
        </Card>
      )},
    ]} />
  )
}

// ── 语音输入(ASR)配置：选服务商并填密钥，持久化到后端 speech-config.json ──
const SPEECH_DEFAULTS = {
  openai: { baseURL: 'https://api.openai.com/v1', model: 'whisper-1' },
  volcano: { resourceId: 'volc.bigasr.auc', endpoint: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit' },
}
function normalizeSpeech(d: any) {
  const c = d || {}
  return {
    provider: c.provider || '',
    openai: {
      baseURL: c.openai?.baseURL || SPEECH_DEFAULTS.openai.baseURL,
      apiKey: c.openai?.apiKey || '',
      model: c.openai?.model || SPEECH_DEFAULTS.openai.model,
      language: c.openai?.language || '',
    },
    volcano: {
      appId: c.volcano?.appId || '',
      accessToken: c.volcano?.accessToken || '',
      resourceId: c.volcano?.resourceId || SPEECH_DEFAULTS.volcano.resourceId,
      endpoint: c.volcano?.endpoint || SPEECH_DEFAULTS.volcano.endpoint,
    },
  }
}
function SpeechCard() {
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  const [cfg, setCfg] = useState<any>(() => normalizeSpeech(null))
  const [saving, setSaving] = useState(false)
  useEffect(() => { api('GET', '/speech/config').then((r) => setCfg(normalizeSpeech(r?.data))).catch(() => {}) }, [])
  const setOpenAI = (k: string, v: string) => setCfg((c: any) => ({ ...c, openai: { ...c.openai, [k]: v } }))
  const setVolc = (k: string, v: string) => setCfg((c: any) => ({ ...c, volcano: { ...c.volcano, [k]: v } }))
  const save = async () => {
    setSaving(true)
    try { await api('PUT', '/speech/config', cfg); message.success(t('settings.speechSaved')) }
    catch (e: any) { message.error(e.message) }
    finally { setSaving(false) }
  }
  return (
    <Card title={t('settings.speech')}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space align="center" wrap>
          <Select
            value={cfg.provider || ''}
            style={{ width: 220 }}
            onChange={(v) => setCfg((c: any) => ({ ...c, provider: v }))}
            options={[
              { value: '', label: t('settings.speechProviderNone') },
              { value: 'openai', label: 'OpenAI' },
              { value: 'volcano', label: 'Volcano Engine' },
            ]}
          />
          <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('settings.speechHelp')}</span>
        </Space>
        {cfg.provider === 'openai' && (
          <Space direction="vertical" size="small" style={{ width: '100%', maxWidth: 520 }}>
            <Input addonBefore={t('settings.speechBaseUrl')} value={cfg.openai.baseURL} onChange={(e) => setOpenAI('baseURL', e.target.value)} />
            <Input.Password addonBefore={t('settings.speechApiKey')} value={cfg.openai.apiKey} onChange={(e) => setOpenAI('apiKey', e.target.value)} />
            <Input addonBefore={t('settings.speechModel')} value={cfg.openai.model} onChange={(e) => setOpenAI('model', e.target.value)} />
            <Input addonBefore={t('settings.speechLanguage')} placeholder={t('common.optional')} value={cfg.openai.language} onChange={(e) => setOpenAI('language', e.target.value)} />
          </Space>
        )}
        {cfg.provider === 'volcano' && (
          <Space direction="vertical" size="small" style={{ width: '100%', maxWidth: 520 }}>
            <Input addonBefore={t('settings.volcanoAppId')} value={cfg.volcano.appId} onChange={(e) => setVolc('appId', e.target.value)} />
            <Input.Password addonBefore={t('settings.volcanoAccessToken')} value={cfg.volcano.accessToken} onChange={(e) => setVolc('accessToken', e.target.value)} />
            <Input addonBefore={t('settings.volcanoResourceId')} value={cfg.volcano.resourceId} onChange={(e) => setVolc('resourceId', e.target.value)} />
            <Input addonBefore={t('settings.volcanoEndpoint')} value={cfg.volcano.endpoint} onChange={(e) => setVolc('endpoint', e.target.value)} />
          </Space>
        )}
        <Button type="primary" loading={saving} onClick={save}>{t('settings.save')}</Button>
      </Space>
    </Card>
  )
}

// ── Chrome(浏览器镜像)启动配置：屏幕尺寸/全屏/缩放/profile(data-dir)/可执行路径，
//    持久化到后端 browser-config.json；保存后点「重启 Chrome」按新参数重新拉起 ──
function BrowserCard() {
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  const [cfg, setCfg] = useState<any>({ headless: 'auto', windowSize: '1920,1080', fullscreen: true, scale: '2', profile: '/tmp/ttmux-chrome', bin: '' })
  const [saving, setSaving] = useState(false)
  const [relaunching, setRelaunching] = useState(false)
  useEffect(() => { api('GET', '/browser/config').then((r) => { if (r?.data) setCfg(r.data) }).catch(() => {}) }, [])
  const set = (k: string, v: any) => setCfg((c: any) => ({ ...c, [k]: v }))
  const save = async () => {
    setSaving(true)
    try { await api('PUT', '/browser/config', cfg); message.success(t('settings.browserSaved')) }
    catch (e: any) { message.error(e.message) }
    finally { setSaving(false) }
  }
  const relaunch = async () => {
    setRelaunching(true)
    try {
      await api('PUT', '/browser/config', cfg) // 先存再重启，省一步
      const r = await api('POST', '/browser/relaunch')
      if (r?.data?.attached) message.warning(t('settings.browserAttached'))
      else message.success(t('settings.browserRelaunched'))
    } catch (e: any) { message.error(e.message) }
    finally { setRelaunching(false) }
  }
  return (
    <Card title={t('settings.browser')}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('settings.browserHelp')}</span>
        <Space align="center" wrap>
          <span>{t('settings.browserMode')}</span>
          <Segmented
            value={cfg.headless || 'auto'}
            onChange={(v) => set('headless', v)}
            options={[
              { value: 'auto', label: t('settings.browserModeAuto') },
              { value: 'on', label: t('settings.browserModeHeadless') },
              { value: 'off', label: t('settings.browserModeHeadful') },
            ]}
          />
          <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('settings.browserModeHelp')}</span>
        </Space>
        <Space direction="vertical" size="small" style={{ width: '100%', maxWidth: 560 }}>
          <Input addonBefore={t('settings.browserWindow')} value={cfg.windowSize} placeholder={t('settings.browserWindowPlaceholder')} onChange={(e) => set('windowSize', e.target.value)} />
          <Space align="center">
            <Switch checked={!!cfg.fullscreen} onChange={(v) => set('fullscreen', v)} />
            <span>{t('settings.browserFullscreen')}</span>
            <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('settings.browserFullscreenHelp')}</span>
          </Space>
          <Input addonBefore={t('settings.browserScale')} value={cfg.scale} placeholder={t('settings.browserScalePlaceholder')} onChange={(e) => set('scale', e.target.value)} />
          <Input addonBefore={t('settings.browserProfile')} value={cfg.profile} placeholder={t('settings.browserProfilePlaceholder')} onChange={(e) => set('profile', e.target.value)} />
          <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('settings.browserProfileHelp')}</span>
          <Input addonBefore={t('settings.browserBin')} value={cfg.bin} placeholder={t('common.optional')} onChange={(e) => set('bin', e.target.value)} />
        </Space>
        <Space>
          <Button type="primary" loading={saving} onClick={save}>{t('settings.save')}</Button>
          <Button loading={relaunching} onClick={relaunch}>{t('settings.browserRelaunch')}</Button>
        </Space>
      </Space>
    </Card>
  )
}

// ── 两步验证 (TOTP / Authenticator)：可在 UI 里开启/关闭，即时生效并持久化 ──
function TwoFactorCard() {
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [setup, setSetup] = useState<{ uri: string; secret: string } | null>(null) // 开启流程中的待确认密钥
  const [code, setCode] = useState('')
  const [qr, setQr] = useState<{ uri: string; secret: string } | null>(null) // 查看当前二维码
  const [busy, setBusy] = useState(false)

  const refresh = () => api('GET', '/pubconfig').then((r) => setEnabled(!!r?.data?.totp)).catch(() => setEnabled(false))
  useEffect(() => { refresh() }, [])

  const startSetup = async () => {
    try { const r = await api('GET', '/2fa/gen'); setSetup({ uri: r.data.uri, secret: r.data.secret }); setCode(''); setQr(null) }
    catch (e: any) { message.error(e.message) }
  }
  const confirmEnable = async () => {
    if (!setup) return
    setBusy(true)
    try { await api('POST', '/2fa/enable', { secret: setup.secret, code: code.trim() }); message.success(t('twoFactor.enabled')); setSetup(null); refresh() }
    catch (e: any) { message.error(/BAD_CODE/.test(e.message) ? t('twoFactor.badCode') : e.message) }
    finally { setBusy(false) }
  }
  const disable = async () => {
    try { await api('POST', '/2fa/disable'); message.success(t('twoFactor.disabled')); setQr(null); refresh() }
    catch (e: any) { message.error(e.message) }
  }
  const showCurrent = async () => {
    try { const r = await api('GET', '/2fa/qr'); if (r.data?.enabled) setQr({ uri: r.data.uri, secret: r.data.secret }) }
    catch (e: any) { message.error(e.message) }
  }
  const copy = (s: string) => { try { navigator.clipboard?.writeText(s) } catch {}; message.success(t('common.copied')) }

  return (
    <Card title={t('twoFactor.title')} extra={
      <Tag color={enabled ? 'green' : 'default'}>{enabled === null ? '…' : enabled ? t('twoFactor.on') : t('twoFactor.off')}</Tag>
    }>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Text type="secondary" style={{ fontSize: 13 }}>
          {t('twoFactor.helpPrefix')}<code>TTMUX_WEB_TOTP_SECRET</code>{t('twoFactor.helpSuffix')}
        </Text>

        {!setup && (
          <Space>
            {enabled
              ? <>
                  <Button onClick={showCurrent}>{t('twoFactor.showQr')}</Button>
                  <Popconfirm title={t('twoFactor.disableConfirm')} onConfirm={disable}><Button danger>{t('twoFactor.disable')}</Button></Popconfirm>
                </>
              : <Button type="primary" onClick={startSetup}>{t('twoFactor.enable')}</Button>}
          </Space>
        )}

        {/* 开启流程：扫码 → 输码确认 */}
        {setup && (
          <div style={{ padding: 16, background: 'var(--bg-base)', borderRadius: 8 }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ background: '#fff', padding: 10, borderRadius: 8 }}><QRCodeSVG value={setup.uri} size={168} /></div>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 4 }}>{t('twoFactor.scanStep')}</div>
                <Space.Compact style={{ width: '100%', marginBottom: 10 }}>
                  <Input readOnly value={setup.secret} />
                  <Button onClick={() => copy(setup.secret)}>{t('common.copy')}</Button>
                </Space.Compact>
                <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 4 }}>{t('twoFactor.codeStep')}</div>
                <Space.Compact style={{ width: '100%' }}>
                  <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t('twoFactor.codePlaceholder')} inputMode="numeric" maxLength={6} onPressEnter={confirmEnable} />
                  <Button type="primary" loading={busy} onClick={confirmEnable}>{t('twoFactor.confirmEnable')}</Button>
                </Space.Compact>
              </div>
            </div>
            <div style={{ marginTop: 10 }}><Button size="small" onClick={() => setSetup(null)}>{t('common.cancel')}</Button></div>
          </div>
        )}

        {/* 查看当前二维码（已开启时给新设备加） */}
        {qr && (
          <div style={{ padding: 16, background: 'var(--bg-base)', borderRadius: 8, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ background: '#fff', padding: 10, borderRadius: 8 }}><QRCodeSVG value={qr.uri} size={168} /></div>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 4 }}>{t('twoFactor.addDevice')}</div>
              <Space.Compact style={{ width: '100%' }}><Input readOnly value={qr.secret} /><Button onClick={() => copy(qr.secret)}>{t('common.copy')}</Button></Space.Compact>
            </div>
          </div>
        )}
      </Space>
    </Card>
  )
}

// ── 创建任务（命令 / Agent） ──
function SpawnModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm()
  const [type, setType] = useState('cmd')
  const [pickDir, setPickDir] = useState(false)
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  const submit = async () => {
    const v = await form.validateFields()
    const tasks = (v.tasks || []).filter((t: any) => t?.name && t?.payload)
      .map((t: any) => (type === 'agent' ? { name: t.name, task: t.payload } : { name: t.name, cmd: t.payload }))
    if (!tasks.length) return message.error(t('task.needOne'))
    const body: any = { group: v.group, type, tasks }
    if (type === 'agent') { body.dir = v.dir; body.perm = v.perm; body.model = v.model }
    try { await api('POST', '/tasks', body); message.success(t('session.created')); onClose(); onDone() }
    catch (e: any) { message.error(e.message) }
  }
  return (
    <>
      <Modal open={open} onCancel={onClose} onOk={submit} okText={t('file.create')} title={t('task.create')} destroyOnClose>
        <Segmented block value={type} onChange={(v) => setType(v as string)}
          options={[{ label: t('common.command'), value: 'cmd' }, { label: 'Agent', value: 'agent' }]} style={{ marginBottom: 12 }} />
        <Form form={form} layout="vertical" preserve={false} initialValues={{ tasks: [{}, {}], perm: 'auto' }}>
          <Form.Item name="group" label={t('task.groupName')} rules={[{ required: true }]}><Input placeholder={t('task.groupPlaceholder')} /></Form.Item>
          <Form.List name="tasks">
            {(fields, { add, remove }) => (
              <>
                {fields.map((f) => (
                  <Space key={f.key} align="baseline" style={{ display: 'flex', marginBottom: 8 }}>
                    <Form.Item {...f} name={[f.name, 'name']} noStyle><Input placeholder={t('common.name')} style={{ width: 110 }} /></Form.Item>
                    <Form.Item {...f} name={[f.name, 'payload']} noStyle><Input placeholder={type === 'agent' ? t('task.description') : t('common.command')} style={{ width: 240 }} /></Form.Item>
                    <a onClick={() => remove(f.name)} style={{ color: '#f85149' }}>×</a>
                  </Space>
                ))}
                <Button type="dashed" onClick={() => add()} block>+ {t('task.addRow')}</Button>
              </>
            )}
          </Form.List>
          {type === 'agent' && (
            <div style={{ marginTop: 12 }}>
              <Form.Item label={t('task.workdirLabel')}>
                <Space.Compact style={{ width: '100%' }}>
                  <Form.Item name="dir" noStyle><Input placeholder={t('task.dirExample')} /></Form.Item>
                  <Button onClick={() => setPickDir(true)}>{t('common.browse')}</Button>
                </Space.Compact>
              </Form.Item>
              <Space>
                <Form.Item name="perm" label={t('task.permission')}><Input placeholder={t('task.permissionPlaceholder')} /></Form.Item>
                <Form.Item name="model" label={t('task.model')}><Input placeholder={t('common.optional')} /></Form.Item>
              </Space>
            </div>
          )}
        </Form>
      </Modal>
      <DirPicker open={pickDir} start={form.getFieldValue('dir') || undefined}
        onPick={(p) => { form.setFieldValue('dir', p); setPickDir(false) }} onClose={() => setPickDir(false)} />
    </>
  )
}

function SendModal({ tasks, onClose }: { tasks: any[] | null; onClose: () => void }) {
  const [sess, setSess] = useState<string>()
  const [msg, setMsg] = useState('')
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  useEffect(() => { if (tasks?.length) setSess(tasks[0].name) }, [tasks])
  const go = async () => {
    if (!sess || !msg) return
    try { await api('POST', '/tasks/_/send', { sess, msg }); message.success(t('task.sent')); onClose() } catch (e: any) { message.error(e.message) }
  }
  return (
    <Modal open={!!tasks} onCancel={onClose} onOk={go} okText={t('common.send')} title={t('task.appendInstruction')} destroyOnClose>
      <Select style={{ width: '100%', marginBottom: 10 }} value={sess} onChange={setSess}
        options={(tasks || []).map((t: any) => ({ value: t.name, label: `${t.name} [${t.type}]` }))} />
      <Input.TextArea rows={3} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={t('task.instructionPlaceholder')} />
    </Modal>
  )
}

function CollectModal({ group, onClose }: { group: string | null; onClose: () => void }) {
  const { t } = useI18n()
  const [text, setText] = useState(t('common.loading'))
  useEffect(() => {
    if (!group) return
    setText(t('common.loading'))
    api('GET', '/tasks/' + encodeURIComponent(group) + '/collect')
      .then((r) => setText((r.results || []).map((x: any) => `━━━ ${x.task} [${x.type}] ━━━\n${x.prompt ? t('task.promptPrefix') + x.prompt + '\n' : ''}${x.output}`).join('\n\n') || t('task.noOutput')))
      .catch((e) => setText(e.message))
  }, [group, t])
  return (
    <Modal open={!!group} onCancel={onClose} footer={null} title={t('task.collectTitle', { group: group || '' })} width="min(720px,94vw)">
      <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '60vh', overflow: 'auto', background: 'var(--bg-term)', padding: 12, borderRadius: 8, fontSize: 12.5 }}>{text}</pre>
    </Modal>
  )
}
