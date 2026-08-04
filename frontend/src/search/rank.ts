// 合并与排序：把本地条目、后端结果、全文结果并成一张列表。
//
// 排序规则只有两条，刻意做得死板：**先按类别的固定顺序，再按分数**。
// 不跨类别按分数重排——组的顺序一跳，用户刚瞄准的那一行就跑了；打字时列表本来就
// 在变，再让分组也漂，一次都点不中。
import { fuzzyBest } from './score'
import type { HitKind } from './types'

/** 类别顺序：本地能立刻到达的在前，要走网络找出来的在后 */
export const KIND_ORDER: HitKind[] = ['page', 'command', 'project', 'session', 'plugin', 'swarm', 'file', 'content']

/** 排在名单外的类别（后端新加的数据源）一律垫底，而不是靠 indexOf 的 -1 冲到最前 */
const kindRank = (k: HitKind) => {
  const i = KIND_ORDER.indexOf(k)
  return i < 0 ? KIND_ORDER.length : i
}

export type Rankable = { key: string; kind: HitKind; score: number }

/** 给本地条目打分并排序（不匹配的直接丢掉）。副字段打折规则见 fuzzyBest。 */
export function rankLocal<T extends { title: string; subtitle?: string; keywords?: string }>(
  query: string,
  items: T[],
): (T & { score: number; positions?: number[] })[] {
  const out: (T & { score: number; positions?: number[] })[] = []
  for (const it of items) {
    const m = fuzzyBest(query, [it.title, it.subtitle || '', it.keywords || ''].filter(Boolean))
    if (!m) continue
    out.push({ ...it, score: m.score, positions: m.positions })
  }
  return out.sort((a, b) => b.score - a.score || a.title.length - b.title.length)
}

/** 同 key 只留第一条：先来的（本地那一路）优先——同一个东西出现两次，用户会以为是两个 */
export function dedupeByKey<T extends { key: string }>(rows: T[]): T[] {
  const seen = new Set<string>()
  return rows.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)))
}

/** 先类别、后分数的稳定排序 */
export function sortByKind<T extends Rankable>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ka = kindRank(a.kind), kb = kindRank(b.kind)
    if (ka !== kb) return ka - kb
    return b.score - a.score
  })
}
