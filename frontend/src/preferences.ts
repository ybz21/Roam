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
  _migrated: boolean
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
    cache = { ...DEFAULTS, ...r?.data }
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
