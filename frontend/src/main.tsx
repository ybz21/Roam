import React from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntApp } from 'antd'
import App from './App'
import { ThemeProvider } from './theme'
import './index.css'

// 主题(黑/白)统一收敛到 ThemeProvider：它内部按 mode 渲染 ConfigProvider + 写 data-theme。
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <AntApp>
        <App />
      </AntApp>
    </ThemeProvider>
  </React.StrictMode>,
)
