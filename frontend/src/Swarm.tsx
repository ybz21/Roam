// 蜂群(swarm) 页面：列表 + 详情仪表盘（实时拓扑 / 广场 / 看板 / 节点详情抽屉）。
// 数据全部来自后端 /api/swarms*（透传 ttmux CLI）。设计见 docs/design/蜂群 Web 接入设计.md。
//   一个蜂群 = 一个 master cc(会话 cc-<群>) 带一群 member cc(会话 <群>-<成员>)，每个节点可一键进终端。
//   Web 只读 + 广场/看板轻操作；建群/加成员/接管仍在 CLI。
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Card, Tag, Empty, Segmented, Input, Select, Button, Drawer, Tooltip,
  App as AntApp, Popconfirm, Modal, Space, Spin,
} from 'antd'
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd'
import { api } from './api'

// ── 配色（与 App.tsx 一致） ──
const C = {
  bg: '#0d1117', bg2: '#161b22', bg3: '#06090d', line: '#21262d', line2: '#30363d',
  fg: '#e6edf3', fg2: '#8b949e', fg3: '#6e7681',
  blue: '#58a6ff', green: '#3fb950', amber: '#d29922', red: '#f85149', magenta: '#d2a8ff', cyan: '#39c5cf',
}
const COLS = ['backlog', 'assigned', 'doing', 'review', 'done', 'blocked'] as const
type Col = typeof COLS[number]
const COL_LABEL: Record<Col, string> = { backlog: '待办', assigned: '已派', doing: '进行', review: '待审', done: '完成', blocked: '受阻' }
const COL_COLOR: Record<Col, string> = { backlog: C.fg2, assigned: C.blue, doing: C.amber, review: C.cyan, done: C.green, blocked: C.red }

interface SwarmRow { id: string; name: string; goal: string; status: string; supervisor: string; created: string; total: number; alive: number; pending: number }
interface Member { name: string; type: string; task: string; deps: string; done: number; status: string; session: string }
interface Pending { name: string; deps: string }
interface Detail { name: string; goal: string; status: string; supervisor: string; created: string; members: Member[]; pending: Pending[]; done_marked: string[] }
interface Post { id: number; ts: string; author: string; kind: string; re: number | null; text: string }
interface CardT { id: string; title: string; descr: string; assignee: string; col: string; deps: string; updated: string }

function statusTag(status: string) {
  const map: Record<string, [string, string]> = {
    running: [C.amber, 'running'], done: [C.green, 'done'],
    integrating: [C.cyan, 'integrating'], planning: [C.fg2, 'planning'], archived: [C.fg3, 'archived'],
  }
  const [c, t] = map[status] || [C.fg2, status || 'planning']
  return <Tag style={{ color: c, borderColor: c + '66', background: c + '14', margin: 0 }}>{t}</Tag>
}

export default function Swarm({ openTerm }: { openTerm: (n: string) => void }) {
  const [sel, setSel] = useState<string | null>(null)
  const [list, setList] = useState<SwarmRow[]>([])
  const loadList = () => api('GET', '/swarms').then((r) => setList(Array.isArray(r) ? r : [])).catch(() => {})
  useEffect(() => {
    if (sel) return
    loadList(); const t = setInterval(loadList, 3000); return () => clearInterval(t)
  }, [sel])

  if (sel) return <SwarmDetail name={sel} onBack={() => setSel(null)} openTerm={openTerm} onGone={() => { setSel(null); loadList() }} />
  return <SwarmList list={list} onOpen={setSel} reload={loadList} />
}

// ── 列表页 ──
function SwarmList({ list, onOpen, reload }: { list: SwarmRow[]; onOpen: (n: string) => void; reload: () => void }) {
  const [creating, setCreating] = useState(false)
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: C.fg }}>蜂群</span>
        <span style={{ color: C.fg3, fontSize: 12 }}>一个 master cc 带一群 member cc 协作</span>
        <Button type="primary" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>+ 新建蜂群</Button>
      </div>
      {list.length === 0 ? (
        <Card style={{ textAlign: 'center', padding: '32px 0' }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span style={{ color: C.fg2 }}>还没有蜂群</span>}>
            <Button type="primary" onClick={() => setCreating(true)}>+ 新建第一个蜂群</Button>
          </Empty>
        </Card>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 14 }}>
          {list.map((s) => <SwarmCard key={s.id || s.name} s={s} onOpen={onOpen} />)}
        </div>
      )}
      <NewSwarmModal open={creating} onClose={() => setCreating(false)} onDone={reload} />
    </Space>
  )
}

function SwarmCard({ s, onOpen }: { s: SwarmRow; onOpen: (n: string) => void }) {
  const accent = s.status === 'running' ? C.amber : s.status === 'done' ? C.green : s.status === 'archived' ? C.fg3 : C.blue
  const exited = Math.max(0, s.total - s.alive)
  const [hover, setHover] = useState(false)
  return (
    <div onClick={() => onOpen(s.name)} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative', background: C.bg2, border: `1px solid ${hover ? accent + '88' : C.line2}`, borderRadius: 12,
        padding: '14px 16px 13px', cursor: 'pointer', overflow: 'hidden', transition: 'border-color .15s, transform .15s',
        transform: hover ? 'translateY(-2px)' : 'none',
      }}>
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: accent }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ color: C.magenta, fontSize: 15 }}>◆</span>
        <span style={{ fontSize: 16, fontWeight: 700, color: C.fg }}>{s.name}</span>
        <span style={{ marginLeft: 'auto' }}>{statusTag(s.status)}</span>
      </div>
      <div style={{ color: s.goal ? C.fg2 : C.fg3, fontSize: 13, marginBottom: 12, minHeight: 19, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {s.goal || '（无目标）'}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
          {Array.from({ length: Math.min(s.alive, 10) }).map((_, i) => <i key={'a' + i} style={{ width: 8, height: 8, borderRadius: '50%', background: C.green }} />)}
          {Array.from({ length: Math.min(s.pending, 10) }).map((_, i) => <i key={'p' + i} style={{ width: 8, height: 8, borderRadius: '50%', background: C.amber }} />)}
          {Array.from({ length: Math.min(exited, 10) }).map((_, i) => <i key={'e' + i} style={{ width: 8, height: 8, borderRadius: '50%', background: C.line2 }} />)}
          {s.total + s.pending === 0 && <span style={{ color: C.fg3, fontSize: 12 }}>暂无成员</span>}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center', fontSize: 12, color: C.fg2 }}>
          {s.alive > 0 && <span><b style={{ color: C.green }}>{s.alive}</b> 活</span>}
          {s.pending > 0 && <span style={{ color: C.amber }}>+{s.pending} 待解锁</span>}
        </span>
      </div>
      <div style={{ marginTop: 10, paddingTop: 9, borderTop: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', fontSize: 11.5, color: C.fg3 }}>
        <span style={{ color: s.supervisor ? C.magenta : C.fg3 }}>{s.supervisor ? `◆ ${s.supervisor}` : '无指挥'}</span>
        <span style={{ marginLeft: 'auto' }}>{(s.created || '').slice(5, 16)}</span>
      </div>
    </div>
  )
}

function NewSwarmModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { message } = AntApp.useApp()
  const [name, setName] = useState(''); const [goal, setGoal] = useState(''); const [master, setMaster] = useState(true)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setName(''); setGoal(''); setMaster(true) } }, [open])
  const ok = async () => {
    if (!name.trim()) return message.error('需要蜂群名')
    setBusy(true)
    try {
      await api('POST', '/swarms', { name: name.trim(), goal: goal.trim(), master })
      message.success(master ? '已建群并拉起指挥 master' : '已建群')
      onClose(); onDone()
    } catch (e: any) { message.error(e.message) } finally { setBusy(false) }
  }
  return (
    <Modal open={open} onCancel={onClose} onOk={ok} okText="创建" confirmLoading={busy} title="新建蜂群" destroyOnClose>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Input placeholder="蜂群名，如 login" value={name} onChange={(e) => setName(e.target.value)} autoFocus onPressEnter={ok} />
        <Input.TextArea rows={2} placeholder="目标（可空），如：加登录页 + 调 API 契约" value={goal} onChange={(e) => setGoal(e.target.value)} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.fg2, fontSize: 13 }}>
          <input type="checkbox" checked={master} onChange={(e) => setMaster(e.target.checked)} />
          自动拉起指挥 master（cc-{name || '群'}，加载 cc-swarm 技能）
        </label>
      </Space>
    </Modal>
  )
}

// ── 详情仪表盘 ──
function SwarmDetail({ name, onBack, openTerm, onGone }: { name: string; onBack: () => void; openTerm: (n: string) => void; onGone: () => void }) {
  const { message, modal } = AntApp.useApp()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [cards, setCards] = useState<CardT[]>([])
  const [posts, setPosts] = useState<Post[]>([])
  const [focus, setFocus] = useState<string | null>(null)   // 聚焦成员（跨面板联动）
  const [drawer, setDrawer] = useState<string | null>(null) // 抽屉里的成员
  const [view, setView] = useState<'topo' | 'board' | 'plaza'>('topo')
  const [narrow, setNarrow] = useState(false)
  const [adding, setAdding] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const lastId = useRef(0)

  const reloadDetail = () => api('GET', `/swarms/${encodeURIComponent(name)}`).then(setDetail).catch(() => {})

  // 自身宽度 < 860 → 页签；否则仪表盘（终端停靠会压窄内容区，量自身比量视口准）
  useEffect(() => {
    const el = rootRef.current; if (!el) return
    const ro = new ResizeObserver((es) => setNarrow(es[0].contentRect.width < 860))
    ro.observe(el); return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const loadDetail = reloadDetail
    const loadBoard = () => api('GET', `/swarms/${encodeURIComponent(name)}/board`).then((r) => setCards(Array.isArray(r) ? r : [])).catch(() => {})
    const loadFeed = () => api('GET', `/swarms/${encodeURIComponent(name)}/feed?since=${lastId.current}`)
      .then((r) => {
        const arr: Post[] = Array.isArray(r) ? r : []
        if (arr.length) {
          lastId.current = arr[arr.length - 1].id
          setPosts((p) => (lastId.current && p.length ? [...p, ...arr] : arr))
        }
      }).catch(() => {})
    loadDetail(); loadBoard(); loadFeed()
    const t1 = setInterval(loadDetail, 3000), t2 = setInterval(loadBoard, 3000), t3 = setInterval(loadFeed, 2000)
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3) }
  }, [name])

  const onNode = (m: string) => { setFocus(m); setDrawer(m) }
  const closeDrawer = () => { setDrawer(null); setFocus(null) }
  const enc = encodeURIComponent(name)
  const markDone = (member?: string) =>
    api('POST', `/swarms/${enc}/done`, member ? { member } : {}).then(() => { message.success(member ? `已标记 ${member} 完成` : '已标记整群完成'); reloadDetail() }).catch((e: any) => message.error(e.message))
  const activate = (member?: string, force?: boolean) =>
    api('POST', `/swarms/${enc}/activate`, { member: member || '', force: !!force }).then(() => { message.success('已解锁'); reloadDetail() }).catch((e: any) => message.error(e.message))
  const archive = () => modal.confirm({
    title: `归档蜂群 ${name}？`, content: '会杀掉成员会话，保留元数据/看板/广场（不彻底删除）。',
    okText: '归档', okButtonProps: { danger: true },
    onOk: async () => { try { await api('DELETE', `/swarms/${enc}`); message.success('已归档'); onGone() } catch (e: any) { message.error(e.message) } },
  })

  const topo = <Topology detail={detail} swarm={name} focus={focus} onNode={onNode} />
  const plaza = <Plaza name={name} posts={posts} focus={focus} />
  const board = <Board name={name} cards={cards} focus={focus} onCard={(c) => onNode(c.assignee)} reload={() => api('GET', `/swarms/${encodeURIComponent(name)}/board`).then((r) => setCards(Array.isArray(r) ? r : [])).catch(() => {})} setCards={setCards} />

  return (
    <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 顶部条 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 2px 12px', flexWrap: 'wrap' }}>
        <a onClick={onBack} style={{ color: C.fg2 }}>← 蜂群</a>
        <span style={{ fontSize: 17, fontWeight: 700 }}>{name}</span>
        {detail?.goal && <span style={{ color: C.fg2, fontSize: 13 }}>{detail.goal}</span>}
        {detail && statusTag(detail.status)}
        {detail?.supervisor && <span style={{ color: C.magenta, fontSize: 12 }}>◆ {detail.supervisor}</span>}
        {detail && (
          <span style={{ color: C.fg2, fontSize: 12 }}>
            {detail.members.length} 成员 · <b style={{ color: C.green }}>{detail.members.filter((m) => m.status === 'running').length}</b> 活{detail.pending.length ? <> · <span style={{ color: C.amber }}>{detail.pending.length} 待解锁</span></> : null}
          </span>
        )}
        {detail && (
          <Space style={{ marginLeft: 'auto' }}>
            <Button size="small" type="primary" onClick={() => setAdding(true)}>+ 成员</Button>
            {detail.pending.length > 0 && <Button size="small" onClick={() => activate()}>解锁挂起</Button>}
            <Tooltip title="归档（杀会话，留数据）"><Button size="small" danger onClick={archive}>归档</Button></Tooltip>
          </Space>
        )}
      </div>

      {!detail ? <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}><Spin /></div> : narrow ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <Segmented block value={view} onChange={(v) => setView(v as any)} style={{ marginBottom: 10 }}
            options={[{ label: '拓扑', value: 'topo' }, { label: '看板', value: 'board' }, { label: '广场', value: 'plaza' }]} />
          <div style={{ flex: 1, minHeight: 0 }}>{view === 'topo' ? topo : view === 'board' ? board : plaza}</div>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 12, flex: '0 0 auto', minHeight: 300 }}>
            {topo}{plaza}
          </div>
          <div style={{ flex: 1, minHeight: 220 }}>{board}</div>
        </div>
      )}

      <NodeDrawer swarm={name} member={drawer} detail={detail} cards={cards} posts={posts} openTerm={openTerm} onClose={closeDrawer}
        onDone={markDone} onActivate={activate} />
      <AddMemberModal open={adding} name={name} members={detail?.members.map((m) => m.name) || []} onClose={() => setAdding(false)} onDone={reloadDetail} />
    </div>
  )
}

function AddMemberModal({ open, name, members, onClose, onDone }: { open: boolean; name: string; members: string[]; onClose: () => void; onDone: () => void }) {
  const { message } = AntApp.useApp()
  const [mname, setMname] = useState(''); const [task, setTask] = useState(''); const [type, setType] = useState('agent')
  const [deps, setDeps] = useState<string[]>([]); const [dir, setDir] = useState(''); const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setMname(''); setTask(''); setType('agent'); setDeps([]); setDir('') } }, [open])
  const ok = async () => {
    if (!mname.trim()) return message.error('需要成员名')
    if (!task.trim()) return message.error(type === 'agent' ? '需要任务描述' : '需要命令')
    setBusy(true)
    try {
      await api('POST', `/swarms/${encodeURIComponent(name)}/members`, { name: mname.trim(), type, task: task.trim(), deps: deps.join(','), dir: dir.trim() })
      message.success(deps.length ? `成员 ${mname} 已挂起（等依赖）` : `成员 ${mname} 已启动`)
      onClose(); onDone()
    } catch (e: any) { message.error(e.message) } finally { setBusy(false) }
  }
  return (
    <Modal open={open} onCancel={onClose} onOk={ok} okText="加成员" confirmLoading={busy} title="加成员（一个 cc 会话）" destroyOnClose>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Segmented block value={type} onChange={(v) => setType(v as string)}
          options={[{ label: '🤖 Agent (Claude)', value: 'agent' }, { label: '⌨️ 命令', value: 'task' }]} />
        <Input placeholder="成员名，如 api / ui" value={mname} onChange={(e) => setMname(e.target.value)} autoFocus />
        <Input.TextArea rows={2} placeholder={type === 'agent' ? '任务描述，如：实现登录 API（注册/登录/JWT）' : 'shell 命令'} value={task} onChange={(e) => setTask(e.target.value)} />
        {type === 'agent' && <Input placeholder="工作目录（可空）" value={dir} onChange={(e) => setDir(e.target.value)} />}
        <div>
          <div style={{ color: C.fg2, fontSize: 12, marginBottom: 4 }}>依赖成员（满足后才启动）</div>
          <Select mode="multiple" allowClear style={{ width: '100%' }} placeholder="选已有成员（可空）" value={deps} onChange={setDeps}
            options={members.filter((m) => m !== mname).map((m) => ({ value: m, label: m }))} />
        </div>
      </Space>
    </Modal>
  )
}

// 面板外壳
function Panel({ title, extra, children }: { title: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ background: C.bg2, border: `1px solid ${C.line2}`, borderRadius: 10, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderBottom: `1px solid ${C.line}`, fontSize: 13, color: C.fg2 }}>
        {title}{extra && <span style={{ marginLeft: 'auto' }}>{extra}</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{children}</div>
    </div>
  )
}

// ── 实时拓扑（自绘 SVG，分层 DAG） ──
function Topology({ detail, swarm, focus, onNode }: { detail: Detail | null; swarm: string; focus: string | null; onNode: (m: string) => void }) {
  const layout = useMemo(() => buildLayout(detail, swarm), [detail, swarm])
  return (
    <Panel title={<><span>拓扑 · 实时依赖图</span></>} extra={<span style={{ fontSize: 11, color: C.fg3 }}>点节点 → 进终端/联动</span>}>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 8 }}>
        {layout.nodes.length === 0 ? <Empty description="还没有成员（点右上「+ 成员」添加）" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : (
          <svg width="100%" viewBox={`0 0 ${layout.w} ${layout.h}`} preserveAspectRatio="xMidYMin meet" style={{ minHeight: 260 }}>
            <defs>
              <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill={C.green} /></marker>
            </defs>
            {layout.edges.map((e, i) => (
              <path key={i} d={e.d} fill="none" stroke={e.kind === 'cmd' ? C.fg2 : C.green} strokeWidth={e.kind === 'cmd' ? 1.2 : 1.7}
                strokeDasharray={e.kind === 'cmd' ? '4 4' : undefined} opacity={e.kind === 'cmd' ? 0.55 : 0.95} markerEnd={e.kind === 'dep' ? 'url(#arr)' : undefined} />
            ))}
            {layout.nodes.map((n) => {
              const col = nodeColor(n.kind)
              const dim = focus && focus !== n.name && n.role !== 'master'
              const running = n.kind === 'running'
              return (
                <g key={n.name} style={{ cursor: 'pointer', opacity: dim ? 0.35 : 1 }} onClick={() => onNode(n.name)}>
                  {running && <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={10} fill="none" stroke={col} strokeWidth={2}>
                    <animate attributeName="opacity" values="0.3;0.9;0.3" dur="1.8s" repeatCount="indefinite" /></rect>}
                  <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={10}
                    fill={col + (n.kind === 'done' ? '22' : '12')} stroke={col} strokeWidth={n.role === 'master' ? 1.6 : 1.4}
                    strokeDasharray={n.kind === 'pending' ? '6 4' : undefined} />
                  <text x={n.x + 14} y={n.y + 21} fontSize={12} fontWeight={600} fill={n.role === 'master' ? col : C.fg}>{nodeIcon(n)} {n.name}</text>
                  <text x={n.x + 14} y={n.y + 38} fontSize={11} fill={col}>{nodeSub(n)}</text>
                </g>
              )
            })}
          </svg>
        )}
      </div>
    </Panel>
  )
}

function nodeColor(kind: string) {
  return kind === 'running' || kind === 'done' ? C.green : kind === 'pending' ? C.amber : kind === 'failed' ? C.red : kind === 'master' ? C.magenta : C.fg2
}
function nodeIcon(n: any) {
  if (n.role === 'master') return '◆'
  if (n.kind === 'done') return '✔'
  if (n.kind === 'pending') return '⏳'
  if (n.kind === 'failed') return '✕'
  return '●'
}
function nodeSub(n: any) {
  if (n.role === 'master') return '指挥 · master'
  if (n.kind === 'pending') return `挂起 · 依赖→${n.deps || '?'}`
  if (n.kind === 'running') return 'running · agent'
  if (n.kind === 'done') return 'done'
  return 'exited'
}

// 分层布局：master 顶部；成员按 deps 深度分层
function buildLayout(detail: Detail | null, swarm: string) {
  const NW = 132, NH = 50, GX = 26, GY = 64, TOP = 12, MASTER_H = 46
  if (!detail) return { nodes: [], edges: [], w: 400, h: 280 }
  type N = { name: string; role: 'master' | 'member' | 'pending'; kind: string; deps: string; session: string; x: number; y: number; w: number; h: number }
  const members = detail.members.map((m) => ({
    name: m.name, role: 'member' as const, deps: m.deps, session: m.session,
    kind: m.done ? 'done' : m.status === 'running' ? 'running' : m.status === 'done' ? 'done' : 'exited',
  }))
  const pendings = detail.pending.map((p) => ({ name: p.name, role: 'pending' as const, deps: p.deps, session: `${swarm}-${p.name}`, kind: 'pending' }))
  const all = [...members, ...pendings]
  if (all.length === 0) return { nodes: [], edges: [], w: 400, h: 280 }
  const byName: Record<string, any> = {}; all.forEach((n) => (byName[n.name] = n))
  const memo: Record<string, number> = {}
  const depth = (name: string, seen = new Set<string>()): number => {
    if (name in memo) return memo[name]
    const n = byName[name]; if (!n || !n.deps || seen.has(name)) return 0
    seen.add(name)
    let d = 0
    n.deps.split(',').map((s: string) => s.trim()).filter(Boolean).forEach((dep: string) => { if (byName[dep]) d = Math.max(d, depth(dep, seen) + 1) })
    memo[name] = d; return d
  }
  const layers: Record<number, any[]> = {}
  all.forEach((n) => { const d = depth(n.name); (layers[d] = layers[d] || []).push(n) })
  const layerKeys = Object.keys(layers).map(Number).sort((a, b) => a - b)
  const maxRow = Math.max(1, ...layerKeys.map((k) => layers[k].length))
  const w = Math.max(NW + 40, maxRow * NW + (maxRow - 1) * GX + 24)
  const nodes: N[] = []
  // master 顶部居中
  const masterName = detail.supervisor || `cc-${swarm}`
  nodes.push({ name: masterName, role: 'master', kind: 'master', deps: '', session: detail.supervisor || `cc-${swarm}`, x: w / 2 - NW / 2, y: TOP, w: NW, h: MASTER_H })
  layerKeys.forEach((k, li) => {
    const row = layers[k]
    const rowW = row.length * NW + (row.length - 1) * GX
    const startX = (w - rowW) / 2
    const y = TOP + MASTER_H + GY * 0.5 + li * (NH + GY)
    row.forEach((n, i) => nodes.push({ ...n, x: startX + i * (NW + GX), y, w: NW, h: NH }))
  })
  const pos: Record<string, N> = {}; nodes.forEach((n) => (pos[n.name] = n))
  const edges: { d: string; kind: 'cmd' | 'dep' }[] = []
  const master = pos[masterName]
  // 指挥边：master → 第 0 层成员
  ;(layers[0] || []).forEach((n) => {
    const t = pos[n.name]
    edges.push({ kind: 'cmd', d: `M${master.x + NW / 2} ${master.y + MASTER_H} C${master.x + NW / 2} ${t.y - 30}, ${t.x + NW / 2} ${t.y - 30}, ${t.x + NW / 2} ${t.y}` })
  })
  // 依赖边：dep → member
  all.forEach((n) => {
    if (!n.deps) return
    n.deps.split(',').map((s: string) => s.trim()).filter(Boolean).forEach((dep: string) => {
      const a = pos[dep], b = pos[n.name]; if (!a || !b) return
      edges.push({ kind: 'dep', d: `M${a.x + NW / 2} ${a.y + a.h} C${a.x + NW / 2} ${a.y + a.h + 24}, ${b.x + NW / 2} ${b.y - 24}, ${b.x + NW / 2} ${b.y}` })
    })
  })
  const h = TOP + MASTER_H + GY * 0.5 + layerKeys.length * (NH + GY)
  return { nodes, edges, w, h: Math.max(h, 260) }
}

// ── 广场 ──
function Plaza({ name, posts, focus }: { name: string; posts: Post[]; focus: string | null }) {
  const { message } = AntApp.useApp()
  const [text, setText] = useState('')
  const [kind, setKind] = useState('note')
  const [sending, setSending] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)
  useEffect(() => { const el = feedRef.current; if (el) el.scrollTop = el.scrollHeight }, [posts.length])

  const send = async () => {
    if (!text.trim()) return
    setSending(true)
    try { await api('POST', `/swarms/${encodeURIComponent(name)}/say`, { kind, text: text.trim() }); setText('') }
    catch (e: any) { message.error(e.message) } finally { setSending(false) }
  }
  return (
    <Panel title="广场 · 协作墙" extra={<span style={{ fontSize: 11, color: C.fg3 }}>实时</span>}>
      <div ref={feedRef} style={{ flex: 1, overflow: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        {posts.length === 0 ? <Empty description="还没有消息" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : posts.map((p) => {
          const who = p.author === 'master' ? C.magenta : p.author === 'human' ? C.blue : C.green
          const dim = focus && focus !== p.author
          return (
            <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, opacity: dim ? 0.4 : 1 }}>
              <span style={{ color: C.fg3, fontSize: 11, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', paddingTop: 2 }}>#{p.id} {(p.ts || '').slice(11, 16)}</span>
              <span style={{ color: who, fontWeight: 600, whiteSpace: 'nowrap' }}>{p.author === 'master' ? '◆' : '●'} {p.author}</span>
              <span style={{ fontSize: 12 }}>{kindIcon(p.kind)}</span>
              <span style={{ color: C.fg }}>{p.text}</span>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '9px 12px', borderTop: `1px solid ${C.line}` }}>
        <Select size="small" value={kind} onChange={setKind} style={{ width: 96 }}
          options={['note', 'ask', 'decide', 'broadcast', 'block', 'done'].map((k) => ({ value: k, label: k }))} />
        <Input size="small" value={text} onChange={(e) => setText(e.target.value)} onPressEnter={send} placeholder="以 human 身份发言…" />
        <Button size="small" type="primary" loading={sending} onClick={send}>发言</Button>
      </div>
    </Panel>
  )
}
function kindIcon(k: string) {
  const m: Record<string, React.ReactNode> = {
    broadcast: '📢', done: <span style={{ color: C.green }}>✔</span>, ask: <span style={{ color: C.amber }}>?</span>,
    decide: <span style={{ color: C.cyan }}>◎</span>, block: <span style={{ color: C.red }}>!</span>,
  }
  return m[k] || <span style={{ color: C.fg3 }}>·</span>
}

// ── 看板（真拖拽） ──
function Board({ name, cards, focus, onCard, reload, setCards }: {
  name: string; cards: CardT[]; focus: string | null; onCard: (c: CardT) => void
  reload: () => void; setCards: React.Dispatch<React.SetStateAction<CardT[]>>
}) {
  const { message } = AntApp.useApp()
  const [adding, setAdding] = useState(false)
  const byCol = (c: Col) => cards.filter((k) => (k.col || 'backlog') === c)

  const onDragEnd = async (r: any) => {
    if (!r.destination) return
    const id = r.draggableId, to = r.destination.droppableId as Col
    const card = cards.find((k) => k.id === id); if (!card || card.col === to) return
    setCards((cs) => cs.map((k) => (k.id === id ? { ...k, col: to } : k)))  // 乐观
    try { await api('PATCH', `/swarms/${encodeURIComponent(name)}/task/${id}`, { move: to }) }
    catch (e: any) { message.error(e.message); reload() }
  }
  const del = async (id: string) => {
    try { await api('DELETE', `/swarms/${encodeURIComponent(name)}/task/${id}`); reload() } catch (e: any) { message.error(e.message) }
  }

  return (
    <Panel title="看板 · 拖拽流转" extra={<Button size="small" type="primary" ghost onClick={() => setAdding(true)}>+ 建卡</Button>}>
      <DragDropContext onDragEnd={onDragEnd}>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 10, padding: 10, overflowX: 'auto' }}>
          {COLS.map((c) => (
            <Droppable droppableId={c} key={c}>
              {(prov, snap) => (
                <div ref={prov.innerRef} {...prov.droppableProps}
                  style={{ flex: '0 0 184px', background: snap.isDraggingOver ? C.line : C.bg3, border: `1px solid ${C.line}`, borderRadius: 9, display: 'flex', flexDirection: 'column', minHeight: 150, transition: 'background .15s' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', fontSize: 12, color: COL_COLOR[c], borderBottom: `1px solid ${C.line}` }}>
                    {c} <span style={{ color: C.fg3 }}>{COL_LABEL[c]}</span>
                    <span style={{ marginLeft: 'auto', background: C.line2, borderRadius: 9, padding: '0 7px', fontSize: 11, color: C.fg2 }}>{byCol(c).length}</span>
                  </div>
                  <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                    {byCol(c).map((card, idx) => (
                      <Draggable draggableId={card.id} index={idx} key={card.id}>
                        {(dp, ds) => {
                          const dim = focus && card.assignee !== focus
                          return (
                            <div ref={dp.innerRef} {...dp.draggableProps} {...dp.dragHandleProps}
                              onClick={() => card.assignee && onCard(card)}
                              style={{ ...dp.draggableProps.style, background: C.bg2, border: `1px solid ${ds.isDragging ? C.blue : C.line2}`, borderRadius: 8, padding: 9, opacity: dim ? 0.4 : 1, boxShadow: ds.isDragging ? `0 4px 12px rgba(0,0,0,.4)` : 'none' }}>
                              <div style={{ fontSize: 13, marginBottom: 6, display: 'flex', gap: 6 }}>
                                <span style={{ color: C.fg3, fontSize: 11 }}>{card.id}</span>
                                <span style={{ flex: 1 }}>{card.title}</span>
                                <Popconfirm title="删卡？" onConfirm={() => del(card.id)}><a onClick={(e) => e.stopPropagation()} style={{ color: C.fg3 }}>×</a></Popconfirm>
                              </div>
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: C.fg2, fontSize: 11 }}>
                                {card.assignee && <span style={{ color: C.green }}>@{card.assignee}</span>}
                                {card.deps && <span style={{ color: C.fg3 }}>⛓ {card.deps}</span>}
                              </div>
                            </div>
                          )
                        }}
                      </Draggable>
                    ))}
                    {prov.placeholder}
                  </div>
                </div>
              )}
            </Droppable>
          ))}
        </div>
      </DragDropContext>
      <AddCardModal open={adding} name={name} onClose={() => setAdding(false)} onDone={reload} />
    </Panel>
  )
}

function AddCardModal({ open, name, onClose, onDone }: { open: boolean; name: string; onClose: () => void; onDone: () => void }) {
  const { message } = AntApp.useApp()
  const [title, setTitle] = useState(''); const [assignee, setAssignee] = useState(''); const [col, setCol] = useState<Col>('backlog')
  useEffect(() => { if (open) { setTitle(''); setAssignee(''); setCol('backlog') } }, [open])
  const ok = async () => {
    if (!title.trim()) return message.error('需要标题')
    try { await api('POST', `/swarms/${encodeURIComponent(name)}/task`, { title: title.trim(), assignee: assignee.trim(), col }); onClose(); onDone() }
    catch (e: any) { message.error(e.message) }
  }
  return (
    <Modal open={open} onCancel={onClose} onOk={ok} okText="建卡" title="新建卡片" destroyOnClose>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Input placeholder="卡片标题" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus onPressEnter={ok} />
        <Input placeholder="负责成员（可空）" value={assignee} onChange={(e) => setAssignee(e.target.value)} />
        <Select value={col} onChange={(v) => setCol(v as Col)} style={{ width: '100%' }}
          options={COLS.map((c) => ({ value: c, label: `${c} (${COL_LABEL[c]})` }))} />
      </Space>
    </Modal>
  )
}

// ── 节点详情抽屉（每个 cc 的身份 + 终端快照 + 卡 + 发言） ──
function NodeDrawer({ swarm, member, detail, cards, posts, openTerm, onClose, onDone, onActivate }: {
  swarm: string; member: string | null; detail: Detail | null; cards: CardT[]; posts: Post[]
  openTerm: (n: string) => void; onClose: () => void
  onDone: (m?: string) => void; onActivate: (m?: string, force?: boolean) => void
}) {
  const [snap, setSnap] = useState('')
  const isMaster = !!detail && (member === detail.supervisor)
  const m = detail?.members.find((x) => x.name === member)
  const pend = detail?.pending.find((x) => x.name === member)
  const session = isMaster ? (detail?.supervisor || `cc-${swarm}`) : m?.session || `${swarm}-${member}`

  useEffect(() => {
    if (!member) { setSnap(''); return }
    let stop = false
    setSnap('加载中…')
    api('GET', `/sessions/${encodeURIComponent(session)}/capture?lines=40`)
      .then((r) => { if (!stop) setSnap((r.data || '').trim() || '(空)') })
      .catch(() => { if (!stop) setSnap('(会话未运行)') })
    return () => { stop = true }
  }, [member, session])

  const myCards = cards.filter((c) => c.assignee === member)
  const myPosts = posts.filter((p) => p.author === member)
  const color = isMaster ? C.magenta : pend ? C.amber : m?.done ? C.green : m?.status === 'running' ? C.green : C.fg2

  return (
    <Drawer open={!!member} onClose={onClose} width={400} title={
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <i style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
        <b>{member}</b>
        {isMaster ? <Tag color="purple">master</Tag> : pend ? <Tag color="warning">挂起</Tag> : <Tag color={m?.status === 'running' ? 'processing' : 'default'}>{m?.done ? 'done' : m?.status}</Tag>}
      </span>
    }>
      {member && (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div>
            <div style={{ color: C.fg2, fontSize: 12, marginBottom: 4 }}>身份</div>
            <div style={{ fontSize: 13 }}>{isMaster ? 'master · 指挥' : `${m?.type || 'agent'} · 成员`} · 会话 <b>{session}</b></div>
            {(m?.task || (isMaster && detail?.goal)) && <div style={{ fontSize: 13, color: C.fg2, marginTop: 6 }}>{isMaster ? `目标：${detail?.goal}` : m?.task}</div>}
            {(m?.deps || pend?.deps) && <div style={{ fontSize: 12, color: C.fg3, marginTop: 4 }}>依赖→ {m?.deps || pend?.deps}</div>}
            {!isMaster && (
              <Space wrap style={{ marginTop: 10 }}>
                {pend ? (
                  <>
                    <Button size="small" onClick={() => { onActivate(member!); onClose() }}>解锁（依赖满足）</Button>
                    <Popconfirm title="无视依赖强制解锁？" onConfirm={() => { onActivate(member!, true); onClose() }}><Button size="small" danger>强制解锁</Button></Popconfirm>
                  </>
                ) : !m?.done ? (
                  <Popconfirm title={`标记 ${member} 完成？会解锁其下游成员`} onConfirm={() => { onDone(member!); onClose() }}>
                    <Button size="small">标记完成</Button>
                  </Popconfirm>
                ) : <Tag color="success">✔ 已完成</Tag>}
              </Space>
            )}
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ color: C.fg2, fontSize: 12 }}>终端快照</span>
              <Button size="small" type="primary" style={{ marginLeft: 'auto' }} onClick={() => { openTerm(session); onClose() }}>进入终端 ↗</Button>
            </div>
            <pre style={{ background: C.bg3, border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, fontSize: 12, lineHeight: 1.5, color: '#c9d1d9', whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto', margin: 0 }}>{snap}</pre>
          </div>
          <div>
            <div style={{ color: C.fg2, fontSize: 12, marginBottom: 6 }}>它的看板卡 ({myCards.length})</div>
            {myCards.length ? myCards.map((c) => (
              <div key={c.id} style={{ background: C.bg3, border: `1px solid ${C.line}`, borderRadius: 7, padding: '7px 9px', marginBottom: 6, fontSize: 13 }}>
                <span style={{ color: C.fg3, fontSize: 11 }}>{c.id}</span> {c.title} <span style={{ color: COL_COLOR[(c.col as Col)] || C.fg2 }}>[{c.col}]</span>
              </div>
            )) : <div style={{ color: C.fg3, fontSize: 12 }}>（暂无）</div>}
          </div>
          <div>
            <div style={{ color: C.fg2, fontSize: 12, marginBottom: 6 }}>它的广场发言 ({myPosts.length})</div>
            {myPosts.length ? myPosts.slice(-6).map((p) => (
              <div key={p.id} style={{ fontSize: 13, marginBottom: 5 }}>{kindIcon(p.kind)} <span style={{ color: C.fg }}>{p.text}</span></div>
            )) : <div style={{ color: C.fg3, fontSize: 12 }}>（暂无）</div>}
          </div>
        </Space>
      )}
    </Drawer>
  )
}
