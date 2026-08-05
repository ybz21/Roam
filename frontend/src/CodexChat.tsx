// Codex 对话面板（容器）：拉 codex rollout 转录 → 交给 ChatShell 渲染。
// 消息渲染在 chat/Message（与 Claude 共用一份，只差 side），工具渲染在 chat/tool-render。
import { useMemo } from 'react'
import { ChatShell } from './chat/ChatShell'
import { Typing } from './chat/blocks'
import { ChatMessage, CODEX_ACCENT } from './chat/Message'
import { useTranscript, isPending, pairToolResults } from './chat/useTranscript'
import { buildTaskIndex } from './chat/tasks'
import { toAgentStatus } from './chat/status'
import { useI18n } from './i18n'

export default function CodexChat({ name, file, onOpenFile }: { name: string; file?: string; onOpenFile?: (path: string, line?: number) => void }) {
  const { t } = useI18n()
  const { msgs, err, status: raw } = useTranscript(name, file, 'codex-transcript')
  const { results, view } = useMemo(() => pairToolResults(msgs), [msgs])
  const pending = isPending(view)
  // TaskUpdate 只给 {taskId,status}，标题在更早那次 TaskCreate 的结果里 —— 跨消息扫一遍才接得上
  const tasks = useMemo(() => buildTaskIndex(view, results), [view, results])
  const status = useMemo(() => toAgentStatus(raw, tasks), [raw, tasks])

  return (
    <ChatShell
      name={name} accent={CODEX_ACCENT} error={err} onOpenFile={onOpenFile} tasks={tasks} status={status}
      placeholder={t('chat.codexPlaceholder')}
      messages={view}
      renderMessage={(m, i) => <ChatMessage key={m.id || i} m={m} results={results} side="codex" />}
      pending={pending ? <Typing color={CODEX_ACCENT} /> : undefined}
      busy={pending}
    />
  )
}
