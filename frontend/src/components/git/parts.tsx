// Git 面板共用的小零件：图标、引用徽标、行内动作按钮、分组标题。
// 视觉基调沿用全局 CSS 变量（黑白主题自动跟随），只在泳道色上用固定 HSL。
import type { ReactNode } from 'react'
import { Tooltip } from 'antd'
import { useI18n } from '../../i18n'
import type { RawRef } from './graph'
import { ArrowDown, ArrowUp, CloudIcon, WindowsIcon, MergeIcon } from '../../icons'

export { CloudIcon }

export const MONO = "ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace"

const svg = (d: ReactNode, size = 15, extra?: Record<string, string | number>) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...extra}>{d}</svg>
)

export const BranchIcon = ({ size = 15 }: { size?: number }) => svg(
  <><circle cx="6" cy="6" r="2.3" /><circle cx="6" cy="18" r="2.3" /><circle cx="18" cy="8" r="2.3" />
    <path d="M6 8.3v7.4" /><path d="M18 10.3a6 6 0 0 1-6 6H8.3" /></>, size, { strokeWidth: 2 })
export const RefreshIcon = () => svg(<><path d="M21 12a9 9 0 0 1-15 6.7" /><path d="M3 12A9 9 0 0 1 18 5.3" /><path d="M18 2v4h-4" /><path d="M6 22v-4h4" /></>)
export const CloseIcon = () => svg(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>)
export const BackIcon = () => svg(<><path d="M15 18l-6-6 6-6" /></>)
export const MoreIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
export const PlusIcon = () => svg(<path d="M12 5v14M5 12h14" />, 14, { strokeWidth: 2.2 })
export const MinusIcon = () => svg(<path d="M5 12h14" />, 14, { strokeWidth: 2.2 })
export const DiscardIcon = () => svg(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></>, 14, { strokeWidth: 1.9 })
export const SyncIcon = () => svg(<><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 12A9 9 0 0 1 18 5.3L21 8" /><path d="M21 3v5h-5" /><path d="M3 21v-5h5" /></>, 14, { strokeWidth: 1.9 })
export const TagIcon = () => svg(<><path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z" /><circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" /></>, 13)
export const StashIcon = () => svg(<><rect x="3" y="4" width="18" height="5" rx="1.4" /><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" /><path d="M10 13h4" /></>, 13)
export const CheckIcon = () => svg(<path d="m5 12.5 4.5 4.5L19 7" />, 14, { strokeWidth: 2.2 })
export const SearchIcon = () => svg(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></>, 14)
export const CopyIcon = () => svg(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>, 13)

// 引用徽标：当前 HEAD 绿、本地分支蓝、远端灰蓝、标签琥珀。
const REF_STYLE: Record<string, { fg: string; bg: string; bd: string }> = {
  head: { fg: 'var(--ok)', bg: 'var(--ok-soft)', bd: 'var(--ok-border)' },
  branch: { fg: 'hsl(212,78%,58%)', bg: 'hsla(212,78%,58%,.13)', bd: 'hsla(212,78%,58%,.38)' },
  remote: { fg: 'hsl(258,30%,62%)', bg: 'hsla(258,30%,62%,.13)', bd: 'hsla(258,30%,62%,.34)' },
  tag: { fg: 'hsl(32,85%,52%)', bg: 'hsla(32,85%,52%,.14)', bd: 'hsla(32,85%,52%,.4)' },
  stash: { fg: 'hsl(190,60%,45%)', bg: 'hsla(190,60%,45%,.13)', bd: 'hsla(190,60%,45%,.36)' },
}

// wt 非空 = 这条分支被某个 worktree 占着，徽标后挂一个 ⧉ 角标，点它进那个 worktree。
export function RefBadge({ r, onClick, title, wt, onWt }: {
  r: RawRef; onClick?: () => void; title?: string; wt?: string; onWt?: () => void
}) {
  const s = REF_STYLE[r.kind] || REF_STYLE.branch
  const node = (
    <span onClick={onClick ? (e) => { e.stopPropagation(); onClick() } : undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3, maxWidth: 150,
        padding: '0 5px', height: 16, borderRadius: 4, fontSize: 10.5, lineHeight: '15px',
        fontFamily: MONO, color: s.fg, background: s.bg, border: `1px solid ${s.bd}`,
        cursor: onClick ? 'pointer' : 'default', flex: '0 0 auto',
      }}>
      {r.kind === 'head' && <span style={{ width: 5, height: 5, borderRadius: '50%', background: s.fg, flex: '0 0 auto' }} />}
      {r.kind === 'tag' && <span style={{ opacity: .8 }}>#</span>}
      {r.kind === 'remote' && <span style={{ opacity: .8, display: 'inline-flex' }}><CloudIcon size={10} /></span>}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
    </span>
  )
  const badge = title ? <Tooltip title={title}>{node}</Tooltip> : node
  if (!wt) return badge
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flex: '0 0 auto' }}>
      {badge}
      <Tooltip title={wt}>
        <span onClick={(e) => { e.stopPropagation(); onWt?.() }}
          style={{ color: 'hsl(190,60%,50%)', display: 'inline-flex', cursor: onWt ? 'pointer' : 'default', lineHeight: 1 }}><WindowsIcon size={11} /></span>
      </Tooltip>
    </span>
  )
}

// 行内小动作按钮：hover 行时浮现（沿用 .cc-dl 的浮现样式）。
export const RowAct = ({ title, danger, onClick, children }: { title: string; danger?: boolean; onClick: () => void; children: ReactNode }) => (
  <Tooltip title={title}>
    <button type="button" className="cc-dl" data-file-action
      onClick={(e) => { e.stopPropagation(); onClick() }}
      style={{ width: 22, height: 22, border: 0, background: 'transparent', borderRadius: 5, cursor: 'pointer', display: 'inline-grid', placeItems: 'center', color: danger ? 'hsl(0,72%,62%)' : 'var(--text-dim)', flex: '0 0 auto' }}>
      {children}
    </button>
  </Tooltip>
)

// 分组标题：小写字距拉开，右侧留动作位（hover 分组时浮现）。
export function Section({ title, count, extra, children, icon }: {
  title: string; count?: number; extra?: ReactNode; children: ReactNode; icon?: ReactNode
}) {
  return (
    <div className="cc-git-section" style={{ marginBottom: 4 }}>
      <div style={{ padding: '5px 8px 4px 10px', color: 'var(--text-dim)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .5, display: 'flex', alignItems: 'center', gap: 6 }}>
        {icon && <span style={{ display: 'inline-flex', color: 'var(--text-dimmer)' }}>{icon}</span>}
        <span>{title}</span>
        {count != null && <span style={{ color: 'var(--text-dimmer)', fontWeight: 500 }}>{count}</span>}
        <span style={{ flex: 1 }} />
        <span className="cc-git-section-act" style={{ display: 'inline-flex', gap: 2 }}>{extra}</span>
      </div>
      {children}
    </div>
  )
}

// ↑n ↓n 的领先/落后指示（无差异时不渲染）。
export function AheadBehind({ ahead, behind, size = 11 }: { ahead?: number; behind?: number; size?: number }) {
  if (!ahead && !behind) return null
  return (
    <span style={{ display: 'inline-flex', gap: 5, fontFamily: MONO, fontSize: size, flex: '0 0 auto' }}>
      {!!behind && <span style={{ color: 'hsl(32,85%,55%)', display: 'inline-flex', alignItems: 'center', gap: 1 }}><ArrowDown size={size} />{behind}</span>}
      {!!ahead && <span style={{ color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', gap: 1 }}><ArrowUp size={size} />{ahead}</span>}
    </span>
  )
}


/** worktree 的分支状态图标（Orca 卡片右上角那枚 PR 标的位置）：颜色说状态，悬停看分支和数字。
 *  已合入 = 绿 + 合并标；有未提交改动 = 黄；有未合入提交 = 蓝；干净 = 灰。 */
export function WtStatusIcon({ branch, merged, dirty = 0, ahead = 0, behind = 0, pushed }: {
  branch?: string; merged?: boolean; dirty?: number; ahead?: number; behind?: number; pushed?: boolean
}) {
  const { t } = useI18n()
  const tone = merged ? 'ok' : dirty ? 'warn' : ahead > 0 ? 'accent' : 'dim'
  const bits = [
    merged ? t('tree.merged') : ahead > 0 ? t('tree.aheadN', { n: ahead }) : '',
    pushed && !merged ? t('tree.pushed') : '',
    dirty ? t('tree.dirtyN', { n: dirty }) : '',
    behind ? t('tree.behindN', { n: behind }) : '',
  ].filter(Boolean)
  const tip = [branch, ...bits].filter(Boolean).join(' · ')
  return (
    <Tooltip title={tip} placement="right">
      <span className={`wtst ${tone}`} aria-label={tip}>{merged ? <MergeIcon size={13} /> : <BranchIcon size={13} />}</span>
    </Tooltip>
  )
}
