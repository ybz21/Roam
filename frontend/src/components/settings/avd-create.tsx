// 新建本机模拟器(AVD)的向导抽屉。
//
// 它不是一个普通表单：想建的镜像没下载过时，第一步是拉一个 1.5–2.5G 的系统镜像，
// 几分钟到几十分钟。所以创建请求只发号（回 taskId），进度另走 SSE，任务活在后端——
// 关掉抽屉、切页面、手机锁屏都不影响它，回来还能接着看。
import { useEffect, useRef, useState } from 'react'
import { App as AntApp, Button, Checkbox, Drawer, Input, InputNumber, Segmented, Select, Space, Tag } from 'antd'
import { api } from '../../api'
import { nodeApi } from '../cluster/node-url'
import { useI18n } from '../../i18n'
import { purposeFilter, slugAvdName, tvSizeOverride } from '../../avd-profile'
import type { AvdImage, DeviceProfile, Purpose } from '../../avd-profile'

type Image = AvdImage
type Catalog = {
  devices: DeviceProfile[]; images: Image[]; avds: string[]; abi: string
  tools: { emulator: boolean; sdkmanager: boolean; avdmanager: boolean; sdkRoot: string }
}

export function AvdCreateDrawer({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated: () => void
}) {
  const { t } = useI18n()
  const { message } = AntApp.useApp()
  const [cat, setCat] = useState<Catalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [purpose, setPurpose] = useState<Purpose>('phone')
  const [device, setDevice] = useState('')
  const [pkg, setPkg] = useState('')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [license, setLicense] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [ram, setRam] = useState<number | null>(null)
  const [disk, setDisk] = useState('')
  const [task, setTask] = useState<{ pct: number; lines: string[]; status: string; error: string } | null>(null)
  const esRef = useRef<EventSource | null>(null)

  const loadCatalog = (remote: boolean) => {
    remote ? setRemoteLoading(true) : setLoading(true)
    return api('GET', '/phone/avd/catalog' + (remote ? '?remote=1' : ''))
      .then((r) => { if (r?.data) setCat(r.data) })
      .catch((e: any) => message.error(e.message))
      .finally(() => { remote ? setRemoteLoading(false) : setLoading(false) })
  }

  useEffect(() => { if (open && !cat) loadCatalog(false) }, [open])
  // 抽屉关了就断流；任务本身留在后端继续跑，重开再订阅。
  useEffect(() => () => { esRef.current?.close() }, [])

  const f = purposeFilter(purpose)
  const devices = (cat?.devices || []).filter(f.device)
  const images = (cat?.images || []).filter(f.image)
  const picked = images.find((i) => i.pkg === pkg)
  const needsDownload = !!picked && !picked.installed

  // 名字跟着选择走，除非用户自己改过——改过就不再覆盖他。
  useEffect(() => {
    if (nameTouched || !picked) return
    setName(slugAvdName([device || purpose, 'api' + picked.api].join('_')))
  }, [device, pkg, purpose])

  const variantText = (v: string) => {
    const key = 'phone.avd.variant.' + v
    const s = t(key)
    return s === key ? v : s
  }
  const imageLabel = (i: Image) =>
    `Android ${i.api} · ${variantText(i.variant)}` + (i.installed ? ' · ' + t('phone.avd.downloaded') : '')

  const reset = () => { setTask(null); esRef.current?.close(); esRef.current = null }

  const subscribe = (taskId: string) => {
    esRef.current?.close()
    const es = new EventSource(nodeApi('/phone/avd/tasks/' + taskId))
    esRef.current = es
    es.addEventListener('task', (ev) => {
      const d = JSON.parse((ev as MessageEvent).data)
      setTask((prev) => ({
        pct: d.pct ?? 0,
        status: d.status,
        error: d.error || '',
        lines: [...(prev?.lines || []), ...(d.lines || [])].slice(-200),
      }))
      if (d.status !== 'running') {
        es.close()
        esRef.current = null
        if (d.status === 'done') { message.success(t('phone.avd.created')); onCreated() }
        else message.error(d.error || t('phone.avd.failed'))
      }
    })
    es.onerror = () => { es.close(); esRef.current = null }
  }

  const create = async (start: boolean) => {
    if (!name || !pkg) { message.warning(t('phone.avd.needNamePkg')); return }
    const tvSize = tvSizeOverride(purpose, device)
    try {
      const r = await api('POST', '/phone/avd', {
        name, pkg, device, start, acceptLicense: license,
        ram: ram || 0, disk: disk.trim(), ...tvSize,
      })
      if (r?.error) { message.error(r.error); return }
      setTask({ pct: 0, lines: [], status: 'running', error: '' })
      subscribe(r.data.taskId)
    } catch (e: any) { message.error(e.message) }
  }

  const running = task?.status === 'running'
  const missingTools = cat && (!cat.tools.avdmanager || !cat.tools.emulator)

  return (
    <Drawer open={open} onClose={onClose} width={520} title={t('phone.avd.new')} destroyOnClose={false}>
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        {missingTools && (
          <div className="tt-cstate warn">
            <i className="d" aria-hidden />
            {t('phone.avd.noTools')}
          </div>
        )}

        <div>
          <div className="tt-lbl">{t('phone.avd.purpose')}</div>
          <Segmented value={purpose} onChange={(v) => { setPurpose(v as Purpose); setDevice(''); setPkg('') }}
            options={[
              { label: t('phone.avd.purpose.phone'), value: 'phone' },
              { label: t('phone.avd.purpose.tablet'), value: 'tablet' },
              { label: t('phone.avd.purpose.tv'), value: 'tv' },
              { label: t('phone.avd.purpose.custom'), value: 'custom' },
            ]} />
        </div>

        <div>
          <div className="tt-lbl">{t('phone.avd.deviceProfile')}</div>
          <Select style={{ width: '100%' }} value={device || undefined} loading={loading}
            placeholder={t('phone.avd.deviceProfilePh')} showSearch optionFilterProp="label"
            onChange={(v) => setDevice(v)}
            options={devices.map((d) => ({ value: d.id, label: d.name + (d.oem ? ' · ' + d.oem : '') }))} />
        </div>

        <div>
          <div className="tt-lbl">
            <Space size={8}>
              {t('phone.avd.image')}
              <button type="button" className="tt-act" disabled={remoteLoading} onClick={() => loadCatalog(true)}>
                {remoteLoading ? t('phone.avd.fetching') : t('phone.avd.fetchRemote')}
              </button>
            </Space>
          </div>
          <Select style={{ width: '100%' }} value={pkg || undefined} loading={loading}
            placeholder={t('phone.avd.imagePh')} showSearch optionFilterProp="label"
            onChange={(v) => setPkg(v)}
            options={images.map((i) => ({ value: i.pkg, label: imageLabel(i) }))} />
          <div className="tt-hint">{t('phone.avd.imageHelp', { abi: cat?.abi || '' })}</div>
        </div>

        <div>
          <div className="tt-lbl">{t('phone.avd.name')}</div>
          <Input value={name} onChange={(e) => { setNameTouched(true); setName(slugAvdName(e.target.value)) }} />
          <div className="tt-hint">{t('phone.avd.nameHelp')}</div>
        </div>

        <div>
          <button type="button" className="tt-act" onClick={() => setAdvanced((v) => !v)}>
            {advanced ? t('phone.avd.advancedHide') : t('phone.avd.advanced')}
          </button>
          {advanced && (
            <Space style={{ marginTop: 10 }} wrap>
              <InputNumber value={ram} onChange={(v) => setRam(v)} min={512} max={16384} step={512}
                addonBefore={t('phone.avd.ram')} placeholder={t('phone.avd.followProfile')} style={{ width: 200 }} />
              <Input value={disk} onChange={(e) => setDisk(e.target.value)} addonBefore={t('phone.avd.disk')}
                placeholder="6G" style={{ width: 180 }} />
            </Space>
          )}
        </div>

        {needsDownload && (
          <Checkbox checked={license} onChange={(e) => setLicense(e.target.checked)}>
            {t('phone.avd.license')}
          </Checkbox>
        )}

        <Space wrap>
          <Button type="primary" disabled={running || (needsDownload && !license)} onClick={() => create(false)}>
            {t('phone.avd.create')}
          </Button>
          <Button disabled={running || (needsDownload && !license)} onClick={() => create(true)}>
            {t('phone.avd.createStart')}
          </Button>
          {task && !running && <Button onClick={reset}>{t('phone.avd.again')}</Button>}
        </Space>

        {task && (
          <div>
            <Space size={8} wrap>
              <Tag color={task.status === 'error' ? 'red' : task.status === 'done' ? 'green' : 'blue'}>
                {t('phone.avd.status.' + task.status)}
              </Tag>
              {running && <span className="tt-hint">{task.pct}%</span>}
            </Space>
            <pre className="tt-log">{task.lines.slice(-40).join('\n')}</pre>
          </div>
        )}
      </Space>
    </Drawer>
  )
}
