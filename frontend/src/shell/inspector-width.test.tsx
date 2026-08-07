// @vitest-environment jsdom
// 点开文件要能读：420 的默认 Inspector 列宽分成两栏后只剩两百出头的预览，
// 分栏等于白做。面板自己知道要多宽，列宽却在 Shell 手里——这条小道把两边接上。
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

  it('要得比现在宽就加宽，收起预览不缩回去', async () => {
    const m = await freshModules()
    const { result } = renderHook(() => m.useWorkspaceLayout(true))
    expect(result.current.inspectorWidth).toBe(m.INSPECTOR_DEFAULT)

    m.requestInspectorWidth(825)
    await waitFor(() => expect(result.current.inspectorWidth).toBe(825))

    // 关掉预览：请求撤回，但列不缩——面板多宽是用户的选择，不该被开合文件反复改
    m.requestInspectorWidth(0)
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current.inspectorWidth).toBe(825)
  })

  it('用户拖得更宽时不动他的宽度', async () => {
    const m = await freshModules()
    const { result } = renderHook(() => m.useWorkspaceLayout(true))
    // 拖到上界（几何还要给 Dock 留位，落地值由 inspectorBounds 说了算）
    result.current.setInspectorWidth(m.INSPECTOR_MAX)
    await waitFor(() => expect(result.current.inspectorWidth).toBeGreaterThan(825))
    const dragged = result.current.inspectorWidth

    m.requestInspectorWidth(825)
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current.inspectorWidth).toBe(dragged)
  })
})
