// @vitest-environment jsdom
import { App as AntApp } from 'antd'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FileBrowser from './FileBrowser'
import FloatingFileDrawer from './FloatingFileDrawer'
import { I18nProvider } from './i18n'

vi.mock('./App', () => ({ recentDirs: () => [] }))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('FileBrowser folder context menu', () => {
  let nativeGetComputedStyle: typeof window.getComputedStyle

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('ttmux-locale', 'zh-CN')
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/files?')) {
        return jsonResponse({
          data: {
            path: '/workspace',
            parent: '/',
            entries: [{ name: 'folder', dir: true, size: 0, mtime: 1, ctime: 1 }],
          },
        })
      }
      return jsonResponse({ data: {} })
    }))
    nativeGetComputedStyle = window.getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => nativeGetComputedStyle(element))
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const renderBrowser = () => render(
    <I18nProvider>
      <AntApp>
        <FloatingFileDrawer open>
          <FileBrowser dir="/workspace" layout="dock" />
        </FloatingFileDrawer>
      </AntApp>
    </I18nProvider>,
  )

  const openFolderMenu = async () => {
    const folder = await screen.findByText('folder')
    const row = folder.closest('.cc-filerow')
    expect(row).not.toBeNull()
    fireEvent.contextMenu(row!)
    return screen.findByText('重命名')
  }

  it('stays open while moving over items and runs the selected folder action', async () => {
    renderBrowser()
    const rename = await openFolderMenu()
    const menu = rename.closest('.ant-dropdown')
    expect(menu).not.toBeNull()
    expect(menu?.className.includes('slide-')).toBe(false)
    expect(menu?.classList.contains('tt-file-context-menu')).toBe(true)

    for (const label of ['新建目录', '移动到…', '属性', '重命名']) {
      const item = screen.getByText(label)
      fireEvent.mouseEnter(item)
      fireEvent.mouseMove(item)
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(menu?.classList.contains('ant-dropdown-hidden')).toBe(false)
      expect(screen.getByText('重命名')).toBeTruthy()
    }

    fireEvent.click(rename)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    expect(screen.getByDisplayValue('folder')).toBeTruthy()
  })

  it.each([
    ['新建目录', '新建目录'],
    ['移动到…', '移动到'],
    ['复制到…', '复制到'],
    ['属性', '属性'],
    ['删除', '删除此文件夹及其中所有内容？'],
  ])('runs the “%s” folder action', async (menuLabel, dialogText) => {
    renderBrowser()
    await openFolderMenu()
    fireEvent.click(screen.getByText(menuLabel))

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain(dialogText)
  })

  it('runs the open-folder action and navigates to the target directory', async () => {
    renderBrowser()
    await openFolderMenu()
    fireEvent.click(screen.getByText('打开目录'))

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        '/api/files?path=%2Fworkspace%2Ffolder',
        expect.objectContaining({ method: 'GET' }),
      )
    })
  })
})
