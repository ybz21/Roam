// 与 backend/search/score_test.go 同一批用例：两份实现只要有一份漂了，
// 合并后的排序就会自相矛盾（同一个东西在两路里分数不同）。
import { describe, expect, it } from 'vitest'
import { fuzzyBest, fuzzyScore } from './score'
import { rankLocal, dedupeByKey, sortByKind } from './rank'

describe('fuzzyScore', () => {
  it('首字母缩写能命中，不存在的子序列不命中', () => {
    expect(fuzzyScore('ovw', 'Overview.tsx')).not.toBeNull()
    expect(fuzzyScore('zzz', 'Overview.tsx')).toBeNull()
    expect(fuzzyScore('', 'anything')).toBeNull()
  })

  it('词首命中压过散落在中间的巧合', () => {
    const head = fuzzyScore('api', 'backend/api/api.go')!
    const tail = fuzzyScore('api', 'backend/xapixzz/notes.md')!
    expect(head.score).toBeGreaterThan(tail.score)
  })

  it('连续命中压过被打散的命中', () => {
    const solid = fuzzyScore('search', 'search.go')!
    const spread = fuzzyScore('search', 's_e_a_r_c_h.go')!
    expect(solid.score).toBeGreaterThan(spread.score)
  })

  it('忽略大小写', () => {
    expect(fuzzyScore('OVERVIEW', 'overview.tsx')).not.toBeNull()
  })

  it('多个词是 AND', () => {
    expect(fuzzyScore('api search', 'backend/api/search.go')).not.toBeNull()
    expect(fuzzyScore('api zzz', 'backend/api/search.go')).toBeNull()
  })

  it('命中位置严格递增且指向对的字符', () => {
    const m = fuzzyScore('apgo', 'backend/api/api.go')!
    const target = Array.from('backend/api/api.go')
    const want = Array.from('apgo')
    expect(m.positions).toHaveLength(4)
    m.positions.forEach((p, i) => {
      expect(target[p]).toBe(want[i])
      if (i > 0) expect(p).toBeGreaterThan(m.positions[i - 1])
    })
  })

  it('中文按子串/子序列匹配', () => {
    expect(fuzzyScore('概览', '概览页 Overview')).not.toBeNull()
    expect(fuzzyScore('概设', '概览设计')).not.toBeNull()
  })
})

describe('fuzzyBest', () => {
  it('主字段命中给位置，副字段命中打折且不给位置', () => {
    const name = fuzzyBest('search', ['search.go', '/home/x/deep/search/other.go'])!
    expect(name.positions).toBeDefined()
    const sub = fuzzyBest('search', ['other.go', '/home/x/search/other.go'])!
    expect(sub.positions).toBeUndefined()
    expect(sub.score).toBeLessThan(name.score)
  })

  it('一个字段都不匹配就返回 null', () => {
    expect(fuzzyBest('zzz', ['a.go', 'b/c.go'])).toBeNull()
  })
})

describe('rankLocal', () => {
  it('丢掉不匹配的，按分数排', () => {
    const items = [
      { key: 'a', title: 'Overview' },
      { key: 'b', title: 'Projects' },
      { key: 'c', title: 'Over the top view' },
    ]
    const out = rankLocal('overview', items)
    expect(out.map((i) => i.key)).toEqual(['a', 'c'])
  })

  it('别名（keywords）也参与匹配', () => {
    const out = rankLocal('files', [{ key: 'a', title: '文件', keywords: 'files' }])
    expect(out).toHaveLength(1)
  })
})

describe('合并规则', () => {
  it('同 key 只留第一条', () => {
    const rows = [{ key: 'x', n: 1 }, { key: 'x', n: 2 }, { key: 'y', n: 3 }]
    expect(dedupeByKey(rows).map((r) => r.n)).toEqual([1, 3])
  })

  it('先按类别固定顺序，再按分数', () => {
    const rows = [
      { key: '1', kind: 'file' as const, score: 999 },
      { key: '2', kind: 'page' as const, score: 1 },
      { key: '3', kind: 'session' as const, score: 5 },
      { key: '4', kind: 'session' as const, score: 50 },
    ]
    expect(sortByKind(rows).map((r) => r.key)).toEqual(['2', '4', '3', '1'])
  })
})
