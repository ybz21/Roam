// 一棵组件树，两种容器（13 §6）。
//
// Git 面板和 Worktree 在手机上一直是桌面抽屉：420/520 的浮层压在底栏上、不吃安全区、
// 返回键不认它。但面板本体（GitPanel / WorktreePanel）没有问题，问题全在**容器**——
// 所以这里只换壳：手机档给 MobileSubPage（整页 + ← + 返回键），桌面维持原样。
//
// 桌面两种形态都要保留，它们的差别是历史形成的、也确实合理：
//   floating —— 会话页/项目页的 Git，停在右缘，不遮挡左边正在看的内容；
//   drawer   —— Worktree，antd Drawer，层级要压过 floating 面板（它可以从 Git 里唤起）。
import { type ReactNode } from 'react'
import { Drawer } from 'antd'
import { useLayout } from '../layout'
import MobileSubPage from '../MobileSubPage'
import FloatingFileDrawer from '../FloatingFileDrawer'

export default function AdaptivePanel({
  open, title, onClose, desktop, width, right, scrim, zIndex, drawerStyles, layer, children,
}: {
  open: boolean
  /** 手机二级页的页头标题；桌面的 floating 形态不用它（面板自带头） */
  title: ReactNode
  onClose: () => void
  desktop: 'floating' | 'drawer'
  width?: number | string
  /** floating：距右缘的偏移（文件抽屉已经占了右边时往左让） */
  right?: number | string
  /** floating：是否带点击关闭的遮罩 */
  scrim?: boolean
  zIndex?: number
  drawerStyles?: Record<string, any>
  /** 'session' = 从会话全屏覆盖层里唤起，手机档要换更高的层 */
  layer?: 'page' | 'session'
  children: ReactNode
}) {
  const { phone } = useLayout()
  if (!open) return null

  if (phone) {
    return <MobileSubPage title={title} onBack={onClose} layer={layer}>{children}</MobileSubPage>
  }

  if (desktop === 'drawer') {
    return (
      <Drawer open={open} onClose={onClose} title={title} width={width} zIndex={zIndex} styles={drawerStyles}>
        {children}
      </Drawer>
    )
  }

  return (
    <>
      {scrim && (
        <div onClick={onClose} style={{
          position: 'fixed', inset: 0, background: 'rgba(1,4,9,.6)',
          zIndex: 'var(--z-scrim)' as unknown as number,
        }} />
      )}
      <FloatingFileDrawer open={open} right={right} width={width}>{children}</FloatingFileDrawer>
    </>
  )
}
