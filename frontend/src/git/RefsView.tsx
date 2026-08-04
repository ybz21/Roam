// 分支页：本地分支 / 远端分支 / 标签 / 储藏 四段清单。
// 点行 = 在提交树里定位这个引用（看树优先）；切换分支、删除等写操作都收在行尾的 ⋯ 菜单里，
// 避免手机上误触就切了分支。
import { useMemo, useState } from 'react'
import { Dropdown, Input, Spin, Tooltip } from 'antd'
import type { MenuProps } from 'antd'
import { useI18n } from '../i18n'
import { relTime } from './graph'
import { AheadBehind, BranchIcon, CloudIcon, MONO, MoreIcon, PlusIcon, Section, StashIcon, TagIcon } from './parts'
import { ArrowUp, CheckIcon } from '../icons'

export interface BranchInfo {
  name: string; short: string; upstream?: string
  ahead: number; behind: number; gone: boolean
  date: string; subject: string; current: boolean; remote: boolean; worktree?: string
}
export interface StashEntry { ref: string; hash: string; subject: string; when: string; date: string }
export interface TagInfo { name: string; short: string; date: string; subject: string }
export interface RefsData {
  branches: BranchInfo[]; remoteBranches: BranchInfo[]; tags: TagInfo[]; stashes: StashEntry[]; remotes: string[]
}
// /git/worktrees 的子集：分支页「Worktree」段只用得到这些字段
export interface WtInfo {
  path: string; branch: string; isMain: boolean; base: string; external: boolean
  dirty: number; untracked: number; committedAhead: number
  mergedInto?: string; sessions?: { session: string }[]
}

// 通用的两行清单行：左标记 + 名字 + 右侧动作，第二行是副标题和时间。
function RefRow({ icon, name, mono = true, accent, badge, sub, time, active, menu, onClick, quick }: {
  icon?: React.ReactNode; name: string; mono?: boolean; accent?: string
  badge?: React.ReactNode; sub?: string; time?: string; active?: boolean
  menu: MenuProps; onClick?: () => void
  quick?: { title: string; icon: React.ReactNode; onClick: () => void }
}) {
  const { t } = useI18n()
  const row = (
    <div className="cc-filerow" onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px 5px 10px', cursor: onClick ? 'pointer' : 'default',
        position: 'relative', background: active ? 'color-mix(in srgb, var(--text-bright) 8%, transparent)' : undefined,
      }}>
      {active && <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 2, background: accent || 'var(--text-dim)' }} />}
      {icon && <span style={{ display: 'inline-flex', flex: '0 0 auto', color: accent || 'var(--text-dimmer)' }}>{icon}</span>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{
            minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontFamily: mono ? MONO : undefined, fontSize: 12.5,
            color: accent || 'var(--text-bright)', fontWeight: accent ? 600 : 400,
          }} title={name}>{name}</span>
          {badge}
        </div>
        {(sub || time) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-dimmer)', marginTop: 1 }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</span>
            {time && <span style={{ flex: '0 0 auto' }}>{time}</span>}
          </div>
        )}
      </div>
      {quick && (
        <Tooltip title={quick.title}>
          <button type="button" className="cc-dl" data-file-action onClick={(e) => { e.stopPropagation(); quick.onClick() }}
            style={{ width: 22, height: 22, border: 0, background: 'transparent', borderRadius: 5, cursor: 'pointer', color: 'var(--text-dim)', display: 'inline-grid', placeItems: 'center', flex: '0 0 auto' }}>
            {quick.icon}
          </button>
        </Tooltip>
      )}
      <Dropdown menu={menu} trigger={['click']} placement="bottomRight">
        <button type="button" aria-label={t('common.more')} onClick={(e) => e.stopPropagation()}
          style={{ width: 22, height: 22, border: 0, background: 'transparent', borderRadius: 5, cursor: 'pointer', color: 'var(--text-dim)', display: 'inline-grid', placeItems: 'center', flex: '0 0 auto' }}>
          <MoreIcon />
        </button>
      </Dropdown>
    </div>
  )
  return <Dropdown menu={menu} trigger={['contextMenu']}>{row}</Dropdown>
}

const WtIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="13" height="13" rx="2" /><path d="M8 20h11a1 1 0 0 0 1-1V8" />
  </svg>
)

const CheckoutIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 4v12" /><path d="m7 12 5 5 5-5" /><path d="M4 20h16" />
  </svg>
)

export default function RefsView({
  data, loading, accent, onLocate, onCheckout, branchMenu, remoteMenu, tagMenu, stashMenu,
  onNewBranch, onStashAll, worktrees, currentWt, wtMenu, onNewWorktree,
}: {
  data: RefsData | null
  loading: boolean
  accent: string
  onLocate: (hashOrRef: string) => void
  onCheckout: (b: BranchInfo) => void
  branchMenu: (b: BranchInfo) => MenuProps
  remoteMenu: (b: BranchInfo) => MenuProps
  tagMenu: (tg: TagInfo) => MenuProps
  stashMenu: (s: StashEntry, i: number) => MenuProps
  onNewBranch: () => void
  onStashAll: () => void
  worktrees?: WtInfo[]
  currentWt?: string
  wtMenu?: (w: WtInfo) => MenuProps
  onNewWorktree?: () => void
}) {
  const { t, locale } = useI18n()
  const [q, setQ] = useState('')

  const hit = (s: string) => !q.trim() || s.toLowerCase().includes(q.trim().toLowerCase())
  const locals = useMemo(() => (data?.branches || []).filter((b) => hit(b.name)), [data, q])
  const remotes = useMemo(() => (data?.remoteBranches || []).filter((b) => hit(b.name)), [data, q])
  const tags = useMemo(() => (data?.tags || []).filter((tg) => hit(tg.name)), [data, q])
  const stashes = data?.stashes || []
  // 主工作区不进这一段（它就是仓库本身，不是"检出到别处"）
  const wts = useMemo(() => (worktrees || []).filter((w) => !w.isMain && hit(w.branch || w.path)), [worktrees, q])

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)', alignItems: 'center' }}>
        <Input size="small" allowClear value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={t('git.refs.filterPlaceholder')} style={{ flex: 1, minWidth: 0 }} />
        <Tooltip title={t('git.refs.newBranch')}>
          <button type="button" onClick={onNewBranch}
            style={{ height: 24, border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-dim)', borderRadius: 6, padding: '0 8px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, flex: '0 0 auto' }}>
            <PlusIcon />{t('git.refs.branchShort')}
          </button>
        </Tooltip>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 0 10px' }}>
        {loading && !data && <div style={{ display: 'flex', justifyContent: 'center', padding: 16 }}><Spin size="small" /></div>}

        <Section title={t('git.refs.local')} count={locals.length} icon={<BranchIcon size={13} />}>
          {locals.map((b) => (
            <RefRow key={b.name} name={b.name} active={b.current} accent={b.current ? accent : undefined}
              icon={b.current ? <span style={{ width: 6, height: 6, borderRadius: '50%', background: accent, display: 'block' }} /> : <span style={{ width: 6, height: 6, borderRadius: '50%', border: '1px solid var(--border)', display: 'block' }} />}
              badge={<>
                <AheadBehind ahead={b.ahead} behind={b.behind} />
                {b.gone && <Tooltip title={t('git.refs.upstreamGone')}><span style={{ fontSize: 10, color: 'hsl(0,60%,60%)' }}>gone</span></Tooltip>}
                {!!b.worktree && !b.current && <Tooltip title={b.worktree}><span style={{ fontSize: 10, color: 'hsl(190,60%,50%)' }}>wt</span></Tooltip>}
              </>}
              sub={b.subject} time={relTime(b.date, '', locale)}
              onClick={() => onLocate(b.name)}
              quick={b.current ? undefined : { title: t('git.refs.checkout'), icon: <CheckoutIcon />, onClick: () => onCheckout(b) }}
              menu={branchMenu(b)} />
          ))}
          {!locals.length && !loading && <div style={{ padding: '2px 12px 6px', fontSize: 12, color: 'var(--text-dimmer)' }}>{t('git.refs.none')}</div>}
        </Section>

        {/* worktree 就是「检出在别处的分支」，所以和分支并列在同一份引用清单里 */}
        {!!wts.length && (
          <Section title={t('git.refs.worktrees')} count={wts.length} icon={<WtIcon />}
            extra={onNewWorktree && (
              <Tooltip title={t('git.refs.newWorktree')}>
                <button type="button" className="cc-dl" onClick={onNewWorktree}
                  style={{ width: 22, height: 22, border: 0, background: 'transparent', borderRadius: 5, cursor: 'pointer', color: 'var(--text-dim)', display: 'inline-grid', placeItems: 'center' }}>
                  <PlusIcon />
                </button>
              </Tooltip>
            )}>
            {wts.map((w) => {
              const here = !!currentWt && w.path === currentWt
              const live = w.sessions?.length || 0
              const cleanable = !!w.mergedInto && w.dirty + w.untracked === 0
              return (
                <RefRow key={w.path} name={w.branch || w.path.split('/').pop() || w.path}
                  active={here} accent={here ? 'hsl(190,60%,50%)' : undefined}
                  icon={<span style={{
                    width: 7, height: 7, flex: '0 0 auto', display: 'block',
                    borderRadius: w.external ? 1 : '50%', transform: w.external ? 'rotate(45deg)' : undefined,
                    background: live ? 'var(--ok)' : cleanable ? 'transparent' : w.external ? 'transparent' : 'hsl(32,85%,55%)',
                    border: (cleanable || w.external) ? '1px solid var(--text-dimmer)' : undefined,
                  }} />}
                  badge={<>
                    {here && <span style={{ fontSize: 10, color: 'var(--text-dimmer)' }}>{t('git.refs.youAreHere')}</span>}
                    {!!w.committedAhead && <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', gap: 1 }}><ArrowUp size={10} />{w.committedAhead}</span>}
                    {cleanable && <span style={{ display: 'inline-flex', color: 'var(--ok)' }}><CheckIcon size={11} /></span>}
                    {w.external && <span style={{ fontSize: 10, color: 'var(--text-dimmer)' }}>{t('git.refs.externalWt')}</span>}
                  </>}
                  sub={w.path}
                  time={live ? t('git.refs.wtSessions', { count: live }) : cleanable ? t('git.refs.wtCleanable') : t('git.refs.wtOrphan')}
                  onClick={() => w.branch && onLocate(w.branch)}
                  menu={wtMenu ? wtMenu(w) : { items: [] }} />
              )
            })}
          </Section>
        )}

        {!!remotes.length && (
          <Section title={t('git.refs.remote')} count={remotes.length} icon={<CloudIcon />}>
            {remotes.map((b) => (
              <RefRow key={b.name} name={b.name} sub={b.subject} time={relTime(b.date, '', locale)}
                icon={<span style={{ width: 6, height: 6, borderRadius: '50%', border: '1px solid var(--border)', display: 'block' }} />}
                onClick={() => onLocate(b.name)} menu={remoteMenu(b)} />
            ))}
          </Section>
        )}

        {!!tags.length && (
          <Section title={t('git.refs.tags')} count={tags.length} icon={<TagIcon />}>
            {tags.map((tg) => (
              <RefRow key={tg.name} name={tg.name} sub={tg.subject} time={relTime(tg.date, '', locale)}
                icon={<span style={{ color: 'hsl(32,85%,52%)', fontFamily: MONO, fontSize: 11 }}>#</span>}
                onClick={() => onLocate(tg.name)} menu={tagMenu(tg)} />
            ))}
          </Section>
        )}

        <Section title={t('git.refs.stashes')} count={stashes.length} icon={<StashIcon />}
          extra={<Tooltip title={t('git.refs.stashAll')}>
            <button type="button" className="cc-dl" onClick={onStashAll}
              style={{ width: 22, height: 22, border: 0, background: 'transparent', borderRadius: 5, cursor: 'pointer', color: 'var(--text-dim)', display: 'inline-grid', placeItems: 'center' }}>
              <PlusIcon />
            </button>
          </Tooltip>}>
          {stashes.map((s, i) => (
            <RefRow key={s.ref} name={s.ref} sub={s.subject} time={relTime(s.date, s.when, locale)}
              icon={<StashIcon />} menu={stashMenu(s, i)} />
          ))}
          {!stashes.length && <div style={{ padding: '2px 12px 6px', fontSize: 12, color: 'var(--text-dimmer)' }}>{t('git.refs.noStash')}</div>}
        </Section>
      </div>
    </div>
  )
}
