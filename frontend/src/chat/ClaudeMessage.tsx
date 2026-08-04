// Claude 工具调用 + 气泡渲染。工具按类型富展示（命令/写入/diff/待办…），
// 工具结果按 tool_use_id 折叠在对应调用之下。
import { memo, useState, type ReactNode } from 'react'
import Markdown from '../Markdown'
import { CodeBox, Collapsible, Diff, MONO, copyText, fmtTs, ToolResult } from './blocks'
import { useI18n } from '../i18n'
import type { Block, Msg } from './types'
import { BotIcon, CheckIcon, ChecklistIcon, CircleIcon, ClockIcon, Disclosure, GearIcon, GlobeIcon, NotebookIcon, PencilIcon, QuestionIcon, ReadIcon, SearchIcon, TerminalIcon } from '../icons'

function parseInput(input?: string): any {
  if (!input) return null
  try { return JSON.parse(input) } catch { return null }
}

// 工具名 → 图标 + 单行标题（取最有信息量的字段）。
// 图标是 SVG 不是 emoji：emoji 在各平台字体里大小/基线/配色全不一样，一列排下来高低不齐。
function toolHead(name: string | undefined, o: any, t: (key: string, vars?: Record<string, string | number>) => string): { icon: ReactNode; title: string } {
  const n = name || t('chat.tool')
  const s = (v: any) => (v == null ? '' : String(v))
  const clip = (v: string) => (v.length > 140 ? v.slice(0, 140) + '…' : v)
  switch (n) {
    case 'Bash': return { icon: <TerminalIcon />, title: clip(s(o?.command)) }
    case 'Read': return { icon: <ReadIcon />, title: clip(s(o?.file_path)) }
    case 'Write': return { icon: <PencilIcon />, title: clip(s(o?.file_path)) }
    case 'Edit': case 'MultiEdit': return { icon: <PencilIcon />, title: clip(s(o?.file_path)) }
    case 'NotebookEdit': return { icon: <NotebookIcon />, title: clip(s(o?.notebook_path)) }
    case 'Glob': return { icon: <SearchIcon />, title: clip(s(o?.pattern) + (o?.path ? `  @ ${o.path}` : '')) }
    case 'Grep': return { icon: <SearchIcon />, title: clip(s(o?.pattern) + (o?.path ? `  @ ${o.path}` : '')) }
    case 'Task': return { icon: <BotIcon size={13} />, title: clip(s(o?.description || o?.subagent_type)) }
    case 'TodoWrite': return { icon: <ChecklistIcon />, title: t('chat.todoCount', { count: (o?.todos || []).length }) }
    case 'WebFetch': return { icon: <GlobeIcon />, title: clip(s(o?.url)) }
    case 'WebSearch': return { icon: <GlobeIcon />, title: clip(s(o?.query)) }
    case 'AskUserQuestion': {
      const qs = Array.isArray(o?.questions) ? o.questions : []
      const more = qs.length > 1 ? ` (+${qs.length - 1})` : ''
      return { icon: <QuestionIcon size={13} />, title: clip(s(qs[0]?.question)) + more }
    }
    default: {
      const key = o && ['command', 'file_path', 'path', 'pattern', 'query', 'prompt', 'description'].find((k) => o[k])
      return { icon: <GearIcon />, title: clip(key ? s(o[key]) : (o ? JSON.stringify(o) : '')) }
    }
  }
}

// AskUserQuestion：每个问题一张卡片，列出候选项（纯展示，不回传选择）
function AskQuestions({ questions }: { questions: any[] }) {
  const { t } = useI18n()
  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {questions.map((q: any, i: number) => (
        <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-base)', padding: '6px 8px', fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
            {q?.header && <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{String(q.header)}</span>}
            <span style={{ color: 'var(--text-bright)', fontWeight: 600 }}>{String(q?.question || '')}</span>
            {q?.multiSelect === true && <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>{t('chat.askMultiSelect')}</span>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(Array.isArray(q?.options) ? q.options : []).map((op: any, j: number) => (
              <div key={j} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ color: 'var(--text-bright)', fontWeight: 600 }}>{String(op?.label ?? '')}</span>
                {op?.description && <span style={{ color: 'var(--text-dim)' }}>{String(op.description)}</span>}
                {op?.preview && <CodeBox text={String(op.preview)} max={220} />}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
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
    const mark = (status: string) => (
      status === 'completed' ? <span style={{ color: 'var(--ok)', display: 'flex' }}><CheckIcon size={12} /></span>
        : status === 'in_progress' ? <span style={{ color: '#d29922', display: 'flex' }}><ClockIcon size={12} /></span>
          : <span style={{ color: 'var(--text-dimmer)', display: 'flex' }}><CircleIcon size={12} /></span>
    )
    return (
      <div style={{ marginTop: 6, fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {o.todos.map((t: any, i: number) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, color: t.status === 'completed' ? 'var(--text-dim)' : 'var(--text-bright)', textDecoration: t.status === 'completed' ? 'line-through' : 'none' }}>
            {mark(t.status)}<span>{t.content}</span>
          </div>
        ))}
      </div>
    )
  }
  if (name === 'Task') return <CodeBox text={o?.prompt || ''} max={260} />
  if (name === 'WebFetch') return <CodeBox text={o?.prompt || o?.url || ''} max={160} />
  if (name === 'AskUserQuestion' && Array.isArray(o?.questions)) return <AskQuestions questions={o.questions} />
  const pretty = o ? JSON.stringify(o, null, 2) : (raw || '')
  return pretty ? <CodeBox text={pretty} /> : null
}

function ToolUse({ b, result }: { b: Block; result?: Block }) {
  const { t } = useI18n()
  const o = parseInput(b.input)
  const { icon, title } = toolHead(b.name, o, t)
  const [open, setOpen] = useState(false)
  const hasBody = !!(o || b.input)
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--bg-base)', padding: '6px 10px', fontSize: 'var(--fs-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, cursor: hasBody ? 'pointer' : 'default' }} onClick={() => hasBody && setOpen((v) => !v)}>
        <span style={{ color: 'var(--accent)', fontWeight: 600, flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}>{icon}{b.name}</span>
        {title && <span style={{ color: 'var(--text-dim)', fontFamily: MONO, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>}
        {hasBody && <span style={{ marginLeft: 'auto', color: 'var(--text-dimmer)', flex: '0 0 auto', display: 'inline-flex' }}><Disclosure open={open} /></span>}
      </div>
      {open && <ToolBody name={b.name} o={o} raw={b.input} />}
      {result && <ToolResult result={result} />}
    </div>
  )
}

function messageText(m: Msg): string {
  return m.blocks.map((b) => {
    if (b.kind === 'tool_use') return b.input || ''
    return b.text || ''
  }).filter(Boolean).join('\n\n')
}

export const ClaudeBubble = memo(function ClaudeBubble({ m, results }: { m: Msg; results: Record<string, Block> }) {
  const { t } = useI18n()
  const isUser = m.role === 'user'
  const isTool = m.role === 'tool'
  const align = isUser ? 'flex-end' : 'flex-start'
  const bg = isUser ? 'var(--accent-solid)' : isTool ? 'transparent' : 'var(--bg-container)'
  const border = isUser || isTool ? 'none' : '1px solid var(--border)'
  return (
    <div className="cc-msg" style={{ display: 'flex', flexDirection: 'column', alignItems: align, margin: '6px 0', gap: 2 }}>
      <div style={{ maxWidth: isUser ? '86%' : '100%', width: isUser ? 'auto' : '100%', background: bg, border, borderRadius: 12, padding: isTool ? 0 : '8px 12px', color: isUser ? '#fff' : 'var(--text-bright)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {m.blocks.map((b, i) => {
          if (b.kind === 'text') return <Markdown key={i} accent={isUser ? '#cfe1ff' : 'var(--accent)'}>{b.text || ''}</Markdown>
          if (b.kind === 'thinking') return <Collapsible key={i} label={t('chat.thinking')} text={b.text} color="var(--text-dim)" />
          if (b.kind === 'tool_use') return <ToolUse key={i} b={b} result={b.id ? results[b.id] : undefined} />
          if (b.kind === 'tool_result') return <Collapsible key={i} label={b.isError ? t('chat.toolOutputError') : t('chat.toolOutput')} text={b.text} color={b.isError ? '#f85149' : 'var(--text-dim)'} />
          if (b.text) return <Markdown key={i} accent="var(--accent)">{b.text}</Markdown>
          return null
        })}
      </div>
      {!isTool && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 10, color: 'var(--text-dimmer)', padding: '0 4px' }}>
          {m.ts && fmtTs(m.ts)}
          <button className="cc-msg-copy" onClick={() => copyText(messageText(m))}>{t('common.copy')}</button>
        </span>
      )}
    </div>
  )
})
