// 「已有」选择器：接着干的落脚点有两种，都在这一张单子里。
//
// 从前这里只有 worktree——手上那条还没开工作区的分支（review 完没删的、昨天 push 了没跟进的）
// 在界面上根本不存在，只能自己去终端 `git worktree add`。现在分支也是候选：选中它就为它开一个
// 工作区进去（不新建分支）。两组东西的差别只有一句话，写在组标题上，不做成第三个模式按钮。
import { useMemo, useState } from 'react'
import { Dropdown, Input } from 'antd'
import { useI18n } from '../../i18n'
import { relTime } from '../../time-format'
import { sessionLabel } from './session-label'
import { BranchIcon } from '../git/parts'
import { ChevronDown, SearchIcon } from '../../icons'
import type { LocalBranch } from '../git/local-branches'

/** 选中值编码：前缀 wt: 跟路径 = 进已有工作区；前缀 br: 跟分支名 = 为这条分支开工作区。 */
export const pickWt = (path: string) => 'wt:' + path
export const pickBranch = (name: string) => 'br:' + name
export const pickedBranch = (v: string) => (v.startsWith('br:') ? v.slice(3) : '')
export const pickedWtPath = (v: string) => (v.startsWith('wt:') ? v.slice(3) : '')

/** 搜索框只在单子长到扫不完时才出现——三五条时它纯属多一个要点的东西。 */
const SEARCH_AT = 8

export function ExistingWorkPicker({ wts, branches, mainPath, value, onChange }: {
  wts: any[]
  branches: LocalBranch[]
  /** 主仓库工作区路径：被它检出的分支收养不了（git 不许一条分支同时检出两次） */
  mainPath: string
  value: string
  onChange: (v: string) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  // 已被 linked worktree 检出的分支不再单列：它就在上面那组里，列两遍只是让人多读一遍。
  // 主仓库检出的那条（通常是主干）留下但置灰——不然搜 main 搜不到，人会以为是漏了。
  const free = useMemo(() => branches.filter((b) => !b.worktree || b.worktree === mainPath), [branches, mainPath])
  const kw = q.trim().toLowerCase()
  const hit = (s: string) => !kw || s.toLowerCase().includes(kw)
  const wtRows = wts.filter((w: any) => hit(`${w.branch || ''} ${w.path}`))
  const brRows = free.filter((b) => hit(b.name))

  const sel = wts.find((w: any) => w.path === pickedWtPath(value))
  const selBranch = pickedBranch(value)
  const label = sel ? (sel.branch || sel.path.split('/').pop()) : selBranch
  const item = (key: string, name: string, extra: React.ReactNode, disabled?: boolean) => (
    <button key={key} type="button" className={`tt-pickitem${value === key ? ' on' : ''}`} disabled={disabled}
      onClick={() => { onChange(key); setOpen(false); setQ('') }}>
      <BranchIcon size={12} />
      <span className="nm">{name}</span>
      <span className="ex">{extra}</span>
    </button>
  )
  return (
    <Dropdown trigger={['click']} open={open} onOpenChange={(v) => { setOpen(v); if (!v) setQ('') }}
      popupRender={() => (
        <div className="mc-menu tt-pickpanel">
          {wts.length + free.length > SEARCH_AT && (
            <Input size="small" prefix={<SearchIcon size={12} />} placeholder={t('project.where.search')}
              value={q} onChange={(e) => setQ(e.target.value)} allowClear />
          )}
          <div className="tt-picklist">
            {wtRows.length > 0 && (
              <div className="tt-pickgrp">{t('project.where.groupWt')}<i>{t('project.where.groupWtHint')}</i></div>
            )}
            {wtRows.map((w: any) => item(pickWt(w.path), w.branch || w.path.split('/').pop(), (
              <>
                {w.sessions?.length ? <em className="ok">{sessionLabel(w.sessions[0].session)}</em>
                  : w.external ? <em>{t('worktree.external')}</em>
                    : <em className="warn">{t('worktree.orphan')}</em>}
                {(w.dirty > 0 || w.untracked > 0) && <span>{t('session.wt.dirtyShort', { count: w.dirty + w.untracked })}</span>}
              </>
            )))}
            {brRows.length > 0 && (
              <div className="tt-pickgrp">{t('project.where.groupBranch')}<i>{t('project.where.groupBranchHint')}</i></div>
            )}
            {brRows.map((b) => item(pickBranch(b.name), b.name,
              b.worktree ? <em>{t('project.where.mainCheckout')}</em> : <span>{relTime(b.at, t)}</span>,
              !!b.worktree))}
            {!wtRows.length && !brRows.length && <div className="tt-pickempty">{t('project.where.noMatch')}</div>}
          </div>
        </div>
      )}>
      <button type="button" className="tt-pill sel" aria-label={t('project.where.pick')} title={t('project.where.pick')}>
        <BranchIcon size={11} />
        <b>{label || '—'}</b>
        {/* 选的是分支时说清代价：开干会为它新开一个工作区，不是走进一个现成的 */}
        {!!selBranch && <span className="tt-pillnote">{t('project.where.willCreate')}</span>}
        <ChevronDown size={10} />
      </button>
    </Dropdown>
  )
}
