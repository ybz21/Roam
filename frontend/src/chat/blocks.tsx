// 对话渲染共用的小组件：代码框 / 折叠块 / 彩色 diff / 「正在生成」省略号。
import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { Block } from './types'

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

// 时间戳 → HH:MM（解析失败返回空）
export function fmtTs(ts?: string): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

// 跨 http（局域网非安全上下文）也能用的复制
function copyText(s: string) {
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(s).catch(() => {}); return }
  try {
    const ta = document.createElement('textarea')
    ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
  } catch {}
}

// text 始终用于复制；children(可选)是已高亮的节点，传入时渲染它而非纯文本。
export function CodeBox({ text, max = 320, className, children }: { text: string; max?: number; className?: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const onCopy = (e: ReactMouseEvent) => { e.stopPropagation(); copyText(text); setCopied(true); setTimeout(() => setCopied(false), 1200) }
  return (
    <div style={{ position: 'relative' }} className="cc-codebox">
      <button onClick={onCopy} title="复制" className="cc-copy"
        style={{ position: 'absolute', top: 6, right: 6, zIndex: 1, border: '1px solid var(--border)', background: 'var(--bg-container)', color: copied ? '#3fb950' : 'var(--text-dim)', borderRadius: 6, fontSize: 11, lineHeight: 1, padding: '3px 7px', cursor: 'pointer' }}>
        {copied ? '✓ 已复制' : '复制'}
      </button>
      <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '6px 0 0', maxHeight: max, overflow: 'auto', background: 'var(--bg-base)', padding: 8, borderRadius: 6, fontFamily: MONO, fontSize: 12, lineHeight: 1.5, color: 'var(--text-bright)' }}>
        <code className={className}>{children ?? text}</code>
      </pre>
    </div>
  )
}

// 工具调用的输出（折叠；出错默认展开）。Claude / Codex 共用。
export function ToolResult({ result }: { result: Block }) {
  const [open, setOpen] = useState(!!result.isError)
  return (
    <div style={{ marginTop: 6, borderTop: '1px dashed var(--border)', paddingTop: 4 }}>
      <a onClick={() => setOpen((v) => !v)} style={{ color: result.isError ? '#f85149' : 'var(--text-dim)', fontSize: 12 }}>
        {open ? '▾' : '▸'} {result.isError ? '⚠ 输出（错误）' : '输出'}
      </a>
      {open && <CodeBox text={result.text || '(空)'} />}
    </div>
  )
}

export function Collapsible({ label, text, color, open: dflt = false }: { label: string; text?: string; color: string; open?: boolean }) {
  const [open, setOpen] = useState(dflt)
  if (!text) return null
  return (
    <div style={{ fontSize: 12 }}>
      <a onClick={() => setOpen((o) => !o)} style={{ color }}>{open ? '▾' : '▸'} {label}</a>
      {open && <CodeBox text={text} />}
    </div>
  )
}

// 彩色 diff：+ 绿 / - 红 / @@,*** 紫。既能渲染补丁文本，也能渲染手动拼的 +/- 行。
export function Diff({ text, max = 360 }: { text: string; max?: number }) {
  return (
    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: max, overflow: 'auto', fontFamily: MONO, fontSize: 12, lineHeight: 1.45 }}>
      {text.split('\n').map((l, i) => {
        let color = 'var(--text-bright)'
        if (l.startsWith('+') && !l.startsWith('+++')) color = '#3fb950'
        else if (l.startsWith('-') && !l.startsWith('---')) color = '#f85149'
        else if (l.startsWith('@@') || l.startsWith('***')) color = '#d2a8ff'
        return <div key={i} style={{ color }}>{l || ' '}</div>
      })}
    </pre>
  )
}

export function Typing({ color = '#58a6ff' }: { color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start', margin: '6px 0' }}>
      <div style={{ background: 'var(--bg-container)', border: '1px solid var(--border)', borderRadius: 12, padding: '8px 14px', color: 'var(--text-dim)', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <span>正在生成</span>
        <span className="cc-dots" style={{ ['--cc-dot' as any]: color }}><i /><i /><i /></span>
      </div>
    </div>
  )
}
