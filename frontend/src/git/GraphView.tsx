// 提交树：一行一提交，左侧 SVG 泳道把 DAG 画出来，右侧是主题/引用/作者/时间。
// 行的高度固定（ROW_H），泳道连线才能跨行对齐；每行自己画上下两个半格，不做跨行绝对定位。
import { useEffect, useMemo, useRef, useState } from 'react'
import { Dropdown, Input, Segmented, Spin, Tooltip } from 'antd'
import type { MenuProps } from 'antd'
import { useI18n } from '../i18n'
import { layoutGraph, relTime, type GraphRow, type RawCommit } from './graph'
import { MONO, MoreIcon, RefBadge, SearchIcon } from './parts'

const ROW_H = 46
const LANE_W = 15
const NODE_R = 4.2
const MAX_GUTTER = 132

export interface GraphData { commits: RawCommit[]; head?: string; branch?: string; hasMore?: boolean }

// 一行的泳道图：上半格收线、下半格发线，节点在中间。
function LaneCanvas({ row, laneW, width, headHash }: { row: GraphRow; laneW: number; width: number; headHash?: string }) {
  const x = (lane: number) => Math.min(lane, Math.floor(width / laneW) - 1) * laneW + laneW / 2
  const mid = ROW_H / 2
  const cx = x(row.lane)
  const isHead = row.commit.hash === headHash

  const path = (from: number, to: number, y1: number, y2: number) => {
    const x1 = x(from), x2 = x(to)
    if (x1 === x2) return `M${x1} ${y1}V${y2}`
    const my = (y1 + y2) / 2
    return `M${x1} ${y1}C${x1} ${my},${x2} ${my},${x2} ${y2}`
  }

  return (
    <svg width={width} height={ROW_H} style={{ flex: '0 0 auto', display: 'block', overflow: 'visible' }} aria-hidden>
      {row.top.map((s, i) => <path key={'t' + i} d={path(s.from, s.to, 0, mid)} stroke={s.color} strokeWidth={1.6} fill="none" strokeLinecap="round" />)}
      {row.bottom.map((s, i) => <path key={'b' + i} d={path(s.from, s.to, mid, ROW_H)} stroke={s.color} strokeWidth={1.6} fill="none" strokeLinecap="round" />)}
      {/* 节点：普通提交实心，合并提交空心圈；HEAD 外加一圈光环 */}
      {isHead && <circle cx={cx} cy={mid} r={NODE_R + 3.4} fill="none" stroke={row.color} strokeWidth={1.2} opacity={.45} />}
      <circle cx={cx} cy={mid} r={NODE_R + 1.6} fill="var(--bg-container)" />
      <circle cx={cx} cy={mid} r={NODE_R} fill={row.merge ? 'var(--bg-container)' : row.color} stroke={row.color} strokeWidth={row.merge ? 1.8 : 1} />
    </svg>
  )
}

function CommitRow({ row, gutter, laneW, headHash, selected, onPick, menu, wtByBranch, onWt }: {
  row: GraphRow; gutter: number; laneW: number; headHash?: string; selected: boolean
  onPick: () => void; menu: MenuProps
  wtByBranch?: Record<string, string>; onWt?: (path: string) => void
}) {
  const { t, locale } = useI18n()
  const c = row.commit
  const refs = c.refs.slice(0, 3)
  const hidden = c.refs.length - refs.length

  const body = (
    <div className="tt-git-crow" onClick={onPick} data-hash={c.hash}
      style={{
        display: 'flex', alignItems: 'stretch', height: ROW_H, cursor: 'pointer', position: 'relative',
        background: selected ? 'color-mix(in srgb, var(--text-bright) 8%, transparent)' : undefined,
      }}>
      {selected && <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 2, background: row.color }} />}
      <LaneCanvas row={row} laneW={laneW} width={gutter} headHash={headHash} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2, paddingRight: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {refs.map((r) => {
            const wt = (r.kind === 'head' || r.kind === 'branch') ? wtByBranch?.[r.name] : undefined
            return <RefBadge key={r.kind + r.name} r={r} wt={wt} onWt={wt && onWt ? () => onWt(wt) : undefined} />
          })}
          {hidden > 0 && <span style={{ fontSize: 10.5, color: 'var(--text-dimmer)', flex: '0 0 auto' }}>+{hidden}</span>}
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5, color: 'var(--text-bright)' }} title={c.subject}>
            {c.subject}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-dimmer)', minWidth: 0 }}>
          <span style={{ fontFamily: MONO, color: row.color, opacity: .95, flex: '0 0 auto' }}>{c.short}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.author}</span>
          <span style={{ flex: 1 }} />
          <Tooltip title={c.date}><span style={{ flex: '0 0 auto' }}>{relTime(c.date, c.when, locale)}</span></Tooltip>
          <Dropdown menu={menu} trigger={['click']} placement="bottomRight">
            <button type="button" className="cc-dl" aria-label={t('common.more')} onClick={(e) => e.stopPropagation()}
              style={{ width: 20, height: 18, border: 0, background: 'transparent', borderRadius: 4, cursor: 'pointer', color: 'var(--text-dim)', display: 'inline-grid', placeItems: 'center', flex: '0 0 auto' }}>
              <MoreIcon />
            </button>
          </Dropdown>
        </div>
      </div>
    </div>
  )
  return <Dropdown menu={menu} trigger={['contextMenu']}>{body}</Dropdown>
}

export default function GraphView({
  data, loading, selected, onPick, commitMenu, scope, onScope, query, onQuery, onLoadMore,
  wtByBranch, onWt, focus, onFocusDone,
}: {
  data: GraphData | null
  loading: boolean
  selected?: string
  onPick: (c: RawCommit) => void
  commitMenu: (c: RawCommit) => MenuProps
  scope: 'all' | 'current'
  onScope: (v: 'all' | 'current') => void
  query: string
  onQuery: (v: string) => void
  onLoadMore: () => void
  wtByBranch?: Record<string, string>
  onWt?: (path: string) => void
  /** 从分支页跳过来时要定位的引用名；nonce 变化即触发一次定位 */
  focus?: { ref: string; nonce: number }
  onFocusDone?: (hash: string | null) => void
}) {
  const { t } = useI18n()
  const [q, setQ] = useState(query)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setQ(query) }, [query])
  useEffect(() => {
    const id = setTimeout(() => { if (q !== query) onQuery(q) }, 300)
    return () => clearTimeout(id)
  }, [q])

  const commits = data?.commits || []
  const { rows, lanes } = useMemo(() => layoutGraph(commits), [commits])
  // 泳道多了就压缩间距，最多占 MAX_GUTTER，右侧文字始终有活路
  const laneW = lanes * LANE_W + 8 > MAX_GUTTER ? Math.max(9, Math.floor((MAX_GUTTER - 8) / lanes)) : LANE_W
  const gutter = Math.max(28, Math.min(MAX_GUTTER, lanes * laneW + 8))

  // 定位：分支页点一行 → 切到这里并把对应提交滚到中间。找不到就回报 null，由上层提示。
  useEffect(() => {
    if (!focus?.ref) return
    const hit = rows.find((r) => r.commit.refs.some((x) => x.name === focus.ref))
      || rows.find((r) => r.commit.hash.startsWith(focus.ref))
    onFocusDone?.(hit ? hit.commit.hash : null)
    if (hit) {
      requestAnimationFrame(() => {
        boxRef.current?.querySelector(`[data-hash="${hit.commit.hash}"]`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      })
    }
  }, [focus?.nonce, rows])

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)', alignItems: 'center' }}>
        <Input size="small" allowClear value={q} onChange={(e) => setQ(e.target.value)}
          prefix={<span style={{ color: 'var(--text-dimmer)', display: 'inline-flex' }}><SearchIcon /></span>}
          placeholder={t('git.graph.searchPlaceholder')} style={{ flex: 1, minWidth: 0 }} />
        <Segmented size="small" value={scope} onChange={(v) => onScope(v as any)}
          options={[{ label: t('git.graph.scopeAll'), value: 'all' }, { label: t('git.graph.scopeCurrent'), value: 'current' }]} />
      </div>

      <div ref={boxRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 0 8px' }}>
        {loading && !rows.length && <div style={{ display: 'flex', justifyContent: 'center', padding: 16 }}><Spin size="small" /></div>}
        {!loading && !rows.length && (
          <div style={{ color: 'var(--text-dimmer)', fontSize: 12, padding: '14px 12px', textAlign: 'center' }}>
            {query ? t('git.graph.noMatch') : t('git.graph.empty')}
          </div>
        )}
        {rows.map((row) => (
          <CommitRow key={row.commit.hash} row={row} gutter={gutter} laneW={laneW} headHash={data?.head}
            selected={selected === row.commit.hash} onPick={() => onPick(row.commit)} menu={commitMenu(row.commit)}
            wtByBranch={wtByBranch} onWt={onWt} />
        ))}
        {data?.hasMore && (
          <div style={{ padding: '8px 12px', textAlign: 'center' }}>
            <button type="button" onClick={onLoadMore} disabled={loading}
              style={{ border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-dim)', borderRadius: 6, padding: '4px 14px', fontSize: 12, cursor: 'pointer' }}>
              {loading ? <Spin size="small" /> : t('git.graph.loadMore')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
