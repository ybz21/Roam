// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StreamControl } from './mirror'
import { I18nProvider } from './i18n'

// 断点入口是 matchMedia（layout.ts）；这里按查询命中与否伪造两端。
// layout 的快照是模块级的、只在 resize/媒体事件时重算，所以桩装好之后要派一次 resize
// 才会生效——否则拿到的还是模块加载那一刻算出来的档位。
function stubLayout(desktop: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: desktop && q.includes('min-width'), media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  }))
}
const syncLayout = () => act(() => { window.dispatchEvent(new Event('resize')) })

const show = (extra: Partial<Parameters<typeof StreamControl>[0]> = {}) => {
  const r = render(
    <I18nProvider>
      <StreamControl connected label="已连接" quality={92} onQuality={() => {}}
        latency={32} bytesPerSec={1024 * 1024} fps={24} {...extra} />
    </I18nProvider>,
  )
  syncLayout()
  return r
}

describe('StreamControl：连接与画质是一个部件', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('桌面：状态、档位、指标在同一个壳里，不是两处', () => {
    stubLayout(true)
    const { container } = show()
    const shell = container.querySelector('.tt-stream')!
    expect(shell).toBeTruthy()
    // 三段都在这一个壳内部——这正是「不可拆分」的含义
    expect(shell.querySelector('.tt-stream-sec.is-stat')?.textContent).toContain('已连接')
    expect(shell.querySelector('.tt-stream-seg')).toBeTruthy()
    expect(shell.querySelector('.tt-stream-sec.is-num')?.textContent).toContain('32ms')
    // 四档都在
    expect(screen.getAllByRole('radio')).toHaveLength(4)
  })

  it('手机：收成一枚 chip，档位藏在浮层里', () => {
    stubLayout(false)
    const { container } = show()
    expect(container.querySelector('.tt-stream.is-chip')).toBeTruthy()
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    fireEvent.click(container.querySelector('.tt-stream.is-chip')!)
    expect(screen.getAllByRole('radio')).toHaveLength(4)
  })

  it('手机 chip 上显示当前档位；auto 时显示后端实际选中的那档', () => {
    stubLayout(false)
    const { container, rerender } = show()
    expect(container.querySelector('.tt-stream .lvl')?.textContent).toBe('超清')
    rerender(
      <I18nProvider>
        <StreamControl connected label="已连接" quality="auto" onQuality={() => {}} level="高清"
          latency={32} bytesPerSec={1024} fps={24} />
      </I18nProvider>,
    )
    expect(container.querySelector('.tt-stream .lvl')?.textContent).toBe('高清')
  })

  it('没连上时状态点不给绿色（.on 只在连上时出现）', () => {
    stubLayout(true)
    const { container } = show({ connected: false, label: '未连接' })
    expect(container.querySelector('.tt-stream')?.className).not.toContain('on')
  })

  it('换档位回调把 auto 与数字档分开给', () => {
    stubLayout(true)
    const onQuality = vi.fn()
    show({ onQuality })
    fireEvent.click(screen.getAllByRole('radio')[0]) // 自动
    expect(onQuality).toHaveBeenCalledWith('auto')
    fireEvent.click(screen.getAllByRole('radio')[1]) // 标清
    expect(onQuality).toHaveBeenCalledWith(50)
  })
})
