// 设置 › 多机（设计稿 docs/design/cluster/settings.html）。
//
// 第一屏不给表单，先让人选身份——多机最容易卡住的地方是「我这台该配成什么」。
// 文案里不出现 standard / cloud / frps / frpc，那是实现的说法：
//   这台机器 = 就是你现在用的这套，可选接到一个中心上，接上之后外网也能用它
//   中心     = 只当入口，自己不跑活，别的机器接进来后在这里访问它们全部
//
// 接入用的是**一次性令牌**，不是中心的登录口令——口令是给人登录浏览器用的。
// 这一条要写在界面上：用户第一反应就是去填密码。
import { useEffect, useState } from 'react'
import { App as AntApp, Button, Card, Input, Switch, Tag } from 'antd'
import { api } from '../api'
import { useI18n } from '../i18n'
import { CloudIcon, HostIcon, LanIcon } from './cluster-icons'

type NodeState = { connected: boolean; nodeId?: string; since?: string; lastError?: string; retrying?: boolean }
type Cfg = {
  mode: 'standard' | 'cloud'
  broker: string; name: string; group: string; insecure: boolean
  hasToken: boolean; state?: NodeState; lanUrls: string[]
}

/**
 * 设置页看的是**当前节点**的配置（请求带 /n/<id> 前缀）。中心自己的角色够不着——
 * 而那正好是「切成中心之后再也切不回来」的那个洞。所以经中心访问时，额外读一份
 * 不带前缀的 /api/cluster/config（那是中心本机的），单独给一张卡。
 */
function HubSelfCard() {
  const { t } = useI18n()
  const { message, modal } = AntApp.useApp()
  const [self, setSelf] = useState<Cfg | null>(null)
  useEffect(() => {
    fetch('/api/cluster/config', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((r) => setSelf(r?.data || null))
      .catch(() => {})
  }, [])
  if (!self || self.mode !== 'cloud') return null
  const backToNode = () => modal.confirm({
    title: t('cluster.hubToNodeTitle'),
    content: t('cluster.hubToNodeBody'),
    okText: t('cluster.hubToNodeOk'), cancelText: t('common.cancel'),
    onOk: async () => {
      await fetch('/api/cluster/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'standard', broker: '', name: self.name, group: self.group, insecure: false }),
      })
      message.success(t('cluster.savedRestartHub'))
    },
  })
  return (
    <Card title={t('cluster.hubSelfTitle')} extra={<Tag color="processing">{t('cluster.modeHub')}</Tag>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.9 }}>{t('cluster.hubSelfHelp')}</div>
        <div className="tt-ways">
          <div className="tt-way">
            <div className="h"><CloudIcon />{t('cluster.entryForPeople')}</div>
            {/* 中心的入口地址不能报网卡 IP：云主机上那是内网地址（172.17.x），
                用户永远输不进去。**你正在用的这个地址**才是对的答案，就在 location 里。 */}
            <div className="u">{location.origin}</div>
            <div className="n">{t('cluster.entryForPeopleHelp')}</div>
          </div>
        </div>
        <div><Button onClick={backToNode}>{t('cluster.hubToNode')}</Button></div>
      </div>
    </Card>
  )
}

export function ClusterSettings() {
  const { t } = useI18n()
  const { message, modal } = AntApp.useApp()
  const [cfg, setCfg] = useState<Cfg | null>(null)
  const [form, setForm] = useState<{ broker: string; token: string; name: string; group: string; insecure: boolean }>(
    { broker: '', token: '', name: '', group: '', insecure: false },
  )
  const [saving, setSaving] = useState(false)

  const load = () => api('GET', '/cluster/config').then((r) => {
    const c: Cfg = r?.data
    setCfg(c)
    setForm({ broker: c.broker || '', token: '', name: c.name || '', group: c.group || '', insecure: !!c.insecure })
  }).catch(() => {})

  useEffect(() => { load() }, [])
  // 接入状态是会自己变的（重连、掉线），停在旧值上比不显示更糟
  useEffect(() => {
    const id = window.setInterval(() => { api('GET', '/cluster/config').then((r) => setCfg(r?.data)).catch(() => {}) }, 5000)
    return () => window.clearInterval(id)
  }, [])

  if (!cfg) return null
  const isHub = cfg.mode === 'cloud'

  const save = async (mode: 'standard' | 'cloud', extra?: Partial<typeof form>) => {
    setSaving(true)
    try {
      const f = { ...form, ...extra }
      const r = await api('PUT', '/cluster/config', {
        mode,
        broker: mode === 'cloud' ? '' : f.broker.trim(),
        // 只在用户真填了新令牌时才传：不传 = 保留原来的
        token: f.token ? f.token.trim() : undefined,
        name: f.name, group: f.group, insecure: f.insecure,
      })
      if (r?.data?.needsRestart) restartPrompt()
      else message.success(t('cluster.saved'))
      load()
    } catch (e: any) {
      message.error(e?.message || t('cluster.saveFailed'))
    } finally { setSaving(false) }
  }

  const restartPrompt = () => modal.confirm({
    title: t('cluster.restartTitle'),
    content: t('cluster.restartBody'),
    okText: t('cluster.restartNow'), cancelText: t('cluster.restartLater'),
    onOk: async () => {
      await api('POST', '/cluster/restart').catch(() => {})
      message.loading(t('cluster.restarting'), 6)
      // 等它自己回来：/api/version 是免登录的，最轻
      const t0 = Date.now()
      const tick = window.setInterval(async () => {
        try {
          await fetch('/api/version', { cache: 'no-store' })
          window.clearInterval(tick); location.reload()
        } catch { if (Date.now() - t0 > 30000) window.clearInterval(tick) }
      }, 1500)
    },
  })

  const switchMode = (next: 'standard' | 'cloud') => {
    if (next === cfg.mode) return
    // 只有「这台机器 → 中心」需要拦：那个方向真会丢东西（终端断、项目不见）。
    // 反过来只是把本机能力重新打开，没有东西会消失。
    if (next === 'cloud') {
      modal.confirm({
        title: t('cluster.toHubTitle'),
        content: <div style={{ lineHeight: 1.9 }}>{t('cluster.toHubBody')}</div>,
        okText: t('cluster.toHubOk'), cancelText: t('common.cancel'),
        okButtonProps: { danger: true },
        onOk: () => save('cloud'),
      })
      return
    }
    save('standard')
  }

  const st = cfg.state
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card title={t('cluster.roleTitle')}>
        <div className="tt-modes">
          <button type="button" className={`tt-mode${!isHub ? ' on' : ''}`} onClick={() => switchMode('standard')}>
            <span className="radio" />
            <span className="t"><HostIcon />{t('cluster.modeNode')}{!isHub && <Tag color="success" style={{ marginInlineStart: 4 }}>{t('cluster.current')}</Tag>}</span>
            <span className="d">{t('cluster.modeNodeDesc')}</span>
          </button>
          <button type="button" className={`tt-mode${isHub ? ' on' : ''}`} onClick={() => switchMode('cloud')}>
            <span className="radio" />
            <span className="t"><CloudIcon />{t('cluster.modeHub')}{isHub && <Tag color="success" style={{ marginInlineStart: 4 }}>{t('cluster.current')}</Tag>}</span>
            <span className="d">{t('cluster.modeHubDesc')}</span>
          </button>
        </div>
      </Card>

      {!isHub && (
        <Card title={t('cluster.joinTitle')} extra={
          <Tag color={st?.connected ? 'success' : cfg.broker ? 'warning' : 'default'}>
            {st?.connected ? t('cluster.connected') : cfg.broker ? t('cluster.connecting') : t('cluster.notJoined')}
          </Tag>
        }>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className={`tt-cstate${st?.connected ? ' ok' : cfg.broker ? ' warn' : ''}`}>
              <i className="d" />
              {st?.connected
                ? <span>{t('cluster.joinedTo', { broker: cfg.broker })}</span>
                : cfg.broker
                  ? <span>{t('cluster.connectingTo', { broker: cfg.broker })}</span>
                  : <span>{t('cluster.notJoinedHelp')}</span>}
              {/* 上次为什么没连上——令牌过期 / 凭证失效 / 地址不是中心，三种的下一步完全不同。
                  这句话以前只进日志，用户得去翻 journalctl 才看得到。 */}
              {!st?.connected && st?.lastError && <span className="err">{st.lastError}</span>}
            </div>

            <div className="tt-crow">
              <label className="tt-cf">
                <span>{t('cluster.brokerAddr')}</span>
                <Input value={form.broker} placeholder="https://…"
                  onChange={(e) => setForm({ ...form, broker: e.target.value })} />
                <em>{t('cluster.brokerHelp')}</em>
              </label>
              <label className="tt-cf">
                <span>{t('cluster.token')} <Tag>{t('cluster.tokenOnce')}</Tag></span>
                <Input.Password value={form.token}
                  placeholder={cfg.hasToken ? t('cluster.tokenKeep') : t('cluster.tokenPlaceholder')}
                  onChange={(e) => setForm({ ...form, token: e.target.value })} />
                <em>{t('cluster.tokenHelp')}</em>
              </label>
            </div>
            <div className="tt-crow">
              <label className="tt-cf">
                <span>{t('cluster.nodeName')}</span>
                <Input value={form.name} placeholder={t('cluster.nodeNamePlaceholder')}
                  onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>
              <label className="tt-cf">
                <span>{t('cluster.groupName')}</span>
                <Input value={form.group} placeholder={t('cluster.optional')}
                  onChange={(e) => setForm({ ...form, group: e.target.value })} />
              </label>
            </div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-dim)' }}>
              <Switch size="small" checked={form.insecure} onChange={(v) => setForm({ ...form, insecure: v })} />
              {t('cluster.insecure')}
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button type="primary" loading={saving} onClick={() => save('standard')}>{t('cluster.saveJoin')}</Button>
              {cfg.broker && (
                <Button danger onClick={() => modal.confirm({
                  title: t('cluster.leaveTitle'), content: t('cluster.leaveBody'),
                  okText: t('cluster.leave'), cancelText: t('common.cancel'), okButtonProps: { danger: true },
                  onOk: () => save('standard', { broker: '', token: '' }),
                })}>{t('cluster.leave')}</Button>
              )}
            </div>
          </div>
        </Card>
      )}

      <HubSelfCard />

      <Card title={isHub ? t('cluster.hubEntry') : t('cluster.howToReach')}
        extra={!isHub && <Tag>{t('cluster.bothWork')}</Tag>}>
        <div className="tt-ways">
          <div className="tt-way">
            <div className="h"><LanIcon />{isHub ? t('cluster.entryForPeople') : t('cluster.lanDirect')}</div>
            {(cfg.lanUrls.length ? cfg.lanUrls : ['—']).map((u) => <div key={u} className="u">{u}</div>)}
            <div className="n">{isHub ? t('cluster.entryForPeopleHelp') : t('cluster.lanDirectHelp')}</div>
          </div>
          {!isHub && (
            <div className="tt-way">
              <div className="h"><CloudIcon />{t('cluster.viaHub')}</div>
              <div className="u">{cfg.broker || t('cluster.notJoined')}</div>
              <div className="n">{t('cluster.viaHubHelp')}</div>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
