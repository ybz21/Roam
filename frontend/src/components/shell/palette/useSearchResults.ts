// 面板的数据侧：防抖、掐请求、合并三路结果。UI 只从这里拿一个 rows 数组。
//
// 本地那一路先出、后端结果回来再并进去：搜索框最忌讳「按一个键顿一下」，所以网络
// 永远不挡在渲染前面。请求带 AbortSignal，上一次没回来就掐掉——否则慢的那条后到
// 会把新结果盖掉。
import { useEffect, useMemo, useRef, useState } from 'react'
import { searchAll, searchContent, type SearchHit } from '../../search'
import { contentRows, localRows, mergeRows, remoteRows } from './rows'
import type { PaletteActions, PaletteItem, PaletteRow } from './types'

const DEBOUNCE_MS = 120

export function useSearchResults(query: string, items: PaletteItem[], actions: PaletteActions, dir?: string): {
  rows: PaletteRow[]
  busy: boolean
  contentBusy: boolean
  truncated: boolean
  /** 文件索引还在后台建：这一批文件结果可能不全 */
  indexing: boolean
  /** 跑一次全文搜索（贵，只在用户显式要求时） */
  runContentSearch: () => void
} {
  const needle = query.trim()
  const [remote, setRemote] = useState<SearchHit[]>([])
  const [content, setContent] = useState<SearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const [contentBusy, setContentBusy] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [indexing, setIndexing] = useState(false)
  const contentAbort = useRef<AbortController | null>(null)

  useEffect(() => {
    setContent([]) // 查询变了，上一轮的全文结果就过期了
    contentAbort.current?.abort()
    if (!needle) { setRemote([]); setTruncated(false); setIndexing(false); setBusy(false); return }
    const ac = new AbortController()
    setBusy(true)
    const timer = window.setTimeout(() => {
      searchAll(needle, { dir, signal: ac.signal })
        .then((r) => { setRemote(r.hits); setTruncated(r.truncated); setIndexing(!!r.indexing) })
        .catch(() => { /* abort / 掉线：保留上一批结果，不要闪成空 */ })
        .finally(() => setBusy(false))
    }, DEBOUNCE_MS)
    return () => { window.clearTimeout(timer); ac.abort() }
  }, [needle, dir])

  useEffect(() => () => contentAbort.current?.abort(), [])

  const runContentSearch = () => {
    if (!needle || contentBusy) return
    const ac = new AbortController()
    contentAbort.current = ac
    setContentBusy(true)
    searchContent(needle, { dir, signal: ac.signal })
      .then((r) => setContent(r.hits))
      .catch(() => { /* abort / 掉线：保持原样 */ })
      .finally(() => setContentBusy(false))
  }

  const rows = useMemo(
    () => mergeRows(localRows(needle, items), remoteRows(remote, items, actions), contentRows(content, actions)),
    [needle, items, remote, content, actions],
  )

  return { rows, busy, contentBusy, truncated, indexing, runContentSearch }
}
