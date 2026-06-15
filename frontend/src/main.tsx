import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, theme, App as AntApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#58a6ff',
          borderRadius: 8,
          // 统一深黑主题
          colorBgBase: '#0d1117',
          colorBgContainer: '#161b22',
          colorBgElevated: '#161b22',
          colorBgLayout: '#0d1117',
          colorBorder: '#30363d',
          colorBorderSecondary: '#21262d',
        },
        components: {
          Layout: { siderBg: '#0d1117', headerBg: '#161b22', bodyBg: '#0d1117' },
          Menu: {
            darkItemBg: 'transparent',
            darkItemSelectedBg: 'rgba(88,166,255,0.16)',
            darkItemSelectedColor: '#58a6ff',
            darkItemHoverBg: 'rgba(255,255,255,0.04)',
            itemBorderRadius: 8,
            itemHeight: 42,
            itemMarginInline: 8,
          },
        },
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
)
