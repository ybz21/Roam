// P2P 直连（实验性）：开关 + STUN + 两个超时 + 最低速率。
// 这几项作为一组存在——总开关关掉时后面四项无意义，所以整块留在一页里，不拆成独立设置行。
import { useEffect, useState } from 'react'
import { InputNumber, Select, Space, Switch, Tag } from 'antd'
import { nodeApi } from '../cluster/node-url'
import { useI18n } from '../../i18n'
import { usePreferences } from '../../preferences'
import { STUN_PRESETS, normalizeStun, parseStunList } from '../../p2p/ice-servers'

export function P2PSettings() {
  const { t } = useI18n()
  const [prefs, setPrefs] = usePreferences()
  const [serverStun, setServerStun] = useState<string[]>([])
  // 拉服务端默认 STUN 预填进输入框（用户未自定义时展示当前默认；改了才存自定义偏好）。
  useEffect(() => {
    fetch(nodeApi('/p2p/config'), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const cfg = d?.data ?? d ?? {}
        const urls = (cfg.iceServers || []).flatMap((s: { urls?: string | string[] }) => (Array.isArray(s.urls) ? s.urls : s.urls ? [s.urls] : [])).filter(Boolean)
        if (urls.length) setServerStun(urls)
      })
      .catch(() => { /* ignore */ })
  }, [])
  const on = prefs.p2pEnabled
  // 展示：用户自定义优先，否则预填服务端默认。清空(未自定义)时 transport 仍走服务端默认。
  const custom = parseStunList(prefs.p2pStunServers)
  const stunValue = custom.length ? custom : serverStun
  const dim = { color: 'var(--text-dim)', fontSize: 'var(--fs-meta)' }
  const hint = { color: 'var(--text-dimmer)', fontSize: 'var(--fs-micro)' }
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space align="center" wrap>
        <Switch checked={on} onChange={(v) => setPrefs({ p2pEnabled: v })} />
        <Tag color="orange" style={{ margin: 0 }}>{t('settings.p2pExperimental')}</Tag>
        <span style={dim}>{t('settings.p2pHelp')}</span>
      </Space>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)', opacity: on ? 1 : 0.5 }}>
        <span style={dim}>{t('settings.p2pStun')}</span>
        <Select
          mode="tags" disabled={!on} allowClear value={stunValue}
          placeholder={t('settings.p2pStunPh')}
          tokenSeparators={[',', ' ', '\n']}
          // 存回偏好前先规整：下拉选的已经规范，手打的可能漏 stun: 前缀。
          onChange={(v: string[]) => setPrefs({ p2pStunServers: parseStunList(v.map(normalizeStun).join(',')).join(', ') })}
          options={STUN_PRESETS.map((p) => ({
            value: p.value,
            label: <span>{p.value}<span style={{ ...hint, marginLeft: 'var(--sp-2)' }}>{p.brand}</span></span>,
          }))}
          style={{ maxWidth: 460, width: '100%' }}
        />
        <span style={hint}>{t('settings.p2pStunHelp')}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)', opacity: on ? 1 : 0.5 }}>
        <span style={dim}>{t('settings.p2pTimeout')}</span>
        <Space align="center" wrap>
          <InputNumber
            disabled={!on} min={5} max={120} step={5} value={prefs.p2pConnectTimeoutSec}
            onChange={(v) => setPrefs({ p2pConnectTimeoutSec: typeof v === 'number' ? v : 30 })}
            addonAfter={t('settings.p2pTimeoutUnit')} style={{ width: 130 }}
          />
          <span style={hint}>{t('settings.p2pTimeoutHelp')}</span>
        </Space>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)', opacity: on ? 1 : 0.5 }}>
        <span style={dim}>{t('settings.p2pGather')}</span>
        <Space align="center" wrap>
          <InputNumber
            disabled={!on} min={3} max={300} step={5} value={prefs.p2pGatherTimeoutSec}
            onChange={(v) => setPrefs({ p2pGatherTimeoutSec: typeof v === 'number' ? v : 30 })}
            addonAfter={t('settings.p2pTimeoutUnit')} style={{ width: 130 }}
          />
          <span style={hint}>{t('settings.p2pGatherHelp')}</span>
        </Space>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)', opacity: on ? 1 : 0.5 }}>
        <span style={dim}>{t('settings.p2pMinSpeed')}</span>
        <Space align="center" wrap>
          <InputNumber
            disabled={!on} min={0} max={100000} step={50} value={prefs.p2pMinSpeedKBps}
            onChange={(v) => setPrefs({ p2pMinSpeedKBps: typeof v === 'number' && v >= 0 ? v : 200 })}
            addonAfter={t('settings.p2pMinSpeedUnit')} style={{ width: 150 }}
          />
          <span style={hint}>{t('settings.p2pMinSpeedHelp')}</span>
        </Space>
      </div>
    </Space>
  )
}
