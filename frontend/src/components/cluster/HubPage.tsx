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
import HostMonitorPanel, { type Snapshot } from '../plugins/HostMonitorPanel'
import { WarnIcon } from '../../icons'

type Sample = { at: number; rss: number; goroutines: number; heap: number; tunnels: number; requests: number }
type HubEvent = { at: number; kind: string; node?: string; secs?: number }
type Host = {
  memTotal: number; memAvailable: number; swapTotal: number; swapFree: number
  load1: number; load5: number; load15: number; cpus: number
  cpuPercent: number; hostname: string; uptimeSecs: number
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

/**
 * 把 /api/hub/self 映射成 host-monitor 插件那套 Snapshot——**为了复用同一个面板**。
 *
 * 中心没有插件宿主（NewHub 不构造业务 runtime），所以拿不到插件的数据；但面板只认形状，
 * 不认来源。与其为中心重画一套监控 UI（然后两套长期不同步、术语还不一致），
 * 不如在这里做一次映射。缺的字段照实留空：中心不采 GPU 与磁盘，disks/gpus 就是 null，
 * 面板本来就按「没有这一节」处理；网络给 0 而不是假数，因为面板会硬取这两个字段。
 */
function hubSnapshot(d: SelfData): Snapshot {
  const h = d.host || ({} as Host)
  const used = Math.max(0, h.memTotal - h.memAvailable)
  return {
    time: new Date().toISOString(),
    host: {
      hostname: h.hostname || location.hostname,
      uptimeSec: h.uptimeSecs, load1: h.load1, load5: h.load5, load15: h.load15,
    },
    cpu: { cores: h.cpus, usagePercent: h.cpuPercent || 0 },
    memory: {
      total: h.memTotal, used, available: h.memAvailable,
      usagePercent: h.memTotal ? (used / h.memTotal) * 100 : 0,
      swapTotal: h.swapTotal, swapUsed: Math.max(0, h.swapTotal - h.swapFree),
    },
    disks: null,
    gpus: null,
    network: { rxBytesPerSec: 0, txBytesPerSec: 0 },
    // 历史直接用中心自己的采样：5 分钟一点，比插件的 3 秒粗，但它问的本来就是「有没有在爬」
    history: (d.samples || []).map((x) => ({
      t: x.at, cpu: 0, gpu: 0, rx: 0, tx: 0,
      mem: h.memTotal ? (x.rss / h.memTotal) * 100 : 0,
    })),
  }
}
function gb(bytes: number): string { return (bytes / 1024 / 1024 / 1024).toFixed(1) }

/** 迷你曲线。单点数字看不出「稳在 20」还是「正在爬」——曲线才是证据。
 *  只有一个点时**明说在等**，不要留一片空白让人以为是坏了：中心刚重启就是这个状态。 */
function Spark({ series, tone, waiting }: { series: number[]; tone: string; waiting: string }) {
  if (series.length < 2) return <div className="tt-hub-spark waiting">{waiting}</div>
  const max = Math.max(...series), min = Math.min(...series)
  const span = Math.max(1e-6, max - min)
  const pts = series.map((v, i) => `${(i / (series.length - 1)) * 60},${(18 - ((v - min) / span) * 16).toFixed(1)}`).join(' ')
  return (
    <svg className="tt-hub-spark" viewBox="0 0 60 20" preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: tone }} />
    </svg>
  )
}

/**
 * 一格指标。它们不等重要：平时你只想知道「正常吗」，异常时才想看具体数字。
 * 所以做成一条紧凑的横条而不是四张等大的卡片——四张 133px 高的卡片占掉三分之一首屏，
 * 却只传达了「一切正常」这一件事，而你最常看的机器列表被挤到下面去了。
 */
function Stat({ label, value, unit, sub, series, tone, waiting }: {
  label: string; value: string; unit?: string; sub: string; series?: number[]; tone?: string; waiting: string
}) {
  const bad = tone === 'var(--danger)' || tone === 'var(--warn)'
  return (
    <div className={`tt-hub-stat${bad ? ' bad' : ''}`}>
      <div className="line">
        <span className="k">{label}</span>
        <span className="v" style={bad ? { color: tone } : undefined}>{value}{unit && <span className="u">{unit}</span>}</span>
      </div>
      <div className="line2">
        <span className="s" title={sub}>{sub}</span>
        {series && series.length >= 2
          ? <Spark series={series} tone={tone || 'var(--ok)'} waiting={waiting} />
          : <span className="wait" title={waiting} />}
      </div>
    </div>
  )
}

/**
 * 拉某台节点的宿主机概况。**复用现成的 host-monitor 插件**，中心不重画监控——
 * 中心本来就是反代，这条路几乎白拿：/n/<id>/api/plugins/<插件>/run 就是节点自己那套。
 *
 * 只取两个数（CPU% / 内存%）做摘要，完整的 CPU/GPU/磁盘/网络 + 历史曲线仍在那台机器的
 * 插件面板里——在这里重画一遍监控 UI 是白费力气，还会和插件面板长期不同步。
 */
async function nodeHostSummary(nodeId: string): Promise<{ cpu: number; mem: number } | null> {
  try {
    const r = await fetch(`/n/${encodeURIComponent(nodeId)}/api/plugins/roam.host-monitor/run`, {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'host-monitor.stats', args: {} }),
    })
    if (!r.ok) return null // 插件没装/没开：这台就不显示，不报错
    // 经反代回来的是插件的原始返回：Snapshot 在**顶层**，没有 data 包装
    // （节点侧的 PluginRun 直接把插件结果写回；踩过一次，按 .data 取会永远拿到 undefined）
    const j = await r.json()
    const snap = (j?.data ?? j) as { cpu?: { usagePercent: number }; memory?: { usagePercent: number } }
    if (!snap?.cpu || !snap?.memory) return null
    return { cpu: Math.round(snap.cpu.usagePercent), mem: Math.round(snap.memory.usagePercent) }
  } catch { return null }
}

function NodeCard({ n, current, hubVersion, onEnter, onMonitor }: {
  n: ClusterNode; current: boolean; hubVersion: string; onEnter: () => void; onMonitor: () => void
}) {
  const { t } = useI18n()
  // 宿主概况按需拉，失败就当没有——插件可能没装、没开，或者那台正忙
  const [host, setHost] = useState<{ cpu: number; mem: number } | null>(null)
  // CPU% 是「两次取样之间的平均」，所以面板每次轮询都要真的再问一次中心，
  // 拿 15 秒前那份缓存重算的话，这个数会永远停在上一轮（实测停在 0%）。
  useEffect(() => {
    if (!n.online) return
    let stop = false
    const load = () => nodeHostSummary(n.id).then((h) => { if (!stop) setHost(h) })
    load()
    const iv = setInterval(load, 30000)
    return () => { stop = true; clearInterval(iv) }
  }, [n.id, n.online])
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
        {host && (
          <span className="tt-hub-host">
            <span className={host.cpu > 85 ? 'hot' : ''}>CPU {host.cpu}%</span>
            <span className={host.mem > 85 ? 'hot' : ''}>{t('hub.memShort')} {host.mem}%</span>
          </span>
        )}
        {/* 能力清单退到 title：六个芯片天天不变，却每台机器占一整行。
            它回答的是「这台能干什么」——一年问一次的事，不该常驻。 */}
        {(n.capabilities || []).length > 0 && (
          <span className="caps" title={(n.capabilities || []).join(' · ')}>
            {(n.capabilities || []).length} {t('hub.caps')}
          </span>
        )}
      </div>
      <div className="acts">
        <button type="button" className="tt-act" disabled={!n.online || current} onClick={onEnter}>
          {current ? t('hub.enterCurrent') : t('hub.enter')}
        </button>
        {host && (
          <button type="button" className="tt-act" onClick={onMonitor}>{t('hub.fullMonitor')}</button>
        )}
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
  const [hostOpen, setHostOpen] = useState(false)
  const [monitorNode, setMonitorNode] = useState<ClusterNode | null>(null)

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

      {/* 左栏只放主体（机器）——那是这一页最常看的东西；右栏收次要的三块。
           之前左栏排三块、右栏只有事件，右边空一大片而左边挤成一长条。 */}
      <div className="tt-hub-cols">
        <div className="tt-hub-side">
          <div className="tt-hub-card">
            <h4>{t('hub.machines')}<span className="grow" />
            <span className="dim">{t('hub.onlineOf', { online: self.nodesOnline, total: self.nodes })}</span>
            </h4>
            {nodes.length === 0
            ? <div className="tt-hub-empty small">{t('hub.noNodes')}</div>
            : nodes.map((n) => (
            <NodeCard key={n.id} n={n} current={n.id === curNodeId} hubVersion={self.version}
              onEnter={() => enter(n.id)} onMonitor={() => setMonitorNode(n)} />
            ))}
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
          {/* 宿主机这一块用的是**插件页那个面板**，不是另画一套：面板只认 Snapshot 形状，
              中心把 /api/hub/self 映射过去即可（见 hubSnapshot）。默认收起——上面四格已经
              给了结论，这里是「要细看时」的地方。 */}
          {!!host.memTotal && (
            <div className="tt-hub-card">
              <h4>{t('hub.host')}<span className="grow" />
                <span className="dim">
                  {t('hub.hostBrief', { pct: Math.round(((host.memTotal - host.memAvailable) / host.memTotal) * 100), load: host.load1.toFixed(2) })}
                </span>
                <button type="button" className="tt-act" onClick={() => setHostOpen((v) => !v)}>
                  {hostOpen ? t('hub.collapse') : t('hub.expand')}
                </button>
              </h4>
              {hostOpen && (
                <div className="body">
                  <HostMonitorPanel pluginId="roam.host-monitor" enabled t={t} fetchSnapshot={async () => hubSnapshot((await getSelf()) || self)} />
                </div>
              )}
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
      </div>

      {monitorNode && (
        <Modal open width={900} footer={null} title={monitorNode.name}
          onCancel={() => setMonitorNode(null)} destroyOnClose>
          {/* 同一个面板，取数换成「经中心反代拉那台的插件」——中心不重画监控 UI */}
          <HostMonitorPanel pluginId="roam.host-monitor" enabled t={t} fetchSnapshot={async () => {
            const r = await fetch(`/n/${encodeURIComponent(monitorNode.id)}/api/plugins/roam.host-monitor/run`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
              body: JSON.stringify({ command: 'host-monitor.stats', args: {} }),
            })
            if (!r.ok) throw new Error(String(r.status))
            const j = await r.json()
            return (j?.data ?? j) as Snapshot
          }} />
        </Modal>
      )}
    </div>
  )
}
