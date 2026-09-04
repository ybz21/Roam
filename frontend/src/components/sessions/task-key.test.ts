import { describe, it, expect } from 'vitest'
import { taskKeyOf, isLooseTask, looseSessionOf, LOOSE_PREFIX } from './task-key'

describe('会话归属的任务', () => {
  it('有 worktree 就归 worktree，key 是绝对路径', () => {
    expect(taskKeyOf('roam-cc', '/home/u/workspace/Roam/.worktrees/2026-0903-0953-0007'))
      .toBe('/home/u/workspace/Roam/.worktrees/2026-0903-0953-0007')
  })

  it('没有 worktree 的是散会话，不看项目目录', () => {
    expect(taskKeyOf('htop')).toBe(LOOSE_PREFIX + 'htop')
    expect(taskKeyOf('htop', '')).toBe(LOOSE_PREFIX + 'htop')
    expect(taskKeyOf('htop', null)).toBe(LOOSE_PREFIX + 'htop')
  })

  it('两个会话同一个 worktree 就是同一个任务', () => {
    const wt = '/w/.worktrees/a'
    expect(taskKeyOf('cc', wt)).toBe(taskKeyOf('sh', wt))
  })

  it('散会话能认出来、能拆回会话名', () => {
    expect(isLooseTask(taskKeyOf('x'))).toBe(true)
    expect(isLooseTask('/w/.worktrees/a')).toBe(false)
    expect(isLooseTask(null)).toBe(false)
    expect(looseSessionOf(taskKeyOf('x'))).toBe('x')
    expect(looseSessionOf('/w/.worktrees/a')).toBe('')
  })
})
