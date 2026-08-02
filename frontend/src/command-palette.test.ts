import { describe, expect, it } from 'vitest'
import { filterActions, moveHighlight } from './command-palette'

const ACTIONS = [
  { key: 'a', label: '竖分屏', hint: 'Ctrl-b %', group: '分屏' },
  { key: 'b', label: '横分屏', hint: 'Ctrl-b "', group: '分屏' },
  { key: 'c', label: '关闭当前窗格', hint: 'Ctrl-b x', danger: true, group: '窗格 (Pane)' },
  { key: 'd', label: '新建窗口', hint: 'Ctrl-b c', group: '窗口 (Window)' },
]

describe('filterActions', () => {
  it('returns everything for an empty query', () => {
    expect(filterActions(ACTIONS, '')).toHaveLength(4)
    expect(filterActions(ACTIONS, '   ')).toHaveLength(4)
  })

  it('matches case-insensitively on the label', () => {
    expect(filterActions(ACTIONS, '分屏').map((a) => a.key)).toEqual(['a', 'b'])
  })

  it('matches on the group name too (including the parenthesized English part)', () => {
    expect(filterActions(ACTIONS, 'window').map((a) => a.key)).toEqual(['d'])
    expect(filterActions(ACTIONS, '窗口').map((a) => a.key)).toEqual(['d'])
  })

  it('returns nothing when nothing matches', () => {
    expect(filterActions(ACTIONS, 'zzz')).toEqual([])
  })
})

describe('moveHighlight', () => {
  it('advances forward and wraps past the end', () => {
    expect(moveHighlight(4, 0, 1)).toBe(1)
    expect(moveHighlight(4, 3, 1)).toBe(0)
  })

  it('moves backward and wraps past the start', () => {
    expect(moveHighlight(4, 0, -1)).toBe(3)
    expect(moveHighlight(4, 2, -1)).toBe(1)
  })

  it('returns -1 for an empty list', () => {
    expect(moveHighlight(0, 0, 1)).toBe(-1)
  })
})
