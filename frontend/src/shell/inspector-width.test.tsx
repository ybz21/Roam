// @vitest-environment jsdom
// 文件抽屉是两层折叠：文件夹层 + 预览层，面板宽 = 两层之和。宽度由面板自己报，
// Shell 照办——但只在报的值变化时办一次，否则用户拖外把手会被立刻弹回去（把手等于拖不动）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const VIEWPORT = 1920

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function freshModules() {
  vi.resetModules()
  return { ...(await import('./inspector')), ...(await import('./useWorkspaceLayout')) }
}

describe('文件预览要列宽', () => {
  beforeEach(() => {
    localStorage.clear()
    window.innerWidth = VIEWPORT
    vi.stubGlobal('matchMedia', vi.fn((q: string) => ({
      matches: q.includes('min-width'),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(),
    })))
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: {} })))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('叠一层预览就加一层的宽，收起来又减回去', async () => {
    const m = await freshModules()
    const { result } = renderHook(() => m.useWorkspaceLayout(true))
    expect(result.current.inspectorWidth).toBe(m.INSPECTOR_DEFAULT)

    // 只有文件夹层
    m.requestInspectorWidth(360)
    await waitFor(() => expect(result.current.inspectorWidth).toBe(360))

    // 点开文件 → 左边叠一层预览：300 + 5 + 500
    m.requestInspectorWidth(805)
    await waitFor(() => expect(result.current.inspectorWidth).toBe(805))

    // 收起预览 → 退回文件夹层那一层的宽
    m.requestInspectorWidth(360)
    await waitFor(() => expect(result.current.inspectorWidth).toBe(360))
  })

  it('报过的值不再反复施加，外把手才拖得动', async () => {
    const m = await freshModules()
    const { result } = renderHook(() => m.useWorkspaceLayout(true))
    m.requestInspectorWidth(805)
    await waitFor(() => expect(result.current.inspectorWidth).toBe(805))

    // 用户拖外把手：报的值没变，不许把他弹回 805
    result.current.setInspectorWidth(700)
    await waitFor(() => expect(result.current.inspectorWidth).toBe(700))
    await new Promise((r) => setTimeout(r, 60))
    expect(result.current.inspectorWidth).toBe(700)
  })
})
