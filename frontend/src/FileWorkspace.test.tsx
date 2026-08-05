// @vitest-environment jsdom
import { App as AntApp } from 'antd'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FileWorkspace from './FileWorkspace'
import { I18nProvider } from './i18n'
import { requestIntent, OPEN_FILE_INTENT } from './intents'

vi.mock('./FileBrowser', () => ({ default: () => <div data-testid="file-browser" /> }))
vi.mock('./fileview', () => ({ FileView: () => <div data-testid="file-view" /> }))

class PointerEventStub extends MouseEvent {
  readonly pointerId: number

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 0
  }
}

describe('FileWorkspace resize shield', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('ttmux-locale', 'zh-CN')
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }))
    vi.stubGlobal('CSS', { escape: (value: string) => value })
    vi.stubGlobal('PointerEvent', PointerEventStub)
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    })
    Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', {
      configurable: true,
      value: vi.fn(() => false),
    })
  })

  afterEach(() => {
    cleanup()
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const renderWorkspace = () => render(
    <I18nProvider>
      <AntApp>
        <FileWorkspace dir="/workspace" />
      </AntApp>
    </I18nProvider>,
  )

  it('keeps dock resize events above iframe previews until pointerup', () => {
    const { container } = renderWorkspace()
    const handle = container.querySelector<HTMLElement>('[data-resize-handle="dock"]')!
    const dock = handle.previousElementSibling as HTMLElement

    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 280 })

    const shield = document.body.querySelector<HTMLElement>('[data-pointer-resize-shield="true"]')!
    expect(shield).not.toBeNull()
    expect(document.body.style.userSelect).toBe('none')
    expect(document.body.style.cursor).toBe('col-resize')

    fireEvent.pointerMove(shield, { pointerId: 7, clientX: 360 })
    expect(dock.style.flex).toBe('0 0 360px')

    fireEvent.pointerUp(shield, { pointerId: 7, clientX: 360 })
    expect(document.body.querySelector('[data-pointer-resize-shield="true"]')).toBeNull()
    expect(document.body.style.userSelect).toBe('')
    expect(document.body.style.cursor).toBe('')
    expect(localStorage.getItem('ttmux.fileDockW')).toBe('360')
  })

  it('removes the shield and restores page styles when the window loses focus', () => {
    const { container } = renderWorkspace()
    const handle = container.querySelector<HTMLElement>('[data-resize-handle="dock"]')!
    document.body.style.userSelect = 'text'
    document.body.style.cursor = 'default'

    fireEvent.pointerDown(handle, { pointerId: 9, clientX: 280 })
    fireEvent.blur(window)

    expect(document.body.querySelector('[data-pointer-resize-shield="true"]')).toBeNull()
    expect(document.body.style.userSelect).toBe('text')
    expect(document.body.style.cursor).toBe('default')
  })
})

// 从对话里点 Read/Edit 的路径开文件：必须开到**右栏**。
// A 栏的首 tab 是会话（终端/对话）本身，开在那儿等于把你正在看的对话顶掉——
// 而点这个路径的动机恰恰是「一边对着看」。
describe('FileWorkspace 从对话打开文件', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('ttmux-locale', 'zh-CN')
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }))
    vi.stubGlobal('CSS', { escape: (value: string) => value })
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  const renderWithSession = () => render(
    <I18nProvider>
      <AntApp>
        <FileWorkspace dir="/workspace" leadingTab={<span data-testid="lead-tab" />} leadingTitle="sess"
          leadingContent={<div data-testid="chat" />} />
      </AntApp>
    </I18nProvider>,
  )

  const tabTexts = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-tab-key]')].map((e) => (e.textContent || '').trim())

  it('side 意图把文件开成第二栏，会话首 tab 仍在', () => {
    const { container } = renderWithSession()
    expect(container.querySelectorAll('[data-drop-group]').length).toBeGreaterThan(0)

    act(() => { requestIntent(OPEN_FILE_INTENT, { path: '/workspace/a.ts', side: true }) })

    const keys = [...container.querySelectorAll('[data-tab-key]')].map((e) => e.getAttribute('data-tab-key'))
    expect(keys).toContain('lead')                      // 会话首 tab 还在
    expect(keys).toContain('/workspace/a.ts')           // 文件开出来了
    // 两个编辑组 → 分栏成立（B 栏非空才会渲染第二个 pane）
    expect(container.querySelectorAll('[data-drop-content="1"]').length).toBe(2)
    expect(tabTexts(container).length).toBeGreaterThan(1)
  })

  it('不带 side 时沿用旧行为：开在 A 栏（⌘K 搜索那条路）', () => {
    const { container } = renderWithSession()
    act(() => { requestIntent(OPEN_FILE_INTENT, { path: '/workspace/b.ts' }) })
    expect(container.querySelectorAll('[data-drop-content="1"]').length).toBe(1)
  })

  it('没有会话首 tab 时（纯文件页）side 不生效，不该无故拆出空的一栏', () => {
    const { container } = render(
      <I18nProvider><AntApp><FileWorkspace dir="/workspace" /></AntApp></I18nProvider>,
    )
    act(() => { requestIntent(OPEN_FILE_INTENT, { path: '/workspace/c.ts', side: true }) })
    expect(container.querySelectorAll('[data-drop-content="1"]').length).toBe(1)
  })
})
