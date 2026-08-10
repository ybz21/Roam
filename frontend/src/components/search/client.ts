// 后端搜索接口的薄封装。两条：名字（便宜，跟着打字走）与内容（贵，显式触发）。
import { api } from '../../api'
import type { SearchHit, SearchResponse } from './types'

/** 项目 / 会话 / 项目文件名。dir 会把「当前所在目录」也当成一个搜索根。 */
export async function searchAll(
  q: string,
  opts?: { dir?: string; limit?: number; signal?: AbortSignal },
): Promise<SearchResponse> {
  const params = new URLSearchParams({ q })
  if (opts?.dir) params.set('dir', opts.dir)
  if (opts?.limit) params.set('limit', String(opts.limit))
  const res = await api('GET', '/search?' + params.toString(), undefined, { signal: opts?.signal })
  return {
    hits: res?.data?.hits || [],
    truncated: !!res?.data?.truncated,
    indexing: !!res?.data?.indexing,
    tookMs: res?.data?.tookMs || 0,
  }
}

/** 文件内容（rg / grep）。比名字搜索贵一到两个数量级，只在用户显式要求时调。 */
export async function searchContent(
  q: string,
  opts?: { dir?: string; signal?: AbortSignal },
): Promise<SearchResponse> {
  const params = new URLSearchParams({ q })
  if (opts?.dir) params.set('dir', opts.dir)
  const res = await api('GET', '/search/content?' + params.toString(), undefined, { signal: opts?.signal })
  const hits: SearchHit[] = (res?.data?.hits || []).map((h: any) => ({
    kind: 'content' as const,
    id: `${h.path}:${h.line}`,
    title: h.text,
    subtitle: h.rel,
    path: h.path,
    project: h.project,
    projectKey: h.projectKey,
    line: h.line,
    score: 0,
  }))
  return { hits, truncated: !!res?.data?.truncated, tookMs: res?.data?.tookMs || 0 }
}
