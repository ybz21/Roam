import React from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntApp } from 'antd'
import App from './App'
import { ThemeProvider } from './theme'
import { I18nProvider } from './i18n'
import './index.css'

// 注册 service worker：满足 PWA「添加到桌面」可安装条件 + 离线打开应用外壳。
// 仅在安全上下文(https / localhost)注册；/api 与 WebSocket 不被其拦截（见 public/sw.js）。
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}) })
}

// 安卓 Chrome 软键盘默认会压缩布局视口（把界面挤一下）。这里让虚拟键盘「悬浮覆盖」内容，
// 行为对齐 iOS；同时暴露 CSS env(keyboard-inset-height)，供输入区抬高到键盘之上（见 App.tsx）。
try {
  const vk = (navigator as any).virtualKeyboard
  if (vk) vk.overlaysContent = true
} catch { /* 不支持的浏览器忽略 */ }

// 主题(黑/白)统一收敛到 ThemeProvider：它内部按 mode 渲染 ConfigProvider + 写 data-theme。
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <AntApp>
          <App />
        </AntApp>
      </ThemeProvider>
    </I18nProvider>
  </React.StrictMode>,
)
