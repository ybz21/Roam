// 底部 sheet：手机档两个二级基元之一（13 设计 §4.3），另一个是已有的 MobileSubPage。
//
// 取代的是 antd `Dropdown` —— 它在底栏上方弹出的菜单项只有 32px 高、贴着屏幕边缘，
// 是全站最难点中的控件之一。sheet 的行高 ≥48，从底部升起，落在拇指弧内。
//
// 吃 --kb：键盘弹起时整块抬到键盘之上；吃安全区：底部不压在手势条下面。
// 层级用 --z-sheet / --z-scrim 两个令牌，不再手算 1199/1200/1201。
import { type ReactNode } from 'react'
import { useI18n } from '../i18n'
import { useBackDismiss } from './useBackDismiss'
import { CloseIcon } from '../icons'

export function MobileSheet({ open, title, onClose, children }: {
  open: boolean
  title: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  const { t } = useI18n()
  // 打开时接管返回：安卓物理返回键应该收 sheet，而不是退出整个页面。
  // （Escape 也由它一并处理——此前这里只监听了 Escape，而手机上没有 Escape 键。）
  useBackDismiss(open, onClose)

  if (!open) return null
  return (
    <>
      <button
        aria-label={t('common.close')}
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 'var(--z-scrim)' as unknown as number,
          border: 0, padding: 0, background: 'rgba(0,0,0,.5)',
          animation: 'tt-sheet-fade .18s ease',
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 'var(--z-sheet)' as unknown as number,
          maxHeight: '82%', display: 'flex', flexDirection: 'column',
          background: 'var(--bg-elevated)',
          borderTop: '1px solid var(--border)',
          borderRadius: 'var(--r-sheet) var(--r-sheet) 0 0',
          boxShadow: '0 -18px 48px rgba(0,0,0,.42)',
          // 键盘弹起时安全区被键盘盖住，两者取大而不是相加
          paddingBottom: 'max(var(--kb), var(--safe-b))',
          animation: 'tt-sheet-up .22s cubic-bezier(.22,.8,.3,1)',
        }}
      >
        <div style={{ display: 'grid', placeItems: 'center', padding: '8px 0 2px' }}>
          <i style={{ width: 36, height: 4, borderRadius: 99, background: 'var(--border)' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', padding: '6px 14px 10px' }}>
          <b style={{ fontSize: 15 }}>{title}</b>
          <button onClick={onClose} aria-label={t('common.close')}
            style={{
              marginLeft: 'auto', width: 'var(--tap)', height: 'var(--tap)',
              border: 0, background: 'none', color: 'var(--text-dim)', fontSize: 18, cursor: 'pointer',
            }}><CloseIcon size={14} /></button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 10px' }}>{children}</div>
      </div>
    </>
  )
}

/** sheet 里的一行：48px 高、整行可点，图标 + 主副文案（13 §4.1）。 */
export function SheetRow({ icon, title, desc, danger, active, extra, minHeight = 48, onClick }: {
  icon?: ReactNode
  title: ReactNode
  desc?: ReactNode
  danger?: boolean
  /** 当前项：淡强调底，与 hover 区分 */
  active?: boolean
  /** 行尾附加操作（如关闭）——自己 stopPropagation */
  extra?: ReactNode
  /** 会话切换这类"一屏看尽"的列表要 56（13 §4.2），默认 48 */
  minHeight?: number
  onClick: () => void
}) {
  return (
    <button onClick={onClick} style={{
      width: '100%', minHeight, padding: '8px 10px',
      display: 'flex', alignItems: 'center', gap: 12,
      border: 0, borderRadius: 12, cursor: 'pointer',
      background: active ? 'var(--accent-soft)' : 'transparent',
      color: danger ? '#f85149' : 'var(--text-bright)', textAlign: 'left',
    }}>
      {icon && <span style={{ flex: '0 0 20px', display: 'grid', placeItems: 'center', color: danger ? '#f85149' : 'var(--text-dim)' }}>{icon}</span>}
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 'var(--fs-body)' }}>{title}</span>
        {desc && <span style={{ display: 'block', marginTop: 2, color: 'var(--text-dim)', fontSize: 'var(--fs-meta)' }}>{desc}</span>}
      </span>
      {extra && <span style={{ marginLeft: 'auto', flex: '0 0 auto' }}>{extra}</span>}
    </button>
  )
}

/** 分组标题：把「工具」和「账户」断开，不让退出登录和浏览器并排（13 §4.1）。 */
export function SheetSection({ children }: { children: ReactNode }) {
  return (
    <div style={{
      padding: '12px 12px 6px', color: 'var(--text-dimmer)',
      fontSize: 11, fontWeight: 700, letterSpacing: '.1em',
    }}>{children}</div>
  )
}
