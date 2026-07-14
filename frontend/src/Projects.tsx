// 项目页（08 设计）——「项目 = 目录（git 可选），任务驱动」：
//   #/projects        P1 列表：GET /projects 聚合卡片（发现/退场在后端读时收敛）+ 散会话
//   #/projects/<key>  P2 主页：composer（描述任务 ⏎ 开干）+ 任务流（会话 ∪ 孤儿 worktree）
//                     + Worktree / 编队 / 活动 tab（仅 git 项目开启）
// 项目是后台存储对象（POST/DELETE /projects）；开 session、建 feature 是项目内的动作。
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { App as AntApp, AutoComplete, Button, Input, Modal, Popconfirm, Segmented, Select, Space, Spin, Tag, Tooltip } from 'antd'
import { api } from './api'
import { useI18n } from './i18n'
import { usePreferences } from './preferences'
import { detectPrompt } from './prompt'
import { relTime, taskNameFromPrompt, shq, NewSessionModal, DirPicker, recentDirs, pushRecentDir, CloseWorktreeModal } from './App'

const WorktreePanel = lazy(() => import('./WorktreePanel'))
const GitPanel = lazy(() => import('./GitPanel'))
const RaceCreateModal = lazy(() => import('./Race').then((m) => ({ default: m.RaceCreateModal })))
const RaceComparePanel = lazy(() => import('./Race').then((m) => ({ default: m.RaceComparePanel })))

type ProjSession = { name: string; attached: boolean; lastActivity: number; branch?: string; linked?: boolean }
type Proj = {
  key: string; name: string; dir: string; git: boolean; pinned: boolean
  sessions: number; attached: number; worktrees: number; unfinished: number; races: number
  lastActivity: number; top: ProjSession[] | null
}

const dot = (on: boolean, color?: string) => (
  <span style={{
    width: 8, height: 8, borderRadius: '50%', flex: '0 0 8px', display: 'inline-block',
    background: color || (on ? 'var(--green, #3fb950)' : 'var(--text-dimmer, #6e7681)'),
  }} />
)

// ── 生命周期导轨（P2 图纸）：建→干→审→并，当前段呼吸 ──────
const LIFEC_COLORS = ['#39c5cf', '#3fb950', '#d29922', '#a371f7']
function Lifec({ done, cur }: { done: number; cur?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      {[1, 2, 3, 4].map((i) => (
        <i key={i} style={{
          width: 11, height: 4, borderRadius: 2,
          background: i <= done || i === cur ? LIFEC_COLORS[i - 1] : 'rgba(139,148,158,.25)',
          animation: i === cur ? 'projLifecPulse 1.6s ease-in-out infinite' : undefined,
        }} />
      ))}
      <style>{'@keyframes projLifecPulse{0%,100%{opacity:1}50%{opacity:.35}}'}</style>
    </span>
  )
}

export default function Projects({ openTerm, initialKey }: { openTerm: (n: string) => void; initialKey?: string }) {
  const [data, setData] = useState<{ projects: Proj[]; loose: ProjSession[] }>({ projects: [], loose: [] })
  const [loaded, setLoaded] = useState(false)
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

// ── 新项目弹窗：创建的是「项目」这个存储对象（POST /projects），不建任何会话。
// 项目 = 任意目录（git 可选）；开 session / 建 feature 是进项目之后 composer 的事。
function NewProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n()
  const { message } = AntApp.useApp()
  const [dir, setDir] = useState('')
  const [name, setName] = useState('')
  const [pick, setPick] = useState(false)
  const [creating, setCreating] = useState(false)
  useEffect(() => { if (open) { setDir(''); setName('') } }, [open])
  const ok = async () => {
    if (!dir.trim()) { message.error(t('session.dirPlaceholder')); return }
    try {
      setCreating(true)
      const res = await api('POST', '/projects', { dir: dir.trim(), displayName: name.trim() })
      pushRecentDir(dir.trim())
      message.success(t('project.createdProject'))
      onClose()
      location.hash = '#/projects/' + encodeURIComponent(res.data.key)
    } catch (e: any) { message.error(e.message) }
    finally { setCreating(false) }
  }
  return (
    <>
      <Modal open={open} onCancel={onClose} onOk={ok} title={t('project.newModalTitle')}
        okText={t('file.create')} destroyOnClose confirmLoading={creating}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space.Compact style={{ width: '100%' }}>
            <AutoComplete style={{ flex: 1 }} value={dir} onChange={setDir} autoFocus
              options={recentDirs().map((d) => ({ value: d }))}
              filterOption={(input, opt) => String(opt?.value).toLowerCase().includes(input.toLowerCase())}
              placeholder={t('session.dirPlaceholder')} />
            <Button onClick={() => setPick(true)}>{t('common.browse')}</Button>
          </Space.Compact>
          <Input placeholder={t('project.displayName')} value={name} onChange={(e) => setName(e.target.value)} />
          <div style={{ fontSize: 12, color: 'var(--text-dimmer)' }}>{t('project.newHint')}</div>
        </Space>
      </Modal>
      <DirPicker open={pick} start={dir} onPick={(p) => { setDir(p); setPick(false) }} onClose={() => setPick(false)} />
    </>
  )
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
  const remove = async (p: Proj) => {
    try { await api('DELETE', `/projects/${encodeURIComponent(p.key)}`); message.success(t('project.removed')); refresh() }
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
        <Button type="primary" size="small" onClick={() => setNewOpen(true)}>{t('project.newProject')}</Button>
      </div>

      {loaded && data.projects.length === 0 && (
        <div style={{ color: 'var(--text-dim)', padding: '24px 4px' }}>{t('project.empty')}</div>
      )}
      <style>{'.prj-card .prj-acts{opacity:.25;transition:opacity .15s}.prj-card:hover .prj-acts{opacity:1}.prj-card .prj-acts .pinned{opacity:1}'}</style>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))', gap: 12 }}>
        {data.projects.map((p) => (
          <div key={p.key} onClick={() => open(p)} className="prj-card"
            style={{
              background: 'var(--bg-container, rgba(177,186,196,.04))', border: '1px solid var(--border-subtle, #21262d)',
              borderRadius: 12, padding: '13px 14px 11px', cursor: 'pointer',
              display: 'flex', flexDirection: 'column', gap: 8,
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 14.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              {p.races > 0 && <Tag color="gold" style={{ margin: 0 }}>{t('project.race', { count: p.races })}</Tag>}
              <span style={{ flex: 1 }} />
              <span className="prj-acts" style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
                <Tooltip title={p.pinned ? t('project.unpin') : t('project.pin')}>
                  <a className={p.pinned ? 'pinned' : ''} onClick={(e) => { e.stopPropagation(); pin(p) }}
                    style={{ color: p.pinned ? 'var(--yellow, #d29922)' : 'var(--text-dimmer)', fontSize: 13 }}>★</a>
                </Tooltip>
                <Popconfirm title={t('project.removeConfirm')} onConfirm={() => remove(p)}
                  onPopupClick={(e) => e.stopPropagation()}>
                  <a onClick={(e) => e.stopPropagation()} style={{ color: 'var(--text-dimmer)', fontSize: 12 }}>✕</a>
                </Popconfirm>
              </span>
            </div>
            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'var(--text-dimmer)', marginTop: -4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.dir}>{p.dir}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-dim)' }}>
              <span><b style={{ color: 'var(--text-bright, inherit)' }}>{p.sessions}</b> {t('project.tasks')}</span>
              {p.git && <>·<span><b style={{ color: 'var(--text-bright, inherit)' }}>{p.worktrees}</b> worktree</span></>}
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
      <NewProjectModal open={newOpen} onClose={() => { setNewOpen(false); refresh() }} />
    </div>
  )
}

// ── composer 选项 pill（P2 图纸样式）─────────────────────
function Pill({ on, cyan, disabled, onClick, children }: {
  on?: boolean; cyan?: boolean; disabled?: boolean; onClick?: () => void; children: any
}) {
  const color = on ? (cyan ? '#39c5cf' : '#79b8ff') : 'var(--text-dim)'
  return (
    <span onClick={disabled ? undefined : onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 11px',
      borderRadius: 999, fontSize: 12, cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
      color, opacity: disabled ? 0.45 : 1,
      border: `1px solid ${on ? (cyan ? 'rgba(57,197,207,.5)' : 'rgba(56,139,253,.55)') : 'var(--border, #30363d)'}`,
      background: on ? (cyan ? 'rgba(57,197,207,.1)' : 'rgba(31,111,235,.14)') : 'rgba(177,186,196,.03)',
    }}>{children}</span>
  )
}

// 终端捕获 → 尾行预览：去 ANSI/OSC，取最后一行非空输出
function tailLine(raw: string): string {
  const clean = String(raw || '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean)
  return (lines[lines.length - 1] || '').slice(0, 90)
}

// ── P2 项目主页：头部 + composer + 任务流/Worktree/编队/活动 ──
function ProjectHome({ proj, loaded, openTerm, refresh }: {
  proj?: Proj; loaded: boolean; openTerm: (n: string) => void; refresh: () => void
}) {
  const { t } = useI18n()
  const { message } = AntApp.useApp()
  const [prefs] = usePreferences()
  const [tab, setTab] = useState<'tasks' | 'wt' | 'race' | 'act'>('tasks')
  const [prompt, setPrompt] = useState('')
  const [wtMode, setWtMode] = useState<'new' | 'repo' | 'existing'>('new')
  const [agent, setAgent] = useState<'claude' | 'codex' | 'none'>('claude')
  const [wtsAll, setWtsAll] = useState<any[]>([])
  const [wtPath, setWtPath] = useState('')
  const [defBranch, setDefBranch] = useState('')
  const [sessions, setSessions] = useState<any[]>([])
  const [ann, setAnn] = useState<Record<string, any>>({})
  const [cc, setCc] = useState<Record<string, boolean>>({})
  const [cx, setCx] = useState<Record<string, boolean>>({})
  const [needsInput, setNeedsInput] = useState<Record<string, boolean>>({})
  const [races, setRaces] = useState<any[]>([])
  const [activity, setActivity] = useState<any[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [peeks, setPeeks] = useState<Record<string, string>>({})
  const [creating, setCreating] = useState(false)
  const [wtOpen, setWtOpen] = useState(false)
  const [gitOpen, setGitOpen] = useState(false)
  const [fullForm, setFullForm] = useState(false)
  const [forking, setForking] = useState<string | null>(null)
  const [closing, setClosing] = useState<{ name: string; st: any } | null>(null)
  const [raceOpen, setRaceOpen] = useState(false)
  const [compareRace, setCompareRace] = useState<any>(null)
  const dir = proj?.dir || ''
  const isGit = !!proj?.git

  // worktree 清单（含 main，用于 HEAD 展示；「已有(N)」与任务流用非 main 子集）
  useEffect(() => {
    if (!dir || !isGit) { setWtsAll([]); return }
    let stop = false
    const loadWts = () => api('GET', `/git/worktrees?dir=${encodeURIComponent(dir)}`).then((r) => {
      if (stop) return
      setWtsAll(Array.isArray(r?.data) ? r.data : [])
    }).catch(() => {})
    loadWts()
    const i = setInterval(loadWts, 5000)
    return () => { stop = true; clearInterval(i) }
  }, [dir, isGit])
  useEffect(() => {
    if (!dir || !isGit) return
    api('GET', `/git/branches?dir=${encodeURIComponent(dir)}`)
      .then((r) => setDefBranch(r?.data?.default || '')).catch(() => {})
  }, [dir, isGit])
  const wts = useMemo(() => wtsAll.filter((w: any) => !w.isMain && !w.prunable), [wtsAll])
  const mainHead = useMemo(() => (wtsAll.find((w: any) => w.isMain)?.head || '').slice(0, 7), [wtsAll])
  useEffect(() => {
    setWtPath((prev) => (prev && wts.some((w: any) => w.path === prev) ? prev : (wts[0]?.path || '')))
  }, [wts])
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
  // 竞赛（编队 tab + 任务计数）
  useEffect(() => {
    if (!isGit) return
    let stop = false
    const loadRaces = () => api('GET', '/races').then((r) => {
      if (!stop) setRaces((Array.isArray(r?.data) ? r.data : []).filter((x: any) => x.dir === dir))
    }).catch(() => {})
    loadRaces()
    const i = setInterval(loadRaces, 8000)
    return () => { stop = true; clearInterval(i) }
  }, [dir, isGit])
  // 活动流（懒加载：切到活动 tab 才拉，60s 后端缓存）
  useEffect(() => {
    if (tab !== 'act' || !proj) return
    let stop = false
    const loadAct = () => api('GET', `/projects/${encodeURIComponent(proj.key)}/activity`)
      .then((r) => { if (!stop) setActivity(Array.isArray(r?.data) ? r.data : []) }).catch(() => {})
    loadAct()
    const i = setInterval(loadAct, 30000)
    return () => { stop = true; clearInterval(i) }
  }, [tab, proj?.key])

  const mine = useMemo(() => {
    if (!dir) return []
    if (isGit) return sessions.filter((s) => ann[s.name]?.primary?.repo === dir)
    // 非 git 项目：按后端 top 无法覆盖全部——用 loose 语义近似（后端已按 cwd 前缀归属，
    // 这里直接复用后端 sessions 计数对应的名单：ann 无记录且会话 cwd 前端不可知，
    // 退化为展示后端 top + 计数；完整名单等后端 detail 接口。先按 ann 缺失全列会有误，
    // 故仅展示 proj.top（后端已认领的前 2）之外提示进「全部会话」。
    return sessions.filter((s) => (proj?.top || []).some((x) => x.name === s.name))
  }, [sessions, ann, dir, isGit, proj])
  // Agent 运行标注 + 待输入检测（仅本项目会话，量小）
  useEffect(() => {
    let stop = false
    const check = () => mine.forEach(async (s: any) => {
      try { const r = await api('GET', `/sessions/${encodeURIComponent(s.name)}/claude`); if (!stop) setCc((m) => ({ ...m, [s.name]: !!r.data?.running })) } catch {}
      try { const r = await api('GET', `/sessions/${encodeURIComponent(s.name)}/codex`); if (!stop) setCx((m) => ({ ...m, [s.name]: !!r.data?.running })) } catch {}
      try { const r = await api('GET', `/sessions/${encodeURIComponent(s.name)}/capture?lines=50`); if (!stop) setNeedsInput((m) => ({ ...m, [s.name]: !!detectPrompt(r.data || '') })) } catch {}
    })
    if (mine.length) check()
    const i = setInterval(() => { if (mine.length) check() }, 6000)
    return () => { stop = true; clearInterval(i) }
  }, [mine])
  // 展开的 worktree 的命令行尾行预览（懒加载，5s）
  useEffect(() => {
    const names = wts.filter((w: any) => expanded[w.path]).flatMap((w: any) => (w.sessions || []).map((x: any) => x.session))
    if (!names.length) return
    let stop = false
    const peek = () => names.forEach(async (n: string) => {
      try { const r = await api('GET', `/sessions/${encodeURIComponent(n)}/capture?lines=8`); if (!stop) setPeeks((m) => ({ ...m, [n]: tailLine(r.data) })) } catch {}
    })
    peek()
    const i = setInterval(peek, 5000)
    return () => { stop = true; clearInterval(i) }
  }, [wts, expanded])

  const orphans = useMemo(() => wts.filter((w: any) => !w.external && !(w.sessions?.length)), [wts])
  const unfinished = orphans.filter((w: any) => w.committedAhead > 0 || w.dirty > 0 || w.untracked > 0)
  const clean = orphans.filter((w: any) => !(w.committedAhead > 0 || w.dirty > 0 || w.untracked > 0))
  const wtOf = (s: any) => wts.find((w: any) => w.path === ann[s.name]?.primary?.worktree)

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
      const wantWt = isGit && wtMode === 'new'
      if (wantWt) {
        const res = await api('POST', '/worktree-sessions', { name: finalName, dir })
        actual = res.name || res.data?.session || finalName
      } else {
        const sessionDir = isGit && wtMode === 'existing' && wtPath ? wtPath : dir
        const res = await api('POST', '/sessions', { name: finalName, dir: sessionDir })
        actual = res.name || finalName
      }
      if (agent !== 'none') {
        const cmd = agent === 'claude' ? (prefs.claudeCommand || 'claude') : (prefs.codexCommand || 'codex')
        const naming = wantWt ? t('session.wt.namingHint') + '\n\n' : ''
        await api('POST', '/tasks/_/send', { sess: actual, msg: `${cmd} ${shq(naming + prompt.trim())}` })
      }
      setPrompt(''); message.success(t('session.created')); openTerm(actual); refresh()
    } catch (e: any) { message.error(e.message) }
    finally { setCreating(false) }
  }
  // 新开命令行（P4）：shell = 裸会话；Claude/Codex = 会话 + 启动 agent。孤儿复活/外部收编同款。
  const newCli = async (w: any, kind: 'shell' | 'claude' | 'codex') => {
    const base = (w.branch || 'wt').replace(/[^a-zA-Z0-9_.-]+/g, '-')
    const name = kind === 'shell' ? `${base}-sh` : `${base}-${kind === 'claude' ? 'cc' : 'cx'}`
    try {
      const res = await api('POST', '/sessions', { name, dir: w.path })
      const actual = res.name || name
      if (kind !== 'shell') {
        const cmd = kind === 'claude' ? (prefs.claudeCommand || 'claude') : (prefs.codexCommand || 'codex')
        await api('POST', '/tasks/_/send', { sess: actual, msg: cmd })
      }
      message.success(t('session.created')); openTerm(actual); refresh()
    } catch (e: any) { message.error(e.message) }
  }
  // 收尾（W7 三选一）：会话在 worktree 内走 CloseWorktreeModal；否则普通关闭
  const beginClose = async (n: string) => {
    let st: any = null
    try { st = (await api('GET', `/sessions/${encodeURIComponent(n)}/worktree-status`))?.data } catch {}
    if (!st?.inWorktree || st.external) {
      Modal.confirm({
        title: t('project.killConfirm', { name: n }),
        onOk: async () => { try { await api('DELETE', '/sessions/' + encodeURIComponent(n)); message.success(t('session.closed')); refresh() } catch (e: any) { message.error(e.message) } },
      })
      return
    }
    setClosing({ name: n, st })
  }

  if (!proj) {
    return (
      <div style={{ padding: 24, color: 'var(--text-dim)' }}>
        {loaded ? t('project.notFound') : <Spin />}
        <div style={{ marginTop: 12 }}><a onClick={() => { location.hash = '#/projects' }}>‹ {t('project.back')}</a></div>
      </div>
    )
  }

  const sect = (label: string, count: number, warn?: boolean) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 2px 4px', fontSize: 12, color: warn ? 'var(--yellow, #d29922)' : 'var(--text-dim)' }}>
      <b>{label}</b><span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10.5, color: 'var(--text-dimmer)' }}>{count}</span>
      <span style={{ flex: 1, borderTop: '1px dashed var(--border-subtle, #21262d)' }} />
    </div>
  )

  // 任务行：生命周期导轨 = 建(必亮)→干(agent 跑)→审(待输入/有未合并)→并(merged)
  // 状态点语义收敛（设计 W2）：绿 = agent 正在干活，黄 = 待输入，其余一律灰——
  // 「已连接」不配绿点，否则满屏绿。
  const row = (s: any) => {
    const a = ann[s.name] || {}
    const hit = a.primary || {}
    const isChild = !!s.parent && mine.some((x) => x.name === s.parent)
    const w = wtOf(s)
    const ahead = w?.committedAhead || 0
    const changes = (w?.dirty || 0) + (w?.untracked || 0)
    const running = cc[s.name] || cx[s.name]
    const waiting = needsInput[s.name]
    let done = 2, cur: number | undefined, stage = t('project.stage.idle')
    if (running && !waiting) { done = 1; cur = 2; stage = t('project.stage.doing') }
    else if (waiting || ahead > 0) { done = 2; cur = 3; stage = t('project.stage.review') }
    return (
      <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px', borderRadius: 9, cursor: 'pointer', marginLeft: isChild ? 22 : 0 }}
        onClick={() => openTerm(s.name)}>
        {dot(false, waiting ? 'var(--yellow, #d29922)' : running ? 'var(--green, #3fb950)' : undefined)}
        {isChild && <span style={{ color: 'var(--purple, #a371f7)', fontSize: 12 }}>⑂</span>}
        <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700 }}>{s.name}</span>
            {hit.linked && hit.branch && <Tag color="cyan" style={{ margin: 0 }}>⎇ {hit.branch}</Tag>}
            {hit.external && hit.linked && <Tag style={{ margin: 0 }}>⧉</Tag>}
            {cc[s.name] && <Tag color="blue" style={{ margin: 0 }}>Claude</Tag>}
            {cx[s.name] && <Tag color="green" style={{ margin: 0 }}>Codex</Tag>}
            {waiting && <Tag color="warning" style={{ margin: 0 }}>{t('session.waiting')}</Tag>}
            {a.ambiguous && (
              <Tooltip title={(a.matches || []).map((m: any) => m.worktree).join('\n')}>
                <span style={{ color: 'var(--yellow, #d29922)' }}>⚠</span>
              </Tooltip>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-dimmer)' }}>
            <Lifec done={done} cur={cur} /><span>{stage}</span>
            {(ahead > 0 || changes > 0) && (
              <span>
                {ahead > 0 && <span style={{ color: 'var(--blue, #58a6ff)' }}>↑{ahead}</span>}
                {ahead > 0 && changes > 0 && ' · '}
                {changes > 0 && <span style={{ color: 'var(--yellow, #d29922)' }}>{t('project.wt.changes', { count: changes })}</span>}
              </span>
            )}
            <span>{relTime(s.last_activity, t)}</span>
          </div>
        </div>
        <span style={{ display: 'flex', gap: 12, fontSize: 12.5, flex: '0 0 auto' }} onClick={(e) => e.stopPropagation()}>
          <a onClick={() => openTerm(s.name)}>{t('project.enter')}</a>
          {hit.linked && <a onClick={() => setGitOpen(true)}>{t('project.compare')}</a>}
          <a onClick={() => setForking(s.name)}>{t('project.forkTask')}</a>
          <a style={{ color: 'var(--red, #f85149)' }} onClick={() => beginClose(s.name)}>{hit.linked ? t('project.finish') : t('common.close')}</a>
        </span>
      </div>
    )
  }

  const tabBtn = (k: typeof tab, label: string, n?: number) => (
    <span onClick={() => setTab(k)} style={{
      padding: '8px 13px 9px', fontSize: 13, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
      color: tab === k ? 'var(--text-bright, #e6edf3)' : 'var(--text-dim)',
      borderBottom: `2px solid ${tab === k ? 'var(--blue, #58a6ff)' : 'transparent'}`, marginBottom: -1,
      fontWeight: tab === k ? 600 : 400,
    }}>{label}{n !== undefined && <span style={{ fontSize: 10.5, fontFamily: 'ui-monospace, monospace', color: 'var(--text-dimmer)', background: 'rgba(177,186,196,.08)', borderRadius: 999, padding: '1px 6px' }}>{n}</span>}</span>
  )

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      {/* 项目头：面包屑返回 + ⌂ 图标块 + 名称 + 路径 · ⎇主干 @ HEAD + [Git 面板][Worktree 管理] */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <Button type="text" size="small" onClick={() => { location.hash = '#/projects' }}
          style={{ color: 'var(--text-dim)', paddingInline: 6 }}>‹ {t('project.title')}</Button>
        <span style={{ width: 1, height: 18, background: 'var(--border-subtle, #21262d)' }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{proj.name}</div>
          <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, color: 'var(--text-dimmer)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span>{proj.dir}</span>
            {isGit && defBranch && <span style={{ color: 'var(--cyan, #39c5cf)' }}>⎇ {defBranch}{mainHead ? ` @ ${mainHead}` : ''}</span>}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        {isGit && <Button size="small" onClick={() => setGitOpen(true)}>{t('project.gitPanel')}</Button>}
        {isGit && <Button size="small" onClick={() => setWtOpen(true)}>{t('project.wtManage')}</Button>}
      </div>

      {/* Composer（Codex 式）：需求 ⏎ 开干；pill 选项与 P2 图纸对齐 */}
      <div style={{ background: 'var(--bg-container, rgba(177,186,196,.04))', border: '1px solid var(--border, #30363d)', borderRadius: 12, padding: '4px 4px 8px' }}>
        <Input.TextArea value={prompt} onChange={(e) => setPrompt(e.target.value)}
          placeholder={isGit ? t('project.composerPlaceholder') : t('project.composerPlain')} autoSize={{ minRows: 2, maxRows: 6 }} variant="borderless"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); goCreate() } }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '4px 8px 0' }}>
          {isGit && (<>
            <Pill on={wtMode === 'new'} cyan onClick={() => setWtMode('new')}>⎇ {t('project.where.new')}</Pill>
            <Pill on={wtMode === 'repo'} onClick={() => setWtMode('repo')}>{t('project.where.repo')}</Pill>
            <Pill on={wtMode === 'existing'} disabled={!wts.length} onClick={() => setWtMode('existing')}>{t('project.where.existing', { count: wts.length })}</Pill>
            {wtMode === 'existing' && (
              <Select size="small" style={{ minWidth: 160 }} value={wtPath} onChange={setWtPath}
                options={wts.map((w: any) => ({ value: w.path, label: '⎇ ' + (w.branch || w.path.split('/').pop()) }))} />
            )}
            {wtMode === 'new' && <span style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>{defBranch ? t('project.basedOn', { base: defBranch }) : t('project.baseDefault')}</span>}
            <span style={{ width: 1, height: 16, background: 'var(--border, #30363d)' }} />
          </>)}
          <Pill on={agent === 'claude'} onClick={() => setAgent('claude')}>Claude</Pill>
          <Pill on={agent === 'codex'} onClick={() => setAgent('codex')}>Codex</Pill>
          <Pill on={agent === 'none'} onClick={() => setAgent('none')}>{t('project.agent.none')}</Pill>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>{t('project.autoName')} · <a style={{ fontSize: 11.5 }} onClick={() => setFullForm(true)}>{t('project.fullForm')} ›</a></span>
          <Button type="primary" size="small" loading={creating} onClick={goCreate}>{t('project.go')}</Button>
        </div>
      </div>

      {/* Tabs：任务 | Worktree | 编队 | 活动（非 git 只有任务） */}
      <div style={{ display: 'flex', gap: 2, margin: '14px 0 6px', borderBottom: '1px solid var(--border-subtle, #21262d)' }}>
        {tabBtn('tasks', t('project.tasks'), mine.length + unfinished.length + clean.length)}
        {isGit && tabBtn('wt', 'Worktree', wts.length)}
        {isGit && tabBtn('race', t('project.tab.race'), races.length)}
        {isGit && tabBtn('act', t('project.tab.activity'))}
      </div>

      {/* ── 任务流 ── */}
      {tab === 'tasks' && (<>
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
              {dot(false, 'var(--yellow, #d29922)')}
              <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                  <Tag color="cyan" style={{ margin: 0 }}>⎇ {w.branch}</Tag>
                  <Tag color="warning" style={{ margin: 0 }}>{t('project.sessionClosed')}</Tag>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-dimmer)' }}>
                  <Lifec done={2} cur={3} /><span>{t('project.stage.unfinished')}</span>
                  <span>{t('project.aheadDirty', { ahead: w.committedAhead, dirty: w.dirty + w.untracked })}</span>
                  <span>{relTime(w.lastCommitAt, t)}</span>
                </div>
              </div>
              <span style={{ display: 'flex', gap: 12, fontSize: 12.5 }}>
                <a style={{ color: 'var(--yellow, #d29922)' }} onClick={() => setWtOpen(true)}>{t('project.finish')}</a>
                <a onClick={() => newCli(w, 'shell')}>{t('project.revive')}</a>
                <a onClick={() => setGitOpen(true)}>{t('project.compare')}</a>
              </span>
            </div>
          ))}
        </>)}

        {clean.length > 0 && (<>
          {sect(t('project.section.clean'), clean.length)}
          {clean.map((w: any) => (
            <div key={w.path} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', borderRadius: 9 }}>
              {dot(false, 'var(--purple, #a371f7)')}
              <Tag color="purple" style={{ margin: 0 }}>⇥ {t('project.mergedClean')}</Tag>
              <Tag color="cyan" style={{ margin: 0 }}>⎇ {w.branch}</Tag>
              <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--text-dimmer)' }}>
                <Lifec done={4} /><span>{t('project.stage.done')}</span>
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ display: 'flex', gap: 12, fontSize: 12.5 }}>
                <a onClick={() => newCli(w, 'shell')}>{t('project.revive')}</a>
                <a onClick={() => setWtOpen(true)}>{t('project.cleanup')}</a>
              </span>
            </div>
          ))}
        </>)}
      </>)}

      {/* ── Worktree tab（P4：行可展开 → 命令行 + 尾行预览 + 新开命令行）── */}
      {tab === 'wt' && (
        <div style={{ background: 'var(--bg-container, rgba(177,186,196,.03))', border: '1px solid var(--border-subtle, #21262d)', borderRadius: 12, marginTop: 6 }}>
          {wts.length === 0 && <div style={{ color: 'var(--text-dimmer)', fontSize: 12.5, padding: 14 }}>{t('project.noTasks')}</div>}
          {wts.map((w: any, i: number) => {
            const open = !!expanded[w.path]
            const live = (w.sessions || []).length
            return (
              <div key={w.path} style={{ padding: '13px 16px', borderBottom: i < wts.length - 1 ? '1px solid var(--border-subtle, #21262d)' : undefined }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
                  onClick={() => setExpanded((m) => ({ ...m, [w.path]: !open }))}>
                  <span style={{ fontSize: 10, color: 'var(--text-dimmer)', width: 12, display: 'inline-block', transform: open ? 'rotate(90deg)' : undefined, transition: 'transform .15s' }}>▸</span>
                  <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13.5, fontWeight: 600, color: 'var(--cyan, #39c5cf)' }}>⎇ {w.branch}</span>
                  {w.external
                    ? <Tag style={{ margin: 0 }}>{t('project.wt.externalTag')}</Tag>
                    : live > 0
                      ? <Tag style={{ margin: 0 }}>{t('project.wt.cli', { count: live })}</Tag>
                      : <Tag color="warning" style={{ margin: 0 }}>{t('project.wt.orphanTag')}</Tag>}
                </div>
                <div style={{ marginLeft: 20, marginTop: 5, fontSize: 12, color: 'var(--text-dimmer)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span>{t('project.basedOn', { base: w.base || '?' })}</span>·
                  <span style={{ color: w.committedAhead > 0 ? 'var(--blue, #58a6ff)' : undefined }}>↑{w.committedAhead}</span>·
                  <span style={{ color: (w.dirty + w.untracked) > 0 ? 'var(--yellow, #d29922)' : undefined }}>{t('project.wt.changes', { count: w.dirty + w.untracked })}</span>·
                  <span>{relTime(w.lastCommitAt, t)}</span>
                </div>
                {open && (
                  <div style={{ margin: '8px 0 2px 5px', paddingLeft: 12, borderLeft: '2px solid rgba(57,197,207,.25)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {(w.sessions || []).map((ref: any) => {
                      return (
                        <div key={ref.session} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, cursor: 'pointer' }}
                          onClick={() => openTerm(ref.session)}>
                          {dot(false, cc[ref.session] || cx[ref.session] ? 'var(--green, #3fb950)' : undefined)}
                          <span style={{ fontWeight: 600, fontSize: 13 }}>{ref.session}</span>
                          {cc[ref.session] && <Tag color="blue" style={{ margin: 0, fontSize: 10.5, lineHeight: '16px' }}>Claude</Tag>}
                          {cx[ref.session] && <Tag color="green" style={{ margin: 0, fontSize: 10.5, lineHeight: '16px' }}>Codex</Tag>}
                          <span style={{
                            flex: 1, minWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'var(--text-dimmer)',
                            background: 'rgba(1,4,9,.55)', border: '1px solid var(--border-subtle, #21262d)', borderRadius: 6, padding: '3px 8px',
                          }}>{peeks[ref.session] || '…'}</span>
                          <a style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); openTerm(ref.session) }}>{t('project.enter')}</a>
                        </div>
                      )
                    })}
                    {live === 0 && <div style={{ fontSize: 12, color: 'var(--text-dimmer)', padding: '4px 8px' }}>{t('project.wt.noCli')}</div>}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', border: '1px dashed var(--border, #30363d)', borderRadius: 8, color: 'var(--text-dim)', fontSize: 12.5 }}>
                      {t('project.wt.newCli')}
                      <a onClick={() => newCli(w, 'shell')}>shell</a>·<a onClick={() => newCli(w, 'claude')}>Claude</a>·<a onClick={() => newCli(w, 'codex')}>Codex</a>
                    </div>
                  </div>
                )}
                <div style={{ marginTop: 9, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button size="small" onClick={() => setGitOpen(true)}>{t('project.wt.compareBase')}</Button>
                  {!w.external && <Button size="small" onClick={() => setWtOpen(true)}>{t('worktree.mergeInto', { base: w.base || '?' })} ▾</Button>}
                  <Tooltip title={live > 0 ? t('project.wt.busyDelete', { count: live }) : undefined}>
                    <Button size="small" danger disabled={live > 0} onClick={() => setWtOpen(true)}>{t('project.wt.delete')}</Button>
                  </Tooltip>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── 编队 tab：竞赛 + 蜂群（只列组，编排去对比台/蜂群页）── */}
      {tab === 'race' && (<>
        {races.map((r: any) => (
          <div key={r.id} style={{ background: 'var(--bg-container, rgba(177,186,196,.03))', border: '1px solid var(--border-subtle, #21262d)', borderRadius: 12, padding: '13px 16px', marginTop: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Tag color="gold" style={{ margin: 0 }}>RACE</Tag>
              <b>{r.name}</b>
              <span style={{ fontSize: 12, color: 'var(--text-dimmer)' }}>{t('project.race.meta', { count: (r.contestants || []).length, base: r.base })}</span>
              <span style={{ flex: 1 }} />
              <Button size="small" type="primary" onClick={() => setCompareRace(r)}>{t('project.race.compare')} →</Button>
            </div>
          </div>
        ))}
        {races.length === 0 && <div style={{ color: 'var(--text-dimmer)', fontSize: 12.5, padding: '12px 4px' }}>{t('project.formation.empty')}</div>}
        <div style={{ marginTop: 10 }}>
          <Button size="small" onClick={() => setRaceOpen(true)}>{t('project.newRace')}</Button>
        </div>
      </>)}

      {/* ── 活动 tab：全部分支近 30 天提交 ── */}
      {tab === 'act' && (
        <div style={{ background: 'var(--bg-container, rgba(177,186,196,.03))', border: '1px solid var(--border-subtle, #21262d)', borderRadius: 12, padding: '6px 4px', marginTop: 6 }}>
          {activity.map((e: any) => (
            <div key={e.oid + e.at} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 12.5, fontFamily: 'ui-monospace, monospace' }}>
              <span style={{ color: 'var(--cyan, #39c5cf)', opacity: 0.8 }}>{e.oid}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.subject}</span>
              <span style={{ marginLeft: 'auto', color: 'var(--text-dimmer)', fontSize: 11.5, flex: '0 0 auto' }}>
                {e.refs ? `${String(e.refs).split(',')[0]} · ` : ''}{relTime(e.at, t)}
              </span>
            </div>
          ))}
          {activity.length === 0 && <div style={{ color: 'var(--text-dimmer)', fontSize: 12.5, padding: 12 }}>{t('project.act.empty')}</div>}
          <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)', padding: '8px 12px', borderTop: '1px dashed var(--border-subtle, #21262d)' }}>{t('project.act.hint')}</div>
        </div>
      )}

      <Suspense fallback={<Spin />}>
        {wtOpen && <WorktreePanel open={wtOpen} onClose={() => { setWtOpen(false); refresh() }} openTerm={openTerm} initialDir={dir} />}
        {gitOpen && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(1,4,9,.6)' }} onClick={() => setGitOpen(false)}>
            <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 'min(520px, 94vw)', background: 'var(--bg-container, #161b22)', borderLeft: '1px solid var(--border, #30363d)' }}
              onClick={(e) => e.stopPropagation()}>
              <GitPanel dir={dir} onClose={() => setGitOpen(false)} />
            </div>
          </div>
        )}
        {raceOpen && <RaceCreateModal open={raceOpen} onClose={() => setRaceOpen(false)} onDone={() => { setRaceOpen(false); refresh() }} />}
        {compareRace && <RaceComparePanel race={compareRace} onClose={() => setCompareRace(null)} openTerm={openTerm} onChanged={refresh} />}
      </Suspense>
      {/* 完整表单（W1 弹窗）与 派生（parent 固定）复用同一张表单；收尾走 W7 三选一 */}
      <NewSessionModal open={fullForm || !!forking} parent={forking}
        onClose={() => { setFullForm(false); setForking(null) }}
        onDone={(n) => { openTerm(n); refresh() }} />
      <CloseWorktreeModal info={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); refresh() }} />
    </div>
  )
}
