// 会话展示名（tmux 用户选项 @roam_name）的全局小表。
//
// 会话名 = 会话 id（2026-0728-1808-0000）：不可变、不重名、没有 tmux `-t` 前缀
// 匹配的歧义，所以 API/WS/URL 一律用它当 handle。但 id 不是给人读的，界面统一
// 显示「名字（id）」——名字就是这里存的展示名。
//
// 用一张模块级小表 + useSyncExternalStore 而不是层层传 props：终端标签、页头、
// 文件区、对话页都要显示名字，它们分散在各处，但数据源只有会话列表那一份轮询。
import { useSyncExternalStore } from 'react'

let labels: Record<string, string> = {}
const listeners = new Set<() => void>()

/** 用最新的会话列表刷新展示名表（{会话名: 展示名}）。内容没变就不触发重渲染。 */
export function setSessionLabels(next: Record<string, string>) {
  const keys = Object.keys(next)
  if (keys.length === Object.keys(labels).length && keys.every((k) => labels[k] === next[k])) return
  labels = next
  listeners.forEach((fn) => fn())
}

/** 就地改一个会话的展示名（改名后立刻生效，不等下一轮列表轮询）。 */
export function updateSessionLabel(name: string, label: string) {
  if (!name || labels[name] === label) return
  labels = { ...labels, [name]: label }
  listeners.forEach((fn) => fn())
}

/** 会话的展示名；没登记过（列表还没回来/裸 tmux 建的）就退回会话名本身。 */
export function sessionLabel(name?: string | null): string {
  if (!name) return ''
  return labels[name] || name
}

/** 展示口径「名字（id）」的纯文本形式（document.title、tooltip、确认框文案用）。 */
export function sessionDisplay(name?: string | null): string {
  if (!name) return ''
  const label = sessionLabel(name)
  return label === name ? name : `${label}（${name}）`
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useSessionLabel(name?: string | null): string {
  return useSyncExternalStore(subscribe, () => sessionLabel(name), () => sessionLabel(name))
}

/** 会话标题：名字为主，id 跟在后面弱化显示（名字缺失时只显示 id）。 */
export function SessionTitle({ name, showId = true, style }: { name: string; showId?: boolean; style?: React.CSSProperties }) {
  const label = useSessionLabel(name)
  return (
    <span style={style}>
      {label}
      {showId && label !== name && (
        <span style={{ opacity: 0.5, fontSize: '.85em', marginLeft: 4, fontWeight: 400 }}>({name})</span>
      )}
    </span>
  )
}
