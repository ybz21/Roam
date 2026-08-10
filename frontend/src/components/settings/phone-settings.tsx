// 手机/Android 后端配置：本地 redroid / 远程 redroid / 真机 三选一 + adb 地址。
// Android 与 iOS 互斥（active 决定哪个驱动镜像页），未装依赖时开关会先自动装。
import { useEffect, useRef, useState } from 'react'
import { App as AntApp, AutoComplete, Button, Card, Segmented, Space, Switch, Tag } from 'antd'
import { api } from '../../api'
import { useI18n } from '../../i18n'

type PhoneCfg = { active: '' | 'android' | 'ios'; android: { mode: string; address: string; resolution: string }; ios: { mode: string; address: string } }
const PHONE_DEFAULT: PhoneCfg = { active: 'android', android: { mode: 'local', address: 'localhost:5555', resolution: '' }, ios: { mode: 'simulator', address: '' } }

export function PhoneSettings() {
  // 两张卡片：Android / iOS，各自配置(互不覆盖)；active 决定哪个驱动镜像。
  const { t } = useI18n()
  const { message } = AntApp.useApp()
  const [cfg, setCfg] = useState<PhoneCfg>(PHONE_DEFAULT)
  const cfgRef = useRef(cfg)
  const [status, setStatus] = useState<any>({})
  const [devs, setDevs] = useState<{ android: any[]; ios: any[] }>({ android: [], ios: [] })
  const [plat, setPlat] = useState<{ android: { installed: boolean }; ios: { installed: boolean; supported: boolean } }>({ android: { installed: false }, ios: { installed: false, supported: false } })
  const [installing, setInstalling] = useState<'android' | 'ios' | null>(null)
  const [busy, setBusy] = useState('')
  const [log, setLog] = useState('')
  useEffect(() => { cfgRef.current = cfg }, [cfg])

  const loadStatus = () => api('GET', '/phone/status').then((r) => { if (r?.data) setStatus(r.data) }).catch(() => {})
  const loadDevices = (p: 'android' | 'ios') => api('GET', `/phone/devices?platform=${p}`).then((r) => { if (r?.data) setDevs((s) => ({ ...s, [p]: r.data })) }).catch(() => {})
  const loadPlatforms = () => api('GET', '/phone/platforms').then((r) => { if (r?.data) setPlat({ android: { installed: !!r.data.android?.installed }, ios: { installed: !!r.data.ios?.installed, supported: !!r.data.ios?.supported } }) }).catch(() => {})
  useEffect(() => {
    api('GET', '/phone/config').then((r) => { if (r?.data) setCfg({ ...PHONE_DEFAULT, ...r.data, android: { ...PHONE_DEFAULT.android, ...r.data.android }, ios: { ...PHONE_DEFAULT.ios, ...r.data.ios } }) }).catch(() => {})
    loadPlatforms(); loadStatus(); loadDevices('android'); loadDevices('ios')
    const iv = setInterval(loadStatus, 3000) // 状态灯后台自动刷新
    return () => clearInterval(iv)
  }, [])

  const persist = (next: PhoneCfg) => { setCfg(next); cfgRef.current = next; return api('PUT', '/phone/config', next).then(loadStatus).catch((e: any) => message.error(e.message)) }
  const patch = (p: 'android' | 'ios', d: any) => persist({ ...cfgRef.current, [p]: { ...cfgRef.current[p], ...d } })
  const editAddr = (p: 'android' | 'ios', a: string) => setCfg((c) => { const n = { ...c, [p]: { ...c[p], address: a } }; cfgRef.current = n; return n })
  const blurPersist = () => api('PUT', '/phone/config', cfgRef.current).then(loadStatus).catch(() => {})

  // 开关：开=激活(互斥+未装先装)；关=未启用。
  const toggle = async (p: 'android' | 'ios', on: boolean) => {
    if (busy || installing) return
    if (!on) { if (cfg.active === p) persist({ ...cfgRef.current, active: '' }); return }
    if (!plat[p].installed) {
      setInstalling(p); setLog('')
      try {
        const r = await api('POST', '/phone/install', { platform: p })
        setLog(r?.data?.log || r?.error || '')
        if (!r?.data?.installed) { message.error(t('phone.installFailed')); setInstalling(null); return }
        setPlat((s) => ({ ...s, [p]: { ...s[p], installed: true } }))
      } catch (e: any) { message.error(e.message); setInstalling(null); return }
      setInstalling(null)
    }
    persist({ ...cfgRef.current, active: p }); loadDevices(p)
  }
  const act = async (name: string, endpoint: string) => {
    setBusy(name); setLog('')
    try {
      const r = await api('POST', endpoint, {})
      if (r?.error) { message.error(r.error); setLog(r.error) }
      if (r?.data?.log) setLog(r.data.log)
      const h = r?.data?.health || r?.data
      if (h?.error) message.warning(h.error)
    } catch (e: any) { message.error(e.message) } finally { setBusy(''); loadStatus() }
  }
  const dim = { color: 'var(--text-dim)', fontSize: 12 }
  const st = status || {}

  const renderCard = (p: 'android' | 'ios') => {
    const c = cfg[p] as any
    const active = cfg.active === p
    const inst = plat[p].installed
    const sup = p === 'ios' ? plat.ios.supported : true
    const isA = p === 'android'
    const needAddr = isA ? c.mode !== 'local' : true
    const isNet = isA && (c.address || '').includes(':')
    const canSS = (isA && c.mode === 'local') || (!isA && c.mode === 'simulator')
    const sources = isA
      ? [{ label: t('phone.mode.local'), value: 'local' }, { label: t('phone.mode.remote'), value: 'remote' }, { label: t('phone.mode.device'), value: 'device' }]
      : [{ label: t('phone.ios.simulator'), value: 'simulator' }, { label: t('phone.ios.device'), value: 'device' }]
    const opts = (devs[p] || []).map((d: any) => ({ value: d.id, label: `${d.name} (${d.id})${d.kind && d.kind !== 'android' ? ' · ' + d.kind : ''}` }))
    // 切来源要连地址一起换：每种来源的目标地址各自独立(本地 redroid=loopback / 远程=待填 / 真机=默认设备)。
    // 否则从「本地 redroid」切到「真机」会把 localhost:5555 带过去，adb 一直连不存在的 loopback，真机被忽略→连不上。
    const changeSrc = (m: string) => patch(p, isA ? { mode: m, address: m === 'local' ? 'localhost:5555' : '' } : { mode: m, address: '' })
    return (
      <Card size="small" title={
        <Space align="center">
          <Switch checked={active} loading={installing === p} onChange={(on) => toggle(p, on)} />
          <b>{t('phone.platform.' + p)}</b>
          <Tag color={inst ? 'green' : 'default'}>{inst ? t('phone.installedTag') : t('phone.notInstalled')}</Tag>
          {p === 'ios' && !sup && <span style={dim}>{t('phone.iosMacOnly')}</span>}
        </Space>
      }>
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <span style={dim}>{t('phone.source')}</span>
            <Segmented value={c.mode} onChange={(v) => changeSrc(v as string)} options={sources} />
          </Space>
          {needAddr && (
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Space.Compact style={{ width: '100%', maxWidth: 380 }}>
                <AutoComplete value={c.address} onChange={(a) => editAddr(p, a)} onBlur={blurPersist} options={opts} style={{ width: '100%' }}
                  placeholder={isA ? t('phone.addrPlaceholder') : t('phone.addrPlaceholderIOS')}
                  filterOption={(i, o) => String(o?.value || '').toLowerCase().includes(i.toLowerCase())} />
                <Button onClick={() => loadDevices(p)}>{t('phone.refreshDevices')}</Button>
              </Space.Compact>
              <span style={dim}>{isA ? (c.mode === 'remote' ? t('phone.addrHelpRemote') : t('phone.addrHelpDevice')) : t('phone.addrHelpIOS')}</span>
            </Space>
          )}
          {isA && c.mode !== 'device' && (
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <span style={dim}>{t('phone.resolution')}</span>
              <Segmented value={c.resolution || 'phone'} onChange={(v) => patch(p, { resolution: (v as string) === 'phone' ? '' : v })}
                options={[{ label: t('phone.res.phone'), value: 'phone' }, { label: t('phone.res.tablet'), value: 'tablet' },
                  { label: t('phone.res.tabletLand'), value: 'tablet-land' }, { label: t('phone.res.tabletLarge'), value: 'tablet-large' }]} />
            </Space>
          )}
          {/* 动作条 + 状态：仅激活卡片（动作作用于当前激活平台） */}
          {active ? (
            <>
              <Space wrap>
                <Button type="primary" loading={busy === 'auto'} onClick={() => act('auto', '/phone/auto')}>{t('phone.auto')}</Button>
                {canSS && <Button loading={busy === 'start'} disabled={st.running === true} onClick={() => act('start', '/phone/start')}>{t('phone.redroidStart')}</Button>}
                {canSS && <Button loading={busy === 'stop'} disabled={st.running === false} onClick={() => act('stop', '/phone/stop')}>{t('phone.redroidStop')}</Button>}
                {isNet && <Button loading={busy === 'connect'} onClick={() => act('connect', '/phone/connect')}>{t('phone.connect')}</Button>}
                {isNet && <Button loading={busy === 'disconnect'} onClick={() => act('disconnect', '/phone/disconnect')}>{t('phone.disconnect2')}</Button>}
                <Button loading={busy === 'test'} onClick={() => act('test', '/phone/test')}>{t('phone.test')}</Button>
              </Space>
              <Space wrap size={8}>
                <Tag color={st.connected ? 'green' : (st.error ? 'red' : 'default')}>
                  {st.connected ? (st.device || t('phone.connected')) : (st.error || t('phone.disconnected'))}
                </Tag>
                {canSS && st.running != null && <Tag color={st.running ? 'blue' : 'default'}>{st.running ? t('phone.redroidRunning') : t('phone.redroidStopped')}</Tag>}
              </Space>
            </>
          ) : <span style={dim}>{t('phone.enableHint')}</span>}
        </Space>
      </Card>
    )
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {renderCard('android')}
      {renderCard('ios')}
      {log && <pre style={{ maxHeight: 160, overflow: 'auto', margin: 0, padding: 8, fontSize: 11, lineHeight: 1.5, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 6, whiteSpace: 'pre-wrap' }}>{log}</pre>}
    </Space>
  )
}

// 关于页：Logo / roam 版本号 / 检测更新（跳 release 页）/ GitHub 仓库链接