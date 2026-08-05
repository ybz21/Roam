// ttmux Web 控制台 — React + Vite + Antd（统一深色主题）
// 布局（见 docs/design/web/01-overview.md）：
//   电脑 ≥1200 → 三栏：导航 Sider | 列表(页面) | 终端面板(常驻, 多标签)
//   平板/手机   → 终端为全屏覆盖层；手机底部 Tab 导航
// 终端：多标签 / 字号调节 / 复制 / 更多快捷键 / 断线自动重连。
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Layout, Button, Card, List, Tag, Form, Input, Select, Segmented, Tabs, Descriptions,
  Statistic, Row, Col, Space, Popconfirm, Empty, Modal, App as AntApp, Typography, Spin, Tooltip, Dropdown, Checkbox, Progress, AutoComplete, Radio, Switch, Collapse, InputNumber,
} from 'antd'
import type { MenuProps } from 'antd'
import { QRCodeSVG } from 'qrcode.react'
import { api, upload, makeClipboardImageFile, setUnauthorizedHandler } from './api'
import Term, { TermHandle, TermStatus } from './Terminal'
import ClaudeChat from './ClaudeChat'
import CodexChat from './CodexChat'
import FileBrowser from './FileBrowser'
import FileWorkspace from './FileWorkspace'
import AdaptivePanel from './shell/AdaptivePanel'
import { InspectorColumn } from './shell/InspectorColumn'
import MobileSubPage from './MobileSubPage'
import { FileView } from './fileview'
// 非首屏的重页面（蜂群/Git 面板/浏览器/手机镜像/插件）按路由懒加载：切到对应 tab 才拉 chunk，
// 缩小首屏 index 块。都渲染在同一个 Suspense 边界内（见 lazyFallback，App 内 page）。
const GitPanel = lazy(() => import('./GitPanel'))
const WorktreePanel = lazy(() => import('./WorktreePanel'))
const RaceCreateModal = lazy(() => import('./Race').then((m) => ({ default: m.RaceCreateModal })))
const RaceComparePanel = lazy(() => import('./Race').then((m) => ({ default: m.RaceComparePanel })))
const PluginsPanel = lazy(() => import('./PluginsPanel'))
const BrowserView = lazy(() => import('./BrowserView'))
const PhoneView = lazy(() => import('./PhoneView'))
const Swarm = lazy(() => import('./Swarm'))
const Projects = lazy(() => import('./Projects'))
const OverviewPage = lazy(() => import('./Overview'))
import UpdateBanner from './UpdateBanner'
import { useThemeMode } from './theme'
import { useI18n } from './i18n'
import { usePwaInstall } from './install'
import { usePreferences, savePreferences, saveWorkspace, loadPreferences } from './preferences'
import { PromptDialog, advancePromptSignal, detectPrompt } from './prompt'
import type { PromptSignal } from './prompt'
import { useLayout } from './layout'
import { useWorkspaceLayout, NAV_WIDTH, NAV_RAIL } from './shell/useWorkspaceLayout'
import { Workspace, SessionCapsule } from './shell/Workspace'
import { Navigation } from './shell/Navigation'
import { reorderTabs } from './shell/tabs'
import { requestIntent, takeIntentData, INTENT_EVENT, OPEN_FILE_INTENT } from './intents'
import { SessionDock, SessionSwitchSheet } from './shell/SessionDock'
import { DPad } from './shell/DPad'
import { sessionProject, setSessionProjects, buildSessionProjects, useSessionProjects, sessionLocation } from './session-project'
import { MobileSheet, SheetRow, SheetSection } from './shell/MobileSheet'
import { WorkspaceTopbar, type PaletteActions, type PaletteItem } from './shell/WorkspaceTopbar'
import { GlobalSearch, openPalette } from './shell/palette'
import { copyText } from './chat/blocks'
import { SessionTitle, TabName, setSessionLabels, updateSessionLabel, useSessionLabel, sessionLabel, sessionDisplay } from './session-label'
import { VoiceInput } from './chat/VoiceInput'
import LinkStatus from './p2p/LinkStatus'
import { startControlLink, stopControlLink } from './p2p/transport'
import { PointerResizeShield, usePointerResize } from './PointerResize'
import { PaneCloseConfirm, type PaneCloseTarget } from './PaneCloseConfirm'

interface ClaudeInfo { running: boolean; file?: string; dir?: string }

const { Sider, Content } = Layout
const { Text } = Typography

// 「蜂群」不进导航：项目页是唯一主入口（任务驱动，08 设计），蜂群从项目编队 tab 进
// （蜂群台深链 #/swarm/<名>）。
// 「会话」在 NAV 里但不进桌面侧栏两组：桌面从项目页/概览进，命令面板能搜到；
// 手机则**必须**有个导航入口——此前它只能从概览的「全部会话」链接进，而搜索、筛选、
// Worktree 管理、新建竞赛全在那一页（13 §6）。
const NAV = [
  { key: 'overview', labelKey: 'nav.overview' },
  { key: 'projects', labelKey: 'nav.projects' },
  { key: 'sessions', labelKey: 'nav.sessions' },
  { key: 'files', labelKey: 'nav.files' },
  { key: 'browser', labelKey: 'nav.browser' },
  { key: 'phone', labelKey: 'nav.phone' },
  { key: 'plugins', labelKey: 'nav.plugins' },
  { key: 'settings', labelKey: 'nav.env' },
]

// 桌面导航的两组（14 §4.4）。NAV 仍是全量注册表——命令面板和手机「更多」都从它取，
// 所以 settings/about 留在 NAV 里，只是不进这两组，改由账户菜单收口。
const NAV_WORKSPACE = ['overview', 'projects', 'files']
const NAV_TOOLS = ['browser', 'phone', 'plugins']

// 手机底栏只放高频页，plugins/settings 折进「更多」，避免底栏拥挤（桌面侧栏仍展示全部）
const MOBILE_NAV_KEYS = ['overview', 'projects', 'files']
// 「更多」sheet 里的两段：会话属于工作区主线，不归到工具下面
const MOBILE_MORE_WORKSPACE = ['sessions']
const MOBILE_MORE_TOOLS = ['browser', 'phone', 'plugins', 'settings']
const MOBILE_MORE_KEYS = [...MOBILE_MORE_WORKSPACE, ...MOBILE_MORE_TOOLS]

// 用 Canvas 容器查询排版的页面（见 index.css 的 .tt-canvas[data-cq]）。逐页开，
// 不是全局开：container-type 会改变 fixed 后代的包含块。
const CQ_PAGES = new Set(['overview', 'sessions'])

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
  const base = (h.split('?')[0]) || '#/projects'
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) { if (v) sp.set(k, v) }
  const qs = sp.toString()
  const next = qs ? base + '?' + qs : base
  if (h !== next) history.replaceState(history.state, '', next)
}

// URL 上的终端标签参数（terms=打开的标签、active=当前标签）。
// 现在写进去的是会话 id；老链接里存的是会话名，两者都能读——还原时按 id 表判别（见 resolveToken）。
function readTermTokens(): { terms: string[]; active: string } {
  const p = getHashParams()
  const t = p.get('terms')
  const a = p.get('active')
  return {
    terms: t ? t.split(',').map(decodeURIComponent).filter(Boolean) : [],
    active: a ? decodeURIComponent(a) : '',
  }
}

// 线性图标（无 emoji，currentColor 描边）
const svg = (paths: any) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths}</svg>
)
const ICONS: Record<string, any> = {
  overview: svg(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>),
  projects: svg(<><path d="M3 10.2 12 3l9 7.2" /><path d="M5.5 9v11h13V9" /><path d="M9.5 20v-5h5v5" /></>),
  sessions: svg(<><polyline points="5 8 9 12 5 16" /><line x1="12" y1="16" x2="18" y2="16" /></>),
  swarm: svg(<><circle cx="12" cy="5" r="2.4" /><circle cx="5" cy="17" r="2.4" /><circle cx="19" cy="17" r="2.4" /><line x1="12" y1="7.4" x2="6.5" y2="14.8" /><line x1="12" y1="7.4" x2="17.5" y2="14.8" /></>),
  files: svg(<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M7 12h10" /><path d="M7 16h6" /></>),
  settings: svg(<><line x1="4" y1="7" x2="20" y2="7" /><circle cx="9" cy="7" r="2.3" /><line x1="4" y1="17" x2="20" y2="17" /><circle cx="15" cy="17" r="2.3" /></>),
  browser: svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><circle cx="6" cy="6.5" r="0.6" /><circle cx="8.4" cy="6.5" r="0.6" /></>),
  phone: svg(<><rect x="6" y="2" width="12" height="20" rx="2.5" /><line x1="10" y1="18.5" x2="14" y2="18.5" /></>),
  plugins: svg(<path d="M10 3.5a1.8 1.8 0 0 1 3.6 0V5H17a2 2 0 0 1 2 2v3.4h1.5a1.8 1.8 0 0 1 0 3.6H19V17a2 2 0 0 1-2 2h-3.4v1.5a1.8 1.8 0 0 1-3.6 0V19H7a2 2 0 0 1-2-2v-3.4H3.5a1.8 1.8 0 0 1 0-3.6H5V7a2 2 0 0 1 2-2h3z" />),
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
  return type === 'agent'
    ? <Tag color="blue" icon={<BotIcon size={11} />}>{t('session.type.agent')}</Tag>
    : <Tag icon={<KeyboardIcon size={11} />}>{t('session.type.command')}</Tag>
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
export function relTime(sec: string | number | undefined, t: (k: string, v?: Record<string, string | number>) => string): string {
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
  // 手机(窄屏)两级导航：一级整页文件列表，点文件后详情以全屏二级页(MobileSubPage)展开；
  // 桌面仍是 FileWorkspace(文件树 dock + 多 tab 编辑)。
  const { phone: isMobile } = useLayout()
  const [mobileFile, setMobileFile] = useState<string | null>(null)
  // 搜到文件 → 切到本页 → 打开它。桌面那条路径在 FileWorkspace 里（开成标签页），
  // 手机这里是二级全屏页，所以各接各的。
  useEffect(() => {
    if (!isMobile) return
    const on = () => {
      const data = takeIntentData<{ path?: string }>(OPEN_FILE_INTENT)
      const p = data && data !== true ? data.path : ''
      if (p) setMobileFile(p)
    }
    on()
    window.addEventListener(INTENT_EVENT, on)
    return () => window.removeEventListener(INTENT_EVENT, on)
  }, [isMobile])
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
  if (isMobile) {
    return (
      <div style={{ height: '100%', minHeight: 0, display: 'flex' }}>
        <FileBrowser dir="" accent="var(--accent)" layout="dock" onOpenFile={setMobileFile} onOpenAgent={openAgent} />
        {mobileFile && (
          <MobileSubPage onBack={() => setMobileFile(null)}>
            <FileView path={mobileFile} accent="var(--accent)" inline onBack={() => setMobileFile(null)}
              onClose={() => setMobileFile(null)} onOpenPath={setMobileFile} onOpenAgent={openAgent} />
          </MobileSubPage>
        )}
      </div>
    )
  }
  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex' }}>
      <FileWorkspace dir="" accent="var(--accent)" onOpenAgent={openAgent} />
    </div>
  )
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [route, setRoute] = useState(() => normalizeRoute(location.hash.replace(/^#\/?/, '') || 'projects'))
  const tab = route.split('/')[0]                                  // 基础页（swarm/leave → swarm）
  const swarmSub = tab === 'swarm' && route.includes('/') ? decodeURIComponent(route.slice(route.indexOf('/') + 1)) : '' // 深链选中的蜂群
  const projectSub = tab === 'projects' && route.includes('/') ? decodeURIComponent(route.slice(route.indexOf('/') + 1)) : '' // 深链选中的项目
  const go = (k: string) => {
    const qi = location.hash.indexOf('?')
    const qs = qi >= 0 ? location.hash.slice(qi) : ''
    location.hash = '#/' + k + qs
  }
  const { mode, toggle: toggleTheme } = useThemeMode()
  const { t } = useI18n()
  const [prefs] = usePreferences()
  const themeIcon = mode === 'dark'
    ? svg(<><circle cx="12" cy="12" r="4.2" /><path d="M12 2v2.2M12 19.8V22M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2 12h2.2M19.8 12H22M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" /></>)
    : svg(<><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" /></>)
  const { phone: isMobile, desktop: hasSider } = useLayout()
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

  // 多终端状态（从 URL 恢复）。URL 里放的是**会话 id**（见下方 sessIds 注释），
  // 组件内部一律用会话名——后端 API / WebSocket 收发的都是名字。
  const [terms, setTerms] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  // URL 上待还原的 id/名字（还没拿到 id 映射前先原样存着）
  const urlTerms = useRef<string[]>(readTermTokens().terms)
  const urlActive = useRef<string>(readTermTokens().active)
  const restored = useRef(false) // 还原完成前不许回写 URL，否则会把待还原的参数抹掉
  const [overlay, setOverlay] = useState(false) // 手机/平板全屏终端
  const [moreOpen, setMoreOpen] = useState(false) // 手机「更多」sheet
  // 空间状态（Page / Split / Focus）与 Dock 宽度：唯一的尺寸契约来源
  const space = useWorkspaceLayout(terms.length > 0)
  const modKeyLabel = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl+'
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(navigator.onLine)
    window.addEventListener('online', on); window.addEventListener('offline', on)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', on) }
  }, [])
  const [fontSize, setFontSize] = useState(13)
  const [statusMap, setStatusMap] = useState<Record<string, TermStatus>>({})
  const termRefs = useRef<Record<string, TermHandle | null>>({})
  // Claude Code / Codex 检测（针对已打开的终端）+ 每个标签的「对话/终端」视图切换
  const [claudeMap, setClaudeMap] = useState<Record<string, ClaudeInfo>>({})
  const [claudeView, setClaudeView] = useState<Record<string, boolean>>({})
  const [codexMap, setCodexMap] = useState<Record<string, ClaudeInfo>>({})
  const [codexView, setCodexView] = useState<Record<string, boolean>>({})

  // 一条轮询喂两件事（15s）：
  //   ① 导航 badge 的跨项目待收尾数（14 §4.4）
  //   ② 会话 → 项目 归属表，给终端标签写 `项目 · 会话`（14 §6.3）
  // 概览页轮的是同两条接口，所以两处显示的数字同源，不会互相打架。
  // 会话坞要显示「几个在等你」，而这个信号是 TerminalPane 抓屏算出来的（detectPrompt）。
  // 它已经在为每个已开会话轮询，别再开第二份——让它把结果递上来即可。
  const [mobileWaiting, setMobileWaiting] = useState<Record<string, boolean>>({})
  const [unfinished, setUnfinished] = useState(0)
  // 不能按 hasSider 收窄：手机没有侧栏，但会话坞同样要写「项目 · 会话」
  useEffect(() => {
    let stop = false
    const load = async () => {
      try {
        const [pr, an] = await Promise.all([
          api('GET', '/projects'),
          api('GET', '/sessions/annotations').catch(() => null),
        ])
        if (stop) return
        const projects = pr?.data?.projects || []
        setUnfinished(projects.reduce((n: number, p: any) => n + (p.unfinished || 0), 0))
        setSessionProjects(buildSessionProjects(projects, an?.data || {}))
      } catch { /* 轮询失败就保持上一轮的值，不清空 */ }
    }
    load()
    const i = setInterval(load, 15000)
    return () => { stop = true; clearInterval(i) }
  }, [])

  // Canvas 滚动位置（14 §6.3.5）：终端一开，Canvas 变窄、卡片重排，scrollHeight
  // 从 1108 掉到 781，浏览器顺手把 scrollTop 归零——"你看到哪儿了"就这么没了。
  //
  // 两个坑：
  // ① **不能等状态变了再存**。effect 在 DOM 改完之后才跑，那时 scrollTop 已经是 0。
  //    所以持续记录，而不是在切换时抓一把。
  // ② **不能存像素**。两种形态的 scrollHeight 不一样，像素值换算过去是错的位置。
  //    存比例，还原时再乘回去——重排前后落在同一批卡片上。
  const canvasRatio = useRef(0)
  useEffect(() => {
    if (!hasSider) return
    const el = document.querySelector<HTMLElement>('.tt-canvas')
    if (!el) return
    const on = () => {
      const room = el.scrollHeight - el.clientHeight
      if (room > 0) canvasRatio.current = el.scrollTop / room
    }
    el.addEventListener('scroll', on, { passive: true })
    return () => el.removeEventListener('scroll', on)
  }, [hasSider])
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('.tt-canvas')
    if (!el || !canvasRatio.current) return
    // 等这一帧的布局落定再还原，否则写进去的值会被重排冲掉
    const id = requestAnimationFrame(() => {
      const room = el.scrollHeight - el.clientHeight
      if (room > 0) el.scrollTop = Math.round(canvasRatio.current * room)
    })
    return () => cancelAnimationFrame(id)
  }, [space.mode])

  // ── 工作区快捷键（14 §9.1）：⌘J 开合终端、⌘⇧J 终端聚焦、Esc 退出聚焦 ──
  // 只挂带修饰键的这几个；字母单键快捷键要等命令面板一起做，且必须在输入框/终端
  // 聚焦时禁用，否则会把用户正在打的字吃掉。
  useEffect(() => {
    if (!hasSider) return
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        if (e.shiftKey) space.toggleFocus()
        else { space.setFocus('none'); space.toggleDock() }
        return
      }
      // Esc 收一层：覆盖态先收面板，聚焦态退回分栏。两者都不关终端、不离开页面。
      //
      // 注意这里**不需要**判断焦点在不在终端里：xterm 在捕获阶段就 stopPropagation
      // 了 Escape，事件根本冒泡不到 window。于是天然是对的——在 vim/Claude 里按 Esc
      // 进 TUI，焦点在页面上按 Esc 才收面板。改这段前先确认这条前提还成立。
      if (e.key === 'Escape') {
        if (space.mode === 'overlay') space.setDockOpen(false)
        else if (space.focus !== 'none') space.setFocus('none')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasSider, space])

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false))
    api('GET', '/me').then(() => {
      setAuthed(true); loadPreferences()
      navigator.clipboard?.readText?.().catch(() => {})
    }).catch(() => setAuthed(false))
  }, [])

  // ── 会话身份映射（id ↔ 名字）──
  // 会话名可以随时改，用它当 URL 里的 handle 会让分享/收藏的链接一改名就指空。id 由后端按
  // tmux session_id 派生、改名不变，所以 URL 只写 id。名字仍是 API/WS 的 handle，只在这里换算。
  const [sessIds, setSessIds] = useState<{ byId: Record<string, string>; byName: Record<string, string> } | null>(null)
  useEffect(() => {
    if (!authed) return
    let stop = false
    const load = () => api('GET', '/sessions').then((list) => {
      if (stop) return
      const byId: Record<string, string> = {}
      const byName: Record<string, string> = {}
      const labels: Record<string, string> = {}
      for (const s of Array.isArray(list) ? list : []) {
        if (s?.id && s?.name) { byId[s.id] = s.name; byName[s.name] = s.id }
        if (s?.name && s?.label) labels[s.name] = s.label
      }
      setSessIds({ byId, byName })
      setSessionLabels(labels) // 展示名（@roam_name）：界面显示「名字（id）」，handle 仍是会话名
    }).catch(() => { if (!stop) setSessIds((m) => m || { byId: {}, byName: {} }) }) // 拉不到也要放行还原，别把标签卡在空白
    load()
    const t = setInterval(load, 5000)
    return () => { stop = true; clearInterval(t) }
  }, [authed])

  // 从 URL 还原标签：拿到 id 表后做一次。老链接里存的是名字，id 表里查不到就按名字用。
  useEffect(() => {
    if (!sessIds || restored.current) return
    restored.current = true
    const toName = (tok: string) => sessIds.byId[tok] || tok
    const names = Array.from(new Set(urlTerms.current.map(toName)))
    if (!names.length) return
    // 用户在 id 表回来之前就点开了标签 → 以他的操作为准，别被 URL 还原顶掉
    setTerms((cur) => (cur.length ? cur : names))
    setActive((cur) => {
      if (cur) return cur
      const a = urlActive.current ? toName(urlActive.current) : ''
      return a && names.includes(a) ? a : names[names.length - 1]
    })
  }, [sessIds])

  // 终端状态同步到 URL，刷新后可恢复。写 id；还没有 id 的（刚建、列表未刷新）先退回写名字。
  useEffect(() => {
    if (!restored.current) return
    const toTok = (n: string) => sessIds?.byName[n] || n
    setHashParams({
      terms: terms.map((n) => encodeURIComponent(toTok(n))).join(','),
      active: active ? encodeURIComponent(toTok(active)) : '',
    })
  }, [terms, active, sessIds])

  // hash 路由：URL #/xxx 与当前页同步（支持前进/后退、刷新保持、收藏分享）
  useEffect(() => {
    const apply = () => setRoute(normalizeRoute(location.hash.replace(/^#\/?/, '') || 'projects'))
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

  // 通用传输 Phase 1a：登录后且用户偏好开 P2P → 建会话级常驻 control PC（左边栏全局状态）。
  // 偏好关闭 / 登出即拆链。P2P 是否真正可用由 transport 内部拉 /api/p2p/config 决定。
  useEffect(() => {
    if (authed && prefs.p2pEnabled) startControlLink()
    else stopControlLink()
  }, [authed, prefs.p2pEnabled])

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
    if (hasSider) { space.setDockOpen(true); space.setFocus('none') } // 桌面：拉出右侧停靠栏
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
    // id 表 5 秒才轮询一次，这里先就地改名，免得 URL 上的 id 短暂退化成名字再跳回来
    setSessIds((m) => {
      const id = m?.byName[oldName]
      if (!m || !id) return m
      const { [oldName]: _drop, ...rest } = m.byName
      return { byId: { ...m.byId, [id]: newName }, byName: { ...rest, [newName]: id } }
    })
  }
  const closeTerm = (name: string) => {
    setTerms((ts) => {
      const next = ts.filter((t) => t !== name)
      setActive((a) => (a === name ? (next[next.length - 1] || null) : a))
      if (next.length === 0) { setOverlay(false); space.setFocus('none') }
      return next
    })
    delete termRefs.current[name]
  }
  const setStatus = (name: string, s: TermStatus) => setStatusMap((m) => ({ ...m, [name]: s }))
  const sendKey = (seq: string) => active && termRefs.current[active]?.send(seq)

  // 标签拖拽排序（14 §7.1）。顺序本来就写进 URL 的 terms=，所以持久化是白拿的。
  const reorderTerm = (name: string, to: number) => setTerms((ts) => reorderTabs(ts, name, to))


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
      onCollapse={() => { setOverlay(false); space.setDockOpen(false) }}
      onReorder={reorderTerm}
      onNeedsInput={setMobileWaiting}
      // Focus 只在桌面有意义：手机上终端本来就是全屏覆盖层
      focus={hasSider ? { on: space.focus !== 'none', toggle: space.toggleFocus, hint: `${modKeyLabel}⇧J` } : undefined}
    />
  )

  const pages: any = {
    // 概览不再嵌会话列表：那是会话页的活（分工见 docs/design/web/13-mobile-responsive/ia.html）
    overview: <OverviewPage openTerm={openTerm} />,
    swarm: <Swarm openTerm={openTerm} initialSwarm={swarmSub || undefined} onNav={(n) => { location.hash = n ? '#/swarm/' + encodeURIComponent(n) : '#/swarm' }} />,
    projects: <Projects openTerm={openTerm} closeTerm={closeTerm} initialKey={projectSub || undefined} activeTerm={active} />,
    sessions: <Sessions openTerm={openTerm} closeTerm={closeTerm} activeTerm={active} />,
    files: <FilesPage openTerm={openTerm} />,
    settings: <EnvPage />,
    plugins: <PluginsPanel />,
    browser: <BrowserView />,
    phone: <PhoneView />,
    about: <AboutPage />,
  }
  // 懒加载页面 chunk 拉取期间的兜底：居中转圈（体量小，通常一闪而过）
  const lazyFallback = <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}><Spin /></div>
  const page = <Suspense fallback={lazyFallback}>{pages[tab] || pages.projects}</Suspense>
  // browser 全幅(自带工具栏铺满)；phone 与概览/会话一致走 tt-page（同 16px 留白 + 满高，见 tt-page-phone）。
  // 浏览器页不再全幅特例：与 文件/手机 同走 tt-page 满高容器，五页左上角起点统一 (16,16)
  const pageNode = <div className={`tt-page tt-page-${tab}${isMobile ? ' tt-page-mobile' : ''}${isMobile && terms.length ? ' has-dock' : ''}`}>{page}</div>
  // Canvas 与 Dock 各包一层：两者在 Page / Split / Focus 三态间只改宽度，不改挂载
  // ⌘K 面板的**本地**条目：页面导航 + 已打开的会话——这两样数据就在内存里，打字即出。
  // 项目 / 全部会话 / 项目文件走后端 /search（见 shell/palette），不在这里凑。
  // 这一段在 authed / soloName 那几个提前 return 之后，**不能用 hook**——
  // useMemo 放这里就是条件调用，React 直接抛 #310（踩过一次）。所以这两个值每次
  // 渲染重算；面板那边的合并是纯函数，重算一次的代价远小于把整块状态提上来。
  const paletteItems: PaletteItem[] = [
    ...NAV.map((n) => ({
      key: `page:${n.key}`, group: t('workspace.groupPages'), title: t(n.labelKey),
      keywords: n.key, icon: ICONS[n.key], run: () => go(n.key),
    })),
    ...terms.map((name) => ({
      key: `term:${name}`, group: t('workspace.groupSessions'),
      title: sessionDisplay(name), desc: name === active ? t('workspace.current') : undefined,
      run: () => { setActive(name); space.setDockOpen(true); if (isMobile) setOverlay(true) },
    })),
  ]

  // 面板选中结果后要做的事。三类各自一条路径：项目→详情页深链，会话→开终端，
  // 文件→切文件页并留下「打开这个文件」的意图（见 intents.ts，文件工作区接手）。
  const paletteActions: PaletteActions = {
    openRoute: (hash: string) => { location.hash = hash },
    openSession: (name: string) => openTerm(name),
    openFile: (path: string) => { go('files'); requestIntent(OPEN_FILE_INTENT, { path }) },
  }

  const canvasNode = (
    <Content className="tt-canvas" data-cq={CQ_PAGES.has(tab) ? 'on' : undefined} style={{
      flex: 1, minWidth: 0, minHeight: 0, height: '100%', padding: 0,
      overflow: tab === 'browser' || tab === 'phone' || tab === 'files' ? 'hidden' : 'auto',
    }}>{pageNode}</Content>
  )
  const dockNode = (
    <div onTransitionEnd={() => window.dispatchEvent(new Event('resize'))}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>{termPane}</div>
  )

  // 导航分两组（14 §4.4）：工作区 = 干活的地方，工具 = 看别的东西的地方。
  // 设置 / 关于 不在任何一组里——它们进底部账户菜单，见下面的 accountMenu。
  const navGroups = [
    { label: t('nav.groupWorkspace'), items: NAV_WORKSPACE },
    { label: t('nav.groupTools'), items: NAV_TOOLS },
  ].map((g) => ({
    label: g.label,
    items: g.items.map((key) => {
      const n = NAV.find((x) => x.key === key)!
      return {
        key: n.key, label: t(n.labelKey), icon: ICONS[n.key],
        // badge 只报「需要行动」的数量，不报普通总数（14 §4.4）。这里取跨项目待收尾
        // 数：它来自 /projects 一条请求，全局常新；「等待输入」要逐会话抓屏才知道，
        // 为一个角标常驻轮询十几个会话不划算，那个数留在概览页。
        badge: n.key === 'projects' ? unfinished : undefined,
        badgeTitle: n.key === 'projects' ? t('overview.unfinishedN', { count: unfinished }) : undefined,
      }
    }),
  }))

  const accountMenu: MenuProps['items'] = [
    { key: 'settings', icon: ICONS.settings, label: t('nav.env'), onClick: () => go('settings') },
    { key: 'about', icon: ICONS.github, label: t('nav.about'), onClick: () => go('about') },
    { type: 'divider' },
    { key: 'theme', icon: themeIcon, label: mode === 'dark' ? t('common.lightTheme') : t('common.darkTheme'), onClick: () => toggleTheme() },
    ...(fsSupported ? [{ key: 'fs', icon: fsIcon, label: isFs ? t('common.exitFullscreen') : t('common.fullscreen'), onClick: () => toggleFs() }] : []),
    { type: 'divider' },
    {
      key: 'logout', danger: true, label: t('common.logout'),
      icon: svg(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>),
      onClick: () => Modal.confirm({
        title: t('common.logoutConfirm'), okText: t('common.logout'), cancelText: t('common.cancel'),
        okButtonProps: { danger: true }, onOk: logout,
      }),
    },
  ]

  // 侧栏是否是 64px 轨：用户手动收起 / Focus 聚焦 / 非 large 档（expanded 一律用轨）
  const navRail = space.navCollapsed || space.mode === 'focus'

  return (
    <Layout style={{ height: '100dvh', overflow: 'hidden', background: 'var(--bg-base)' }}>
      <UpdateBanner />
      {/* Focus 时导航收成 64px 轨而不是消失——上下文始终可找回（14 §4.1，老 dockMax 的病根）。
          expanded 档也一律用轨：905–1279 展开 224 侧栏会把 Canvas 挤破契约。*/}
      {hasSider && (
        <Sider collapsible trigger={null} collapsedWidth={NAV_RAIL} width={NAV_WIDTH} theme={mode}
          collapsed={navRail}
          style={{ position: 'sticky', top: 0, height: '100dvh', background: 'var(--bg-base)', borderRight: '1px solid var(--border-subtle)' }}>
          <Navigation
            rail={navRail} active={tab} groups={navGroups} onGo={go}
            linkStatus={<LinkStatus collapsed={navRail} />}
            dock={terms.length > 0 ? {
              count: terms.length, open: space.dockVisible,
              onToggle: () => { space.setFocus('none'); space.toggleDock() },
              title: `${space.dockVisible ? t('terminal.collapseRightTitle') : t('terminal.expandTitle')} (${modKeyLabel}J)`,
            } : null}
            accountName={t('nav.thisDevice')}
            account={accountMenu}
            onToggleRail={() => space.setNavCollapsed(!space.navCollapsed)}
          />
        </Sider>
      )}

      {/* 主区：Command Center ｜ (Canvas ｜ 8px 分隔条 ｜ Dock)。
          顶栏横跨页面与终端，位置不因 Dock 开合跳动；终端**常驻挂载**
          （收起时宽度归零、Focus 时页面归零），换形态不断连接。*/}
      <Layout style={{ background: 'var(--bg-base)', minWidth: 0 }}>
        {hasSider && (
          <WorkspaceTopbar
            online={online} modKey={modKeyLabel}
            dockCount={terms.length} dockOpen={space.dockVisible}
            onToggleDock={() => { space.setFocus('none'); space.toggleDock() }}
            // 切到项目页并留下「要新建」的意图，由那一页挂载后消费（见 intents.ts）。
            // 从任何页面点「＋ 新建」都是同一条路径，不必在每页各摆一枚按钮。
            onCreate={() => { go('projects'); requestIntent('new-project') }}
          />
        )}
        {hasSider && terms.length > 0 ? (
          // 四态（page / split / overlay / focus）都走同一个 Workspace：换的是几何，
          // 不是组件树，终端因此不会在开合时被卸载重建。
          <Workspace
            mode={space.mode} canvas={canvasNode} dock={dockNode}
            dockWidth={space.dockRenderWidth} bounds={space.bounds} splitMax={space.splitMax}
            onResize={space.setDockWidth} onReset={space.resetDockWidth}
            onFocus={() => space.setFocus('dock')}
            onDismiss={() => space.setDockOpen(false)}
            inspectorWidth={space.inspectorWidth} inspectorBounds={space.inspectorBounds}
            inspectorOverlay={!space.splitCapable} canvasFitsInspector={space.canvasFitsInspector}
            onInspectorResize={space.setInspectorWidth} onInspectorReset={space.resetInspectorWidth}
            capsule={space.overlayCapable && space.mode === 'page' ? (
              // 胶囊只有 320px，显示 sessionLabel 而不是 sessionDisplay——后者带
              // 「（会话 id）」后缀，在这个宽度下正好被截在 id 中间，什么也没说清。
              // 完整名留给 title。（前缀成 `项目 · 会话` 是 14 §7 的统一命名，
              // 要连 Dock 标签和切换 sheet 一起改，不在这里单独做半套。）
              <SessionCapsule
                label={sessionLabel(active) || active} count={terms.length}
                onOpen={() => { space.setFocus('none'); space.setDockOpen(true) }}
                title={`${sessionDisplay(active)} · ${t('terminal.expandTitle')} (${modKeyLabel}J)`}
              />
            ) : null}
          />
        ) : (
          // 没有终端时不走 Workspace（不必为空 Dock 撑一套几何），但 Inspector 这一列
          // 两边都要有——Git 面板在项目页也开得出来。
          <div style={{ position: 'relative', display: 'flex', flex: 1, minHeight: 0 }}>
            {canvasNode}
            {hasSider && (
              <InspectorColumn width={space.inspectorWidth} bounds={space.inspectorBounds}
                overlay={!space.splitCapable} onResize={space.setInspectorWidth}
                onReset={space.resetInspectorWidth} />
            )}
          </div>
        )}
      </Layout>

      {/* 底栏 4 格 + 会话坞（13 §4.1/§4.2）：浏览器/手机镜像这类"用手机看手机"的低频页
          进「更多」sheet，不占底栏。sheet 内部分「工具 / 账户」两段——退出登录和浏览器
          并排时误触代价差了几个数量级，所以它收在账户行的二级里。*/}
      {isMobile && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          zIndex: 'var(--z-nav)' as unknown as number, paddingBottom: 'var(--safe-b)',
          background: 'var(--bg-container)', borderTop: '1px solid var(--border)',
        }}>
        {/* 会话坞叠在底栏之上，两者共用同一个 fixed 容器与安全区内边距——
            分开两个 fixed 就得手算彼此的高度，底栏一改高度就错位 */}
        <SessionDock
          sessions={terms} active={active} needsInput={mobileWaiting}
          running={(n) => !!(claudeMap[n]?.running || codexMap[n]?.running)}
          onOpen={() => setOverlay(true)}
          onPick={(n) => { setActive(n); setOverlay(true) }}
          onClose={closeTerm}
        />
        <nav style={{ display: 'flex' }}>
          {MOBILE_NAV_KEYS.map((key) => {
            const n = NAV.find((x) => x.key === key)!
            return (
              <button key={n.key} onClick={() => go(n.key)}
                style={{ flex: 1, minHeight: 'var(--tap)', border: 0, background: 'none', color: tab === n.key ? 'var(--accent)' : 'var(--text-dim)', padding: '8px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, fontSize: 11 }}>
                {ICONS[n.key]}{t(n.labelKey)}
              </button>
            )
          })}
          <button onClick={() => setMoreOpen(true)}
            style={{ flex: 1, minHeight: 'var(--tap)', border: 0, background: 'none', color: MOBILE_MORE_KEYS.includes(tab) ? 'var(--accent)' : 'var(--text-dim)', padding: '8px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, fontSize: 11 }}>
            {svg(<><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>)}{t('common.more')}
          </button>
        </nav>
        </div>
      )}

      {isMobile && (
        <MobileSheet open={moreOpen} title={t('common.more')} onClose={() => setMoreOpen(false)}>
          {/* 手机没有顶栏，⌘K 也按不出来——全局搜索在这里给一个入口，否则手机上
              根本到不了它（同一个面板，见 shell/palette）。 */}
          <SheetRow icon={<SearchIcon size={16} />} title={t('workspace.search')}
            desc={t('workspace.searchPlaceholder')}
            onClick={() => { setMoreOpen(false); openPalette() }} />
          <SheetSection>{t('nav.groupWorkspace')}</SheetSection>
          {MOBILE_MORE_WORKSPACE.map((key) => {
            const n = NAV.find((x) => x.key === key)!
            return <SheetRow key={n.key} icon={ICONS[n.key]} title={t(n.labelKey)}
              onClick={() => { setMoreOpen(false); go(n.key) }} />
          })}
          <SheetSection>{t('nav.groupTools')}</SheetSection>
          {MOBILE_MORE_TOOLS.map((key) => {
            const n = NAV.find((x) => x.key === key)!
            return <SheetRow key={n.key} icon={ICONS[n.key]} title={t(n.labelKey)}
              onClick={() => { setMoreOpen(false); go(n.key) }} />
          })}
          <SheetSection>{t('mobile.groupAccount')}</SheetSection>
          <SheetRow icon={themeIcon} title={mode === 'dark' ? t('common.lightTheme') : t('common.darkTheme')}
            onClick={() => { toggleTheme() }} />
          {fsSupported && (
            <SheetRow icon={fsIcon} title={isFs ? t('common.exitFullscreen') : t('common.fullscreen')}
              onClick={() => { toggleFs() }} />
          )}
          <SheetRow icon={ICONS.github} title={t('nav.about')} onClick={() => { setMoreOpen(false); go('about') }} />
          <SheetRow
            icon={svg(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>)}
            title={t('common.logout')} desc={t('common.logoutConfirm')} danger
            onClick={() => { setMoreOpen(false); Modal.confirm({ title: t('common.logoutConfirm'), okText: t('common.logout'), cancelText: t('common.cancel'), okButtonProps: { danger: true }, onOk: logout }) }} />
        </MobileSheet>
      )}

      {/* 全局搜索挂在这里而不是顶栏里：手机没有顶栏、终端聚焦时 xterm 会吃掉按键，
          都得靠这一处（见 shell/palette/GlobalSearch）。入口另给：顶栏那枚框、
          手机「更多」里那一行、以及 ⌘K / Ctrl+K。 */}
      <GlobalSearch items={paletteItems} actions={paletteActions} dir={sessionProject(active)?.dir} />

      {/* 手机/平板：全屏会话覆盖层（桌面用右侧停靠栏，不走这里）*/}
      {isMobile && overlay && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-session)' as unknown as number, background: 'var(--bg-term)', display: 'flex', flexDirection: 'column' }}>
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
  const label = useSessionLabel(name)

  // 独立页没有会话列表轮询，自己拉一次拿展示名（标题要显示「名字（id）」）
  useEffect(() => {
    api('GET', '/sessions').then((list) => {
      setSessionLabels(Object.fromEntries((Array.isArray(list) ? list : []).filter((s: any) => s?.name && s?.label).map((s: any) => [s.name, s.label])))
    }).catch(() => {})
  }, [])
  useEffect(() => { document.title = `Roam · ${sessionDisplay(name) || name}` }, [name, label])
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

  // 独立页也要能搜（⌘K）。这页没有侧栏也没有顶栏，本地条目就只有「当前这个会话」；
  // 结果照样从后端来。打开方式换成同一个标签内换 hash——独立页本身就是同一个 SPA，
  // 所以「打开文件」的意图（intents）也照常能被文件页接住。
  const paletteActions: PaletteActions = {
    openRoute: (hash: string) => { location.hash = hash },
    openSession: (n: string) => { location.hash = '#/term/' + encodeURIComponent(n) },
    openFile: (path: string) => { location.hash = '#/files'; requestIntent(OPEN_FILE_INTENT, { path }) },
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg-term)', display: 'flex', flexDirection: 'column' }}>
      <GlobalSearch items={[]} actions={paletteActions} />
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

// ── 会话导航栏（标签条 + 工具条）的图标与控件 ──
// 与左侧主导航同一套线性语言：24 viewBox、currentColor 描边、无 emoji（emoji 各平台字形不一，
// 在深色栏里显得廉价且无法跟随强调色）。样式在 index.css 的 .tt-tabs / .tt-tbar 段。
const tIcon = (paths: any, size = 15) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{paths}</svg>
)
const TI = {
  collapse: tIcon(<><path d="M20 4.5v15" /><path d="M4.5 12h10" /><path d="m10 7 5 5-5 5" /></>),
  close: tIcon(<><path d="m7 7 10 10" /><path d="M17 7 7 17" /></>, 12),
  tmux: tIcon(<><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="m7.5 10 2.5 2-2.5 2" /><path d="M13 14.5h3.5" /></>),
  newTab: tIcon(<><path d="M13.5 4h6.5v6.5" /><path d="M20 4 12 12" /><path d="M18.5 14.5V18a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 18V8A2.5 2.5 0 0 1 6 5.5h3.5" /></>),
  rename: tIcon(<><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" /><path d="m14.5 6.5 3 3" /></>),
  bellOn: tIcon(<><path d="M18 9.5a6 6 0 1 0-12 0c0 4.5-2 6-2 6h16s-2-1.5-2-6" /><path d="M10.2 19.5a2.2 2.2 0 0 0 3.6 0" /></>),
  bellOff: tIcon(<><path d="M18 9.5a6 6 0 0 0-9.1-5.1" /><path d="M6 9.5c0 4.5-2 6-2 6h12.5" /><path d="M10.2 19.5a2.2 2.2 0 0 0 3.6 0" /><path d="m3.5 3.5 17 17" /></>),
  folder: tIcon(<><path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>),
  git: tIcon(<><circle cx="6" cy="6" r="2.3" /><circle cx="6" cy="18" r="2.3" /><circle cx="18" cy="8" r="2.3" /><path d="M6 8.3v7.4" /><path d="M18 10.3a6 6 0 0 1-6 6H8.3" /></>),
  mic: tIcon(<><rect x="9.2" y="3" width="5.6" height="11" rx="2.8" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" /><path d="M12 18v3" /></>),
  scrollUp: tIcon(<><path d="M4.5 4.5h15" /><path d="M12 20V9" /><path d="m7.5 13.5 4.5-4.5 4.5 4.5" /></>),
  toBottom: tIcon(<><path d="M4.5 19.5h15" /><path d="M12 4v11" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /></>),
  // Focus = 四角向外扩，返回分栏 = 四角向内收
  focus: tIcon(<><path d="M4 9V4h5" /><path d="M20 9V4h-5" /><path d="M4 15v5h5" /><path d="M20 15v5h-5" /></>),
  unfocus: tIcon(<><path d="M9 4v5H4" /><path d="M15 4v5h5" /><path d="M9 20v-5H4" /><path d="M15 20v-5h5" /></>),
  dpad: tIcon(<><polyline points="12 5 12 19" /><polyline points="5 12 19 12" /></>),
  back: tIcon(<><line x1="20" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></>),
  caret: tIcon(<polyline points="6 9 12 15 18 9" />),
  dots: tIcon(<><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>),
  redraw: tIcon(<><path d="M20 12a8 8 0 1 1-2.6-5.9" /><path d="M20.5 4v5h-5" /></>),
  reconnect: tIcon(<><path d="M10.4 13.6a4.2 4.2 0 0 0 6 0l2.4-2.4a4.2 4.2 0 0 0-6-6l-1.4 1.4" /><path d="M13.6 10.4a4.2 4.2 0 0 0-6 0l-2.4 2.4a4.2 4.2 0 0 0 6 6l1.4-1.4" /></>),
}
// Claude / Codex 的会话标记：原来用 ✳ ✸ 两个字符，字重与基线都对不齐；改成同尺寸的品牌感 mark。
function AgentMark({ kind, size = 13 }: { kind: 'claude' | 'codex'; size?: number }) {
  return kind === 'claude'
    ? (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" aria-hidden>
        <path d="M12 3.2v17.6" /><path d="m4.4 7.6 15.2 8.8" /><path d="M19.6 7.6 4.4 16.4" />
      </svg>
    )
    : (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" aria-hidden>
        <circle cx="12" cy="12" r="7.6" /><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
      </svg>
    )
}
// 工具条按钮：默认安静（无框），开启态才由 tone 上强调色（会话蓝 / Codex 绿）。
// tone 是 6 位十六进制，追加 alpha 后缀直接拿来做底色/描边，避免 color-mix 的兼容性问题。
function TBtn({ icon, label, on, tone = 'var(--accent)', title, onClick, onMouseDown }: {
  icon?: ReactNode; label?: ReactNode; on?: boolean; tone?: string; title?: ReactNode
  onClick?: () => void; onMouseDown?: (e: React.MouseEvent) => void
}) {
  const btn = (
    <button type="button" className={`tt-tbtn${on ? ' on' : ''}${label ? '' : ' tt-ico'}`}
      onClick={onClick} onMouseDown={onMouseDown}
      style={on ? { color: tone, background: `${tone}1f`, borderColor: `${tone}59` } : undefined}>
      {icon}{label != null && <span>{label}</span>}
    </button>
  )
  return title ? <Tooltip title={title} mouseEnterDelay={0.35}>{btn}</Tooltip> : btn
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
  /** 标签拖拽排序；不传就不可拖（独立单终端页没有多标签） */
  onReorder?: (name: string, to: number) => void
  /** 把「哪些会话在等输入」递给外层（手机会话坞要用），避免第二份抓屏轮询 */
  onNeedsInput?: (map: Record<string, boolean>) => void
  /** 终端 Focus：传了才渲染工具条右侧那枚按钮（手机没有这个概念） */
  focus?: { on: boolean; toggle: () => void; hint: string }
  fileDock?: 'right' | 'left'   // 文件面板停靠：'right'=右侧浮动抽屉（默认），'left'=左侧 VSCode 栏（新标签全屏页）
}) {
  const { terms, active, setActive, closeTerm, fontSize, setFontSize, statusMap, setStatus, termRefs, sendKey, onCollapse, claudeMap, claudeView, setClaudeView, codexMap, codexView, setCodexView, onRename, onReorder, onNeedsInput, focus } = props
  const fileDock = props.fileDock || 'right'
  const { message, modal } = AntApp.useApp()
  const { t } = useI18n()
  const st = active ? statusMap[active] : undefined
  const [termNeedsInput, setTermNeedsInput] = useState<Record<string, boolean>>({})
  const promptSignals = useRef<Record<string, PromptSignal>>({})
  // 危险操作目标可视化 / 就地确认：关闭 pane 前先定位目标（几何+cwd+前台进程），
  // confirm 走结构化后端接口，不再盲发 Ctrl-b x 字节（那样只会撞上 tmux 底部原生 y/n 提示）。
  const [paneCloseTarget, setPaneCloseTarget] = useState<PaneCloseTarget | null>(null)
  const [paneCloseBusy, setPaneCloseBusy] = useState(false)
  const [paneCloseError, setPaneCloseError] = useState<string>()
  const openPaneCloseConfirm = async () => {
    if (!active) return
    try {
      const r = await api('GET', `/sessions/${encodeURIComponent(active)}/panes/active`)
      const p = r.data
      const rect = termRefs.current[active]?.paneScreenRect(p)
      if (!rect) { message.error(t('pane.close.locateFailed')); return }
      setPaneCloseError(undefined)
      setPaneCloseTarget({ session: active, paneId: p.paneId, cwd: p.cwd, cmd: p.cmd, panesInWindow: p.panesInWindow, rect })
    } catch {
      message.error(t('pane.close.locateFailed'))
    }
  }
  const confirmPaneClose = async () => {
    if (!paneCloseTarget) return
    setPaneCloseBusy(true)
    try {
      await api('POST', `/sessions/${encodeURIComponent(paneCloseTarget.session)}/panes/${encodeURIComponent(paneCloseTarget.paneId)}/close`, {})
      setPaneCloseTarget(null)
    } catch (e: any) {
      setPaneCloseError(e?.message || t('pane.close.failed'))
    } finally {
      setPaneCloseBusy(false)
    }
  }
  const activeNeedsInput = !!(active && termNeedsInput[active])
  const dot = activeNeedsInput ? 'var(--warn)' : st === 'connected' ? 'var(--ok)' : st === 'connecting' ? 'var(--warn)' : 'var(--danger)'
  // 灵动岛的「活着」判据：有 Agent 在跑。会话只是连着（st==='connected'）不算——
  // 那是个静态事实，让点一直呼吸等于把呼吸这个信号用废了。
  const activeAgentLive = !!(active && (claudeMap[active]?.running || codexMap[active]?.running))
  // 当前标签是否在 Claude/Codex 对话视图：此时聊天 UI 自带输入框，
  // 终端那条移动输入条 + 快捷键栏要隐藏，否则手机上会出现两个输入框。
  const inChat = !!active && ((claudeView[active] && claudeMap[active]?.running) || (codexView[active] && codexMap[active]?.running))

  // 移动端可靠输入：xterm 隐藏 textarea 在软键盘/输入法「合成/预测词」下会把字留在
  // 合成缓冲里不提交，onData 不触发 → 打完字发不出去。触摸设备改用独立输入框：整行送 PTY。
  const { coarse: isTouch } = useLayout()
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
  // 文件栏与 Git 面板可并存：左侧停靠时文件走左栏、Git 走右抽屉，天然并列；
  // 右侧停靠时两者都是右抽屉，Git 抽屉在文件也开着时向左让位（见下方 right 偏移），并排显示而非互相覆盖。
  const toggleFiles = () => setShowFiles((s) => !s)
  const toggleGit = () => setShowGit((s) => !s)
  // 对话页里点工具行的文件路径 → 在文件面板打开（带行号就跳到那一行）。
  // 左侧停靠时 <FileWorkspace> 已挂载在同一页，直接发意图即可开成对话旁边的标签页；
  // 否则先切到文件页再发，跟 ⌘K 搜索结果打开文件是同一条路（见 intents.ts）。
  // 手机上不给：文件面板是全屏二级页，从对话里跳过去会丢上下文且回不到原滚动位置，
  // 所以窄屏干脆不传 onOpenFile，路径退化成普通文字（见 15 设计 §9）。
  const openFileFromChat = (path: string, line?: number) => {
    if (fileDock !== 'left') location.hash = '#/files'
    // side：开到右栏，别把左栏正在看的对话顶掉（FileWorkspace 只在 A 栏有首 tab 时才照办）
    requestIntent(OPEN_FILE_INTENT, { path, line, side: fileDock === 'left' })
  }

  // 标签条是单行横向滑动（见 index.css .tt-tabs）：窄栏/手机上会话一多，当前标签会滑出视口，
  // 切换后把它带回可视区（block:'nearest' → 只横向滚标签条，不牵动整页）。
  const activeTabRef = useRef<HTMLSpanElement | null>(null)
  useEffect(() => { activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [active])

  // 标签溢出时两侧给渐隐，提示"这边还有"（14 §7.1）。滚动条本身是隐藏的，
  // 没有这个提示，窄栏下多出来的标签等于不存在。
  const tabScrollRef = useRef<HTMLDivElement | null>(null)
  const [fadeL, setFadeL] = useState(false)
  const [fadeR, setFadeR] = useState(false)
  const syncFade = useCallback(() => {
    const el = tabScrollRef.current
    if (!el) return
    setFadeL(el.scrollLeft > 2)
    setFadeR(el.scrollLeft + el.clientWidth < el.scrollWidth - 2)
  }, [])
  useEffect(() => {
    syncFade()
    const el = tabScrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(syncFade)
    ro.observe(el)
    return () => ro.disconnect()
  }, [syncFade, terms.length])

  // 标签拖拽排序（14 §7.1）：dragTab / dropAt 只用来画反馈（半透明 + 插入线），
  // 落点判定全部走事件本身，见下面两个 helper。
  const { phone: isPhone } = useLayout()
  const ws = prefsData.workspace
  const [typing, setTyping] = useState(false)
  // 快捷键条的两侧渐隐：和标签条同一套做法（溢出时才提示"这边还有"）
  const keyRowRef = useRef<HTMLDivElement>(null)
  const [keyFadeL, setKeyFadeL] = useState(false)
  const [keyFadeR, setKeyFadeR] = useState(false)
  const syncKeyFade = useCallback(() => {
    const el = keyRowRef.current
    if (!el) return
    setKeyFadeL(el.scrollLeft > 2)
    setKeyFadeR(el.scrollLeft + el.clientWidth < el.scrollWidth - 2)
  }, [])
  const [switchOpen, setSwitchOpen] = useState(false)
  const [moreSheet, setMoreSheet] = useState(false)
  const [dragTab, setDragTab] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  // 自定义 MIME：文件区/终端的拖放判定按 type 分流，共用 text/plain 会被它们当路径接走
  const isTabDrag = (e: React.DragEvent) => e.dataTransfer.types.includes('application/x-tt-tab')
  /** 落在标签右半边 = 插到它后面 */
  const dropIndexAt = (e: React.DragEvent, i: number) => {
    const b = e.currentTarget.getBoundingClientRect()
    return e.clientX > b.left + b.width / 2 ? i + 1 : i
  }

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
  // 系统文件拖入（非内部路径拖拽）：types 含 'Files'。不接住的话浏览器会把文件当新标签打开。
  const isFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes('Files')
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
  // 从系统拖入真实文件：上传后把绝对路径以 @ 注入当前会话（等同 Ctrl+V 粘图）。
  // 图片走 /tmp（不污染工作目录），其余文件走会话工作目录。
  const onTermFileDrop = async (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files || [])
    if (!files.length || !active) return
    const imgs = files.filter((f) => f.type.startsWith('image/'))
    const rest = files.filter((f) => !f.type.startsWith('image/'))
    const saved: string[] = []
    try {
      if (imgs.length) saved.push(...(await upload('/tmp', imgs)).saved)
      if (rest.length) {
        if (!cwd) { message.error(t('chat.cwdMissing')) }
        else saved.push(...(await upload(cwd, rest)).saved)
      }
    } catch (err: any) { message.error(t('terminal.imageUploadFailed', { message: err.message })); return }
    if (!saved.length) return
    exitCopyMode()
    termRefs.current[active]?.send(saved.map((p) => '@' + p).join(' ') + ' ', true)
  }
  // 拖到终端区：直接把 @路径 送进当前会话（claude/codex TUI 或 shell 提示符的光标处）。
  const onTermDrop = (e: React.DragEvent) => {
    if (isFileDrag(e) && e.dataTransfer.files?.length) { // 系统文件：上传并注入（无视左右半区，不做分栏）
      e.preventDefault(); e.stopPropagation(); setDragOver(false)
      onTermFileDrop(e)
      return
    }
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
    if (!terms.length) {
      promptSignals.current = {}
      setTermNeedsInput((previous) => Object.keys(previous).length ? {} : previous)
      return
    }
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
      if (stop) return
      const nextSignals: Record<string, PromptSignal> = {}
      const nextState: Record<string, boolean> = {}
      entries.forEach(([name, candidate]) => {
        const signal = advancePromptSignal(promptSignals.current[name], candidate)
        nextSignals[name] = signal
        nextState[name] = signal.stable
      })
      promptSignals.current = nextSignals
      // 未发生语义变化时复用旧对象，避免后台抓屏每 4 秒让整个终端区无意义重渲染。
      setTermNeedsInput((previous) => {
        const keys = Object.keys(nextState)
        const unchanged = keys.length === Object.keys(previous).length && keys.every((name) => previous[name] === nextState[name])
        return unchanged ? previous : nextState
      })
    }
    checkPrompts()
    const t = setInterval(checkPrompts, 4000)
    return () => { stop = true; clearInterval(t) }
  }, [terms])

  useEffect(() => { onNeedsInput?.(termNeedsInput) }, [termNeedsInput, onNeedsInput])

  useEffect(() => {
    syncKeyFade()
    const el = keyRowRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(syncKeyFade)
    ro.observe(el)
    return () => ro.disconnect()
  }, [syncKeyFade, typing, inChat])

  // 软键盘开合会改可视高度，但 xterm 不会自己重算行数——不重新 fit 就会出现
  // 「PTY 以为还有 25 行、实际只画得下 7 行」的错位，表现为花屏。等一帧让布局落定再量。
  const kb = useLayout().keyboard
  useEffect(() => {
    if (!active) return
    const id = requestAnimationFrame(() => termRefs.current[active]?.fit())
    return () => cancelAnimationFrame(id)
  }, [kb, active, typing])

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
                // 同一张图多种 MIME 只取一张，避免重复上传出现两次 @路径
                if (!imageFiles.length) { const blob = await item.getType(type); imageFiles.push(new File([blob], 'image', { type })) }
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
    { key: 'redraw', label: t('terminal.redraw') },
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
    else if (key === 'redraw') h?.redraw()
    else if (key === 'reconnect') h?.reconnect()
    else h?.send(key)
    setCtx(null)
  }
  if (terms.length === 0) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-dim)' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--text-dimmer)' }}><TerminalIcon size={40} /></div>
          <div>{t('terminal.openHint', { terminal: t('common.terminal') })}</div>
        </div>
      </div>
    )
  }

  // ── 会话（终端）各部件抽成局部 JSX：左侧停靠走 <FileWorkspace> 的槽位，右侧抽屉走原地布局，二者共用同一份 ──
  // 标签条是单行横向滑动：窄栏/手机上开的会话一多，当前标签就滑出视口了 → 切换后把它带回来。
  // 会话状态点：等待确认=琥珀，已连接=绿，连接中=琥珀，断开=红（与列表页同一套色）
  const dotOf = (name: string) => termNeedsInput[name] ? 'var(--warn)'
    : statusMap[name] === 'connected' ? 'var(--ok)' : statusMap[name] === 'connecting' ? 'var(--warn)' : 'var(--danger)'
  const statusDot = (color: string, size = 7) => (
    <i style={{ width: size, height: size, borderRadius: '50%', flex: `0 0 ${size}px`, background: color, boxShadow: `0 0 0 3px ${color}26` }} />
  )
  // 标签内的会话标记：Claude 蓝 / Codex 绿，跟状态点同一行且同一光学尺寸
  const agentMarks = (name: string) => (
    <>
      {claudeMap[name]?.running && <span title={t('session.runningClaude')} style={{ display: 'inline-flex', color: 'var(--accent)' }}><AgentMark kind="claude" /></span>}
      {codexMap[name]?.running && <span title={t('session.runningCodex')} style={{ display: 'inline-flex', color: 'var(--ok)' }}><AgentMark kind="codex" /></span>}
    </>
  )
  const sessionTab = (
    <>
      {statusDot(active ? dotOf(active) : '#f85149')}
      {active && agentMarks(active)}
      {active && <SessionTitle name={active} />}
    </>
  )
  // 标签条：左侧「收起」固定不滚，标签区独立横滚（14 §7.1）。
  // 收起按钮原来跟着标签一起滚，会话一多它就滑出视口——那是常驻动作，不该跟着内容跑。
  const tabStrip = (
    <div className="tt-tabs-wrap">
      {onCollapse && (
        <div className="tt-tabs-lead">
          <TBtn icon={TI.collapse} label={t('common.collapse')} onClick={onCollapse} />
          <span className="tt-sep" />
        </div>
      )}
      <div className="tt-tabs" ref={tabScrollRef} data-l={fadeL ? '1' : undefined} data-r={fadeR ? '1' : undefined}
        onScroll={syncFade}
        // 竖滚轮横移：标签条只有一行，鼠标滚轮在它上面本来什么也不做
        onWheel={(e) => {
          const el = tabScrollRef.current
          if (!el || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
          el.scrollLeft += e.deltaY
        }}>
        {terms.map((termName, i) => {
          const on = termName === active
          const waiting = termNeedsInput[termName]
          const proj = sessionProject(termName)
          // 分支进 Tooltip，不占标签宽度（14 §6.3.2）
          const tip = [proj && proj.name, sessionDisplay(termName), proj?.branch]
            .filter(Boolean).join(' · ')
          const tab = (
            <span key={termName} ref={on ? activeTabRef : undefined}
              className={`tt-tab${on ? ' on' : ''}${dragTab === termName ? ' dragging' : ''}${dropAt === i ? ' dropL' : ''}`}
              title={tip} onClick={() => setActive(termName)}
              draggable={!!onReorder}
              onDragStart={(e) => {
                // 自定义 MIME：文件区/终端的拖放判定按 type 分流，用通用 text/plain
                // 会被它们当成路径拖拽接走（见 isPathDrag）
                e.dataTransfer.setData('application/x-tt-tab', String(i))
                e.dataTransfer.effectAllowed = 'move'
                setDragTab(termName)
              }}
              onDragOver={(e) => {
                if (!isTabDrag(e)) return
                e.preventDefault(); e.stopPropagation()
                e.dataTransfer.dropEffect = 'move'
                setDropAt(dropIndexAt(e, i))
              }}
              onDrop={(e) => {
                if (!isTabDrag(e)) return
                e.preventDefault(); e.stopPropagation()
                // 源标签从 dataTransfer 读，不从 dragTab 状态读：状态只用来画拖拽反馈，
                // 落点判定必须只依赖事件本身，否则 setState 还没刷新时这一拖就静默丢了
                const from = Number(e.dataTransfer.getData('application/x-tt-tab'))
                const name = terms[from]
                if (name) onReorder?.(name, dropIndexAt(e, i))
                setDragTab(null); setDropAt(null)
              }}
              onDragEnd={() => { setDragTab(null); setDropAt(null) }}>
              {statusDot(dotOf(termName))}
              {waiting && <span className="tt-wait" title={t('prompt.confirmRequired')}>{t('session.waiting')}</span>}
              {agentMarks(termName)}
              <TabName name={termName} />
              <a className="tt-x" title={t('common.close')} onClick={(e) => { e.stopPropagation(); closeTerm(termName) }}>{TI.close}</a>
            </span>
          )
          // 右键菜单：标签是跨页常驻的，「这个会话是哪来的」得有个地方能问（14 §6.3.4）
          return (
            <Dropdown key={termName} trigger={['contextMenu']} menu={{ items: [
              ...(proj ? [{ key: 'proj', label: t('terminal.openOwnerProject', { name: proj.name }),
                onClick: () => { location.hash = '#/projects/' + encodeURIComponent(proj.key) } }] : []),
              { key: 'newtab', label: t('terminal.openInNewTabTitle'),
                onClick: () => window.open(`/#/term/${encodeURIComponent(termName)}`, '_blank') },
              { type: 'divider' as const },
              { key: 'close', danger: true, label: t('common.close'), onClick: () => closeTerm(termName) },
            ] }}>{tab}</Dropdown>
          )
        })}
        {/* 拖到最右侧：最后一个标签的右半边已经给出 i+1，这里只补"空白区也能落" */}
        {dragTab && (
          <span className="tt-tab-tail"
            onDragOver={(e) => { if (!isTabDrag(e)) return; e.preventDefault(); setDropAt(terms.length) }}
            onDrop={(e) => {
              if (!isTabDrag(e)) return
              e.preventDefault()
              const name = terms[Number(e.dataTransfer.getData('application/x-tt-tab'))]
              if (name) onReorder?.(name, terms.length)
              setDragTab(null); setDropAt(null)
            }} />
        )}
      </div>
    </div>
  )
  // ── 手机会话页顶栏（13 §5.1）：一行 50，取代「标签条 + 工具条」两行 79 ──
  // 中间胶囊点开 = 会话切换 sheet（取代横滑标签条）；除 Agent 视图切换外，其余控件全进「⋯」。
  // **不能按 !inChat 收窄**：切到 Claude/Codex 对话视图后 phoneChrome 变 null，
  // 整块外壳就掉回桌面那套「标签条 + 工具条」——按一下渲染模式，页面样式全变了。
  // 对话只该换中间那块内容，顶栏（返回 / 会话胶囊 / Agent 切换 / 更多）自始至终是同一条。
  const phoneChrome = isPhone ? (
    <>
      <div className="tt-sesshead">
        <button type="button" className="ic" aria-label={t('common.collapse')} onClick={onCollapse}>
          {TI.back}
        </button>
        {/* 灵动岛：胶囊本身就是当前会话的状态显示器，不只是个「点我换会话」的按钮。
            名字吃掉所有余量、右侧那簇贴边——之前名字不 grow，一胶囊右半截是空的，
            看着像没画完。待确认时整颗岛变黄并浮出文字：那是唯一需要人立刻动手的状态，
            只把 8px 的点变黄在 50px 顶栏里根本注意不到。 */}
        <button type="button" className={`pill${activeNeedsInput ? ' wait' : ''}`} onClick={() => setSwitchOpen(true)}>
          <i className={`d${activeAgentLive && !activeNeedsInput ? ' live' : ''}`} style={{ background: dot }} />
          {active && <TabName name={active} project={false} />}
          {activeNeedsInput && <span className="tag">{t('session.waiting')}</span>}
          {terms.length > 1 && <span className="n">{terms.length}</span>}
          <span className="ca">{TI.caret}</span>
        </button>
        {active && claudeMap[active]?.running && (
          <button type="button" className={`ic${claudeView[active] ? ' on' : ''}`} aria-label="Claude"
            onClick={() => setClaudeView((v) => ({ ...v, [active!]: !v[active!] }))}>
            <AgentMark kind="claude" size={16} />
          </button>
        )}
        {active && codexMap[active]?.running && (
          <button type="button" className={`ic${codexView[active] ? ' on' : ''}`} aria-label="Codex"
            onClick={() => setCodexView((v) => ({ ...v, [active!]: !v[active!] }))}>
            <AgentMark kind="codex" size={16} />
          </button>
        )}
        <button type="button" className="ic" aria-label={t('common.more')} onClick={() => setMoreSheet(true)}>
          {TI.dots}
        </button>
      </div>
      <SessionSwitchSheet open={switchOpen} onClose={() => setSwitchOpen(false)}
        sessions={terms} active={active} needsInput={termNeedsInput}
        running={(n) => !!(claudeMap[n]?.running || codexMap[n]?.running)}
        onPick={setActive} onCloseSession={closeTerm} />
      <MobileSheet open={moreSheet} title={t('common.more')} onClose={() => setMoreSheet(false)}>
        <SheetSection>{t('mobile.groupSession')}</SheetSection>
        <SheetRow icon={TI.rename} title={t('session.rename')} onClick={() => { setMoreSheet(false); active && setRenameSession(active) }} />
        <SheetRow icon={TI.newTab} title={t('terminal.newTab')}
          onClick={() => { setMoreSheet(false); active && window.open(`/#/term/${encodeURIComponent(active)}`, '_blank') }} />
        <SheetSection>{t('mobile.groupPanels')}</SheetSection>
        <SheetRow icon={TI.folder} title={t('chat.files')} onClick={() => { setMoreSheet(false); toggleFiles() }} />
        <SheetRow icon={TI.git} title={t('git.title')} onClick={() => { setMoreSheet(false); toggleGit() }} />
        <SheetRow icon={TI.mic} title={t('voice.input')} onClick={() => { setMoreSheet(false); setShowVoice((v) => !v) }} />
        <SheetRow icon={promptOff ? TI.bellOff : TI.bellOn} title={t('prompt.popup')}
          desc={promptOff ? t('prompt.popupOff') : t('prompt.popupOn')} onClick={togglePromptOff} />
        <SheetRow icon={TI.dpad} title={t('mobile.dpadOn')} desc={ws.dpadOn ? t('common.on') : t('common.off')}
          onClick={() => saveWorkspace({ dpadOn: !ws.dpadOn })} />
        {ws.dpadOn && (
          <SheetRow icon={TI.dpad} title={t('mobile.dpadSide')} desc={ws.dpadSide === 'left' ? t('common.on') : t('common.off')}
            onClick={() => saveWorkspace({ dpadSide: ws.dpadSide === 'left' ? 'right' : 'left' })} />
        )}
        {/* 画面工具只对终端画布有意义：对话视图有自己的滚动与排版 */}
        {!inChat && <SheetSection>{t('mobile.groupScreen')}</SheetSection>}
        {!inChat && <div className="tt-sheet-grid">
          <button type="button" onClick={() => setFontSize(Math.max(10, fontSize - 1))}>A−</button>
          <button type="button" onClick={() => setFontSize(Math.min(22, fontSize + 1))}>A+</button>
          <button type="button" onClick={() => active && termRefs.current[active]?.scroll(-12)}>{TI.scrollUp}</button>
          <button type="button" onClick={() => active && termRefs.current[active]?.toBottom()}>{TI.toBottom}</button>
          <button type="button" onClick={() => active && termRefs.current[active]?.redraw()}>{TI.redraw}</button>
          <button type="button" onClick={() => active && termRefs.current[active]?.reconnect()}>{TI.reconnect}</button>
        </div>}
      </MobileSheet>
    </>
  ) : null

  // 工具条分三段：左=会话身份与动作，中=面板开关，右（分段组）=只读的画面控制
  const sessionToolbar = (
    <div className="tt-tbar tt-session-toolbar">
      <span className="tt-status">
        {statusDot(dot, 7)}
        {activeNeedsInput ? t('session.waiting') : st === 'connected' ? t('terminal.status.connected') : st === 'connecting' ? t('terminal.status.connecting') : t('terminal.status.disconnected')}
      </span>
      {active && claudeMap[active]?.running && (
        <TBtn icon={<AgentMark kind="claude" size={14} />} label="Claude" tone="var(--accent)" on={!!claudeView[active]}
          title={t('chat.switchToClaude')} onClick={() => setClaudeView((v) => ({ ...v, [active!]: !v[active!] }))} />
      )}
      {active && codexMap[active]?.running && (
        <TBtn icon={<AgentMark kind="codex" size={14} />} label="Codex" tone="var(--ok)" on={!!codexView[active]}
          title={t('chat.switchToCodex')} onClick={() => setCodexView((v) => ({ ...v, [active!]: !v[active!] }))} />
      )}
      <span className="tt-sep" />
      <Dropdown trigger={['click']} menu={{ items: tmuxMenu(t) as any, onClick: ({ key }) => { if (key === PFX + 'x') openPaneCloseConfirm(); else sendKey(key) } }} placement="bottomLeft">
        <button type="button" className="tt-tbtn">{TI.tmux}<span>tmux</span><span style={{ color: 'var(--text-dimmer)', display: 'inline-flex' }}><ChevronDown size={11} /></span></button>
      </Dropdown>
      {active && (
        <TBtn icon={TI.newTab} label={t('terminal.newTab')} title={t('terminal.openInNewTabTitle')}
          onClick={() => window.open(`/#/term/${encodeURIComponent(active)}`, '_blank')} />
      )}
      {active && <TBtn icon={TI.rename} label={t('session.rename')} title={t('session.renameTitle')} onClick={() => setRenameSession(active)} />}
      <span className="tt-sep" />
      <TBtn icon={promptOff ? TI.bellOff : TI.bellOn} label={t('prompt.popup')} on={!promptOff}
        title={promptOff ? t('prompt.popupOff') : t('prompt.popupOn')} onClick={togglePromptOff} />
      <TBtn icon={TI.folder} label={t('chat.files')} on={showFiles} title={t('terminal.fileBrowserTitle')} onClick={toggleFiles} />
      <TBtn icon={TI.git} label={t('git.title')} on={showGit} title={t('terminal.gitPanelTitle')} onClick={toggleGit} />
      <TBtn icon={TI.mic} label={t('voice.input')} on={showVoice} title={showVoice ? t('voice.hideButton') : t('voice.showButton')} onClick={() => setShowVoice((v) => !v)} />
      <span className="tt-spacer" />
      <span className="tt-tgroup">
        <TBtn icon={TI.scrollUp} title={t('terminal.scrollHistory')} onClick={() => active && termRefs.current[active]?.scroll(-12)} />
        <TBtn icon={TI.toBottom} title={t('terminal.toBottom')} onClick={() => active && termRefs.current[active]?.toBottom()} />
      </span>
      <span className="tt-tgroup" style={{ marginLeft: 6 }}>
        <TBtn label={<span style={{ fontWeight: 600 }}>A−</span>} title={t('terminal.decreaseFont')} onClick={() => setFontSize(Math.max(10, fontSize - 1))} />
        <TBtn label={<span style={{ fontWeight: 600 }}>A+</span>} title={t('terminal.increaseFont')} onClick={() => setFontSize(Math.min(22, fontSize + 1))} />
      </span>
      <span className="tt-tgroup" style={{ marginLeft: 6 }}>
        <TBtn icon={TI.redraw} title={t('terminal.redraw')} onClick={() => active && termRefs.current[active]?.redraw()} />
        <TBtn icon={TI.reconnect} title={t('terminal.reconnect')} onClick={() => active && termRefs.current[active]?.reconnect()} />
      </span>
      {/* Focus 与「返回分栏」是同一枚按钮的两态（14 §7.2）：不额外插一条只在
          Focus 时出现的横条——那种横条会让 Focus 前后的工具条高度跳一下。 */}
      {focus && (
        <TBtn icon={focus.on ? TI.unfocus : TI.focus} label={focus.on ? t('workspace.exitFocus') : t('workspace.focusDock')}
          on={focus.on} title={`${focus.on ? t('workspace.exitFocus') : t('workspace.focusDock')} (${focus.hint})`}
          onClick={focus.toggle} />
      )}
    </div>
  )
  // 方向簇（13 §5.3）：贴在终端画布上，不吃终端高度。
  //
  // **只在 TUI 里出现**——Claude/Codex 在跑的时候。它存在的全部理由是「在选项列表里选一项
  // 时不必弹软键盘」；普通 shell 下你本来就要打字，键盘总要弹，一个没有标签的十字浮在那儿
  // 只会让人问「这是干嘛的」（用户原话）。对话视图有自己的输入框，同样不挂。
  const agentRunning = !!(active && (claudeMap[active]?.running || codexMap[active]?.running))
  const dpad = isPhone && !inChat && agentRunning && ws.dpadOn ? (
    <>
      <DPad side={ws.dpadSide} onSend={(seq) => tapKey(seq)} onHide={() => saveWorkspace({ dpadOn: false })} />
      {/* 一次性说明：一个没有标签的十字自己解释不了自己 */}
      {!ws.dpadHintSeen && (
        <div className="tt-dpad-hint">
          <span className="tx">
            <b>{t('mobile.dpadHintTitle')}</b>
            {t('mobile.dpadHintBody')}
          </span>
          <button type="button" onClick={() => saveWorkspace({ dpadHintSeen: true })}>{t('mobile.dpadHintOk')}</button>
        </div>
      )}
    </>
  ) : null

  const terminalArea = (
    <div className={dpad ? 'tt-has-dpad' : undefined}
      style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}
      onDragOver={(e) => {
        if (isFileDrag(e)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; setDragOver(true); return } // 系统文件：允许放下并上传
        if (!isPathDrag(e)) return
        if (inTermSplitZone(e)) { setDragOver(false); return } // 右半区：让事件冒泡给 FileWorkspace 显示分栏提示
        e.stopPropagation(); allowPathDrop(e); setDragOver(true)
      }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false) }}
      onDrop={onTermDrop}>
      {dpad}
      {dragOver && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 5, pointerEvents: 'none',
          border: '2px dashed var(--accent)', borderRadius: 'var(--r-sm)', background: 'rgba(88,166,255,.08)',
          display: 'grid', placeItems: 'center', color: 'var(--accent)', fontSize: 14, fontWeight: 600,
        }}>{t('terminal.dropToMention')}</div>
      )}
      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        {terms.map((termName) => (
          // 非当前终端不能用 display:none：xterm 会暂停渲染且容器尺寸归零，切换或关闭当前标签时
          // 下一张 WebGL 画布要经过“重新量尺寸 → 清画布 → 重画”，中间会露出 1~2 帧黑屏。
          // visibility:hidden 保留真实尺寸并让后台画布保持就绪；pointerEvents/zIndex 隔离交互与层叠。
          <div key={termName} style={{
            position: 'absolute', inset: 0, padding: 6,
            visibility: termName === active ? 'visible' : 'hidden',
            pointerEvents: termName === active ? 'auto' : 'none',
            zIndex: termName === active ? 1 : 0,
          }}>
            <Term ref={(h) => { termRefs.current[termName] = h }} name={termName} fontSize={fontSize} active={termName === active} onStatus={(s) => setStatus(termName, s)}
              onContextMenu={({ x, y, selection }) => { setActive(termName); setCtx({ x, y, session: termName, selection }) }}
              onSelectionMenu={({ selection }) => { setActive(termName); setCtx(null); if (selection.trim()) { copyText(selection); message.success(t('common.copied')) } }}
              onPaste={() => { setActive(termName); pasteClipboard(termName) }}
              onImagePaste={(files) => { setActive(termName); pasteImage(termName, files) }} />
            {claudeView[termName] && claudeMap[termName]?.running && (
              <div style={{ position: 'absolute', inset: 0 }}>
                <ClaudeChat name={termName} file={claudeMap[termName].file} onOpenFile={isPhone ? undefined : openFileFromChat} onOpenGit={() => setShowGit(true)} />
              </div>
            )}
            {codexView[termName] && codexMap[termName]?.running && (
              <div style={{ position: 'absolute', inset: 0 }}>
                <CodexChat name={termName} file={codexMap[termName].file} onOpenFile={isPhone ? undefined : openFileFromChat} onOpenGit={() => setShowGit(true)} />
              </div>
            )}
            {showVoice && !claudeView[termName] && !codexView[termName] && (
              <VoiceInput accent="var(--accent)" onResult={(text) => { api('POST', `/sessions/${encodeURIComponent(termName)}/type`, { text }).catch((e: any) => message.error(e.message)) }} />
            )}
          </div>
        ))}
      </div>
    </div>
  )
  const sessionBottom = (
    <>
      {isTouch && !inChat && (
        <div style={{ display: 'flex', gap: 'var(--sp-2)', padding: '8px 8px 0' }} onDragOver={allowPathDrop} onDrop={onInputDrop}>
          <Input ref={mobileInputRef} value={line}
            onFocus={() => { exitCopyMode(); setTyping(true) }}
            // 延后收起：点快捷键条上的键会先让输入框失焦，立刻收就把那一条抽走了
            onBlur={() => setTimeout(() => setTyping(false), 180)}
            onChange={(e) => setLine(e.target.value)}
            onPressEnter={(e) => { if ((e.nativeEvent as any).isComposing) return; submitLine() }}
            placeholder={t('terminal.mobileInputPlaceholder')} allowClear autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
          <Button type="primary" onMouseDown={noBlur} onClick={submitLine}>{t('common.send')}</Button>
        </div>
      )}
      {/* 快捷键条只在输入态出现（13 §5.2）：它常驻 49px，而不打字时一个键也用不上——
          手机上这 49px 直接等于终端少 3 行。桌面不受影响。
          `tt-keyrow` 给两侧渐隐 + 滚轮横移：这一条 15 个按钮宽 913，窄栏里只露得出 605，
          而原来既没有渐隐也没有滚动条，右边缘正好把某个键切成一半——看着就是"没显示全"。 */}
      {!inChat && (!isPhone || typing) && (
        <div className="tt-keyrow" ref={keyRowRef}
          onScroll={syncKeyFade}
          onWheel={(e) => {
            const el = keyRowRef.current
            if (!el || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
            el.scrollLeft += e.deltaY
          }}
          data-l={keyFadeL ? '1' : undefined} data-r={keyFadeR ? '1' : undefined}
          style={{ display: 'flex', gap: 'var(--sp-2)', padding: 8, borderTop: '1px solid var(--border)', overflowX: 'auto' }}>
          <Button type="primary" onMouseDown={noBlur} style={{ flex: '0 0 auto' }}
            onClick={() => (isTouch ? submitLine() : sendKey('\r'))}>Enter</Button>
          {/* 触屏没有 Ctrl+Shift+V / 右键菜单在长按选词后也不再弹出，丝带上补一个直达粘贴 */}
          {isTouch && <Button onMouseDown={noBlur} onClick={() => active && pasteClipboard(active)} style={{ flex: '0 0 auto' }}>{t('terminal.pasteAction')}</Button>}
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
      {active && <PromptDialog name={active} accent={codexMap[active]?.running ? 'var(--ok)' : 'var(--accent)'} enabled={!inChat && !promptOff} />}
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
          dir={cwd} accent="var(--accent)"
          explorerOpen={showFiles} onExplorerClose={() => setShowFiles(false)}
          leadingTitle={active || ''} leadingTab={sessionTab}
          leadingContent={terminalArea} chrome={sessionToolbar} footer={sessionBottom}
        />
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {phoneChrome || <>{tabStrip}{sessionToolbar}</>}
            {terminalArea}
            {sessionBottom}
          </div>
        </div>
      )}
      {/* 文件树也进 Inspector：它是最后一种「从右边出来一块」的浮层（420 fixed，
          同样盖住终端）。收进来之后 文件 / Git / Worktree 三者互斥——同一时刻只有一个
          Inspector，关掉栈顶自然露出下面那个（图纸 panels-desktop.html §二）。 */}
      {fileDock === 'right' && (
        <AdaptivePanel open={showFiles} layer="session" title={t('nav.files')}
          onClose={() => setShowFiles(false)}>
          <FileBrowser dir={cwd} accent="var(--accent)" layout="dock" onClose={() => setShowFiles(false)} />
        </AdaptivePanel>
      )}
      {/* 手机走全屏二级页（13 §6）：420 的浮层在 360 屏上盖到 92vw，还压着底栏、不吃安全区。
          桌面维持右缘浮动面板不变。layer="session" —— 这一层是从会话全屏(100)里唤起的。 */}
      <AdaptivePanel open={showGit} layer="session" title={t('git.title')}
        onClose={() => setShowGit(false)}>
        <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}><Spin /></div>}>
          <GitPanel dir={cwd} accent="var(--accent)" onClose={() => setShowGit(false)} />
        </Suspense>
      </AdaptivePanel>
      {paneCloseTarget && (
        <PaneCloseConfirm
          target={paneCloseTarget} busy={paneCloseBusy} error={paneCloseError}
          onConfirm={confirmPaneClose} onCancel={() => setPaneCloseTarget(null)}
        />
      )}
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
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null) // 首次是否需设置口令
  const saved = (() => { try { return localStorage.getItem(PW_KEY) || '' } catch { return '' } })()

  // 问后端是否要动态码 / 是否需首次设置口令（公开端点）
  useEffect(() => {
    api('GET', '/pubconfig')
      .then((r) => { setTotp(!!r?.data?.totp); setNeedsSetup(!!r?.data?.needsSetup) })
      .catch(() => setNeedsSetup(false))
  }, [])

  const Brand = (
    <div style={{ textAlign: 'center', marginBottom: 18 }}>
      <img src="/logo-mark.svg" width={64} height={64} alt="Roam" />
      <div style={{
        fontSize: 30, fontWeight: 800, letterSpacing: 1, marginTop: 12,
        background: 'var(--brand-grad)',
        WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent',
      }}>Roam</div>
      <div style={{ color: 'var(--text-dimmer)', fontSize: 12, marginTop: 4, letterSpacing: 0.5 }}>{t('auth.tagline')}</div>
    </div>
  )

  const shell = (children: ReactNode) => (
    <div style={{ height: '100dvh', display: 'grid', placeItems: 'center', padding: 16, background: 'var(--bg-base)' }}>
      <Card style={{ width: 'min(360px,92vw)' }}>{Brand}{children}</Card>
    </div>
  )

  // 加载中：pubconfig 未回来前不闪现登录表单
  if (needsSetup === null) return shell(<div style={{ textAlign: 'center', padding: 12 }}><Spin /></div>)

  // 首次：必须先设置口令，成功即已登录
  if (needsSetup) {
    return shell(
      <Form
        layout="vertical"
        onFinish={async (v) => {
          setLoading(true)
          try {
            await api('POST', '/setup', { password: v.password })
            onOk()
          } catch (e: any) {
            message.error(/WEAK_PASSWORD/.test(e.message) ? t('auth.passwordMin') : t('auth.setupFailed'))
          } finally { setLoading(false) }
        }}
      >
        <div style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 12, textAlign: 'center' }}>{t('auth.setupHint')}</div>
        <Form.Item name="password" rules={[{ required: true, min: 6, message: t('auth.passwordMin') }]}>
          <Input.Password size="large" placeholder={t('auth.setupPassword')} autoFocus />
        </Form.Item>
        <Form.Item name="confirm" dependencies={['password']} rules={[
          { required: true, message: t('auth.confirmRequired') },
          ({ getFieldValue }) => ({ validator(_, value) { if (!value || getFieldValue('password') === value) return Promise.resolve(); return Promise.reject(new Error(t('auth.passwordMismatch'))) } }),
        ]}>
          <Input.Password size="large" placeholder={t('auth.setupConfirm')} />
        </Form.Item>
        <Button type="primary" size="large" block htmlType="submit" loading={loading}>{t('auth.setupSubmit')}</Button>
      </Form>
    )
  }

  return shell(
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
  )
}

// ── 概览（仪表盘）──
// 蜂群状态 → 颜色/中文
// 概览页已重构为「项目为主」的独立组件（Overview.tsx，08 设计 P6）。

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
                      title={<Space><span>{t.label || t.name}</span><TypeTag type={t.type} /><StatusTag status={t.status} code={t.exit_code} /></Space>}
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
import { ArrowDown, ArrowUp, BotIcon, CheckIcon, ChevronDown, ChevronRight, CloseIcon, Disclosure, HomeIcon, KeyboardIcon, MoonIcon, PlusIcon, SearchIcon, SunIcon, TerminalIcon, WindowsIcon } from './icons'
import { BranchIcon } from './git/parts'
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
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)', marginBottom: 10 }}>
        <Tag style={{ cursor: 'pointer', margin: 0 }} onClick={() => load(undefined)} icon={<HomeIcon size={11} />}>{t('dirPicker.home')}</Tag>
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
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: d === '..' ? 'var(--text-dim)' : 'var(--text-bright)' }}>
              {d === '..' ? <><ArrowUp size={12} />{t('file.parentDir')}</> : <><ChevronRight size={12} />{d}</>}
            </span>
          </List.Item>
        )} />
    </Modal>
  )
}

// worktree 分支默认名：会话名 slug（小写、非字母数字转 -）
// prompt 派生任务名：取首行、去引号标点、截 24 字、空白转 -；中文原样保留（tmux 会话名支持中文）。
export function taskNameFromPrompt(p: string): string {
  const first = (p.trim().split(/\n/)[0] || '').replace(/["'`«»""'']/g, '').trim()
  // 优先在首个标点处断句（够长时），再截 24 字、去尾部标点、空白转 -
  const seg = first.split(/[，。,.!！？?;；:：]/)[0]
  const base = seg.length >= 4 ? seg : first
  return base.slice(0, 24).trim().replace(/[，。,.!！？?;；:：\s]+$/g, '').replace(/\s+/g, '-')
}
// POSIX 单引号安全包裹（prompt 作为 agent CLI 参数发送）。
export function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

// ── 新建会话（prompt-first 派活）/ 派生子会话 ──
// parent 非空 = 派生模式：同一张表单（目录默认父 cwd 可改、三选一、命名约定 prompt 全同款），
// 仅提交路由不同（fork / fork-worktree，meta 记父子关系）。两处不再各维护一份表单。
export function NewSessionModal({ open, parent, onClose, onDone }: { open: boolean; parent?: string | null; onClose: () => void; onDone: (name: string) => void }) {
  const [prompt, setPrompt] = useState('')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [dir, setDir] = useState('')
  const [pick, setPick] = useState(false)
  const [agent, setAgent] = useState<'none' | 'claude' | 'codex'>('claude')
  // 工作区三选一（W1 交互修订）：主仓库 / 新建隔离 worktree / 进入已有 worktree
  const [wtMode, setWtMode] = useState<'repo' | 'new' | 'existing'>('repo')
  const [existingWts, setExistingWts] = useState<any[]>([])
  const [wtPath, setWtPath] = useState('')
  const [autoReview, setAutoReview] = useState(false)
  const [isGitRepo, setIsGitRepo] = useState(false)
  const [creating, setCreating] = useState(false)
  // worktree 展开态（W1）：只选「基于」。分支不提前指定——后端按会话名占位，
  // Agent 开工后按任务 git branch -m 语义化（交互修订 4：先建会话再建 worktree）。
  // base 选中值：本地分支存裸名；远端分支存 remote:<remote>:<branch> 编码
  // （冒号在 git ref 名里非法，编码无歧义），提交前拆回 {base, remote}
  const [base, setBase] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [remoteBranches, setRemoteBranches] = useState<{ remote: string; name: string }[]>([])
  const [defBranch, setDefBranch] = useState('')
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  const [prefs] = usePreferences()
  useEffect(() => {
    if (!open) return
    setPrompt(''); setName(''); setNameTouched(false); setDir(''); setAgent('claude'); setWtMode('repo'); setAutoReview(false); setIsGitRepo(false)
    setBase(''); setBranches([]); setRemoteBranches([]); setDefBranch(''); setExistingWts([]); setWtPath('')
    // 派生模式：目录默认父会话 cwd（可改成任意目录，与新建一致）
    if (parent) {
      let cancelled = false
      api('GET', `/sessions/${encodeURIComponent(parent)}/cwd`)
        .then((r) => { if (!cancelled) setDir(r?.data?.dir || '') }).catch(() => {})
      return () => { cancelled = true }
    }
  }, [open, parent])
  useEffect(() => {
    const d = dir.trim()
    if (!d) { setIsGitRepo(false); return }
    let cancelled = false
    api('GET', `/git/is-repo?path=${encodeURIComponent(d)}`).then((r) => {
      if (!cancelled) setIsGitRepo(!!r?.data?.repo)
    }).catch(() => { if (!cancelled) setIsGitRepo(false) })
    return () => { cancelled = true }
  }, [dir])
  // 目录是 git 仓库时拉已有 worktree（三选一的「已有」选项 + 计数）
  useEffect(() => {
    if (!isGitRepo || !dir.trim()) { setExistingWts([]); setWtPath(''); setWtMode('repo'); return }
    let cancelled = false
    api('GET', `/git/worktrees?dir=${encodeURIComponent(dir.trim())}`).then((r) => {
      if (cancelled) return
      const wts = (Array.isArray(r?.data) ? r.data : []).filter((w: any) => !w.isMain && !w.prunable)
      setExistingWts(wts)
      setWtPath((prev) => (prev && wts.some((w: any) => w.path === prev) ? prev : (wts[0]?.path || '')))
    }).catch(() => { if (!cancelled) setExistingWts([]) })
    return () => { cancelled = true }
  }, [isGitRepo, dir])
  // 选「新建 worktree」时拉本地+远端分支做「基于」候选
  useEffect(() => {
    if (wtMode !== 'new' || !isGitRepo || !dir.trim()) return
    let cancelled = false
    api('GET', `/git/branches?dir=${encodeURIComponent(dir.trim())}`).then((r) => {
      if (cancelled) return
      const bs: string[] = r?.data?.branches || []
      const def: string = r?.data?.default || ''
      const rs: { remote: string; name: string }[] = r?.data?.remotes || []
      setBranches(bs); setDefBranch(def); setRemoteBranches(rs)
      setBase((prev) => (prev && (bs.includes(prev) || rs.some((x) => `remote:${x.remote}:${x.name}` === prev)) ? prev : def))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [wtMode, isGitRepo, dir])
  const ok = async () => {
    // prompt-first：名字可全派生；prompt 与名字都空才拦
    let finalName = name.trim()
    if (!finalName) {
      if (!prompt.trim()) return message.error(t('session.promptOrNameRequired'))
      finalName = taskNameFromPrompt(prompt).slice(0, 16).replace(/[-，。,.\s]+$/g, '')
    }
    if (!finalName) {
      const d = new Date()
      finalName = 'task-' + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0')
    }
    try {
      setCreating(true)
      let sessionDir = dir.trim()
      let actual: string
      if (wtMode === 'new' && isGitRepo && sessionDir) {
        // 组合 API（先会话后 worktree）：分支不传——后端按会话名占位，Agent 开工后语义化；
        // 派生模式走 fork-worktree（同编排 + meta 记父子）
        let baseReq: { base?: string; remote?: string } = base ? { base } : {}
        if (base.startsWith('remote:')) {
          const rest = base.slice('remote:'.length)
          const sep = rest.indexOf(':')
          baseReq = { base: rest.slice(sep + 1), remote: rest.slice(0, sep) }
        }
        const res = parent
          ? await api('POST', `/sessions/${encodeURIComponent(parent)}/fork-worktree`, {
            child: finalName, dir: sessionDir, ...baseReq,
          })
          : await api('POST', '/worktree-sessions', {
            name: finalName, dir: sessionDir, ...baseReq,
          })
        actual = res.name || res.data?.session || finalName
        sessionDir = res.data?.path || sessionDir
      } else {
        // 主仓库直接用所选目录；「已有 worktree」= 会话 cwd 指进该 worktree；
        // 派生模式走 fork（dir 留空则继承父 cwd）
        if (wtMode === 'existing' && wtPath) sessionDir = wtPath
        const res = parent
          ? await api('POST', `/sessions/${encodeURIComponent(parent)}/fork`, {
            child: finalName, ...(sessionDir ? { dir: sessionDir } : {}),
          })
          : await api('POST', '/sessions', { name: finalName, dir: sessionDir })
        actual = res.name || finalName
      }
      if (agent !== 'none') {
        const cmd = agent === 'claude' ? (prefs.claudeCommand || 'claude') : (prefs.codexCommand || 'codex')
        let launch = cmd
        if (prompt.trim()) {
          // prompt 作为 CLI 参数随启动一次带入；新建 worktree 时前置命名约定：
          // 让 agent 开工前 git branch -m 一个语义化分支名（占位分支来自后端）
          const naming = wtMode === 'new' ? t('session.wt.namingHint') + '\n\n' : ''
          launch = `${cmd} ${shq(naming + prompt.trim())}`
        }
        await api('POST', '/tasks/_/send', { sess: actual, msg: launch })
        if (autoReview && !sessionDir) {
          message.warning(t('session.autoReviewNeedsDir'))
        } else if (autoReview && sessionDir) {
          // track 会登记跟踪并拉起 review-<会话> 监控会话:对话空闲即互审,意见回灌
          await api('POST', '/plugin/track', {
            session: actual,
            labels: { 'review:auto': 'true', role: 'author', workdir: sessionDir },
          }).catch((e: any) => message.warning(t('session.autoReviewTrackFailed') + ': ' + e.message))
        }
      }
      pushRecentDir(dir); message.success(t(parent ? 'session.fork.created' : 'session.created')); onClose(); onDone(actual)
    }
    catch (e: any) { message.error(e.message) }
    finally { setCreating(false) }
  }
  return (
    <>
      <Modal open={open} onCancel={onClose} onOk={ok}
        okText={parent ? t('session.fork.ok') : t('file.create')}
        title={parent ? t('session.fork.title', { parent }) : t('session.new')} destroyOnClose
        confirmLoading={creating}>
        <Space direction="vertical" style={{ width: '100%' }}>
          {/* 名称是一等短输入(可留空自动命名)；需求是任务本体,发给 Agent/派生分支 */}
          <Input placeholder={t('session.namePlaceholder2')} value={name} autoFocus
            onChange={(e) => { setName(e.target.value); setNameTouched(true) }} />
          {/* 顺序（交互修订 5）：先定位置——名字 → 目录 → 在哪干活；再定执行——Agent → 需求。
              派生模式目录固定 = 父会话 cwd（派生的语义就是在父目录干活），只读展示 */}
          {parent ? (
            <div style={{ color: 'var(--text-dimmer)', fontSize: 12, fontFamily: 'ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={dir}>{dir || '…'}</div>
          ) : (<>
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
          </>)}
          {/* 工作区三选一（W1 交互修订）：常驻不隐藏(cc96123 教训)——非 git 目录整组置灰+tooltip */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--text-dim)', fontSize: 13, flex: '0 0 auto' }}>{t('session.wt.where')}</span>
              <Tooltip title={isGitRepo ? '' : parent ? t('session.fork.parentNotRepo') : t('session.worktreeNeedsRepo')}>
                <Segmented size="small" value={isGitRepo ? wtMode : 'repo'} onChange={(v) => setWtMode(v as any)} options={[
                  { label: parent ? t('session.fork.parentDir') : t('session.wt.mainRepo'), value: 'repo' },
                  { label: t('session.wt.newWt'), value: 'new', disabled: !isGitRepo },
                  { label: t('session.wt.existingWt', { count: existingWts.length }), value: 'existing', disabled: !isGitRepo || !existingWts.length },
                ]} />
              </Tooltip>
            </div>
            <div style={{ color: 'var(--text-dimmer)', fontSize: 12 }}>
              {!isGitRepo ? (parent ? t('session.fork.parentNotRepo') : t('session.worktreeNeedsRepo'))
                : wtMode === 'repo' ? (parent ? t('session.fork.hintParent') : t('session.wt.hintRepo'))
                  : wtMode === 'new' ? t('session.wt.hintNew') : t('session.wt.hintExisting')}
            </div>
            {wtMode === 'existing' && (
              <Select value={wtPath || undefined} onChange={(v) => setWtPath(v)} placeholder={t('session.wt.pickExisting')}
                style={{ width: '100%' }} optionLabelProp="title"
                options={existingWts.map((w: any) => {
                  const occupied = (w.sessions || []).length > 0
                  return {
                    value: w.path,
                    title: w.branch || w.path.split('/').pop(),
                    label: (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', minWidth: 0 }}>
                        <span style={{ fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-flex', alignItems: 'center', gap: 4 }}><BranchIcon size={11} />{w.branch || '?'}</span>
                        {occupied
                          ? <Tag color="green" style={{ margin: 0, fontSize: 11, lineHeight: '16px' }}>{sessionLabel(w.sessions[0].session)}</Tag>
                          : w.external
                            ? <Tag style={{ margin: 0, fontSize: 11, lineHeight: '16px' }}>⧉ {t('worktree.external')}</Tag>
                            : <Tag color="warning" style={{ margin: 0, fontSize: 11, lineHeight: '16px' }}>{t('worktree.orphan')}</Tag>}
                        {(w.dirty > 0 || w.untracked > 0) && <span style={{ color: 'var(--text-dimmer)', fontSize: 11 }}>{t('session.wt.dirtyShort', { count: w.dirty + w.untracked })}</span>}
                      </span>
                    ),
                  }
                })} />
            )}
            {/* 新建 worktree 展开态（W1 交互修订 4）：只选「基于」（缺省本地主干）。
                分支不提前指定——占位按会话名派生，Agent 开工后按任务命名 */}
            {wtMode === 'new' && isGitRepo && (
              <div style={{ background: 'var(--bg-elevated)', borderRadius: 'var(--r-sm)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: '0 0 52px', color: 'var(--text-dim)', fontSize: 13 }}>{t('session.wt.base')}</span>
                  <Select size="small" showSearch optionFilterProp="label" style={{ flex: 1, minWidth: 0 }}
                    value={base || undefined} onChange={(v) => setBase(v)}
                    placeholder={t('session.wt.basePlaceholder')}
                    options={(() => {
                      type Opt = { value?: string; label: string; options?: { value: string; label: string }[] }
                      const locals = [
                        ...(defBranch ? [{ value: defBranch, label: t('session.wt.defaultBranch', { name: defBranch }) }] : []),
                        ...branches.filter((b) => b !== defBranch).map((b) => ({ value: b, label: b })),
                      ]
                      if (!remoteBranches.length) return locals as Opt[]
                      return [
                        { label: t('session.wt.localBranches'), options: locals },
                        {
                          label: t('session.wt.remoteBranches'),
                          options: remoteBranches.map((rb) => ({ value: `remote:${rb.remote}:${rb.name}`, label: `${rb.remote}/${rb.name}` })),
                        },
                      ] as Opt[]
                    })()} />
                </div>
                <div style={{ color: 'var(--text-dimmer)', fontSize: 12 }}>
                  {base.startsWith('remote:') ? t('session.wt.remoteFetchNote')
                    : agent !== 'none' ? t('session.wt.autoNote') : t('session.wt.autoNoteNoAgent')}
                </div>
              </div>
            )}
          </div>
          <Radio.Group value={agent} onChange={(e) => setAgent(e.target.value)} optionType="button" buttonStyle="solid"
            style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            <Radio.Button value="none">{t('session.agentNone')}</Radio.Button>
            <Radio.Button value="claude">{t('session.agentClaude')}</Radio.Button>
            <Radio.Button value="codex">{t('session.agentCodex')}</Radio.Button>
          </Radio.Group>
          <Input.TextArea placeholder={t('session.promptPlaceholder')} value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            autoSize={{ minRows: 3, maxRows: 8 }} />
          <Tooltip placement="right" title={agent !== 'none' ? t('session.autoReviewTip') : t('session.autoReviewNeedsAgent')}>
            <Checkbox checked={autoReview && agent !== 'none'} disabled={agent === 'none'}
              onChange={(e) => setAutoReview(e.target.checked)} style={{ width: 'fit-content' }}>
              <span style={{ fontSize: 13 }}>{t('session.autoReview')}</span>
            </Checkbox>
          </Tooltip>
        </Space>
      </Modal>
      <DirPicker open={pick} start={dir || undefined} onPick={(p) => { setDir(p); setPick(false) }} onClose={() => setPick(false)} />
    </>
  )
}


// 改名 = 只改**展示名**：会话本身叫 id，改名不动 handle，
// 所以终端标签、URL、归属、正在跑的东西全都不受影响，重名也随便。
function RenameSessionModal({ session, onClose, onDone }: { session: string | null; onClose: () => void; onDone: (oldName: string, newName: string) => void }) {
  const [name, setName] = useState('')
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  useEffect(() => { if (session) setName(sessionLabel(session)) }, [session])
  const ok = async () => {
    if (!session) return
    const next = name.trim()
    if (!next) return message.error(t('session.nameRequired'))
    try {
      const res = await api('PATCH', `/sessions/${encodeURIComponent(session)}`, { name: next })
      const label = res.data?.label || next
      updateSessionLabel(session, label)
      message.success(t('session.renamed'))
      onClose()
      onDone(session, session)
    } catch (e: any) {
      message.error(e.message)
    }
  }
  return (
    <Modal open={!!session} onCancel={onClose} onOk={ok} okText={t('session.rename')} title={t('session.renameTitle')} destroyOnClose>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Input placeholder={t('session.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <div style={{ color: 'var(--text-dimmer)', fontSize: 12 }}>{t('session.renameHint')}</div>
        {session && <div style={{ color: 'var(--text-dimmer)', fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>id: {session}</div>}
      </Space>
    </Modal>
  )
}

// ── 关闭 worktree 会话的收尾三选一（W7）：保留 / 合并回 base 并删除 / 丢弃并删除 ──
export function CloseWorktreeModal({ info, onClose, onDone }: {
  info: { name: string; st: any } | null
  onClose: () => void
  onDone: (name: string) => void
}) {
  const [mode, setMode] = useState<'keep' | 'merge' | 'discard'>('keep')
  const [strategy, setStrategy] = useState<'squash' | 'merge' | 'rebase'>('squash')
  const [busy, setBusy] = useState(false)
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  const st = info?.st || {}
  const merged = !!st.mergedInto // 合入检测（10 §5）：已合入时丢弃=清理，默认直选
  useEffect(() => { if (info) { setMode(info.st?.mergedInto ? 'discard' : 'keep'); setStrategy('squash') } }, [info])
  const ok = async () => {
    if (!info) return
    setBusy(true)
    try {
      await api('POST', `/sessions/${encodeURIComponent(info.name)}/close-with-worktree`, {
        mode, path: st.path, ...(mode === 'merge' ? { strategy } : {}),
      })
      message.success(t('session.closed'))
      onClose(); onDone(info.name)
    } catch (e: any) {
      const ae = e.apiError || {}
      message.error(ae.stage ? t('worktree.close.failedAtStage', { stage: ae.stage, msg: e.message }) : e.message)
    } finally { setBusy(false) }
  }
  return (
    <Modal open={!!info} onCancel={onClose} onOk={ok} confirmLoading={busy} destroyOnClose
      title={t('worktree.close.title', { name: info?.name || '' })}
      okText={t('session.close')}
      okButtonProps={{ danger: mode === 'discard' && (!merged || (st.dirty || 0) + (st.untracked || 0) > 0) }}>
      <div style={{ color: 'var(--text-dim)', marginBottom: 12 }}>
        {/* 已合入（10 §5）：损失叙事换成绿色定心丸；未提交改动仍如实提示 */}
        {merged
          ? (<>
            <div style={{ color: 'var(--ok)' }}>{t('project.finish.mergedRemote', { target: st.mergedInto, kind: st.mergedKind })}</div>
            {(st.dirty || 0) + (st.untracked || 0) > 0 && (
              <div style={{ color: '#d29922', marginTop: 4 }}>{t('project.finish.uncommitted', { count: (st.dirty || 0) + (st.untracked || 0) })}</div>
            )}
          </>)
          : t('worktree.close.summary', {
            branch: st.branch || '?',
            dirty: (st.dirty || 0) + (st.untracked || 0),
            ahead: st.committedAhead || 0,
            base: st.base || '?',
          })}
      </div>
      <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
        <Radio value="keep">{t('worktree.close.keep')}</Radio>
        {/* 已合入后本地再合并只会空转/添乱：禁用并提示走清理 */}
        <Radio value="merge" disabled={!st.base || merged}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {t('worktree.close.merge', { base: st.base || '?' })}
            {merged && <span style={{ fontSize: 12, color: 'var(--text-dimmer)' }}>{t('worktree.close.mergeDisabledMerged')}</span>}
            {mode === 'merge' && (
              <Select size="small" value={strategy} onChange={(v) => setStrategy(v)} style={{ width: 100 }}
                onClick={(e) => e.stopPropagation()}
                options={[{ value: 'squash', label: 'squash' }, { value: 'merge', label: 'merge' }, { value: 'rebase', label: 'rebase' }]} />
            )}
          </span>
        </Radio>
        <Radio value="discard">
          {merged
            ? <span style={{ color: 'var(--ok)' }}>{t('worktree.close.discardMerged', { target: st.mergedInto })}</span>
            : <span style={{ color: '#f85149' }}>{t('worktree.close.discard')}</span>}
        </Radio>
      </Radio.Group>
    </Modal>
  )
}

// ── 会话（可新建/指定目录 / 进终端 / 关闭） ──
function Sessions({ openTerm, closeTerm, activeTerm, embedded }: {
  openTerm: (n: string) => void; closeTerm: (n: string) => void; activeTerm: string | null
  /** 嵌在概览「会话」tab 里：不渲染页头（外面的 tab 已经说了这是会话） */
  embedded?: boolean
}) {
  const { phone: isPhone } = useLayout()
  const [list, setList] = useState<any[]>([])
  const [cc, setCc] = useState<Record<string, boolean>>({})
  const [cx, setCx] = useState<Record<string, boolean>>({})
  const [needsInput, setNeedsInput] = useState<Record<string, boolean>>({})
  const [swarmMap, setSwarmMap] = useState<Record<string, { swarm: string; role: string }>>({})
  const [newOpen, setNewOpen] = useState(false)
  const [wtOpen, setWtOpen] = useState(false)
  const [wtDir, setWtDir] = useState<string | undefined>(undefined)
  // session→worktree 归属注解（cwd 现算的弱关联）：会话行 ⎇ Tag 的数据源
  const [wtAnn, setWtAnn] = useState<Record<string, any>>({})
  // 会话→项目：桌面「项目」列的数据源。表是 App 那份轮询建的，这里只读（14 §6.3）
  const sessProj = useSessionProjects()
  // 竞赛（W5/W6）：Race Service 业务数据，会话按竞赛聚组、组头进对比台
  const [races, setRaces] = useState<any[]>([])
  const [raceOpen, setRaceOpen] = useState(false)
  const [compareId, setCompareId] = useState('')
  // W7 关闭流程：confirmKill = 普通 Popconfirm 受控打开；closing = worktree 收尾三选一弹窗
  const [confirmKill, setConfirmKill] = useState<string | null>(null)
  const [closing, setClosing] = useState<{ name: string; st: any } | null>(null)
  // 派生子会话（fork）弹窗：值为父会话名
  const [forking, setForking] = useState<string | null>(null)
  const { message, modal } = AntApp.useApp()
  const { t } = useI18n()
  // tree=1：拿 parent 投影树后拍平（节点字段与平铺一致 + parent），W2 父子分组用
  const load = () => api('GET', '/sessions?tree=1').then((roots) => {
    const flat: any[] = []
    const walk = (nodes: any[]) => { for (const n of nodes || []) { flat.push(n); walk(n.children) } }
    walk(Array.isArray(roots) ? roots : [])
    setList(flat)
    setSessionLabels(Object.fromEntries(flat.filter((s) => s?.name && s?.label).map((s) => [s.name, s.label])))
  }).catch(() => {})
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t) }, [])
  useEffect(() => {
    let stop = false
    const loadAnn = () => api('GET', '/sessions/annotations')
      .then((r) => { if (!stop) setWtAnn(r?.data || {}) }).catch(() => {})
    loadAnn()
    const t = setInterval(loadAnn, 8000)
    return () => { stop = true; clearInterval(t) }
  }, [])
  useEffect(() => {
    let stop = false
    const loadRaces = () => api('GET', '/races')
      .then((r) => { if (!stop) setRaces(Array.isArray(r?.data) ? r.data : []) }).catch(() => {})
    loadRaces()
    const t = setInterval(loadRaces, 8000)
    return () => { stop = true; clearInterval(t) }
  }, [])
  const reloadRaces = () => api('GET', '/races').then((r) => setRaces(Array.isArray(r?.data) ? r.data : [])).catch(() => {})
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
  // W7：点关闭先查会话是否在 worktree 内，据状态分流——
  // 非 worktree/外部 → 原 Popconfirm；有未收尾内容 → 三选一；干净且 base 已知 → 确认框附「随会话删除」勾选
  const closeWith = async (n: string, mode: 'keep' | 'merge' | 'discard', path?: string) => {
    try {
      await api('POST', `/sessions/${encodeURIComponent(n)}/close-with-worktree`, { mode, path })
      message.success(t('session.closed')); closeTerm(n); load()
    } catch (e: any) {
      const ae = e.apiError || {}
      message.error(ae.stage ? t('worktree.close.failedAtStage', { stage: ae.stage, msg: e.message }) : e.message)
      throw e
    }
  }
  const beginClose = async (n: string) => {
    let st: any = null
    try { st = (await api('GET', `/sessions/${encodeURIComponent(n)}/worktree-status`))?.data } catch {}
    if (!st?.inWorktree || st.external) { setConfirmKill(n); return }
    if ((st.dirty || 0) > 0 || (st.untracked || 0) > 0 || (st.committedAhead || 0) > 0) {
      setClosing({ name: n, st })
      return
    }
    if (!st.base) { setConfirmKill(n); return }
    // 干净 worktree：默认勾选随会话删除（显式可见，不静默）
    const removeToo = { current: true }
    modal.confirm({
      title: t('session.closeConfirm', { name: sessionDisplay(n) }),
      content: (
        <Checkbox defaultChecked onChange={(e) => { removeToo.current = e.target.checked }}>
          {t('worktree.close.removeWithSession')}
        </Checkbox>
      ),
      okText: t('session.close'),
      onOk: () => closeWith(n, removeToo.current ? 'discard' : 'keep', st.path),
    })
  }

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
  const filtered = list.filter((s: any) => (!ql || `${s.label || ''} ${s.name}`.toLowerCase().includes(ql)) && match(s, filter))
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

  // ── W2 仓库分组：同仓库 ≥2 个 worktree 会话聚组，组头可折叠(记 localStorage) ──
  const { desktop: wide } = useLayout()
  const [wtCollapsed, setWtCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('ttmux_wt_groups') || '{}') } catch { return {} }
  })
  const toggleGroup = (repo: string) => setWtCollapsed((m) => {
    const next = { ...m, [repo]: !m[repo] }
    try { localStorage.setItem('ttmux_wt_groups', JSON.stringify(next)) } catch { /* 忽略 */ }
    return next
  })
  const repoOf = (name: string) => { const a = wtAnn[name]; return a?.primary?.linked ? a.primary.repo as string : '' }
  // 分组仓库的 worktree 全貌(总数/孤儿)：让会话页感知还有没挂会话的 worktree
  const [repoWt, setRepoWt] = useState<Record<string, { total: number; orphans: number }>>({})
  useEffect(() => {
    const repos = Array.from(new Set(Object.values(wtAnn)
      .map((a: any) => (a?.primary?.linked ? a.primary.repo as string : ''))
      .filter(Boolean)))
    if (!repos.length) { setRepoWt({}); return }
    let stop = false
    Promise.all(repos.map(async (r) => {
      try {
        const res = await api('GET', `/git/worktrees?dir=${encodeURIComponent(r)}`)
        const wts = (Array.isArray(res?.data) ? res.data : []).filter((w: any) => !w.isMain && !w.prunable)
        return [r, { total: wts.length, orphans: wts.filter((w: any) => !(w.sessions || []).length).length }] as const
      } catch { return [r, { total: 0, orphans: 0 }] as const }
    })).then((es) => { if (!stop) setRepoWt(Object.fromEntries(es)) })
    return () => { stop = true }
  }, [wtAnn])
  // 竞赛成员映射：竞赛分组优先于仓库分组（同一批会话不重复聚组）
  const raceOf: Record<string, any> = {}
  for (const rc of races) {
    if (rc.status === 'cleaned') continue
    for (const ct of rc.contestants || []) raceOf[ct.session] = rc
  }
  // 父子树（设计 §2.2）：parent 是显式强关系（fork 意图），分组优先级 竞赛 > 父子树 > 仓库
  const alive = new Set(sorted.map((s: any) => s.name))
  const byName: Record<string, any> = {}
  for (const s of sorted) byName[s.name] = s
  const kidsOf: Record<string, any[]> = {}
  for (const s of sorted) {
    if (raceOf[s.name]) continue
    if (s.parent && alive.has(s.parent) && !raceOf[s.parent]) (kidsOf[s.parent] ||= []).push(s)
  }
  const famRootOf = (s: any) => {
    let cur = s
    const seen = new Set<string>([s.name])
    while (cur.parent && alive.has(cur.parent) && !raceOf[cur.parent] && !seen.has(cur.parent)) {
      seen.add(cur.parent); cur = byName[cur.parent]
    }
    return cur
  }
  const famInvolved = (s: any) => !raceOf[s.name] &&
    ((kidsOf[s.name]?.length || 0) > 0 || (s.parent && alive.has(s.parent) && !raceOf[s.parent]))
  const groupCounts: Record<string, number> = {}
  for (const s of sorted) { const r = repoOf(s.name); if (r && !raceOf[s.name] && !famInvolved(s)) groupCounts[r] = (groupCounts[r] || 0) + 1 }
  const entries: any[] = []
  {
    const consumed = new Set<string>()
    for (const s of sorted) {
      if (consumed.has(s.name)) continue
      const rc = raceOf[s.name]
      if (rc) {
        // 竞赛组头(W2)：RACE <名> ×N + [对比台]
        const members = sorted.filter((x: any) => raceOf[x.name]?.id === rc.id)
        members.forEach((m: any) => consumed.add(m.name))
        const key = 'race:' + rc.id
        entries.push({ kind: 'race', race: rc, count: members.length, key })
        if (!wtCollapsed[key]) members.forEach((m: any) => entries.push({ kind: 'sess', s: m, indent: true, race: true }))
        continue
      }
      if (famInvolved(s)) {
        // 父子树：根行照常，子孙 DFS 缩进（⑂ 紫色导线）
        const root = famRootOf(s)
        if (consumed.has(root.name)) continue
        consumed.add(root.name)
        entries.push({ kind: 'sess', s: root, indent: false })
        const dfs = (parent: string, depth: number) => {
          for (const kid of kidsOf[parent] || []) {
            if (consumed.has(kid.name)) continue
            consumed.add(kid.name)
            entries.push({ kind: 'sess', s: kid, indent: true, fam: true, depth })
            dfs(kid.name, depth + 1)
          }
        }
        dfs(root.name, 1)
        continue
      }
      const r = repoOf(s.name)
      if (r && groupCounts[r] >= 2) {
        const members = sorted.filter((x: any) => repoOf(x.name) === r && !raceOf[x.name] && !famInvolved(x))
        members.forEach((m: any) => consumed.add(m.name))
        entries.push({ kind: 'group', repo: r, count: members.length })
        if (!wtCollapsed[r]) members.forEach((m: any) => entries.push({ kind: 'sess', s: m, indent: true }))
      } else {
        entries.push({ kind: 'sess', s, indent: false })
      }
    }
  }
  const compareRace = races.find((rc) => rc.id === compareId) || null

  // 会话动作：Worktree 管理 + 新建（两处复用，桌面进页头、手机独占一行）
  const sessionActions = (
    <>
      <Tooltip title={t('worktree.entryTip')}>
        <Button style={isPhone ? { flex: 1, minWidth: 0 } : undefined}
          onClick={() => { setWtDir(undefined); setWtOpen(true) }}>{t('worktree.entry')}</Button>
      </Tooltip>
      {/* 必须钉住 flex：Dropdown.Button 内的 Space.Compact 是块级 flex 子项，不钉就会
          一路撑开并盖住左边那枚按钮（项目页页头、手机头部都踩过同一个坑） */}
      <span style={{ flex: '0 0 auto', display: 'inline-flex' }}>
        {/* 新建下拉(W5 入口)：主点 = 新建会话；菜单 = 新建竞赛 */}
        <Dropdown.Button type="primary" onClick={() => setNewOpen(true)}
          menu={{ items: [{ key: 'race', label: t('race.new') }], onClick: () => setRaceOpen(true) }}>
          + {t('session.new')}
        </Dropdown.Button>
      </span>
    </>
  )

  return (
    // 不再套 Card：嵌在概览「会话」tab 里时，卡片边框 + 「会话 13」标题与外面的 tab
    // 完全重复——一层壳里套一层同名的壳。独立页则用与概览/项目同一套页头。
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      {/* 手机才需要自己占一行（横向放不下）；桌面并进下面搜索那一行，
          否则「Worktree 管理 / ＋新建会话」白占一整行 */}
      {isPhone && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>{sessionActions}</div>
      )}
      {/* 工具条：页名 + 搜索 + 排序同一行，类型筛选另起一行。
          页名并进这一行而不是单独的 .tt-pagehead（图纸 14-desktop-workspace/pagehead.html）：
          眉标「工作区」+ 大标题「会话」+ 一句「所有会话，按 Agent、等待状态与最近响应筛选」
          三层 91px，说的全是侧栏那条高亮导航项已经说完的事。 */}
      <div style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!embedded && !isPhone && (<>
            <span className="tt-pagename" title={t('session.subtitle')}>{t('nav.sessions')}</span>
            <span className="tt-pagedivider" aria-hidden="true" />
          </>)}
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
            {sortAsc ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
          </Button>
          {!isPhone && sessionActions}
        </div>
        {/* 一律按内容宽：block 在手机上把 6 项等分成 ~60px、标签全截成「全部…」；
            在桌面上又把 6 个标签摊到 1200px，中间空出大片，读起来是散的。
            筛选条本来就该贴左、只占它需要的宽度。 */}
        <div style={{ overflowX: 'auto' }} className="tt-seg-scroll">
          <Segmented value={filter} onChange={(v) => setFilter(v as any)} size="small" options={[
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
            <List dataSource={entries} renderItem={(en: any) => {
              if (en.kind === 'race') {
                const rc = en.race
                const collapsed = !!wtCollapsed[en.key]
                return (
                  // 竞赛组头(W6 入口)：RACE 徽标 + 名字 + 选手数 + 对比台
                  <List.Item style={{ padding: '10px 8px 4px 6px', cursor: 'pointer', borderBlockEnd: 'none' }} onClick={() => toggleGroup(en.key)}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minWidth: 0 }}>
                      <span style={{ color: 'var(--text-dimmer)', flex: '0 0 auto', display: 'inline-flex' }}><Disclosure open={!collapsed} /></span>
                      <Tag color="gold" style={{ margin: 0, flex: '0 0 auto', fontSize: 11, lineHeight: '18px', height: 20 }}>RACE</Tag>
                      <span style={{ fontWeight: 700, color: 'var(--text-bright)', fontSize: 13, flex: '0 0 auto' }}>{rc.name}</span>
                      {rc.base && <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, color: 'var(--text-dimmer)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{t('race.groupBase', { base: rc.base })}</span>}
                      <Tag style={{ margin: 0, flex: '0 0 auto', fontSize: 11, lineHeight: '18px', height: 20 }}>×{en.count}</Tag>
                      {rc.status === 'crowned' && <Tag color="gold" style={{ margin: 0, flex: '0 0 auto', fontSize: 11, lineHeight: '18px', height: 20 }}>{t('race.status.crowned')}</Tag>}
                      <span style={{ flex: 1 }} />
                      <a style={{ fontSize: 12.5, flex: '0 0 auto' }} onClick={(e) => { e.stopPropagation(); setCompareId(rc.id) }}>{t('race.compare')}</a>
                    </div>
                  </List.Item>
                )
              }
              if (en.kind === 'group') {
                const repo: string = en.repo
                const base = repo.split('/').filter(Boolean).pop() || repo
                const collapsed = !!wtCollapsed[repo]
                return (
                  // 仓库分组头(W2)：折叠三角 + 仓库名 + 路径 + worktree 计数 + 管理入口
                  <List.Item style={{ padding: '10px 8px 4px 6px', cursor: 'pointer', borderBlockEnd: 'none' }} onClick={() => toggleGroup(repo)}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minWidth: 0 }}>
                      <span style={{ color: 'var(--text-dimmer)', flex: '0 0 auto', display: 'inline-flex' }}><Disclosure open={!collapsed} /></span>
                      <span style={{ fontWeight: 700, color: 'var(--text-bright)', fontSize: 13, flex: '0 0 auto' }}>{base}</span>
                      <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, color: 'var(--text-dimmer)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{repo}</span>
                      <Tag color="cyan" style={{ margin: 0, flex: '0 0 auto', fontSize: 11, lineHeight: '18px', height: 20 }}>{t('worktree.groupCount', { count: repoWt[repo]?.total ?? en.count })}</Tag>
                      {(repoWt[repo]?.orphans ?? 0) > 0 && (
                        <Tooltip title={t('worktree.groupOrphansTip')}>
                          <Tag color="warning" style={{ margin: 0, flex: '0 0 auto', fontSize: 11, lineHeight: '18px', height: 20, cursor: 'pointer' }}
                            onClick={(e) => { e.stopPropagation(); setWtDir(repo); setWtOpen(true) }}>
                            {t('worktree.groupOrphans', { count: repoWt[repo].orphans })}
                          </Tag>
                        </Tooltip>
                      )}
                      <span style={{ flex: 1 }} />
                      <a style={{ fontSize: 12.5, flex: '0 0 auto' }} onClick={(e) => { e.stopPropagation(); setWtDir(repo); setWtOpen(true) }}>{t('worktree.manage')}</a>
                    </div>
                  </List.Item>
                )
              }
              const s = en.s
              const indent = !!en.indent
              const sw = swarmMap[s.name]
              const connected = s.attached == 1
              const agent = cc[s.name] ? 'claude' : cx[s.name] ? 'codex' : null
              const waiting = !!needsInput[s.name]
              const activeRow = activeTerm === s.name
              return (
                // 整行点击直接进入终端；右侧操作区 stopPropagation 不触发进入
                <List.Item style={{
                  position: 'relative', overflow: 'hidden',
                  marginLeft: indent ? 14 * (en.depth || 1) : 0,
                  borderLeft: indent ? (en.race ? '2px solid rgba(212,160,23,.35)' : en.fam ? '2px solid rgba(163,113,247,.4)' : '2px solid rgba(57,197,207,.3)') : undefined,
                  padding: '10px 8px 10px 12px', cursor: 'pointer',
                  borderRadius: indent ? '0 var(--r-sm) var(--r-sm) 0' : 'var(--r-sm)',
                  background: activeRow ? 'linear-gradient(90deg, rgba(31,111,235,.38), rgba(31,111,235,.16))' : undefined,
                  border: activeRow ? '1px solid var(--accent)' : '1px solid transparent',
                  boxShadow: activeRow ? '0 0 0 1px rgba(88,166,255,.18), 0 0 18px rgba(31,111,235,.14)' : undefined,
                }} onClick={() => openTerm(s.name)}>
                  {activeRow && <span aria-hidden style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: 'var(--accent)' }} />}
                  {/* 七个格子恒定：缺一个桌面上就整行错列，所以空的项目/位置格照样渲染（见 .tt-srow） */}
                  <div className="tt-srow">
                    <i title={waiting ? t('prompt.confirmRequired') : connected ? t('terminal.status.connected') : t('terminal.status.idle')} style={{ width: 8, height: 8, borderRadius: '50%', flex: '0 0 8px', background: waiting ? '#d29922' : connected ? 'var(--ok)' : 'var(--text-dimmer)' }} />
                    <span className="nm" style={{ color: activeRow ? '#fff' : undefined }}
                      title={`${s.label || s.name}（${s.id || s.name}）· ${t('session.createdAt')} ${absTime(s.created)}`}>
                      {en.fam && <Tooltip title={t('session.fork.childOf', { parent: s.parent })}><span style={{ color: '#a371f7', marginRight: 6, display: 'inline-flex' }}><BranchIcon size={12} /></span></Tooltip>}
                      {s.label || s.name}
                      {/* 会话 ID 只留尾 4 位：全名与名字同权并排时，每行前半截都在念一串日期 */}
                      {(s.id || s.name) !== (s.label || s.name) && <span className="id">{(s.id || s.name).slice(-4)}</span>}
                    </span>
                    <span className="pj">{sessProj[s.name]?.name}</span>
                    {(() => { // 位置列：有 worktree 就是 ⎇ 分支（点开进 worktree 管理），否则是工作目录
                      const ann = wtAnn[s.name]
                      const loc = sessionLocation(ann, s.cwd, sessProj[s.name]?.dir)
                      if (!loc.branch && !loc.path) return <span className="loc" />
                      const tip = loc.branch
                        ? t('worktree.sessionTagTip', { path: ann?.primary?.worktree || '' })
                          + (ann?.ambiguous ? ' · ' + t('worktree.sessionTagAmbiguous', { count: ann.matches?.length || 0 }) : '')
                        : loc.title
                      return (
                        <span className="loc" title={tip}
                          onClick={ann?.primary?.linked ? (e) => { e.stopPropagation(); setWtDir(ann.primary.repo); setWtOpen(true) } : undefined}
                          style={ann?.primary?.linked ? { cursor: 'pointer' } : undefined}>
                          {loc.branch ? <span className="br"><BranchIcon size={11} />{loc.branch}{ann?.ambiguous ? ' +' : ''}</span> : loc.path}
                        </span>
                      )
                    })()}
                    <span className="tags">
                      {(() => { // 窄档只留一枚 ⎇ 图标（桌面由位置列接管）；外部 worktree 加 ⧉
                        const ann = wtAnn[s.name]
                        if (!ann?.primary?.linked) return null
                        return (<>
                          <Tag className="wt" color="cyan" style={{ margin: 0, flex: '0 0 auto', cursor: 'pointer', fontFamily: 'ui-monospace, monospace' }}
                            onClick={(e) => { e.stopPropagation(); setWtDir(ann.primary.repo); setWtOpen(true) }}><BranchIcon size={11} /></Tag>
                          {ann.primary.external && <Tag className="wt" style={{ margin: 0, flex: '0 0 auto' }}><WindowsIcon size={11} /></Tag>}
                        </>)
                      })()}
                      {sw && <Tag color="blue" style={{ margin: 0, flex: '0 0 auto' }}>{t('nav.swarm')}:{sw.swarm}{sw.role === 'leader' ? `·${t('swarm.master')}` : ''}</Tag>}
                      {waiting && <Tag color="warning" style={{ margin: 0, flex: '0 0 auto' }}>{t('session.waiting')}</Tag>}
                      {cc[s.name] && <Tag color="blue" style={{ margin: 0, flex: '0 0 auto' }} icon={<AgentMark kind="claude" size={11} />}>Claude</Tag>}
                      {cx[s.name] && <Tag color="green" style={{ margin: 0, flex: '0 0 auto' }} icon={<AgentMark kind="codex" size={11} />}>Codex</Tag>}
                      {!sw && !agent && <Tag style={{ margin: 0, flex: '0 0 auto' }}>{connected ? t('terminal.status.connected') : t('terminal.status.idle')}</Tag>}
                      {/* 窗口数 99% 的会话都是 1，常驻就是一列噪声——只在 >1 时说 */}
                      {s.windows > 1 && <span style={{ color: 'var(--text-dim)', fontSize: 12, whiteSpace: 'nowrap' }}>{t('session.windows', { count: s.windows })}</span>}
                    </span>
                    <span className="tm" title={absTime(s.last_activity)}>{relTime(s.last_activity, t)}</span>
                    <span className="acts" onClick={(e) => e.stopPropagation()}>
                      {!sw && wide && <a onClick={() => setForking(s.name)}>{t('session.fork.entry')}</a>}
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
                        // 受控 Popconfirm：点「关闭」先查 worktree 状态，非 worktree 会话才打开本确认
                        <Popconfirm title={t('session.closeConfirm', { name: s.label || s.name })} open={confirmKill === s.name}
                          onConfirm={() => { setConfirmKill(null); kill(s.name) }}
                          onCancel={() => setConfirmKill(null)}
                          onOpenChange={(o) => { if (!o && confirmKill === s.name) setConfirmKill(null) }}>
                          <a style={{ color: '#f85149' }} onClick={() => { if (confirmKill !== s.name) beginClose(s.name) }}>{t('session.close')}</a>
                        </Popconfirm>
                      )}
                    </span>
                  </div>
                </List.Item>
              )
            }} />
          )}
      <NewSessionModal open={newOpen || !!forking} parent={forking}
        onClose={() => { setNewOpen(false); setForking(null) }} onDone={(name) => { load(); openTerm(name) }} />
      <CloseWorktreeModal info={closing} onClose={() => setClosing(null)} onDone={(name) => { closeTerm(name); load() }} />
      <Suspense fallback={null}>
        <WorktreePanel open={wtOpen} onClose={() => { setWtOpen(false); setWtDir(undefined) }} openTerm={openTerm} initialDir={wtDir} />
      </Suspense>
      <Suspense fallback={null}>
        {raceOpen && <RaceCreateModal open={raceOpen} onClose={() => setRaceOpen(false)}
          onDone={() => { reloadRaces(); load() }} />}
        {compareRace && <RaceComparePanel race={compareRace} onClose={() => setCompareId('')}
          openTerm={openTerm} onChanged={() => { reloadRaces(); load() }} />}
      </Suspense>
    </div>
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

function P2PCard() {
  const { t } = useI18n()
  const [prefs, setPrefs] = usePreferences()
  const [serverStun, setServerStun] = useState('')
  // 拉服务端默认 STUN 预填进输入框（用户未自定义时展示当前默认；改了才存自定义偏好）。
  useEffect(() => {
    fetch('/api/p2p/config', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const cfg = d?.data ?? d ?? {}
        const urls = (cfg.iceServers || []).flatMap((s: { urls?: string | string[] }) => (Array.isArray(s.urls) ? s.urls : s.urls ? [s.urls] : [])).filter(Boolean)
        if (urls.length) setServerStun(urls.join(', '))
      })
      .catch(() => { /* ignore */ })
  }, [])
  const on = prefs.p2pEnabled
  // 输入框展示：用户自定义优先，否则预填服务端默认。留空(未自定义)时 transport 仍走服务端默认。
  const stunValue = prefs.p2pStunServers || serverStun
  const dim = { color: 'var(--text-dim)', fontSize: 12 }
  const hint = { color: 'var(--text-dimmer)', fontSize: 11 }
  return (
    <Card title={t('settings.p2p')}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space align="center" wrap>
          <Switch checked={on} onChange={(v) => setPrefs({ p2pEnabled: v })} />
          <Tag color="orange" style={{ margin: 0 }}>{t('settings.p2pExperimental')}</Tag>
          <span style={dim}>{t('settings.p2pHelp')}</span>
        </Space>
        {/* STUN 服务器（留空用服务端默认）。仅影响本浏览器的打洞。 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)', opacity: on ? 1 : 0.5 }}>
          <span style={dim}>{t('settings.p2pStun')}</span>
          <Input
            disabled={!on} allowClear value={stunValue}
            placeholder={t('settings.p2pStunPh')}
            onChange={(e) => setPrefs({ p2pStunServers: e.target.value })}
            style={{ maxWidth: 460 }}
          />
          <span style={hint}>{t('settings.p2pStunHelp')}</span>
        </div>
        {/* 连接超时（秒）：打洞建链超时后回退 frp。 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)', opacity: on ? 1 : 0.5 }}>
          <span style={dim}>{t('settings.p2pTimeout')}</span>
          <Space align="center" wrap>
            <InputNumber
              disabled={!on} min={5} max={120} step={5} value={prefs.p2pConnectTimeoutSec}
              onChange={(v) => setPrefs({ p2pConnectTimeoutSec: typeof v === 'number' ? v : 30 })}
              addonAfter={t('settings.p2pTimeoutUnit')} style={{ width: 130 }}
            />
            <span style={hint}>{t('settings.p2pTimeoutHelp')}</span>
          </Space>
        </div>
        {/* 候选收集(gather)上限（秒）：慢网(手机蜂窝 srflx 迟到)可调大。 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)', opacity: on ? 1 : 0.5 }}>
          <span style={dim}>{t('settings.p2pGather')}</span>
          <Space align="center" wrap>
            <InputNumber
              disabled={!on} min={3} max={300} step={5} value={prefs.p2pGatherTimeoutSec}
              onChange={(v) => setPrefs({ p2pGatherTimeoutSec: typeof v === 'number' ? v : 30 })}
              addonAfter={t('settings.p2pTimeoutUnit')} style={{ width: 130 }}
            />
            <span style={hint}>{t('settings.p2pGatherHelp')}</span>
          </Space>
        </div>
        {/* P2P 最低速率(KB/s)：直连平均落盘速率长期低于此值就回退中转；0=不回退，永远坚持 P2P。 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)', opacity: on ? 1 : 0.5 }}>
          <span style={dim}>{t('settings.p2pMinSpeed')}</span>
          <Space align="center" wrap>
            <InputNumber
              disabled={!on} min={0} max={100000} step={50} value={prefs.p2pMinSpeedKBps}
              onChange={(v) => setPrefs({ p2pMinSpeedKBps: typeof v === 'number' && v >= 0 ? v : 200 })}
              addonAfter={t('settings.p2pMinSpeedUnit')} style={{ width: 150 }}
            />
            <span style={hint}>{t('settings.p2pMinSpeedHelp')}</span>
          </Space>
        </div>
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
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)' }}>
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
    // 切来源要连地址一起换：每种来源的目标地址各自独立(本地 redroid=loopback / 远程=待填 / 真机=默认设备)。
    // 否则从「本地 redroid」切到「真机」会把 localhost:5555 带过去，adb 一直连不存在的 loopback，真机被忽略→连不上。
    const changeSrc = (m: string) => patch(p, isA ? { mode: m, address: m === 'local' ? 'localhost:5555' : '' } : { mode: m, address: '' })
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
          {isA && c.mode !== 'device' && (
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
                  {st.connected ? (st.device || t('phone.connected')) : (st.error || t('phone.disconnected'))}
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

// 关于页：Logo / roam 版本号 / 检测更新（跳 release 页）/ GitHub 仓库链接
function AboutPage() {
  const { t } = useI18n()
  const { message } = AntApp.useApp()
  const [info, setInfo] = useState<{ version?: string; repo?: string }>({})
  const [checking, setChecking] = useState(false)
  const [latest, setLatest] = useState<{ tag: string; url: string; newer: boolean; failed?: boolean } | null>(null)
  useEffect(() => { api('GET', '/version').then((d: any) => setInfo(d?.data || {})).catch(() => {}) }, [])
  const repo = info.repo || 'ybz21/Roam'
  const releasesUrl = `https://github.com/${repo}/releases`
  // 走后端 /update-check（带缓存+优雅降级），避免浏览器直连 GitHub API 的限流/跨域/被墙问题
  const checkUpdate = async () => {
    setChecking(true); setLatest(null)
    try {
      const d = (await api('GET', '/update-check'))?.data || {}
      if (d.error || !d.latest) {
        setLatest({ tag: '', url: d.releases || releasesUrl, newer: false, failed: true })
        message.warning(t('about.checkFailed'))
      } else {
        setLatest({ tag: d.latest, url: d.url || d.releases || releasesUrl, newer: !!d.newer, failed: false })
      }
    } catch {
      setLatest({ tag: '', url: releasesUrl, newer: false, failed: true })
      message.error(t('about.checkFailed'))
    } finally { setChecking(false) }
  }
  return (
    <Card style={{ maxWidth: 520, margin: '0 auto' }}>
      <Space direction="vertical" size={18} align="center" style={{ width: '100%', padding: '28px 0' }}>
        <img src="/logo-mark.svg" width={72} height={72} alt="Roam" />
        <div style={{
          fontWeight: 800, fontSize: 28, letterSpacing: 0.5,
          background: 'var(--brand-grad)', WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent',
        }}>Roam</div>
        <p style={{ color: 'var(--text-dim)', fontSize: 13, lineHeight: 1.7, margin: 0, textAlign: 'left', maxWidth: 420 }}>
          {t('about.intro')}
        </p>
        <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          {t('settings.version')} <code>{info.version || '—'}</code>
        </div>
        <Space wrap style={{ justifyContent: 'center' }}>
          <Button loading={checking} onClick={checkUpdate}>{t('about.checkUpdate')}</Button>
          {latest?.failed && (
            <a href={latest.url} target="_blank" rel="noreferrer">
              <Button>{t('about.goReleases')}</Button>
            </a>
          )}
          {latest && !latest.failed && (latest.newer
            ? <a href={latest.url} target="_blank" rel="noreferrer">
                <Button type="primary">{t('about.newVersion', { tag: latest.tag })}</Button>
              </a>
            : <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>{t('about.upToDate')}</span>)}
        </Space>
        <a href={`https://github.com/${repo}`} target="_blank" rel="noreferrer"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--text-bright)', fontSize: 14 }}>
          {ICONS.github}<span>github.com/{repo}</span>
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
                  { label: <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><MoonIcon size={12} />{t('common.darkTheme')}</span>, value: 'dark' },
                  { label: <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><SunIcon size={12} />{t('common.lightTheme')}</span>, value: 'light' },
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
          <P2PCard />
          <Card title={t('install.settingsTitle')}>
            <Space align="center" wrap>
              {pwaInstalled
                ? <span style={{ color: 'var(--text-bright)', display: 'inline-flex', alignItems: 'center', gap: 5 }}><CheckIcon size={13} />{t('install.installed')}</span>
                : <Button type="primary" onClick={doInstall}>{t('install.button')}</Button>}
              <CertDownloadButton />
              <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('install.settingsHelp')}</span>
            </Space>
          </Card>
          {installGuide}
          <ChangePasswordCard />
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

// ── 修改登录口令：校验旧口令后写回 config.yaml，即时生效 ──
function ChangePasswordCard() {
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [form] = Form.useForm()
  return (
    <Card title={t('password.title')}>
      <Form form={form} layout="vertical" style={{ maxWidth: 360 }}
        onFinish={async (v) => {
          setBusy(true)
          try {
            await api('POST', '/password', { old: v.old, new: v.new })
            message.success(t('password.changed')); form.resetFields()
          } catch (e: any) {
            message.error(/BAD_PASSWORD/.test(e.message) ? t('password.badOld') : /WEAK_PASSWORD/.test(e.message) ? t('password.weak') : e.message)
          } finally { setBusy(false) }
        }}>
        <Form.Item name="old" label={t('password.old')} rules={[{ required: true, message: t('password.oldRequired') }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item name="new" label={t('password.new')} rules={[{ required: true, min: 6, message: t('password.weak') }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="confirm" label={t('password.confirm')} dependencies={['new']} rules={[
          { required: true, message: t('password.confirmRequired') },
          ({ getFieldValue }) => ({ validator(_, value) { if (!value || getFieldValue('new') === value) return Promise.resolve(); return Promise.reject(new Error(t('password.mismatch'))) } }),
        ]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={busy}>{t('password.submit')}</Button>
      </Form>
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
          <div style={{ padding: 16, background: 'var(--bg-base)', borderRadius: 'var(--r-sm)' }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ background: '#fff', padding: 10, borderRadius: 'var(--r-sm)' }}><QRCodeSVG value={setup.uri} size={168} /></div>
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
          <div style={{ padding: 16, background: 'var(--bg-base)', borderRadius: 'var(--r-sm)', display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ background: '#fff', padding: 10, borderRadius: 'var(--r-sm)' }}><QRCodeSVG value={qr.uri} size={168} /></div>
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
                    <a onClick={() => remove(f.name)} style={{ color: '#f85149', display: 'inline-flex' }}><CloseIcon size={13} /></a>
                  </Space>
                ))}
                <Button type="dashed" onClick={() => add()} block icon={<PlusIcon size={13} />}>{t('task.addRow')}</Button>
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
        options={(tasks || []).map((t: any) => ({ value: t.name, label: `${t.label || t.name} [${t.type}]` }))} />
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
      <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '60vh', overflow: 'auto', background: 'var(--bg-term)', padding: 12, borderRadius: 'var(--r-sm)', fontSize: 12.5 }}>{text}</pre>
    </Modal>
  )
}
