// 左边栏全局 P2P 链路状态（设计 §3）。
//
// 反映会话主连接（control PC）状态：
//   connecting → 「连接中」（灰）
//   connected  → 「直连 · <path 标签>」（绿）
//   relay      → 「中转」（琥珀）
//   disabled   → 隐藏（未启用/偏好关）
// 点开详情浮层：control / media（镜像）/ file（文件）三条链路各自 path。
//
// 数据源：信令 link 消息 → transport.ts 的 store（subscribeLink/getLinkStatus）。
// 图标为内联 SVG「P2P 双节点」logo（无 emoji），颜色随状态变。

import { useState, useSyncExternalStore } from 'react'
import { useI18n } from '../i18n'
import { pathLabelKey } from './labels'
import { subscribeLink, getLinkStatus, type LinkState } from './transport'

function useLinkStatus() {
  return useSyncExternalStore(subscribeLink, getLinkStatus, getLinkStatus)
}

// 子链路（media 镜像 / file 文件）状态行的 i18n key。
const SUBLINK_STATE_KEY: Record<LinkState, string> = {
  disabled: 'p2p.link.sub.idle',
  connecting: 'p2p.link.sub.connecting',
  connected: 'p2p.link.sub.connected',
  relay: 'p2p.link.sub.relay',
}

// 侧边栏 P2P logo：两个节点 + 直连横线（P2P 直连语义）。relay 时中间加一个中转节点。
// 颜色随状态由外部传入（字体也带同色）。
function P2PLogo({ color, relay = false, size = 15 }: { color: string; relay?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden style={{ flex: '0 0 auto' }}>
      <line x1="6" y1="12" x2="18" y2="12" stroke={color} strokeWidth="2" strokeLinecap="round"
        strokeDasharray={relay ? '2 2.5' : undefined} />
      <circle cx="5" cy="12" r="3.2" fill={color} />
      <circle cx="19" cy="12" r="3.2" fill={color} />
      {relay && <circle cx="12" cy="12" r="2.4" fill="var(--bg-base)" stroke={color} strokeWidth="1.6" />}
    </svg>
  )
}

// collapsed：左边栏折叠时只显 logo（不显文案），点开详情仍可用。
export function LinkStatus({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useI18n()
  const status = useLinkStatus()
  const [open, setOpen] = useState(false)

  // 未启用（偏好关 / P2P 不可用）→ 隐藏整块。
  if (status.state === 'disabled') return null

  const isP2P = status.state === 'connected'
  const isRelay = status.state === 'relay'

  let color = 'var(--text-dim)'
  let text: string
  if (isP2P) {
    color = '#3fb950'
    text = t('p2p.link.direct', { path: t(pathLabelKey(status.path)) })
  } else if (isRelay) {
    color = '#d29922'
    text = t('p2p.link.relay')
  } else {
    text = t('p2p.link.connecting')
  }

  const subRow = (labelKey: string, state: LinkState | undefined, path: string | undefined) => (
    <>
      <span style={{ color: 'var(--text-dim)' }}>{t(labelKey)}</span>
      <span style={{ color: state === 'connected' ? '#3fb950' : state === 'relay' ? '#d29922' : 'var(--text-dimmer)' }}>
        {state === 'connected'
          ? t('p2p.link.sub.directPath', { path: t(pathLabelKey(path)) })
          : t(SUBLINK_STATE_KEY[state ?? 'disabled'])}
      </span>
    </>
  )

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={text}
        style={{
          // 与底部「关于/收起」按钮对齐：14px 字号、logo 左边缘落在 24px（同 bottomBtnStyle paddingLeft）。
          display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer',
          border: 'none', borderRadius: 6, padding: collapsed ? '6px' : '6px 15px 6px 24px',
          fontSize: 14, fontWeight: 500, color, background: 'transparent',
          width: '100%', justifyContent: collapsed ? 'center' : 'flex-start',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        <P2PLogo color={color} relay={isRelay} size={16} />
        {!collapsed && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>}
      </button>

      {open && (
        <div style={{
          position: 'absolute', bottom: '100%', left: 0, marginBottom: 6, zIndex: 60,
          minWidth: 226, padding: '9px 11px', borderRadius: 8, fontSize: 12,
          background: 'var(--bg-base)', border: '1px solid var(--border-subtle)',
          boxShadow: '0 6px 20px rgba(0,0,0,.35)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, color: 'var(--text-bright)', marginBottom: 8 }}>
            <P2PLogo color={color} relay={isRelay} size={16} />
            {t('p2p.link.title')}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0,1fr)', gap: '5px 10px' }}>
            <span style={{ color: 'var(--text-dim)' }}>{t('p2p.link.control')}</span>
            <span style={{ color, fontWeight: 600 }}>{text}</span>

            <span style={{ color: 'var(--text-dim)' }}>{t('p2p.detail.rtt')}</span>
            <span style={{ color: 'var(--text-bright)' }}>{status.rttMs != null && status.rttMs > 0 ? t('p2p.detail.rttMs', { ms: Math.round(status.rttMs) }) : t('p2p.detail.na')}</span>

            {/* media 类 PC（镜像：浏览器/手机镜像开启时按需建）。 */}
            {subRow('p2p.link.media', status.media, status.mediaPath)}

            {/* file 类临时 PC（下载时按需建，用完即拆）。 */}
            {subRow('p2p.link.file', status.file, status.filePath)}
          </div>
        </div>
      )}
    </div>
  )
}

export default LinkStatus
