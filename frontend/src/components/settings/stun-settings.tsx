// STUN 列表：一台一行，能加能删，每行跟一个质量数。
//
// 之前是个 tags 输入框：能配多台，但看不出「配了哪几台、各自好不好、想删哪一台」。
// 表格把这三件事摊开——地址、质量、删除各占一列，加一台在表下面单开一行。
import { useState } from 'react'
import { AutoComplete, Empty, Space, Table } from 'antd'
import { useI18n } from '../../i18n'
import { usePreferences } from '../../preferences'
import { STUN_PRESETS, normalizeStun, parseStunList } from '../../p2p/ice-servers'
import { pickFastest, probeAll, type StunResult } from '../../p2p/stun-probe'
import { PlusIcon, TrashIcon } from '../../icons'

// 检测结果落 localStorage：换一页回来还看得见上次量的数，不必为一个只读的数字再等五秒。
const PROBE_KEY = 'roam.stunProbe'
type ProbeSnapshot = { at: number; results: StunResult[] }

function loadProbe(): ProbeSnapshot | null {
  try {
    const raw = localStorage.getItem(PROBE_KEY)
    const v = raw ? JSON.parse(raw) as ProbeSnapshot : null
    return v && Array.isArray(v.results) ? v : null
  } catch { return null }
}

type Row = { url: string; brand?: string; refMs?: number; ms?: number; ok?: boolean }

/** 排序用的可比较值：实测优先，其次出厂参考；不通和没有数的一律沉底。 */
function rank(r: Row): number {
  if (r.ok === false) return Number.MAX_SAFE_INTEGER
  return r.ms ?? r.refMs ?? Number.MAX_SAFE_INTEGER - 1
}

export function StunServers({ on, serverStun }: { on: boolean; serverStun: string[] }) {
  const { t } = useI18n()
  const [prefs, setPrefs] = usePreferences()
  const [probe, setProbe] = useState<ProbeSnapshot | null>(() => loadProbe())
  const [probing, setProbing] = useState(false)
  const [draft, setDraft] = useState('')

  // 没自定义过就展示服务端那份（transport 那边也是这个规则：偏好为空就跟随服务端）。
  const custom = parseStunList(prefs.p2pStunServers)
  const following = custom.length === 0
  const list = following ? serverStun : custom
  const measured = new Map((probe?.results || []).map((r) => [r.url, r]))

  const dim = { color: 'var(--text-dim)', fontSize: 'var(--fs-meta)' }
  const hint = { color: 'var(--text-dimmer)', fontSize: 'var(--fs-micro)' }

  const write = (urls: string[]) => setPrefs({ p2pStunServers: urls.join(', ') })

  // 删/加都写整份列表：跟随服务端时删一台，等于「从这份开始改」，自动落成本浏览器的自定义。
  const remove = (url: string) => write(list.filter((u) => u !== url))
  const add = (raw: string) => {
    const u = normalizeStun(raw)
    if (!u || list.includes(u)) { setDraft(''); return }
    write([...list, u])
    setDraft('')
  }

  const runProbe = async (): Promise<StunResult[]> => {
    setProbing(true)
    try {
      // 预置的一起量：没在列表里的也要有数，不然「该加哪一台」还是没依据。
      const results = await probeAll([...STUN_PRESETS.map((p) => p.value), ...list])
      const snap = { at: Date.now(), results }
      setProbe(snap)
      try { localStorage.setItem(PROBE_KEY, JSON.stringify(snap)) } catch { /* 隐私模式写不进，不影响功能 */ }
      return results
    } finally {
      setProbing(false)
    }
  }

  // 优选：没量过就先量，再把通的里面最快的几台写进偏好。一台都不通就不动——
  // 宁可维持现状，也不写一份空列表。
  const autoPick = async () => {
    const results = probe?.results?.length ? probe.results : await runProbe()
    const best = pickFastest(results)
    if (best.length) write(best)
  }

  const rowOf = (url: string): Row => {
    const p = STUN_PRESETS.find((x) => x.value === url)
    const m = measured.get(url)
    return { url, brand: p?.brand, refMs: p?.refMs, ms: m?.ok ? m.ms : undefined, ok: m?.ok }
  }
  const rows = list.map(rowOf)

  // 下拉只提还没加的：已经在表里的再列出来只会让人点了没反应。
  const options = STUN_PRESETS.filter((p) => !list.includes(p.value)).map((p) => {
    const r = rowOf(p.value)
    return {
      value: p.value,
      label: (
        <span style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'baseline' }}>
          <span>{p.value}</span>
          <span style={hint}>{p.brand}</span>
          <span style={{ ...hint, marginLeft: 'auto' }}>{qualityText(r, t)}</span>
        </span>
      ),
    }
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)', opacity: on ? 1 : 0.5 }}>
      <span style={dim}>{t('settings.p2pStun')}</span>

      <Table<Row>
        size="small" rowKey="url" dataSource={rows} pagination={false}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('settings.p2pStunEmpty')} /> }}
        style={{ maxWidth: 560 }}
        columns={[
          {
            title: t('settings.p2pStunColAddr'),
            dataIndex: 'url',
            render: (url: string, r: Row) => (
              <span>
                <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{url}</span>
                {r.brand && <span style={{ ...hint, marginLeft: 'var(--sp-2)' }}>{r.brand}</span>}
              </span>
            ),
          },
          {
            title: t('settings.p2pStunColQuality'),
            width: 96,
            align: 'right',
            defaultSortOrder: 'ascend',
            sorter: (a: Row, b: Row) => rank(a) - rank(b),
            render: (_: unknown, r: Row) => (
              <span style={{ color: r.ok === false ? 'var(--danger)' : r.ms != null ? 'var(--text)' : 'var(--text-dimmer)' }}>
                {qualityText(r, t)}
              </span>
            ),
          },
          {
            title: '',
            width: 56,
            align: 'right',
            render: (_: unknown, r: Row) => (
              <button type="button" className="tt-act danger" disabled={!on}
                aria-label={t('settings.p2pStunRemove', { url: r.url })}
                onClick={() => remove(r.url)}><TrashIcon /></button>
            ),
          },
        ]}
      />

      <Space align="center" wrap size="small">
        <AutoComplete
          disabled={!on} value={draft} options={options} onChange={setDraft} onSelect={add}
          placeholder={t('settings.p2pStunAddPh')} style={{ width: 360 }}
          filterOption={(input, opt) => String(opt?.value || '').includes(input.trim())}
        />
        <button type="button" className="tt-act" disabled={!on || !draft.trim()} onClick={() => add(draft)}>
          <PlusIcon />{t('settings.p2pStunAdd')}
        </button>
      </Space>

      <Space align="center" wrap size="small">
        <button type="button" className="tt-act" disabled={!on || probing} onClick={() => { void runProbe() }}>
          {probing ? t('settings.p2pStunTesting') : t('settings.p2pStunTest')}
        </button>
        <button type="button" className="tt-act ok" disabled={!on || probing} onClick={() => { void autoPick() }}>
          {t('settings.p2pStunPick')}
        </button>
        {!following && (
          <button type="button" className="tt-act" disabled={!on} onClick={() => write([])}>
            {t('settings.p2pStunFollow')}
          </button>
        )}
        <span style={hint}>
          {probe
            ? t('settings.p2pStunLast', {
              time: new Date(probe.at).toLocaleTimeString(),
              ok: probe.results.filter((r) => r.ok).length,
              total: probe.results.length,
            })
            : t('settings.p2pStunNever')}
        </span>
      </Space>

      <span style={hint}>{following ? t('settings.p2pStunFollowing') : t('settings.p2pStunCustom', { n: list.length })}</span>
      <span style={hint}>{t('settings.p2pStunHelp')}</span>
    </div>
  )
}

// 量过就报实测，没量过报出厂参考（不同网络会不一样，所以标明是参考）。
function qualityText(r: Row, t: (k: string, v?: Record<string, unknown>) => string): string {
  if (r.ok === false) return t('settings.p2pStunBad')
  if (r.ms != null) return t('settings.p2pStunMs', { ms: r.ms })
  return r.refMs != null ? t('settings.p2pStunRef', { ms: r.refMs }) : t('settings.p2pStunUnknown')
}
