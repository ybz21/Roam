// ttmux Web 控制台 — React + Vite + Antd（统一深色主题）
// 布局（见 docs/design/web/01-overview.md）：
//   电脑 ≥1200 → 三栏：导航 Sider | 列表(页面) | 终端面板(常驻, 多标签)
//   平板/手机   → 终端为全屏覆盖层；手机底部 Tab 导航
// 终端：多标签 / 字号调节 / 复制 / 更多快捷键 / 断线自动重连。
import { useEffect, useRef, useState } from 'react'
import {
  Layout, Menu, Button, Card, List, Tag, Form, Input, Select, Segmented,
  Statistic, Row, Col, Space, Popconfirm, Empty, Modal, Grid, App as AntApp, Typography, Spin, Tooltip, Dropdown, Checkbox, Progress, AutoComplete,
} from 'antd'
import { QRCodeSVG } from 'qrcode.react'
import { api, setUnauthorizedHandler } from './api'
import Term, { TermHandle, TermStatus } from './Terminal'
import ClaudeChat from './ClaudeChat'
import CodexChat from './CodexChat'
import FileBrowser from './FileBrowser'
import BrowserView from './BrowserView'
import Swarm from './Swarm'
import UpdateBanner from './UpdateBanner'
import { useThemeMode } from './theme'

interface ClaudeInfo { running: boolean; file?: string; dir?: string }

const { Sider, Content } = Layout
const { useBreakpoint } = Grid
const { Text } = Typography

const NAV = [
  { key: 'overview', label: '概览' },
  { key: 'sessions', label: '会话' },
  { key: 'swarm', label: '蜂群' },
  { key: 'browser', label: '浏览器' },
  { key: 'env', label: '系统配置' },
]

// 线性图标（无 emoji，currentColor 描边）
const svg = (paths: any) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths}</svg>
)
const ICONS: Record<string, any> = {
  overview: svg(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>),
  sessions: svg(<><polyline points="5 8 9 12 5 16" /><line x1="12" y1="16" x2="18" y2="16" /></>),
  swarm: svg(<><circle cx="12" cy="5" r="2.4" /><circle cx="5" cy="17" r="2.4" /><circle cx="19" cy="17" r="2.4" /><line x1="12" y1="7.4" x2="6.5" y2="14.8" /><line x1="12" y1="7.4" x2="17.5" y2="14.8" /></>),
  env: svg(<><line x1="4" y1="7" x2="20" y2="7" /><circle cx="9" cy="7" r="2.3" /><line x1="4" y1="17" x2="20" y2="17" /><circle cx="15" cy="17" r="2.3" /></>),
  browser: svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><circle cx="6" cy="6.5" r="0.6" /><circle cx="8.4" cy="6.5" r="0.6" /></>),
}


const KEYS: [string, string][] = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'],
  ['^C', '\x03'], ['^D', '\x04'], ['Space', ' '], ['y', 'y'], ['n', 'n'], ['/', '/'], ['q', 'q'],
]

// tmux 基操菜单：前缀键 C-b(\x02) + 命令键，直接发给 tmux attach
// （key 即要发送的字节序列，onClick 时原样发出）
const PFX = '\x02'
const TMUX_MENU = [
  { type: 'group', label: '分屏', children: [
    { key: PFX + '%', label: '竖分屏 — 左右 ▏▏' },
    { key: PFX + '"', label: '横分屏 — 上下 ▔▁' },
  ]},
  { type: 'group', label: '窗格 (Pane)', children: [
    { key: PFX + 'o', label: '切到下一个窗格' },
    { key: PFX + '\x1b[A', label: '选上方窗格 ↑' },
    { key: PFX + '\x1b[B', label: '选下方窗格 ↓' },
    { key: PFX + '\x1b[D', label: '选左侧窗格 ←' },
    { key: PFX + '\x1b[C', label: '选右侧窗格 →' },
    { key: PFX + 'z', label: '最大化 / 还原窗格' },
    { key: PFX + ' ', label: '切换布局' },
    { key: PFX + 'x', label: '关闭当前窗格', danger: true },
  ]},
  { type: 'group', label: '窗口 (Window)', children: [
    { key: PFX + 'c', label: '新建窗口' },
    { key: PFX + 'n', label: '下一个窗口' },
    { key: PFX + 'p', label: '上一个窗口' },
    { key: PFX + 'w', label: '窗口列表' },
    { key: PFX + ',', label: '重命名窗口' },
  ]},
  { type: 'group', label: '其他', children: [
    { key: PFX + '[', label: '复制模式（翻历史）' },
    { key: PFX + 'd', label: '断开会话 (detach)' },
    { key: PFX + 't', label: '显示时钟' },
  ]},
] as const

function StatusTag({ status, code }: { status?: string; code?: string }) {
  if (status === 'running') return <Tag color="processing">运行中</Tag>
  if (status === 'done') return code && code !== '0' ? <Tag color="error">失败 {code}</Tag> : <Tag color="success">完成</Tag>
  return <Tag>已结束</Tag>
}
function TypeTag({ type }: { type?: string }) {
  return type === 'agent' ? <Tag color="blue">🤖 Agent</Tag> : <Tag>⌨️ 命令</Tag>
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [kanna, setKanna] = useState('')
  const [route, setRoute] = useState(() => location.hash.replace(/^#\/?/, '') || 'sessions')
  const tab = route.split('/')[0]                                  // 基础页（swarm/leave → swarm）
  const swarmSub = tab === 'swarm' && route.includes('/') ? decodeURIComponent(route.slice(route.indexOf('/') + 1)) : '' // 深链选中的蜂群
  const go = (k: string) => { location.hash = '#/' + k } // hash 路由：/#/xxx
  const { mode, toggle: toggleTheme } = useThemeMode()
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

  // 多终端状态
  const [terms, setTerms] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [overlay, setOverlay] = useState(false) // 手机/平板全屏终端
  const [dockOpen, setDockOpen] = useState(true) // 桌面：右侧终端停靠栏是否展开
  const [dockMax, setDockMax] = useState(false)  // 桌面：终端栏向左扩展（遮住会话列表）
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
    api('GET', '/me').then((r) => { setAuthed(true); setKanna(r?.data?.kanna || '') }).catch(() => setAuthed(false))
  }, [])

  // hash 路由：URL #/xxx 与当前页同步（支持前进/后退、刷新保持、收藏分享）
  useEffect(() => {
    const apply = () => setRoute(location.hash.replace(/^#\/?/, '') || 'sessions')
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
  if (!authed) return <Login onOk={() => { setAuthed(true); go('overview') }} />

  // 独立单终端页（新标签全屏打开）：URL 带 ?term=<会话名>
  const soloName = new URLSearchParams(location.search).get('term')
  if (soloName) return <SoloTerminal name={soloName} />

  const openTerm = (name: string) => {
    setTerms((ts) => (ts.includes(name) ? ts : [...ts, name]))
    setActive(name)
    if (hasSider) { setDockOpen(true); setDockMax(false) } // 桌面：拉出右侧停靠栏（压缩页面到左）
    else setOverlay(true)           // 手机/平板：全屏
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
      onCollapse={() => { setOverlay(false); setDockOpen(false) }}
    />
  )

  const pages: any = {
    overview: <Overview go={go} openTerm={openTerm} kanna={kanna} />,
    swarm: <Swarm openTerm={openTerm} initialSwarm={swarmSub || undefined} onNav={(n) => { location.hash = n ? '#/swarm/' + encodeURIComponent(n) : '#/swarm' }} />,
    sessions: <Sessions openTerm={openTerm} />,
    env: <EnvPage />,
    browser: <BrowserView />,
  }

  const menu = (
    <Menu
      theme={mode} mode="inline" selectedKeys={[tab]} onClick={(e) => go(e.key)}
      items={NAV.map((n) => ({ key: n.key, icon: ICONS[n.key], label: n.label }))}
      style={{ borderInlineEnd: 0, background: 'transparent' }}
    />
  )

  return (
    <Layout style={{ minHeight: '100dvh', background: 'var(--bg-base)' }}>
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
                  <div style={{ color: 'var(--text-dimmer)', fontSize: 10, letterSpacing: 1.5 }}>ANYWHERE · ANYTIME</div>
                </div>
              )}
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>{menu}</div>
            {/* 底部：全屏（上）+ 折叠 + 退出（下），始终竖向堆叠 */}
            <div style={{ borderTop: '1px solid var(--border-subtle)', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Button type="text" block onClick={toggleTheme} style={{ color: 'var(--text-dim)', textAlign: collapsed ? 'center' : 'left' }}
                title={mode === 'dark' ? '切换浅色' : '切换深色'}>
                {collapsed ? themeIcon : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{themeIcon}{mode === 'dark' ? '浅色主题' : '深色主题'}</span>}
              </Button>
              {fsSupported && (
                <Button type="text" block onClick={toggleFs} style={{ color: 'var(--text-dim)', textAlign: collapsed ? 'center' : 'left' }}
                  title={isFs ? '退出全屏' : '全屏'}>
                  {collapsed ? fsIcon : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{fsIcon}{isFs ? '退出全屏' : '全屏'}</span>}
                </Button>
              )}
              <Button type="text" block onClick={() => setCollapsed((c) => !c)} style={{ color: 'var(--text-dim)' }}
                title={collapsed ? '展开导航' : '折叠导航'}>
                {svg(collapsed
                  ? <><polyline points="9 6 15 12 9 18" /></>
                  : <><polyline points="15 6 9 12 15 18" /></>)}
              </Button>
              <Popconfirm title="确定退出登录？" okText="退出" cancelText="取消" onConfirm={logout} placement="topRight">
                <Button type="text" block style={{ color: 'var(--text-dim)', textAlign: collapsed ? 'center' : 'left' }} title="退出登录">
                  {collapsed ? svg(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>) : '退出登录'}
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
            // 终端弹出时左侧页面压窄到 300；继续向左扩展(dockMax)则收到 0、被终端遮住
            flex: docked && tab !== 'browser' ? (dockMax ? '0 0 0px' : '0 0 300px') : 1,
            width: docked && tab !== 'browser' ? (dockMax ? 0 : 300) : 'auto', minWidth: 0,
            height: '100dvh', overflow: tab === 'browser' ? 'hidden' : 'auto',
            padding: tab === 'browser' ? 0 : 14,
            paddingBottom: isMobile ? 76 : (tab === 'browser' ? 0 : 14),
            transition: 'flex-basis .2s, width .2s',
          }}>
            {pages[tab] || pages.sessions}
          </Content>

          {/* 角标把手：上半=向左扩展（关→开→遮住会话列表），下半=向右收起；都带图标+文字 */}
          {hasSider && terms.length > 0 && (
            <div style={{
              flex: '0 0 32px', background: 'var(--bg-container)', borderLeft: '1px solid var(--border)',
              display: 'flex', flexDirection: 'column', color: anyClaude ? '#58a6ff' : 'var(--text-dim)', userSelect: 'none',
            }}>
              {/* 上半：向左扩展 */}
              <div onClick={() => (dockOpen ? setDockMax(true) : setDockOpen(true))}
                title={!dockOpen ? '展开终端' : '向左扩展（遮住会话列表）'}
                style={{
                  flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 7,
                  borderBottom: '1px solid var(--border)', cursor: dockMax ? 'default' : 'pointer', opacity: dockMax ? 0.3 : 1,
                }}>
                {/* 双箭头向左 = 扩展/展开面板 */}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 6 L7 12 L13 18" /><path d="M18 6 L12 12 L18 18" />
                </svg>
                <span style={{ writingMode: 'vertical-rl', letterSpacing: 3, fontSize: 12, fontWeight: 600 }}>{dockOpen ? '扩展' : '展开'}</span>
                <span style={{ fontSize: 11, background: '#1f6feb', color: '#fff', borderRadius: 9, padding: '0 6px' }}>{terms.length}</span>
              </div>
              {/* 下半：向右收起 */}
              <div onClick={() => (dockMax ? setDockMax(false) : setDockOpen(false))}
                title={dockMax ? '还原' : '向右收起'}
                style={{
                  flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 7,
                  cursor: dockOpen ? 'pointer' : 'default', opacity: dockOpen ? 1 : 0.3,
                }}>
                {/* 双箭头向右 = 收起/还原面板 */}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 6 L17 12 L11 18" /><path d="M6 6 L12 12 L6 18" />
                </svg>
                <span style={{ writingMode: 'vertical-rl', letterSpacing: 3, fontSize: 12, fontWeight: 600 }}>{dockMax ? '还原' : '收起'}</span>
              </div>
            </div>
          )}

          {/* 右侧终端停靠栏（桌面）：常驻挂载以保留连接，收起时宽度归零 */}
          {hasSider && terms.length > 0 && (
            <div style={{
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
              {ICONS[n.key]}{n.label}
            </button>
          ))}
          {/* 主题/全屏/退出折叠进「更多」，省出底栏空间 */}
          <Dropdown placement="top" trigger={['click']} menu={{ items: [
            { key: 'theme', icon: themeIcon, label: mode === 'dark' ? '浅色主题' : '深色主题', onClick: toggleTheme },
            ...(fsSupported ? [{ key: 'fs', icon: fsIcon, label: isFs ? '退出全屏' : '全屏', onClick: toggleFs }] : []),
            { type: 'divider' as const },
            { key: 'logout', danger: true, label: '退出登录', onClick: () => Modal.confirm({ title: '确定退出登录？', okText: '退出', cancelText: '取消', okButtonProps: { danger: true }, onOk: logout }) },
          ] }}>
            <button
              style={{ flex: 1, border: 0, background: 'none', color: 'var(--text-dim)', padding: '8px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, fontSize: 11 }}>
              {svg(<><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>)}更多
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

// ── 独立单终端页：新浏览器标签全屏打开单个会话（URL ?term=name）──
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
}) {
  const { terms, active, setActive, closeTerm, fontSize, setFontSize, statusMap, setStatus, termRefs, sendKey, onCollapse, claudeMap, claudeView, setClaudeView, codexMap, codexView, setCodexView } = props
  const { message } = AntApp.useApp()
  const st = active ? statusMap[active] : undefined
  const dot = st === 'connected' ? '#3fb950' : st === 'connecting' ? '#d29922' : '#f85149'
  // 当前标签是否在 Claude/Codex 对话视图：此时聊天 UI 自带输入框，
  // 终端那条移动输入条 + 快捷键栏要隐藏，否则手机上会出现两个输入框。
  const inChat = !!active && ((claudeView[active] && claudeMap[active]?.running) || (codexView[active] && codexMap[active]?.running))

  // 移动端可靠输入：xterm 隐藏 textarea 在软键盘/输入法「合成/预测词」下会把字留在
  // 合成缓冲里不提交，onData 不触发 → 打完字发不出去。触摸设备改用独立输入框：整行送 PTY。
  const isTouch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
  const [line, setLine] = useState('')
  const sendRaw = (s: string) => { if (active) termRefs.current[active]?.send(s, true) } // keepFocus：不抢 xterm 焦点 → 软键盘不收起
  const flushLine = () => { if (line) { sendRaw(line); setLine('') } }                  // 把输入框待发文本先送出（不带回车）
  const submitLine = () => { sendRaw(line + '\r'); setLine('') }                         // 整行 + 回车
  const tapKey = (seq: string) => { flushLine(); if (isTouch) sendRaw(seq); else sendKey(seq) } // 控制键：先 flush 待发文本
  const noBlur = isTouch ? (e: React.MouseEvent) => e.preventDefault() : undefined        // 点按钮不夺走输入框焦点（软键盘保持）

  // 文件侧栏（终端视图下也可用）：定位到当前会话的工作目录
  const [showFiles, setShowFiles] = useState(false)
  const [cwd, setCwd] = useState('')
  useEffect(() => {
    if (!active) { setCwd(''); return }
    // 优先用 claude/codex 已知工作目录，否则查会话 pane 当前路径
    const known = claudeMap[active]?.dir || codexMap[active]?.dir
    if (known) { setCwd(known); return }
    let stop = false
    api('GET', `/sessions/${encodeURIComponent(active)}/cwd`).then((r) => { if (!stop) setCwd(r.data?.dir || '') }).catch(() => {})
    return () => { stop = true }
  }, [active, claudeMap, codexMap])

  if (terms.length === 0) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-dim)' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 40 }}>▸</div>
          <div>点击「会话」或「任务」里的 <b style={{ color: 'var(--text-bright)' }}>终端</b> 进入命令行</div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* 标签栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', borderBottom: '1px solid var(--border)', overflowX: 'auto' }}>
        {onCollapse && <Button size="small" type="text" style={{ color: 'var(--text-dim)' }} onClick={onCollapse}>✕ 收起</Button>}
        {terms.map((t) => (
          <span key={t} onClick={() => setActive(t)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap',
              background: t === active ? '#1f6feb33' : 'transparent', border: t === active ? '1px solid #1f6feb' : '1px solid var(--border)', color: 'var(--text-bright)',
            }}>
            <i style={{ width: 7, height: 7, borderRadius: '50%', background: (statusMap[t] === 'connected' ? '#3fb950' : statusMap[t] === 'connecting' ? '#d29922' : '#f85149') }} />
            {claudeMap[t]?.running && <span title="正在运行 Claude Code">🤖</span>}
            {codexMap[t]?.running && <span title="正在运行 Codex" style={{ color: '#10a37f' }}>✸</span>}
            {t}
            <a onClick={(e) => { e.stopPropagation(); closeTerm(t) }} style={{ color: 'var(--text-dim)' }}>×</a>
          </span>
        ))}
      </div>

      {/* 工具栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-dim)', fontSize: 12 }}>
          <i style={{ width: 8, height: 8, borderRadius: '50%', background: dot }} />
          {st === 'connected' ? '已连接' : st === 'connecting' ? '连接中' : '已断开'}
        </span>
        {active && claudeMap[active]?.running && (
          <Tooltip title="切换到 Claude Code 对话界面">
            <Button size="small" type={claudeView[active] ? 'primary' : 'default'}
              onClick={() => setClaudeView((v) => ({ ...v, [active!]: !v[active!] }))}>🤖 Claude</Button>
          </Tooltip>
        )}
        {active && codexMap[active]?.running && (
          <Tooltip title="切换到 Codex 对话界面">
            <Button size="small" type={codexView[active] ? 'primary' : 'default'}
              style={codexView[active] ? { background: '#10a37f', borderColor: '#10a37f' } : {}}
              onClick={() => setCodexView((v) => ({ ...v, [active!]: !v[active!] }))}>✸ Codex</Button>
          </Tooltip>
        )}
        <Dropdown
          trigger={['click']}
          menu={{ items: TMUX_MENU as any, onClick: ({ key }) => sendKey(key) }}
          placement="bottomLeft"
        >
          <Button size="small" type="primary" ghost>tmux ▾</Button>
        </Dropdown>
        {active && (
          <Tooltip title="在新浏览器标签全屏打开此会话">
            <Button size="small" onClick={() => window.open(`/?term=${encodeURIComponent(active)}`, '_blank')}>↗ 新标签</Button>
          </Tooltip>
        )}
        <Tooltip title="文件浏览（当前会话工作目录）">
          <Button size="small" type={showFiles ? 'primary' : 'default'} onClick={() => setShowFiles((s) => !s)}>📁 文件</Button>
        </Tooltip>
        <span style={{ flex: 1 }} />
        <Tooltip title="上翻看历史对话"><Button size="small" onClick={() => active && termRefs.current[active]?.scroll(-12)}>▲</Button></Tooltip>
        <Tooltip title="回到最新"><Button size="small" onClick={() => active && termRefs.current[active]?.toBottom()}>▼底</Button></Tooltip>
        <Tooltip title="缩小字号"><Button size="small" onClick={() => setFontSize(Math.max(10, fontSize - 1))}>A-</Button></Tooltip>
        <Tooltip title="放大字号"><Button size="small" onClick={() => setFontSize(Math.min(22, fontSize + 1))}>A+</Button></Tooltip>
        <Tooltip title="复制选中"><Button size="small" onClick={() => { const ok = active && termRefs.current[active]?.copy(); message[ok ? 'success' : 'info'](ok ? '已复制' : '请先选中文本') }}>复制</Button></Tooltip>
        <Tooltip title="重新连接"><Button size="small" onClick={() => active && termRefs.current[active]?.reconnect()}>重连</Button></Tooltip>
      </div>

      {/* 终端区（所有标签常驻，仅激活可见，保留滚动历史）+ 可选文件侧栏 */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          {terms.map((t) => (
            <div key={t} style={{ position: 'absolute', inset: 0, display: t === active ? 'block' : 'none', padding: 6 }}>
              <Term ref={(h) => { termRefs.current[t] = h }} name={t} fontSize={fontSize} active={t === active} onStatus={(s) => setStatus(t, s)} />
              {claudeView[t] && claudeMap[t]?.running && (
                <div style={{ position: 'absolute', inset: 0 }}>
                  <ClaudeChat name={t} file={claudeMap[t].file} dir={claudeMap[t].dir} onBack={() => setClaudeView((v) => ({ ...v, [t]: false }))} />
                </div>
              )}
              {codexView[t] && codexMap[t]?.running && (
                <div style={{ position: 'absolute', inset: 0 }}>
                  <CodexChat name={t} file={codexMap[t].file} dir={codexMap[t].dir} onBack={() => setCodexView((v) => ({ ...v, [t]: false }))} />
                </div>
              )}
            </div>
          ))}
        </div>
        {showFiles && (
          <div style={{ flex: '0 0 clamp(220px, 34%, 340px)', minWidth: 0 }}>
            <FileBrowser dir={cwd} accent="#58a6ff" onClose={() => setShowFiles(false)} />
          </div>
        )}
      </div>

      {/* 移动端文字输入框：软键盘/输入法在 xterm 里会丢字，这里整行可靠发送到 PTY。
          对话视图(Claude/Codex)有自己的输入框，这里隐藏避免双输入框。 */}
      {isTouch && !inChat && (
        <div style={{ display: 'flex', gap: 6, padding: '8px 8px 0' }}>
          <Input
            value={line}
            onChange={(e) => setLine(e.target.value)}
            onPressEnter={(e) => { if ((e.nativeEvent as any).isComposing) return; submitLine() }}
            placeholder="输入文字，回车 / 发送 → 终端"
            allowClear
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          />
          <Button type="primary" onMouseDown={noBlur} onClick={submitLine}>发送</Button>
        </div>
      )}

      {/* 快捷键栏：对话视图下隐藏（聊天 UI 不需要终端控制键，且避免与其输入区挤占） */}
      {!inChat && (
        <div style={{ display: 'flex', gap: 6, padding: 8, borderTop: '1px solid var(--border)', overflowX: 'auto' }}>
          <Button type="primary" onMouseDown={noBlur} onClick={() => (isTouch ? submitLine() : sendKey('\r'))}>Enter</Button>
          {KEYS.map(([label, seq]) => (
            <Button key={label} onMouseDown={noBlur} onClick={() => tapKey(seq)} style={{ flex: '0 0 auto' }}>{label}</Button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── 登录 ──
const PW_KEY = 'ttmux_pw' // 「记住密码」本地存储键
function Login({ onOk }: { onOk: () => void }) {
  const { message } = AntApp.useApp()
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
          <div style={{ color: 'var(--text-dimmer)', fontSize: 12, marginTop: 4, letterSpacing: 0.5 }}>Code anywhere, anytime.</div>
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
              message.error(/BAD_CODE/.test(e.message) ? '动态码错误' : /LOCKED/.test(e.message) ? '尝试过多，已锁定' : '登录失败')
            } finally { setLoading(false) }
          }}
        >
          <Form.Item name="password" rules={[{ required: true, message: '请输入口令' }]}>
            <Input.Password size="large" placeholder="口令" autoFocus={!saved} />
          </Form.Item>
          {totp && (
            <Form.Item name="code" rules={[{ required: true, message: '请输入动态码' }]}>
              <Input size="large" placeholder="Authenticator 动态码（6 位）" inputMode="numeric" maxLength={6} autoFocus={!!saved} />
            </Form.Item>
          )}
          <Form.Item name="remember" valuePropName="checked" style={{ marginBottom: 12 }}>
            <Checkbox>记住密码</Checkbox>
          </Form.Item>
          <Button type="primary" size="large" block htmlType="submit" loading={loading}>登 录</Button>
        </Form>
      </Card>
    </div>
  )
}

// ── 概览（仪表盘）──
// 蜂群状态 → 颜色/中文
function SwarmStatusTag({ status }: { status?: string }) {
  const m: Record<string, [string, string]> = {
    planning: ['blue', '规划中'], running: ['processing', '运行中'],
    integrating: ['gold', '集成中'], done: ['success', '完成'], archived: ['default', '已归档'],
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

function Overview({ go, openTerm, kanna }: { go: (k: string) => void; openTerm: (n: string) => void; kanna?: string }) {
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
            <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-bright)' }}>欢迎回来 👋</div>
            <div style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 4 }}>多终端 · 蜂群编排 · 一起干活</div>
          </div>
          <Space wrap>
            <Button type="primary" onClick={() => go('sessions')}>进入会话</Button>
            <Button onClick={() => go('swarm')}>查看蜂群</Button>
          </Space>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          <Tag bordered={false} style={chip}>ttmux {info?.version || '—'}</Tag>
          <Tag bordered={false} style={chip}>tmux {info?.tmux_version || '—'}</Tag>
          {info?.data_dir && <Tag bordered={false} style={chip}>📁 {info.data_dir}</Tag>}
        </div>
      </div>

      {/* 统计磁贴 */}
      <Row gutter={[14, 14]}>
        <Col xs={12} sm={6}><StatTile icon={ICONS.sessions} label="会话" value={info?.sessions ?? sessions.length} accent="#58a6ff" onClick={() => go('sessions')} /></Col>
        <Col xs={12} sm={6}><StatTile icon={ICONS.swarm} label="蜂群" value={swarms.length} accent="#58a6ff" onClick={() => go('swarm')} /></Col>
        <Col xs={12} sm={6}><StatTile icon={ICONS.swarm} label="活跃成员" value={aliveMembers} accent="#3fb950" onClick={() => go('swarm')} /></Col>
        <Col xs={12} sm={6}><StatTile icon={ICONS.overview} label="待解锁" value={pendingMembers} accent="#d29922" onClick={() => go('swarm')} /></Col>
      </Row>

      {/* 蜂群 + 会话 双栏 */}
      <Row gutter={[14, 14]}>
        <Col xs={24} lg={14}>
          <Card title={<Space><span style={{ color: '#58a6ff' }}>◆</span>蜂群</Space>} extra={<a onClick={() => go('swarm')}>全部 →</a>}>
            {swarms.length === 0 ? <Empty description="暂无蜂群（在终端 ttmux swarm new 创建）" /> : (
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {swarms.slice(0, 5).map((s: any) => (
                  <div key={s.id || s.name} onClick={() => go('swarm')}
                    style={{ cursor: 'pointer', padding: '10px 12px', borderRadius: 10, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-bright)' }}>{s.name}</span>
                      <SwarmStatusTag status={s.status} />
                      {s.supervisor && <Text type="secondary" style={{ fontSize: 12 }}>◆{s.supervisor}</Text>}
                      <span style={{ flex: 1 }} />
                      <span style={{ color: 'var(--text-dim)', fontSize: 12, whiteSpace: 'nowrap' }}>{s.alive}/{s.total} 活{s.pending ? ` · +${s.pending} 待` : ''}</span>
                    </div>
                    <div style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.goal || '(无目标)'}</div>
                    <Progress percent={s.total ? Math.round((s.alive / s.total) * 100) : 0} showInfo={false} size="small" strokeColor="#58a6ff" trailColor="var(--border-subtle)" style={{ marginBottom: 0, marginTop: 6 }} />
                  </div>
                ))}
              </Space>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card title="会话" extra={<a onClick={() => go('sessions')}>全部 →</a>}>
            {sessions.length === 0 ? <Empty description="无活跃会话" /> : (
              <List size="small" dataSource={sessions.slice(0, 6)} renderItem={(s: any) => (
                <List.Item actions={[<a key="t" onClick={() => openTerm(s.name)}>终端</a>]}>
                  <List.Item.Meta
                    title={<span style={{ color: 'var(--text-bright)' }}>{s.name}</span>}
                    description={`${s.windows} 窗口 · ${s.attached == 1 ? '已连接' : '空闲'}`} />
                </List.Item>
              )} />
            )}
          </Card>
        </Col>
      </Row>
    </Space>
  )
}

// ── 任务（命令 + Agent 统一） ──
function Tasks({ openTerm, kanna }: { openTerm: (n: string) => void; kanna?: string }) {
  const [groups, setGroups] = useState<any[]>([])
  const [detail, setDetail] = useState<Record<string, any>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [spawn, setSpawn] = useState(false)
  const [send, setSend] = useState<any[] | null>(null)
  const [collect, setCollect] = useState<string | null>(null)
  const { message } = AntApp.useApp()

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
    try { await api('DELETE', '/tasks/' + encodeURIComponent(g)); message.success('已清理'); setOpen(null); loadGroups() }
    catch (e: any) { message.error(e.message) }
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <div><Button type="primary" onClick={() => setSpawn(true)}>+ 创建任务</Button></div>
      {groups.length === 0 && <Empty description="暂无任务组" />}
      {groups.map((g: any) => (
        <Card key={g.group} size="small"
          title={<span onClick={() => setOpen(open === g.group ? null : g.group)} style={{ cursor: 'pointer' }}>
            {g.group} <Text type="secondary" style={{ fontSize: 13 }}>{g.alive}/{g.total} 存活</Text></span>}
          extra={<Popconfirm title={`清理 ${g.group}？`} onConfirm={() => kill(g.group)}><Button danger size="small">清理</Button></Popconfirm>}
        >
          {open === g.group && (
            <>
              <List size="small" dataSource={detail[g.group]?.tasks || []} locale={{ emptyText: '加载中…' }}
                renderItem={(t: any) => (
                  <List.Item actions={[
                    <a key="t" onClick={() => openTerm(t.name)}>终端</a>,
                    ...(kanna && t.type === 'agent'
                      ? [<a key="k" href={kanna} target="_blank" rel="noreferrer">Kanna ↗</a>]
                      : []),
                  ]}>
                    <List.Item.Meta
                      title={<Space><span>{t.name}</span><TypeTag type={t.type} /><StatusTag status={t.status} code={t.exit_code} /></Space>}
                      description={t.task ? <Text type="secondary" style={{ fontSize: 12 }}>{t.task}</Text> : null}
                    />
                  </List.Item>
                )} />
              <Space style={{ marginTop: 10 }}>
                <Button size="small" onClick={() => setCollect(g.group)}>收集输出</Button>
                <Button size="small" onClick={() => setSend(detail[g.group]?.tasks || [])}>追加指令</Button>
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
// 最近用过的工作目录（localStorage 持久化），作为目录选择器的快捷候选
const RECENT_DIRS_KEY = 'ttmux_recent_dirs'
function recentDirs(): string[] { try { return JSON.parse(localStorage.getItem(RECENT_DIRS_KEY) || '[]') } catch { return [] } }
export function pushRecentDir(d: string) {
  if (!d || !d.trim()) return
  try { localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify([d.trim(), ...recentDirs().filter((x) => x !== d.trim())].slice(0, 8))) } catch {}
}

function DirPicker({ open, start, onPick, onClose }: { open: boolean; start?: string; onPick: (p: string) => void; onClose: () => void }) {
  const [data, setData] = useState<any>({ path: '', parent: '', dirs: [] })
  const [recent, setRecent] = useState<string[]>([])
  const { message } = AntApp.useApp()
  const load = (p?: string) => api('GET', '/fs' + (p !== undefined ? '?path=' + encodeURIComponent(p) : '')).then((r) => setData(r.data)).catch((e) => message.error(e.message))
  useEffect(() => { if (open) { setRecent(recentDirs()); load(start || undefined) } }, [open])
  const enter = (d: string) => load((data.path === '/' ? '' : data.path) + '/' + d)
  const choose = (p: string) => { pushRecentDir(p); onPick(p) }
  return (
    <Modal open={open} onCancel={onClose} title="选择工作目录" zIndex={1100}
      footer={[<Button key="c" onClick={onClose}>取消</Button>, <Button key="o" type="primary" onClick={() => choose(data.path)}>选择此目录</Button>]}>
      {/* 快捷候选：家目录 + 最近用过的目录 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        <Tag style={{ cursor: 'pointer', margin: 0 }} onClick={() => load(undefined)}>🏠 家目录</Tag>
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
            <span style={{ color: d === '..' ? 'var(--text-dim)' : 'var(--text-bright)' }}>{d === '..' ? '↑ 上级目录' : '▸ ' + d}</span>
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
  const { message } = AntApp.useApp()
  useEffect(() => { if (open) { setName(''); setDir('') } }, [open])
  const ok = async () => {
    if (!name.trim()) return message.error('请输入名称')
    try { await api('POST', '/sessions', { name: name.trim(), dir: dir.trim() }); pushRecentDir(dir); message.success('已创建'); onClose(); onDone(name.trim()) }
    catch (e: any) { message.error(e.message) }
  }
  return (
    <>
      <Modal open={open} onCancel={onClose} onOk={ok} okText="创建" title="新建会话" destroyOnClose>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input placeholder="会话名称，如 work" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <Space.Compact style={{ width: '100%' }}>
            <AutoComplete style={{ flex: 1 }} value={dir} onChange={setDir}
              options={recentDirs().map((d) => ({ value: d }))}
              filterOption={(input, opt) => String(opt?.value).toLowerCase().includes(input.toLowerCase())}
              placeholder="工作目录（可空，默认家目录；聚焦看最近）" />
            <Button onClick={() => setPick(true)}>浏览…</Button>
          </Space.Compact>
        </Space>
      </Modal>
      <DirPicker open={pick} start={dir || undefined} onPick={(p) => { setDir(p); setPick(false) }} onClose={() => setPick(false)} />
    </>
  )
}

// ── 会话（可新建/指定目录 / 进终端 / 关闭） ──
function Sessions({ openTerm }: { openTerm: (n: string) => void }) {
  const [list, setList] = useState<any[]>([])
  const [cc, setCc] = useState<Record<string, boolean>>({})
  const [cx, setCx] = useState<Record<string, boolean>>({})
  const [swarmMap, setSwarmMap] = useState<Record<string, { swarm: string; role: string }>>({})
  const [newOpen, setNewOpen] = useState(false)
  const { message } = AntApp.useApp()
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
            if (st?.supervisor) map[st.supervisor] = { swarm: sw.name, role: 'master' }
            for (const m of (st?.members || [])) {
              if (m?.session) map[m.session] = { swarm: sw.name, role: m.role === 'master' ? 'master' : 'worker' }
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
  const kill = async (n: string) => { try { await api('DELETE', '/sessions/' + encodeURIComponent(n)); message.success('已关闭'); load() } catch (e: any) { message.error(e.message) } }
  const goSwarm = (sw: string) => { location.hash = '#/swarm/' + encodeURIComponent(sw) }

  // ── 筛选 / 搜索 ──
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'claude' | 'codex' | 'swarm' | 'idle'>('all')
  const ql = q.trim().toLowerCase()
  const isSwarm = (s: any) => !!swarmMap[s.name]
  // 默认不展示蜂群会话（它们有专门的蜂群页）；仅「蜂群」筛选时才列出
  const match = (s: any, f: typeof filter) => {
    if (f === 'swarm') return isSwarm(s)
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

  return (
    <Card
      title={<Space size={8}>会话<Tag style={{ margin: 0 }}>{cnt('all')}</Tag></Space>}
      extra={<Button type="primary" onClick={() => setNewOpen(true)}>+ 新建会话</Button>}
    >
      {/* 工具条：搜索 + 类型筛选 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 14 }}>
        <Input allowClear value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索会话名…"
          style={{ width: 220, maxWidth: '100%' }}
          prefix={svg(<><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>)} />
        <Segmented value={filter} onChange={(v) => setFilter(v as any)} options={[
          { label: `全部 ${cnt('all')}`, value: 'all' },
          { label: `Claude ${cnt('claude')}`, value: 'claude' },
          { label: `Codex ${cnt('codex')}`, value: 'codex' },
          { label: `蜂群 ${cnt('swarm')}`, value: 'swarm' },
          { label: `空闲 ${cnt('idle')}`, value: 'idle' },
        ]} />
      </div>

      {list.length === 0 ? <Empty description="无活跃会话" />
        : filtered.length === 0 ? <Empty description="无匹配会话" />
          : (
            <List dataSource={filtered} renderItem={(s: any) => {
              const sw = swarmMap[s.name]
              const connected = s.attached == 1
              const agent = cc[s.name] ? 'claude' : cx[s.name] ? 'codex' : null
              return (
                // 整行点击直接进入终端；右侧操作区 stopPropagation 不触发进入
                <List.Item style={{ padding: '10px 8px', cursor: 'pointer' }} onClick={() => openTerm(s.name)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', width: '100%' }}>
                    <i style={{ width: 8, height: 8, borderRadius: '50%', flex: '0 0 8px', background: connected ? '#3fb950' : 'var(--text-dimmer)' }} />
                    <span style={{ fontWeight: 600, color: 'var(--text-bright)' }} title={s.name}>{s.name}</span>
                    {sw && <Tag color="blue" style={{ margin: 0 }}>蜂群:{sw.swarm}{sw.role === 'master' ? '·指挥' : ''}</Tag>}
                    {cc[s.name] && <Tag color="blue" style={{ margin: 0 }}>🤖 Claude</Tag>}
                    {cx[s.name] && <Tag color="green" style={{ margin: 0 }}>✸ Codex</Tag>}
                    {!sw && !agent && <Tag style={{ margin: 0 }}>{connected ? '已连接' : '空闲'}</Tag>}
                    <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{s.windows} 窗口</span>
                    <div onClick={(e) => e.stopPropagation()} style={{ marginLeft: 'auto', display: 'flex', gap: 14, alignItems: 'center' }}>
                      {sw && <a onClick={() => goSwarm(sw.swarm)}>蜂群页</a>}
                      {sw ? (
                        <Popconfirm
                          title="直接关闭蜂群会话？"
                          description={<div style={{ maxWidth: 280 }}>这是蜂群 <b>{sw.swarm}</b> 的{sw.role === 'master' ? '指挥' : '成员'}。从这里关闭只是 kill 会话，蜂群会据此把它当作「已完成」并解锁下游依赖，可能脱节。建议到蜂群页管理。</div>}
                          okText="仍要关闭" okButtonProps={{ danger: true }} cancelText="取消"
                          onConfirm={() => kill(s.name)}>
                          <a style={{ color: '#f85149' }}>关闭</a>
                        </Popconfirm>
                      ) : (
                        <Popconfirm title={`关闭 ${s.name}？`} onConfirm={() => kill(s.name)}>
                          <a style={{ color: '#f85149' }}>关闭</a>
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

// ── Env ──
function EnvPage() {
  const [list, setList] = useState<any[]>([])
  const { message, modal } = AntApp.useApp()
  const load = () => api('GET', '/env').then(setList).catch(() => {})
  useEffect(() => { load() }, [])
  const add = () => {
    let key = '', value = ''
    modal.confirm({
      title: '添加环境变量',
      content: (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input placeholder="KEY" onChange={(e) => (key = e.target.value)} />
          <Input placeholder="VALUE" onChange={(e) => (value = e.target.value)} />
        </Space>
      ),
      okText: '设置',
      onOk: async () => {
        if (!key.trim()) { message.error('需要 KEY'); throw new Error('empty') }
        await api('PUT', '/env', { key: key.trim(), value }); message.success('已设置'); load()
      },
    })
  }
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card title="全局环境变量" extra={<Space>
        <Button onClick={add}>+ 添加</Button>
        <Button onClick={async () => { try { await api('POST', '/env/push'); message.success('已推送') } catch (e: any) { message.error(e.message) } }}>推送到会话</Button>
      </Space>}>
        {list.length === 0 ? <Empty description="无环境变量" /> : (
          <List dataSource={list} renderItem={(kv: any) => (
            <List.Item actions={[<Popconfirm key="d" title="删除？" onConfirm={async () => { try { await api('DELETE', '/env/' + encodeURIComponent(kv.key)); message.success('已删除'); load() } catch (e: any) { message.error(e.message) } }}><a style={{ color: '#f85149' }}>删除</a></Popconfirm>]}>
              <List.Item.Meta title={<code>{kv.key}</code>} description={<code style={{ color: 'var(--text-dim)' }}>{kv.value}</code>} />
            </List.Item>
          )} />
        )}
      </Card>
      <TwoFactorCard />
    </Space>
  )
}

// ── 两步验证 (TOTP / Authenticator)：可在 UI 里开启/关闭，即时生效并持久化 ──
function TwoFactorCard() {
  const { message } = AntApp.useApp()
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
    try { await api('POST', '/2fa/enable', { secret: setup.secret, code: code.trim() }); message.success('两步验证已开启'); setSetup(null); refresh() }
    catch (e: any) { message.error(/BAD_CODE/.test(e.message) ? '动态码不正确，请用最新的码' : e.message) }
    finally { setBusy(false) }
  }
  const disable = async () => {
    try { await api('POST', '/2fa/disable'); message.success('两步验证已关闭'); setQr(null); refresh() }
    catch (e: any) { message.error(e.message) }
  }
  const showCurrent = async () => {
    try { const r = await api('GET', '/2fa/qr'); if (r.data?.enabled) setQr({ uri: r.data.uri, secret: r.data.secret }) }
    catch (e: any) { message.error(e.message) }
  }
  const copy = (s: string) => { try { navigator.clipboard?.writeText(s) } catch {}; message.success('已复制') }

  return (
    <Card title="两步验证 (TOTP / Authenticator)" extra={
      <Tag color={enabled ? 'green' : 'default'}>{enabled === null ? '…' : enabled ? '已开启' : '未开启'}</Tag>
    }>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Text type="secondary" style={{ fontSize: 13 }}>
          开启后登录需「口令 + Authenticator 6 位动态码」。开关即时生效并持久化；也可用环境变量 <code>TTMUX_WEB_TOTP_SECRET</code> 预置。
        </Text>

        {!setup && (
          <Space>
            {enabled
              ? <>
                  <Button onClick={showCurrent}>查看二维码</Button>
                  <Popconfirm title="确定关闭两步验证？" onConfirm={disable}><Button danger>关闭两步验证</Button></Popconfirm>
                </>
              : <Button type="primary" onClick={startSetup}>开启两步验证</Button>}
          </Space>
        )}

        {/* 开启流程：扫码 → 输码确认 */}
        {setup && (
          <div style={{ padding: 16, background: 'var(--bg-base)', borderRadius: 8 }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ background: '#fff', padding: 10, borderRadius: 8 }}><QRCodeSVG value={setup.uri} size={168} /></div>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 4 }}>① 用 Authenticator 扫码，或手动输入密钥：</div>
                <Space.Compact style={{ width: '100%', marginBottom: 10 }}>
                  <Input readOnly value={setup.secret} />
                  <Button onClick={() => copy(setup.secret)}>复制</Button>
                </Space.Compact>
                <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 4 }}>② 输入 App 上显示的 6 位码确认：</div>
                <Space.Compact style={{ width: '100%' }}>
                  <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6 位动态码" inputMode="numeric" maxLength={6} onPressEnter={confirmEnable} />
                  <Button type="primary" loading={busy} onClick={confirmEnable}>确认开启</Button>
                </Space.Compact>
              </div>
            </div>
            <div style={{ marginTop: 10 }}><Button size="small" onClick={() => setSetup(null)}>取消</Button></div>
          </div>
        )}

        {/* 查看当前二维码（已开启时给新设备加） */}
        {qr && (
          <div style={{ padding: 16, background: 'var(--bg-base)', borderRadius: 8, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ background: '#fff', padding: 10, borderRadius: 8 }}><QRCodeSVG value={qr.uri} size={168} /></div>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 4 }}>扫码把当前密钥加入新设备：</div>
              <Space.Compact style={{ width: '100%' }}><Input readOnly value={qr.secret} /><Button onClick={() => copy(qr.secret)}>复制</Button></Space.Compact>
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
  const submit = async () => {
    const v = await form.validateFields()
    const tasks = (v.tasks || []).filter((t: any) => t?.name && t?.payload)
      .map((t: any) => (type === 'agent' ? { name: t.name, task: t.payload } : { name: t.name, cmd: t.payload }))
    if (!tasks.length) return message.error('至少一个任务')
    const body: any = { group: v.group, type, tasks }
    if (type === 'agent') { body.dir = v.dir; body.perm = v.perm; body.model = v.model }
    try { await api('POST', '/tasks', body); message.success('已创建'); onClose(); onDone() }
    catch (e: any) { message.error(e.message) }
  }
  return (
    <>
      <Modal open={open} onCancel={onClose} onOk={submit} okText="创建" title="创建任务" destroyOnClose>
        <Segmented block value={type} onChange={(v) => setType(v as string)}
          options={[{ label: '命令', value: 'cmd' }, { label: 'Agent', value: 'agent' }]} style={{ marginBottom: 12 }} />
        <Form form={form} layout="vertical" preserve={false} initialValues={{ tasks: [{}, {}], perm: 'auto' }}>
          <Form.Item name="group" label="任务组名称" rules={[{ required: true }]}><Input placeholder="如 build / refactor" /></Form.Item>
          <Form.List name="tasks">
            {(fields, { add, remove }) => (
              <>
                {fields.map((f) => (
                  <Space key={f.key} align="baseline" style={{ display: 'flex', marginBottom: 8 }}>
                    <Form.Item {...f} name={[f.name, 'name']} noStyle><Input placeholder="名称" style={{ width: 110 }} /></Form.Item>
                    <Form.Item {...f} name={[f.name, 'payload']} noStyle><Input placeholder={type === 'agent' ? '任务描述' : '命令'} style={{ width: 240 }} /></Form.Item>
                    <a onClick={() => remove(f.name)} style={{ color: '#f85149' }}>×</a>
                  </Space>
                ))}
                <Button type="dashed" onClick={() => add()} block>+ 加一行</Button>
              </>
            )}
          </Form.List>
          {type === 'agent' && (
            <div style={{ marginTop: 12 }}>
              <Form.Item label="工作目录 (--dir)">
                <Space.Compact style={{ width: '100%' }}>
                  <Form.Item name="dir" noStyle><Input placeholder="如 ~/project" /></Form.Item>
                  <Button onClick={() => setPickDir(true)}>浏览…</Button>
                </Space.Compact>
              </Form.Item>
              <Space>
                <Form.Item name="perm" label="权限"><Input placeholder="auto/plan/default" /></Form.Item>
                <Form.Item name="model" label="模型"><Input placeholder="可空" /></Form.Item>
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
  useEffect(() => { if (tasks?.length) setSess(tasks[0].name) }, [tasks])
  const go = async () => {
    if (!sess || !msg) return
    try { await api('POST', '/tasks/_/send', { sess, msg }); message.success('已发送'); onClose() } catch (e: any) { message.error(e.message) }
  }
  return (
    <Modal open={!!tasks} onCancel={onClose} onOk={go} okText="发送" title="追加指令" destroyOnClose>
      <Select style={{ width: '100%', marginBottom: 10 }} value={sess} onChange={setSess}
        options={(tasks || []).map((t: any) => ({ value: t.name, label: `${t.name} [${t.type}]` }))} />
      <Input.TextArea rows={3} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="发送给该任务/Agent 的指令" />
    </Modal>
  )
}

function CollectModal({ group, onClose }: { group: string | null; onClose: () => void }) {
  const [text, setText] = useState('加载中…')
  useEffect(() => {
    if (!group) return
    setText('加载中…')
    api('GET', '/tasks/' + encodeURIComponent(group) + '/collect')
      .then((r) => setText((r.results || []).map((x: any) => `━━━ ${x.task} [${x.type}] ━━━\n${x.prompt ? '任务: ' + x.prompt + '\n' : ''}${x.output}`).join('\n\n') || '(无输出)'))
      .catch((e) => setText(e.message))
  }, [group])
  return (
    <Modal open={!!group} onCancel={onClose} footer={null} title={`收集: ${group || ''}`} width="min(720px,94vw)">
      <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '60vh', overflow: 'auto', background: 'var(--bg-term)', padding: 12, borderRadius: 8, fontSize: 12.5 }}>{text}</pre>
    </Modal>
  )
}
