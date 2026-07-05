// 插件统一管理/配置页(VS Code 扩展页式):左侧插件列表,右侧详情
// (配置表单按 manifest.configFields 自动渲染 / 命令 / 审计)。
// 数据全部走 backend 薄封装 REST(exec ttmux plugin ... --json),前端不感知 plugind。
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert, Button, Card, Descriptions, Empty, Form, Input, List, Select, Space, Spin, Switch,
  Table, Tabs, Tag, Typography, message,
} from 'antd'
import { api } from './api'
import { useI18n } from './i18n'

type LocaleText = Record<string, string> | undefined

type ConfigField = {
  key: string
  title?: LocaleText
  description?: LocaleText
  secret?: boolean
  options?: string[]
  placeholder?: string
}

type Manifest = {
  id: string
  name: string
  version: string
  displayName?: LocaleText
  description?: LocaleText
  runtime?: { kind?: string; resident?: boolean }
  permissions?: Record<string, any>
  contributes?: {
    commands?: { id: string; title?: LocaleText }[]
    notificationSinks?: { id: string; events?: string[] }[]
    configFields?: ConfigField[]
  }
}

type RegisteredPlugin = { manifest: Manifest; enabled: boolean; installed: string }

type AuditEntry = {
  time: string; plugin: string; actor: string; action: string
  target?: string; decision: string; result?: string
}

function lt(text: LocaleText, locale: string): string {
  if (!text) return ''
  return text[locale] || text['zh-CN'] || Object.values(text)[0] || ''
}

export default function PluginsPanel() {
  const { t, locale } = useI18n()
  const [plugins, setPlugins] = useState<RegisteredPlugin[]>([])
  const [daemon, setDaemon] = useState<Record<string, any> | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState('')

  const reload = useCallback(async () => {
    try {
      const [list, st] = await Promise.all([api('GET', '/plugins'), api('GET', '/plugin/status')])
      const rows: RegisteredPlugin[] = list || []
      setPlugins(rows)
      setDaemon(st?.daemon || null)
      setSelected((cur) => cur || rows[0]?.manifest.id || '')
    } catch (e: any) {
      message.error(e.message)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { reload() }, [reload])

  const current = useMemo(() => plugins.find((p) => p.manifest.id === selected), [plugins, selected])

  const toggle = async (p: RegisteredPlugin, enabled: boolean) => {
    try {
      await api('POST', `/plugins/${encodeURIComponent(p.manifest.id)}/${enabled ? 'enable' : 'disable'}`)
      message.success(t(enabled ? 'plugins.enabled' : 'plugins.disabled'))
      reload()
    } catch (e: any) {
      message.error(e.message)
    }
  }

  if (loading) return <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%', minHeight: 0 }}>
      <Card size="small" style={{ width: 300, flex: '0 0 300px', overflow: 'auto' }} title={t('plugins.title')}>
        {daemon
          ? <Alert type="success" showIcon style={{ marginBottom: 8 }} message={t('plugins.daemonRunning')} />
          : <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={t('plugins.daemonStopped')}
              description={<Typography.Text code copyable>ttmux plugin daemon</Typography.Text>} />}
        <List
          dataSource={plugins}
          renderItem={(p) => (
            <List.Item
              onClick={() => setSelected(p.manifest.id)}
              style={{
                cursor: 'pointer', borderRadius: 8, padding: '8px 10px',
                background: p.manifest.id === selected ? 'var(--bg-elevated, rgba(88,166,255,.12))' : undefined,
              }}
              actions={[<Switch key="sw" size="small" checked={p.enabled}
                onClick={(v, e) => { e.stopPropagation(); toggle(p, v) }} />]}
            >
              <List.Item.Meta
                title={<Space size={6}>{lt(p.manifest.displayName, locale) || p.manifest.name}
                  <Tag style={{ marginInlineStart: 0 }}>{p.manifest.version}</Tag></Space>}
                description={<Typography.Text type="secondary" ellipsis={{ tooltip: true }} style={{ fontSize: 12 }}>
                  {lt(p.manifest.description, locale)}</Typography.Text>}
              />
            </List.Item>
          )}
        />
      </Card>
      <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        {current
          ? <PluginDetail key={current.manifest.id} plugin={current} locale={locale} t={t} />
          : <Empty style={{ marginTop: 64 }} />}
      </div>
    </div>
  )
}

function PluginDetail({ plugin, locale, t }: {
  plugin: RegisteredPlugin; locale: string
  t: (k: string, vars?: Record<string, string | number>) => string
}) {
  const m = plugin.manifest
  const fields = m.contributes?.configFields || []
  const commands = m.contributes?.commands || []
  return (
    <Card size="small"
      title={<Space>{lt(m.displayName, locale) || m.name}
        <Tag color={plugin.enabled ? 'green' : undefined}>{t(plugin.enabled ? 'plugins.stateEnabled' : 'plugins.stateDisabled')}</Tag>
        <Tag>{m.runtime?.kind || 'builtin'}</Tag></Space>}
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        {lt(m.description, locale)}
      </Typography.Paragraph>
      <Tabs
        items={[
          {
            key: 'config', label: t('plugins.tabConfig'),
            children: fields.length
              ? <ConfigForm pluginId={m.id} fields={fields} locale={locale} t={t} />
              : <Empty description={t('plugins.noConfig')} image={Empty.PRESENTED_IMAGE_SIMPLE} />,
          },
          {
            key: 'commands', label: t('plugins.tabCommands'),
            children: <CommandList pluginId={m.id} commands={commands} enabled={plugin.enabled} locale={locale} t={t} />,
          },
          {
            key: 'perms', label: t('plugins.tabPerms'),
            children: <Descriptions size="small" column={1} bordered
              items={Object.entries(m.permissions || {}).map(([k, v]) => ({
                key: k, label: k, children: <Typography.Text code>{JSON.stringify(v)}</Typography.Text>,
              }))} />,
          },
          { key: 'audit', label: t('plugins.tabAudit'), children: <AuditTable pluginId={m.id} t={t} /> },
        ]}
      />
    </Card>
  )
}

function ConfigForm({ pluginId, fields, locale, t }: {
  pluginId: string; fields: ConfigField[]; locale: string
  t: (k: string, vars?: Record<string, string | number>) => string
}) {
  const [form] = Form.useForm()
  const [initial, setInitial] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api('GET', `/plugins/${encodeURIComponent(pluginId)}/config`)
      .then((cfg) => { setInitial(cfg || {}); form.setFieldsValue(cfg || {}) })
      .catch((e) => message.error(e.message))
  }, [pluginId, form])

  const save = async () => {
    const values: Record<string, string> = form.getFieldsValue()
    // secret 字段展示的是掩码:只提交用户真正改动过的项,避免掩码写回。
    const set: Record<string, string> = {}
    for (const f of fields) {
      const v = values[f.key] ?? ''
      if (v !== (initial[f.key] ?? '')) set[f.key] = v
    }
    if (!Object.keys(set).length) { message.info(t('plugins.nothingChanged')); return }
    setSaving(true)
    try {
      await api('PUT', `/plugins/${encodeURIComponent(pluginId)}/config`, { set })
      message.success(t('plugins.saved'))
      const cfg = await api('GET', `/plugins/${encodeURIComponent(pluginId)}/config`)
      setInitial(cfg || {})
      form.setFieldsValue(cfg || {})
    } catch (e: any) {
      message.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Form form={form} layout="vertical" style={{ maxWidth: 560 }}>
      {fields.map((f) => (
        <Form.Item key={f.key} name={f.key}
          label={lt(f.title, locale) || f.key}
          extra={lt(f.description, locale) || undefined}>
          {f.options?.length
            ? <Select options={f.options.map((o) => ({ value: o, label: o === '' ? t('plugins.optionAuto') : o }))} />
            : f.secret
              ? <Input.Password placeholder={f.placeholder} autoComplete="new-password" />
              : <Input placeholder={f.placeholder} />}
        </Form.Item>
      ))}
      <Button type="primary" loading={saving} onClick={save}>{t('plugins.save')}</Button>
    </Form>
  )
}

function CommandList({ pluginId, commands, enabled, locale, t }: {
  pluginId: string; commands: { id: string; title?: LocaleText }[]; enabled: boolean; locale: string
  t: (k: string, vars?: Record<string, string | number>) => string
}) {
  const [running, setRunning] = useState('')
  const [result, setResult] = useState<{ id: string; data: any } | null>(null)

  const run = async (id: string) => {
    setRunning(id)
    setResult(null)
    try {
      const data = await api('POST', `/plugins/${encodeURIComponent(pluginId)}/run`, { command: id, args: {} })
      setResult({ id, data })
      message.success(t('plugins.runDone'))
    } catch (e: any) {
      message.error(e.message)
    } finally {
      setRunning('')
    }
  }

  if (!commands.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <List
        dataSource={commands}
        renderItem={(c) => (
          <List.Item actions={[
            <Button key="run" size="small" disabled={!enabled} loading={running === c.id}
              onClick={() => run(c.id)}>{t('plugins.run')}</Button>,
          ]}>
            <List.Item.Meta
              title={<Typography.Text code>{c.id}</Typography.Text>}
              description={lt(c.title, locale)}
            />
          </List.Item>
        )}
      />
      {result && (
        <Card size="small" title={<Typography.Text code>{result.id}</Typography.Text>}>
          <pre style={{ margin: 0, maxHeight: 320, overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(result.data, null, 2)}
          </pre>
        </Card>
      )}
    </Space>
  )
}

function AuditTable({ pluginId, t }: {
  pluginId: string
  t: (k: string, vars?: Record<string, string | number>) => string
}) {
  const [rows, setRows] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    api('GET', `/plugins/${encodeURIComponent(pluginId)}/audit`)
      .then((data) => setRows(data || []))
      .catch((e) => message.error(e.message))
      .finally(() => setLoading(false))
  }, [pluginId])
  return (
    <Table<AuditEntry> size="small" rowKey={(r, i) => `${r.time}-${i}`} loading={loading}
      dataSource={rows} pagination={{ pageSize: 15, hideOnSinglePage: true }}
      columns={[
        { title: t('plugins.auditTime'), dataIndex: 'time', width: 190, ellipsis: true },
        { title: t('plugins.auditAction'), dataIndex: 'action', width: 170,
          render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
        { title: t('plugins.auditTarget'), dataIndex: 'target', ellipsis: true },
        { title: t('plugins.auditDecision'), dataIndex: 'decision', width: 90,
          render: (v: string) => <Tag color={v === 'denied' ? 'red' : 'green'}>{v}</Tag> },
        { title: t('plugins.auditResult'), dataIndex: 'result', ellipsis: true },
      ]}
    />
  )
}
