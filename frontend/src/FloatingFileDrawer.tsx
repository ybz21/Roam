import type { ReactNode } from 'react'

export default function FloatingFileDrawer({ open, children }: { open: boolean; children: ReactNode }) {
  if (!open) return null
  return (
    <div
      className="tt-file-drawer"
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        height: '100dvh',
        zIndex: 1200,
        width: 'min(420px, 92vw)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--bg-container)',
        borderLeft: '1px solid var(--border)',
        boxShadow: 'var(--elevated-shadow)',
        pointerEvents: 'auto',
      }}
    >
      {children}
    </div>
  )
}
