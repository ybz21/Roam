import { describe, it, expect } from 'vitest'
import { buildTaskTree } from './task-tree'
import { LOOSE_PREFIX } from '../sessions/task-key'

const roam = { key: 'roam', name: 'Roam', dir: '/w/Roam', git: true, waiting: 1, unfinished: 1,
  top: [{ name: 'roam-cc', label: '三栏重做', running: true, agent: 'claude' as const }],
  needs: [{ name: 'roam-cx', label: '接回对话', waiting: true, agent: 'codex' as const }] }
const wts = {
  roam: [
    { path: '/w/Roam', branch: 'main', isMain: true, sessions: [{ session: 'in-main' }] },
    { path: '/w/Roam/.worktrees/a', branch: 'chore/a', isMain: false, committedAhead: 2, sessions: [{ session: 'roam-cc' }, { session: 'roam-sh' }] },
    { path: '/w/Roam/.worktrees/b', branch: 'fix/b', isMain: false, sessions: [{ session: 'roam-cx' }] },
    { path: '/w/Roam/.worktrees/c', branch: 'feat/c', isMain: false, committedAhead: 3, sessions: [] },
  ],
}
const sessions = [
  { name: 'roam-cc', label: '三栏重做' }, { name: 'roam-sh' }, { name: 'roam-cx', label: '接回对话' },
  { name: 'in-main', label: '主仓库里开的' }, { name: 'htop' },
]

describe('项目树读模型', () => {
  const tree = buildTaskTree({ projects: [roam], worktrees: wts, sessions })

  it('worktree 是任务，主仓库不是', () => {
    expect(tree.projects[0].tasks.map((t) => t.branch)).toEqual(['chore/a', 'fix/b', 'feat/c'])
    expect(tree.projects[0].tasks[0].key).toBe('/w/Roam/.worktrees/a')
  })

  it('任务名取第一个会话的展示名，没有会话就用分支名', () => {
    const [a, , c] = tree.projects[0].tasks
    expect(a.name).toBe('三栏重做')
    expect(c.name).toBe('feat/c')
  })

  it('会话都关了还有未合并提交 = 待收尾', () => {
    const [a, b, c] = tree.projects[0].tasks
    expect(c.unfinished).toBe(true)
    expect(a.unfinished).toBe(false) // 有会话，ahead 再多也不算待收尾
    expect(b.unfinished).toBe(false)
  })

  it('agent / running / waiting 从 /projects 的 top 与 needs 里来', () => {
    const [a, b] = tree.projects[0].tasks
    expect(a.sessions[0]).toMatchObject({ name: 'roam-cc', agent: 'claude', running: true })
    expect(a.sessions[1]).toMatchObject({ name: 'roam-sh', label: 'roam-sh' })
    expect(b.sessions[0]).toMatchObject({ agent: 'codex', waiting: true })
  })

  it('主仓库里的会话和不在任何项目里的会话都是散会话', () => {
    expect(tree.loose.map((s) => s.name)).toEqual(['in-main', 'htop'])
    expect(tree.loose[0].label).toBe('主仓库里开的')
  })

  it('项目行的计数 = 等待 + 待收尾', () => {
    expect(tree.projects[0].needs).toBe(2)
  })

  it('已打开会话探测到的 agent 优先于 top 名单', () => {
    const t2 = buildTaskTree({ projects: [roam], worktrees: wts, sessions, agentOf: (n) => (n === 'roam-sh' ? 'codex' : undefined) })
    expect(t2.projects[0].tasks[0].sessions[1].agent).toBe('codex')
  })

  it('散会话的 key 带前缀，不会和路径撞', () => {
    expect(LOOSE_PREFIX + 'htop').not.toMatch(/^\//)
  })
})
