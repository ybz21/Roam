import { describe, it, expect } from 'vitest'
import { parseTail } from './LiveTail'

// 真机上扒到的那一帧（截图 2026-08-05 15:30）：TUI 的树枝、字符图标、回显、会话名全在里面
const RAW = [
  '╭──────────────────────────────────────╮',
  '│ 合入合入                             │',
  '',
  '  Running 1 shell command…',
  '  └  $ gh pr merge 170 --squash --delete-branch 2>&1 | tail -5',
  '  └  ✔ 修 shell 命令行渲染：截断 JSON',
  '  ✔ 后端透出会话状态 status',
  '  □ 补测试 + 全套校验 + 真机验收',
  'refine-chat-tool-rendering',
  '  ✻ ',
  '  esc to interrupt · ctrl+_ to undo',
  '╰──────────────────────────────────────╯',
].join('\n')

describe('parseTail', () => {
  const lines = parseTail(RAW, { session: 'refine-chat-tool-rendering', lastUser: '合入合入' })

  it('剥掉框线与树枝，`└` 和 `⎿` 也算框线', () => {
    expect(lines.every((l) => !/[└⎿│╭╰]/.test(l.text))).toBe(true)
  })

  it('用户刚发的那句和会话名不重复回显', () => {
    expect(lines.some((l) => l.text === '合入合入')).toBe(false)
    expect(lines.some((l) => l.text === 'refine-chat-tool-rendering')).toBe(false)
  })

  it('命令行认出来并去掉 $', () => {
    const cmd = lines.find((l) => l.kind === 'cmd')
    expect(cmd?.text).toBe('gh pr merge 170 --squash --delete-branch 2>&1 | tail -5')
  })

  it('待办认成结构，字符图标不进文本（显示时换成 SVG）', () => {
    const todos = lines.filter((l) => l.kind === 'todo') as { text: string; done: boolean }[]
    expect(todos).toHaveLength(3)
    expect(todos[0]).toMatchObject({ done: true, text: '修 shell 命令行渲染：截断 JSON' })
    expect(todos[2]).toMatchObject({ done: false, text: '补测试 + 全套校验 + 真机验收' })
    expect(todos.every((x) => !/[✔✓□☐]/.test(x.text))).toBe(true)
  })

  it('状态行单列一类，提示行与 spinner 丢掉', () => {
    expect(lines.filter((l) => l.kind === 'action').map((l) => l.text)).toEqual(['Running 1 shell command…'])
    expect(lines.some((l) => /esc to interrupt/.test(l.text))).toBe(false)
    expect(lines.some((l) => l.text === '✻')).toBe(false)
  })

  it('只留最后 10 行', () => {
    expect(parseTail(Array.from({ length: 40 }, (_, i) => `行 ${i}`).join('\n'))).toHaveLength(10)
  })

  it('空输入不炸', () => {
    expect(parseTail('')).toEqual([])
  })
})
