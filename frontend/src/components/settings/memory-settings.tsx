// 会话内存上限：给每个会话套一层天花板，让失控的 agent 只杀死自己。
//
// 值落在 ttmux 的全局 env 文件（ROAM_SESSION_MEM_MAX），CLI 建会话时读它，
// 用 systemctl set-property 设到那个会话的 cgroup 上。
// 见 docs/design/reliability/memory-guard.html。
import { useEffect, useState } from 'react'
import { App as AntApp, Button, Input, Radio, Space, Tag } from 'antd'
import { api } from '../../api'
import { useI18n } from '../../i18n'

const KEY = 'ROAM_SESSION_MEM_MAX'

/** 预设档：按整机内存的比例给，而不是拍一个固定数——8G 的本子和 128G 的工作站不该同一个值。 */
const PRESETS = ['', '4G', '8G', '12G', '16G', 'off']

export function MemoryGuardSettings() {
  const { t } = useI18n()
  const { message } = AntApp.useApp()
  const [value, setValue] = useState('')
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    api('GET', '/env')
      .then((list: any) => {
        const hit = (Array.isArray(list) ? list : []).find((kv: any) => kv?.key === KEY)
        const v = (hit?.value || '').trim()
        setValue(v)
        if (v && !PRESETS.includes(v)) setCustom(v)
      })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  const save = async (v: string) => {
    setBusy(true)
    try {
      await api('PUT', '/env', { key: KEY, value: v })
      setValue(v)
      message.success(t('set.mem.saved'))
    } catch (e: any) {
      message.error(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!loaded) return null
  const isCustom = !!value && !PRESETS.includes(value)

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Radio.Group
        value={isCustom ? 'custom' : value}
        disabled={busy}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'custom') { setCustom(custom || '8G'); return }
          void save(v)
        }}
      >
        <Space direction="vertical" size={4}>
          <Radio value="">
            {t('set.mem.auto')} <Tag style={{ marginInlineStart: 6 }}>{t('set.mem.autoHint')}</Tag>
          </Radio>
          {['4G', '8G', '12G', '16G'].map((p) => (
            <Radio key={p} value={p}>{p}</Radio>
          ))}
          <Radio value="custom">{t('set.mem.custom')}</Radio>
          <Radio value="off">
            {t('set.mem.off')} <Tag color="warning" style={{ marginInlineStart: 6 }}>{t('set.mem.offHint')}</Tag>
          </Radio>
        </Space>
      </Radio.Group>

      {(isCustom || custom) && (
        <Space.Compact style={{ width: '100%', maxWidth: 320 }}>
          <Input
            value={custom}
            placeholder={t('set.mem.placeholder')}
            onChange={(e) => setCustom(e.target.value)}
            onPressEnter={() => custom.trim() && save(custom.trim())}
          />
          <Button type="primary" loading={busy} disabled={!custom.trim()} onClick={() => save(custom.trim())}>
            {t('env.set')}
          </Button>
        </Space.Compact>
      )}

      <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-dimmer)', lineHeight: 1.7 }}>
        {t('set.mem.note')}
      </div>
    </Space>
  )
}
