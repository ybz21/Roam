// path → i18n 标签映射（评审点10）。
// 后端 connected.path 是稳定枚举字符串（线协议的一部分，不翻译）；这里只把它映射到
// i18n key，由调用方用 t(pathLabelKey(path)) 取本地化文案。回退走 frp 时 path='frp'。

import type { PathKind } from './types'

// 后端可能上报的路径枚举 + 回退态 'frp'。
export type P2PPathLabel = PathKind | 'frp'

// 稳定枚举 → i18n key。未知值兜底到 p2p.path.unknown。
const PATH_LABEL_KEYS: Record<string, string> = {
  'ipv6-direct': 'p2p.path.ipv6Direct',
  upnp: 'p2p.path.upnp',
  stun: 'p2p.path.stun',
  lan: 'p2p.path.lan',
  frp: 'p2p.path.frp',
}

// 返回该 path 对应的 i18n key。调用方：t(pathLabelKey(m.path))。
export function pathLabelKey(path: string | undefined | null): string {
  if (!path) return 'p2p.path.unknown'
  return PATH_LABEL_KEYS[path] ?? 'p2p.path.unknown'
}
