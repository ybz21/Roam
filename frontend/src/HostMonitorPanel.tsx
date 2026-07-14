// 主机监控仪表盘(roam.host-monitor 插件的宿主侧面板):轮询插件 stats
// 命令,展示 CPU/GPU/内存/磁盘/网络实时状态与趋势。趋势历史由插件在
// StorageDir 持久化,面板打开即有近期曲线,不依赖页面常驻。
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, Card, Empty, Progress, Segmented, Space, Spin, Tag, Tooltip, Typography } from 'antd'
import { api } from './api'

type HistoryDot = { t: number; cpu: number; mem: number; gpu: number; rx: number; tx: number }

type Snapshot = {
  time: string
  host: {
    hostname: string; os?: string; kernel?: string; arch?: string
    uptimeSec?: number; load1: number; load5: number; load15: number
  }
  cpu: { model?: string; cores: number; usagePercent: number; perCore?: number[]; tempC?: number }
  memory: {
    total: number; used: number; available: number; usagePercent: number
    swapTotal: number; swapUsed: number
  }
  disks: { device: string; mount: string; fsType: string; total: number; used: number; free: number; usagePercent: number }[] | null
  gpus: {
    index: number; name: string; utilPercent: number; memUsed: number; memTotal: number
    tempC: number; powerW: number; powerLimitW: number; fanPercent: number; memUsagePercent: number
  }[] | null
  network: { rxBytesPerSec: number; txBytesPerSec: number }
  history: HistoryDot[] | null
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

function fmtBytes(n: number, perSec = false): string {
  let v = n
  let u = 0
  while (v >= 1024 && u < UNITS.length - 1) { v /= 1024; u++ }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${UNITS[u]}${perSec ? '/s' : ''}`
}

function usageColor(p: number): string {
  if (p >= 90) return '#f5222d'
  if (p >= 70) return '#faad14'
  return '#52c41a'
}

// ── 轻量 SVG 面积走势图(不引图表库) ──
function Sparkline({ series, color, max, height = 46 }: {
  series: number[]; color: string; max?: number; height?: number
}) {
  const W = 300
  const H = 60
  if (series.length < 2) return <div style={{ height }} />
  const top = max ?? Math.max(...series, 1e-9) * 1.1
  const pts = series.map((v, i) => {
    const x = (i / (series.length - 1)) * W
    const y = H - (Math.min(v, top) / top) * (H - 4) - 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }}>
      <polygon points={`0,${H} ${pts.join(' ')} ${W},${H}`} fill={color} opacity={0.15} />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  )
}

function StatCard({ title, extra, children }: {
  title: ReactNode; extra?: ReactNode; children: ReactNode
}) {
  return (
    <Card size="small" title={title} extra={extra}
      styles={{ body: { padding: 12 } }} style={{ minWidth: 0 }}>
      {children}
    </Card>
  )
}

export default function HostMonitorPanel({ pluginId, enabled, t }: {
  pluginId: string
  enabled: boolean
  t: (k: string, vars?: Record<string, string | number>) => string
}) {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  const [intervalSec, setIntervalSec] = useState(3)
  const busy = useRef(false)

  const poll = useCallback(async () => {
    if (busy.current || document.hidden) return
    busy.current = true
    try {
      const data = await api('POST', `/plugins/${encodeURIComponent(pluginId)}/run`,
        { command: 'host-monitor.stats', args: {} })
      setSnap(data)
      setError('')
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      busy.current = false
    }
  }, [pluginId])

  useEffect(() => {
    if (!enabled) return
    poll()
    const timer = setInterval(poll, intervalSec * 1000)
    return () => clearInterval(timer)
  }, [poll, intervalSec, enabled])

  if (!enabled) return <Alert type="warning" showIcon message={t('plugins.monitor.enableHint')} />
  if (error && !snap) return <Alert type="error" showIcon message={t('plugins.monitor.loadFailed')} description={error} />
  if (!snap) return <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>

  const { host, cpu, memory, disks, gpus, network } = snap
  const history = snap.history || []
  const uptime = host.uptimeSec
    ? t('plugins.monitor.uptimeDH', { d: Math.floor(host.uptimeSec / 86400), h: Math.floor((host.uptimeSec % 86400) / 3600) })
    : ''

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {/* 头部:主机信息 + 刷新频率 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <Typography.Text strong>{host.hostname}</Typography.Text>
        {host.os && <Tag>{host.os}</Tag>}
        {host.kernel && <Tag>{host.kernel}</Tag>}
        {host.arch && <Tag>{host.arch}</Tag>}
        {uptime && <Tag>{t('plugins.monitor.uptime')} {uptime}</Tag>}
        <Tooltip title={t('plugins.monitor.loadTip')}>
          <Tag>{t('plugins.monitor.load')} {host.load1} / {host.load5} / {host.load15}</Tag>
        </Tooltip>
        <span style={{ flex: 1 }} />
        {error && <Tag color="red">{t('plugins.monitor.pollFailed')}</Tag>}
        <Segmented size="small" value={intervalSec}
          options={[3, 5, 10].map((s) => ({ label: `${s}s`, value: s }))}
          onChange={(v) => setIntervalSec(v as number)} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        {/* CPU */}
        <StatCard
          title={<Space size={6}>{t('plugins.monitor.cpu')}
            <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
              {cpu.model} · {t('plugins.monitor.cores', { n: cpu.cores })}</Typography.Text></Space>}
          extra={cpu.tempC ? <Tag>{cpu.tempC}°C</Tag> : null}>
          <Space align="center" size={16} style={{ width: '100%' }}>
            <Progress type="dashboard" size={88} percent={Math.round(cpu.usagePercent)}
              strokeColor={usageColor(cpu.usagePercent)} />
            <div style={{ flex: 1, minWidth: 0, alignSelf: 'stretch', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
              <Sparkline series={history.map((h) => h.cpu)} color="#58a6ff" max={100} />
            </div>
          </Space>
          {!!cpu.perCore?.length && (
            <div style={{ display: 'flex', gap: 2, marginTop: 8, alignItems: 'flex-end', height: 26 }}>
              {cpu.perCore.map((p, i) => (
                <Tooltip key={i} title={`#${i}: ${p}%`}>
                  <div style={{ flex: 1, height: Math.max(2, (p / 100) * 26), background: usageColor(p), borderRadius: 1, opacity: 0.85 }} />
                </Tooltip>
              ))}
            </div>
          )}
        </StatCard>

        {/* 内存 */}
        <StatCard
          title={t('plugins.monitor.memory')}
          extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {fmtBytes(memory.used)} / {fmtBytes(memory.total)}</Typography.Text>}>
          <Space align="center" size={16} style={{ width: '100%' }}>
            <Progress type="dashboard" size={88} percent={Math.round(memory.usagePercent)}
              strokeColor={usageColor(memory.usagePercent)} />
            <div style={{ flex: 1, minWidth: 0, alignSelf: 'stretch', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
              <Sparkline series={history.map((h) => h.mem)} color="#d2a8ff" max={100} />
            </div>
          </Space>
          {memory.swapTotal > 0 && (
            <div style={{ marginTop: 8 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Swap {fmtBytes(memory.swapUsed)} / {fmtBytes(memory.swapTotal)}
              </Typography.Text>
              <Progress percent={Math.round((memory.swapUsed / memory.swapTotal) * 100)}
                showInfo={false} size="small" strokeColor="#8b949e" />
            </div>
          )}
        </StatCard>

        {/* GPU */}
        <StatCard title={t('plugins.monitor.gpu')}
          extra={gpus?.length ? <Tag>{gpus.length}</Tag> : null}>
          {gpus?.length ? gpus.map((g) => (
            <div key={g.index} style={{ marginBottom: gpus.length > 1 ? 12 : 0 }}>
              <Space size={6} wrap style={{ marginBottom: 4 }}>
                <Typography.Text style={{ fontSize: 13 }}>{g.name}</Typography.Text>
                <Tag>{g.tempC}°C</Tag>
                {g.powerLimitW > 0 && <Tag>{g.powerW}/{g.powerLimitW}W</Tag>}
                {g.fanPercent > 0 && <Tag>{t('plugins.monitor.fan')} {g.fanPercent}%</Tag>}
              </Space>
              <Space align="center" size={16} style={{ width: '100%' }}>
                <Progress type="dashboard" size={88} percent={Math.round(g.utilPercent)}
                  strokeColor={usageColor(g.utilPercent)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Sparkline series={history.map((h) => h.gpu)} color="#7ee787" max={100} />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('plugins.monitor.vram')} {fmtBytes(g.memUsed)} / {fmtBytes(g.memTotal)}
                  </Typography.Text>
                  <Progress percent={Math.round(g.memUsagePercent)} showInfo={false} size="small"
                    strokeColor={usageColor(g.memUsagePercent)} />
                </div>
              </Space>
            </div>
          )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('plugins.monitor.noGpu')} />}
        </StatCard>

        {/* 网络 */}
        <StatCard title={t('plugins.monitor.network')}
          extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>
            ↓ {fmtBytes(network.rxBytesPerSec, true)} · ↑ {fmtBytes(network.txBytesPerSec, true)}
          </Typography.Text>}>
          <Sparkline series={history.map((h) => h.rx)} color="#79c0ff" height={40} />
          <Sparkline series={history.map((h) => h.tx)} color="#ffa657" height={40} />
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <span style={{ color: '#79c0ff' }}>■</span> {t('plugins.monitor.rx')}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <span style={{ color: '#ffa657' }}>■</span> {t('plugins.monitor.tx')}
            </Typography.Text>
          </div>
        </StatCard>
      </div>

      {/* 磁盘 */}
      <StatCard title={t('plugins.monitor.disk')}>
        {disks?.length ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '4px 24px' }}>
            {disks.map((d) => (
              <div key={d.device + d.mount}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <Typography.Text ellipsis={{ tooltip: `${d.device} (${d.fsType})` }} style={{ fontSize: 13 }}>
                    {d.mount}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                    {fmtBytes(d.used)} / {fmtBytes(d.total)}
                  </Typography.Text>
                </div>
                <Progress percent={Math.round(d.usagePercent)} size="small"
                  strokeColor={usageColor(d.usagePercent)} />
              </div>
            ))}
          </div>
        ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}
      </StatCard>
    </Space>
  )
}
