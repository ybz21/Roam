// ── 服务器目录选择器 ──
// 最近用过的工作目录（服务端偏好 + localStorage 兜底），作为目录选择器的快捷候选
import { getPreferences, savePreferences } from '../../preferences'
import { ArrowUp, ChevronRight, HomeIcon } from '../../icons'
import { Button, List, Modal, Tag, Tooltip, App as AntApp } from 'antd'
import { api } from '../../api'
import { useEffect, useState } from 'react'
import { useI18n } from '../../i18n/index'
const RECENT_DIRS_KEY = 'ttmux_recent_dirs'
export function recentDirs(): string[] {
  const fromPrefs = getPreferences().recentDirs
  if (fromPrefs && fromPrefs.length > 0) return fromPrefs
  try { return JSON.parse(localStorage.getItem(RECENT_DIRS_KEY) || '[]') } catch { return [] }
}
export function pushRecentDir(d: string) {
  if (!d || !d.trim()) return
  const dirs = [d.trim(), ...recentDirs().filter((x) => x !== d.trim())].slice(0, 8)
  savePreferences({ recentDirs: dirs })
  try { localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(dirs)) } catch {}
}

export function DirPicker({ open, start, onPick, onClose }: { open: boolean; start?: string; onPick: (p: string) => void; onClose: () => void }) {
  const [data, setData] = useState<any>({ path: '', parent: '', dirs: [] })
  const [recent, setRecent] = useState<string[]>([])
  const { message } = AntApp.useApp()
  const { t } = useI18n()
  const load = (p?: string) => api('GET', '/fs' + (p !== undefined ? '?path=' + encodeURIComponent(p) : '')).then((r) => setData(r.data)).catch((e) => message.error(e.message))
  useEffect(() => { if (open) { setRecent(recentDirs()); load(start || undefined) } }, [open])
  const enter = (d: string) => load((data.path === '/' ? '' : data.path) + '/' + d)
  const choose = (p: string) => { pushRecentDir(p); onPick(p) }
  return (
    <Modal open={open} onCancel={onClose} title={t('dirPicker.title')} zIndex={1100}
      footer={[<Button key="c" onClick={onClose}>{t('common.cancel')}</Button>, <Button key="o" type="primary" onClick={() => choose(data.path)}>{t('dirPicker.chooseCurrent')}</Button>]}>
      {/* 快捷候选：家目录 + 最近用过的目录 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)', marginBottom: 10 }}>
        <Tag style={{ cursor: 'pointer', margin: 0 }} onClick={() => load(undefined)} icon={<HomeIcon size={11} />}>{t('dirPicker.home')}</Tag>
        {recent.map((d) => (
          <Tooltip key={d} title={d}>
            <Tag color="blue" style={{ cursor: 'pointer', margin: 0, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}
              onClick={() => load(d)} onDoubleClick={() => choose(d)}>
              {d.split('/').filter(Boolean).pop() || d}
            </Tag>
          </Tooltip>
        ))}
      </div>
      <div style={{ fontFamily: 'monospace', color: 'var(--text-dim)', marginBottom: 8, wordBreak: 'break-all' }}>{data.path || '…'}</div>
      <List size="small" style={{ maxHeight: '50vh', overflow: 'auto' }}
        dataSource={['..', ...(data.dirs || [])]}
        renderItem={(d: string) => (
          <List.Item style={{ cursor: 'pointer' }} onClick={() => (d === '..' ? load(data.parent) : enter(d))}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: d === '..' ? 'var(--text-dim)' : 'var(--text-bright)' }}>
              {d === '..' ? <><ArrowUp size={12} />{t('file.parentDir')}</> : <><ChevronRight size={12} />{d}</>}
            </span>
          </List.Item>
        )} />
    </Modal>
  )
}
