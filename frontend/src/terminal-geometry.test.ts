import { describe, expect, it } from 'vitest'
import { paneCellsToPixelRect } from './terminal-geometry'

describe('paneCellsToPixelRect', () => {
  it('converts a pane at the terminal origin using the cell size', () => {
    const rect = paneCellsToPixelRect(
      { left: 100, top: 40, cellWidth: 8, cellHeight: 16 },
      { left: 0, top: 0, width: 80, height: 24 },
    )
    expect(rect).toEqual({ x: 100, y: 40, width: 640, height: 384 })
  })

  it('offsets by both the terminal origin and the pane cell offset (right-hand split)', () => {
    const rect = paneCellsToPixelRect(
      { left: 100, top: 40, cellWidth: 8, cellHeight: 16 },
      { left: 80, top: 0, width: 40, height: 24 },
    )
    expect(rect).toEqual({ x: 100 + 80 * 8, y: 40, width: 40 * 8, height: 24 * 16 })
  })

  it('offsets vertically for a bottom split', () => {
    const rect = paneCellsToPixelRect(
      { left: 0, top: 0, cellWidth: 10, cellHeight: 20 },
      { left: 0, top: 12, width: 80, height: 12 },
    )
    expect(rect).toEqual({ x: 0, y: 240, width: 800, height: 240 })
  })
})
