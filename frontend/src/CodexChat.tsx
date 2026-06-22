// Codex 对话面板（容器）：拉 codex rollout 转录 → 交给 ChatShell 渲染。
// 渲染/工具卡片在 chat/CodexMessage，外壳在 chat/ChatShell，共用件在 chat/blocks。
import { useMemo } from 'react'
import { ChatShell } from './chat/ChatShell'
import { Typing } from './chat/blocks'
import { CodexBubble, CODEX_ACCENT } from './chat/CodexMessage'
import { useTranscript, isPending, pairToolResults } from './chat/useTranscript'
import { useI18n } from './i18n'

export default function CodexChat({ name, file, dir, onBack }: { name: string; file?: string; dir?: string; onBack: () => void }) {
  const { t } = useI18n()
  const { msgs, err, refresh } = useTranscript(name, file, 'codex-transcript')
  const { results, view } = useMemo(() => pairToolResults(msgs), [msgs])
  const pending = isPending(view)

  return (
    <ChatShell
      name={name} dir={dir} accent={CODEX_ACCENT} error={err}
      title={<span style={{ color: CODEX_ACCENT, fontWeight: 600 }}>✸ Codex</span>}
      placeholder={t('chat.codexPlaceholder')}
      onBack={onBack}
      onRefresh={refresh}
      messages={view}
      renderMessage={(m, i) => <CodexBubble key={m.id || i} m={m} results={results} />}
      pending={pending ? <Typing color={CODEX_ACCENT} /> : undefined}
      busy={pending}
    />
  )
}
