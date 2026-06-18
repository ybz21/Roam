// Codex 工具调用 + 气泡渲染：
//   shell/exec_command → 终端命令卡片；apply_patch → 彩色 diff；reasoning → 折叠「推理」。
import { memo } from 'react'
import Markdown from '../Markdown'
import { Collapsible, Diff, MONO, fmtTs, ToolResult } from './blocks'
import type { Block, Msg } from './types'

export const CODEX_ACCENT = '#10a37f' // OpenAI 绿

function extractCmd(input?: string): string | null {
  if (!input) return null
  try {
    const o = JSON.parse(input)
    return o.cmd || o.command || (Array.isArray(o.argv) ? o.argv.join(' ') : null)
  } catch { return null }
}

function argSummary(input?: string): string {
  if (!input) return ''
  try {
    const o = JSON.parse(input)
    const key = ['path', 'file_path', 'pattern', 'query', 'cmd', 'command'].find((k) => o[k])
    const v = key ? String(o[key]) : JSON.stringify(o)
    return v.length > 140 ? v.slice(0, 140) + '…' : v
  } catch { return input.slice(0, 140) }
}

function ToolCard({ b, result }: { b: Block; result?: Block }) {
  const cmd = b.name === 'apply_patch' ? null : extractCmd(b.input)
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-base)', padding: cmd ? '6px 10px' : '8px 10px', fontSize: 12.5 }}>
      {b.name === 'apply_patch' ? (
        <>
          <div style={{ color: CODEX_ACCENT, fontWeight: 600, fontSize: 12.5, marginBottom: 6 }}>✎ apply_patch</div>
          {b.input && <Diff text={b.input} />}
        </>
      ) : cmd ? (
        <div style={{ fontFamily: MONO }}>
          <span style={{ color: CODEX_ACCENT }}>❯</span>{' '}
          <span style={{ color: 'var(--text-bright)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{cmd}</span>
        </div>
      ) : (
        <div>
          <span style={{ color: CODEX_ACCENT, fontWeight: 600 }}>⚙ {b.name}</span>
          {argSummary(b.input) && <span style={{ color: 'var(--text-dim)', marginLeft: 8, fontFamily: MONO }}>{argSummary(b.input)}</span>}
        </div>
      )}
      {result && <ToolResult result={result} />}
    </div>
  )
}

export const CodexBubble = memo(function CodexBubble({ m, results }: { m: Msg; results: Record<string, Block> }) {
  const isUser = m.role === 'user'
  const isTool = m.role === 'tool'
  const align = isUser ? 'flex-end' : 'flex-start'
  const bg = isUser ? CODEX_ACCENT : isTool ? 'transparent' : 'var(--bg-container)'
  const border = isUser || isTool ? 'none' : '1px solid var(--border)'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: align, margin: '6px 0', gap: 2 }}>
      <div style={{ maxWidth: isUser ? '86%' : '100%', width: isUser ? 'auto' : '100%', background: bg, border, borderRadius: 12, padding: isTool ? 0 : '8px 12px', color: isUser ? '#fff' : 'var(--text-bright)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {m.blocks.map((b, i) => {
          if (b.kind === 'text') return <Markdown key={i} accent={isUser ? '#d6fff0' : CODEX_ACCENT}>{b.text || ''}</Markdown>
          if (b.kind === 'thinking') return <Collapsible key={i} label="推理" text={b.text} color="var(--text-dim)" />
          if (b.kind === 'tool_use') return <ToolCard key={i} b={b} result={b.id ? results[b.id] : undefined} />
          if (b.kind === 'tool_result') return <Collapsible key={i} label={b.isError ? '⚠ 输出（出错）' : '输出'} text={b.text} color={b.isError ? '#f85149' : 'var(--text-dim)'} />
          if (b.text) return <Markdown key={i} accent={CODEX_ACCENT}>{b.text}</Markdown>
          return null
        })}
      </div>
      {m.ts && !isTool && <span style={{ fontSize: 10, color: 'var(--text-dimmer)', padding: '0 4px' }}>{fmtTs(m.ts)}</span>}
    </div>
  )
})
