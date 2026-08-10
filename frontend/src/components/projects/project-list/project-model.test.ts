// 「需要你」的计数与队列**不能**从 top 里数：后端把 top 截到三行给卡片画，
// 第 4 个以后的等待输入会凭空消失（#186 合并后留下的账）。
import { describe, expect, it } from 'vitest'
import { projNeeds, runningCount, waitingCount, waitingSessions, type Proj } from './project-model'

const sess = (name: string, o: Partial<{ waiting: boolean; running: boolean }> = {}) =>
  ({ name, attached: false, lastActivity: 1, ...o })

const proj = (o: Partial<Proj>): Proj => ({
  key: 'k', name: 'p', dir: '/d', git: true, pinned: false,
  sessions: 0, attached: 0, worktrees: 0, unfinished: 0, cleanable: 0, races: 0,
  lastActivity: 0, firstSeen: 0, top: null, ...o,
})

describe('项目的等待/运行计数', () => {
  it('用后端的全量字段，而不是被截断的 top', () => {
    // 卡片那三行里只看得见一个等待，实际有三个
    const p = proj({
      top: [sess('a', { waiting: true, running: true }), sess('b', { running: true }), sess('c', { running: true })],
      waiting: 3, running: 5,
      needs: [sess('a', { waiting: true }), sess('d', { waiting: true }), sess('e', { waiting: true })] as any,
    })
    expect(waitingCount(p)).toBe(3)
    expect(runningCount(p)).toBe(5)
    expect(waitingSessions(p).map((s) => s.name)).toEqual(['a', 'd', 'e'])
    expect(projNeeds(p, [])).toBe(3)
  })

  it('老后端没有这些字段时回落到 top，不至于变成 0', () => {
    const p = proj({ top: [sess('a', { waiting: true }), sess('b', { running: true })] })
    expect(waitingCount(p)).toBe(1)
    expect(runningCount(p)).toBe(1)
    expect(waitingSessions(p).map((s) => s.name)).toEqual(['a'])
  })

  it('needs 为空数组时是「真的没有」，不要回落到 top', () => {
    // 后端明确说了没有等待，就别再去 top 里翻出一个来
    const p = proj({ top: [sess('a', { waiting: true })], waiting: 0, needs: [] })
    expect(waitingCount(p)).toBe(0)
    expect(waitingSessions(p)).toEqual([])
  })

  it('待收尾与蜂群待解锁一并算进「需要你」', () => {
    const p = proj({ key: 'k', waiting: 1, unfinished: 2 })
    const swarms = [{ name: 's', projKey: 'k', projName: 'p', total: 3, inProj: 3, pending: 1 }]
    expect(projNeeds(p, swarms)).toBe(4)
  })
})
