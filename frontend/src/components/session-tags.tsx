// 会话列表里的两枚标签：跑没跑完、是命令还是 Agent。
import { Tag } from 'antd'
import { BotIcon, KeyboardIcon } from '../icons'
import { useI18n } from '../i18n'

export function StatusTag({ status, code }: { status?: string; code?: string }) {
  const { t } = useI18n()
  if (status === 'running') return <Tag color="processing">{t('common.running')}</Tag>
  if (status === 'done') return code && code !== '0' ? <Tag color="error">{t('session.status.failedWithCode', { code })}</Tag> : <Tag color="success">{t('common.done')}</Tag>
  return <Tag>{t('common.ended')}</Tag>
}
export function TypeTag({ type }: { type?: string }) {
  const { t } = useI18n()
  return type === 'agent'
    ? <Tag color="blue" icon={<BotIcon size={11} />}>{t('session.type.agent')}</Tag>
    : <Tag icon={<KeyboardIcon size={11} />}>{t('session.type.command')}</Tag>
}
