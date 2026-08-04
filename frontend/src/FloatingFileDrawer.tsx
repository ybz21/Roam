// 桌面右侧浮动面板：文件树 / Git 停靠在工作区右缘。
// 手机不走这里——那一档由 MobileSubPage 接管（13 §6），入口统一在 shell/AdaptivePanel。
import type { ReactNode } from 'react'

export default function FloatingFileDrawer({ open, children, right = 0, width = 'min(420px, 92vw)' }: {
  open: boolean
  children: ReactNode
  right?: number | string
  width?: number | string
}) {
  if (!open) return null
  return (
    <div
      className="tt-file-drawer"
      style={{
        position: 'fixed',
        top: 0,
        right,
        bottom: 0,
        height: '100dvh',
        // 具名层取代魔数 1200：压过 sheet(1000)，低于 antd 弹层基座(1300)
        zIndex: 'var(--z-panel)' as unknown as number,
        width,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--bg-container)',
        borderLeft: '1px solid var(--border)',
        boxShadow: 'var(--elevated-shadow)',
        paddingTop: 'var(--safe-t)',
        paddingBottom: 'var(--safe-b)',
        pointerEvents: 'auto',
      }}
    >
      {children}
    </div>
  )
}
