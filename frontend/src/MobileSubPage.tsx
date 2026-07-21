// 移动端二级页：Android Fragment 式全屏覆盖层——列表页点某项后，详情在上层整页展开。
// 传 title 则带「← 返回 + 标题」顶栏；不传则无顶栏（内容自带返回入口，如 FileView 的 onBack）。
// z-index 90：盖过底部导航(50)，低于全屏会话覆盖层(100)与 antd 弹层(≥1000)。
import { type ReactNode } from 'react'
import { useI18n } from './i18n'

export default function MobileSubPage({ title, onBack, children }: {
  title?: ReactNode
  onBack: () => void
  children: ReactNode
}) {
  const { t } = useI18n()
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 90, background: 'var(--bg-base)',
      display: 'flex', flexDirection: 'column', paddingTop: 'env(safe-area-inset-top)',
    }}>
      {title !== undefined && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', borderBottom: '1px solid var(--border)', background: 'var(--bg-container)' }}>
          <button onClick={onBack} title={t('common.back')} style={{ border: 0, background: 'none', color: 'var(--text-bright)', padding: '6px 10px', display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  )
}
