// Claude Code 对话面板（容器）：拉转录 → 把 tool_result 按 id 挂回 tool_use → 交给 ChatShell 渲染。
// 渲染/工具卡片在 chat/ClaudeMessage，外壳在 chat/ChatShell，共用件在 chat/blocks。
import { useMemo } from 'react'
import { ChatShell } from './chat/ChatShell'
import { Typing } from './chat/blocks'
import { ClaudeBubble } from './chat/ClaudeMessage'
import { useTranscript, isPending, pairToolResults } from './chat/useTranscript'
import { useI18n } from './i18n'

export default function ClaudeChat({ name, file, dir, onBack }: { name: string; file?: string; dir?: string; onBack: () => void }) {
  const { t } = useI18n()
  const { msgs, err, refresh } = useTranscript(name, file, 'transcript')
  const { results, view } = useMemo(() => pairToolResults(msgs), [msgs])
  const pending = isPending(view)

  return (
    <ChatShell
      name={name} dir={dir} accent="#58a6ff" error={err}
      title={<span style={{ color: '#58a6ff', fontWeight: 600 }}>✳ Claude Code</span>}
      placeholder={t('chat.claudePlaceholder')}
      onBack={onBack}
      onRefresh={refresh}
      messages={view}
      renderMessage={(m, i) => <ClaudeBubble key={m.id || i} m={m} results={results} />}
      pending={pending ? <Typing color="#58a6ff" /> : undefined}
      busy={pending}
    />
  )
}
