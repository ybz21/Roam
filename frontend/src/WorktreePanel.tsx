// Worktree 管理抽屉（W4，设计见 docs/design/web/07-worktree.md §3）
// 列出仓库全部 worktree（5s 轮询），支持合并回 base（squash/merge/rebase）、
// 删除（脏保护/占用检查/分支未合并三种 409 交互）与显式清理残留。
import { useCallback, useEffect, useState } from 'react'
import { App as AntApp, AutoComplete, Button, Drawer, Dropdown, Empty, Grid, Skeleton, Tag } from 'antd'
import { api } from './api'
import { useI18n } from './i18n'
import { recentDirs } from './App'

type WtSession = { session: string; primary: boolean }
type Worktree = {
  path: string; branch: string; head: string; isMain: boolean
  base: string; startOid: string; createdBy: string; createdAt: number
  external: boolean; dirty: number; untracked: number
  committedAhead: number; behind: number; lastCommitAt: number
  locked: boolean; prunable: boolean; sessions: WtSession[]
}

// 相对时间（Unix 秒），与 App.tsx relTime 同款（避免循环依赖只引用函数式 recentDirs）
function relTime(sec: number | undefined, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (!sec || !Number.isFinite(sec)) return '—'
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - sec))
  if (diff < 60) return t('time.justNow')
  if (diff < 3600) return t('time.minutesAgo', { count: Math.floor(diff / 60) })
  if (diff < 86400) return t('time.hoursAgo', { count: Math.floor(diff / 3600) })
  return t('time.daysAgo', { count: Math.floor(diff / 86400) })
}

export default function WorktreePanel({ open, onClose, openTerm }: {
  open: boolean
  onClose: () => void
  openTerm: (name: string) => void
}) {
  const { message, modal } = AntApp.useApp()
  const { t } = useI18n()
  const screens = Grid.useBreakpoint()
  const [dir, setDir] = useState('')
  const [list, setList] = useState<Worktree[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  // 打开时默认选最近用过的目录
  useEffect(() => {
    if (open && !dir) { const r = recentDirs(); if (r.length) setDir(r[0]) }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async (d: string, silent = false) => {
    if (!d.trim()) { setList(null); return }
    if (!silent) setLoading(true)
    try {
      const r = await api('GET', `/git/worktrees?dir=${encodeURIComponent(d.trim())}`)
      setList(Array.isArray(r?.data) ? r.data : [])
    } catch (e: any) {
      if (!silent) { message.error(e.message); setList([]) }
    } finally { if (!silent) setLoading(false) }
  }, [message])

  // 目录变化去抖加载；抽屉开着时 5s 轮询（service 侧有缓存兜底）
  useEffect(() => {
    if (!open || !dir.trim()) { setList(null); return }
    const t0 = setTimeout(() => load(dir), 300)
    const iv = setInterval(() => load(dir, true), 5000)
    return () => { clearTimeout(t0); clearInterval(iv) }
  }, [open, dir, load])

  const withBusy = async (path: string, fn: () => Promise<void>) => {
    setBusy((m) => ({ ...m, [path]: true }))
    try { await fn() } finally { setBusy((m) => ({ ...m, [path]: false })) }
  }

  // 删除：先裸调（默认 -d 删分支），按 409 错误码分流三种确认交互
  const doRemove = (wt: Worktree, extra: Record<string, any> = {}) => withBusy(wt.path, async () => {
    try {
      await api('POST', '/git/worktree/remove', { path: wt.path, deleteBranch: true, ...extra })
      message.success(t('worktree.deleted'))
      load(dir, true)
    } catch (e: any) {
      const ae = e.apiError || {}
      if (ae.code === 'WORKTREE_DIRTY') {
        modal.confirm({
          title: t('worktree.dirtyDeleteTitle'),
          content: t('worktree.dirtyDeleteDesc', { dirty: ae.dirty ?? wt.dirty, untracked: ae.untracked ?? wt.untracked }),
          okText: t('worktree.delete'), okButtonProps: { danger: true },
          onOk: () => { doRemove(wt, { ...extra, forceWorktree: true }) },
        })
      } else if (ae.code === 'SESSIONS_INSIDE') {
        modal.warning({
          title: t('worktree.sessionsInsideTitle'),
          content: t('worktree.sessionsInsideDesc', { sessions: (ae.sessions || []).join(', ') }),
        })
      } else if (ae.code === 'BRANCH_NOT_MERGED') {
        load(dir, true) // worktree 本体已删，先刷新
        modal.confirm({
          title: t('worktree.branchNotMergedTitle'),
          content: t('worktree.branchNotMergedDesc', { branch: ae.branch || wt.branch }),
          okText: t('worktree.forceDeleteBranch'), okButtonProps: { danger: true },
          onOk: () => { doRemove(wt, { ...extra, forceDeleteBranch: true }) },
        })
      } else {
        message.error(e.message)
      }
    }
  })

  const doMerge = (wt: Worktree, strategy: 'squash' | 'merge' | 'rebase') => withBusy(wt.path, async () => {
    try {
      const r = await api('POST', '/git/worktree/merge', { path: wt.path, strategy, expectedHead: wt.head })
      message.success(t('worktree.mergeSuccess', { base: r?.data?.base || wt.base }))
      load(dir, true)
      modal.confirm({
        title: t('worktree.deleteAfterMergeTitle', { branch: wt.branch }),
        content: t('worktree.deleteAfterMergeDesc'),
        okText: t('worktree.delete'),
        onOk: () => { doRemove(wt) },
      })
    } catch (e: any) {
      const ae = e.apiError || {}
      if (ae.code === 'MERGE_CONFLICT') {
        modal.warning({
          title: t('worktree.mergeConflictTitle'),
          content: (
            <div>
              <div>{t('worktree.mergeConflictDesc', { stage: ae.stage || '?' })}</div>
              <ul style={{ fontFamily: 'monospace', fontSize: 12, marginTop: 8, paddingLeft: 18, maxHeight: 200, overflow: 'auto' }}>
                {(ae.conflictFiles || []).map((f: string) => <li key={f}>{f}</li>)}
              </ul>
            </div>
          ),
        })
      } else {
        message.error(e.message)
      }
    }
  })

  const doPrune = async () => {
    try {
      await api('POST', '/git/worktree/prune', { dir: dir.trim() })
      message.success(t('worktree.pruned'))
      load(dir, true)
    } catch (e: any) { message.error(e.message) }
  }

  // 四态徽章：活会话（点击进终端）/ 孤儿 / 外部创建 / 旧格式；主工作区单独标注
  const badges = (wt: Worktree) => {
    if (wt.isMain) return [<Tag key="m" style={{ margin: 0 }}>{t('worktree.main')}</Tag>]
    const out = [] as any[]
    if (wt.sessions?.length) {
      out.push(
        <Tag key="s" color="green" style={{ margin: 0, cursor: 'pointer' }} title={wt.sessions.map((x) => x.session).join(', ')}
          onClick={() => { openTerm(wt.sessions[0].session); onClose() }}>
          {wt.sessions[0].session}{wt.sessions.length > 1 ? ` +${wt.sessions.length - 1}` : ''}
        </Tag>,
      )
    } else if (!wt.external) {
      out.push(<Tag key="o" color="warning" style={{ margin: 0 }}>{t('worktree.orphan')}</Tag>)
    }
    if (wt.external) out.push(<Tag key="e" style={{ margin: 0 }}>{t('worktree.external')}</Tag>)
    if (wt.branch.startsWith('_')) out.push(<Tag key="l" color="warning" style={{ margin: 0 }}>{t('worktree.legacy')}</Tag>)
    return out
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('worktree.title')} width={screens.md ? 480 : '100%'}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <AutoComplete style={{ flex: 1, minWidth: 0 }} value={dir} onChange={setDir}
          options={recentDirs().map((d) => ({ value: d }))}
          filterOption={(input, opt) => String(opt?.value).toLowerCase().includes(input.toLowerCase())}
          placeholder={t('worktree.dirPlaceholder')} />
        <Button onClick={() => load(dir)} loading={loading} style={{ flex: '0 0 auto' }}>{t('common.refresh')}</Button>
      </div>

      {!dir.trim() ? (
        <Empty description={t('worktree.pickDir')} />
      ) : loading && list === null ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[0, 1, 2].map((i) => <Skeleton key={i} active title={false} paragraph={{ rows: 2 }} />)}
        </div>
      ) : list && list.length === 0 ? (
        <Empty description={t('worktree.empty')} />
      ) : list ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {list.map((wt) => (
            <div key={wt.path} style={{
              background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8,
              padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span title={wt.path} style={{
                  fontFamily: 'monospace', fontWeight: 600, color: 'var(--text-bright)',
                  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>⎇ {wt.branch}</span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, flex: '0 0 auto' }}>{badges(wt)}</span>
              </div>
              <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                {t('worktree.baseOf', { base: wt.base || '?' })} · ↑{wt.committedAhead} ↓{wt.behind}
                {' · '}{t('worktree.changes', { dirty: wt.dirty, untracked: wt.untracked })}
                {' · '}{relTime(wt.lastCommitAt, t)}
              </div>
              {!wt.isMain && (
                <div style={{ display: 'flex', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
                  {!wt.external && !!wt.base && (
                    <Dropdown.Button size="small" loading={!!busy[wt.path]}
                      onClick={() => doMerge(wt, 'squash')}
                      menu={{
                        items: [
                          { key: 'merge', label: t('worktree.strategyMerge') },
                          { key: 'rebase', label: t('worktree.strategyRebase') },
                        ],
                        onClick: ({ key }) => doMerge(wt, key as 'merge' | 'rebase'),
                      }}>
                      {t('worktree.mergeSquash')}
                    </Dropdown.Button>
                  )}
                  <Button size="small" danger loading={!!busy[wt.path]} onClick={() => doRemove(wt)}>
                    {t('worktree.delete')}
                  </Button>
                </div>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', marginTop: 6 }}>
            <span style={{ color: 'var(--text-dimmer)', fontSize: 12 }}>{t('worktree.count', { count: list.length })}</span>
            <Button size="small" style={{ marginLeft: 'auto' }} onClick={doPrune}>{t('worktree.prune')}</Button>
          </div>
        </div>
      ) : null}
    </Drawer>
  )
}
