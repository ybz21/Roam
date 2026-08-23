// ── 服务器目录选择器 ──
// 最近用过的工作目录（服务端偏好 + localStorage 兜底），作为目录选择器的快捷候选
import { getPreferences, savePreferences } from '../../preferences'
import { ArrowUp, ChevronRight, HomeIcon } from '../../icons'
import { Button, Input, List, Modal, Tag, Tooltip, App as AntApp } from 'antd'
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

  // 新建目录：就地建、建完直接进去。
  //
  // 从前这里只能在已有目录里挑，想要个新目录就得先去文件页建好再回来选，
  // 或者关掉选择器手打全路径——而「新建项目」本来就常常是要开一个新目录。
  const [mkOpen, setMkOpen] = useState(false)
  const [mkName, setMkName] = useState('')
  const [mkBusy, setMkBusy] = useState(false)
  const doMkdir = async () => {
    const name = mkName.trim()
    if (!name) return
    setMkBusy(true)
    try {
      const r = await api('POST', '/file/mkdir', { dir: data.path, name })
      setMkOpen(false); setMkName('')
      // 建完进去：这时候你多半就是要选它，少一次点击。
      load(r?.data?.path || (data.path === '/' ? '' : data.path) + '/' + name)
    } catch (e: any) { message.error(e.message) }
    finally { setMkBusy(false) }
  }

  return (
    <Modal open={open} onCancel={onClose} title={t('dirPicker.title')} zIndex={1100}
      footer={[
        <Button key="n" onClick={() => { setMkName(''); setMkOpen(true) }} disabled={!data.path} style={{ float: 'left' }}>
          {t('file.newFolder')}
        </Button>,
        <Button key="c" onClick={onClose}>{t('common.cancel')}</Button>,
        <Button key="o" type="primary" onClick={() => choose(data.path)}>{t('dirPicker.chooseCurrent')}</Button>,
      ]}>
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
      <Modal open={mkOpen} title={t('file.newFolder')} zIndex={1200} destroyOnClose
        okText={t('file.create')} confirmLoading={mkBusy}
        onOk={doMkdir} onCancel={() => setMkOpen(false)}>
        <div style={{ fontFamily: 'monospace', fontSize: 'var(--fs-meta)', color: 'var(--text-dimmer)', marginBottom: 8, wordBreak: 'break-all' }}>
          {data.path}/
        </div>
        <Input value={mkName} autoFocus placeholder={t('file.newFolderPlaceholder')}
          onChange={(e) => setMkName(e.target.value)} onPressEnter={doMkdir} />
      </Modal>
    </Modal>
  )
}
