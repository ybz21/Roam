// 主题（黑/白）切换：单一 mode 状态，持久化到 localStorage。
// 所有应用级颜色从 THEME_TOKENS 出发，同时喂给 CSS 变量和 Antd ConfigProvider。
// 组件只使用 var(--...) 或语义常量，不再各自判断黑白主题。
import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { ConfigProvider, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import { useI18n } from './i18n'
import { usePreferences, savePreferences } from './preferences'

export type ThemeMode = 'dark' | 'light'
const KEY = 'ttmux-theme'
const FONT_FAMILY = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', Roboto, Helvetica, Arial, sans-serif"

type ThemeTokens = {
  css: Record<string, string>
  antd: {
    bgBase: string
    bgContainer: string
    bgElevated: string
    bgLayout: string
    border: string
    borderSecondary: string
    shadowSecondary: string
  }
}

export const THEME_TOKENS: Record<ThemeMode, ThemeTokens> = {
  dark: {
    css: {
      '--bg-base': '#0d1117',
      '--bg-container': '#161b22',
      '--bg-elevated': '#1b222b',
      '--bg-term': '#06090d',
      '--border': '#30363d',
      '--border-subtle': '#21262d',
      '--text-bright': '#e6edf3',
      '--text-dim': '#8b949e',
      '--text-dimmer': '#6e7681',
      '--brand-grad': 'linear-gradient(180deg, #f5f7fa 0%, #c3c9d1 46%, #9aa1ab 56%, #e7ebef 100%)',
      '--list-hover': 'rgba(255, 255, 255, .025)',
      '--scroll-thumb': '#2a313a',
      '--scroll-thumb-hover': '#3d444d',
      '--card-hover-shadow': '0 8px 24px rgba(1, 4, 9, .5)',
      '--elevated-shadow': '0 16px 48px rgba(1, 4, 9, .55)',
      '--xterm-bg': '#06090d',
      '--xterm-fg': '#e6edf3',
      '--hl-comment': '#8b949e',
      '--hl-keyword': '#ff7b72',
      '--hl-string': '#a5d6ff',
      '--hl-number': '#79c0ff',
      '--hl-title': '#d2a8ff',
      '--hl-attr': '#7ee787',
      '--hl-built': '#ffa657',
    },
    antd: {
      bgBase: '#0d1117',
      bgContainer: '#161b22',
      bgElevated: '#1b222b',
      bgLayout: '#0d1117',
      border: '#2a313a',
      borderSecondary: '#21262d',
      shadowSecondary: '0 8px 24px rgba(1,4,9,0.5)',
    },
  },
  light: {
    css: {
      '--bg-base': '#f6f8fa',
      '--bg-container': '#ffffff',
      '--bg-elevated': '#ffffff',
      '--bg-term': '#ffffff',
      '--border': '#d0d7de',
      '--border-subtle': '#e6e9ec',
      '--text-bright': '#1f2328',
      '--text-dim': '#57606a',
      '--text-dimmer': '#8c959f',
      '--brand-grad': 'linear-gradient(180deg, #2c333b 0%, #1f2328 100%)',
      '--list-hover': 'rgba(27, 31, 36, .04)',
      '--scroll-thumb': '#c9d1d9',
      '--scroll-thumb-hover': '#aab1b9',
      '--card-hover-shadow': '0 8px 24px rgba(140, 149, 159, .18)',
      '--elevated-shadow': '0 16px 48px rgba(140, 149, 159, .22)',
      '--xterm-bg': '#ffffff',
      '--xterm-fg': '#1f2328',
      '--hl-comment': '#6e7781',
      '--hl-keyword': '#cf222e',
      '--hl-string': '#0a3069',
      '--hl-number': '#0550ae',
      '--hl-title': '#8250df',
      '--hl-attr': '#116329',
      '--hl-built': '#953800',
    },
    antd: {
      bgBase: '#f6f8fa',
      bgContainer: '#ffffff',
      bgElevated: '#ffffff',
      bgLayout: '#f6f8fa',
      border: '#d0d7de',
      borderSecondary: '#e6e9ec',
      shadowSecondary: '0 8px 24px rgba(140,149,159,0.18)',
    },
  },
}

const ThemeCtx = createContext<{ mode: ThemeMode; toggle: () => void; setMode: (m: ThemeMode) => void }>({
  mode: 'dark', toggle: () => {}, setMode: () => {},
})
export const useThemeMode = () => useContext(ThemeCtx)

function buildTheme(mode: ThemeMode) {
  const dark = mode === 'dark'
  const t = THEME_TOKENS[mode].antd
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: '#58a6ff',
      borderRadius: 8, borderRadiusLG: 12, borderRadiusSM: 6,
      fontFamily: FONT_FAMILY,
      fontSize: 14, lineHeight: 1.6,
      colorBgBase: t.bgBase,
      colorBgContainer: t.bgContainer,
      colorBgElevated: t.bgElevated,
      colorBgLayout: t.bgLayout,
      colorBorder: t.border,
      colorBorderSecondary: t.borderSecondary,
      boxShadowSecondary: t.shadowSecondary,
      wireframe: false,
    },
    components: {
      Layout: dark
        ? { siderBg: t.bgBase, headerBg: t.bgContainer, bodyBg: t.bgBase }
        : { siderBg: t.bgContainer, headerBg: t.bgContainer, bodyBg: t.bgLayout },
      Menu: dark ? {
        darkItemBg: 'transparent', darkItemSelectedBg: 'rgba(88,166,255,0.16)',
        darkItemSelectedColor: '#58a6ff', darkItemHoverBg: 'rgba(255,255,255,0.04)',
        itemBorderRadius: 8, itemHeight: 42, itemMarginInline: 8,
      } : {
        itemBg: 'transparent', itemSelectedBg: 'rgba(31,111,235,0.10)',
        itemSelectedColor: '#1f6feb', itemHoverBg: 'rgba(31,111,235,0.06)',
        itemBorderRadius: 8, itemHeight: 42, itemMarginInline: 8,
      },
      Card: { borderRadiusLG: 12, paddingLG: 18, headerFontSize: 15 },
      Button: { fontWeight: 500, primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none' },
      Modal: { borderRadiusLG: 14, contentBg: t.bgContainer, headerBg: 'transparent' },
      Segmented: { borderRadius: 8, itemSelectedBg: '#1f6feb', itemSelectedColor: '#fff' },
      Tag: { borderRadiusSM: 6 },
      Tooltip: { borderRadius: 8 },
    },
  }
}

function applyCssVars(mode: ThemeMode) {
  const root = document.documentElement
  root.dataset.theme = mode
  root.style.colorScheme = mode
  for (const [key, value] of Object.entries(THEME_TOKENS[mode].css)) {
    root.style.setProperty(key, value)
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { locale } = useI18n()
  const [prefs] = usePreferences()
  const [mode, setModeLocal] = useState<ThemeMode>(() => {
    try { const v = localStorage.getItem(KEY); if (v === 'light' || v === 'dark') return v } catch {}
    return 'dark'
  })
  useEffect(() => {
    if (prefs.theme && (prefs.theme === 'dark' || prefs.theme === 'light')) setModeLocal(prefs.theme)
  }, [prefs.theme])
  useLayoutEffect(() => { applyCssVars(mode) }, [mode])
  const setMode = (m: ThemeMode) => {
    setModeLocal(m)
    savePreferences({ theme: m })
    try { localStorage.setItem(KEY, m) } catch {}
  }
  const toggle = () => setMode(mode === 'dark' ? 'light' : 'dark')
  return (
    <ThemeCtx.Provider value={{ mode, toggle, setMode }}>
      <ConfigProvider locale={locale === 'en-US' ? enUS : zhCN} theme={buildTheme(mode)}>{children}</ConfigProvider>
    </ThemeCtx.Provider>
  )
}
