import { describe, it, expect } from 'vitest'
import { reorderTabs } from './tabs'

const L = ['a', 'b', 'c', 'd']

describe('标签拖拽排序', () => {
  it('往左拖：插到目标位置', () => {
    expect(reorderTabs(L, 'c', 0)).toEqual(['c', 'a', 'b', 'd'])
    expect(reorderTabs(L, 'd', 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('往右拖：摘掉源标签后插入位左移一格', () => {
    // 把 a 拖到 c 的右半边 → to = 2；摘掉 a 之后 ['b','c','d']，应插在 c 后面
    expect(reorderTabs(L, 'a', 3)).toEqual(['b', 'c', 'a', 'd'])
    expect(reorderTabs(L, 'a', 4)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('拖回原位是恒等，不制造抖动', () => {
    expect(reorderTabs(L, 'b', 1)).toEqual(L)
    expect(reorderTabs(L, 'b', 2)).toEqual(L)
  })

  it('越界钳住，不丢标签', () => {
    expect(reorderTabs(L, 'a', 99)).toEqual(['b', 'c', 'd', 'a'])
    expect(reorderTabs(L, 'a', -5)).toEqual(L)
    expect(reorderTabs(L, '不存在', 0)).toEqual(L)
  })

  it('任何一次拖拽都不增删标签', () => {
    for (const n of L) {
      for (let to = 0; to <= L.length; to++) {
        expect([...reorderTabs(L, n, to)].sort()).toEqual([...L].sort())
      }
    }
  })
})
