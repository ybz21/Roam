// Claude 工具调用 + 气泡渲染。工具按类型富展示（命令/写入/diff/待办…），
// 工具结果按 tool_use_id 折叠在对应调用之下。
import { memo, useState } from 'react'
import Markdown from '../Markdown'
import { CodeBox, Collapsible, Diff, MONO, fmtTs, ToolResult } from './blocks'
import type { Block, Msg } from './types'

function parseInput(input?: string): any {
  if (!input) return null
  try { return JSON.parse(input) } catch { return null }
}

// 工具名 → 图标 + 单行标题（取最有信息量的字段）
function toolHead(name?: string, o?: any): { icon: string; title: string } {
  const n = name || '工具'
  const s = (v: any) => (v == null ? '' : String(v))
  const clip = (v: string) => (v.length > 140 ? v.slice(0, 140) + '…' : v)
  switch (n) {
    case 'Bash': return { icon: '$', title: clip(s(o?.command)) }
    case 'Read': return { icon: '📖', title: clip(s(o?.file_path)) }
    case 'Write': return { icon: '✏️', title: clip(s(o?.file_path)) }
    case 'Edit': case 'MultiEdit': return { icon: '✏️', title: clip(s(o?.file_path)) }
    case 'NotebookEdit': return { icon: '📓', title: clip(s(o?.notebook_path)) }
    case 'Glob': return { icon: '🔍', title: clip(s(o?.pattern) + (o?.path ? `  @ ${o.path}` : '')) }
    case 'Grep': return { icon: '🔍', title: clip(s(o?.pattern) + (o?.path ? `  @ ${o.path}` : '')) }
    case 'Task': return { icon: '🤖', title: clip(s(o?.description || o?.subagent_type)) }
    case 'TodoWrite': return { icon: '☑', title: `${(o?.todos || []).length} 项待办` }
    case 'WebFetch': return { icon: '🌐', title: clip(s(o?.url)) }
    case 'WebSearch': return { icon: '🌐', title: clip(s(o?.query)) }
    default: {
      const key = o && ['command', 'file_path', 'path', 'pattern', 'query', 'prompt', 'description'].find((k) => o[k])
      return { icon: '⚙', title: clip(key ? s(o[key]) : (o ? JSON.stringify(o) : '')) }
    }
  }
}

// 工具调用的「详情体」：按工具类型展开有用信息
function ToolBody({ name, o, raw }: { name?: string; o: any; raw?: string }) {
  if (name === 'Bash') return <CodeBox text={o?.command || ''} />
  if (name === 'Write') return <CodeBox text={o?.content || ''} max={420} />
  if (name === 'Edit') {
    const minus = (o?.old_string || '').split('\n').map((l: string) => '- ' + l).join('\n')
    const plus = (o?.new_string || '').split('\n').map((l: string) => '+ ' + l).join('\n')
    return <div style={{ marginTop: 6 }}><Diff text={minus + (plus ? '\n' + plus : '')} /></div>
  }
  if (name === 'MultiEdit' && Array.isArray(o?.edits)) {
    return <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>{o.edits.map((e: any, i: number) => <ToolBody key={i} name="Edit" o={e} />)}</div>
  }
  if (name === 'TodoWrite' && Array.isArray(o?.todos)) {
    const mark: Record<string, string> = { completed: '✅', in_progress: '🔄', pending: '⬜' }
    return (
      <div style={{ marginTop: 6, fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {o.todos.map((t: any, i: number) => (
          <div key={i} style={{ color: t.status === 'completed' ? 'var(--text-dim)' : 'var(--text-bright)', textDecoration: t.status === 'completed' ? 'line-through' : 'none' }}>
            {mark[t.status] || '⬜'} {t.content}
          </div>
        ))}
      </div>
    )
  }
  if (name === 'Task') return <CodeBox text={o?.prompt || ''} max={260} />
  if (name === 'WebFetch') return <CodeBox text={o?.prompt || o?.url || ''} max={160} />
  const pretty = o ? JSON.stringify(o, null, 2) : (raw || '')
  return pretty ? <CodeBox text={pretty} /> : null
}

function ToolUse({ b, result }: { b: Block; result?: Block }) {
  const o = parseInput(b.input)
  const { icon, title } = toolHead(b.name, o)
  const [open, setOpen] = useState(false)
  const hasBody = !!(o || b.input)
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-base)', padding: '6px 10px', fontSize: 12.5 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, cursor: hasBody ? 'pointer' : 'default' }} onClick={() => hasBody && setOpen((v) => !v)}>
        <span style={{ color: '#d2a8ff', fontWeight: 600, flex: '0 0 auto' }}>{icon} {b.name}</span>
        {title && <span style={{ color: 'var(--text-dim)', fontFamily: MONO, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>}
        {hasBody && <span style={{ marginLeft: 'auto', color: 'var(--text-dimmer)', flex: '0 0 auto' }}>{open ? '▾' : '▸'}</span>}
      </div>
      {open && <ToolBody name={b.name} o={o} raw={b.input} />}
      {result && <ToolResult result={result} />}
    </div>
  )
}

export const ClaudeBubble = memo(function ClaudeBubble({ m, results }: { m: Msg; results: Record<string, Block> }) {
  const isUser = m.role === 'user'
  const isTool = m.role === 'tool'
  const align = isUser ? 'flex-end' : 'flex-start'
  const bg = isUser ? '#1f6feb' : isTool ? 'transparent' : 'var(--bg-container)'
  const border = isUser || isTool ? 'none' : '1px solid var(--border)'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: align, margin: '6px 0', gap: 2 }}>
      <div style={{ maxWidth: isUser ? '86%' : '100%', width: isUser ? 'auto' : '100%', background: bg, border, borderRadius: 12, padding: isTool ? 0 : '8px 12px', color: isUser ? '#fff' : 'var(--text-bright)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {m.blocks.map((b, i) => {
          if (b.kind === 'text') return <Markdown key={i} accent={isUser ? '#cfe1ff' : '#58a6ff'}>{b.text || ''}</Markdown>
          if (b.kind === 'thinking') return <Collapsible key={i} label="思考过程" text={b.text} color="var(--text-dim)" />
          if (b.kind === 'tool_use') return <ToolUse key={i} b={b} result={b.id ? results[b.id] : undefined} />
          if (b.kind === 'tool_result') return <Collapsible key={i} label={b.isError ? '⚠ 工具输出（错误）' : '工具输出'} text={b.text} color={b.isError ? '#f85149' : 'var(--text-dim)'} />
          if (b.text) return <Markdown key={i} accent="#58a6ff">{b.text}</Markdown>
          return null
        })}
      </div>
      {m.ts && !isTool && <span style={{ fontSize: 10, color: 'var(--text-dimmer)', padding: '0 4px' }}>{fmtTs(m.ts)}</span>}
    </div>
  )
})
