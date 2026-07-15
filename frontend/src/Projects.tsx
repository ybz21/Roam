// 项目页（08 设计）——「项目 = 目录（git 可选），任务驱动」：
//   #/projects        P1 列表：GET /projects 聚合卡片（发现/退场在后端读时收敛）+ 散会话
//   #/projects/<key>  P2 主页：composer（描述任务 ⏎ 开干）+ 任务流（会话 ∪ 孤儿 worktree）
//                     + Worktree / 编队 / 活动 tab（仅 git 项目开启）
// 项目是后台存储对象（POST/DELETE /projects）；开 session、建 feature 是项目内的动作。
//
// 视觉基调：终端工业风的克制精修——居中 880px 阅读列、composer 是全页唯一 hero
// （渐变卡面 + focus 辉光环）、git 数据一律等宽字、行 hover 左导轨渐显、
// 分区头沿用设计图纸体例、入场一次性 stagger。全部颜色走 index.css token。
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { App as AntApp, AutoComplete, Button, Input, Modal, Popconfirm, Segmented, Select, Space, Spin, Tag, Tooltip, Typography } from 'antd'
import { api } from './api'
import { useI18n } from './i18n'
import { usePreferences } from './preferences'
import { detectPrompt } from './prompt'
import { relTime, taskNameFromPrompt, shq, NewSessionModal, DirPicker, recentDirs, pushRecentDir, CloseWorktreeModal } from './App'

const WorktreePanel = lazy(() => import('./WorktreePanel'))
const GitPanel = lazy(() => import('./GitPanel'))
const RaceCreateModal = lazy(() => import('./Race').then((m) => ({ default: m.RaceCreateModal })))
const RaceComparePanel = lazy(() => import('./Race').then((m) => ({ default: m.RaceComparePanel })))
const NewSwarmModal = lazy(() => import('./Swarm').then((m) => ({ default: m.NewSwarmModal })))

type ProjSession = { name: string; attached: boolean; lastActivity: number; branch?: string; linked?: boolean }
type Proj = {
  key: string; name: string; dir: string; git: boolean; pinned: boolean
  sessions: number; attached: number; worktrees: number; unfinished: number; races: number
  lastActivity: number; firstSeen: number; top: ProjSession[] | null
}

// 项目列表排序模式（置顶恒在最前；选择持久化）
type ProjSort = 'name' | 'created' | 'active'
const SORT_KEY = 'roam.projects.sort'

// ── 页面级样式（一次注入；产品 token 之上只做布局/微交互）──
const PRJ_CSS = `
/* 左对齐不居中：全站页面统一从 tt-page 的 (16,16) 起笔，限宽只管可读性 */
.prj-wrap{max-width:880px;margin:0;padding:0 0 32px}
.prj-wrap-wide{max-width:1180px;margin:0;padding:0 0 32px}
.prj-mono{font-family:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace}
.prj-in{animation:prjIn .38s cubic-bezier(.2,.85,.3,1) backwards}
@keyframes prjIn{from{opacity:0;transform:translateY(6px)}}
@keyframes projLifecPulse{0%,100%{opacity:1}50%{opacity:.35}}

.prj-composer{background:linear-gradient(180deg,var(--bg-elevated),var(--bg-container));
  border:1px solid var(--border);border-radius:14px;
  box-shadow:0 1px 0 rgba(255,255,255,.04) inset,0 8px 28px rgba(1,4,9,.35);
  transition:border-color .2s,box-shadow .2s;padding:4px 4px 10px}
.prj-composer:focus-within{border-color:rgba(88,166,255,.55);
  box-shadow:0 0 0 3px rgba(31,111,235,.16),0 1px 0 rgba(255,255,255,.05) inset,0 8px 28px rgba(1,4,9,.35)}
.prj-composer textarea{font-size:14.5px !important;line-height:1.75 !important;padding:10px 12px 4px !important}
.prj-cbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 10px 0}

.prj-pill{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 11px;border-radius:999px;
  font-size:12px;cursor:pointer;white-space:nowrap;user-select:none;color:var(--text-dim);
  border:1px solid var(--border);background:rgba(177,186,196,.03);
  transition:color .15s,border-color .15s,background .15s}
.prj-pill:hover{color:var(--text-bright);border-color:#8b949e}
.prj-pill.on{color:#79b8ff;border-color:rgba(56,139,253,.55);background:rgba(31,111,235,.14)}
.prj-pill.on.cyan{color:#39c5cf;border-color:rgba(57,197,207,.5);background:rgba(57,197,207,.1)}
.prj-pill.dis{opacity:.4;cursor:not-allowed}

.prj-tabs{display:flex;gap:2px;margin:20px 0 2px;border-bottom:1px solid var(--border-subtle)}
.prj-tab{padding:8px 13px 9px;font-size:13px;color:var(--text-dim);cursor:pointer;user-select:none;
  display:inline-flex;align-items:center;gap:6px;border-bottom:2px solid transparent;margin-bottom:-1px;
  transition:color .15s}
.prj-tab:hover{color:var(--text-bright)}
.prj-tab.on{color:var(--text-bright);border-bottom-color:#58a6ff;font-weight:600}
.prj-tab .n{font-size:10.5px;font-family:ui-monospace,monospace;color:var(--text-dimmer);
  background:rgba(177,186,196,.08);border-radius:999px;padding:1px 6px}

.prj-sect{display:flex;align-items:center;gap:8px;margin:16px 2px 4px;
  font-size:11px;letter-spacing:.08em;color:var(--text-dim);font-weight:700}
.prj-sect .n{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--text-dimmer);font-weight:400}
.prj-sect .ln{flex:1;border-top:1px dashed var(--border-subtle)}
.prj-sect.warn{color:#d29922}

.prj-row{position:relative;display:flex;align-items:flex-start;gap:9px;padding:10px 12px;
  border-radius:10px;cursor:pointer;transition:background .15s}
.prj-row::before{content:'';position:absolute;left:0;top:9px;bottom:9px;width:2px;border-radius:2px;
  background:transparent;transition:background .15s}
.prj-row:hover{background:var(--list-hover)}
.prj-row:hover::before{background:rgba(88,166,255,.5)}
.prj-row .acts{opacity:.55;transition:opacity .15s;display:flex;gap:12px;font-size:12.5px;flex:0 0 auto;margin-top:3px}
.prj-row:hover .acts{opacity:1}
.prj-row.warn{background:rgba(210,153,34,.05);border:1px solid rgba(210,153,34,.18);margin-bottom:4px}
.prj-row.warn:hover{background:rgba(210,153,34,.09)}
.prj-row.warn::before{display:none}

.prj-card{background:var(--bg-container);border:1px solid var(--border-subtle);border-radius:12px;
  padding:13px 14px 11px;cursor:pointer;display:flex;flex-direction:column;gap:8px;
  transition:border-color .18s,transform .18s,box-shadow .18s}
.prj-card:hover{border-color:rgba(88,166,255,.45);transform:translateY(-1px);box-shadow:var(--card-hover-shadow)}
.prj-card .prj-acts{opacity:.25;transition:opacity .15s;display:inline-flex;gap:10px;align-items:center}
.prj-card:hover .prj-acts{opacity:1}
.prj-card .prj-acts .pinned{opacity:1}

.prj-panel{background:var(--bg-container);border:1px solid var(--border-subtle);border-radius:12px;margin-top:8px}
.prj-wtrow{padding:13px 16px}
.prj-wtrow+.prj-wtrow{border-top:1px solid var(--border-subtle)}
.prj-subrow{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;transition:background .14s}
.prj-subrow:hover{background:var(--list-hover)}
.prj-peek{flex:1;min-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:ui-monospace,monospace;font-size:11px;color:var(--text-dimmer);
  background:var(--bg-term);border:1px solid var(--border-subtle);border-radius:6px;padding:3px 8px}
.prj-addline{display:flex;align-items:center;gap:8px;padding:6px 10px;margin-top:2px;
  border:1px dashed var(--border);border-radius:8px;color:var(--text-dim);font-size:12.5px;
  transition:border-color .15s,color .15s}
.prj-addline:hover{border-color:#8b949e;color:var(--text-bright)}

.prj-empty{color:var(--text-dimmer);font-size:12.5px;padding:14px 12px}
`

export const dot = (on: boolean, color?: string) => (
  <span style={{
    width: 8, height: 8, borderRadius: '50%', flex: '0 0 8px', display: 'inline-block',
    background: color || (on ? '#3fb950' : 'var(--text-dimmer)'),
    boxShadow: color || on ? `0 0 0 3px ${color ? 'rgba(210,153,34,.12)' : 'rgba(63,185,80,.12)'}` : undefined,
  }} />
)

// ── 生命周期导轨（P2 图纸）：建→干→审→并，当前段呼吸 ──────
const LIFEC_COLORS = ['#39c5cf', '#3fb950', '#d29922', '#a371f7']
export function Lifec({ done, cur }: { done: number; cur?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      {[1, 2, 3, 4].map((i) => (
        <i key={i} style={{
          width: 11, height: 4, borderRadius: 2,
          background: i <= done || i === cur ? LIFEC_COLORS[i - 1] : 'rgba(139,148,158,.25)',
          animation: i === cur ? 'projLifecPulse 1.6s ease-in-out infinite' : undefined,
        }} />
      ))}
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

  return (
    <>
      <style>{PRJ_CSS}</style>
      {initialKey
        ? <ProjectHome proj={data.projects.find((x) => x.key === initialKey)} loaded={loaded} openTerm={openTerm} refresh={load} />
        : <ProjectList data={data} loaded={loaded} openTerm={openTerm} refresh={load} />}
    </>
  )
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
  const [sortBy, setSortBy] = useState<ProjSort>(() => {
    try { return (localStorage.getItem(SORT_KEY) as ProjSort) || 'name' } catch { return 'name' }
  })
  const changeSort = (v: ProjSort) => { setSortBy(v); try { localStorage.setItem(SORT_KEY, v) } catch {} }
  // 排序：置顶恒在最前；名称(默认,稳定)/创建时间(新在前)/最近活跃(新在前)
  const sorted = useMemo(() => [...data.projects].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (sortBy === 'created') return (b.firstSeen || 0) - (a.firstSeen || 0)
    if (sortBy === 'active') return (b.lastActivity || 0) - (a.lastActivity || 0)
    return a.name.localeCompare(b.name)
  }), [data.projects, sortBy])
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
      <div className="prj-wrap-wide">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 16, fontWeight: 700 }}>{t('project.title')}</span>
          <Segmented size="small" value={sortBy} onChange={(v) => changeSort(v as ProjSort)}
            options={[
              { label: t('project.sort.name'), value: 'name' },
              { label: t('project.sort.created'), value: 'created' },
              { label: t('project.sort.active'), value: 'active' },
            ]} />
          <span style={{ flex: 1 }} />
          <Button type="primary" size="small" onClick={() => setNewOpen(true)}>{t('project.newProject')}</Button>
        </div>

        {loaded && data.projects.length === 0 && (
          <div className="prj-empty" style={{ textAlign: 'center', padding: '48px 0' }}>{t('project.empty')}</div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))', gap: 14 }}>
          {sorted.map((p, i) => (
            <div key={p.key} onClick={() => open(p)} className="prj-card prj-in" style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 14.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                {p.races > 0 && <Tag color="gold" style={{ margin: 0 }}>{t('project.race', { count: p.races })}</Tag>}
                <span style={{ flex: 1 }} />
                <span className="prj-acts">
                  <Tooltip title={p.pinned ? t('project.unpin') : t('project.pin')}>
                    <a className={p.pinned ? 'pinned' : ''} onClick={(e) => { e.stopPropagation(); pin(p) }}
                      style={{ color: p.pinned ? '#d29922' : 'var(--text-dimmer)', fontSize: 13 }}>★</a>
                  </Tooltip>
                  <Popconfirm title={t('project.removeConfirm')} onConfirm={() => remove(p)}
                    onPopupClick={(e) => e.stopPropagation()}>
                    <a onClick={(e) => e.stopPropagation()} style={{ color: 'var(--text-dimmer)', fontSize: 12 }}>✕</a>
                  </Popconfirm>
                </span>
              </div>
              <div className="prj-mono" style={{ fontSize: 11, color: 'var(--text-dimmer)', marginTop: -4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.dir}>{p.dir}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-dim)' }}>
                <span><b style={{ color: 'var(--text-bright)' }}>{p.sessions}</b> {t('project.tasks')}</span>
                {p.git && <>·<span><b style={{ color: 'var(--text-bright)' }}>{p.worktrees}</b> worktree</span></>}
                {p.unfinished > 0 && <Tag color="warning" style={{ margin: 0 }}>{t('project.unfinished', { count: p.unfinished })}</Tag>}
              </div>
              {(p.top?.length || 0) > 0 && (
                <div style={{
                  display: 'flex', flexDirection: 'column', gap: 5, padding: '7px 9px',
                  borderRadius: 8, background: 'var(--bg-term)', border: '1px solid var(--border-subtle)', fontSize: 12.5,
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
            <div className="prj-sect" style={{ marginTop: 22 }}>
              <b>{t('project.loose')}</b><span className="n">{data.loose.length}</span><span className="ln" />
            </div>
            {data.loose.map((s) => (
              <div key={s.name} className="prj-row" onClick={() => openTerm(s.name)}>
                <span style={{ marginTop: 5, display: 'inline-flex' }}>{dot(s.attached)}</span>
                <span style={{ fontWeight: 600 }}>{s.name}</span>
                <span style={{ color: 'var(--text-dimmer)', fontSize: 12, marginTop: 2 }}>{relTime(s.lastActivity, t)}</span>
                <span style={{ flex: 1 }} />
                <span className="acts"><a>{t('project.enter')}</a></span>
              </div>
            ))}
          </>
        )}
        <NewProjectModal open={newOpen} onClose={() => { setNewOpen(false); refresh() }} />
      </div>
    </div>
  )
}

// ── P3 收尾抽屉：孤儿 worktree 的三选一（合并并删除 / 复活 / 丢弃删除）──
// 合并档走 POST /git/worktree/finish（冻结 expectedHead→wip→merge→remove→留痕，
// 08 §5.4）；复活 = 新命令行进入；丢弃 = force remove。损失清单先行。
function FinishModal({ w, base, onClose, onDone, onRevive }: {
  w: any | null; base: string
  onClose: () => void; onDone: () => void; onRevive: (w: any) => void
}) {
  const { t } = useI18n()
  const { message } = AntApp.useApp()
  const [mode, setMode] = useState<'merge' | 'revive' | 'discard'>('merge')
  const [strategy, setStrategy] = useState<'squash' | 'merge' | 'rebase'>('squash')
  const [delBranch, setDelBranch] = useState(true)
  const [diff, setDiff] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!w) return
    setMode('merge'); setStrategy('squash'); setDelBranch(true); setDiff(null)
    api('GET', `/git/worktree/diff?path=${encodeURIComponent(w.path)}`)
      .then((r) => setDiff(r?.data || null)).catch(() => {})
  }, [w])
  if (!w) return null
  const wtBase = w.base || base
  const uncommitted = (diff?.workingTree?.files?.length || 0) + (diff?.untracked ?? w.untracked ?? 0)
  const ok = async () => {
    if (mode === 'revive') { onRevive(w); onClose(); return }
    setBusy(true)
    try {
      if (mode === 'merge') {
        await api('POST', '/git/worktree/finish', { path: w.path, strategy, expectedHead: w.head, deleteBranch: delBranch })
        message.success(t('project.finish.merged', { base: wtBase }))
      } else {
        await api('POST', '/git/worktree/remove', { path: w.path, forceWorktree: true, deleteBranch: delBranch, forceDeleteBranch: delBranch })
        message.success(t('project.finish.discarded'))
      }
      onClose(); onDone()
    } catch (e: any) {
      const ae = e.apiError || {}
      message.error(ae.stage ? t('worktree.close.failedAtStage', { stage: ae.stage, msg: e.message }) : e.message)
    } finally { setBusy(false) }
  }
  const radio = (k: typeof mode, title: any, desc: string, danger?: boolean) => (
    <div onClick={() => setMode(k)} style={{
      display: 'flex', gap: 9, padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
      border: `1px solid ${mode === k ? 'rgba(88,166,255,.6)' : 'var(--border)'}`,
      background: mode === k ? 'rgba(31,111,235,.09)' : 'transparent',
    }}>
      <span style={{
        width: 14, height: 14, borderRadius: '50%', marginTop: 3, flex: '0 0 14px',
        border: `1.5px solid ${mode === k ? '#58a6ff' : 'var(--text-dimmer)'}`,
        background: mode === k ? 'radial-gradient(circle at center, #58a6ff 40%, transparent 45%)' : 'transparent',
      }} />
      <span style={{ minWidth: 0 }}>
        <b style={{ display: 'block', fontSize: 13.5, color: danger ? '#f85149' : undefined }}>{title}</b>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{desc}</span>
      </span>
    </div>
  )
  return (
    <Modal open onCancel={onClose} onOk={ok} okText={t('project.finish.ok')} confirmLoading={busy}
      okButtonProps={mode === 'discard' ? { danger: true } : undefined}
      title={<span>{t('project.finish.title')} <Tag color="cyan" className="prj-mono" style={{ marginLeft: 4 }}>⎇ {w.branch}</Tag></span>} destroyOnClose>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <div className="prj-mono" style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.8, padding: '9px 12px', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-term)' }}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('project.finish.kept', { path: w.path })}</div>
          <div>{t('project.finish.stats', { base: wtBase || '?', ahead: w.committedAhead, dirty: uncommitted })}</div>
        </div>
        {(diff?.committed?.files?.length || 0) > 0 && (
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 5 }}>{t('project.finish.take', { base: wtBase })}</div>
            <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '4px 2px', maxHeight: 160, overflow: 'auto' }}>
              {diff.committed.files.slice(0, 20).map((f: any) => (
                <div key={f.path} className="prj-mono" style={{ display: 'flex', gap: 8, padding: '3px 10px', fontSize: 12 }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path}</span>
                  {f.binary ? <span style={{ color: 'var(--text-dimmer)' }}>bin</span> : (<span style={{ flex: '0 0 auto' }}>
                    <span style={{ color: '#3fb950' }}>+{f.adds}</span> <span style={{ color: '#f85149' }}>-{f.dels}</span>
                  </span>)}
                </div>
              ))}
            </div>
            {uncommitted > 0 && <div style={{ fontSize: 12, color: '#d29922', marginTop: 5 }}>{t('project.finish.uncommitted', { count: uncommitted })}</div>}
          </div>
        )}
        {radio('merge', <>
          {t('project.finish.optMerge', { base: wtBase || '?' })}
          <Select size="small" value={strategy} onChange={(v) => setStrategy(v)} style={{ marginLeft: 8, minWidth: 96 }}
            onClick={(e) => e.stopPropagation()}
            options={[{ value: 'squash', label: 'squash' }, { value: 'merge', label: 'merge' }, { value: 'rebase', label: 'rebase' }]} />
        </>, t('project.finish.optMergeDesc'))}
        {radio('revive', t('project.finish.optRevive'), t('project.finish.optReviveDesc'))}
        {radio('discard', t('project.finish.optDiscard'), t('project.finish.optDiscardDesc', { ahead: w.committedAhead }), true)}
        {mode !== 'revive' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-dim)' }}>
            <input type="checkbox" checked={delBranch} onChange={(e) => setDelBranch(e.target.checked)} style={{ accentColor: '#1f6feb' }} />
            {t('project.finish.delBranch', { branch: w.branch })}
          </label>
        )}
      </Space>
    </Modal>
  )
}

// 终端捕获 → 尾行预览：去 ANSI/OSC，取最后一行非空输出
function tailLine(raw: string): string {
  const clean = String(raw || '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean)
  return (lines[lines.length - 1] || '').slice(0, 90)
}

// ── P2 项目主页：头部 + composer(hero) + 任务流/Worktree/编队/活动 ──
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
  const [swarms, setSwarms] = useState<any[]>([])
  const [swarmOpen, setSwarmOpen] = useState(false)
  const [activity, setActivity] = useState<any[]>([])
  const [finishing, setFinishing] = useState<any>(null)
  const [swarmExtras, setSwarmExtras] = useState<Record<string, { cols: Record<string, number>; last?: any }>>({})
  const [saying, setSaying] = useState<string>('') // 给指挥发话的目标蜂群名
  const [sayText, setSayText] = useState('')
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
  // 编队 tab 才拉的重数据（P5 帧一）：看板列计数 + 广场最后一条（15s）
  useEffect(() => {
    if (tab !== 'race' || !swarms.length) return
    let stop = false
    const loadExtras = () => swarms.forEach(async (sw: any) => {
      try {
        const [board, feed] = await Promise.all([
          api('GET', `/swarms/${encodeURIComponent(sw.name)}/board`).catch(() => []),
          api('GET', `/swarms/${encodeURIComponent(sw.name)}/feed?n=1`).catch(() => []),
        ])
        if (stop) return
        const cols: Record<string, number> = {}
        for (const c of (Array.isArray(board) ? board : [])) cols[c.col] = (cols[c.col] || 0) + 1
        const posts = Array.isArray(feed) ? feed : []
        setSwarmExtras((m) => ({ ...m, [sw.name]: { cols, last: posts[posts.length - 1] } }))
      } catch {}
    })
    loadExtras()
    const i = setInterval(loadExtras, 15000)
    return () => { stop = true; clearInterval(i) }
  }, [tab, swarms])

  // 活动流（懒加载：切到活动 tab 才拉，60s 后端缓存）
  useEffect(() => {
    if (tab !== 'act' || !proj) return
    let stop = false
    // 活动流 = git log(commits) ∪ 收尾留痕(traces)，按时间合并倒序（08 §2.2）
    const loadAct = () => api('GET', `/projects/${encodeURIComponent(proj.key)}/activity`)
      .then((r) => {
        if (stop) return
        const commits = (r?.data?.commits || []).map((x: any) => ({ ...x, kind: 'commit' }))
        const traces = (r?.data?.traces || []).map((x: any) => ({ ...x, kind: 'trace' }))
        setActivity([...commits, ...traces].sort((a, b) => (b.at || 0) - (a.at || 0)))
      }).catch(() => {})
    loadAct()
    const i = setInterval(loadAct, 30000)
    return () => { stop = true; clearInterval(i) }
  }, [tab, proj?.key])

  const mine = useMemo(() => {
    if (!dir) return []
    if (isGit) return sessions.filter((s) => ann[s.name]?.primary?.repo === dir)
    return sessions.filter((s) => (proj?.top || []).some((x) => x.name === s.name))
  }, [sessions, ann, dir, isGit, proj])
  // 蜂群归属（08 §2.2）：swarm ls 无 dir 字段——按「指挥/成员会话 ∈ 本项目会话」现算
  const mineKey = useMemo(() => mine.map((s) => s.name).sort().join('\n'), [mine])
  useEffect(() => {
    if (!isGit) return
    let stop = false
    const loadSwarms = async () => {
      try {
        const list = await api('GET', '/swarms')
        const names = new Set(mineKey.split('\n').filter(Boolean))
        const active = (Array.isArray(list) ? list : []).filter((s: any) => s.status !== 'archived')
        const out: any[] = []
        await Promise.all(active.map(async (sw: any) => {
          try {
            const st = await api('GET', `/swarms/${encodeURIComponent(sw.name)}`)
            const members = (st?.members || []) as any[]
            const inProj = members.filter((m: any) => names.has(m.session)).length + (st?.supervisor && names.has(st.supervisor) ? 1 : 0)
            if (inProj > 0) out.push({ ...sw, inProj, roster: members.length + (st?.supervisor ? 1 : 0), supervisor: st?.supervisor || '', members })
          } catch {}
        }))
        if (!stop) setSwarms(out.sort((a, b) => String(a.name).localeCompare(String(b.name))))
      } catch {}
    }
    loadSwarms()
    const i = setInterval(loadSwarms, 10000)
    return () => { stop = true; clearInterval(i) }
  }, [isGit, mineKey])
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

  // session → 蜂群成员映射（任务流 ⬡ 分组 + 成员标签的数据源）
  const swarmMap = useMemo(() => {
    const m: Record<string, { swarm: string; role: string; subrole?: string; done?: boolean }> = {}
    for (const sw of swarms) {
      if (sw.supervisor) m[sw.supervisor] = { swarm: sw.name, role: 'leader' }
      for (const mem of (sw.members || [])) {
        if (mem.session) m[mem.session] = { swarm: sw.name, role: mem.role === 'leader' || mem.role === 'master' ? 'leader' : 'member', subrole: mem.subrole, done: !!mem.done }
      }
    }
    return m
  }, [swarms])

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
  // 纯命令行：项目目录里开一个裸 shell 会话（同名已存在则直接进入，不重复建）
  const newShell = async () => {
    if (!proj) return
    const name = proj.name + '-sh'
    if (sessions.some((s) => s.name === name)) { openTerm(name); return }
    try {
      const res = await api('POST', '/sessions', { name, dir })
      message.success(t('session.created')); openTerm(res.name || name); refresh()
    } catch (e: any) { message.error(e.message) }
  }
  // 重命名 = 改 displayName 偏好（空值回退目录名，key/目录不变）
  const rename = async (v: string) => {
    if (!proj || v.trim() === proj.name) return
    try {
      await api('PATCH', `/projects/${encodeURIComponent(proj.key)}/prefs`, { displayName: v.trim() })
      message.success(t('project.renamed')); refresh()
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
    <div className={`prj-sect${warn ? ' warn' : ''}`}>
      <b>{label}</b><span className="n">{count}</span><span className="ln" />
    </div>
  )

  // 任务行：生命周期导轨 = 建(必亮)→干(agent 跑)→审(待输入/有未合并)→并(merged)
  // 状态点语义（设计 W2）：绿 = agent 正在干活，黄 = 待输入，其余一律灰。
  const row = (s: any, i: number) => {
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
      <div key={s.name} className="prj-row prj-in" style={{ marginLeft: isChild ? 22 : 0, animationDelay: `${Math.min(i, 8) * 40}ms` }}
        onClick={() => openTerm(s.name)}>
        <span style={{ marginTop: 7, display: 'inline-flex' }}>{dot(false, waiting ? '#d29922' : running ? '#3fb950' : undefined)}</span>
        {isChild && <span style={{ color: '#a371f7', fontSize: 12, marginTop: 3 }}>⑂</span>}
        <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700 }}>{s.name}</span>
            {hit.linked && hit.branch && <Tag color="cyan" className="prj-mono" style={{ margin: 0, fontSize: 11 }}>⎇ {hit.branch}</Tag>}
            {hit.external && hit.linked && <Tag style={{ margin: 0 }}>⧉</Tag>}
            {swarmMap[s.name]?.role === 'leader' && <Tag color="purple" style={{ margin: 0 }}>{t('project.swarm.leaderTag')}</Tag>}
            {swarmMap[s.name]?.subrole && <Tag style={{ margin: 0 }}>{t(('swarm.subrole.' + swarmMap[s.name]!.subrole) as any) || swarmMap[s.name]!.subrole}</Tag>}
            {swarmMap[s.name]?.done && <Tag color="purple" style={{ margin: 0 }}>{t('project.swarm.integrate')}</Tag>}
            {cc[s.name] && <Tag color="blue" style={{ margin: 0 }}>Claude</Tag>}
            {cx[s.name] && <Tag color="green" style={{ margin: 0 }}>Codex</Tag>}
            {waiting && <Tag color="warning" style={{ margin: 0 }}>{t('session.waiting')}</Tag>}
            {a.ambiguous && (
              <Tooltip title={(a.matches || []).map((m: any) => m.worktree).join('\n')}>
                <span style={{ color: '#d29922' }}>⚠</span>
              </Tooltip>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-dimmer)' }}>
            <Lifec done={done} cur={cur} /><span>{stage}</span>
            {(ahead > 0 || changes > 0) && (
              <span className="prj-mono" style={{ fontSize: 11.5 }}>
                {ahead > 0 && <span style={{ color: '#58a6ff' }}>↑{ahead}</span>}
                {ahead > 0 && changes > 0 && ' · '}
                {changes > 0 && <span style={{ color: '#d29922' }}>{t('project.wt.changes', { count: changes })}</span>}
              </span>
            )}
            <span>{relTime(s.last_activity, t)}</span>
          </div>
        </div>
        <span className="acts" onClick={(e) => e.stopPropagation()}>
          <a onClick={() => openTerm(s.name)}>{t('project.enter')}</a>
          {hit.linked && <a onClick={() => setGitOpen(true)}>{t('project.compare')}</a>}
          <a onClick={() => setForking(s.name)}>{t('project.forkTask')}</a>
          <a style={{ color: '#f85149' }} onClick={() => beginClose(s.name)}>{hit.linked ? t('project.finish') : t('common.close')}</a>
        </span>
      </div>
    )
  }

  const tabBtn = (k: typeof tab, label: string, n?: number) => (
    <span key={k} className={`prj-tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>
      {label}{n !== undefined && <span className="n">{n}</span>}
    </span>
  )

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <div className="prj-wrap">
        {/* 项目头：面包屑 | 名称 / 路径 · ⎇主干@HEAD | Git 面板 */}
        <div className="prj-in" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <Button type="text" size="small" onClick={() => { location.hash = '#/projects' }}
            style={{ color: 'var(--text-dim)', paddingInline: 6, flex: '0 0 auto' }}>‹ {t('project.title')}</Button>
          <span style={{ width: 1, height: 18, background: 'var(--border-subtle)', flex: '0 0 auto' }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            {/* 名称可编辑 = 重命名（displayName 偏好，key/目录不变） */}
            <Typography.Text style={{ fontSize: 16, fontWeight: 700, display: 'block', whiteSpace: 'nowrap' }}
              ellipsis editable={{ onChange: rename, tooltip: t('project.rename'), triggerType: ['icon'] }}>
              {proj.name}
            </Typography.Text>
            <div className="prj-mono" style={{ fontSize: 11.5, color: 'var(--text-dimmer)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={proj.dir}>
              {proj.dir}
              {isGit && defBranch && <span style={{ color: '#39c5cf' }}> · ⎇ {defBranch}{mainHead ? ` @ ${mainHead}` : ''}</span>}
            </div>
          </div>
          <Button size="small" onClick={newShell}>{t('project.shell')}</Button>
          {isGit && <Button size="small" onClick={() => setGitOpen(true)}>{t('project.gitPanel')}</Button>}
        </div>

        {/* Composer（hero）：需求 ⏎ 开干 */}
        <div className="prj-composer prj-in" style={{ animationDelay: '60ms' }}>
          <Input.TextArea value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder={isGit ? t('project.composerPlaceholder') : t('project.composerPlain')} autoSize={{ minRows: 2, maxRows: 6 }} variant="borderless"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); goCreate() } }} />
          <div className="prj-cbar">
            {isGit && (<>
              <span className={`prj-pill cyan${wtMode === 'new' ? ' on' : ''}`} onClick={() => setWtMode('new')}>⎇ {t('project.where.new')}</span>
              <span className={`prj-pill${wtMode === 'repo' ? ' on' : ''}`} onClick={() => setWtMode('repo')}>{t('project.where.repo')}</span>
              <span className={`prj-pill${wtMode === 'existing' ? ' on' : ''}${wts.length ? '' : ' dis'}`}
                onClick={() => { if (wts.length) setWtMode('existing') }}>{t('project.where.existing', { count: wts.length })}</span>
              {wtMode === 'existing' && (
                <Select size="small" style={{ minWidth: 160 }} value={wtPath} onChange={setWtPath}
                  options={wts.map((w: any) => ({ value: w.path, label: '⎇ ' + (w.branch || w.path.split('/').pop()) }))} />
              )}
              {wtMode === 'new' && <span className="prj-mono" style={{ fontSize: 11, color: 'var(--text-dimmer)' }}>{defBranch ? t('project.basedOn', { base: defBranch }) : t('project.baseDefault')}</span>}
              <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
            </>)}
            <span className={`prj-pill${agent === 'claude' ? ' on' : ''}`} onClick={() => setAgent('claude')}>Claude</span>
            <span className={`prj-pill${agent === 'codex' ? ' on' : ''}`} onClick={() => setAgent('codex')}>Codex</span>
            <span className={`prj-pill${agent === 'none' ? ' on' : ''}`} onClick={() => setAgent('none')}>{t('project.agent.none')}</span>
            {/* 尾组 marginLeft:auto：换行后整组靠右成独立一行，窄屏不散架 */}
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 11.5, color: 'var(--text-dimmer)', whiteSpace: 'nowrap' }}>{t('project.autoName')} · <a style={{ fontSize: 11.5 }} onClick={() => setFullForm(true)}>{t('project.fullForm')} ›</a></span>
              <Button type="primary" size="small" loading={creating} onClick={goCreate}>{t('project.go')}</Button>
            </span>
          </div>
        </div>

        {/* Tabs：任务 | Worktree | 编队 | 活动（非 git 只有任务） */}
        <div className="prj-tabs prj-in" style={{ animationDelay: '110ms' }}>
          {tabBtn('tasks', t('project.tasks'), mine.length + unfinished.length + clean.length)}
          {isGit && tabBtn('wt', 'Worktree', wts.length)}
          {isGit && tabBtn('race', t('project.tab.race'), races.length + swarms.length)}
          {isGit && tabBtn('act', t('project.tab.activity'))}
        </div>

        {/* ── 任务流 ── */}
        {tab === 'tasks' && (<>
          {sect(t('project.section.active'), mine.length)}
          {/* 分组优先级 蜂群 ⬡ > parent 树 > 平铺（08 §2.2）：成员按编队组头聚合，组头 → 蜂群台 */}
          {(() => {
            const groups = new Map<string, any[]>()
            const rest: any[] = []
            for (const s of mine) {
              const sm = swarmMap[s.name]
              if (sm) {
                if (!groups.has(sm.swarm)) groups.set(sm.swarm, [])
                groups.get(sm.swarm)!.push(s)
              } else rest.push(s)
            }
            return (<>
              {[...groups.entries()].map(([swName, rows]) => {
                const sw = swarms.find((x: any) => x.name === swName)
                return (
                  <div key={'g' + swName}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 6px 2px', fontSize: 12.5, color: 'var(--text-dim)' }}>
                      <span style={{ color: '#a371f7' }}>⬡</span>
                      <b style={{ color: 'var(--text-bright)' }}>{swName}</b>
                      {sw && <span style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>{t('project.swarm.members', { mine: sw.inProj, total: sw.roster })}</span>}
                      <span style={{ flex: 1 }} />
                      <a style={{ fontSize: 12 }} onClick={() => { location.hash = '#/swarm/' + encodeURIComponent(swName) }}>{t('project.swarm.board')}</a>
                    </div>
                    <div style={{ marginLeft: 6, paddingLeft: 10, borderLeft: '2px solid rgba(163,113,247,.3)' }}>
                      {rows.map(row)}
                    </div>
                  </div>
                )
              })}
              {rest.map(row)}
            </>)
          })()}
          {mine.length === 0 && <div className="prj-empty">{t('project.noTasks')}</div>}

          {unfinished.length > 0 && (<>
            {sect(t('project.section.unfinished'), unfinished.length, true)}
            {unfinished.map((w: any) => (
              <div key={w.path} className="prj-row warn">
                <span style={{ marginTop: 7, display: 'inline-flex' }}>{dot(false, '#d29922')}</span>
                <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                    <Tag color="cyan" className="prj-mono" style={{ margin: 0, fontSize: 11 }}>⎇ {w.branch}</Tag>
                    <Tag color="warning" style={{ margin: 0 }}>{t('project.sessionClosed')}</Tag>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-dimmer)', flexWrap: 'wrap' }}>
                    <Lifec done={2} cur={3} /><span>{t('project.stage.unfinished')}</span>
                    <span className="prj-mono" style={{ fontSize: 11.5 }}>{t('project.aheadDirty', { ahead: w.committedAhead, dirty: w.dirty + w.untracked })}</span>
                    <span>{relTime(w.lastCommitAt, t)}</span>
                  </div>
                </div>
                <span className="acts">
                  <a style={{ color: '#d29922' }} onClick={() => setFinishing(w)}>{t('project.finish')}</a>
                  <a onClick={() => newCli(w, 'shell')}>{t('project.revive')}</a>
                  <a onClick={() => setGitOpen(true)}>{t('project.compare')}</a>
                </span>
              </div>
            ))}
          </>)}

          {clean.length > 0 && (<>
            {sect(t('project.section.clean'), clean.length)}
            {clean.map((w: any) => (
              <div key={w.path} className="prj-row">
                <span style={{ marginTop: 7, display: 'inline-flex' }}>{dot(false, '#a371f7')}</span>
                <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                    <Tag color="cyan" className="prj-mono" style={{ margin: 0, fontSize: 11 }}>⎇ {w.branch}</Tag>
                    <Tag color="purple" style={{ margin: 0 }}>⇥ {t('project.mergedClean')}</Tag>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-dimmer)' }}>
                    <Lifec done={4} /><span>{t('project.stage.done')}</span>
                  </div>
                </div>
                <span className="acts">
                  <a onClick={() => newCli(w, 'shell')}>{t('project.revive')}</a>
                  <a onClick={() => setWtOpen(true)}>{t('project.cleanup')}</a>
                </span>
              </div>
            ))}
          </>)}
        </>)}

        {/* ── Worktree tab（P4：行可展开 → 命令行 + 尾行预览 + 新开命令行）── */}
        {tab === 'wt' && (
          <div className="prj-panel prj-in">
            {wts.length === 0 && <div className="prj-empty">{t('project.noTasks')}</div>}
            {wts.map((w: any) => {
              const open = !!expanded[w.path]
              const live = (w.sessions || []).length
              return (
                <div key={w.path} className="prj-wtrow">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
                    onClick={() => setExpanded((m) => ({ ...m, [w.path]: !open }))}>
                    <span style={{ fontSize: 10, color: 'var(--text-dimmer)', width: 12, display: 'inline-block', transform: open ? 'rotate(90deg)' : undefined, transition: 'transform .15s' }}>▸</span>
                    <span className="prj-mono" style={{ fontSize: 13.5, fontWeight: 600, color: '#39c5cf' }}>⎇ {w.branch}</span>
                    {w.external
                      ? <Tag style={{ margin: 0 }}>{t('project.wt.externalTag')}</Tag>
                      : live > 0
                        ? <Tag style={{ margin: 0 }}>{t('project.wt.cli', { count: live })}</Tag>
                        : <Tag color="warning" style={{ margin: 0 }}>{t('project.wt.orphanTag')}</Tag>}
                  </div>
                  <div className="prj-mono" style={{ marginLeft: 20, marginTop: 5, fontSize: 11.5, color: 'var(--text-dimmer)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <span>{t('project.basedOn', { base: w.base || '?' })}</span>·
                    <span style={{ color: w.committedAhead > 0 ? '#58a6ff' : undefined }}>↑{w.committedAhead}</span>·
                    <span style={{ color: (w.dirty + w.untracked) > 0 ? '#d29922' : undefined }}>{t('project.wt.changes', { count: w.dirty + w.untracked })}</span>·
                    <span>{relTime(w.lastCommitAt, t)}</span>
                  </div>
                  {open && (
                    <div style={{ margin: '8px 0 2px 5px', paddingLeft: 12, borderLeft: '2px solid rgba(57,197,207,.25)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {(w.sessions || []).map((ref: any) => (
                        <div key={ref.session} className="prj-subrow" onClick={() => openTerm(ref.session)}>
                          {dot(false, cc[ref.session] || cx[ref.session] ? '#3fb950' : undefined)}
                          <span style={{ fontWeight: 600, fontSize: 13 }}>{ref.session}</span>
                          {cc[ref.session] && <Tag color="blue" style={{ margin: 0, fontSize: 10.5, lineHeight: '16px' }}>Claude</Tag>}
                          {cx[ref.session] && <Tag color="green" style={{ margin: 0, fontSize: 10.5, lineHeight: '16px' }}>Codex</Tag>}
                          <span className="prj-peek">{peeks[ref.session] || '…'}</span>
                          <a style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); openTerm(ref.session) }}>{t('project.enter')}</a>
                        </div>
                      ))}
                      {live === 0 && <div style={{ fontSize: 12, color: 'var(--text-dimmer)', padding: '4px 8px' }}>{t('project.wt.noCli')}</div>}
                      <div className="prj-addline">
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
            {/* 管理入口收进本 tab：新建/清理残留/跨仓库总览都在抽屉里 */}
            <div style={{ padding: '10px 16px', borderTop: wts.length ? '1px solid var(--border-subtle)' : undefined }}>
              <a style={{ fontSize: 12.5 }} onClick={() => setWtOpen(true)}>{t('project.wtManage')} ›</a>
            </div>
          </div>
        )}

        {/* ── 编队 tab：竞赛 + 蜂群（只列组，编排去对比台/蜂群页）── */}
        {tab === 'race' && (<>
          {races.map((r: any) => (
            <div key={r.id} className="prj-panel prj-in" style={{ padding: '13px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Tag color="gold" style={{ margin: 0 }}>RACE</Tag>
                <b>{r.name}</b>
                <span style={{ fontSize: 12, color: 'var(--text-dimmer)' }}>{t('project.race.meta', { count: (r.contestants || []).length, base: r.base })}</span>
                <span style={{ flex: 1 }} />
                <Button size="small" type="primary" onClick={() => setCompareRace(r)}>{t('project.race.compare')} →</Button>
              </div>
            </div>
          ))}
          {/* 蜂群卡（P5 帧一）：成员/看板计数/广场尾声只读投影 + 给指挥发话；编排一律去蜂群台 */}
          {swarms.map((sw: any) => {
            const ex = swarmExtras[sw.name]
            const mineNames = new Set(mine.map((x) => x.name))
            const memberRow = (session: string, role: string, subrole?: string, done?: boolean, status?: string) => {
              const inProj = mineNames.has(session)
              const running = cc[session] || cx[session] || status === 'running'
              return (
                <div key={session} className="prj-subrow" style={{ opacity: inProj ? 1 : 0.45 }}
                  onClick={() => { if (inProj) openTerm(session) }}>
                  {dot(false, status === 'waiting' ? '#d29922' : running ? '#3fb950' : undefined)}
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{session}</span>
                  {role === 'leader' && <Tag color="purple" style={{ margin: 0, fontSize: 10.5, lineHeight: '16px' }}>{t('project.swarm.leaderTag')}</Tag>}
                  {subrole && <Tag style={{ margin: 0, fontSize: 10.5, lineHeight: '16px' }}>{t(('swarm.subrole.' + subrole) as any) || subrole}</Tag>}
                  {done && <Tag color="purple" style={{ margin: 0, fontSize: 10.5, lineHeight: '16px' }}>{t('project.swarm.integrate')}</Tag>}
                  {ann[session]?.primary?.linked && <Tag color="cyan" className="prj-mono" style={{ margin: 0, fontSize: 10.5, lineHeight: '16px' }}>⎇ {ann[session].primary.branch}</Tag>}
                  <span style={{ flex: 1 }} />
                  {inProj
                    ? <a style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); openTerm(session) }}>{t('project.enter')}</a>
                    : <span style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>{t('project.swarm.crossProj')}</span>}
                </div>
              )
            }
            return (
              <div key={sw.id || sw.name} className="prj-panel prj-in" style={{ padding: '13px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Tag color="purple" style={{ margin: 0 }}>⬡ {t('nav.swarm')}</Tag>
                  <b>{sw.name}</b>
                  {sw.goal && <span style={{ fontSize: 12, color: 'var(--text-dimmer)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 }}>{sw.goal}</span>}
                  {!sw.supervisor && <Tag color="warning" style={{ margin: 0 }}>{t('project.swarm.noLeader')}</Tag>}
                  <span style={{ flex: 1 }} />
                  {ex && Object.keys(ex.cols).length > 0 && (
                    <span className="prj-mono" style={{ fontSize: 11, color: 'var(--text-dimmer)' }}>
                      {['backlog', 'assigned', 'doing', 'review', 'done'].filter((c) => ex.cols[c]).map((c) => `${t(('swarm.board.col.' + c) as any)} ${ex.cols[c]}`).join(' · ')}
                    </span>
                  )}
                  {/* 无指挥修复入口（09 S2）：群在指挥不在（拉起失败/被杀）→ adopt 接管 */}
                  {!sw.supervisor && (
                    <Button size="small" onClick={async () => {
                      try {
                        await api('POST', `/swarms/${encodeURIComponent(sw.name)}/adopt`, { dir, worktree: true })
                        message.success(t('project.swarm.adopted')); openTerm('cc-' + sw.name)
                      } catch (e: any) { message.error(e.message) }
                    }}>{t('project.swarm.adopt')}</Button>
                  )}
                  <Button size="small" onClick={() => { setSaying(sw.name); setSayText('') }}>{t('project.swarm.sayLeader')}</Button>
                  <Button size="small" type="primary" onClick={() => { location.hash = '#/swarm/' + encodeURIComponent(sw.name) }}>{t('project.swarm.board')} →</Button>
                </div>
                <div style={{ margin: '9px 0 0 5px', paddingLeft: 12, borderLeft: '2px solid rgba(163,113,247,.3)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {sw.supervisor && memberRow(sw.supervisor, 'leader')}
                  {(sw.members || []).filter((m: any) => m.session && m.session !== sw.supervisor)
                    .map((m: any) => memberRow(m.session, m.role, m.subrole, !!m.done, m.status))}
                </div>
                {ex?.last && (
                  <div className="prj-mono" style={{ display: 'flex', gap: 8, marginTop: 9, padding: '6px 10px', borderRadius: 8, background: 'var(--bg-term)', border: '1px solid var(--border-subtle)', fontSize: 11.5, color: 'var(--text-dim)' }}>
                    <span style={{ color: '#c4a5f9', flex: '0 0 auto' }}>{ex.last.author}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ex.last.text}</span>
                  </div>
                )}
              </div>
            )
          })}
          {races.length === 0 && swarms.length === 0 && <div className="prj-empty">{t('project.formation.empty')}</div>}
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <Button size="small" onClick={() => setRaceOpen(true)}>{t('project.newRace')}</Button>
            <Button size="small" onClick={() => setSwarmOpen(true)}>{t('project.newSwarm')}</Button>
          </div>
        </>)}

        {/* ── 活动 tab：全部分支近 30 天提交 ── */}
        {tab === 'act' && (
          <div className="prj-panel prj-in" style={{ padding: '6px 4px' }}>
            {activity.map((e: any) => e.kind === 'trace' ? (
              <div key={'t' + e.at + e.branch} className="prj-mono" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 12.5 }}>
                <span style={{ color: '#a371f7' }}>⇥</span>
                <span style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {e.action === 'merged'
                    ? t('project.act.traceMerged', { branch: e.branch, base: e.base || '?', strategy: e.strategy || 'squash' })
                    : t('project.act.traceDiscarded', { branch: e.branch })}
                </span>
                <span style={{ marginLeft: 'auto', color: 'var(--text-dimmer)', fontSize: 11.5, flex: '0 0 auto' }}>{relTime(e.at, t)}</span>
              </div>
            ) : (
              <div key={e.oid + e.at} className="prj-mono" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 12.5 }}>
                <span style={{ color: '#39c5cf', opacity: 0.8 }}>{e.oid}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.subject}</span>
                <span style={{ marginLeft: 'auto', color: 'var(--text-dimmer)', fontSize: 11.5, flex: '0 0 auto' }}>
                  {e.refs ? `${String(e.refs).split(',')[0]} · ` : ''}{relTime(e.at, t)}
                </span>
              </div>
            ))}
            {activity.length === 0 && <div className="prj-empty">{t('project.act.empty')}</div>}
            <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)', padding: '8px 12px', borderTop: '1px dashed var(--border-subtle)' }}>{t('project.act.hint')}</div>
          </div>
        )}

        <Suspense fallback={<Spin />}>
          {wtOpen && <WorktreePanel open={wtOpen} onClose={() => { setWtOpen(false); refresh() }} openTerm={openTerm} initialDir={dir} />}
          {gitOpen && (
            <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(1,4,9,.6)' }} onClick={() => setGitOpen(false)}>
              <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 'min(520px, 94vw)', background: 'var(--bg-container)', borderLeft: '1px solid var(--border)' }}
                onClick={(e) => e.stopPropagation()}>
                <GitPanel dir={dir} onClose={() => setGitOpen(false)} />
              </div>
            </div>
          )}
          {raceOpen && <RaceCreateModal open={raceOpen} onClose={() => setRaceOpen(false)} onDone={() => { setRaceOpen(false); refresh() }} />}
          {swarmOpen && (
            <NewSwarmModal open={swarmOpen} initialDir={dir} lockDir
              onClose={() => setSwarmOpen(false)}
              onDone={(n) => { setSwarmOpen(false); refresh(); if (n) openTerm('cc-' + n) }} />
          )}
          {compareRace && <RaceComparePanel race={compareRace} onClose={() => setCompareRace(null)} openTerm={openTerm} onChanged={refresh} />}
        </Suspense>
        {/* 完整表单（W1 弹窗）与 派生（parent 固定）复用同一张表单；收尾走 W7 三选一 */}
        <NewSessionModal open={fullForm || !!forking} parent={forking}
          onClose={() => { setFullForm(false); setForking(null) }}
          onDone={(n) => { openTerm(n); refresh() }} />
        <CloseWorktreeModal info={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); refresh() }} />
        <FinishModal w={finishing} base={defBranch} onClose={() => setFinishing(null)}
          onDone={() => { setFinishing(null); refresh() }} onRevive={(w) => newCli(w, 'shell')} />
        {/* 给指挥发话 = 广场署名 human 发言（08 §3），编排动作仍去蜂群台 */}
        <Modal open={!!saying} onCancel={() => setSaying('')} title={t('project.swarm.sayTitle', { name: saying })}
          okText={t('project.swarm.saySend')} destroyOnClose
          onOk={async () => {
            if (!sayText.trim()) return
            try {
              await api('POST', `/swarms/${encodeURIComponent(saying)}/say`, { text: '@leader ' + sayText.trim(), kind: 'ask' })
              message.success(t('project.swarm.saySent')); setSaying('')
            } catch (e: any) { message.error(e.message) }
          }}>
          <Input.TextArea autoFocus rows={3} value={sayText} onChange={(e) => setSayText(e.target.value)}
            placeholder={t('project.swarm.sayPlaceholder')} />
        </Modal>
      </div>
    </div>
  )
}
