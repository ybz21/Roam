import { describe, expect, it, vi } from 'vitest'
import type { SearchHit } from '../../search'
import { contentRows, localRows, mergeRows, remoteRows } from './rows'
import type { PaletteActions, PaletteItem } from './types'

const noop = () => {}
const items: PaletteItem[] = [
  { key: 'page:overview', group: '页面', title: '概览', keywords: 'overview', run: noop },
  { key: 'page:files', group: '页面', title: '文件', keywords: 'files', run: noop },
  { key: 'term:2026-0728-1150-0142', group: '会话', title: 'roam · dev', run: noop },
]
const actions = (): PaletteActions => ({ openSession: vi.fn(), openRoute: vi.fn(), openFile: vi.fn() })

describe('localRows', () => {
  it('空查询原样列出（那是「你能去哪」，不是搜索结果）', () => {
    expect(localRows('', items)).toHaveLength(items.length)
  })

  it('有查询时过滤并打分，别名也算', () => {
    expect(localRows('overview', items).map((r) => r.key)).toEqual(['page:overview'])
  })

  it('已打开的会话归到 session 类', () => {
    const rows = localRows('roam', items)
    expect(rows[0].kind).toBe('session')
  })
})

describe('remoteRows', () => {
  const hit = (over: Partial<SearchHit>): SearchHit => ({
    kind: 'file', id: '/x/a.go', title: 'a.go', score: 10, ...over,
  })

  it('已经开着的会话不再从后端那一路重复出现', () => {
    const hits = [
      hit({ kind: 'session', id: '2026-0728-1150-0142', title: 'roam · dev' }),
      hit({ kind: 'session', id: 'other-session', title: '别的会话' }),
    ]
    expect(remoteRows(hits, items, actions()).map((r) => r.key)).toEqual(['session:other-session'])
  })

  it('点开只按后端给的 action 分发，不看 kind', () => {
    const a = actions()
    const rows = remoteRows([
      hit({ kind: 'project', id: 'p1', title: 'roam', action: { type: 'route', target: '#/projects/p1' } }),
      hit({ kind: 'session', id: 's1', title: 'sess', action: { type: 'session', target: 's1' } }),
      hit({ kind: 'file', id: '/x/a.go', title: 'a.go', action: { type: 'file', target: '/x/a.go' } }),
      // 后端新加的数据源：前端没为它写过任何分支，照样能打开
      hit({ kind: 'plugin', id: 'roam.cron', title: '定时任务', action: { type: 'route', target: '#/plugins' } }),
    ], items, a)
    rows.forEach((r) => r.run())
    expect(a.openRoute).toHaveBeenCalledWith('#/projects/p1')
    expect(a.openRoute).toHaveBeenCalledWith('#/plugins')
    expect(a.openSession).toHaveBeenCalledWith('s1')
    expect(a.openFile).toHaveBeenCalledWith('/x/a.go')
  })

  it('老后端没给 action 时按 path / projectKey 兜底', () => {
    const a = actions()
    remoteRows([hit({ kind: 'file', id: '/x/a.go', path: '/x/a.go', title: 'a.go' })], items, a)[0].run()
    expect(a.openFile).toHaveBeenCalledWith('/x/a.go')
  })

  it('文件结果把所属项目挂到右侧标签上', () => {
    const rows = remoteRows([hit({ project: 'roam' })], items, actions())
    expect(rows[0].badge).toBe('roam')
  })
})

describe('contentRows', () => {
  it('副标题是「相对路径:行号」，点开打开那个文件', () => {
    const a = actions()
    const rows = contentRows([{
      kind: 'content', id: '/x/a.go:12', title: 'func Search()', subtitle: 'x/a.go',
      path: '/x/a.go', line: 12, score: 0,
    }], a)
    expect(rows[0].subtitle).toBe('x/a.go:12')
    rows[0].run()
    expect(a.openFile).toHaveBeenCalledWith('/x/a.go')
  })
})

describe('mergeRows', () => {
  it('按类别固定顺序排：页面 → 项目 → 会话 → 文件', () => {
    const local = localRows('', items)
    const remote = remoteRows([
      { kind: 'project', id: 'p1', projectKey: 'p1', title: 'roam', score: 500 },
      { kind: 'file', id: '/x/a.go', path: '/x/a.go', title: 'a.go', score: 900 },
    ], items, actions())
    const rows = mergeRows(local, remote, [])
    expect(rows.map((r) => r.kind)).toEqual(['page', 'page', 'project', 'session', 'file'])
  })
})
