// Codex 对话面板（容器）：拉 codex rollout 转录 → 交给 ChatShell 渲染。
// 消息渲染在 chat/Message（与 Claude 共用一份，只差 side），工具渲染在 chat/tool-render。
import { useMemo } from 'react'
import { ChatShell } from './chat/ChatShell'
import { Typing } from './chat/blocks'
import { ChatMessage, CODEX_ACCENT } from './chat/Message'
import { useTranscript, isPending, pairToolResults } from './chat/useTranscript'
import { buildTaskIndex } from './chat/tasks'
import { toAgentStatus } from './chat/status'
import { deriveFromMessages } from './chat/status-derive'
import { useI18n } from './i18n'

export default function CodexChat({ name, file, onOpenFile, onOpenGit }: { name: string; file?: string; onOpenFile?: (path: string, line?: number) => void; onOpenGit?: () => void }) {
  const { t } = useI18n()
  const { msgs, err, status: raw } = useTranscript(name, file, 'codex-transcript')
  const { results, view } = useMemo(() => pairToolResults(msgs), [msgs])
  const pending = isPending(view)
  // TaskUpdate 只给 {taskId,status}，标题在更早那次 TaskCreate 的结果里 —— 跨消息扫一遍才接得上
  const tasks = useMemo(() => buildTaskIndex(view, results), [view, results])
  // 失败数与时长后端给不了（它只增量扫新行），前端手里是完整消息流，数一遍就有
  const derived = useMemo(() => deriveFromMessages(view), [view])
  const status = useMemo(() => ({ ...toAgentStatus(raw, tasks), errors: derived.errors, elapsed: derived.elapsed }), [raw, tasks, derived])

  return (
    <ChatShell
      name={name} accent={CODEX_ACCENT} error={err} onOpenFile={onOpenFile} tasks={tasks} status={status} onOpenGit={onOpenGit} lastErrorId={derived.lastErrorId}
      placeholder={t('chat.codexPlaceholder')}
      messages={view} results={results}
      renderMessage={(m, i) => <ChatMessage key={m.id || i} m={m} results={results} side="codex" />}
      pending={pending ? <Typing color={CODEX_ACCENT} /> : undefined}
      busy={pending}
    />
  )
}
