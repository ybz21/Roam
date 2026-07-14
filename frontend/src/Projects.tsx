// 项目页（08 设计 M1）——「项目 = git 仓库」，任务驱动：
//   #/projects        P1 列表：GET /projects 聚合卡片（发现/退场在后端读时收敛）+ 散会话
//   #/projects/<key>  P2 主页：composer（描述任务 ⏎ 开干 = 现有组合 API）+
//                     任务流（会话 ∪ 孤儿 worktree 的统一投影，收尾入口）
// 数据零新真相源：/projects 只是聚合，写路径全部复用 worktree-sessions/sessions。
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { App as AntApp, Button, Input, Segmented, Select, Spin, Tag, Tooltip } from 'antd'
import { api } from './api'
import { useI18n } from './i18n'
import { usePreferences } from './preferences'
import { relTime, taskNameFromPrompt, shq, NewSessionModal } from './App'

const WorktreePanel = lazy(() => import('./WorktreePanel'))

type ProjSession = { name: string; attached: boolean; lastActivity: number; branch?: string; linked?: boolean }
type Proj = {
  key: string; name: string; dir: string; pinned: boolean
  sessions: number; attached: number; worktrees: number; unfinished: number; races: number
  lastActivity: number; top: ProjSession[] | null
}

const dot = (on: boolean) => (
  <span style={{
    width: 8, height: 8, borderRadius: '50%', flex: '0 0 8px', display: 'inline-block',
    background: on ? 'var(--green, #3fb950)' : 'var(--text-dimmer, #6e7681)',
  }} />
)

export default function Projects({ openTerm, initialKey }: { openTerm: (n: string) => void; initialKey?: string }) {
  const [data, setData] = useState<{ projects: Proj[]; loose: ProjSession[] }>({ projects: [], loose: [] })
  const [loaded, setLoaded] = useState(false)
  const { t } = useI18n()
  const load = () => api('GET', '/projects').then((r) => {
    setData({ projects: r?.data?.projects || [], loose: r?.data?.loose || [] })
    setLoaded(true)
  }).catch(() => {})
  useEffect(() => { load(); const i = setInterval(load, 5000); return () => clearInterval(i) }, [])

  if (initialKey) {
    const p = data.projects.find((x) => x.key === initialKey)
    return <ProjectHome proj={p} loaded={loaded} openTerm={openTerm} refresh={load} />
  }
  return <ProjectList data={data} loaded={loaded} openTerm={openTerm} refresh={load} />
}

// ── P1 项目列表 ───────────────────────────────────────────
function ProjectList({ data, loaded, openTerm, refresh }: {
  data: { projects: Proj[]; loose: ProjSession[] }; loaded: boolean
  openTerm: (n: string) => void; refresh: () => void
}) {
  const { t } = useI18n()
  const { message } = AntApp.useApp()
  const [newOpen, setNewOpen] = useState(false)
  const pin = async (p: Proj) => {
    try { await api('PATCH', `/projects/${encodeURIComponent(p.key)}/prefs`, { pinned: !p.pinned }); refresh() }
    catch (e: any) { message.error(e.message) }
  }
  const open = (p: Proj) => { location.hash = '#/projects/' + encodeURIComponent(p.key) }
  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, fontWeight: 700 }}>{t('project.title')}</span>
        <Segmented size="small" value="projects"
          options={[
            { label: t('project.title'), value: 'projects' },
            { label: t('project.allSessions'), value: 'sessions' },
          ]}
          onChange={(v) => { if (v === 'sessions') location.hash = '#/sessions' }} />
        <span style={{ flex: 1 }} />
        <Button type="primary" size="small" onClick={() => setNewOpen(true)}>{t('project.newTask')}</Button>
      </div>

      {loaded && data.projects.length === 0 && (
        <div style={{ color: 'var(--text-dim)', padding: '24px 4px' }}>{t('project.empty')}</div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))', gap: 12 }}>
        {data.projects.map((p) => (
          <div key={p.key} onClick={() => open(p)}
            style={{
              background: 'var(--bg-container, rgba(177,186,196,.04))', border: '1px solid var(--border-subtle, #21262d)',
              borderRadius: 12, padding: '13px 14px 11px', cursor: 'pointer',
              display: 'flex', flexDirection: 'column', gap: 8,
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 14.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>⌂ {p.name}</span>
              {p.races > 0 && <Tag color="gold" style={{ margin: 0 }}>{t('project.race', { count: p.races })}</Tag>}
              <span style={{ flex: 1 }} />
              <Tooltip title={p.pinned ? t('project.unpin') : t('project.pin')}>
                <a onClick={(e) => { e.stopPropagation(); pin(p) }}
                  style={{ color: p.pinned ? 'var(--yellow, #d29922)' : 'var(--text-dimmer)', fontSize: 13 }}>★</a>
              </Tooltip>
            </div>
            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'var(--text-dimmer)', marginTop: -4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.dir}>{p.dir}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-dim)' }}>
              <span><b style={{ color: 'var(--text-bright, inherit)' }}>{p.sessions}</b> {t('project.tasks')}</span>·
              <span><b style={{ color: 'var(--text-bright, inherit)' }}>{p.worktrees}</b> worktree</span>
              {p.unfinished > 0 && <Tag color="warning" style={{ margin: 0 }}>{t('project.unfinished', { count: p.unfinished })}</Tag>}
            </div>
            {(p.top?.length || 0) > 0 && (
              <div style={{
                display: 'flex', flexDirection: 'column', gap: 5, padding: '7px 9px',
                borderRadius: 8, background: 'rgba(1,4,9,.35)', border: '1px solid var(--border-subtle, #21262d)', fontSize: 12.5,
              }}>
                {p.top!.map((s) => (
                  <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                    {dot(s.attached)}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                    {s.branch && <Tag color="cyan" style={{ margin: 0, fontSize: 10.5, lineHeight: '16px', padding: '0 5px' }}>⎇</Tag>}
                    <span style={{ marginLeft: 'auto', color: 'var(--text-dimmer)', fontSize: 11.5, flex: '0 0 auto' }}>{relTime(s.lastActivity, t)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {data.loose.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '16px 2px 6px', color: 'var(--text-dim)', fontSize: 12 }}>
            <b>{t('project.loose')}</b><span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10.5 }}>{data.loose.length}</span>
            <span style={{ flex: 1, borderTop: '1px dashed var(--border-subtle, #21262d)' }} />
          </div>
          {data.loose.map((s) => (
            <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, cursor: 'pointer' }}
              onClick={() => openTerm(s.name)}>
              {dot(s.attached)}
              <span style={{ fontWeight: 600 }}>{s.name}</span>
              <span style={{ color: 'var(--text-dimmer)', fontSize: 12 }}>{relTime(s.lastActivity, t)}</span>
              <span style={{ flex: 1 }} />
              <a style={{ fontSize: 12.5 }}>{t('project.enter')}</a>
            </div>
          ))}
        </>
      )}
      <NewSessionModal open={newOpen} onClose={() => setNewOpen(false)} onDone={(n) => { openTerm(n); refresh() }} />
    </div>
  )
}

// ── P2 项目主页：composer + 任务流 ───────────────────────
function ProjectHome({ proj, loaded, openTerm, refresh }: {
  proj?: Proj; loaded: boolean; openTerm: (n: string) => void; refresh: () => void
}) {
  const { t } = useI18n()
  const { message } = AntApp.useApp()
  const [prefs] = usePreferences()
  const [prompt, setPrompt] = useState('')
  const [wtMode, setWtMode] = useState<'new' | 'repo' | 'existing'>('new')
  const [agent, setAgent] = useState<'claude' | 'codex' | 'none'>('claude')
  const [wts, setWts] = useState<any[]>([])
  const [wtPath, setWtPath] = useState('')
  const [sessions, setSessions] = useState<any[]>([])
  const [ann, setAnn] = useState<Record<string, any>>({})
  const [cc, setCc] = useState<Record<string, boolean>>({})
  const [cx, setCx] = useState<Record<string, boolean>>({})
  const [creating, setCreating] = useState(false)
  const [wtOpen, setWtOpen] = useState(false)
  const [fullForm, setFullForm] = useState(false)
  const [forking, setForking] = useState<string | null>(null)
  const dir = proj?.dir || ''

  // worktree 清单（「已有(N)」档 + 待收尾/可清理分区）
  useEffect(() => {
    if (!dir) return
    let stop = false
    const loadWts = () => api('GET', `/git/worktrees?dir=${encodeURIComponent(dir)}`).then((r) => {
      if (stop) return
      const list = (Array.isArray(r?.data) ? r.data : []).filter((w: any) => !w.isMain && !w.prunable)
      setWts(list)
      setWtPath((prev) => (prev && list.some((w: any) => w.path === prev) ? prev : (list[0]?.path || '')))
    }).catch(() => {})
    loadWts()
    const i = setInterval(loadWts, 5000)
    return () => { stop = true; clearInterval(i) }
  }, [dir])
  // 会话 + 归属注解（任务流数据源，与会话页同两条接口）
  useEffect(() => {
    let stop = false
    const loadSess = () => api('GET', '/sessions?tree=1').then((roots) => {
      if (stop) return
      const flat: any[] = []
      const walk = (nodes: any[]) => { for (const n of nodes || []) { flat.push(n); walk(n.children) } }
      walk(Array.isArray(roots) ? roots : [])
      setSessions(flat)
    }).catch(() => {})
    const loadAnn = () => api('GET', '/sessions/annotations').then((r) => { if (!stop) setAnn(r?.data || {}) }).catch(() => {})
    loadSess(); loadAnn()
    const i = setInterval(() => { loadSess(); loadAnn() }, 5000)
    return () => { stop = true; clearInterval(i) }
  }, [dir])
  const mine = useMemo(
    () => sessions.filter((s) => ann[s.name]?.primary?.repo === dir),
    [sessions, ann, dir],
  )
  // Agent 运行标注（仅本项目会话，量小）
  useEffect(() => {
    let stop = false
    const check = () => mine.forEach(async (s: any) => {
      try { const r = await api('GET', `/sessions/${encodeURIComponent(s.name)}/claude`); if (!stop) setCc((m) => ({ ...m, [s.name]: !!r.data?.running })) } catch {}
      try { const r = await api('GET', `/sessions/${encodeURIComponent(s.name)}/codex`); if (!stop) setCx((m) => ({ ...m, [s.name]: !!r.data?.running })) } catch {}
    })
    if (mine.length) check()
    const i = setInterval(() => { if (mine.length) check() }, 6000)
    return () => { stop = true; clearInterval(i) }
  }, [mine])

  const orphans = useMemo(() => wts.filter((w) => !w.external && !(w.sessions?.length)), [wts])
  const unfinished = orphans.filter((w) => w.committedAhead > 0 || w.dirty > 0 || w.untracked > 0)
  const clean = orphans.filter((w) => !(w.committedAhead > 0 || w.dirty > 0 || w.untracked > 0))

  // composer 提交：与 NewSessionModal 完全同款的派生/编排/命名约定（W1 修订 2/3/4）
  const goCreate = async () => {
    if (!dir || creating) return
    if (!prompt.trim()) { message.error(t('session.promptOrNameRequired')); return }
    let finalName = taskNameFromPrompt(prompt).slice(0, 16).replace(/[-，。,.\s]+$/g, '')
    if (!finalName) {
      const d = new Date()
      finalName = 'task-' + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0')
    }
    try {
      setCreating(true)
      let actual: string
      if (wtMode === 'new') {
        const res = await api('POST', '/worktree-sessions', { name: finalName, dir })
        actual = res.name || res.data?.session || finalName
      } else {
        const sessionDir = wtMode === 'existing' && wtPath ? wtPath : dir
        const res = await api('POST', '/sessions', { name: finalName, dir: sessionDir })
        actual = res.name || finalName
      }
      if (agent !== 'none') {
        const cmd = agent === 'claude' ? (prefs.claudeCommand || 'claude') : (prefs.codexCommand || 'codex')
        const naming = wtMode === 'new' ? t('session.wt.namingHint') + '\n\n' : ''
        await api('POST', '/tasks/_/send', { sess: actual, msg: `${cmd} ${shq(naming + prompt.trim())}` })
      }
      setPrompt(''); message.success(t('session.created')); openTerm(actual); refresh()
    } catch (e: any) { message.error(e.message) }
    finally { setCreating(false) }
  }
  // 复活孤儿：新开会话 cwd 指进该 worktree（=「已有」档语义）
  const revive = async (w: any) => {
    const name = (w.branch || 'wt').replace(/[^a-zA-Z0-9_.-]+/g, '-')
    try {
      const res = await api('POST', '/sessions', { name, dir: w.path })
      message.success(t('session.created')); openTerm(res.name || name); refresh()
    } catch (e: any) { message.error(e.message) }
  }

  if (!proj) {
    return (
      <div style={{ padding: 24, color: 'var(--text-dim)' }}>
        {loaded ? t('project.notFound') : <Spin />}
        <div style={{ marginTop: 12 }}><a onClick={() => { location.hash = '#/projects' }}>‹ {t('project.back')}</a></div>
      </div>
    )
  }

  const row = (s: any) => {
    const a = ann[s.name] || {}
    const hit = a.primary || {}
    const isChild = !!s.parent && mine.some((x) => x.name === s.parent)
    return (
      <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px', borderRadius: 9, cursor: 'pointer', marginLeft: isChild ? 22 : 0 }}
        onClick={() => openTerm(s.name)}>
        {dot(Number(s.attached) > 0)}
        {isChild && <span style={{ color: 'var(--purple, #a371f7)', fontSize: 12 }}>⑂</span>}
        <span style={{ fontWeight: 700 }}>{s.name}</span>
        {hit.linked && hit.branch && <Tag color="cyan" style={{ margin: 0 }}>⎇ {hit.branch}</Tag>}
        {hit.external && hit.linked && <Tag style={{ margin: 0 }}>⧉</Tag>}
        {cc[s.name] && <Tag color="blue" style={{ margin: 0 }}>Claude</Tag>}
        {cx[s.name] && <Tag color="green" style={{ margin: 0 }}>Codex</Tag>}
        {a.ambiguous && (
          <Tooltip title={(a.matches || []).map((m: any) => m.worktree).join('\n')}>
            <span style={{ color: 'var(--yellow, #d29922)' }}>⚠</span>
          </Tooltip>
        )}
        <span style={{ color: 'var(--text-dimmer)', fontSize: 12 }}>{relTime(s.last_activity, t)}</span>
        <span style={{ flex: 1 }} />
        <a style={{ fontSize: 12.5 }} onClick={(e) => { e.stopPropagation(); openTerm(s.name) }}>{t('project.enter')}</a>
        <a style={{ fontSize: 12.5 }} onClick={(e) => { e.stopPropagation(); setForking(s.name) }}>{t('project.forkTask')}</a>
      </div>
    )
  }
  const sect = (label: string, count: number, warn?: boolean) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 2px 4px', fontSize: 12, color: warn ? 'var(--yellow, #d29922)' : 'var(--text-dim)' }}>
      <b>{label}</b><span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10.5, color: 'var(--text-dimmer)' }}>{count}</span>
      <span style={{ flex: 1, borderTop: '1px dashed var(--border-subtle, #21262d)' }} />
    </div>
  )

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      {/* 项目头 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <a onClick={() => { location.hash = '#/projects' }} style={{ color: 'var(--text-dim)', fontSize: 16 }}>‹</a>
        <span style={{ fontSize: 16, fontWeight: 700 }}>⌂ {proj.name}</span>
        <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, color: 'var(--text-dimmer)' }}>{proj.dir}</span>
        <span style={{ flex: 1 }} />
        <Button size="small" onClick={() => setWtOpen(true)}>{t('project.wtManage')}</Button>
      </div>

      {/* Composer（Codex 式）：需求 ⏎ 开干 */}
      <div style={{ background: 'var(--bg-container, rgba(177,186,196,.04))', border: '1px solid var(--border, #30363d)', borderRadius: 12, padding: '4px 4px 8px' }}>
        <Input.TextArea value={prompt} onChange={(e) => setPrompt(e.target.value)}
          placeholder={t('project.composerPlaceholder')} autoSize={{ minRows: 2, maxRows: 6 }} variant="borderless"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); goCreate() } }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '4px 8px 0' }}>
          <Segmented size="small" value={wtMode} onChange={(v) => setWtMode(v as any)} options={[
            { label: '⎇ ' + t('project.where.new'), value: 'new' },
            { label: t('project.where.repo'), value: 'repo' },
            { label: t('project.where.existing', { count: wts.length }), value: 'existing', disabled: !wts.length },
          ]} />
          {wtMode === 'existing' && (
            <Select size="small" style={{ minWidth: 160 }} value={wtPath} onChange={setWtPath}
              options={wts.map((w: any) => ({ value: w.path, label: '⎇ ' + (w.branch || w.path.split('/').pop()) }))} />
          )}
          {wtMode === 'new' && <span style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>{t('project.baseDefault')}</span>}
          <Segmented size="small" value={agent} onChange={(v) => setAgent(v as any)} options={[
            { label: 'Claude', value: 'claude' }, { label: 'Codex', value: 'codex' }, { label: t('project.agent.none'), value: 'none' },
          ]} />
          <span style={{ flex: 1 }} />
          <a style={{ fontSize: 11.5 }} onClick={() => setFullForm(true)}>{t('project.fullForm')} ›</a>
          <Button type="primary" size="small" loading={creating} onClick={goCreate}>{t('project.go')}</Button>
        </div>
      </div>

      {/* 任务流：进行中（会话）/ 待收尾（孤儿 worktree）/ 可清理 */}
      {sect(t('project.section.active'), mine.length)}
      {mine.map(row)}
      {mine.length === 0 && <div style={{ color: 'var(--text-dimmer)', fontSize: 12.5, padding: '4px 10px' }}>{t('project.noTasks')}</div>}

      {unfinished.length > 0 && (<>
        {sect(t('project.section.unfinished'), unfinished.length, true)}
        {unfinished.map((w: any) => (
          <div key={w.path} style={{
            display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px', borderRadius: 9,
            background: 'rgba(210,153,34,.05)', border: '1px solid rgba(210,153,34,.2)', marginBottom: 4, flexWrap: 'wrap',
          }}>
            <Tag color="cyan" style={{ margin: 0 }}>⎇ {w.branch}</Tag>
            <Tag color="warning" style={{ margin: 0 }}>{t('project.sessionClosed')}</Tag>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{t('project.aheadDirty', { ahead: w.committedAhead, dirty: w.dirty + w.untracked })}</span>
            <span style={{ color: 'var(--text-dimmer)', fontSize: 12 }}>{relTime(w.lastCommitAt, t)}</span>
            <span style={{ flex: 1 }} />
            <a style={{ fontSize: 12.5 }} onClick={() => revive(w)}>{t('project.revive')}</a>
            <a style={{ fontSize: 12.5 }} onClick={() => setWtOpen(true)}>{t('project.finish')}</a>
          </div>
        ))}
      </>)}

      {clean.length > 0 && (<>
        {sect(t('project.section.clean'), clean.length)}
        {clean.map((w: any) => (
          <div key={w.path} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', borderRadius: 9 }}>
            <Tag color="cyan" style={{ margin: 0 }}>⎇ {w.branch}</Tag>
            <span style={{ fontSize: 12, color: 'var(--text-dimmer)' }}>{t('project.mergedClean')}</span>
            <span style={{ flex: 1 }} />
            <a style={{ fontSize: 12.5 }} onClick={() => revive(w)}>{t('project.revive')}</a>
            <a style={{ fontSize: 12.5 }} onClick={() => setWtOpen(true)}>{t('project.manage')}</a>
          </div>
        ))}
      </>)}

      <Suspense fallback={<Spin />}>
        {wtOpen && <WorktreePanel open={wtOpen} onClose={() => { setWtOpen(false); refresh() }} openTerm={openTerm} initialDir={dir} />}
      </Suspense>
      {/* 完整表单（W1 弹窗）与 派生（parent 固定）都复用同一张表单 */}
      <NewSessionModal open={fullForm || !!forking} parent={forking}
        onClose={() => { setFullForm(false); setForking(null) }}
        onDone={(n) => { openTerm(n); refresh() }} />
    </div>
  )
}
