// P2P 传输状态角标 + 进度条 + 详情浮层（设计 §5.7；评审点 5/10）。
//
// 三态角标：
//   negotiating → 「… 正在建立直连」
//   p2p         → 「⚡ 直连 · <path 标签> · <goodput MB/s>」（绿色）
//   fallback/http → 「↻ 中转(frp) · <MB/s>」（琥珀）
// 进度条：已传/总量 + 实时 goodput + ETA。点角标展开详情浮层（path/候选对/RTT/实时+平均速率/已传总量/是否回退+原因）。
//
// 速率 = goodput（落盘字节增量，来自 download.ts 的 onProgress），candidate-pair RTT 仅进详情做诊断。
// 所有文案走 i18n（zh-CN + en-US）。

import { useState } from 'react'
import { useI18n } from '../i18n'
import { fmtSize } from '../file-utils'
import { pathLabelKey, type P2PPathLabel } from './labels'
import type { P2PState, P2PProgress } from './download'
import type { PairDiag } from './stats'

// 一次可见传输的完整视图模型（由 FileBrowser 按 transferId 维护并下发）。
export interface TransferView {
  id: string
  name: string
  state: P2PState        // negotiating | p2p | fallback | http | ...
  path?: P2PPathLabel    // 实际走的路（p2p 命中路径或 'frp'）
  progress?: P2PProgress // 已传/总量/实时+平均速率/ETA
  diag?: PairDiag        // 候选对诊断（RTT/type/family）
  fellBack: boolean      // 是否回退
  fallbackReason?: string
}

function fmtRate(bps: number, t: (k: string, v?: Record<string, string | number>) => string): string {
  // 速率用 <大小>/s 表达（复用 fmtSize 的 KB/MB/GB 分档）。
  return t('p2p.status.perSec', { size: fmtSize(Math.max(0, Math.round(bps))) })
}

function fmtEta(sec: number, t: (k: string, v?: Record<string, string | number>) => string): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return t('p2p.status.etaSec', { s })
  const m = Math.floor(s / 60)
  const rest = s % 60
  return t('p2p.status.etaMin', { m, s: rest })
}

// 单条传输的角标 + 进度 + 详情浮层。
function TransferBadge({ tf, onDismiss }: { tf: TransferView; onDismiss: (id: string) => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)

  const isP2P = tf.state === 'p2p' && !tf.fellBack
  const isRelay = tf.fellBack || tf.state === 'fallback' || tf.state === 'http'
  const rate = tf.progress?.ratePerSec ?? 0
  const total = tf.progress?.total
  const written = tf.progress?.written ?? 0
  const pct = total && total > 0 ? Math.min(100, (written / total) * 100) : undefined

  // 角标配色/文案。
  let badgeColor = 'var(--text-dim)'
  let badgeBg = 'rgba(148,163,184,0.14)'
  let badgeText: string
  if (isP2P) {
    badgeColor = '#3fb950'
    badgeBg = 'rgba(63,185,80,0.14)'
    const label = t(pathLabelKey(tf.path))
    badgeText = t('p2p.status.direct', { path: label, rate: fmtRate(rate, t) })
  } else if (isRelay) {
    badgeColor = '#d29922'
    badgeBg = 'rgba(210,153,34,0.16)'
    badgeText = t('p2p.status.relay', { rate: fmtRate(rate, t) })
  } else {
    badgeText = t('p2p.status.negotiating')
  }

  const eta = tf.progress?.etaSec

  return (
    <div style={{ position: 'relative', padding: '6px 8px', borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-container)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={t('p2p.status.detailsToggle')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
            border: 'none', borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: 600,
            color: badgeColor, background: badgeBg, maxWidth: '100%', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {badgeText}
        </button>
        <span style={{ flex: 1, minWidth: 0, color: 'var(--text-dimmer)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {tf.name}
        </span>
        {(tf.state === 'p2p' || isRelay) && eta != null && (
          <span style={{ color: 'var(--text-dimmer)', fontSize: 11, flex: '0 0 auto' }}>
            {t('p2p.status.etaLabel', { eta: fmtEta(eta, t) })}
          </span>
        )}
      </div>

      {/* 进度条：有总量画确定进度，无总量画不确定态（indeterminate 简化成满条低透明）。 */}
      <div style={{ marginTop: 5, height: 4, borderRadius: 2, background: 'var(--border-subtle)', overflow: 'hidden' }}>
        <div style={{
          height: '100%', borderRadius: 2,
          width: pct != null ? `${pct}%` : '100%',
          opacity: pct != null ? 1 : 0.35,
          background: isRelay ? '#d29922' : isP2P ? '#3fb950' : 'var(--text-dim)',
          transition: 'width 0.3s ease',
        }} />
      </div>
      <div style={{ marginTop: 3, display: 'flex', justifyContent: 'space-between', color: 'var(--text-dimmer)', fontSize: 11 }}>
        <span>{total != null ? `${fmtSize(written)} / ${fmtSize(total)}` : fmtSize(written)}</span>
        <span>{fmtRate(rate, t)}</span>
      </div>

      {open && (
        <div style={{
          marginTop: 6, padding: '8px 10px', borderRadius: 6, fontSize: 12,
          background: 'var(--bg-base)', border: '1px solid var(--border-subtle)',
          display: 'grid', gridTemplateColumns: 'max-content minmax(0,1fr)', gap: '4px 10px',
        }}>
          <span style={{ color: 'var(--text-dim)' }}>{t('p2p.detail.path')}</span>
          <span style={{ color: 'var(--text-bright)' }}>{t(pathLabelKey(tf.path))}</span>

          <span style={{ color: 'var(--text-dim)' }}>{t('p2p.detail.candidatePair')}</span>
          <span>{tf.diag?.localType || tf.diag?.remoteType
            ? `${tf.diag?.localType ?? '?'} (${tf.diag?.localFamily ?? '?'}) ↔ ${tf.diag?.remoteType ?? '?'} (${tf.diag?.remoteFamily ?? '?'})`
            : t('p2p.detail.na')}</span>

          <span style={{ color: 'var(--text-dim)' }}>{t('p2p.detail.rtt')}</span>
          <span>{tf.diag?.rttMs != null ? t('p2p.detail.rttMs', { ms: Math.round(tf.diag.rttMs) }) : t('p2p.detail.na')}</span>

          <span style={{ color: 'var(--text-dim)' }}>{t('p2p.detail.liveRate')}</span>
          <span>{fmtRate(rate, t)}</span>

          <span style={{ color: 'var(--text-dim)' }}>{t('p2p.detail.avgRate')}</span>
          <span>{fmtRate(tf.progress?.avgPerSec ?? 0, t)}</span>

          <span style={{ color: 'var(--text-dim)' }}>{t('p2p.detail.transferred')}</span>
          <span>{total != null ? `${fmtSize(written)} / ${fmtSize(total)}` : fmtSize(written)}</span>

          <span style={{ color: 'var(--text-dim)' }}>{t('p2p.detail.fellBack')}</span>
          <span>{tf.fellBack
            ? t('p2p.detail.fellBackYes', { reason: tf.fallbackReason || t('p2p.detail.na') })
            : t('p2p.detail.fellBackNo')}</span>
        </div>
      )}

      {/* 结束态可手动关掉这条（正常流程由 FileBrowser 在 done/error 后自动移除）。 */}
      {(tf.state === 'idle') && (
        <button type="button" onClick={() => onDismiss(tf.id)} style={{ position: 'absolute', top: 4, right: 6, border: 'none', background: 'transparent', color: 'var(--text-dimmer)', cursor: 'pointer', fontSize: 12 }}>×</button>
      )}
    </div>
  )
}

// 传输条堆叠容器：贴在文件面板底部，展示所有进行中的传输。
export function P2PTransferStatus({ transfers, onDismiss }: { transfers: TransferView[]; onDismiss: (id: string) => void }) {
  if (transfers.length === 0) return null
  return (
    <div style={{ flex: '0 0 auto' }}>
      {transfers.map((tf) => <TransferBadge key={tf.id} tf={tf} onDismiss={onDismiss} />)}
    </div>
  )
}
