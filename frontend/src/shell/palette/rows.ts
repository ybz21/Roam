// 三路结果 → 一张列表的纯函数（无 React、无网络，行为都钉在 rows.test.ts）。
import { dedupeByKey, rankLocal, sortByKind, type SearchHit } from '../../search'
import type { PaletteActions, PaletteItem, PaletteRow } from './types'

/** 已打开的会话在本地那一路的 key 前缀（见 App.tsx 的 paletteItems） */
const TERM_PREFIX = 'term:'

const localKind = (key: string) => (key.startsWith(TERM_PREFIX) ? 'session' : 'page') as PaletteRow['kind']

/** 本地条目 → 行。空查询时原样列出（那是「你能去哪」，不是搜索结果）。 */
export function localRows(query: string, items: PaletteItem[]): PaletteRow[] {
  // 页面那一段带着侧栏那枚图标一起过来：面板里再画一个通用放大镜，等于把「概览/项目/
  // 会话」八行画成一模一样的八行，用户得逐行读字才能分辨。
  const toRow = (i: PaletteItem, score: number, positions?: number[]): PaletteRow => ({
    key: i.key, kind: localKind(i.key), title: i.title, subtitle: i.desc,
    icon: i.icon, badge: i.group, positions, score, run: i.run,
  })
  if (!query) return items.map((i) => toRow(i, 0))
  return rankLocal(query, items.map((i) => ({ ...i, subtitle: i.desc })))
    .map((i) => toRow(i, i.score, i.positions))
}

/**
 * 打开一条结果：只认后端给的三种动作，不认它背后是项目还是插件。
 * 后端加一类可搜的东西（search_sources.go）时，这里一行都不用改。
 */
export function runAction(hit: SearchHit, actions: PaletteActions): () => void {
  const a = hit.action
  return () => {
    if (a?.type === 'session') actions.openSession(a.target)
    else if (a?.type === 'file') actions.openFile(a.target)
    else if (a?.type === 'route') actions.openRoute(a.target)
    // 兜底：老版本后端没有 action 字段时，按最常见的两类猜一次
    else if (hit.path) actions.openFile(hit.path)
    else if (hit.projectKey) actions.openRoute('#/projects/' + encodeURIComponent(hit.projectKey))
  }
}

/** 后端结果 → 行。已经开着的会话交给本地那一路，这里去掉，免得同一个东西出现两次。 */
export function remoteRows(hits: SearchHit[], items: PaletteItem[], actions: PaletteActions): PaletteRow[] {
  const open = new Set(items.filter((i) => i.key.startsWith(TERM_PREFIX)).map((i) => i.key.slice(TERM_PREFIX.length)))
  return hits
    .filter((h) => !(h.kind === 'session' && open.has(h.id)))
    .map((h) => ({
      key: `${h.kind}:${h.id}`,
      kind: h.kind,
      title: h.title,
      subtitle: h.subtitle,
      badge: h.kind === 'file' ? h.project : undefined,
      positions: h.positions,
      score: h.score,
      run: runAction(h, actions),
    }))
}

/** 全文结果 → 行：标题是命中的那行代码，副标题是「相对路径:行号」 */
export function contentRows(hits: SearchHit[], actions: PaletteActions): PaletteRow[] {
  return hits.map((h) => ({
    key: `content:${h.id}`,
    kind: 'content' as const,
    title: h.title,
    subtitle: `${h.subtitle}:${h.line}`,
    badge: h.project,
    score: 0,
    run: runAction(h, actions),
  }))
}

/** 合并：本地在前（同 key 时它赢），然后按类别固定顺序 + 分数排 */
export function mergeRows(local: PaletteRow[], remote: PaletteRow[], content: PaletteRow[]): PaletteRow[] {
  return sortByKind(dedupeByKey([...local, ...remote, ...content]))
}
