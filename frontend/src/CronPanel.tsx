// 定时任务面板(roam.cron 插件的宿主侧面板):管理「什么时候 / 干什么 / 由谁干」
// 的定时任务表——增删改、启停、立即触发、改 prompt,全部走插件命令
// (cron.add / list / remove / enable / disable / run)经 backend 薄封装 REST。
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Alert, Button, Empty, Form, Input, Modal, Popconfirm, Select, Space, Spin, Switch, Table, Tag,
  Typography, message,
} from 'antd'
import { api } from './api'
import CronEditor from './CronEditor'

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
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Job | null>(null) // 非空=编辑;{} 视图当新增用 open 区分
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState('') // 正在执行动作的任务名(禁用其行内按钮)

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
      title: t('cron.colRuns'), dataIndex: 'runs', key: 'runs', width: 80,
      render: (n: number, j: Job) => (
        <Tooltip label={j.lastRunAt ? t('cron.lastRun', { time: j.lastRunAt }) : t('cron.neverRun')}>
          <span>{n || 0}</span>
        </Tooltip>
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
        <Button type="primary" disabled={!enabled} onClick={() => { setEditing(null); setOpen(true) }}>{t('cron.add')}</Button>
      </div>
      {jobs.length === 0
        ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('cron.empty')} />
        : <Table<Job> size="small" rowKey="name" dataSource={jobs} columns={columns as any}
            pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 720 }} />}
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
    case 'agent': return `🤖 ${j.provider || t('cron.providerAuto')}${j.interactive ? ' ⭯' : ''} · ${(j.prompt || '').slice(0, 40)}`
    case 'exec': return `＄ ${(j.command || '').slice(0, 50)}`
    default: return ''
  }
}

const ACTION_COLOR: Record<string, string> = { agent: 'purple', exec: 'orange' }

// 轻量 tooltip(避免多引一个组件;antd Tooltip 用 title;此处用 span title 兜底)
function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return <span title={label}>{children}</span>
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
                <Form.Item name="workdir" label={t('cron.fieldWorkdir')}>
                  <Input placeholder={t('cron.workdirPlaceholder')} />
                </Form.Item>
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
