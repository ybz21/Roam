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

  it('worktree 是任务；主仓库里有会话也立一张标 main 的卡', () => {
    expect(tree.projects[0].tasks.map((t) => t.branch)).toEqual(['main', 'chore/a', 'fix/b', 'feat/c'])
    expect(tree.projects[0].tasks[0].main).toBe(true)
    expect(tree.projects[0].tasks[0].sessions.map((s) => s.name)).toEqual(['in-main'])
    expect(tree.projects[0].tasks[1].key).toBe('/w/Roam/.worktrees/a')
  })

  it('主仓库没会话就不立卡，也不算待收尾', () => {
    const t2 = buildTaskTree({ projects: [roam], worktrees: { roam: [{ path: '/w/Roam', branch: 'main', isMain: true, committedAhead: 5, sessions: [] }] }, sessions: [] })
    expect(t2.projects[0].tasks).toEqual([])
  })

  it('任务名取第一个会话的展示名，没有会话就用分支名', () => {
    const [, a, , c] = tree.projects[0].tasks
    expect(a.name).toBe('三栏重做')
    expect(c.name).toBe('feat/c')
  })

  it('会话都关了还有未合并提交 = 待收尾', () => {
    const [, a, b, c] = tree.projects[0].tasks
    expect(c.unfinished).toBe(true)
    expect(a.unfinished).toBe(false) // 有会话，ahead 再多也不算待收尾
    expect(b.unfinished).toBe(false)
  })

  it('agent / running / waiting 从 /projects 的 top 与 needs 里来', () => {
    const [, a, b] = tree.projects[0].tasks
    expect(a.sessions[0]).toMatchObject({ name: 'roam-cc', agent: 'claude', running: true })
    expect(a.sessions[1]).toMatchObject({ name: 'roam-sh', label: 'roam-sh' })
    expect(b.sessions[0]).toMatchObject({ agent: 'codex', waiting: true })
  })

  it('只有不在任何项目里的会话才是散会话；主仓库里的挂在项目下', () => {
    expect(tree.loose.map((s) => s.name)).toEqual(['htop'])
    expect(tree.projects[0].tasks[0].sessions[0].label).toBe('主仓库里开的')
  })

  it('项目行的计数 = 等待 + 待收尾', () => {
    expect(tree.projects[0].needs).toBe(2)
  })

  it('已打开会话探测到的 agent 优先于 top 名单', () => {
    const t2 = buildTaskTree({ projects: [roam], worktrees: wts, sessions, agentOf: (n) => (n === 'roam-sh' ? 'codex' : undefined) })
    expect(t2.projects[0].tasks[1].sessions[1].agent).toBe('codex')
  })

  it('散会话的 key 带前缀，不会和路径撞', () => {
    expect(LOOSE_PREFIX + 'htop').not.toMatch(/^\//)
  })
})

describe('buildTaskTree placement', () => {
  const proj = { key: 'x', name: 'X', dir: '/x', git: true }
  it('annotation 里已知 worktree 的新会话立刻挂到任务位，不等 worktree 轮询', () => {
    const tree = buildTaskTree({
      projects: [proj], worktrees: { x: [{ path: '/x', branch: 'main', isMain: true }] },
      sessions: [{ name: 'new-cc', label: '检查项目' }],
      placement: { 'new-cc': { key: 'x', worktree: '/x/.worktrees/a', branch: 'a' } },
    })
    expect(tree.loose).toEqual([])
    expect(tree.projects[0].tasks.map((t) => [t.path, t.name, t.sessions.map((s) => s.name)])).toEqual([['/x/.worktrees/a', '检查项目', ['new-cc']]])
  })
  it('worktree 轮询已经有这个 worktree 但会话名单还旧：补进去、任务名换成会话名', () => {
    const tree = buildTaskTree({
      projects: [proj], worktrees: { x: [{ path: '/x/.worktrees/a/', branch: 'a', isMain: false, committedAhead: 2 }] },
      sessions: [{ name: 'new-cc', label: '检查项目' }],
      placement: { 'new-cc': { key: 'x', worktree: '/x/.worktrees/a' } },
    })
    const task = tree.projects[0].tasks[0]
    expect(task.name).toBe('检查项目')
    expect(task.unfinished).toBe(false)
    expect(task.sessions.map((s) => s.name)).toEqual(['new-cc'])
  })
  it('annotation 指向主仓库的会话：挂到项目下一张标 main 的卡，不进散会话', () => {
    const tree = buildTaskTree({ projects: [proj], worktrees: {}, sessions: [{ name: 's' }], placement: { s: { key: 'x', worktree: '/x', branch: 'main' } } })
    expect(tree.loose).toEqual([])
    expect(tree.projects[0].tasks.map((t) => [t.path, t.main, t.sessions.map((s) => s.name)])).toEqual([['/x', true, ['s']]])
  })
})
