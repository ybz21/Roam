import { describe, it, expect } from 'vitest'
import { buildTaskIndex, taskList } from './tasks'
import type { Block, Msg } from './types'

const use = (id: string, name: string, input: object): Block =>
  ({ kind: 'tool_use', id, name, input: JSON.stringify(input) })
const msg = (...blocks: Block[]): Msg => ({ role: 'assistant', blocks })
const res = (toolUseId: string, text: string): Record<string, Block> =>
  ({ [toolUseId]: { kind: 'tool_result', toolUseId, text } })

describe('buildTaskIndex', () => {
  it('把 TaskCreate 的标题和结果文本里的 #id 接起来', () => {
    const msgs = [msg(use('a', 'TaskCreate', { subject: '接通渲染', activeForm: '接通中' }))]
    const idx = buildTaskIndex(msgs, res('a', 'Task #1 created successfully: 接通渲染'))
    expect(idx['1']).toMatchObject({ id: '1', subject: '接通渲染', activeForm: '接通中', status: 'pending' })
  })

  it('TaskUpdate 只给 {taskId,status} 也能查到标题', () => {
    const msgs = [
      msg(use('a', 'TaskCreate', { subject: '补单测' })),
      msg(use('b', 'TaskUpdate', { taskId: '4', status: 'completed' })),
    ]
    const idx = buildTaskIndex(msgs, { ...res('a', 'Task #4 created successfully: 补单测'), ...res('b', 'Updated task #4 status') })
    expect(idx['4'].subject).toBe('补单测')
    expect(idx['4'].status).toBe('completed')
  })

  it('后面的更新覆盖前面的：结果是最新状态', () => {
    const msgs = [
      msg(use('a', 'TaskCreate', { subject: '跑校验' })),
      msg(use('b', 'TaskUpdate', { taskId: '2', status: 'in_progress' })),
      msg(use('c', 'TaskUpdate', { taskId: '2', status: 'completed' })),
    ]
    const idx = buildTaskIndex(msgs, {
      ...res('a', 'Task #2 created successfully: 跑校验'),
      ...res('b', 'Updated task #2 status'),
      ...res('c', 'Updated task #2 status'),
    })
    expect(idx['2'].status).toBe('completed')
    expect(idx['2'].subject).toBe('跑校验')
  })

  it('结果还没回来（正在跑）时不进索引，等下一轮轮询补上', () => {
    const msgs = [msg(use('a', 'TaskCreate', { subject: '还没建完' }))]
    expect(buildTaskIndex(msgs, {})).toEqual({})
  })

  it('没见过的 id 也认，状态照记（转录被截断时会遇到）', () => {
    const msgs = [msg(use('b', 'TaskUpdate', { taskId: '9', status: 'in_progress' }))]
    const idx = buildTaskIndex(msgs, res('b', 'Updated task #9 status'))
    expect(idx['9']).toMatchObject({ id: '9', subject: '', status: 'in_progress' })
  })

  it('非法状态回落到 pending，不把脏值画进面板', () => {
    const msgs = [msg(use('b', 'TaskUpdate', { taskId: '3', status: 'weird' }))]
    expect(buildTaskIndex(msgs, res('b', 'Updated task #3 status'))['3'].status).toBe('pending')
  })
})

describe('taskList', () => {
  it('按 id 数值升序（＝创建顺序），并滤掉已删除的', () => {
    const idx = {
      '10': { id: '10', subject: 'j', status: 'pending' as const },
      '2': { id: '2', subject: 'b', status: 'completed' as const },
      '5': { id: '5', subject: 'e', status: 'deleted' as const },
    }
    expect(taskList(idx).map((t) => t.id)).toEqual(['2', '10'])
  })
})
