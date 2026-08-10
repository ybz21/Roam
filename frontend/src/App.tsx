// ttmux Web 控制台 — React + Vite + Antd（统一深色主题）
// 布局（见 docs/design/web/01-overview.md）：
//   电脑 ≥1200 → 三栏：导航 Sider | 列表(页面) | 终端面板(常驻, 多标签)
//   平板/手机   → 终端为全屏覆盖层；手机底部 Tab 导航
// 终端：多标签 / 字号调节 / 复制 / 更多快捷键 / 断线自动重连。
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { bootstrapCluster, setCurrentNode, useClusterNodes, useCurrentNodeId } from './cluster/node-url'
import { NodeMark, nodeDotColor } from './cluster/NodeMark'
import {
  Layout, Button, Card, List, Tag, Form, Input, Select, Segmented, Tabs, Descriptions,
  Statistic, Row, Col, Space, Popconfirm, Empty, Modal, App as AntApp, Typography, Spin, Tooltip, Dropdown, Checkbox, Progress, AutoComplete, Radio, Switch, Collapse, InputNumber,
} from 'antd'
import type { MenuProps } from 'antd'
import { api, setUnauthorizedHandler } from './api'
import Term, { TermHandle, TermStatus } from './Terminal'
import ClaudeChat from './ClaudeChat'
import CodexChat from './CodexChat'
import FileBrowser from './FileBrowser'
import FileWorkspace from './FileWorkspace'
import AdaptivePanel from './shell/AdaptivePanel'
import { InspectorColumn } from './shell/InspectorColumn'
import MobileSubPage from './MobileSubPage'
import SettingsPage from './settings/SettingsPage'
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
import UpdateBanner from './UpdateBanner'
import { useThemeMode } from './theme'
import { useI18n } from './i18n'
import { usePreferences, loadPreferences } from './preferences'
import { detectPrompt } from './prompt'
import type { PromptSignal } from './prompt'
import { useLayout } from './layout'
import { useWorkspaceLayout, NAV_WIDTH, NAV_RAIL } from './shell/useWorkspaceLayout'
import { Workspace, SessionCapsule } from './shell/Workspace'
import { Navigation } from './shell/Navigation'
import { reorderTabs } from './shell/tabs'
import { requestIntent, OPEN_FILE_INTENT } from './intents'
import { SessionDock } from './shell/SessionDock'
import { sessionProject, setSessionProjects, buildSessionProjects } from './session-project'
import { MobileSheet, SheetRow, SheetSection } from './shell/MobileSheet'
import { WorkspaceTopbar, type PaletteActions, type PaletteItem } from './shell/WorkspaceTopbar'
import { GlobalSearch, openPalette } from './shell/palette'
import { setSessionLabels, sessionLabel, sessionDisplay } from './session-label'
import LinkStatus from './p2p/LinkStatus'
import { startControlLink, stopControlLink } from './p2p/transport'
import FilesPage from './components/files/FilesPage'
import Login from './components/auth/Login'
import Sessions from './components/sessions/Sessions'
import Tasks from './components/tasks/Tasks'
import TerminalPane from './components/terminal/TerminalPane'
import SoloTerminal from './components/terminal/SoloTerminal'
import { ICONS, svg } from './components/nav-icons'
import { normalizeRoute, setHashParams, readTermTokens } from './route-hash'
import type { ClaudeInfo } from './components/terminal/claude-info'
import { SearchIcon } from './icons'

const { Sider, Content } = Layout
const { Text } = Typography

// 「蜂群」不进导航：项目页是唯一主入口（任务驱动，08 设计），蜂群从项目编队 tab 进
// （蜂群台深链 #/swarm/<名>）。
// 「会话」在 NAV 里但不进桌面侧栏两组：桌面从项目页进，命令面板能搜到；手机则**必须**
// 有个导航入口——搜索、筛选、Worktree 管理、新建竞赛全在那一页（13 §6）。
//
// 「概览」已并进项目页（18 设计）：两页画的是同一批项目卡、拉的是同一条 /projects，
// 概览独有的问候条/行动队列/活动轨现在挂在项目列表页顶上。旧链接由 normalizeRoute 接住。
const NAV = [
  { key: 'projects', labelKey: 'nav.projects' },
  { key: 'sessions', labelKey: 'nav.sessions' },
  { key: 'files', labelKey: 'nav.files' },
  { key: 'browser', labelKey: 'nav.browser' },
  { key: 'phone', labelKey: 'nav.phone' },
  { key: 'plugins', labelKey: 'nav.plugins' },
  { key: 'settings', labelKey: 'nav.env' },
]

// 桌面导航的两组（14 §4.4）。NAV 仍是全量注册表——命令面板和手机「更多」都从它取，
// 所以 settings 留在 NAV 里，只是不进这两组：它单独摆在侧栏底部（见 Navigation 的 settings）。
const NAV_WORKSPACE = ['projects', 'files']
const NAV_TOOLS = ['browser', 'phone', 'plugins']

// 手机底栏。13 §4.1 当初把「浏览器/手机镜像」折进「更多」，理由是低频且窄屏下几乎不可用
// （地址栏固定 150、设备选择器固定 240）——那两处固定宽度后来都改成自适应了，而这两页
// 恰恰是本机最常用的两个工具，藏在二级 sheet 里每次要点两下。现在放回底栏。
// 概览并进项目页后这里空出一格，不再补人：4 格 + 「更多」= 5 个按钮，390 宽下每格 78，
// 比原来 6 格的 65 宽出一截（13 §7.1 的命中区下限是 44，但相邻图标还要留够间隙）。
const MOBILE_NAV_KEYS = ['projects', 'files', 'browser', 'phone']
// 「更多」sheet 里的两段：会话属于工作区主线，不归到工具下面
const MOBILE_MORE_WORKSPACE = ['sessions']
const MOBILE_MORE_TOOLS = ['plugins', 'settings']
const MOBILE_MORE_KEYS = [...MOBILE_MORE_WORKSPACE, ...MOBILE_MORE_TOOLS]

// 用 Canvas 容器查询排版的页面（见 index.css 的 .tt-canvas[data-cq]）。逐页开，
// 不是全局开：container-type 会改变 fixed 后代的包含块。
const CQ_PAGES = new Set(['projects', 'sessions'])





export default function App() {
  // 多机：底座那枚按钮 + 账户菜单顶部的机器列表。单机时两者都为空，界面与今天一致。
  // **必须在任何提前 return 之前**——这个组件下面有 `if (!authed) return <Login/>` 这类分支，
  // 放到后面就是条件调用 hook，登录成功那一帧 hook 数量变化，React 直接抛 #310（踩过）。
  const clusterNodes = useClusterNodes()
  const curNodeId = useCurrentNodeId()
  const curNode = clusterNodes.find((n) => n.id === curNodeId) || null

  const [authed, setAuthed] = useState<boolean | null>(null)
  const [route, setRoute] = useState(() => normalizeRoute(location.hash.replace(/^#\/?/, '') || 'projects'))
  const tab = route.split('/')[0]                                  // 基础页（swarm/leave → swarm）
  const swarmSub = tab === 'swarm' && route.includes('/') ? decodeURIComponent(route.slice(route.indexOf('/') + 1)) : '' // 深链选中的蜂群
  const projectSub = tab === 'projects' && route.includes('/') ? decodeURIComponent(route.slice(route.indexOf('/') + 1)) : '' // 深链选中的项目
  const settingsSub = tab === 'settings' && route.includes('/') ? route.slice(route.indexOf('/') + 1) : '' // 设置的哪一类（node/browser）
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
    // **必须等 authed**：hooks 跑在下面 `return <Login/>` 那些提前 return 之前，
    // 不等就会在「登录确认 + 多机引导」之前把业务请求发出去——单机上那是一发 401
    // （被 401 处理器吞掉，看不见），在中心上是**没带 /n/<id> 前缀的 404**，
    // 而且没人会告诉你为什么。踩过。
    if (!authed) return
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
  }, [authed])

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

  // 启动：先确认登录态，**再**做多机引导，最后才放行渲染。
  //
  // 三步的顺序是踩出来的。引导要带登录态才问得出结果，所以不能跑在 /me 之前（只会拿 401）；
  // 而它又必须跑在任何业务请求之前，否则第一轮请求发的是 /api/*——在中心上那是 404，
  // 而且没人会告诉你为什么。中间那个「先当单机跑一轮再纠正」的窗口就是这么来的。
  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false))
    let alive = true
    void (async () => {
      try {
        await api('GET', '/me')
      } catch {
        if (alive) setAuthed(false)
        return
      }
      await bootstrapCluster()
      if (!alive) return
      setAuthed(true)
      loadPreferences()
      navigator.clipboard?.readText?.().catch(() => {})
    })()
    return () => { alive = false }
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
  // 登录成功后同样是「先引导、再放行」：不引导就渲染的话，第一轮业务请求会漏掉
  // /n/<id> 前缀。await 之后才 setAuthed，那个窗口就不存在了。
  if (!authed) {
    return <Login onOk={async () => {
      await bootstrapCluster()
      setAuthed(true); loadPreferences(); go('projects')
    }} />
  }

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
    swarm: <Swarm openTerm={openTerm} initialSwarm={swarmSub || undefined} onNav={(n) => { location.hash = n ? '#/swarm/' + encodeURIComponent(n) : '#/swarm' }} />,
    projects: <Projects openTerm={openTerm} closeTerm={closeTerm} initialKey={projectSub || undefined} activeTerm={active} />,
    sessions: <Sessions openTerm={openTerm} closeTerm={closeTerm} activeTerm={active} />,
    files: <FilesPage openTerm={openTerm} />,
    settings: <SettingsPage sub={settingsSub} onNav={(r) => go(r)} />,
    plugins: <PluginsPanel />,
    browser: <BrowserView />,
    phone: <PhoneView />,
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

  // 多机：机器列表接在账户菜单最上面（切机器是「换浏览范围」，不是页面）。
  // 单机时 nodes 为空，这一段整个不出现，菜单与今天逐项一致。
  // 顶部切换器的下拉：就是机器列表本身，不再套一层分组标题——它已经有自己的按钮当标题了
  const nodeItems: MenuProps['items'] = clusterNodes.length ? [
    ...clusterNodes.map((n) => ({
      key: 'node:' + n.id,
      icon: <NodeMark name={n.name} size="sm" current={n.id === curNodeId} offline={!n.online} />,
      label: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 168 }}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.name}</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--fs-micro)', color: 'var(--text-dimmer)' }}>
            {n.online ? t('node.latencyMs', { ms: n.latencyMs }) : t('node.offline')}
          </span>
          <i style={{ width: 7, height: 7, borderRadius: '50%', background: nodeDotColor(n) }} />
        </span>
      ),
      disabled: !n.online,
      // 切机器 = 换「浏览 / 新开操作落到哪台」。整页重载是这一版的取舍：页面各自缓存着
      // 上一台的数据，逐个清远比重来一次更容易漏。
      //
      // **必须先把 terms/active 从 URL 里摘掉**：它们是上一台机器的会话 id，原样带过去
      // 就会在新机器上还原一批根本不存在的标签——界面上表现为「一堆打不开的窗口」，
      // 而且同名会话还可能连到错的那台。终端真正的跨机保留要等会话键改成 (nodeId, name)，
      // 见设计稿；在那之前，切机器就是换一台机器的终端，不留残影。
      onClick: () => {
        setCurrentNode(n.id)
        setHashParams({ terms: '', active: '' })
        location.reload()
      },
    })),
  ] : []

  // 设置不在这里：它在侧栏底部有自己的入口，菜单里再放一条就是同一页两个门
  const accountMenu: MenuProps['items'] = [
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
            settings={{ key: 'settings', label: t('nav.env'), icon: ICONS.settings }}
            linkStatus={<LinkStatus collapsed={navRail} />}
            accountName={t('nav.thisDevice')}
            account={accountMenu}
            nodeMenu={nodeItems}
            node={curNode ? {
              name: curNode.name,
              // 切换器那枚**不涂蓝**：它永远是当前机器，`current` 那层高亮不传递任何信息，
              // 只会和别处的蓝撞成两块「选中」。蓝留给下拉列表里区分「哪台是当前」，
              // 那里才有对比对象。
              mark: <NodeMark name={curNode.name} size="sm" />,
              dot: nodeDotColor(curNode),
              latency: curNode.online ? t('node.latencyMs', { ms: curNode.latencyMs }) : t('node.offline'),
            } : null}
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
            splitCapable={space.splitCapable}
            onToggleDock={() => { space.setFocus('none'); space.toggleDock() }}
            onExitFocus={() => space.setFocus('none')}
            inspectorCollapsed={space.inspectorCollapsed}
            onToggleInspector={space.toggleInspectorCollapsed}
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
                onReset={space.resetInspectorWidth}
                collapsed={space.inspectorCollapsed} onToggleCollapsed={space.toggleInspectorCollapsed} />
            )}
          </div>
        )}
      </Layout>

      {/* 底栏 6 格 + 会话坞（13 §4.1/§4.2）：概览/项目/文件/浏览器/手机 + 更多。
          360px 下每格 60px，标签 11px 单行截断——所以格数到此为止，再加就只剩图标了。
          「更多」sheet 仍分「工具 / 账户」两段：退出登录和功能页并排时误触代价差了几个
          数量级，所以它收在账户行的二级里。*/}
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
              <button key={n.key} onClick={() => go(n.key)} className="tt-bottomnav-btn"
                style={{ color: tab === n.key ? 'var(--accent)' : 'var(--text-dim)' }}>
                {ICONS[n.key]}<span>{t(n.labelKey)}</span>
              </button>
            )
          })}
          <button onClick={() => setMoreOpen(true)} className="tt-bottomnav-btn"
            style={{ color: MOBILE_MORE_KEYS.includes(tab) ? 'var(--accent)' : 'var(--text-dim)' }}>
            {svg(<><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>)}<span>{t('common.more')}</span>
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



