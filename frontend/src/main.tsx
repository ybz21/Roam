import React from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntApp } from 'antd'
import App from './App'
import { ThemeProvider } from './theme'
import { I18nProvider } from './i18n'
import { spike, verify } from './p2p/download'
import { roamP2PEcho } from './p2p/transport'
import './index.css'

// [临时/仅开发] P2P 直连的控制台自测入口（不接产品 UI，避免触发 i18n 规范）：
//   window.roamP2PSpike()             // transport 自测：收随机字节流丢弃，只统计吞吐
//   window.roamP2PSpike('/abs/path')  // 指定路径
//   await window.roamP2PVerify('/abs/path')  // 完整性冒烟：走完整协商，收进 Blob，
//                                            // 打印 size + sha256（绕过 picker，供自动化对比）
//   await window.roamP2PEcho()        // 通用传输 Phase 1a：经 control PC connect('echo') 测往返
// dev-gate：仅开发构建挂载，生产不暴露这些调试钩子（合并前清理）。
if (import.meta.env.DEV) {
  ;(window as any).roamP2PSpike = spike
  ;(window as any).roamP2PVerify = verify
  ;(window as any).roamP2PEcho = roamP2PEcho
}

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
