// 设置 › 外观 里的「全屏 / 退出登录」：原来挂在侧栏脚「当前设备」那枚账户菜单里（22 设计 §3.2 拍板：
// 侧栏脚只留 设置 / 收起，账户那几项并进设置页）。关于页本来就在设置里，主题也在，这里只补剩下两个。
import { useEffect, useState } from 'react'
import { Button, Modal, Space } from 'antd'
import { useI18n } from '../../i18n'
import { ExitFullscreenIcon, FullscreenIcon, LogoutIcon } from '../../icons'

export function AccountActions({ onLogout }: { onLogout?: () => void }) {
  const { t } = useI18n()
  const [fs, setFs] = useState(false)
  useEffect(() => {
    const on = () => setFs(!!(document.fullscreenElement || (document as any).webkitFullscreenElement))
    on()
    document.addEventListener('fullscreenchange', on)
    document.addEventListener('webkitfullscreenchange', on)
    return () => {
      document.removeEventListener('fullscreenchange', on)
      document.removeEventListener('webkitfullscreenchange', on)
    }
  }, [])
  // 全屏切换（标准 API + webkit 兜底）。不支持的浏览器（如 iOS Safari）不画按钮
  const docEl: any = typeof document !== 'undefined' ? document.documentElement : null
  const supported = !!(docEl && (docEl.requestFullscreen || docEl.webkitRequestFullscreen))
  const toggle = () => {
    const doc: any = document
    if (doc.fullscreenElement || doc.webkitFullscreenElement) (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc)
    else (docEl.requestFullscreen || docEl.webkitRequestFullscreen)?.call(docEl)
  }
  return (
    <Space wrap>
      {supported && (
        <Button icon={fs ? <ExitFullscreenIcon size={14} /> : <FullscreenIcon size={14} />} onClick={toggle}>
          {fs ? t('common.exitFullscreen') : t('common.fullscreen')}
        </Button>
      )}
      {onLogout && (
        <Button danger icon={<LogoutIcon size={14} />} onClick={() => Modal.confirm({
          title: t('common.logoutConfirm'), okText: t('common.logout'), cancelText: t('common.cancel'),
          okButtonProps: { danger: true }, onOk: onLogout,
        })}>{t('common.logout')}</Button>
      )}
    </Space>
  )
}
