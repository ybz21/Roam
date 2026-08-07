// 一个「问一句话」的输入弹窗：新建分支 / 打标签 / 重命名 / 储藏说明都用它。
// antd 的 Modal.confirm 塞不进受控输入框，所以单独做一个轻量版。
import { useEffect, useState } from 'react'
import { Input, Modal } from 'antd'
import { useI18n } from '../i18n'
import { onEnterSubmit } from '../enter-submit'

export interface AskSpec {
  title: string
  label?: string
  placeholder?: string
  initial?: string
  okText?: string
  danger?: boolean
  onOk: (value: string) => void | Promise<void>
}

export default function AskModal({ spec, onClose }: { spec: AskSpec | null; onClose: () => void }) {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { setValue(spec?.initial || '') }, [spec])

  const submit = async () => {
    const v = value.trim()
    if (!v) return
    setBusy(true)
    try { await spec?.onOk(v); onClose() } finally { setBusy(false) }
  }

  return (
    <Modal open={!!spec} title={spec?.title} onCancel={onClose} onOk={submit}
      okText={spec?.okText || t('common.confirm')} cancelText={t('common.cancel')}
      okButtonProps={{ disabled: !value.trim(), loading: busy, danger: spec?.danger }}
      destroyOnClose width={420}>
      {spec?.label && <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 6 }}>{spec.label}</div>}
      <Input autoFocus value={value} placeholder={spec?.placeholder}
        onChange={(e) => setValue(e.target.value)}
        onPressEnter={onEnterSubmit(submit)} />
    </Modal>
  )
}
