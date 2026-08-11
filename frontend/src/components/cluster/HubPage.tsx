// 中心页（#/hub）：让中心自己能被看见。
//
// 2026-08-11 中心因为一个 goroutine 泄漏卡死了十几个小时，是部署时碰巧撞见的——界面上
// 没有任何地方会说「中心不健康」。这一页补的就是这个洞，摆的都是**只有中心才知道**的东西：
// 它自己的内存/goroutine 曲线、经它转发的流量、每台机器的版本与能力、最近发生了什么。
//
// 它**不是切换器里的第 N 台机器**：中心不跑会话/项目/文件/终端，切过去大半个应用是空的。
// 所以入口是「去看中心」，当前机器不变（见 Navigation 的 hubEntry）。
import { useEffect, useState } from 'react'
import { App as AntApp, Modal } from 'antd'
import { useI18n } from '../../i18n'
import { relTime } from '../../time-format'
import { NodeMark, nodeDotColor } from './NodeMark'
import { setCurrentNode, useClusterNodes, useCurrentNodeId, type ClusterNode } from './node-url'
import { assessHub } from './hub-health'
import { WarnIcon } from '../../icons'

type Sample = { at: number; rss: number; goroutines: number; heap: number; tunnels: number; requests: number }
type HubEvent = { at: number; kind: string; node?: string; secs?: number }
type Host = {
  memTotal: number; memAvailable: number; swapTotal: number; swapFree: number
  load1: number; load5: number; load15: number; cpus: number
}
type SelfData = {
  version: string; startedAt: number; uptimeSecs: number; pprof: string
  now: Sample; host: Host; nodes: number; nodesOnline: number
  samples: Sample[]; events: HubEvent[]
}

/** 中心自己的接口永远不带 /n/<id> 前缀——加了就成了「问某台节点中心怎么样」。 */
async function getSelf(): Promise<SelfData | null> {
  try {
    const r = await fetch('/api/hub/self', { cache: 'no-store' })
    if (!r.ok) return null
    return (await r.json())?.data || null
  } catch { return null }
}

function mb(bytes: number): number { return Math.round(bytes / 1024 / 1024) }
function gb(bytes: number): string { return (bytes / 1024 / 1024 / 1024).toFixed(1) }

/** 迷你曲线。单点数字看不出「稳在 20」还是「正在爬」——曲线才是证据。
 *  只有一个点时**明说在等**，不要留一片空白让人以为是坏了：中心刚重启就是这个状态。 */
function Spark({ series, tone, waiting }: { series: number[]; tone: string; waiting: string }) {
  if (series.length < 2) return <div className="tt-hub-spark waiting">{waiting}</div>
  const max = Math.max(...series), min = Math.min(...series)
  const span = Math.max(1e-6, max - min)
  const pts = series.map((v, i) => `${(i / (series.length - 1)) * 200},${(24 - ((v - min) / span) * 22).toFixed(1)}`).join(' ')
  return (
    <svg className="tt-hub-spark" viewBox="0 0 200 26" preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: tone }} />
    </svg>
  )
}

function Stat({ label, value, unit, sub, series, tone, waiting }: {
  label: string; value: string; unit?: string; sub: string; series?: number[]; tone?: string; waiting: string
}) {
  return (
    <div className={`tt-hub-stat${tone === 'var(--danger)' ? ' bad' : tone === 'var(--warn)' ? ' warn' : ''}`}>
      <div className="k">{label}</div>
      <div className="v">{value}{unit && <span className="u">{unit}</span>}</div>
      <div className="s">{sub}</div>
      {series && <Spark series={series} tone={tone || 'var(--ok)'} waiting={waiting} />}
    </div>
  )
}

function NodeCard({ n, current, hubVersion, onEnter }: {
  n: ClusterNode; current: boolean; hubVersion: string; onEnter: () => void
}) {
  const { t } = useI18n()
  // 版本不一致会出怪事（前端和后端各说各话），而在这一页之前没有任何地方会告诉你
  const verMismatch = !!n.version && !!hubVersion && n.version !== hubVersion
  return (
    <div className={`tt-hub-node${current ? ' cur' : ''}${n.online ? '' : ' off'}`}>
      <div className="top">
        <NodeMark name={n.name} size="sm" current={current} offline={!n.online} />
        <span className="nm">{n.name}</span>
        {n.group && <span className="grp">{n.group}</span>}
        {n.hostname && <span className="grp">{n.hostname}</span>}
        <span className="grow" />
        {n.online
          ? <span className="lat">{t('node.latencyMs', { ms: n.latencyMs })}</span>
          : <span className="tt-hub-chip danger">{t('node.offline')}</span>}
        <i className="dot" style={{ background: nodeDotColor(n) }} />
      </div>
      <div className="meta">
        {n.online && <span>{t('node.sessionsN', { count: n.sessionCount })}</span>}
        {!!n.version && <span className="mono">{n.version}</span>}
        {verMismatch && <span className="tt-hub-chip warn">{t('hub.versionMismatch')}</span>}
        {(n.capabilities || []).length > 0 && (
          <span className="caps">{(n.capabilities || []).map((c) => <span key={c}>{c}</span>)}</span>
        )}
      </div>
      <div className="acts">
        <button type="button" className="tt-act" disabled={!n.online || current} onClick={onEnter}>
          {current ? t('hub.enterCurrent') : t('hub.enter')}
        </button>
      </div>
    </div>
  )
}

export default function HubPage() {
  const { t } = useI18n()
  const { message } = AntApp.useApp()
  const nodes = useClusterNodes()
  const curNodeId = useCurrentNodeId()
  const [self, setSelf] = useState<SelfData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let stop = false
    const load = () => getSelf().then((d) => { if (!stop) { setSelf(d); setLoading(false) } })
    load()
    const iv = setInterval(load, 15000)
    return () => { stop = true; clearInterval(iv) }
  }, [])

  if (loading) return <div className="tt-hub-empty">{t('common.loading')}</div>
  if (!self) return <div className="tt-hub-empty">{t('hub.notHub')}</div>

  const s = self.samples
  const now = self.now
  // 请求速率按相邻两点差分：累计量重启后会归零，差分自然断开，而不是画出一段假的「零流量」
  const rate = (() => {
    if (s.length < 2) return null // 只有一个点：算不出速率。显示 0 会被读成「没有流量」，那是另一回事
    const a = s[s.length - 2], b = s[s.length - 1]
    const dt = Math.max(1, b.at - a.at)
    return Math.max(0, (b.requests - a.requests) / dt)
  })()
  // 判色看**占宿主机的比例**，不看绝对值：299MB 在 1.6G 的机器上是灾难，在 16G 上不算事。
  // 今早那台就是 1.6G——当时只看到「299MB」，完全没意识到它已经把整台机器拖进换页颠簸。
  const host = self.host || ({} as Host)
  const rssShare = host.memTotal ? now.rss / host.memTotal : 0
  const rssTone = rssShare > 0.5 ? 'var(--danger)' : rssShare > 0.25 ? 'var(--warn)' : 'var(--ok)'
  const gorTone = now.goroutines > 5000 ? 'var(--danger)' : now.goroutines > 1000 ? 'var(--warn)' : 'var(--ok)'

  const uptime = (() => {
    const m = Math.floor(self.uptimeSecs / 60)
    if (m < 60) return t('hub.upMinutes', { n: m })
    const h = Math.floor(m / 60)
    return h < 24 ? t('hub.upHours', { n: h }) : t('hub.upDays', { n: Math.floor(h / 24) })
  })()

  const enter = (id: string) => {
    Modal.confirm({
      title: t('hub.enterTitle'),
      content: t('hub.enterBody'),
      okText: t('hub.enter'),
      cancelText: t('common.cancel'),
      onOk: () => { setCurrentNode(id); location.hash = '#/projects'; location.reload() },
    })
  }

  const evText = (e: HubEvent): string => {
    if (e.kind === 'hub_start') return t('hub.evHubStart')
    if (e.kind === 'enroll') return t('hub.evEnroll')
    if (e.kind === 'node_down') return t('hub.evNodeDown', { node: e.node || '' })
    if (e.kind === 'node_up') {
      return e.secs && e.secs > 0
        ? t('hub.evNodeBack', { node: e.node || '', secs: e.secs })
        : t('hub.evNodeUp', { node: e.node || '' })
    }
    return e.kind
  }
  const evTone = (k: string) => (k === 'node_down' ? 'var(--danger)' : k === 'hub_start' ? 'var(--warn)' : 'var(--ok)')

  // 进了这一页就该直接看到结论，不用自己去读四条曲线
  const health = assessHub(s, Math.max(0, self.nodes - self.nodesOnline))

  return (
    <div className="tt-hub">
      {health.level !== 'ok' && (
        <div className={`tt-hub-banner${health.level === 'bad' ? ' bad' : ''}`}>
          <WarnIcon size={16} />
          <span className="grow">{t('hub.unhealthy', { why: t('hub.why.' + health.reasons[0]) })}</span>
        </div>
      )}
      <div className="tt-hub-head">
        <span className="tt-pagename">{t('hub.title')}</span>
        <span className="tt-pagedivider" aria-hidden="true" />
        <span className="sub">{location.host} · {self.version || '—'} · {uptime}</span>
        <span className="grow" />
        <button type="button" className="tt-act" onClick={() => getSelf().then(setSelf)}>{t('hub.refresh')}</button>
      </div>

      <div className="tt-hub-stats">
        <Stat label={t('hub.memory')} value={String(mb(now.rss) || '—')} unit={now.rss ? 'MB' : undefined}
          sub={host.memTotal
            ? t('hub.ofHost', { pct: Math.round(rssShare * 100), total: gb(host.memTotal) })
            : t('hub.heapNow', { mb: mb(now.heap) })}
          series={s.map((x) => x.rss)} tone={rssTone}
          waiting={t('hub.needTwoSamples')} />
        <Stat label="Goroutine" value={now.goroutines.toLocaleString()}
          sub={t('hub.goroutineSub')} series={s.map((x) => x.goroutines)} tone={gorTone}
          waiting={t('hub.needTwoSamples')} />
        <Stat label={t('hub.tunnels')} value={String(now.tunnels)}
          sub={t('hub.tunnelsSub', { n: self.nodes })} series={s.map((x) => x.tunnels)} tone="var(--accent)"
          waiting={t('hub.needTwoSamples')} />
        <Stat label={t('hub.forwarded')} value={rate === null ? '—' : rate.toFixed(1)} unit={rate === null ? undefined : t('hub.perSec')}
          sub={t('hub.forwardedSub', { total: now.requests })} series={s.map((x) => x.requests)} tone="var(--accent)"
          waiting={t('hub.needTwoSamples')} />
      </div>

      {/* 左栏放会长的（机器卡片里有版本、能力芯片），右栏定宽放事件——
           事件行是「时间 + 一句话」，再宽也不多装一个字。 */}
      <div className="tt-hub-cols">
        <div className="tt-hub-side">
          <div className="tt-hub-card">
            <h4>{t('hub.machines')}<span className="grow" />
            <span className="dim">{t('hub.onlineOf', { online: self.nodesOnline, total: self.nodes })}</span>
            </h4>
            {nodes.length === 0
            ? <div className="tt-hub-empty small">{t('hub.noNodes')}</div>
            : nodes.map((n) => (
            <NodeCard key={n.id} n={n} current={n.id === curNodeId} hubVersion={self.version} onEnter={() => enter(n.id)} />
            ))}
          </div>
          {/* 宿主机单独一块，不混进上面四格：那四格问的是「中心这个进程」，
              这一块问的是「它跑在什么样的机器上」。节点那边的完整资源监控由
              roam.host-monitor 插件负责，中心不重复造——中心压根不跑插件宿主。 */}
          {!!host.memTotal && (
            <div className="tt-hub-card">
              <h4>{t('hub.host')}<span className="grow" />
                <span className="dim">{t('hub.hostCpus', { n: host.cpus })}</span>
              </h4>
              <div className="body">
                <div className="kv"><span>{t('hub.hostMem')}</span>
                  <b>{gb(host.memTotal - host.memAvailable)} / {gb(host.memTotal)} GB</b>
                  <span className="dim">{t('hub.hostAvail', { gb: gb(host.memAvailable) })}</span>
                </div>
                {host.swapTotal > 0 && (
                  <div className="kv"><span>Swap</span>
                    <b>{gb(host.swapTotal - host.swapFree)} / {gb(host.swapTotal)} GB</b>
                    <span className="dim">{host.swapTotal - host.swapFree > host.swapTotal * 0.2 ? t('hub.swapping') : ''}</span>
                  </div>
                )}
                <div className="kv"><span>{t('hub.load')}</span>
                  <b style={{ color: host.load1 > host.cpus * 2 ? 'var(--danger)' : host.load1 > host.cpus ? 'var(--warn)' : undefined }}>
                    {host.load1.toFixed(2)}
                  </b>
                  <span className="dim">{host.load5.toFixed(2)} · {host.load15.toFixed(2)}</span>
                </div>
                <p className="hint">{t('hub.hostWhy')}</p>
              </div>
            </div>
          )}

          <div className="tt-hub-card">
            <h4>{t('hub.diagnostics')}</h4>
            <div className="body">
            <div className="kv"><span>pprof</span>
            <b style={{ color: self.pprof ? 'var(--ok)' : 'var(--text-dimmer)' }}>
            {self.pprof ? t('hub.pprofOn') : t('hub.pprofOff')}
            </b>
            <span className="dim">{self.pprof || 'ROAM_PPROF'}</span>
            </div>
            <div className="kv"><span>{t('hub.samples')}</span><b>{s.length}</b>
            <span className="dim">{t('hub.samplesSub')}</span></div>
            {self.pprof && <div className="tt-hub-cmd">ssh -L 6060:{self.pprof} &lt;user&gt;@{location.hostname}</div>}
            <p className="hint">{t('hub.pprofWhy')}</p>
            <button type="button" className="tt-act" onClick={() => {
            const blob = new Blob([JSON.stringify(self, null, 2)], { type: 'application/json' })
            const a = document.createElement('a')
            a.href = URL.createObjectURL(blob)
            a.download = `roam-hub-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`
            a.click()
            URL.revokeObjectURL(a.href)
            message.success(t('hub.exported'))
            }}>{t('hub.export')}</button>
            </div>
          </div>
        </div>

        <div className="tt-hub-side">
          <div className="tt-hub-card">
            <h4>{t('hub.events')}<span className="grow" /><span className="dim">{t('hub.eventsWindow')}</span></h4>
            {self.events.length === 0
            ? <div className="tt-hub-empty small">{t('hub.noEvents')}</div>
            : [...self.events].reverse().slice(0, 12).map((e, i) => (
            <div className="tt-hub-ev" key={i}>
            <span className="t">{relTime(e.at, t)}</span>
            <i className="i" style={{ background: evTone(e.kind) }} />
            <span className="x">{evText(e)}</span>
            </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
