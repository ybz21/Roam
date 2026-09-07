// 定时任务面板(roam.cron 插件的宿主侧面板):管理「什么时候 / 干什么 / 由谁干」
// 的定时任务表——增删改、启停、立即触发、改 prompt,全部走插件命令
// (cron.add / list / remove / enable / disable / run)经 backend 薄封装 REST。
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Alert, Button, Drawer, Empty, Form, Input, Modal, Popconfirm, Select, Space, Spin, Switch, Table, Tag,
  Typography, message,
} from 'antd'
import { api } from '../../api'
import { useLayout } from '../../layout'
import CronEditor from './CronEditor'
import { PlusIcon } from '../../icons'

// 一条任务的原始配置 + 运行态(与 Go 端 jobView 对齐)。
type Action = 'agent' | 'exec'

type Job = {
  name: string
  schedule: string
  action: Action
  enabled: boolean
  runs: number
  cron?: string
  provider?: string
  prompt?: string
  workdir?: string
  interactive?: boolean
  command?: string
  nextRunAt?: string
  lastRunAt?: string
}

// 一次触发的记录（与 Go 端 runsCmd 对齐）。「已触发 3」这个数字答不出的东西都在这儿。
type Run = {
  name: string
  at: number
  atStr: string
  trigger: 'schedule' | 'manual'
  action: Action
  ok: boolean
  error?: string
  session?: string
  interactive?: boolean
  exit?: number
  output?: string
}

type FormValues = {
  name: string
  cron: string
  action: Action
  provider: string
  prompt: string
  workdir: string
  interactive: boolean
  command: string
}

type T = (k: string, vars?: Record<string, string | number>) => string

export default function CronPanel({ pluginId, enabled, t }: { pluginId: string; enabled: boolean; t: T }) {
  const { phone: isPhone } = useLayout()
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Job | null>(null) // 非空=编辑;{} 视图当新增用 open 区分
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState('') // 正在执行动作的任务名(禁用其行内按钮)
  const [runsOf, setRunsOf] = useState<Job | null>(null) // 正在看谁的执行记录

  // 调一个 cron 命令:command 传短名(cron.xxx),args 全为字符串。
  const runCmd = useCallback(async (command: string, args: Record<string, string> = {}) => {
    return api('POST', `/plugins/${encodeURIComponent(pluginId)}/run`, { command, args })
  }, [pluginId])

  const reload = useCallback(async () => {
    try {
      const data = await runCmd('cron.list')
      setJobs((data?.jobs as Job[]) || [])
    } catch (e: any) {
      message.error(e.message)
    } finally {
      setLoading(false)
    }
  }, [runCmd])
  useEffect(() => { reload() }, [reload])

  const toggle = async (j: Job, on: boolean) => {
    setBusy(j.name)
    try {
      await runCmd(on ? 'cron.enable' : 'cron.disable', { name: j.name })
      await reload()
    } catch (e: any) {
      message.error(e.message)
    } finally {
      setBusy('')
    }
  }

  const runNow = async (j: Job) => {
    setBusy(j.name)
    try {
      await runCmd('cron.run', { name: j.name })
      message.success(t('cron.firedOnce', { name: j.name }))
      await reload()
    } catch (e: any) {
      message.error(e.message)
    } finally {
      setBusy('')
    }
  }

  const remove = async (j: Job) => {
    setBusy(j.name)
    try {
      await runCmd('cron.remove', { name: j.name })
      message.success(t('cron.removed', { name: j.name }))
      await reload()
    } catch (e: any) {
      message.error(e.message)
    } finally {
      setBusy('')
    }
  }

  const openRuns = (j: Job) => setRunsOf(j)

  const columns = useMemo(() => [
    {
      title: t('cron.colName'), dataIndex: 'name', key: 'name',
      render: (v: string, j: Job) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{v}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{actionSummary(j, t)}</Typography.Text>
        </Space>
      ),
    },
    {
      title: t('cron.colSchedule'), dataIndex: 'schedule', key: 'schedule', width: 130,
      render: (v: string) => <Typography.Text code style={{ fontSize: 12 }}>{v}</Typography.Text>,
    },
    {
      title: t('cron.colAction'), dataIndex: 'action', key: 'action', width: 90,
      render: (a: Action) => <Tag color={ACTION_COLOR[a]}>{t(`cron.action.${a}`)}</Tag>,
    },
    {
      title: t('cron.colNext'), dataIndex: 'nextRunAt', key: 'nextRunAt', width: 170,
      render: (v: string, j: Job) => j.enabled
        ? (v || '—')
        : <Typography.Text type="secondary">{t('cron.paused')}</Typography.Text>,
    },
    {
      // 「已触发 3」本身答不出任何问题：哪次跑的、成没成、会话在哪。点开就是记录。
      title: t('cron.colRuns'), dataIndex: 'runs', key: 'runs', width: 90,
      render: (n: number, j: Job) => (
        <Button size="small" type="link" style={{ padding: 0 }} disabled={!n}
          title={j.lastRunAt ? t('cron.lastRun', { time: j.lastRunAt }) : t('cron.neverRun')}
          onClick={() => openRuns(j)}>
          {n || 0}
        </Button>
      ),
    },
    {
      title: t('cron.colEnabled'), key: 'enabled', width: 70,
      render: (_: any, j: Job) => (
        <Switch size="small" checked={j.enabled} loading={busy === j.name}
          disabled={!enabled} onChange={(on) => toggle(j, on)} />
      ),
    },
    {
      title: t('cron.colOps'), key: 'ops', width: 190,
      render: (_: any, j: Job) => (
        <Space size={4}>
          <Button size="small" disabled={!enabled || busy === j.name} onClick={() => runNow(j)}>{t('cron.runNow')}</Button>
          <Button size="small" disabled={!enabled} onClick={() => { setEditing(j); setOpen(true) }}>{t('cron.edit')}</Button>
          <Popconfirm title={t('cron.removeConfirm', { name: j.name })} onConfirm={() => remove(j)}
            okText={t('cron.remove')} cancelText={t('cron.cancel')}>
            <Button size="small" danger disabled={!enabled}>{t('cron.remove')}</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ], [t, enabled, busy]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div style={{ padding: 32, textAlign: 'center' }}><Spin /></div>

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      {!enabled && <Alert type="warning" showIcon message={t('cron.enablePluginHint')} />}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography.Text type="secondary">{t('cron.intro')}</Typography.Text>
        <Button type="primary" disabled={!enabled} onClick={() => { setEditing(null); setOpen(true) }} icon={<PlusIcon size={13} />}>{t('cron.add')}</Button>
      </div>
      {jobs.length === 0
        ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('cron.empty')} />
        // 手机换卡片列表（13 §6）：这张表七列固定宽合计 730，360 的屏上必然横滚，
        // 而横滚表格在手机上等于「每一列都要滑到才看得见」。
        : isPhone ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {jobs.map((j) => (
              <div key={j.name} className="tt-cron-card">
                <div className="hd">
                  <b>{j.name}</b>
                  <Tag color={ACTION_COLOR[j.action]} style={{ margin: 0 }}>{t(`cron.action.${j.action}`)}</Tag>
                  <Switch size="small" checked={j.enabled} loading={busy === j.name}
                    disabled={!enabled} onChange={(on) => toggle(j, on)} />
                </div>
                <div className="sum">{actionSummary(j, t)}</div>
                <div className="meta">
                  <Typography.Text code style={{ fontSize: 12 }}>{j.schedule}</Typography.Text>
                  <span>{j.enabled ? (j.nextRunAt || '—') : t('cron.paused')}</span>
                  <Button size="small" type="link" style={{ padding: 0, height: 'auto' }}
                    disabled={!j.runs} onClick={() => openRuns(j)}>
                    {t('cron.colRuns')} {j.runs || 0}
                  </Button>
                </div>
                <div className="ops">
                  <Button size="small" disabled={!enabled || busy === j.name} onClick={() => runNow(j)}>{t('cron.runNow')}</Button>
                  <Button size="small" disabled={!enabled} onClick={() => { setEditing(j); setOpen(true) }}>{t('cron.edit')}</Button>
                  <Popconfirm title={t('cron.removeConfirm', { name: j.name })} onConfirm={() => remove(j)}
                    okText={t('cron.remove')} cancelText={t('cron.cancel')}>
                    <Button size="small" danger disabled={!enabled}>{t('cron.remove')}</Button>
                  </Popconfirm>
                </div>
              </div>
            ))}
          </div>
        ) : <Table<Job> size="small" rowKey="name" dataSource={jobs} columns={columns as any}
            pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 720 }} />}
      <RunsDrawer job={runsOf} t={t} runCmd={runCmd} onClose={() => setRunsOf(null)} />
      <JobModal open={open} job={editing} existing={jobs} t={t} pluginId={pluginId}
        onClose={() => setOpen(false)}
        onSaved={async () => { setOpen(false); await reload() }}
        submit={(args) => runCmd('cron.add', args)} />
    </Space>
  )
}

// 一句话概括「干什么」,列在任务名下方。
function actionSummary(j: Job, t: T): string {
  switch (j.action) {
    case 'agent': return `${j.provider || t('cron.providerAuto')}${j.interactive ? ` · ${t('cron.fieldInteractive')}` : ''} · ${(j.prompt || '').slice(0, 40)}`
    case 'exec': return (j.command || '').slice(0, 50)
    default: return ''
  }
}

const ACTION_COLOR: Record<string, string> = { agent: 'purple', exec: 'orange' }

// 轻量 tooltip(避免多引一个组件;antd Tooltip 用 title;此处用 span title 兜底)
function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return <span title={label}>{children}</span>
}

// 工作目录：在项目里挑，而不是背路径。
//
// 「定时任务在哪跑」十有八九就是某个项目的目录——原来这里只有一个空输入框，
// 等于每次都要自己去别处把绝对路径抄过来。项目清单直接读 /api/projects
// （「临时」那种目录本身就在项目里，不用另立一档）；剩下的情况留「自定义路径」。
const CUSTOM = '__custom__'

function WorkdirPicker({ t, value, onChange }: { t: T; value: string; onChange: (v: string) => void }) {
  const [projects, setProjects] = useState<{ name: string; dir: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [custom, setCustom] = useState(false)

  // /projects 这条要两秒上下（它顺带算了每个项目的 worktree 状态），
  // 期间下拉里只有「默认」和「自定义」两项——不给个 loading，看着就像项目丢了
  useEffect(() => {
    let stop = false
    api('GET', '/projects')
      .then((r) => {
        const list = (r?.data?.projects || r?.projects || []) as any[]
        if (!stop) setProjects(list.map((p) => ({ name: p.name, dir: p.dir })).filter((p) => p.dir))
      })
      .catch(() => {})
      .finally(() => { if (!stop) setLoading(false) })
    return () => { stop = true }
  }, [])

  // 编辑既有任务：路径不在项目清单里就是自定义的，直接把输入框摊开
  useEffect(() => {
    if (value && !projects.some((p) => p.dir === value)) setCustom(true)
  }, [value, projects])

  const options = [
    { value: '', label: t('cron.workdirDefault') },
    ...projects.map((p) => ({ value: p.dir, label: `${p.name} · ${p.dir}` })),
    { value: CUSTOM, label: t('cron.workdirCustom') },
  ]

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={6}>
      <Select
        value={custom ? CUSTOM : value || ''}
        options={options}
        loading={loading}
        onChange={(v) => {
          if (v === CUSTOM) { setCustom(true); return }
          setCustom(false)
          onChange(v)
        }}
      />
      {custom && (
        <Input placeholder={t('cron.workdirPlaceholder')} value={value}
          onChange={(e) => onChange(e.target.value)} />
      )}
    </Space>
  )
}

// ── 执行记录 ──
//
// 定时任务最要紧的问题不是「排期对不对」，而是**上次到底跑了没、跑成什么样**。
// 表上原来只有一个「已触发 3」，点不开——出了事只能去翻 tmux 里那个会话还在不在。
function RunsDrawer({ job, t, runCmd, onClose }: {
  job: Job | null; t: T
  runCmd: (command: string, args?: Record<string, string>) => Promise<any>
  onClose: () => void
}) {
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(false)
  const [live, setLive] = useState<Set<string>>(new Set()) // 还活着的会话名

  useEffect(() => {
    if (!job) { setRuns([]); return }
    let stop = false
    setLoading(true)
    ;(async () => {
      try {
        const data = await runCmd('cron.runs', { name: job.name, limit: '30' })
        if (!stop) setRuns((data?.runs as Run[]) || [])
        // 会话可能早就退了：拿一次在册名单，退了的那条就不给「打开会话」的入口，
        // 免得点进去是个 4404
        const ss = await api('GET', '/sessions').catch(() => null)
        const list: any[] = Array.isArray(ss) ? ss : (ss?.data || [])
        if (!stop) setLive(new Set(list.map((x: any) => x?.name).filter(Boolean)))
      } catch (e: any) {
        message.error(e.message)
      } finally {
        if (!stop) setLoading(false)
      }
    })()
    return () => { stop = true }
  }, [job, runCmd])

  const openSession = (name: string) => {
    // 会话在工作区里开，不在插件页：直接换路由，把它设成当前标签
    location.hash = `#/w?terms=${encodeURIComponent(name)}&active=${encodeURIComponent(name)}`
  }

  return (
    <Drawer open={!!job} onClose={onClose} width={560} destroyOnClose
      title={job ? t('cron.runsTitle', { name: job.name }) : ''}>
      {loading
        ? <div style={{ padding: 24, textAlign: 'center' }}><Spin /></div>
        : runs.length === 0
          ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('cron.runsEmpty')} />
          : (
            <div className="tt-cron-runs">
              {runs.map((r) => (
                <div key={`${r.at}-${r.session || r.exit}`} className="run">
                  <div className="hd">
                    <Typography.Text code style={{ fontSize: 12 }}>{r.atStr}</Typography.Text>
                    <Tag color={r.ok ? 'green' : 'red'} style={{ margin: 0 }}>
                      {r.ok ? t('cron.runOk') : t('cron.runFail')}
                    </Tag>
                    <Tag style={{ margin: 0 }}>{t(`cron.trigger.${r.trigger}`)}</Tag>
                    {r.exit != null && (
                      <Typography.Text type={r.exit === 0 ? 'secondary' : 'danger'} style={{ fontSize: 12 }}>
                        exit {r.exit}
                      </Typography.Text>
                    )}
                  </div>
                  {r.error && <div className="err">{r.error}</div>}
                  {r.session && (
                    <div className="sess">
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.session}</Typography.Text>
                      {live.has(r.session)
                        ? <Button size="small" onClick={() => openSession(r.session!)}>{t('cron.openSession')}</Button>
                        : <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('cron.sessionGone')}</Typography.Text>}
                    </div>
                  )}
                  {r.output && <pre className="out">{r.output.trimEnd()}</pre>}
                </div>
              ))}
            </div>
          )}
    </Drawer>
  )
}

// ── 新增/编辑弹窗 ──
function JobModal({ open, job, existing, t, pluginId, onClose, onSaved, submit }: {
  open: boolean; job: Job | null; existing: Job[]; t: T; pluginId: string
  onClose: () => void; onSaved: () => void
  submit: (args: Record<string, string>) => Promise<any>
}) {
  const [form] = Form.useForm<FormValues>()
  const [saving, setSaving] = useState(false)
  const isEdit = !!job

  useEffect(() => {
    if (!open) return
    if (job) {
      form.setFieldsValue({
        name: job.name,
        cron: job.cron || '',
        action: job.action,
        provider: job.provider || '', prompt: job.prompt || '', workdir: job.workdir || '',
        interactive: !!job.interactive,
        command: job.command || '',
      })
    } else {
      form.resetFields()
      form.setFieldsValue({ cron: '', action: 'agent', provider: '', interactive: false })
    }
  }, [open, job, form])

  const save = async () => {
    let v: FormValues
    try { v = await form.validateFields() } catch { return }
    const args: Record<string, string> = { name: v.name.trim(), action: v.action, cron: (v.cron || '').trim() }
    if (v.action === 'agent') {
      args.prompt = v.prompt
      if (v.provider) args.provider = v.provider
      if (v.workdir) args.workdir = v.workdir
      args.interactive = v.interactive ? 'true' : 'false'
    } else if (v.action === 'exec') { args.command = v.command }
    setSaving(true)
    try {
      await submit(args)
      message.success(isEdit ? t('cron.updated', { name: v.name }) : t('cron.added', { name: v.name }))
      onSaved()
    } catch (e: any) {
      message.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onCancel={onClose} onOk={save} confirmLoading={saving} destroyOnClose
      title={isEdit ? t('cron.editTitle') : t('cron.addTitle')} okText={t('cron.save')} cancelText={t('cron.cancel')} width={560}>
      <Form form={form} layout="vertical">
        <Form.Item name="name" label={t('cron.fieldName')} rules={[
          { required: true, message: t('cron.nameRequired') },
          // 新增时禁止撞已有名字(会被 upsert 悄悄覆盖)
          () => ({ validator: (_, val) => (!isEdit && existing.some((j) => j.name === (val || '').trim()))
            ? Promise.reject(new Error(t('cron.nameTaken'))) : Promise.resolve() }),
        ]}>
          <Input placeholder={t('cron.namePlaceholder')} disabled={isEdit} />
        </Form.Item>

        <Form.Item name="cron" label={t('cron.fieldSchedule')}
          rules={[{ required: true, message: t('cron.cronRequired') }]}>
          <CronEditor pluginId={pluginId} t={t} />
        </Form.Item>

        <Form.Item name="action" label={t('cron.fieldAction')} rules={[{ required: true }]}>
          <Select options={[
            { value: 'agent', label: t('cron.action.agent') + ' · ' + t('cron.actionAgentHint') },
            { value: 'exec', label: t('cron.action.exec') + ' · ' + t('cron.actionExecHint') },
          ]} />
        </Form.Item>

        <Form.Item noStyle shouldUpdate={(a, b) => a.action !== b.action}>
          {({ getFieldValue }) => {
            if (getFieldValue('action') === 'agent') return (
              <>
                <Form.Item name="provider" label={t('cron.fieldProvider')}>
                  <Select allowClear placeholder={t('cron.providerAuto')} options={[
                    { value: 'claude', label: 'Claude' },
                    { value: 'codex', label: 'Codex' },
                  ]} />
                </Form.Item>
                <Form.Item name="prompt" label={t('cron.fieldPrompt')} rules={[{ required: true, message: t('cron.promptRequired') }]}>
                  <Input.TextArea rows={5} placeholder={t('cron.promptPlaceholder')} />
                </Form.Item>
                <Form.Item label={t('cron.fieldWorkdir')} extra={t('cron.workdirHint')}>
                  <WorkdirPicker t={t} value={getFieldValue('workdir') || ''}
                    onChange={(v) => form.setFieldValue('workdir', v)} />
                </Form.Item>
                <Form.Item name="workdir" hidden><Input /></Form.Item>
                <Form.Item name="interactive" valuePropName="checked" label={t('cron.fieldInteractive')}
                  extra={t('cron.interactiveHint')}>
                  <Switch />
                </Form.Item>
              </>
            )
            return (
              <Form.Item name="command" label={t('cron.fieldCommand')} extra={t('cron.commandHint')}
                rules={[{ required: true, message: t('cron.commandRequired') }]}>
                <Input.TextArea rows={3} placeholder={t('cron.commandPlaceholder')} />
              </Form.Item>
            )
          }}
        </Form.Item>
      </Form>
    </Modal>
  )
}
