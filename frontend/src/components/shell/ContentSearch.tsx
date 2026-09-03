// 右栏「内容」搜索（22 设计 §3.4）：在当前任务的 worktree 里搜文件内容（rg，没装回落 grep）。
//
// 只在回车时跑——它比名字搜索贵一到两个数量级（search.md）；结果按文件分组、行号 + 命中行，
// 点行开成中间的文件标签并定位到那一行。名字搜索走 FileBrowser 自己那枚放大镜，不在这。
import { useEffect, useRef, useState } from 'react'
import { Input, Spin, type InputRef } from 'antd'
import { useI18n } from '../../i18n'
import { searchContent } from '../search/client'
import type { SearchHit } from '../search/types'
import { FileTypeIcon } from '../files/file-icons'
import { SearchIcon } from '../../icons'

export function ContentSearch({ dir, onOpen, focusNonce }: {
  dir: string
  onOpen: (path: string, line?: number) => void
  /** 外面（⌘⇧F）要求聚焦输入框；自增触发 */
  focusNonce?: number
}) {
  const { t } = useI18n()
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [meta, setMeta] = useState<{ truncated: boolean; tookMs: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const ref = useRef<InputRef>(null)
  const abort = useRef<AbortController | null>(null)
  useEffect(() => { if (focusNonce) ref.current?.focus() }, [focusNonce])
  // 换任务 = 换根：上一个 worktree 的结果不该留在新任务下面
  useEffect(() => { setHits(null); setMeta(null); setErr('') }, [dir])

  const run = async () => {
    const query = q.trim()
    if (!query || !dir) return
    abort.current?.abort()
    const ac = new AbortController()
    abort.current = ac
    setBusy(true); setErr('')
    try {
      const r = await searchContent(query, { dir, signal: ac.signal })
      if (ac.signal.aborted) return
      setHits(r.hits); setMeta({ truncated: r.truncated, tookMs: r.tookMs })
    } catch (e: any) {
      if (!ac.signal.aborted) setErr(e?.message || String(e))
    } finally {
      if (!ac.signal.aborted) setBusy(false)
    }
  }

  // 按文件分组，顺序照后端给的
  const groups: { path: string; rel: string; lines: SearchHit[] }[] = []
  for (const h of hits || []) {
    const g = groups.find((x) => x.path === h.path)
    if (g) g.lines.push(h); else groups.push({ path: h.path!, rel: h.subtitle || h.path!, lines: [h] })
  }

  return (
    <div className="tt-csearch">
      <Input ref={ref} value={q} onChange={(e) => setQ(e.target.value)} onPressEnter={run} allowClear
        prefix={<SearchIcon size={14} />} placeholder={t('search.contentPlaceholder')} />
      <div className="tt-csearch-body">
        {busy && <div className="tt-csearch-note"><Spin size="small" /></div>}
        {!busy && err && <div className="tt-csearch-note">{err}</div>}
        {!busy && !err && hits === null && <div className="tt-csearch-note">{t('search.contentHint')}</div>}
        {!busy && !err && hits !== null && hits.length === 0 && <div className="tt-csearch-note">{t('search.contentNone')}</div>}
        {!busy && !err && hits !== null && hits.length > 0 && meta && (
          <div className="tt-csearch-note">{t('search.contentSummary', { n: hits.length, files: groups.length, ms: meta.tookMs })}{meta.truncated ? ` · ${t('search.contentTruncated')}` : ''}</div>
        )}
        {!busy && groups.map((g) => (
          <div key={g.path} className="tt-csearch-file">
            <button type="button" className="tt-csearch-fname" onClick={() => onOpen(g.path)} title={g.path}>
              <span className="fi"><FileTypeIcon name={g.rel} /></span>
              <span className="nm">{g.rel.split('/').pop()}</span>
              <span className="dir">{g.rel.split('/').slice(0, -1).join('/')}</span>
              <span className="cnt">{g.lines.length}</span>
            </button>
            {g.lines.map((h) => (
              <button key={h.id} type="button" className="tt-csearch-line" onClick={() => onOpen(g.path, h.line)} title={`${g.rel}:${h.line}`}>
                <span className="no">{h.line}</span><span className="tx">{h.title}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
