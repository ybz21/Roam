// @vitest-environment jsdom
import { App as AntApp } from 'antd'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from './CommandPalette'
import { I18nProvider } from './i18n'

const ACTIONS = [
  { key: 'split-v', label: '竖分屏', hint: 'Ctrl-b %', group: '分屏' },
  { key: 'split-h', label: '横分屏', hint: 'Ctrl-b "', group: '分屏' },
  { key: 'close-pane', label: '关闭当前窗格', hint: 'Ctrl-b x', danger: true, group: '窗格 (Pane)' },
]

describe('CommandPalette', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('ttmux-locale', 'zh-CN')
    // jsdom 不实现 scrollIntoView（浏览器里有）；测试环境补一个空实现。
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  const renderPalette = (onSelect = vi.fn(), onClose = vi.fn()) => {
    const utils = render(
      <I18nProvider>
        <AntApp>
          <CommandPalette open actions={ACTIONS} onSelect={onSelect} onClose={onClose} />
        </AntApp>
      </I18nProvider>,
    )
    return { ...utils, onSelect, onClose }
  }

  it('lists every action when the query is empty', () => {
    renderPalette()
    expect(screen.getByText('竖分屏')).toBeTruthy()
    expect(screen.getByText('横分屏')).toBeTruthy()
    expect(screen.getByText('关闭当前窗格')).toBeTruthy()
  })

  it('filters as the user types', () => {
    renderPalette()
    const input = screen.getByPlaceholderText('搜索命令…')
    fireEvent.change(input, { target: { value: '横' } })
    expect(screen.getByText('横分屏')).toBeTruthy()
    expect(screen.queryByText('竖分屏')).toBeNull()
  })

  it('selects the highlighted item with ArrowDown + Enter and closes', () => {
    const { onSelect, onClose } = renderPalette()
    const input = screen.getByPlaceholderText('搜索命令…')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('split-h')
    expect(onClose).toHaveBeenCalled()
  })

  it('clicking an item selects it directly regardless of highlight', () => {
    const { onSelect, onClose } = renderPalette()
    fireEvent.click(screen.getByText('关闭当前窗格'))
    expect(onSelect).toHaveBeenCalledWith('close-pane')
    expect(onClose).toHaveBeenCalled()
  })

  it('Escape closes without selecting anything', () => {
    const { onSelect, onClose } = renderPalette()
    const input = screen.getByPlaceholderText('搜索命令…')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onSelect).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})
