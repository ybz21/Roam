// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolRun } from './ToolRun'
import { groupRuns, type Run } from './runs'
import { I18nProvider } from '../i18n'
import type { Block, Msg } from './types'

const use = (id: string, name: string, input: object): Block =>
  ({ kind: 'tool_use', id, name, input: JSON.stringify(input) })
const asst = (...blocks: Block[]): Msg => ({ role: 'assistant', blocks, id: 'm-' + blocks[0]?.id })
const ok = (id: string, out = ''): Record<string, Block> => ({ [id]: { kind: 'tool_result', toolUseId: id, text: out } })
const bad = (id: string, out: string): Record<string, Block> => ({ [id]: { kind: 'tool_result', toolUseId: id, text: out, isError: true } })

function buildRun(msgs: Msg[], results: Record<string, Block>): Run {
  const run = groupRuns(msgs, results).flatMap((i) => (i.kind === 'run' ? [i.run] : []))[0]
  if (!run) throw new Error('没成组')
  return run
}

const show = (run: Run, isLast = false) =>
  render(<I18nProvider><ToolRun run={run} isLast={isLast} /></I18nProvider>)

// 组头折起时仍然带着「最后一条命令」当摘要，所以判断展没展开要看组身(.cc-run-body)，
// 不能拿命令文本在不在页面上当判据。
const body = (c: HTMLElement) => c.querySelector('.cc-run-body')
const rows = (c: HTMLElement) => Array.from(c.querySelectorAll('.cc-run-body .cc-cmd-text')).map((e) => e.textContent)

const CMDS = [asst(use('a', 'Bash', { command: 'npm run typecheck' })), asst(use('b', 'Bash', { command: 'npx vitest run' }))]

describe('ToolRun 折叠', () => {
  beforeEach(() => {
    // 断点入口用 matchMedia；jsdom 没有实现，补一个恒 false 的（= compact 档）
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('跑完且全成功：默认折成一行，组身根本不渲染', () => {
    const { container } = show(buildRun(CMDS, { ...ok('a', 'x'), ...ok('b', 'y\nz') }))
    expect(body(container)).toBeNull()
    // 组头给出数量、量感与最后一条命令
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText('3 行')).toBeTruthy()
    expect(screen.getByText('npx vitest run')).toBeTruthy()
  })

  it('点组头就铺开，再点收回', () => {
    const { container } = show(buildRun(CMDS, { ...ok('a', 'x'), ...ok('b', 'y') }))
    const head = screen.getByRole('button', { name: /终端/ })
    fireEvent.click(head)
    expect(rows(container)).toEqual(['npm run typecheck', 'npx vitest run'])
    fireEvent.click(head)
    expect(body(container)).toBeNull()
  })

  it('还有调用没结果（live）：不折，两条都铺着', () => {
    const { container } = show(buildRun(CMDS, ok('a', 'x')))
    expect(rows(container)).toEqual(['npm run typecheck', 'npx vitest run'])
  })

  it('有失败：组照收，只有失败那条留在外面', () => {
    const { container } = show(buildRun(CMDS, { ...ok('a', 'x'), ...bad('b', 'AssertionError: 炸了') }))
    expect(rows(container)).toEqual(['npx vitest run'])   // 成功的收进去了，失败的留着
    expect(screen.getByText('1 成功 · 1 失败')).toBeTruthy()
  })

  it('被拒绝算「已拒绝」，不染成红色故障', () => {
    const { container } = show(buildRun(CMDS, { ...ok('a'), ...bad('b', "The user doesn't want to proceed") }))
    expect(screen.getByText('1 成功 · 1 已拒绝')).toBeTruthy()
    const style = container.querySelector('.cc-run')?.getAttribute('style') || ''
    expect(style).toContain('--warn')
    expect(style).not.toContain('--danger')
  })

  it('用户收起过的组，来了新结果也不会被自动展开回去', () => {
    const run = buildRun(CMDS, ok('a', 'x')) // live → 自动展开
    const { container, rerender } = show(run, true)
    expect(body(container)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /终端/ })) // 用户手动收起
    expect(body(container)).toBeNull()
    // 轮询回来：第二条也有结果了
    const settled = buildRun(CMDS, { ...ok('a', 'x'), ...ok('b', 'y') })
    rerender(<I18nProvider><ToolRun run={settled} isLast /></I18nProvider>)
    expect(body(container)).toBeNull()
  })

  it('同一个文件连着改几处：并成一张卡，标题带 ×N', () => {
    const msgs = [
      asst(use('a', 'Edit', { file_path: '/p/FileBrowser.tsx', old_string: 'a', new_string: 'b' })),
      asst(use('b', 'Edit', { file_path: '/p/FileBrowser.tsx', old_string: 'c', new_string: 'd' })),
    ]
    const run = buildRun(msgs, { ...ok('a'), ...ok('b') })
    show(run)
    fireEvent.click(screen.getByRole('button', { name: /改文件/ }))
    expect(screen.getByText('/p/FileBrowser.tsx ×2')).toBeTruthy()
  })
})
