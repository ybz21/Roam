// @vitest-environment jsdom
import { App as AntApp } from 'antd'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FileWorkspace from './FileWorkspace'
import { I18nProvider } from './i18n'

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
