import { useEffect, useState } from 'react'
import { Button, Modal, Tag, List, Spin } from 'antd'
import { api } from './api'
import { useI18n } from './i18n'

interface UpgradeInfo {
  available: boolean
  branch: string
  behind: number
  commits: { hash: string; short: string; subject: string; author: string; when: string }[]
}

export default function UpgradeBanner() {
  const [info, setInfo] = useState<UpgradeInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'pulling' | 'restarting'>('idle')
  const { t } = useI18n()

  useEffect(() => {
    let stop = false
    const check = async () => {
      try {
        const r = await api('GET', '/upgrade/check')
        if (!stop && r.data) setInfo(r.data)
      } catch {}
    }
    check()
    const timer = setInterval(check, 5 * 60 * 1000)
    return () => { stop = true; clearInterval(timer) }
  }, [])

  if (phase === 'restarting') {
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 3000,
        display: 'grid', placeItems: 'center',
        background: 'rgba(0,0,0,.65)', backdropFilter: 'blur(4px)',
      }}>
        <div style={{ textAlign: 'center', color: '#fff' }}>
          <Spin size="large" />
          <div style={{ marginTop: 16, fontSize: 15 }}>{t('upgrade.reconnecting')}</div>
        </div>
      </div>
    )
  }
  if (!info?.available) return null

  const handleUpgrade = async () => {
    setPhase('pulling')
    try {
      await api('POST', '/upgrade/apply')
      setPhase('restarting')
      setOpen(false)
      const poll = setInterval(async () => {
        try {
          const r = await fetch('/api/me', { cache: 'no-store' })
          if (r.ok || r.status === 401) {
            clearInterval(poll)
            location.reload()
          }
        } catch {}
      }, 2000)
      setTimeout(() => clearInterval(poll), 120_000)
    } catch {
      setPhase('idle')
    }
  }

  return (
    <>
      <div
        onClick={() => setOpen(true)}
        style={{
          position: 'fixed', top: 14, right: 14, zIndex: 2000,
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 5,
          background: 'var(--bg-elevated)', border: '1px solid #1f6feb',
          borderRadius: 8, padding: '3px 10px',
          boxShadow: 'var(--elevated-shadow)',
          color: '#58a6ff', fontSize: 12, fontWeight: 600,
        }}
      >
        ↑ {t('upgrade.available')}
      </div>

      <Modal
        open={open}
        title={t('upgrade.title')}
        onCancel={() => setOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>,
          <Button key="upgrade" type="primary" loading={phase === 'pulling'} onClick={handleUpgrade}>
            {phase === 'pulling' ? t('upgrade.upgrading') : t('upgrade.confirm')}
          </Button>,
        ]}
      >
        <div style={{ marginBottom: 12 }}>
          <Tag color="blue">{info.branch}</Tag>
          <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
            {t('upgrade.newCommits', { count: info.behind })}
          </span>
        </div>

        <div style={{ maxHeight: 300, overflowY: 'auto', marginBottom: 16 }}>
          <List
            size="small"
            dataSource={info.commits}
            renderItem={(c) => (
              <List.Item style={{ padding: '6px 0' }}>
                <div style={{ minWidth: 0, width: '100%' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code style={{ color: '#58a6ff', fontSize: 12, flex: '0 0 auto' }}>{c.short}</code>
                    <span style={{ color: 'var(--text-bright)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.subject}</span>
                  </div>
                  <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                    {c.author} · {c.when}
                  </div>
                </div>
              </List.Item>
            )}
          />
        </div>

        <div style={{
          padding: '10px 12px', borderRadius: 8,
          background: '#d2992222', border: '1px solid #d2992244',
          color: 'var(--text-bright)', fontSize: 13, lineHeight: 1.6,
        }}>
          ⚠ {t('upgrade.warning')}
        </div>
      </Modal>
    </>
  )
}
