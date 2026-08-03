// 项目页（08 设计）——「项目 = 目录（git 可选），任务驱动」：
//   #/projects        P1 列表：GET /projects 聚合卡片（发现/退场在后端读时收敛）+ 散会话
//   #/projects/<key>  P2 主页：composer（描述任务 ⏎ 开干）+ 任务流（会话 ∪ 孤儿 worktree）
//                     + Worktree / 编队 / 活动 tab（仅 git 项目开启）
// 项目是后台存储对象（POST/DELETE /projects）；开 session、建 feature 是项目内的动作。
//
// 视觉基调：终端工业风的克制精修——居中 880px 阅读列、composer 是全页唯一 hero
// （渐变卡面 + focus 辉光环）、git 数据一律等宽字、行 hover 左导轨渐显、
// 分区头沿用设计图纸体例、入场一次性 stagger。全部颜色走 index.css token。
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { App as AntApp, AutoComplete, Button, Dropdown, Input, Modal, Popconfirm, Segmented, Select, Space, Spin, Tag, Tooltip, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { sessionLabel } from './session-label'
import { api, upload, makeClipboardImageFile } from './api'
import { useI18n } from './i18n'
import { usePreferences } from './preferences'
import { INTENT_EVENT, takeIntent } from './intents'
import { detectPrompt } from './prompt'
import { relTime, taskNameFromPrompt, shq, NewSessionModal, DirPicker, recentDirs, pushRecentDir, CloseWorktreeModal } from './App'
import FileBrowser from './FileBrowser'

const WorktreePanel = lazy(() => import('./WorktreePanel'))
const GitPanel = lazy(() => import('./GitPanel'))
const RaceCreateModal = lazy(() => import('./Race').then((m) => ({ default: m.RaceCreateModal })))
const RaceComparePanel = lazy(() => import('./Race').then((m) => ({ default: m.RaceComparePanel })))
const NewSwarmModal = lazy(() => import('./Swarm').then((m) => ({ default: m.NewSwarmModal })))

// name 是会话名(= 会话 id，打开终端的 handle)，label 是展示名(@roam_name)
type ProjSession = { name: string; label?: string; attached: boolean; running?: boolean; waiting?: boolean; lastActivity: number; branch?: string; linked?: boolean }
type Proj = {
  key: string; name: string; dir: string; git: boolean; pinned: boolean
  sessions: number; attached: number; worktrees: number; unfinished: number; cleanable: number; races: number
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

/* 项目头 64 / Tabs 40，两者 sticky（14 §6.2）：往下翻任务流时「我在哪个项目、
   要新建什么、在看哪个 tab」始终在手边 */
.prj-head{position:sticky;top:0;z-index:calc(var(--z-sticky) + 1);min-height:64px;
  background:var(--bg-base);border-bottom:1px solid var(--border-subtle);margin-bottom:12px}
.prj-tabs{position:sticky;top:64px;z-index:var(--z-sticky);
  display:flex;gap:2px;margin:20px 0 2px;min-height:40px;
  background:var(--bg-base);border-bottom:1px solid var(--border-subtle)}
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
.prj-sect.ok{color:#3fb950}

.prj-row{position:relative;display:flex;align-items:flex-start;gap:9px;padding:10px 12px;
  border-radius:10px;cursor:pointer;transition:background .15s}
.prj-row::before{content:'';position:absolute;left:0;top:9px;bottom:9px;width:2px;border-radius:2px;
  background:transparent;transition:background .15s}
.prj-row:hover{background:var(--list-hover)}
.prj-row:hover::before{background:rgba(88,166,255,.5)}
/* 选中行：细蓝边 + 淡底，和 hover 区分得开（14 §6.3.1） */
.prj-row.on{background:var(--accent-soft);box-shadow:inset 0 0 0 1px var(--accent-border)}
.prj-row.on::before{background:var(--accent)}
.prj-row .acts{opacity:.55;transition:opacity .15s;display:flex;gap:12px;font-size:12.5px;flex:0 0 auto;margin-top:3px}
.prj-row:hover .acts{opacity:1}
.prj-row.warn{background:rgba(210,153,34,.05);border:1px solid rgba(210,153,34,.18);margin-bottom:4px}
.prj-row.warn:hover{background:rgba(210,153,34,.09)}
.prj-row.warn::before{display:none}

/* sticky subheader（14 §6.1）：筛选与排序不该跟着列表滚走 */
.prj-subbar{position:sticky;top:0;z-index:var(--z-sticky);display:flex;align-items:center;gap:10px;
  flex-wrap:wrap;margin-bottom:12px;padding:8px 0;background:var(--bg-base)}
.prj-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;
  border:1px solid var(--border);background:transparent;color:var(--text-dim);font-size:12px;
  cursor:pointer;white-space:nowrap;transition:color .15s,border-color .15s,background .15s}
.prj-chip:hover{color:var(--text-bright);border-color:#8b949e}
.prj-chip.on{color:var(--accent);border-color:var(--accent-border);background:var(--accent-soft)}
.prj-chip .n{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--text-dimmer)}
.prj-chip.on .n{color:#79b8ff}

/* 卡片列固定在 ≥320：原来是 minmax(270,1fr)，右侧一开终端就塌成一条极窄列表（14 §6.1） */
.prj-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}

.prj-card{background:var(--bg-container);border:1px solid var(--border-subtle);border-radius:12px;
  padding:13px 14px 11px;cursor:pointer;display:flex;flex-direction:column;gap:8px;
  transition:border-color .18s,transform .18s,box-shadow .18s}
.prj-card:hover{border-color:rgba(88,166,255,.45);transform:translateY(-1px);box-shadow:var(--card-hover-shadow)}
.prj-card:focus-visible{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.prj-card .prj-acts{opacity:.25;transition:opacity .15s;display:inline-flex;gap:10px;align-items:center}
/* 次要操作 hover 才出现，但键盘走到时同样要看得见——否则纯键盘用户够不着（14 §6.1） */
.prj-card:focus-within .prj-acts,.prj-card:focus-visible .prj-acts{opacity:1}
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

/* 分叉图：主干是整行高的绝对定位线（行高随内容变，画进 svg 必断），
   svg 只画「从主干拐出来的一小段 + 节点」，钉在行顶 22px 处。 */
.prj-fork{position:relative;display:flex;padding:0 14px 0 40px}
.prj-fork::before{content:'';position:absolute;left:15px;top:0;bottom:0;width:1.6px;background:hsl(212,78%,58%)}
.prj-fork.head::before{top:22px}
.prj-fork:last-child::before{bottom:auto;height:24px}
.prj-fork+.prj-fork .col{border-top:1px solid var(--border-subtle)}
.prj-fork .fk{position:absolute;left:0;top:4px;overflow:visible}
.prj-fork .col{flex:1;min-width:0;padding:11px 0 12px;display:flex;gap:12px;align-items:flex-start}
.prj-fork .info{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}
.prj-fork .n1{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.prj-fork .n2{font-size:12px;color:var(--text-dimmer)}
.prj-fork .wt-br{font-family:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace;
  font-size:13.5px;font-weight:600;color:#39c5cf}
.prj-fork .wt-br::before{content:'⎇ ';opacity:.7}
.prj-fork .wt-ab{font-family:ui-monospace,monospace;font-size:12px}
.prj-fork .wt-ab.up{color:#3fb950} .prj-fork .wt-ab.dn{color:#d29922}
.prj-fork .wt-acts{flex:0 0 auto;display:flex;gap:6px;align-items:center;opacity:.55;transition:opacity .15s}
.prj-fork:hover .wt-acts,.prj-fork .wt-acts:focus-within{opacity:1}
.prj-fork.merged .col,.prj-fork.ext .col{opacity:.75}
`

// 分叉图（11 §8.2）：主干蓝取提交树 lane 0 同色，支线按状态着色——
// 绿=有会话在跑 / 琥珀=孤儿待收尾 / 灰虚线=已合入待清理 / 灰菱形=外部。
const FORK_TRUNK = 'hsl(212, 78%, 58%)'
const FORK_COLOR: Record<string, string> = {
  live: '#3fb950', orphan: '#d29922', merged: 'rgba(139,148,158,.55)', ext: 'rgba(139,148,158,.7)',
}
const CLI_KINDS = ['shell', 'claude', 'codex'] as const

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

export default function Projects({ openTerm, closeTerm, initialKey, activeTerm }: { openTerm: (n: string) => void; closeTerm: (n: string) => void; initialKey?: string; activeTerm?: string | null }) {
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
        ? <ProjectHome proj={data.projects.find((x) => x.key === initialKey)} allProjects={data.projects} loaded={loaded} openTerm={openTerm} closeTerm={closeTerm} refresh={load} activeTerm={activeTerm} />
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
  // 新建项目的按钮只有顶栏那一枚（Command Center，14 §4.5）：它切到本页并留下一个
  // 意图，这里挂载时取走。挂载时也要取一次——从别的页面点过来时，事件早在本组件
  // 存在之前就发完了（见 intents.ts）。
  useEffect(() => {
    const on = () => { if (takeIntent('new-project')) setNewOpen(true) }
    on()
    window.addEventListener(INTENT_EVENT, on)
    return () => window.removeEventListener(INTENT_EVENT, on)
  }, [])
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

  // 搜索 + 筛选（14 §6.1）：项目一多，「哪些还欠着事」比「一共有几个」有用得多
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'active' | 'unfinished'>('all')
  const counts = useMemo(() => ({
    all: data.projects.length,
    active: data.projects.filter((p) => p.sessions > 0).length,
    unfinished: data.projects.filter((p) => p.unfinished > 0).length,
  }), [data.projects])
  const visible = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return sorted.filter((p) => {
      if (filter === 'active' && p.sessions <= 0) return false
      if (filter === 'unfinished' && p.unfinished <= 0) return false
      if (!kw) return true
      return p.name.toLowerCase().includes(kw) || p.dir.toLowerCase().includes(kw)
    })
  }, [sorted, q, filter])
  // 置顶与活跃共用同一套栅格，只靠 section header 分组（14 §6.1）——两套栅格会让
  // 卡片宽度在分组之间对不齐
  const pinned = visible.filter((p) => p.pinned)
  const rest = visible.filter((p) => !p.pinned)

  // 上下左右移动选中：列数从栅格实际算，不写死——它随 Canvas 宽度变
  const onGridKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    const grid = e.currentTarget
    const cards = [...grid.querySelectorAll<HTMLElement>('[data-prj-card]')]
    const at = cards.indexOf(document.activeElement as HTMLElement)
    if (at < 0) return
    e.preventDefault()
    const cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').length)
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -cols : cols
    cards[Math.max(0, Math.min(cards.length - 1, at + step))]?.focus()
  }

  const card = (p: Proj, i: number) => (
    <div key={p.key} onClick={() => open(p)} className="prj-card prj-in" data-prj-card
      role="button" tabIndex={0} aria-label={p.name}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); open(p) } }}
      style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}>
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
                {p.cleanable > 0 && <Tag color="success" style={{ margin: 0 }}>{t('project.cleanableCount', { count: p.cleanable })}</Tag>}
              </div>
              {(p.top?.length || 0) > 0 && (
                <div style={{
                  display: 'flex', flexDirection: 'column', gap: 5, padding: '7px 9px',
                  borderRadius: 8, background: 'var(--bg-term)', border: '1px solid var(--border-subtle)', fontSize: 12.5,
                }}>
                  {p.top!.map((s) => (
                    <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                      {dot(false, s.waiting ? '#d29922' : s.running ? '#3fb950' : undefined)}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.name}>{s.label || sessionLabel(s.name)}</span>
                      {s.branch && <Tag color="cyan" style={{ margin: 0, fontSize: 10.5, lineHeight: '16px', padding: '0 5px' }}>⎇</Tag>}
                      <span style={{ marginLeft: 'auto', color: 'var(--text-dimmer)', fontSize: 11.5, flex: '0 0 auto' }}>{relTime(s.lastActivity, t)}</span>
                    </div>
                  ))}
                </div>
              )}
    </div>
  )

  return (
    // 这里**不能**加 overflow:auto——任何非 visible 的祖先都会成为 sticky 的
    // 参照系，而这一层并不真的滚动（真正滚的是 .tt-canvas），于是页头永远粘不住。
    <div>
      <div className="prj-wrap-wide">
        {/* 页头与概览共用一套（.tt-pagehead）：眉标 + 标题 + 一句话。原来这里只有一个
            16px 的「项目」挤在搜索框左边，和概览那页完全不像同一个产品。 */}
        <header className="tt-pagehead" style={{ marginBottom: 14 }}>
          <div className="ttl">
            <div className="kicker">{t('nav.groupWorkspace')}</div>
            <h2>{t('project.title')}</h2>
            <p>{t('project.subtitle')}</p>
          </div>
        </header>

        {/* sticky subheader（14 §6.1）：搜索 / 筛选 / 排序。滚到项目列表深处时这一条还在——
            筛选条件跟着内容滚走，等于要滚回顶部才能改。 */}
        <div className="prj-subbar">
          <Input allowClear size="small" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={t('project.searchPlaceholder')} style={{ width: 200 }} />
          {([
            ['all', t('project.filterAll'), counts.all],
            ['active', t('project.filterActive'), counts.active],
            ['unfinished', t('project.section.unfinished'), counts.unfinished],
          ] as const).map(([k, label, n]) => (
            <button key={k} type="button" className={`prj-chip${filter === k ? ' on' : ''}`}
              onClick={() => setFilter(k)}>{label}<span className="n">{n}</span></button>
          ))}
          <span style={{ flex: 1 }} />
          <Segmented size="small" value={sortBy} onChange={(v) => changeSort(v as ProjSort)}
            options={[
              { label: t('project.sort.name'), value: 'name' },
              { label: t('project.sort.created'), value: 'created' },
              { label: t('project.sort.active'), value: 'active' },
            ]} />
        </div>

        {loaded && data.projects.length === 0 && (
          <div className="prj-empty" style={{ textAlign: 'center', padding: '48px 0' }}>{t('project.empty')}</div>
        )}
        {loaded && data.projects.length > 0 && visible.length === 0 && (
          <div className="prj-empty" style={{ textAlign: 'center', padding: '48px 0' }}>{t('project.noMatch')}</div>
        )}

        {pinned.length > 0 && (
          <div className="prj-sect"><b>{t('project.pinnedSection')}</b><span className="n">{pinned.length}</span><span className="ln" /></div>
        )}
        {pinned.length > 0 && <div className="prj-grid" onKeyDown={onGridKey}>{pinned.map(card)}</div>}
        {pinned.length > 0 && rest.length > 0 && (
          <div className="prj-sect"><b>{t('overview.activeProjects')}</b><span className="n">{rest.length}</span><span className="ln" /></div>
        )}
        {rest.length > 0 && <div className="prj-grid" onKeyDown={onGridKey}>{rest.map(card)}</div>}

        {data.loose.length > 0 && (
          <>
            <div className="prj-sect" style={{ marginTop: 22 }}>
              <b>{t('project.loose')}</b><span className="n">{data.loose.length}</span><span className="ln" />
            </div>
            {data.loose.map((s) => (
              <div key={s.name} className="prj-row" onClick={() => openTerm(s.name)}>
                <span style={{ marginTop: 5, display: 'inline-flex' }}>{dot(false, s.waiting ? '#d29922' : s.running ? '#3fb950' : undefined)}</span>
                <span style={{ fontWeight: 600 }} title={s.name}>{s.label || sessionLabel(s.name)}</span>
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
    // 已合入（10 §5）：丢弃升为推荐首选——零损失，只是删掉本地载体
    setMode(w.mergedInto ? 'discard' : 'merge'); setStrategy('squash'); setDelBranch(true); setDiff(null)
    api('GET', `/git/worktree/diff?path=${encodeURIComponent(w.path)}`)
      .then((r) => setDiff(r?.data || null)).catch(() => {})
  }, [w])
  if (!w) return null
  const merged = !!w.mergedInto
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
      okButtonProps={mode === 'discard' && !merged ? { danger: true } : undefined}
      title={<span>{t('project.finish.title')} <Tag color="cyan" className="prj-mono" style={{ marginLeft: 4 }}>⎇ {w.branch}</Tag></span>} destroyOnClose>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <div className="prj-mono" style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.8, padding: '9px 12px', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-term)' }}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('project.finish.kept', { path: w.path })}</div>
          {/* 已合入：损失清单换成绿色定心丸（10 §5），未提交改动仍如实提示 */}
          {merged
            ? (<>
              <div style={{ color: '#3fb950' }}>{t('project.finish.mergedRemote', { target: w.mergedInto, kind: w.mergedKind })}</div>
              {uncommitted > 0 && <div style={{ color: '#d29922' }}>{t('project.finish.uncommitted', { count: uncommitted })}</div>}
            </>)
            : <div>{t('project.finish.stats', { base: wtBase || '?', ahead: w.committedAhead, dirty: uncommitted })}</div>}
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
        {merged
          ? radio('discard', t('project.finish.optDiscard'), t('project.finish.optDiscardMergedDesc', { target: w.mergedInto }))
          : radio('discard', t('project.finish.optDiscard'), t('project.finish.optDiscardDesc', { ahead: w.committedAhead }), true)}
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

// 目录规整：去尾斜杠 + 折叠重复斜杠，用于蜂群 dir 与项目 dir 的等值比较
function normDir(p: string): string {
  const s = String(p || '').trim().replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  return s
}

// ── P2 项目主页：头部 + composer(hero) + 任务流/Worktree/编队/活动 ──
function ProjectHome({ proj, allProjects, loaded, openTerm, closeTerm, refresh, activeTerm }: {
  activeTerm?: string | null
  proj?: Proj; allProjects: Proj[]; loaded: boolean; openTerm: (n: string) => void; closeTerm: (n: string) => void; refresh: () => void
}) {
  const { t } = useI18n()
  const { message } = AntApp.useApp()
  const [prefs] = usePreferences()
  const [tab, setTab] = useState<'tasks' | 'wt' | 'race' | 'act' | 'files'>('tasks')
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
  // 「＋ 开始」的主动作：回到 composer 并聚焦——这一页最主要的事就是在这儿描述需求
  const composerRef = useRef<HTMLDivElement>(null)
  const promptRef = useRef<any>(null)
  const focusComposer = () => {
    composerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    promptRef.current?.focus?.()
  }
  const [activity, setActivity] = useState<any[]>([])
  const [finishing, setFinishing] = useState<any>(null)
  const [swarmExtras, setSwarmExtras] = useState<Record<string, { cols: Record<string, number>; last?: any }>>({})
  const [saying, setSaying] = useState<string>('') // 给指挥发话的目标蜂群名
  const [sayText, setSayText] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [peeks, setPeeks] = useState<Record<string, string>>({})
  const [creating, setCreating] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [wtOpen, setWtOpen] = useState(false)
  const [gitOpen, setGitOpen] = useState(false)
  const [gitAt, setGitAt] = useState<{ dir: string; tab: 'changes' | 'base' } | null>(null) // Git 面板落点（分叉图「对比 base」用）
  const [mergingWt, setMergingWt] = useState('')
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
  // 远端轻量同步（10 §3 驻留档）：进项目页即同步一次，驻留期间每 5 分钟一次；
  // 失败静默（判定退回本地），worktree 轮询自然吃到新判定。
  useEffect(() => {
    if (!dir || !isGit) return
    const sync = () => api('POST', '/git/worktree/sync', { dir }).catch(() => {})
    sync()
    const i = setInterval(sync, 5 * 60_000)
    return () => clearInterval(i)
  }, [dir, isGit])
  const wts = useMemo(() => wtsAll.filter((w: any) => !w.isMain && !w.prunable), [wtsAll])
  const mainWt = useMemo(() => wtsAll.find((w: any) => w.isMain), [wtsAll])
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
    // 非 git 项目：按 pane cwd 目录前缀认领（对齐后端 project.go 的两阶段归属），
    // 而不是只取 P1 卡片的 top(≤2)——否则该项目的第 3+ 个会话在详情页永远不出现。
    // 已被某 git 仓库认领的会话(annotation 有 primary.repo)排除，避免嵌套 git 子项目
    // 的会话重复挂到非 git 父目录下。
    // 归属看会话钉死的 home 目录（annotation.home），不是实时 cwd：在会话里 cd 出去
    // 不该让它掉出项目。后端没给 home（老后端/刚起的会话）才退回 ls 的实时 cwd。
    const homeOf = (s: any) => ann[s.name]?.home || s.cwd
    const under = (c: string) => !!c && (c === dir || c.startsWith(dir + '/'))
    // 同一会话归最深(最长前缀)的非 git 项目：排除落在更具体的非 git 兄弟项目里的会话，
    // 与后端最长前缀口径一致，否则父项目详情页会把子项目会话重复计入（外层少、里层多）。
    const deeper = allProjects.filter((p) => !p.git && p.dir !== dir && p.dir.startsWith(dir + '/')).map((p) => p.dir)
    const claimedByDeeper = (c: string) => deeper.some((d) => c === d || c.startsWith(d + '/'))
    return sessions.filter((s) => !ann[s.name]?.primary?.repo && under(homeOf(s)) && !claimedByDeeper(homeOf(s)))
  }, [sessions, ann, dir, isGit, allProjects])
  // 蜂群归属（08 §2.2）：两条判据取并集
  //  1) 蜂群自报的工作目录 dir == 本项目目录（swarm new/adopt --dir 落库，CLI 建的群靠这条）
  //  2) 「指挥/成员会话 ∈ 本项目会话」现算（老蜂群没有 dir，保留兼容）
  // 光靠 2) 不够：项目会话来自 ttmux ls --json，而它按设计过滤掉所有蜂群会话，
  // 于是 CLI 建的群 inProj 恒为 0、永远不显示（issue #125）。
  const mineKey = useMemo(() => mine.map((s) => s.name).sort().join('\n'), [mine])
  useEffect(() => {
    if (!isGit) return
    let stop = false
    const loadSwarms = async () => {
      try {
        const list = await api('GET', '/swarms')
        const names = new Set(mineKey.split('\n').filter(Boolean))
        const here = normDir(dir)
        const active = (Array.isArray(list) ? list : []).filter((s: any) => s.status !== 'archived')
        const out: any[] = []
        await Promise.all(active.map(async (sw: any) => {
          try {
            const st = await api('GET', `/swarms/${encodeURIComponent(sw.name)}`)
            const members = (st?.members || []) as any[]
            const inProj = members.filter((m: any) => names.has(m.session)).length + (st?.supervisor && names.has(st.supervisor) ? 1 : 0)
            const swDir = normDir(sw.dir || st?.dir || '')
            const byDir = !!here && !!swDir && swDir === here
            const roster = members.length + (st?.supervisor ? 1 : 0)
            // 认了 dir 的群，整支班子都算本项目的：它的会话本来就被 ls 过滤掉了，
            // 按会话数算会显示成 0/N 且每行都标「跨项目」。
            if (inProj > 0 || byDir) out.push({ ...sw, inProj: byDir ? roster : inProj, byDir, roster, supervisor: st?.supervisor || '', members })
          } catch {}
        }))
        if (!stop) setSwarms(out.sort((a, b) => String(a.name).localeCompare(String(b.name))))
      } catch {}
    }
    loadSwarms()
    const i = setInterval(loadSwarms, 10000)
    return () => { stop = true; clearInterval(i) }
  }, [isGit, mineKey, dir])
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
  // 三桶（10 §5）：已合入·待清理（绿，零损失一键清）/ 真·未合并（黄，三选一决策，
  // 含「已合入但有未提交改动」）/ 干净（老 ⇥ 语义，ahead=0）
  const wtDirty = (w: any) => w.dirty > 0 || w.untracked > 0
  // 判据与后端概览 (api/project.go) 对齐：cleanable = 已合入 ∧ 无未提交改动，不看
  // committedAhead——S1 祖先(FF)合入 committedAhead==0 也算零损失可清，否则外层「可清理」
  // 计数与详情页对不上（详情把它落进「干净」桶、丢了已合入徽标）。
  // git 生命周期三态细化（已提交→已推送→已合入）：pushed 来自后端本地 ref 判定，
  // 把旧「待收尾」黄条里「本地已提交未推送」与「已推送待合入」拆成两态。
  const wtStage = (w: any): 'merged' | 'pushed' | 'committed' | 'clean' =>
    w?.mergedInto ? 'merged' : w?.committedAhead > 0 ? (w?.pushed ? 'pushed' : 'committed') : 'clean'
  const cleanable = orphans.filter((w: any) => w.mergedInto && !wtDirty(w))
  const unfinished = orphans.filter((w: any) => (w.committedAhead > 0 || wtDirty(w)) && !(w.mergedInto && !wtDirty(w)))
  const clean = orphans.filter((w: any) => !w.mergedInto && !(w.committedAhead > 0 || wtDirty(w)))
  const wtOf = (s: any) => wts.find((w: any) => w.path === ann[s.name]?.primary?.worktree)

  // 图片上传到 /tmp 并把绝对路径插进需求框：开干时路径会随命令传给 agent，模型按绝对路径读图（同对话页 Ctrl+V）
  const uploadImages = async (images: File[]) => {
    if (!images.length || uploading) return
    setUploading(true)
    try {
      const res = await upload('/tmp', images)
      setPrompt((v) => (v ? v.replace(/\s*$/, ' ') : '') + res.saved.join(' ') + ' ')
      message.success(t('chat.uploadedFiles', { count: images.length, dir: '/tmp' }))
    } catch (e: any) { message.error(t('chat.uploadFailed', { message: e.message })) }
    finally { setUploading(false) }
  }

  // Ctrl+V 粘贴图片：一次只取一张（同张截图常以多种 MIME 重复出现，全收会插入两次）
  const onPasteComposer = (e: React.ClipboardEvent) => {
    if (!e.clipboardData?.items) return
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) { e.preventDefault(); uploadImages([makeClipboardImageFile(f, item.type, 0)]); return }
      }
    }
  }

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
  // ＋命令行：每次都开一个新命令行会话（一个项目可有多个）；名字冲突就递增后缀。
  // 已开的命令行会话 cwd 落在项目根，annotation 归属本项目 → 都列在「任务」活动区，可再进入。
  const newShell = async () => {
    if (!proj) return
    const base = proj.name + '-sh'
    const taken = new Set(sessions.map((s) => s.name))
    let name = base
    for (let i = 2; taken.has(name); i++) name = base + i
    try {
      const res = await api('POST', '/sessions', { name, dir })
      message.success(t('session.created')); openTerm(res.name || name); refresh()
    } catch (e: any) { message.error(e.message) }
  }
  // 复制项目 id（不可变身份，日志/台账/接口都按它对齐）
  const copyId = async () => {
    if (!proj) return
    try {
      await navigator.clipboard.writeText(proj.key)
      message.success(t('project.idCopied'))
    } catch { message.error(t('common.copyFailed')) }
  }
  // 重命名 = 改 displayName 偏好（空值回退目录名，id/目录不变）
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
        onOk: async () => { try { await api('DELETE', '/sessions/' + encodeURIComponent(n)); message.success(t('session.closed')); closeTerm(n); refresh() } catch (e: any) { message.error(e.message) } },
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

  const sect = (label: string, count: number, tone?: 'warn' | 'ok') => (
    <div className={`prj-sect${tone ? ' ' + tone : ''}`}>
      <b>{label}</b><span className="n">{count}</span><span className="ln" />
    </div>
  )
  // ── Worktree 分叉图的就地操作（设计 11 §8.3：三个动作都在行内做完，不再跳面板）──
  // 对比 base：把 Git 面板开到这条 worktree 上并直接落在「对比 base」tab
  const compareWt = (w: any) => setGitAt({ dir: w.path, tab: 'base' })
  const mergeWt = async (w: any, strategy: 'merge' | 'squash' | 'rebase') => {
    if (mergingWt) return
    setMergingWt(w.path)
    try {
      await api('POST', '/git/worktree/merge', { path: w.path, strategy, expectedHead: w.head })
      message.success(t('git.wt.mergeDone', { base: w.base }))
      refresh()
    } catch (e: any) {
      const ae = e.apiError
      if (ae?.code === 'MERGE_CONFLICT') {
        Modal.error({
          title: t('worktree.mergeConflictTitle'),
          content: (
            <div style={{ fontSize: 13 }}>
              <div style={{ marginBottom: 6 }}>{t('worktree.mergeConflictDesc', { stage: ae.stage || '?' })}</div>
              <ul style={{ paddingLeft: 18, margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                {(ae.conflictFiles || []).map((cf: string) => <li key={cf}>{cf}</li>)}
              </ul>
            </div>
          ),
        })
      } else message.error(e.message)
    } finally { setMergingWt('') }
  }
  // 删除：先把「会丢什么」摆出来再确认。分支一律留着——真要连分支删走「一键清理」那条零损失路径。
  const removeWt = (w: any) => {
    const dirty = (w.dirty || 0) + (w.untracked || 0)
    Modal.confirm({
      title: t('project.wt.deleteConfirm', { branch: w.branch || w.path }),
      content: (
        <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.8 }}>
          <div>{t('project.wt.deleteKeepsBranch', { branch: w.branch || '?' })}</div>
          {dirty > 0 && <div style={{ color: '#d29922' }}>{t('project.wt.deleteLosesDirty', { count: dirty })}</div>}
          {w.committedAhead > 0 && !w.pushed && <div style={{ color: '#d29922' }}>{t('project.wt.deleteUnpushed', { count: w.committedAhead })}</div>}
        </div>
      ),
      okText: t('project.wt.delete'), cancelText: t('common.cancel'), okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api('POST', '/git/worktree/remove', { path: w.path, forceWorktree: dirty > 0 })
          message.success(t('project.wt.deleted')); refresh()
        } catch (e: any) { message.error(e.message) }
      },
    })
  }
  const pruneWts = async () => {
    try {
      const r = await api('POST', '/git/worktree/prune', { dir })
      message.success(r?.data?.output?.trim?.() || t('project.wt.pruned')); refresh()
    } catch (e: any) { message.error(e.message) }
  }
  const wtRowMenu = (w: any, cat: string, live: number): MenuProps => ({
    items: [
      { key: 'open', label: t('project.wt.openFolder') },
      { key: 'copy', label: t('project.wt.copyPath') },
      { key: 'manage', label: t('project.wtManage') },
      { type: 'divider' },
      {
        key: 'delete', label: t('project.wt.delete'), danger: true,
        disabled: live > 0 || cat === 'ext',
      },
    ],
    onClick: ({ key }) => {
      if (key === 'open') setGitAt({ dir: w.path, tab: 'changes' })
      else if (key === 'copy') navigator.clipboard?.writeText(w.path).then(() => message.success(t('common.copied')), () => {})
      else if (key === 'manage') setWtOpen(true)
      else if (key === 'delete') removeWt(w)
    },
  })

  // 已合入·待清理的一键清（10 §5）：零损失确认后删 worktree + 本地分支（留痕 cleaned）
  const cleanupMerged = (w: any) => {
    Modal.confirm({
      title: t('project.cleanupConfirm', { branch: w.branch }),
      content: t('project.cleanupConfirmDesc', { target: w.mergedInto }),
      okText: t('project.cleanup'),
      onOk: async () => {
        try {
          await api('POST', '/git/worktree/remove', { path: w.path, deleteBranch: true, forceDeleteBranch: true })
          message.success(t('project.cleaned'))
          refresh()
        } catch (e: any) { message.error(e.message) }
      },
    })
  }

  // 任务行：生命周期导轨 = 建(必亮)→干(agent 跑)→审(待输入/有未合并)→并(merged)
  // 状态点语义（设计 W2）：绿 = agent 正在干活，黄 = 待输入，其余一律灰。
  const row = (s: any, i: number) => {
    const a = ann[s.name] || {}
    const hit = a.primary || {}
    const isChild = !!s.parent && mine.some((x) => x.name === s.parent)
    const w = wtOf(s)
    const ahead = w?.committedAhead || 0
    const changes = (w?.dirty || 0) + (w?.untracked || 0)
    const gs = wtStage(w)
    const merged = gs === 'merged'
    const running = cc[s.name] || cx[s.name]
    const waiting = needsInput[s.name]
    let done = 2, cur: number | undefined, stage = t('project.stage.idle')
    if (running && !waiting) { done = 1; cur = 2; stage = t('project.stage.doing') }
    else if (waiting) { done = 2; cur = 3; stage = t('project.stage.review') }
    else if (gs === 'merged') { done = 4; stage = t('project.stage.merged') } // 合入检测（10 §5）：导轨走满
    else if (gs === 'pushed') { done = 3; cur = 4; stage = t('project.stage.pushed') } // 已推送待合入：审毕、并在跑
    else if (gs === 'committed') { done = 2; cur = 3; stage = t('project.stage.committed') } // 本地已提交未推送
    // 从这一行开的会话：行保持选中并给细蓝边，页面与终端的对应关系不靠记（14 §6.3.1）
    return (
      <div key={s.name} className={`prj-row prj-in${activeTerm === s.name ? ' on' : ''}`}
        aria-current={activeTerm === s.name ? 'true' : undefined}
        style={{ marginLeft: isChild ? 22 : 0, animationDelay: `${Math.min(i, 8) * 40}ms` }}
        onClick={() => openTerm(s.name)}>
        <span style={{ marginTop: 7, display: 'inline-flex' }}>{dot(false, waiting ? '#d29922' : running ? '#3fb950' : undefined)}</span>
        {isChild && <span style={{ color: '#a371f7', fontSize: 12, marginTop: 3 }}>⑂</span>}
        <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700 }} title={s.name}>{s.label || sessionLabel(s.name)}</span>
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
            {/* 已合入后 ↑n 不再展示（对比远端已零领先，只会误导）；未提交改动照常提示 */}
            {merged && (
              <Tooltip title={`${w.mergedInto} · ${w.mergedKind}`}>
                <span style={{ color: '#3fb950', fontSize: 11.5 }}>✓ {t('project.mergedTag')}</span>
              </Tooltip>
            )}
            {gs === 'pushed' && (
              <Tooltip title={hit.branch ? `origin/${hit.branch}` : undefined}>
                <span style={{ color: '#58a6ff', fontSize: 11.5 }}>⇡ {t('project.pushedTag')}</span>
              </Tooltip>
            )}
            {(!merged && ahead > 0 || changes > 0) && (
              <span className="prj-mono" style={{ fontSize: 11.5 }}>
                {!merged && ahead > 0 && <span style={{ color: '#58a6ff' }}>↑{ahead}</span>}
                {!merged && ahead > 0 && changes > 0 && ' · '}
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
    // 这里**不能**加 overflow:auto——任何非 visible 的祖先都会成为 sticky 的
    // 参照系，而这一层并不真的滚动（真正滚的是 .tt-canvas），于是页头永远粘不住。
    <div>
      <div className="prj-wrap">
        {/* 项目头：面包屑 | 名称 / 路径 · ⎇主干@HEAD | 主操作。sticky（14 §6.2）——
            往下翻任务流时"我在哪个项目、要新建什么"不该跟着滚走。 */}
        <div className="prj-in prj-head" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button type="text" size="small" onClick={() => { location.hash = '#/projects' }}
            style={{ color: 'var(--text-dim)', paddingInline: 6, flex: '0 0 auto' }}>‹ {t('project.title')}</Button>
          <span style={{ width: 1, height: 18, background: 'var(--border-subtle)', flex: '0 0 auto' }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            {/* 名称可编辑 = 重命名（displayName 偏好，key/目录不变） */}
            <Typography.Text style={{ fontSize: 16, fontWeight: 700, display: 'block', whiteSpace: 'nowrap' }}
              ellipsis editable={{ onChange: rename, tooltip: t('project.rename'), triggerType: ['icon'] }}>
              {proj.name}
            </Typography.Text>
            <div className="prj-mono" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-dimmer)' }}>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={proj.dir}>
                {proj.dir}
                {isGit && defBranch && <span style={{ color: '#39c5cf' }}> · ⎇ {defBranch}{mainHead ? ` @ ${mainHead}` : ''}</span>}
              </span>
              {/* 项目 id（不可变，目录搬家也不变）：排障时对着日志/台账查同一个项目 */}
              <Tooltip title={t('project.copyId')}>
                <span onClick={copyId} style={{ flex: '0 0 auto', cursor: 'pointer', opacity: .7 }}>#{proj.key}</span>
              </Tooltip>
            </div>
          </div>
          {isGit && <Button size="small" onClick={() => setGitOpen(true)}>{t('project.gitPanel')}</Button>}
          {/* 「新建会话 / 蜂群 / Race / 命令行」原来散在页头和编队 tab 里，两处入口互相不知道
              对方存在。集中成一枚 split button：主动作 = 回到 composer 描述需求（这一页最主要的
              事），其余进菜单（14 §6.2）。 */}
          {/* 必须包一层并钉住 flex：Dropdown.Button 内部的 Space.Compact 在 flex 容器里
              是块级 flex 子项，会一路撑到 723px，把左边的项目名挤成 0 宽 */}
          <span style={{ flex: '0 0 auto', display: 'inline-flex' }}>
          <Dropdown.Button size="small" type="primary" trigger={['click']}
            onClick={focusComposer}
            menu={{ items: [
              { key: 'shell', label: t('project.shell'), onClick: newShell },
              ...(isGit ? [
                { key: 'swarm', label: t('project.newSwarm'), onClick: () => setSwarmOpen(true) },
                { key: 'race', label: t('project.newRace'), onClick: () => setRaceOpen(true) },
              ] : []),
            ] }}>
            ＋ {t('project.start')}
          </Dropdown.Button>
          </span>
        </div>

        {/* Composer（hero）：需求 ⏎ 开干 */}
        <div ref={composerRef} className="prj-composer prj-in" style={{ animationDelay: '60ms' }}>
          <Input.TextArea ref={promptRef} value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder={isGit ? t('project.composerPlaceholder') : t('project.composerPlain')} autoSize={{ minRows: 2, maxRows: 6 }} variant="borderless"
            onPaste={onPasteComposer}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); goCreate() } }} />
          <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
            onChange={(e) => { const fs = e.target.files ? Array.from(e.target.files) : []; e.target.value = ''; if (fs.length) uploadImages(fs) }} />
          <div className="prj-cbar">
            <Button size="small" type="text" title={t('project.attachImage')} loading={uploading} onClick={() => fileRef.current?.click()} style={{ padding: '0 4px' }}>📎</Button>
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

        {/* Tabs：任务 | Worktree | 编队 | 活动（非 git 只有任务）。同样 sticky，贴在项目头下面 */}
        <div className="prj-tabs prj-in" style={{ animationDelay: '110ms' }}>
          {tabBtn('tasks', t('project.tasks'), mine.length + unfinished.length + cleanable.length + clean.length)}
          {isGit && tabBtn('wt', 'Worktree', wts.length)}
          {isGit && tabBtn('race', t('project.tab.race'), races.length + swarms.length)}
          {isGit && tabBtn('act', t('project.tab.activity'))}
          {tabBtn('files', t('project.tab.files'))}
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

          {cleanable.length > 0 && (<>
            {sect(t('project.section.cleanable'), cleanable.length, 'ok')}
            {cleanable.map((w: any) => (
              <div key={w.path} className="prj-row">
                <span style={{ marginTop: 7, display: 'inline-flex' }}>{dot(false, '#3fb950')}</span>
                <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                    <Tag color="cyan" className="prj-mono" style={{ margin: 0, fontSize: 11 }}>⎇ {w.branch}</Tag>
                    <Tooltip title={`${w.mergedInto} · ${w.mergedKind}`}>
                      <Tag color="success" style={{ margin: 0 }}>✓ {t('project.mergedTag')}</Tag>
                    </Tooltip>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-dimmer)', flexWrap: 'wrap' }}>
                    <Lifec done={4} /><span>{t('project.stage.merged')}</span>
                    <span className="prj-mono" style={{ fontSize: 11.5, color: '#3fb950' }}>{t('project.mergedInto', { target: w.mergedInto })}</span>
                    <span>{relTime(w.lastCommitAt, t)}</span>
                  </div>
                </div>
                <span className="acts">
                  <a style={{ color: '#3fb950' }} onClick={() => cleanupMerged(w)}>{t('project.cleanup')}</a>
                  <a onClick={() => newCli(w, 'shell')}>{t('project.revive')}</a>
                  <a onClick={() => setGitOpen(true)}>{t('project.compare')}</a>
                </span>
              </div>
            ))}
          </>)}

          {unfinished.length > 0 && (<>
            {sect(t('project.section.unfinished'), unfinished.length, 'warn')}
            {unfinished.map((w: any) => (
              <div key={w.path} className="prj-row warn">
                <span style={{ marginTop: 7, display: 'inline-flex' }}>{dot(false, '#d29922')}</span>
                <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                    <Tag color="cyan" className="prj-mono" style={{ margin: 0, fontSize: 11 }}>⎇ {w.branch}</Tag>
                    <Tag color="warning" style={{ margin: 0 }}>{t('project.sessionClosed')}</Tag>
                    {/* 已合入但还有未提交改动：绿标缓解焦虑，损失只剩 working tree */}
                    {w.mergedInto && (
                      <Tooltip title={`${w.mergedInto} · ${w.mergedKind}`}>
                        <Tag color="success" style={{ margin: 0 }}>✓ {t('project.mergedTag')}</Tag>
                      </Tooltip>
                    )}
                    {/* 三态细化：已推送未合入——蓝标区分「本地已提交」，收尾丢弃前知道远端还留着 */}
                    {!w.mergedInto && w.pushed && (
                      <Tooltip title={`origin/${w.branch}`}>
                        <Tag color="blue" style={{ margin: 0 }}>⇡ {t('project.pushedTag')}</Tag>
                      </Tooltip>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-dimmer)', flexWrap: 'wrap' }}>
                    {w.mergedInto
                      ? <><Lifec done={2} cur={3} /><span>{t('project.stage.unfinished')}</span></>
                      : w.pushed
                        ? <><Lifec done={3} cur={4} /><span>{t('project.stage.pushed')}</span></>
                        : <><Lifec done={2} cur={3} /><span>{t('project.stage.committed')}</span></>}
                    <span className="prj-mono" style={{ fontSize: 11.5 }}>
                      {w.mergedInto
                        ? <span style={{ color: '#d29922' }}>{t('project.wt.changes', { count: w.dirty + w.untracked })}</span>
                        : t('project.aheadDirty', { ahead: w.committedAhead, dirty: w.dirty + w.untracked })}
                    </span>
                    {/* S3 佐证（10 §4）：远端分支已删只给线索，不替人拍板 */}
                    {!w.mergedInto && w.remoteGone && <span style={{ color: '#d29922', fontSize: 11.5 }}>{t('project.remoteGoneHint')}</span>}
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

        {/* ── Worktree tab：分叉图（设计 11 §8/G5）──
            主干一条竖线贯穿全表，每条 worktree 从主干分叉出去；状态编码在节点形状上。
            主干必须是整行高的绝对定位元素——行高随内容变，画进每行的 SVG 里必断。 */}
        {tab === 'wt' && (
          <div className="prj-panel prj-in">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap' }}>
              <Button size="small" onClick={() => setWtOpen(true)}>＋ {t('project.wt.newWorktree')}</Button>
              <Button size="small" onClick={pruneWts}>{t('project.wt.prune')}</Button>
              <span style={{ flex: 1 }} />
              <a style={{ fontSize: 12.5 }} onClick={() => setWtOpen(true)}>{t('project.wt.allRepos')} ›</a>
            </div>

            {mainWt && (
              <div className="prj-fork head">
                <svg width="38" height="44" className="fk">
                  <circle cx="15" cy="22" r="7.4" fill="none" stroke={FORK_TRUNK} strokeWidth="1.4" opacity=".45" />
                  <circle cx="15" cy="22" r="4.2" fill={FORK_TRUNK} />
                </svg>
                <div className="col">
                  <div className="info">
                    <div className="n1">
                      <span className="wt-br" style={{ color: FORK_TRUNK }}>{mainWt.branch || 'HEAD'}</span>
                      <Tag style={{ margin: 0 }}>{t('project.wt.mainTag')}</Tag>
                      <span className="prj-mono" style={{ fontSize: 11, color: 'var(--text-dimmer)' }}>{(mainWt.head || '').slice(0, 7)}</span>
                    </div>
                    <div className="n2">
                      <span className="prj-mono">{mainWt.path}</span>
                      {wts.length > 0 && <> · {t('project.wt.forkCount', { count: wts.length })}</>}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {wts.length === 0 && <div className="prj-empty">{t('project.wt.none')}</div>}

            {wts.map((w: any) => {
              const open = !!expanded[w.path]
              const live = (w.sessions || []).length
              const dirty = (w.dirty || 0) + (w.untracked || 0)
              const cleanable = !!w.mergedInto && dirty === 0
              const cat = w.external ? 'ext' : live > 0 ? 'live' : cleanable ? 'merged' : 'orphan'
              const color = FORK_COLOR[cat]
              return (
                <div key={w.path} className={`prj-fork ${cat}`}>
                  <svg width="38" height="44" className="fk">
                    <path d="M15 2C15 16,23 12,29 22" stroke={color} strokeWidth="1.6" fill="none"
                      strokeDasharray={cat === 'merged' ? '3 3' : undefined} />
                    {cat === 'ext'
                      ? <rect x="25.5" y="18.5" width="7" height="7" transform="rotate(45 29 22)" fill="none" stroke={color} strokeWidth="1.5" />
                      : cat === 'merged'
                        ? <circle cx="29" cy="22" r="4.4" fill="var(--bg-container)" stroke={color} strokeWidth="1.6" />
                        : <>
                            {cat === 'live' && <circle cx="29" cy="22" r="8" fill="none" stroke={color} strokeWidth="1.2" opacity=".35" />}
                            <circle cx="29" cy="22" r="4.6" fill={color} />
                          </>}
                  </svg>
                  {/* 动作区是 .col 的第二列，不能塞进会换行的 .n1——否则名字一长按钮就掉行 */}
                  <div className="col">
                    <div className="info">
                    <div className="n1">
                      <span className="wt-br" onClick={() => setExpanded((m) => ({ ...m, [w.path]: !open }))}
                        style={{ cursor: 'pointer', color: cat === 'merged' || cat === 'ext' ? 'var(--text-dim)' : undefined }}>
                        {w.branch || '(detached)'}
                      </span>
                      {w.committedAhead > 0 && <span className="wt-ab up">↑{w.committedAhead}</span>}
                      {w.behind > 0 && <span className="wt-ab dn">↓{w.behind}</span>}
                      {cat === 'live' && <Tag color="green" style={{ margin: 0 }}>{t('project.wt.cli', { count: live })}</Tag>}
                      {cat === 'orphan' && <Tag color="warning" style={{ margin: 0 }}>{t('project.wt.orphanPending')}</Tag>}
                      {cat === 'merged' && <Tag color="success" style={{ margin: 0 }}>✓ {t('project.wt.mergedInto', { target: w.mergedInto })}</Tag>}
                      {cat === 'ext' && <Tag style={{ margin: 0 }}>{t('project.wt.externalTag')}</Tag>}
                    </div>
                    <div className="n2 prj-mono">
                      {w.external
                        ? <>{w.path} · {t('project.wt.externalNote')}</>
                        : <>
                            <span style={{ color: dirty > 0 ? '#d29922' : undefined }}>{t('project.wt.uncommitted', { count: dirty })}</span>
                            {' · '}
                            {cleanable
                              ? <>{t('project.wt.mergedKind', { kind: w.mergedKind || '?' })} · {t('project.wt.zeroLoss')}</>
                              : w.committedAhead > 0
                                ? <span style={{ color: w.pushed ? undefined : '#d29922' }}>
                                    {w.pushed ? t('project.wt.pushed') : t('project.wt.notPushed', { count: w.committedAhead })}
                                  </span>
                                : t('project.wt.noCommits')}
                            {' · '}{relTime(w.lastCommitAt, t)}
                            {live === 0 && <> · {t('project.wt.noSession')}</>}
                          </>}
                    </div>

                    {open && (
                      <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {(w.sessions || []).map((ref: any) => (
                          <div key={ref.session} className="prj-subrow" onClick={() => openTerm(ref.session)}>
                            {dot(false, cc[ref.session] || cx[ref.session] ? '#3fb950' : undefined)}
                            <span style={{ fontWeight: 600, fontSize: 13 }} title={ref.session}>{sessionLabel(ref.session)}</span>
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
                    </div>

                    <span className="wt-acts">
                      {!!w.base && (
                        <Button size="small" onClick={() => compareWt(w)}>
                          {cleanable ? t('project.wt.viewMerged') : t('project.wt.compareWith', { base: w.base })}
                        </Button>
                      )}
                      {cleanable && <Button size="small" onClick={() => cleanupMerged(w)}>{t('project.cleanup')}</Button>}
                      {!cleanable && !w.external && !!w.base && (
                        live === 0 && w.committedAhead === 0 && dirty === 0
                          ? <Dropdown menu={{ items: CLI_KINDS.map((k) => ({ key: k, label: k })), onClick: ({ key }) => newCli(w, key as any) }}>
                              <Button size="small">{t('project.wt.resume')} ▾</Button>
                            </Dropdown>
                          : <Dropdown.Button size="small" type="primary" disabled={mergingWt === w.path}
                              icon={<span style={{ fontSize: 10 }}>▾</span>}
                              onClick={() => mergeWt(w, 'squash')}
                              menu={{ items: [{ key: 'merge', label: 'merge' }, { key: 'rebase', label: 'rebase' }], onClick: ({ key }) => mergeWt(w, key as any) }}>
                              {mergingWt === w.path ? <Spin size="small" /> : t('worktree.mergeInto', { base: w.base })}
                            </Dropdown.Button>
                      )}
                      <Dropdown menu={wtRowMenu(w, cat, live)} trigger={['click']} placement="bottomRight">
                        <Button size="small">⋯</Button>
                      </Dropdown>
                    </span>
                  </div>
                </div>
              )
            })}
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
            // label：蜂群成员的语义名 `<群>-<成员>` / 指挥 cc-<群>。蜂群会话被会话列表
            // 过滤掉（不在全局展示名表里），所以名字要由蜂群接口随行带来。
            const memberRow = (session: string, role: string, subrole?: string, done?: boolean, status?: string, label?: string) => {
              // 按 dir 认领的群：成员会话不在 ls 清单里（被蜂群过滤挡掉），但确实属于本项目
              const inProj = mineNames.has(session) || !!sw.byDir
              const running = cc[session] || cx[session] || status === 'running'
              return (
                <div key={session} className="prj-subrow" style={{ opacity: inProj ? 1 : 0.45 }}
                  onClick={() => { if (inProj) openTerm(session) }}>
                  {dot(false, status === 'waiting' ? '#d29922' : running ? '#3fb950' : undefined)}
                  <span style={{ fontWeight: 600, fontSize: 13 }} title={session}>{label || sessionLabel(session)}</span>
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
                  {sw.supervisor && memberRow(sw.supervisor, 'leader', undefined, false, undefined, 'cc-' + sw.name)}
                  {(sw.members || []).filter((m: any) => m.session && m.session !== sw.supervisor)
                    .map((m: any) => memberRow(m.session, m.role, m.subrole, !!m.done, m.status, m.label))}
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
            {/* 新建入口统一收在页头的「＋ 开始」里，这里不再重复（14 §6.2） */}
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

        {/* ── 文件浏览 ── split 是 height:100% 的组件，需给有界高度的父容器；预留头/Composer/Tab 占位 */}
        {tab === 'files' && (
          <div className="prj-panel prj-in" style={{ height: 'calc(100vh - 300px)', minHeight: 420, overflow: 'hidden', padding: 0 }}>
            <FileBrowser
              dir={proj.dir}
              layout="split"
              onInsertPath={(p) => setPrompt((cur) => (cur ? cur.replace(/\s*$/, ' ') : '') + '@' + p + ' ')}
            />
          </div>
        )}

        <Suspense fallback={<Spin />}>
          {wtOpen && <WorktreePanel open={wtOpen} onClose={() => { setWtOpen(false); refresh() }} openTerm={openTerm} initialDir={dir} />}
          {(gitOpen || gitAt) && (
            <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(1,4,9,.6)' }} onClick={() => { setGitOpen(false); setGitAt(null) }}>
              <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 'min(520px, 94vw)', background: 'var(--bg-container)', borderLeft: '1px solid var(--border)' }}
                onClick={(e) => e.stopPropagation()}>
                <GitPanel dir={gitAt?.dir || dir} initialTab={gitAt?.tab} openTerm={openTerm}
                  onClose={() => { setGitOpen(false); setGitAt(null) }} />
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
        <CloseWorktreeModal info={closing} onClose={() => setClosing(null)} onDone={(name) => { closeTerm(name); setClosing(null); refresh() }} />
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
