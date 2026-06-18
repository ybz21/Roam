// 主题（黑/白）切换：单一 mode 状态，持久化到 localStorage，并把 data-theme 写到 <html>，
// CSS 变量(index.css)与 Antd 算法(ConfigProvider)据此同步切换。
// 自定义内联色用 CSS 变量(var(--bg-base) 等)；Antd 派生色需具体值，故这里按 mode 给具体 token。
import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { ConfigProvider, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'

export type ThemeMode = 'dark' | 'light'
const KEY = 'ttmux-theme'

const ThemeCtx = createContext<{ mode: ThemeMode; toggle: () => void; setMode: (m: ThemeMode) => void }>({
  mode: 'dark', toggle: () => {}, setMode: () => {},
})
export const useThemeMode = () => useContext(ThemeCtx)

function buildTheme(mode: ThemeMode) {
  const dark = mode === 'dark'
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: '#58a6ff',
      borderRadius: 8, borderRadiusLG: 12, borderRadiusSM: 6,
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', Roboto, Helvetica, Arial, sans-serif",
      fontSize: 14, lineHeight: 1.6,
      colorBgBase: dark ? '#0d1117' : '#f6f8fa',
      colorBgContainer: dark ? '#161b22' : '#ffffff',
      colorBgElevated: dark ? '#1b222b' : '#ffffff',
      colorBgLayout: dark ? '#0d1117' : '#f6f8fa',
      colorBorder: dark ? '#2a313a' : '#d0d7de',
      colorBorderSecondary: dark ? '#21262d' : '#e6e9ec',
      boxShadowSecondary: dark ? '0 8px 24px rgba(1,4,9,0.5)' : '0 8px 24px rgba(140,149,159,0.18)',
      wireframe: false,
    },
    components: {
      Layout: dark
        ? { siderBg: '#0d1117', headerBg: '#161b22', bodyBg: '#0d1117' }
        : { siderBg: '#ffffff', headerBg: '#ffffff', bodyBg: '#f6f8fa' },
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
      Modal: { borderRadiusLG: 14, contentBg: dark ? '#161b22' : '#ffffff', headerBg: 'transparent' },
      Segmented: { borderRadius: 8, itemSelectedBg: '#1f6feb', itemSelectedColor: '#fff' },
      Tag: { borderRadiusSM: 6 },
      Tooltip: { borderRadius: 8 },
    },
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(() => {
    try { const v = localStorage.getItem(KEY); if (v === 'light' || v === 'dark') return v } catch {}
    return 'dark'
  })
  useEffect(() => {
    try { localStorage.setItem(KEY, mode) } catch {}
    document.documentElement.dataset.theme = mode
    document.documentElement.style.colorScheme = mode
  }, [mode])
  const toggle = () => setMode((m) => (m === 'dark' ? 'light' : 'dark'))
  return (
    <ThemeCtx.Provider value={{ mode, toggle, setMode }}>
      <ConfigProvider locale={zhCN} theme={buildTheme(mode)}>{children}</ConfigProvider>
    </ThemeCtx.Provider>
  )
}
