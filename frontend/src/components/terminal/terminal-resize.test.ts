import { describe, expect, it } from 'vitest'
import { shouldJiggleAfterAttach } from './terminal-resize'

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
