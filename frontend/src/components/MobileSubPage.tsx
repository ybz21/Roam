// 移动端二级页：Android Fragment 式全屏覆盖层——列表页点某项后，详情在上层整页展开。
// 传 title 则带「← 返回 + 标题」顶栏；不传则无顶栏（内容自带返回入口，如 FileView 的 onBack）。
//
// 三件事是这一层的契约（13 §4.3 / §8.1）：
//   ① **portal 到 body**。开了容器查询的页面（`.tt-canvas[data-cq="on"]`）上，
//      `container-type` 会让 canvas 成为 fixed 后代的包含块——不 portal 的话，
//      从那种页面里唤起的二级页会被裁进 canvas 而不是铺满视口。
//   ② **四边吃安全区**，底部再与软键盘取大：`max(var(--kb), var(--safe-b))`。
//      iOS Safari 没有 VirtualKeyboard API，--kb 只能从 visualViewport 推，所以取大
//      而不是相加，键盘收起时至少还留安全区。
//   ③ **接管返回键**：安卓物理返回应该收掉这一层，而不是把整个路由退掉。
// 层级：--z-subpage(90) 盖过底栏(50)；从会话全屏(100)里唤起时传 layer="session"
// 换成 --z-session-sub(110)，否则 portal 之后不再嵌套在会话那个层叠上下文里，会被盖住。
import { type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../i18n'
import { useBackDismiss } from './shell/useBackDismiss'

export default function MobileSubPage({ title, onBack, layer = 'page', children }: {
  title?: ReactNode
  onBack: () => void
  /** 'session' = 从会话全屏覆盖层里唤起（Git / 文件） */
  layer?: 'page' | 'session'
  children: ReactNode
}) {
  const { t } = useI18n()
  useBackDismiss(true, onBack)

  const node = (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--bg-base)',
      zIndex: `var(${layer === 'session' ? '--z-session-sub' : '--z-subpage'})` as unknown as number,
      display: 'flex', flexDirection: 'column',
      paddingTop: 'var(--safe-t)', paddingLeft: 'var(--safe-l)', paddingRight: 'var(--safe-r)',
      paddingBottom: 'max(var(--kb), var(--safe-b))',
    }}>
      {title !== undefined && (
        <div style={{
          flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 2,
          padding: 'var(--sp-1)', borderBottom: '1px solid var(--border)', background: 'var(--bg-container)',
        }}>
          <button onClick={onBack} title={t('common.back')} aria-label={t('common.back')} style={{
            width: 'var(--tap)', height: 'var(--tap)', flex: '0 0 auto',
            border: 0, background: 'none', color: 'var(--text-bright)',
            display: 'grid', placeItems: 'center', cursor: 'pointer',
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <div style={{
            flex: 1, minWidth: 0, fontSize: 'var(--fs-body)', fontWeight: 600,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{title}</div>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  )
  return typeof document === 'undefined' ? node : createPortal(node, document.body)
}
