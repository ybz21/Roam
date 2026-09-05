// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { loadTreeSrc, saveTreeSrc } from './task-tree-snapshot'

const src = { projects: [{ key: 'roam', name: 'Roam', dir: '/w/Roam', git: true }], worktrees: { roam: [{ path: '/w/Roam', branch: 'main', isMain: true }] } }

describe('项目树本地快照', () => {
  beforeEach(() => localStorage.clear())

  it('存了就能原样拿回来', () => {
    saveTreeSrc(src, 'n1')
    expect(loadTreeSrc('n1')).toEqual(src)
  })

  it('每台机器各记各的：拿别的机器的槽是空树', () => {
    saveTreeSrc(src, 'n1')
    expect(loadTreeSrc('n2')).toEqual({ projects: [], worktrees: {} })
    expect(loadTreeSrc(null)).toEqual({ projects: [], worktrees: {} })
  })

  it('隔了一天的快照不再顶上', () => {
    saveTreeSrc(src, 'n1')
    const all = JSON.parse(localStorage.getItem('roam.tree') || '{}')
    all.n1.at = Date.now() - 25 * 3600 * 1000
    localStorage.setItem('roam.tree', JSON.stringify(all))
    expect(loadTreeSrc('n1')).toEqual({ projects: [], worktrees: {} })
  })

  it('存坏了当没存过，不该崩', () => {
    localStorage.setItem('roam.tree', '{ not json')
    expect(loadTreeSrc('n1')).toEqual({ projects: [], worktrees: {} })
  })

  it('机器多了按最后使用时间淘汰，刚写的那台一定留着', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) saveTreeSrc(src, id)
    const kept = Object.keys(JSON.parse(localStorage.getItem('roam.tree') || '{}'))
    expect(kept).toContain('e')
    expect(kept.length).toBe(4)
  })
})
