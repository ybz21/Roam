// cron 表达式编辑器:上面一排「频率」友好选择器(每隔分钟/小时、每天、每隔N天、
// 每周几、或自定义表达式),自动合成标准 5 段 cron;下面实时预览接下来几次触发
// (走插件 cron.preview,后端是排期的唯一真源)。作为受控组件用在 Form.Item 里
// (antd 注入 value/onChange),value 就是 cron 字符串。
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Checkbox, InputNumber, Input, Select, Space, TimePicker, Typography } from 'antd'
import dayjs from 'dayjs'
import { api } from './api'

type T = (k: string, vars?: Record<string, string | number>) => string
type Kind = 'everyMin' | 'everyHour' | 'daily' | 'everyDay' | 'weekly' | 'custom'

// ── cron 字符串 ⇄ 友好预设 的互转(纯函数)──
function buildCron(k: Kind, p: Params): string {
  const { n, minute, hour, days, raw } = p
  switch (k) {
    case 'everyMin': return `*/${n} * * * *`
    case 'everyHour': return `${minute} */${n} * * *`
    case 'daily': return `${minute} ${hour} * * *`
    case 'everyDay': return `${minute} ${hour} */${n} * *`
    case 'weekly': return `${minute} ${hour} * * ${(days.length ? [...days].sort((a, b) => a - b) : [1]).join(',')}`
    default: return raw
  }
}

type Params = { n: number; minute: number; hour: number; days: number[]; raw: string }

function detect(value: string): { kind: Kind; p: Params } {
  const base: Params = { n: 5, minute: 0, hour: 9, days: [1], raw: value }
  const f = value.trim().split(/\s+/)
  if (f.length === 5) {
    const [mi, h, dom, , dow] = f // 月段固定 * 时才当预设,否则算自定义
    const mo = f[3]
    const num = (s: string) => /^\d+$/.test(s)
    const step = (s: string) => /^\*\/\d+$/.test(s)
    if (mo === '*') {
      if (step(mi) && h === '*' && dom === '*' && dow === '*') return { kind: 'everyMin', p: { ...base, n: +mi.slice(2) } }
      if (num(mi) && step(h) && dom === '*' && dow === '*') return { kind: 'everyHour', p: { ...base, n: +h.slice(2), minute: +mi } }
      if (num(mi) && num(h) && dom === '*' && dow === '*') return { kind: 'daily', p: { ...base, hour: +h, minute: +mi } }
      if (num(mi) && num(h) && step(dom) && dow === '*') return { kind: 'everyDay', p: { ...base, n: +dom.slice(2), hour: +h, minute: +mi } }
      if (num(mi) && num(h) && dom === '*' && /^[0-7](,[0-7])*$/.test(dow))
        return { kind: 'weekly', p: { ...base, days: dow.split(',').map(Number), hour: +h, minute: +mi } }
    }
  }
  return { kind: 'custom', p: base }
}

export default function CronEditor({ value = '', onChange, pluginId, t }: {
  value?: string; onChange?: (v: string) => void; pluginId: string; t: T
}) {
  const [kind, setKind] = useState<Kind>('daily')
  const [p, setP] = useState<Params>({ n: 5, minute: 0, hour: 9, days: [1], raw: '' })
  const inited = useRef(false)

  // 首次:按传入 value 还原成预设(编辑已有任务时回填);空值给个默认「每天 09:00」
  useEffect(() => {
    if (inited.current) return
    inited.current = true
    if (value.trim()) {
      const d = detect(value)
      setKind(d.kind); setP(d.p)
    } else {
      const def = buildCron('daily', { n: 5, minute: 0, hour: 9, days: [1], raw: '' })
      onChange?.(def)
    }
  }, [value, onChange])

  // 改任一控件 → 合成 cron 往外抛
  const emit = useCallback((k: Kind, np: Params) => {
    setKind(k); setP(np)
    onChange?.(buildCron(k, np))
  }, [onChange])

  const time = dayjs().hour(p.hour).minute(p.minute).second(0)
  const setTime = (d: dayjs.Dayjs | null) => { if (d) emit(kind, { ...p, hour: d.hour(), minute: d.minute() }) }

  return (
    <div>
      <Space wrap>
        <Select<Kind> value={kind} style={{ width: 148 }}
          onChange={(k) => emit(k, { ...p, raw: k === 'custom' ? (value || buildCron(kind, p)) : p.raw })}
          options={[
            { value: 'everyMin', label: t('cron.freq.everyMin') },
            { value: 'everyHour', label: t('cron.freq.everyHour') },
            { value: 'daily', label: t('cron.freq.daily') },
            { value: 'everyDay', label: t('cron.freq.everyDay') },
            { value: 'weekly', label: t('cron.freq.weekly') },
            { value: 'custom', label: t('cron.freq.custom') },
          ]} />

        {kind === 'everyMin' && (
          <Space>{t('cron.freq.everyN')}
            <InputNumber min={1} max={59} value={p.n} onChange={(v) => emit(kind, { ...p, n: v || 1 })} />
            {t('cron.unit.min')}</Space>
        )}
        {kind === 'everyHour' && (
          <Space>{t('cron.freq.everyN')}
            <InputNumber min={1} max={23} value={p.n} onChange={(v) => emit(kind, { ...p, n: v || 1 })} />
            {t('cron.unit.hour')}
            <span style={{ opacity: 0.7 }}>{t('cron.atMinute')}</span>
            <InputNumber min={0} max={59} value={p.minute} onChange={(v) => emit(kind, { ...p, minute: v || 0 })} />
            {t('cron.unit.min')}</Space>
        )}
        {kind === 'daily' && (
          <Space>{t('cron.everyDayAt')}<TimePicker value={time} format="HH:mm" allowClear={false} onChange={setTime} /></Space>
        )}
        {kind === 'everyDay' && (
          <Space>{t('cron.freq.everyN')}
            <InputNumber min={2} max={31} value={p.n < 2 ? 2 : p.n} onChange={(v) => emit(kind, { ...p, n: v || 2 })} />
            {t('cron.unit.day')}
            <TimePicker value={time} format="HH:mm" allowClear={false} onChange={setTime} /></Space>
        )}
        {kind === 'weekly' && (
          <Space direction="vertical" size={4}>
            <Checkbox.Group value={p.days} onChange={(v) => emit(kind, { ...p, days: (v as number[]) })}
              options={[0, 1, 2, 3, 4, 5, 6].map((d) => ({ label: t(`cron.wd.${d}`), value: d }))} />
            <TimePicker value={time} format="HH:mm" allowClear={false} onChange={setTime} />
          </Space>
        )}
        {kind === 'custom' && (
          <Input style={{ width: 200, fontFamily: 'monospace' }} placeholder="*/5 * * * *"
            value={value} onChange={(e) => emit('custom', { ...p, raw: e.target.value })} />
        )}
      </Space>

      <PreviewLine cron={value} pluginId={pluginId} t={t} />
    </div>
  )
}

// 实时预览:防抖后调 cron.preview,展示接下来 3 次触发或错误。
function PreviewLine({ cron, pluginId, t }: { cron: string; pluginId: string; t: T }) {
  const [state, setState] = useState<{ next?: string[]; err?: string }>({})
  useEffect(() => {
    if (!cron.trim()) { setState({}); return }
    let alive = true
    const timer = setTimeout(async () => {
      try {
        const r = await api('POST', `/plugins/${encodeURIComponent(pluginId)}/run`,
          { command: 'cron.preview', args: { cron, count: '3' } })
        if (alive) setState({ next: r?.next || [] })
      } catch (e: any) {
        if (alive) setState({ err: e.message })
      }
    }, 350)
    return () => { alive = false; clearTimeout(timer) }
  }, [cron, pluginId])

  if (state.err) return <Alert type="error" showIcon style={{ marginTop: 8 }} message={state.err} />
  return (
    <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
      <Typography.Text code style={{ fontSize: 12 }}>{cron || '—'}</Typography.Text>
      {state.next?.length ? <>　{t('cron.nextFires')}：{state.next.join('　·　')}</> : null}
    </Typography.Paragraph>
  )
}
