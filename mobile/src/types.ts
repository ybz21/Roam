import type { Locale } from './i18n'

export interface BackendProfile {
  origin: string
  label: string
  lastUsedAt: number
}

export interface Preferences {
  theme: 'dark' | 'light'
  locale: Locale
  browserQuality: string
  browserDevice: string
  browserRotate: string
  promptPopupOff: boolean
  recentDirs: string[]
  claudeCommand: string
  codexCommand: string
  quickCommands: string[]
  showVoiceButton: boolean
  _migrated: boolean
}

export interface SessionInfo {
  name: string
  created?: string | number
  last_activity?: string | number
  attached?: string | number | boolean
  windows?: string | number
  [key: string]: unknown
}

export type TabKey = 'sessions' | 'preferences' | 'settings'

export interface PushRegistrationState {
  status: 'idle' | 'ready' | 'denied' | 'missingProject' | 'unavailable' | 'error'
  token?: string
  error?: string
}
