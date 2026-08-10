import { describe, it, expect } from 'vitest'
import { groupRuns, runSummary, familyOf, type Run } from './runs'
import type { Block, Msg } from './types'

const use = (id: string, name: string, input: object | string): Block =>
  ({ kind: 'tool_use', id, name, input: typeof input === 'string' ? input : JSON.stringify(input) })
const asst = (...blocks: Block[]): Msg => ({ role: 'assistant', blocks, id: 'm-' + blocks[0]?.id })
const text = (s: string): Msg => ({ role: 'assistant', blocks: [{ kind: 'text', text: s }] })
const user = (s: string): Msg => ({ role: 'user', blocks: [{ kind: 'text', text: s }] })
const ok = (id: string, out = ''): Record<string, Block> => ({ [id]: { kind: 'tool_result', toolUseId: id, text: out } })
const bad = (id: string, out: string): Record<string, Block> => ({ [id]: { kind: 'tool_result', toolUseId: id, text: out, isError: true } })

const bash = (id: string, cmd: string) => use(id, 'Bash', { command: cmd })
const runs = (items: ReturnType<typeof groupRuns>): Run[] => items.flatMap((i) => (i.kind === 'run' ? [i.run] : []))

describe('familyOf', () => {
  it('按族归类，未知工具归 other', () => {
    expect(familyOf('Bash')).toBe('term')
    expect(familyOf('shell')).toBe('term')
    expect(familyOf('Edit')).toBe('edit')
    expect(familyOf('Grep')).toBe('read')
    expect(familyOf('TodoWrite')).toBe('task')
    expect(familyOf('mcp__foo__bar')).toBe('other')
  })

  it('决策类不参与分组：选择框 / 计划 / 子代理', () => {
    expect(familyOf('AskUserQuestion')).toBeNull()
    expect(familyOf('ExitPlanMode')).toBeNull()
    expect(familyOf('Task')).toBeNull()
  })
})

describe('groupRuns', () => {
  it('相邻的纯工具消息并成一组（这正是截图里那五条命令的形状）', () => {
    const msgs = [user('干活'), asst(bash('a', 'ls')), asst(bash('b', 'pwd')), asst(bash('c', 'date'))]
    const items = groupRuns(msgs, { ...ok('a'), ...ok('b'), ...ok('c') })
    expect(items.map((i) => i.kind)).toEqual(['msg', 'run'])
    expect(runs(items)[0].entries).toHaveLength(3)
    expect(runs(items)[0].key).toBe('a')
  })

  it('中间夹着正文就断组', () => {
    const msgs = [asst(bash('a', 'ls')), asst(bash('b', 'pwd')), text('说两句'), asst(bash('c', 'date')), asst(bash('d', 'id'))]
    const items = groupRuns(msgs, { ...ok('a'), ...ok('b'), ...ok('c'), ...ok('d') })
    expect(items.map((i) => i.kind)).toEqual(['run', 'msg', 'run'])
  })

  it('家族不同不并', () => {
    const msgs = [asst(bash('a', 'ls')), asst(bash('b', 'pwd')), asst(use('c', 'Read', { file_path: '/x' })), asst(use('d', 'Read', { file_path: '/y' }))]
    const g = runs(groupRuns(msgs, { ...ok('a'), ...ok('b'), ...ok('c'), ...ok('d') }))
    expect(g.map((r) => r.family)).toEqual(['term', 'read'])
  })

  it('少于 2 个调用不成组，原样平铺', () => {
    const items = groupRuns([asst(bash('a', 'ls')), text('说两句')], ok('a'))
    expect(items.every((i) => i.kind === 'msg')).toBe(true)
  })

  it('一条消息里就有多个同族调用时也成组（Codex 常这么批量发）', () => {
    const items = groupRuns([asst(bash('a', 'ls'), bash('b', 'pwd'))], { ...ok('a'), ...ok('b') })
    expect(runs(items)[0].entries).toHaveLength(2)
  })

  it('没结果的算 live；出错与被拒分开计数', () => {
    const msgs = [asst(bash('a', 'ls')), asst(bash('b', 'pwd')), asst(bash('c', 'date')), asst(bash('d', 'id'))]
    const r = runs(groupRuns(msgs, { ...bad('a', 'boom'), ...bad('b', 'The user doesn\'t want to proceed'), ...ok('c') }))[0]
    expect(r.live).toBe(true)
    expect(r.errors).toBe(1)
    expect(r.denied).toBe(1)
  })
})

describe('runSummary', () => {
  it('终端：数输出总行数，并带出最后一条命令', () => {
    const msgs = [asst(bash('a', 'npm run typecheck')), asst(bash('b', 'git push'))]
    const r = runs(groupRuns(msgs, { ...ok('a', 'x\ny\nz'), ...ok('b', 'done') }))[0]
    const sum = runSummary(r)
    expect(sum).toMatchObject({ count: 2, lines: 4, last: 'git push' })
  })

  it('改文件：同一个文件多次编辑合并成一份增删统计', () => {
    const msgs = [
      asst(use('a', 'Edit', { file_path: '/p/x.ts', old_string: 'a', new_string: 'b' })),
      asst(use('b', 'Edit', { file_path: '/p/x.ts', old_string: 'c', new_string: 'd\ne' })),
    ]
    const sum = runSummary(runs(groupRuns(msgs, { ...ok('a'), ...ok('b') }))[0])
    expect(sum.files).toBe(1)
    expect(sum.plus).toBe(3)
    expect(sum.minus).toBe(2)
  })

  it('Write 是新建：只有加没有减', () => {
    const msgs = [
      asst(use('a', 'Write', { file_path: '/p/a.ts', content: '1\n2' })),
      asst(use('b', 'Write', { file_path: '/p/b.ts', content: '3' })),
    ]
    const sum = runSummary(runs(groupRuns(msgs, { ...ok('a'), ...ok('b') }))[0])
    expect(sum).toMatchObject({ files: 2, plus: 3, minus: 0 })
  })

  it('任务面板：折叠时给最近一次的进度', () => {
    const msgs = [
      asst(use('a', 'TodoWrite', { todos: [{ content: 'x', status: 'completed' }, { content: 'y', status: 'pending' }] })),
      asst(use('b', 'TodoWrite', { todos: [{ content: 'x', status: 'completed' }, { content: 'y', status: 'completed' }] })),
    ]
    const sum = runSummary(runs(groupRuns(msgs, { ...ok('a'), ...ok('b') }))[0])
    expect(sum).toMatchObject({ done: 2, total: 2 })
  })

  it('命令 JSON 被截断也能读出前半截（后端 clip 到 6000 字）', () => {
    const msgs = [asst(bash('a', 'ls')), asst(use('b', 'Bash', '{"command":"cat > /tmp/x <<EOF\\nhello'))]
    const sum = runSummary(runs(groupRuns(msgs, { ...ok('a'), ...ok('b') }))[0])
    expect(sum.last).toContain('cat > /tmp/x')
  })
})
