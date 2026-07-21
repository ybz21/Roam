// 差异文本按行着色：+ 绿 / - 红 / @@ 蓝 / 头部灰（GitPanel / Race / WorktreePanel 共用）。
export default function DiffView({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <pre style={{ margin: 0, whiteSpace: 'pre', overflow: 'auto', height: '100%', boxSizing: 'border-box', background: 'var(--bg-base)', padding: 12, fontFamily: 'ui-monospace, monospace', fontSize: 12.5, lineHeight: 1.5 }}>
      {lines.map((ln, i) => {
        let color = 'var(--text-bright)'
        let bg = 'transparent'
        if (ln.startsWith('@@')) color = 'hsl(210,75%,62%)'
        else if (ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('diff ') || ln.startsWith('index ') || ln.startsWith('new file') || ln.startsWith('deleted file') || ln.startsWith('rename ') || ln.startsWith('similarity ')) color = 'var(--text-dim)'
        else if (ln.startsWith('+')) { color = 'hsl(140,60%,62%)'; bg = 'hsla(140,60%,45%,.08)' }
        else if (ln.startsWith('-')) { color = 'hsl(0,72%,66%)'; bg = 'hsla(0,72%,50%,.08)' }
        return <div key={i} style={{ color, background: bg, minHeight: '1.5em' }}>{ln || ' '}</div>
      })}
    </pre>
  )
}
