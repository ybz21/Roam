// Claude Code 对话面板（容器）：拉转录 → 把 tool_result 按 id 挂回 tool_use → 交给 ChatShell 渲染。
// 消息渲染在 chat/Message（Claude / Codex 共用），工具渲染在 chat/tool-render，外壳在 chat/ChatShell。
import { useMemo } from 'react'
import { ChatShell } from './chat/ChatShell'
import { Typing } from './chat/blocks'
import { ChatMessage } from './chat/Message'
import { useTranscript, isPending, pairToolResults } from './chat/useTranscript'
import { buildTaskIndex } from './chat/tasks'
import { useI18n } from './i18n'

export default function ClaudeChat({ name, file, onOpenFile }: { name: string; file?: string; onOpenFile?: (path: string, line?: number) => void }) {
  const { t } = useI18n()
  const { msgs, err } = useTranscript(name, file, 'transcript')
  const { results, view } = useMemo(() => pairToolResults(msgs), [msgs])
  const pending = isPending(view)
  // TaskUpdate 只给 {taskId,status}，标题在更早那次 TaskCreate 的结果里 —— 跨消息扫一遍才接得上
  const tasks = useMemo(() => buildTaskIndex(view, results), [view, results])

  return (
    <ChatShell
      name={name} accent="var(--accent)" error={err} onOpenFile={onOpenFile} tasks={tasks}
      placeholder={t('chat.claudePlaceholder')}
      messages={view}
      renderMessage={(m, i) => <ChatMessage key={m.id || i} m={m} results={results} side="claude" />}
      pending={pending ? <Typing color="var(--accent)" /> : undefined}
      busy={pending}
    />
  )
}
