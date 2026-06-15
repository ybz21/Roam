// ttmux Web 控制台 — React + Vite + Antd（统一深色主题）
// 布局（见 docs/web/01-overview.md）：
//   电脑 ≥1200 → 三栏：导航 Sider | 列表(页面) | 终端面板(常驻, 多标签)
//   平板/手机   → 终端为全屏覆盖层；手机底部 Tab 导航
// 终端：多标签 / 字号调节 / 复制 / 更多快捷键 / 断线自动重连。
import { useEffect, useRef, useState } from 'react'
import {
  Layout, Menu, Button, Card, List, Tag, Form, Input, Select, Segmented,
  Statistic, Row, Col, Space, Popconfirm, Empty, Modal, Grid, App as AntApp, Typography, Spin, Tooltip,
} from 'antd'
import { api, setUnauthorizedHandler } from './api'
import Term, { TermHandle, TermStatus } from './Terminal'

const { Sider, Content } = Layout
const { useBreakpoint } = Grid
const { Text } = Typography

const NAV = [
  { key: 'overview', label: '概览' },
  { key: 'sessions', label: '会话' },
  { key: 'tasks', label: '任务' },
  { key: 'env', label: '环境变量' },
]

// 线性图标（无 emoji，currentColor 描边）
const svg = (paths: any) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths}</svg>
)
const ICONS: Record<string, any> = {
  overview: svg(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>),
  sessions: svg(<><polyline points="5 8 9 12 5 16" /><line x1="12" y1="16" x2="18" y2="16" /></>),
  tasks: svg(<><line x1="9" y1="6" x2="20" y2="6" /><line x1="9" y1="12" x2="20" y2="12" /><line x1="9" y1="18" x2="20" y2="18" /><circle cx="4.5" cy="6" r="1.1" /><circle cx="4.5" cy="12" r="1.1" /><circle cx="4.5" cy="18" r="1.1" /></>),
  env: svg(<><line x1="4" y1="7" x2="20" y2="7" /><circle cx="9" cy="7" r="2.3" /><line x1="4" y1="17" x2="20" y2="17" /><circle cx="15" cy="17" r="2.3" /></>),
}


const KEYS: [string, string][] = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'],
  ['^C', '\x03'], ['^D', '\x04'], ['Space', ' '], ['y', 'y'], ['n', 'n'], ['/', '/'], ['q', 'q'],
]

function StatusTag({ status, code }: { status?: string; code?: string }) {
  if (status === 'running') return <Tag color="processing">运行中</Tag>
  if (status === 'done') return code && code !== '0' ? <Tag color="error">失败 {code}</Tag> : <Tag color="success">完成</Tag>
  return <Tag>已结束</Tag>
}
function TypeTag({ type }: { type?: string }) {
  return type === 'agent' ? <Tag color="purple">🤖 Agent</Tag> : <Tag>⌨️ 命令</Tag>
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [kanna, setKanna] = useState('')
  const [tab, setTab] = useState('sessions')
  const [collapsed, setCollapsed] = useState(false)
  const screens = useBreakpoint()
  const isDesktop = !!screens.xl
  const hasSider = !!screens.md
  const isMobile = !screens.md

  // 多终端状态
  const [terms, setTerms] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [overlay, setOverlay] = useState(false) // 手机/平板全屏终端
  const [fontSize, setFontSize] = useState(13)
  const termNarrow = isDesktop && terms.length > 0 // 终端打开后列表栏收窄
  const [statusMap, setStatusMap] = useState<Record<string, TermStatus>>({})
  const termRefs = useRef<Record<string, TermHandle | null>>({})

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false))
    api('GET', '/me').then((r) => { setAuthed(true); setKanna(r?.data?.kanna || '') }).catch(() => setAuthed(false))
  }, [])

  if (authed === null) return <div style={{ height: '100vh', display: 'grid', placeItems: 'center' }}><Spin size="large" /></div>
  if (!authed) return <Login onOk={() => { setAuthed(true); setTab('overview') }} />

  const openTerm = (name: string) => {
    setTerms((ts) => (ts.includes(name) ? ts : [...ts, name]))
    setActive(name)
    if (!isDesktop) setOverlay(true)
  }
  const closeTerm = (name: string) => {
    setTerms((ts) => {
      const next = ts.filter((t) => t !== name)
      setActive((a) => (a === name ? (next[next.length - 1] || null) : a))
      if (next.length === 0) setOverlay(false)
      return next
    })
    delete termRefs.current[name]
  }
  const setStatus = (name: string, s: TermStatus) => setStatusMap((m) => ({ ...m, [name]: s }))
  const sendKey = (seq: string) => active && termRefs.current[active]?.send(seq)

  const termPane = (
    <TerminalPane
      terms={terms} active={active} setActive={setActive} closeTerm={closeTerm}
      fontSize={fontSize} setFontSize={setFontSize} statusMap={statusMap} setStatus={setStatus}
      termRefs={termRefs} sendKey={sendKey}
      onCollapse={!isDesktop ? () => setOverlay(false) : undefined}
    />
  )

  const pages: any = {
    overview: <Overview goTask={() => setTab('tasks')} openTerm={openTerm} />,
    tasks: <Tasks openTerm={openTerm} kanna={kanna} />,
    sessions: <Sessions openTerm={openTerm} />,
    env: <EnvPage />,
  }

  const menu = (
    <Menu
      theme="dark" mode="inline" selectedKeys={[tab]} onClick={(e) => setTab(e.key)}
      items={NAV.map((n) => ({ key: n.key, icon: ICONS[n.key], label: n.label }))}
      style={{ borderInlineEnd: 0, background: 'transparent' }}
    />
  )

  return (
    <Layout style={{ minHeight: '100vh', background: '#0d1117' }}>
      {hasSider && (
        <Sider collapsible trigger={null} collapsed={collapsed} collapsedWidth={64}
          breakpoint="lg" onBreakpoint={(b) => setCollapsed(b)} width={208} theme="dark"
          style={{ position: 'sticky', top: 0, height: '100vh', background: '#0d1117', borderRight: '1px solid #21262d' }}>
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: collapsed ? '18px 0 16px' : '18px 18px 16px', justifyContent: collapsed ? 'center' : 'flex-start' }}>
              <span style={{
                width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', flex: '0 0 auto',
                background: 'linear-gradient(145deg,#f2f4f7 0%,#b9c0c9 38%,#838b95 62%,#cdd3da 100%)',
                boxShadow: 'inset 0 1px 1px rgba(255,255,255,.7), inset 0 -2px 3px rgba(0,0,0,.45), 0 1px 3px rgba(0,0,0,.5)',
                color: '#2b3138', fontWeight: 900, fontSize: 17,
              }}>▸</span>
              {!collapsed && (
                <div style={{ lineHeight: 1.15 }}>
                  <div style={{
                    fontWeight: 800, fontSize: 19, letterSpacing: 0.5,
                    background: 'linear-gradient(180deg,#f5f7fa 0%,#c3c9d1 46%,#9aa1ab 56%,#e7ebef 100%)',
                    WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent',
                  }}>ttmux</div>
                  <div style={{ color: '#6e7681', fontSize: 11, letterSpacing: 2 }}>CONSOLE</div>
                </div>
              )}
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>{menu}</div>
            {/* 底部：折叠 + 退出（无顶部栏） */}
            <div style={{ borderTop: '1px solid #21262d', padding: 8, display: 'flex', flexDirection: collapsed ? 'column' : 'row', gap: 6, alignItems: 'center' }}>
              <Button type="text" onClick={() => setCollapsed((c) => !c)} style={{ color: '#8b949e' }}
                title={collapsed ? '展开' : '折叠'}>
                {svg(collapsed
                  ? <><polyline points="9 6 15 12 9 18" /></>
                  : <><polyline points="15 6 9 12 15 18" /></>)}
              </Button>
              <Button type="text" onClick={logout} style={{ color: '#8b949e', flex: collapsed ? undefined : 1, textAlign: 'left' }}>
                {collapsed ? svg(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>) : '退出登录'}
              </Button>
            </div>
          </div>
        </Sider>
      )}

      <Layout style={{ background: '#0d1117' }}>
        <div style={{ flex: 1, display: 'flex', minHeight: 0, height: '100vh', background: '#0d1117' }}>
          {/* 开了终端后，列表栏收窄给终端让位 */}
          <Content style={{
            flex: termNarrow ? '0 0 320px' : 1, width: termNarrow ? 320 : 'auto',
            overflow: 'auto', padding: 14, paddingBottom: isMobile ? 76 : 14, transition: 'flex-basis .2s',
          }}>
            {pages[tab]}
          </Content>
          {isDesktop && (
            <div style={{ flex: termNarrow ? 1 : '0 0 48%', minWidth: 420, borderLeft: '1px solid #30363d', display: 'flex', flexDirection: 'column', background: '#06090d' }}>
              {termPane}
            </div>
          )}
        </div>
      </Layout>

      {isMobile && (
        <nav style={{ position: 'fixed', bottom: 0, left: 0, right: 0, display: 'flex', background: '#161b22', borderTop: '1px solid #30363d', zIndex: 50, paddingBottom: 'env(safe-area-inset-bottom)' }}>
          {NAV.map((n) => (
            <button key={n.key} onClick={() => setTab(n.key)}
              style={{ flex: 1, border: 0, background: 'none', color: tab === n.key ? '#58a6ff' : '#8b949e', padding: '8px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, fontSize: 11 }}>
              {ICONS[n.key]}{n.label}
            </button>
          ))}
          <button onClick={logout}
            style={{ flex: 1, border: 0, background: 'none', color: '#8b949e', padding: '8px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, fontSize: 11 }}>
            {svg(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>)}退出
          </button>
        </nav>
      )}

      {/* 手机/平板：全屏终端覆盖层 */}
      {!isDesktop && overlay && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#06090d', display: 'flex', flexDirection: 'column' }}>
          {termPane}
        </div>
      )}
    </Layout>
  )

  function logout() {
    api('POST', '/logout').catch(() => {}).finally(() => setAuthed(false))
  }
}

// ── 终端面板（多标签 + 工具栏 + 快捷键栏），桌面右栏与手机覆盖层共用 ──
function TerminalPane(props: {
  terms: string[]; active: string | null; setActive: (n: string) => void; closeTerm: (n: string) => void
  fontSize: number; setFontSize: (n: number) => void
  statusMap: Record<string, TermStatus>; setStatus: (n: string, s: TermStatus) => void
  termRefs: React.MutableRefObject<Record<string, TermHandle | null>>
  sendKey: (seq: string) => void; onCollapse?: () => void
}) {
  const { terms, active, setActive, closeTerm, fontSize, setFontSize, statusMap, setStatus, termRefs, sendKey, onCollapse } = props
  const { message } = AntApp.useApp()
  const st = active ? statusMap[active] : undefined
  const dot = st === 'connected' ? '#3fb950' : st === 'connecting' ? '#d29922' : '#f85149'

  if (terms.length === 0) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: '#8b949e' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 40 }}>▸</div>
          <div>点击「会话」或「任务」里的 <b style={{ color: '#e6edf3' }}>终端</b> 进入命令行</div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* 标签栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', borderBottom: '1px solid #30363d', overflowX: 'auto' }}>
        {onCollapse && <Button size="small" type="text" style={{ color: '#8b949e' }} onClick={onCollapse}>✕ 收起</Button>}
        {terms.map((t) => (
          <span key={t} onClick={() => setActive(t)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap',
              background: t === active ? '#1f6feb33' : 'transparent', border: t === active ? '1px solid #1f6feb' : '1px solid #30363d', color: '#e6edf3',
            }}>
            <i style={{ width: 7, height: 7, borderRadius: '50%', background: (statusMap[t] === 'connected' ? '#3fb950' : statusMap[t] === 'connecting' ? '#d29922' : '#f85149') }} />
            {t}
            <a onClick={(e) => { e.stopPropagation(); closeTerm(t) }} style={{ color: '#8b949e' }}>×</a>
          </span>
        ))}
      </div>

      {/* 工具栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderBottom: '1px solid #21262d' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#8b949e', fontSize: 12 }}>
          <i style={{ width: 8, height: 8, borderRadius: '50%', background: dot }} />
          {st === 'connected' ? '已连接' : st === 'connecting' ? '连接中' : '已断开'}
        </span>
        <span style={{ flex: 1 }} />
        <Tooltip title="上翻看历史对话"><Button size="small" onClick={() => active && termRefs.current[active]?.scroll(-12)}>▲</Button></Tooltip>
        <Tooltip title="回到最新"><Button size="small" onClick={() => active && termRefs.current[active]?.toBottom()}>▼底</Button></Tooltip>
        <Tooltip title="缩小字号"><Button size="small" onClick={() => setFontSize(Math.max(10, fontSize - 1))}>A-</Button></Tooltip>
        <Tooltip title="放大字号"><Button size="small" onClick={() => setFontSize(Math.min(22, fontSize + 1))}>A+</Button></Tooltip>
        <Tooltip title="复制选中"><Button size="small" onClick={() => { const ok = active && termRefs.current[active]?.copy(); message[ok ? 'success' : 'info'](ok ? '已复制' : '请先选中文本') }}>复制</Button></Tooltip>
        <Tooltip title="重新连接"><Button size="small" onClick={() => active && termRefs.current[active]?.reconnect()}>重连</Button></Tooltip>
      </div>

      {/* 终端区（所有标签常驻，仅激活可见，保留滚动历史） */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {terms.map((t) => (
          <div key={t} style={{ position: 'absolute', inset: 0, display: t === active ? 'block' : 'none', padding: 6 }}>
            <Term ref={(h) => { termRefs.current[t] = h }} name={t} fontSize={fontSize} active={t === active} onStatus={(s) => setStatus(t, s)} />
          </div>
        ))}
      </div>

      {/* 快捷键栏 */}
      <div style={{ display: 'flex', gap: 6, padding: 8, borderTop: '1px solid #30363d', overflowX: 'auto' }}>
        <Button type="primary" onClick={() => sendKey('\r')}>Enter</Button>
        {KEYS.map(([label, seq]) => (
          <Button key={label} onClick={() => sendKey(seq)} style={{ flex: '0 0 auto' }}>{label}</Button>
        ))}
      </div>
    </div>
  )
}

// ── 登录 ──
function Login({ onOk }: { onOk: () => void }) {
  const { message } = AntApp.useApp()
  const [loading, setLoading] = useState(false)
  return (
    <div style={{ height: '100vh', display: 'grid', placeItems: 'center', padding: 16, background: '#0d1117' }}>
      <Card style={{ width: 'min(360px,92vw)' }}>
        <div style={{ textAlign: 'center', fontSize: 22, fontWeight: 700, marginBottom: 16 }}>ttmux 控制台</div>
        <Form onFinish={async (v) => {
          setLoading(true)
          try { await api('POST', '/login', { password: v.password }); onOk() }
          catch { message.error('登录失败') } finally { setLoading(false) }
        }}>
          <Form.Item name="password" rules={[{ required: true, message: '请输入口令' }]}>
            <Input.Password size="large" placeholder="口令" autoFocus />
          </Form.Item>
          <Button type="primary" size="large" block htmlType="submit" loading={loading}>登 录</Button>
        </Form>
      </Card>
    </div>
  )
}

// ── 概览 ──
function Overview({ goTask, openTerm }: { goTask: () => void; openTerm: (n: string) => void }) {
  const [info, setInfo] = useState<any>(null)
  const [groups, setGroups] = useState<any[]>([])
  const [spawn, setSpawn] = useState(false)
  const load = () => {
    api('GET', '/info').then(setInfo).catch(() => {})
    api('GET', '/tasks').then(setGroups).catch(() => {})
  }
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t) }, [])
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Row gutter={[12, 12]}>
        {[['会话', info?.sessions], ['任务组', info?.groups], ['ttmux', info?.version], ['tmux', info?.tmux_version]].map(([t, v]) => (
          <Col xs={12} sm={6} key={t as string}><Card size="small"><Statistic title={t as string} value={v ?? '—'} /></Card></Col>
        ))}
      </Row>
      <Card title="任务组" extra={<Button type="primary" onClick={() => setSpawn(true)}>+ 创建任务</Button>}>
        {groups.length === 0 ? <Empty description="暂无任务组" /> : (
          <List dataSource={groups} renderItem={(g: any) => (
            <List.Item actions={[<a key="o" onClick={goTask}>查看</a>]}>
              <List.Item.Meta title={g.group} description={`${g.total} 个任务 · 存活 ${g.alive}`} />
              <StatusTag status={g.alive > 0 ? 'running' : 'done'} />
            </List.Item>
          )} />
        )}
      </Card>
      <SpawnModal open={spawn} onClose={() => setSpawn(false)} onDone={load} />
    </Space>
  )
}

// ── 任务（命令 + Agent 统一） ──
function Tasks({ openTerm, kanna }: { openTerm: (n: string) => void; kanna?: string }) {
  const [groups, setGroups] = useState<any[]>([])
  const [detail, setDetail] = useState<Record<string, any>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [spawn, setSpawn] = useState(false)
  const [send, setSend] = useState<any[] | null>(null)
  const [collect, setCollect] = useState<string | null>(null)
  const { message } = AntApp.useApp()

  const loadGroups = () => api('GET', '/tasks').then(setGroups).catch(() => {})
  const loadDetail = (g: string) => api('GET', '/tasks/' + encodeURIComponent(g)).then((d) => setDetail((s) => ({ ...s, [g]: d }))).catch(() => {})
  useEffect(() => { loadGroups() }, [])
  useEffect(() => {
    if (!open) return
    loadDetail(open)
    const t = setInterval(() => loadDetail(open), 3000)
    return () => clearInterval(t)
  }, [open])

  const kill = async (g: string) => {
    try { await api('DELETE', '/tasks/' + encodeURIComponent(g)); message.success('已清理'); setOpen(null); loadGroups() }
    catch (e: any) { message.error(e.message) }
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <div><Button type="primary" onClick={() => setSpawn(true)}>+ 创建任务</Button></div>
      {groups.length === 0 && <Empty description="暂无任务组" />}
      {groups.map((g: any) => (
        <Card key={g.group} size="small"
          title={<span onClick={() => setOpen(open === g.group ? null : g.group)} style={{ cursor: 'pointer' }}>
            {g.group} <Text type="secondary" style={{ fontSize: 13 }}>{g.alive}/{g.total} 存活</Text></span>}
          extra={<Popconfirm title={`清理 ${g.group}？`} onConfirm={() => kill(g.group)}><Button danger size="small">清理</Button></Popconfirm>}
        >
          {open === g.group && (
            <>
              <List size="small" dataSource={detail[g.group]?.tasks || []} locale={{ emptyText: '加载中…' }}
                renderItem={(t: any) => (
                  <List.Item actions={[
                    <a key="t" onClick={() => openTerm(t.name)}>终端</a>,
                    ...(kanna && t.type === 'agent'
                      ? [<a key="k" href={kanna} target="_blank" rel="noreferrer">Kanna ↗</a>]
                      : []),
                  ]}>
                    <List.Item.Meta
                      title={<Space><span>{t.name}</span><TypeTag type={t.type} /><StatusTag status={t.status} code={t.exit_code} /></Space>}
                      description={t.task ? <Text type="secondary" style={{ fontSize: 12 }}>{t.task}</Text> : null}
                    />
                  </List.Item>
                )} />
              <Space style={{ marginTop: 10 }}>
                <Button size="small" onClick={() => setCollect(g.group)}>收集输出</Button>
                <Button size="small" onClick={() => setSend(detail[g.group]?.tasks || [])}>追加指令</Button>
              </Space>
            </>
          )}
        </Card>
      ))}
      <SpawnModal open={spawn} onClose={() => setSpawn(false)} onDone={loadGroups} />
      <SendModal tasks={send} onClose={() => setSend(null)} />
      <CollectModal group={collect} onClose={() => setCollect(null)} />
    </Space>
  )
}

// ── 服务器目录选择器 ──
function DirPicker({ open, start, onPick, onClose }: { open: boolean; start?: string; onPick: (p: string) => void; onClose: () => void }) {
  const [data, setData] = useState<any>({ path: '', parent: '', dirs: [] })
  const { message } = AntApp.useApp()
  const load = (p?: string) => api('GET', '/fs' + (p !== undefined ? '?path=' + encodeURIComponent(p) : '')).then((r) => setData(r.data)).catch((e) => message.error(e.message))
  useEffect(() => { if (open) load(start || undefined) }, [open])
  const enter = (d: string) => load((data.path === '/' ? '' : data.path) + '/' + d)
  return (
    <Modal open={open} onCancel={onClose} title="选择工作目录" zIndex={1100}
      footer={[<Button key="c" onClick={onClose}>取消</Button>, <Button key="o" type="primary" onClick={() => onPick(data.path)}>选择此目录</Button>]}>
      <div style={{ fontFamily: 'monospace', color: '#8b949e', marginBottom: 8, wordBreak: 'break-all' }}>{data.path || '…'}</div>
      <List size="small" style={{ maxHeight: '50vh', overflow: 'auto' }}
        dataSource={['..', ...(data.dirs || [])]}
        renderItem={(d: string) => (
          <List.Item style={{ cursor: 'pointer' }} onClick={() => (d === '..' ? load(data.parent) : enter(d))}>
            <span style={{ color: d === '..' ? '#8b949e' : '#e6edf3' }}>{d === '..' ? '↑ 上级目录' : '▸ ' + d}</span>
          </List.Item>
        )} />
    </Modal>
  )
}

// ── 新建会话（可选工作目录） ──
function NewSessionModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState('')
  const [dir, setDir] = useState('')
  const [pick, setPick] = useState(false)
  const { message } = AntApp.useApp()
  useEffect(() => { if (open) { setName(''); setDir('') } }, [open])
  const ok = async () => {
    if (!name.trim()) return message.error('请输入名称')
    try { await api('POST', '/sessions', { name: name.trim(), dir: dir.trim() }); message.success('已创建'); onClose(); onDone(name.trim()) }
    catch (e: any) { message.error(e.message) }
  }
  return (
    <>
      <Modal open={open} onCancel={onClose} onOk={ok} okText="创建" title="新建会话" destroyOnClose>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input placeholder="会话名称，如 work" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <Space.Compact style={{ width: '100%' }}>
            <Input placeholder="工作目录（可空，默认家目录）" value={dir} onChange={(e) => setDir(e.target.value)} />
            <Button onClick={() => setPick(true)}>浏览…</Button>
          </Space.Compact>
        </Space>
      </Modal>
      <DirPicker open={pick} start={dir || undefined} onPick={(p) => { setDir(p); setPick(false) }} onClose={() => setPick(false)} />
    </>
  )
}

// ── 会话（可新建/指定目录 / 进终端 / 关闭） ──
function Sessions({ openTerm }: { openTerm: (n: string) => void }) {
  const [list, setList] = useState<any[]>([])
  const [newOpen, setNewOpen] = useState(false)
  const { message } = AntApp.useApp()
  const load = () => api('GET', '/sessions').then(setList).catch(() => {})
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t) }, [])
  const kill = async (n: string) => { try { await api('DELETE', '/sessions/' + encodeURIComponent(n)); message.success('已关闭'); load() } catch (e: any) { message.error(e.message) } }
  return (
    <Card title="会话" extra={<Button type="primary" onClick={() => setNewOpen(true)}>+ 新建会话</Button>}>
      {list.length === 0 ? <Empty description="无活跃会话" /> : (
        <List dataSource={list} renderItem={(s: any) => (
          <List.Item actions={[
            <a key="t" onClick={() => openTerm(s.name)}>终端</a>,
            <Popconfirm key="k" title={`关闭 ${s.name}？`} onConfirm={() => kill(s.name)}><a style={{ color: '#f85149' }}>关闭</a></Popconfirm>,
          ]}>
            <List.Item.Meta title={s.name} description={`${s.windows} 窗口 · ${s.attached == 1 ? '已连接' : '空闲'}`} />
          </List.Item>
        )} />
      )}
      <NewSessionModal open={newOpen} onClose={() => setNewOpen(false)} onDone={(name) => { load(); openTerm(name) }} />
    </Card>
  )
}

// ── Env ──
function EnvPage() {
  const [list, setList] = useState<any[]>([])
  const { message, modal } = AntApp.useApp()
  const load = () => api('GET', '/env').then(setList).catch(() => {})
  useEffect(() => { load() }, [])
  const add = () => {
    let key = '', value = ''
    modal.confirm({
      title: '添加环境变量',
      content: (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input placeholder="KEY" onChange={(e) => (key = e.target.value)} />
          <Input placeholder="VALUE" onChange={(e) => (value = e.target.value)} />
        </Space>
      ),
      okText: '设置',
      onOk: async () => {
        if (!key.trim()) { message.error('需要 KEY'); throw new Error('empty') }
        await api('PUT', '/env', { key: key.trim(), value }); message.success('已设置'); load()
      },
    })
  }
  return (
    <Card title="全局环境变量" extra={<Space>
      <Button onClick={add}>+ 添加</Button>
      <Button onClick={async () => { try { await api('POST', '/env/push'); message.success('已推送') } catch (e: any) { message.error(e.message) } }}>推送到会话</Button>
    </Space>}>
      {list.length === 0 ? <Empty description="无环境变量" /> : (
        <List dataSource={list} renderItem={(kv: any) => (
          <List.Item actions={[<Popconfirm key="d" title="删除？" onConfirm={async () => { try { await api('DELETE', '/env/' + encodeURIComponent(kv.key)); message.success('已删除'); load() } catch (e: any) { message.error(e.message) } }}><a style={{ color: '#f85149' }}>删除</a></Popconfirm>]}>
            <List.Item.Meta title={<code>{kv.key}</code>} description={<code style={{ color: '#8b949e' }}>{kv.value}</code>} />
          </List.Item>
        )} />
      )}
    </Card>
  )
}

// ── 创建任务（命令 / Agent） ──
function SpawnModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [form] = Form.useForm()
  const [type, setType] = useState('cmd')
  const [pickDir, setPickDir] = useState(false)
  const { message } = AntApp.useApp()
  const submit = async () => {
    const v = await form.validateFields()
    const tasks = (v.tasks || []).filter((t: any) => t?.name && t?.payload)
      .map((t: any) => (type === 'agent' ? { name: t.name, task: t.payload } : { name: t.name, cmd: t.payload }))
    if (!tasks.length) return message.error('至少一个任务')
    const body: any = { group: v.group, type, tasks }
    if (type === 'agent') { body.dir = v.dir; body.perm = v.perm; body.model = v.model }
    try { await api('POST', '/tasks', body); message.success('已创建'); onClose(); onDone() }
    catch (e: any) { message.error(e.message) }
  }
  return (
    <>
      <Modal open={open} onCancel={onClose} onOk={submit} okText="创建" title="创建任务" destroyOnClose>
        <Segmented block value={type} onChange={(v) => setType(v as string)}
          options={[{ label: '命令', value: 'cmd' }, { label: 'Agent', value: 'agent' }]} style={{ marginBottom: 12 }} />
        <Form form={form} layout="vertical" preserve={false} initialValues={{ tasks: [{}, {}], perm: 'auto' }}>
          <Form.Item name="group" label="任务组名称" rules={[{ required: true }]}><Input placeholder="如 build / refactor" /></Form.Item>
          <Form.List name="tasks">
            {(fields, { add, remove }) => (
              <>
                {fields.map((f) => (
                  <Space key={f.key} align="baseline" style={{ display: 'flex', marginBottom: 8 }}>
                    <Form.Item {...f} name={[f.name, 'name']} noStyle><Input placeholder="名称" style={{ width: 110 }} /></Form.Item>
                    <Form.Item {...f} name={[f.name, 'payload']} noStyle><Input placeholder={type === 'agent' ? '任务描述' : '命令'} style={{ width: 240 }} /></Form.Item>
                    <a onClick={() => remove(f.name)} style={{ color: '#f85149' }}>×</a>
                  </Space>
                ))}
                <Button type="dashed" onClick={() => add()} block>+ 加一行</Button>
              </>
            )}
          </Form.List>
          {type === 'agent' && (
            <div style={{ marginTop: 12 }}>
              <Form.Item label="工作目录 (--dir)">
                <Space.Compact style={{ width: '100%' }}>
                  <Form.Item name="dir" noStyle><Input placeholder="如 ~/project" /></Form.Item>
                  <Button onClick={() => setPickDir(true)}>浏览…</Button>
                </Space.Compact>
              </Form.Item>
              <Space>
                <Form.Item name="perm" label="权限"><Input placeholder="auto/plan/default" /></Form.Item>
                <Form.Item name="model" label="模型"><Input placeholder="可空" /></Form.Item>
              </Space>
            </div>
          )}
        </Form>
      </Modal>
      <DirPicker open={pickDir} start={form.getFieldValue('dir') || undefined}
        onPick={(p) => { form.setFieldValue('dir', p); setPickDir(false) }} onClose={() => setPickDir(false)} />
    </>
  )
}

function SendModal({ tasks, onClose }: { tasks: any[] | null; onClose: () => void }) {
  const [sess, setSess] = useState<string>()
  const [msg, setMsg] = useState('')
  const { message } = AntApp.useApp()
  useEffect(() => { if (tasks?.length) setSess(tasks[0].name) }, [tasks])
  const go = async () => {
    if (!sess || !msg) return
    try { await api('POST', '/tasks/_/send', { sess, msg }); message.success('已发送'); onClose() } catch (e: any) { message.error(e.message) }
  }
  return (
    <Modal open={!!tasks} onCancel={onClose} onOk={go} okText="发送" title="追加指令" destroyOnClose>
      <Select style={{ width: '100%', marginBottom: 10 }} value={sess} onChange={setSess}
        options={(tasks || []).map((t: any) => ({ value: t.name, label: `${t.name} [${t.type}]` }))} />
      <Input.TextArea rows={3} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="发送给该任务/Agent 的指令" />
    </Modal>
  )
}

function CollectModal({ group, onClose }: { group: string | null; onClose: () => void }) {
  const [text, setText] = useState('加载中…')
  useEffect(() => {
    if (!group) return
    setText('加载中…')
    api('GET', '/tasks/' + encodeURIComponent(group) + '/collect')
      .then((r) => setText((r.results || []).map((x: any) => `━━━ ${x.task} [${x.type}] ━━━\n${x.prompt ? '任务: ' + x.prompt + '\n' : ''}${x.output}`).join('\n\n') || '(无输出)'))
      .catch((e) => setText(e.message))
  }, [group])
  return (
    <Modal open={!!group} onCancel={onClose} footer={null} title={`收集: ${group || ''}`} width="min(720px,94vw)">
      <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '60vh', overflow: 'auto', background: '#06090d', padding: 12, borderRadius: 8, fontSize: 12.5 }}>{text}</pre>
    </Modal>
  )
}
