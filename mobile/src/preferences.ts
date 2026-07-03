import type { Locale } from './i18n'
import type { Preferences } from './types'

export const DEFAULT_PREFERENCES: Preferences = {
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
  _migrated: true,
}

export function mergePreferences(remote: Partial<Preferences> | null | undefined, locale: Locale): Preferences {
  const merged = { ...DEFAULT_PREFERENCES, ...remote }
  merged.locale = merged.locale === 'en-US' || merged.locale === 'zh-CN' ? merged.locale : locale
  merged.theme = merged.theme === 'light' ? 'light' : 'dark'
  merged.quickCommands = Array.isArray(merged.quickCommands) ? merged.quickCommands : []
  merged.recentDirs = Array.isArray(merged.recentDirs) ? merged.recentDirs : []
  return merged
}
