import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'
import { usePreferences, savePreferences } from '../preferences'

export type Locale = 'zh-CN' | 'en-US'
type Dict = Record<string, string>

const STORAGE_KEY = 'ttmux-locale'
const SUPPORTED: Locale[] = ['zh-CN', 'en-US']
const DICTS: Record<Locale, Dict> = { 'zh-CN': zhCN, 'en-US': enUS }

type I18nValue = {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}

const I18nCtx = createContext<I18nValue>({
  locale: 'zh-CN',
  setLocale: () => {},
  t: (key) => key,
})

function normalizeLocale(value: string | null | undefined): Locale | null {
  if (!value) return null
  const lower = value.toLowerCase()
  if (lower === 'zh-cn' || lower === 'zh') return 'zh-CN'
  if (lower === 'en-us' || lower.startsWith('en')) return 'en-US'
  return null
}

function detectLocale(): Locale {
  try {
    const saved = normalizeLocale(localStorage.getItem(STORAGE_KEY))
    if (saved) return saved
  } catch {}
  const langs = typeof navigator === 'undefined' ? [] : [navigator.language, ...(navigator.languages || [])]
  for (const lang of langs) {
    const normalized = normalizeLocale(lang)
    if (normalized && SUPPORTED.includes(normalized)) return normalized
  }
  return 'zh-CN'
}

function interpolate(template: string, vars?: Record<string, string | number>) {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`))
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [prefs] = usePreferences()
  const [locale, setLocaleState] = useState<Locale>(detectLocale)

  useEffect(() => {
    const synced = normalizeLocale(prefs.locale)
    if (synced) setLocaleState(synced)
  }, [prefs.locale])

  const value = useMemo<I18nValue>(() => {
    const setLocale = (next: Locale) => {
      setLocaleState(next)
      savePreferences({ locale: next })
      try { localStorage.setItem(STORAGE_KEY, next) } catch {}
      document.documentElement.lang = next
    }
    const t = (key: string, vars?: Record<string, string | number>) => {
      const template = DICTS[locale][key] ?? DICTS['zh-CN'][key] ?? key
      return interpolate(template, vars)
    }
    return { locale, setLocale, t }
  }, [locale])

  document.documentElement.lang = locale

  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>
}

export function useI18n() {
  return useContext(I18nCtx)
}
