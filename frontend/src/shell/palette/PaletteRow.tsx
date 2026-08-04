// 一行结果：类别图标 ｜ 标题（命中高亮）+ 副标题 ｜ 所属项目 ｜ 回车提示。
import type { ReactNode } from 'react'
import { EnterIcon, FileTextIcon, FolderIcon, PlugIcon, SearchIcon, SwarmIcon, TerminalIcon } from '../../icons'
import type { PaletteRow as Row } from './types'

// 兜底图标：条目自带图标（如页面用侧栏那枚）优先，这里只管没图标的那些
const KIND_ICON: Record<string, ReactNode> = {
  page: <SearchIcon size={15} />,
  command: <SearchIcon size={15} />,
  project: <FolderIcon size={15} />,
  session: <TerminalIcon size={15} />,
  plugin: <PlugIcon size={15} />,
  swarm: <SwarmIcon size={15} />,
  file: <FileTextIcon size={15} />,
  content: <FileTextIcon size={15} />,
}

export function PaletteRowView({ row, idx, active, onHover, onRun }: {
  row: Row
  idx: number
  active: boolean
  onHover: () => void
  onRun: () => void
}) {
  return (
    <button data-idx={idx} className={`tt-palette-row${active ? ' on' : ''}`} onMouseEnter={onHover} onClick={onRun}>
      <span className="ic">{row.icon || KIND_ICON[row.kind] || <SearchIcon size={15} />}</span>
      <span className="tx">
        <span className="t1">{highlight(row.title, row.positions)}</span>
        {row.subtitle && <span className="t2">{row.subtitle}</span>}
      </span>
      {row.kind === 'file' && row.badge && <span className="tag">{row.badge}</span>}
      {active && <span className="go"><EnterIcon size={13} /></span>}
    </button>
  )
}

/** 把命中的字符包成 <b>：结果里不标出「为什么它匹配」，用户只能靠猜 */
export function highlight(text: string, positions?: number[]): ReactNode {
  if (!positions || positions.length === 0) return text
  const chars = Array.from(text)
  const hit = new Set(positions)
  const out: ReactNode[] = []
  let buf = ''
  let bufHit = false
  const flush = (key: number) => {
    if (!buf) return
    out.push(bufHit ? <b key={key}>{buf}</b> : <span key={key}>{buf}</span>)
    buf = ''
  }
  chars.forEach((c, i) => {
    const h = hit.has(i)
    if (h !== bufHit) { flush(i); bufHit = h }
    buf += c
  })
  flush(chars.length)
  return out
}
