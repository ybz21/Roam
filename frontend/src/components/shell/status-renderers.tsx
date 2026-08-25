// 状态条的四种渲染器。**插件只能从这四种里选，不能自带**——插件是外部进程
// （plugin run 每次一个短命子进程），让它往页面里塞标记等于把 XSS 写进设计。
// 图标同理：只能按名字从这张表里取，取不到就不画（设计 §05 约束①）。
import type { ReactNode } from 'react'
import {
  ArrowDown, ArrowUp, ChecklistIcon, ClockIcon, CloudIcon, DiffIcon, ForkIcon, GlobeIcon,
  LinkIcon, MegaphoneIcon, PlugIcon, SwarmIcon, TerminalIcon, WarnIcon,
} from '../../icons'
import { HostIcon } from '../cluster/cluster-icons'
import { formatValue, type Cell } from './status-cells'

/** 插件可用的图标名。名字是契约的一部分，改名等于改公开 API */
const ICONS: Record<string, (p: { size?: number }) => ReactNode> = {
  ArrowDown, ArrowUp, ChecklistIcon, ClockIcon, CloudIcon, DiffIcon, ForkIcon, GlobeIcon,
  HostIcon, LinkIcon, MegaphoneIcon, PlugIcon, SwarmIcon, TerminalIcon, WarnIcon,
}

export function cellIcon(name?: string): ReactNode {
  if (!name) return null
  const Ic = ICONS[name]
  return Ic ? <Ic size={13} /> : null
}

/** 迷你条：只在 gauge 用。0..100 之外的值夹住，插件报 -5 或 130 不该画出界 */
function Gauge({ pct }: { pct: number }) {
  return (
    <span className="mini" aria-hidden>
      <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </span>
  )
}

export function CellBody({ cell }: { cell: Cell }) {
  const text = formatValue(cell.val, cell.unit)
  const icon = cellIcon(cell.icon)
  // danger 档才配警示标：三个颜色一起亮的时候，多一枚图标只是更吵
  const badge = cell.severity === 'danger' ? <WarnIcon size={13} /> : icon
  switch (cell.render) {
    case 'gauge':
      return (
        <>
          {badge}
          {cell.label && <span className="lb">{cell.label}</span>}
          <Gauge pct={cell.val.value ?? 0} />
          <span className="vl">{text}</span>
        </>
      )
    case 'dot':
      return (
        <>
          <i className={`dot ${cell.severity}`} aria-hidden />
          {cell.label && <span className="lb">{cell.label}</span>}
          <span className="vl">{text}</span>
        </>
      )
    case 'progress':
      return (
        <>
          <i className="spin" aria-hidden />
          {cell.label && <span className="lb">{cell.label}</span>}
          <span className="vl">{text}</span>
        </>
      )
    default:
      return (
        <>
          {badge}
          {cell.label && <span className="lb">{cell.label}</span>}
          <span className="vl">{text}</span>
        </>
      )
  }
}
