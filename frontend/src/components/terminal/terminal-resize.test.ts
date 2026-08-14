import { describe, expect, it } from 'vitest'
import { RESUME_RESYNC_MS, resumeHealFor, shouldJiggleAfterAttach } from './terminal-resize'

describe('shouldJiggleAfterAttach', () => {
  it('does not jiggle the first correctly-sized attach after a page refresh', () => {
    expect(shouldJiggleAfterAttach(null, { cols: 181, rows: 86 }, false)).toBe(false)
  })

  it('does not jiggle a same-size reconnect', () => {
    expect(shouldJiggleAfterAttach({ cols: 181, rows: 86 }, { cols: 181, rows: 86 }, false)).toBe(false)
  })

  it('jiggles a reconnect whose terminal geometry really changed', () => {
    expect(shouldJiggleAfterAttach({ cols: 181, rows: 86 }, { cols: 120, rows: 60 }, false)).toBe(true)
  })

  it('honors an explicit resync after a long background suspension', () => {
    expect(shouldJiggleAfterAttach(null, { cols: 181, rows: 86 }, true)).toBe(true)
  })
})

describe('resumeHealFor', () => {
  it('leaves a quick tab switch alone', () => {
    expect(resumeHealFor(0)).toBe('none')
    expect(resumeHealFor(1500)).toBe('none')
  })

  it('rebuilds only the renderer after a short absence', () => {
    expect(resumeHealFor(1501)).toBe('renderer')
    expect(resumeHealFor(RESUME_RESYNC_MS)).toBe('renderer')
  })

  // 手机长期不用回来「进入 session」看到的花屏是内容层：这一层只重建渲染器救不回来。
  it('also repaints the content after a long absence', () => {
    expect(resumeHealFor(RESUME_RESYNC_MS + 1)).toBe('renderer+content')
    expect(resumeHealFor(6 * 60 * 60 * 1000)).toBe('renderer+content')
  })
})
