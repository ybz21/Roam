import { useSyncExternalStore } from 'react'
import { api } from './api'

export interface Preferences {
  theme: 'dark' | 'light'
  locale: string
  browserQuality: string
  browserDevice: string
  browserRotate: string
  promptPopupOff: boolean
  recentDirs: string[]
  claudeCommand: string
  codexCommand: string
  quickCommands: string[]
  showVoiceButton: boolean
  overviewTab: 'projects' | 'sessions' // 概览页 项目/会话 切换 tab，记住上次选择
  p2pEnabled: boolean // P2P 直连总开关（实验性，默认关）；关闭后 下载/镜像等一律走 frp 中转
  p2pStunServers: string // 逗号分隔的 STUN 服务器；留空用服务端默认（/api/p2p/config）。仅影响本浏览器
  p2pConnectTimeoutSec: number // 打洞建链超时（秒），超时回退 frp。默认 30
  p2pGatherTimeoutSec: number // ICE 候选收集上限（秒）：等 srflx 等这么久，慢网(手机蜂窝)可调大。默认 30
  p2pMinSpeedKBps: number // P2P 直连测速回退阈值(KB/s)：平均落盘速率长期低于此值就回退 frp；0=禁用，永远坚持 P2P。默认 200
  workspace: WorkspacePreference // 工作区外壳偏好（13/14 设计共用一份，见下）
  _migrated: boolean
}

/**
 * 工作区外壳偏好（14 §9.3 + 13 §9）。**四档共用一份，不按端各存一套**——
 * 但恢复时按当前档钳制：手机记的方向簇左手位不该影响桌面，桌面记的 Dock 宽度
 * 也不该被手机读出来当布局用。
 */
export interface WorkspacePreference {
  navCollapsed: boolean // 桌面侧栏收成 64px 轨
  dockOpen: boolean // 终端区是否展开
  dockWidth: number // 终端区宽度 px；恢复时按当前视口钳制，旧大屏宽度不挤爆新窗口
  workspaceFocus: 'none' | 'page' | 'dock' // 单区聚焦
  density: 'cozy' | 'compact' // 信息密度，与窗口档正交
  dpadOn: boolean // 手机方向簇
  dpadSide: 'left' | 'right' // 方向簇落在哪只手
  dpadHintSeen: boolean // 方向簇的一次性说明看过没
}

const WORKSPACE_DEFAULTS: WorkspacePreference = {
  navCollapsed: false,
  dockOpen: true,
  dockWidth: 0, // 0 = 还没拖过，用该档默认（clamp(480, 42vw, 880)）
  workspaceFocus: 'none',
  density: 'cozy',
  dpadOn: true,
  dpadSide: 'right',
  dpadHintSeen: false,
}

const DEFAULTS: Preferences = {
  theme: 'dark',
  locale: 'zh-CN',
  browserQuality: 'auto',
  browserDevice: '',
  browserRotate: '0',
  promptPopupOff: false,
  recentDirs: [],
  claudeCommand: 'claude',
  codexCommand: 'codex',
  quickCommands: [],
  showVoiceButton: true,
  overviewTab: 'projects',
  p2pEnabled: false, // 实验性：待真实跨网/Android/iOS 验收后再默认开
  p2pStunServers: '',
  p2pConnectTimeoutSec: 30,
  p2pGatherTimeoutSec: 30,
  p2pMinSpeedKBps: 200,
  workspace: WORKSPACE_DEFAULTS,
  _migrated: false,
}

let cache: Preferences = { ...DEFAULTS }
let listeners = new Set<() => void>()
let loaded = false

function notify() {
  listeners.forEach((l) => l())
}

function migrateFromLocalStorage() {
  try {
    const theme = localStorage.getItem('ttmux-theme')
    if (theme === 'dark' || theme === 'light') cache.theme = theme

    const locale = localStorage.getItem('ttmux-locale')
    if (locale) {
      const lower = locale.toLowerCase()
      if (lower === 'zh-cn' || lower === 'zh') cache.locale = 'zh-CN'
      else if (lower === 'en-us' || lower.startsWith('en')) cache.locale = 'en-US'
    }

    const quality = localStorage.getItem('ttmux.browser.quality')
    if (quality) cache.browserQuality = quality

    const device = localStorage.getItem('ttmux.browser.device')
    if (device !== null) cache.browserDevice = device

    const rotate = localStorage.getItem('ttmux.browser.rotate')
    if (rotate) cache.browserRotate = rotate

    try {
      const dirs = JSON.parse(localStorage.getItem('ttmux_recent_dirs') || '[]')
      if (Array.isArray(dirs)) cache.recentDirs = dirs.slice(0, 8)
    } catch {}
  } catch {}

  cache._migrated = true
  api('PUT', '/preferences', cache).catch(() => {})
}

export async function loadPreferences() {
  try {
    const r = await api('GET', '/preferences')
    // workspace 是嵌套对象：整体展开会让服务端存的旧结构缺字段变 undefined，单独深合一层
    cache = { ...DEFAULTS, ...r?.data, workspace: { ...WORKSPACE_DEFAULTS, ...r?.data?.workspace } }
    if (!cache._migrated) {
      migrateFromLocalStorage()
    }
    loaded = true
    notify()
  } catch {
    // server unreachable: keep defaults, localStorage still works as fallback
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

export function savePreferences(partial: Partial<Preferences>) {
  cache = { ...cache, ...partial }
  notify()
  // debounce server writes to avoid rapid-fire PUTs
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    api('PUT', '/preferences', cache).catch(() => {})
    saveTimer = null
  }, 300)
}

/** 只改工作区偏好的某几项，其余保留（savePreferences 会整块替换嵌套对象）。 */
export function saveWorkspace(partial: Partial<WorkspacePreference>) {
  savePreferences({ workspace: { ...cache.workspace, ...partial } })
}

export function getPreferences(): Preferences {
  return cache
}

export function preferencesLoaded(): boolean {
  return loaded
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function getSnapshot(): Preferences {
  return cache
}

export function usePreferences(): [Preferences, typeof savePreferences] {
  const prefs = useSyncExternalStore(subscribe, getSnapshot)
  return [prefs, savePreferences]
}
