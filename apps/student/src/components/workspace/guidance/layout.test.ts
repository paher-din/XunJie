import { describe, expect, it } from 'vitest'
import { intersect, placeGuidance, validBounds } from './layout'

describe('guidance viewport constraints', () => {
  const area = { left: 20, top: 40, width: 300, height: 220 }
  it('clamps a card wider and taller than its available area', () => {
    expect(placeGuidance(area, { width: 400, height: 800 }, null)).toEqual({ left: 32, top: 52, maxWidth: 276, maxHeight: 196 })
  })
  it('flips below a top edge target and clamps horizontally', () => {
    expect(placeGuidance(area, { width: 150, height: 60 }, { left: 20, top: 45, width: 10, height: 10 })).toEqual({ left: 32, top: 67, maxWidth: 276, maxHeight: 196 })
  })
  it('flips above when below preference has insufficient space', () => {
    expect(placeGuidance(area, { width: 150, height: 60 }, { left: 200, top: 230, width: 10, height: 10 }, true).top).toBe(158)
  })
  it('rejects non-finite, empty and completely clipped bounds', () => {
    expect(validBounds({ ...area, left: NaN })).toBe(false)
    expect(validBounds({ ...area, width: 0 })).toBe(false)
    expect(validBounds(intersect(area, { left: 800, top: 0, width: 20, height: 20 }))).toBe(false)
  })
})
