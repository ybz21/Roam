// 「已结束的会话」——会话死了台账不删（M2），所以那天下午干了什么翻得回来。
//
// 默认折叠：绝大多数时候用户关心的是活着的会话，历史是「要找的时候能找到」，
// 不是常驻噪音。展开才拉数据，也不轮询——历史几分钟才变一次，跟着 3s 轮询白费。
import { useState } from 'react'
import { App as AntApp, Button, Empty, Spin, Tooltip } from 'antd'
import { api } from '../../api'
import { useI18n } from '../../i18n'
import { ChevronDown, ChevronRight, ClockIcon, RefreshIcon } from '../../icons'
import { relTime } from '../../time-format'

export type EndedSession = {
  session: string
  label?: string
  home?: string
  initial_cwd?: string
  died_at?: string
  died_reason?: string
  agent_uuid?: string
}

/** 归属目录：优先钉死的 home，退回建会话时的 cwd（老行只有后者）。 */
function dirOf(r: EndedSession): string { return r.home || r.initial_cwd || '' }

/** 台账里的时间是 RFC3339 字符串，relTime 要秒。认不出就不显示，别写个 NaN 上去。 */
function endedAt(iso: string | undefined, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? '' : relTime(Math.floor(ms / 1000), t)
}

export function SessionHistory({ onRestored }: { onRestored?: (name: string) => void }) {
  const { t } = useI18n()
  const { message } = AntApp.useApp()
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<EndedSession[] | null>(null)
  const [busy, setBusy] = useState('')

  const load = () => {
    setRows(null)
    api('GET', '/sessions/history?limit=100')
      .then((r: unknown) => setRows(Array.isArray(r) ? (r as EndedSession[]) : []))
      .catch(() => setRows([]))
  }

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && rows === null) load()
  }

  const restore = async (r: EndedSession) => {
    setBusy(r.session)
    try {
      const res: any = await api('POST', `/sessions/${encodeURIComponent(r.session)}/restore`)
      const d = res?.data || {}
      message.success(d.resumedAgent
        ? `${t('session.history.restored', { name: d.label || d.session })} · ${t('session.history.resumed')}`
        : t('session.history.restored', { name: d.label || d.session }))
      onRestored?.(d.session)
      load()
    } catch (e: any) {
      message.error(t('session.history.restoreFailed', { msg: e?.message || String(e) }))
    } finally {
      setBusy('')
    }
  }

  const reason = (r: EndedSession) =>
    r.died_reason === 'host-restart'
      ? t('session.history.reasonHostRestart')
      : t('session.history.reasonKilled')

  return (
    <div style={{ marginTop: 'var(--sp-4)' }}>
      <button type="button" className="tt-act" onClick={toggle}
        style={{ gap: 6, fontSize: 'var(--fs-meta)' }}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {t('session.history.title')}
        {rows && rows.length > 0 && (
          <span style={{ color: 'var(--text-dimmer)' }}>{t('session.history.count', { n: rows.length })}</span>
        )}
      </button>

      {open && (
        <div style={{ marginTop: 'var(--sp-3)' }}>
          <div style={{ color: 'var(--text-dimmer)', fontSize: 'var(--fs-micro)', marginBottom: 'var(--sp-2)' }}>
            {t('session.history.hint')}
          </div>
          {rows === null && <div style={{ padding: 'var(--sp-4)', textAlign: 'center' }}><Spin size="small" /></div>}
          {rows && rows.length === 0 && (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('session.history.empty')} />
          )}
          {rows && rows.map((r) => {
            const dir = dirOf(r)
            return (
              <div key={r.session} className="tt-histrow">
                <ClockIcon size={13} />
                <span className="tt-histname" title={r.session}>{r.label || r.session}</span>
                <span className="tt-histdir mono" title={dir}>{dir}</span>
                <span className="tt-histmeta">{reason(r)}</span>
                <span className="tt-histmeta">{endedAt(r.died_at, t)}</span>
                <Tooltip title={dir ? undefined : t('session.history.noDir')}>
                  <Button className="tt-act" type="text" size="small" disabled={!dir || busy === r.session}
                    icon={<RefreshIcon size={13} />}
                    aria-label={t('session.history.restore')}
                    onClick={() => restore(r)}>
                    {busy === r.session ? t('session.history.restoring') : t('session.history.restore')}
                  </Button>
                </Tooltip>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
