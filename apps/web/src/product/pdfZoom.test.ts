import { expect, it } from 'vitest'
import type { PdfPage } from '@xunjie/contracts/pdf-materials'
import { pdfCanSpread, pdfPageSize, pdfSpreadGap, pdfZoomPercent, pdfZoomLimits } from './pdfZoom'

const portrait = { width: 794, height: 1123 }
const desktop = { width: 1280, height: 800 }

it('opens a wide desktop view between fit page and fit width', () => {
  const reading = pdfZoomPercent('reading', desktop, [portrait])
  expect(reading).toBe(125)
  expect(reading).toBeGreaterThan(pdfZoomPercent('fit-page', desktop, [portrait]))
  expect(reading).toBeLessThan(pdfZoomPercent('fit-width', desktop, [portrait]))
  expect(portrait.width * reading / 100).toBeLessThanOrEqual(desktop.width)
})

it('keeps whole-page fitting reachable below the normal slider minimum', () => {
  const short = { width: 1280, height: 350 }
  const pages = [portrait, portrait]
  const minimum = pdfZoomLimits(short, [pages], true).min
  expect(minimum).toBe(pdfZoomPercent('fit-page', short, pages))
  expect(minimum).toBeLessThan(50)
  expect(portrait.height * minimum / 100).toBeLessThanOrEqual(short.height)
})

it('bounds the spread slider by the widest row, including a lone landscape page, and remeasures stacked rows', () => {
  const wide = { width: 1600, height: 900 }
  const rows = [[portrait, portrait], [portrait, wide], [wide]]
  const limits = pdfZoomLimits(desktop, rows, true)
  expect(limits).toMatchObject({ min: 35, max: 61, 'fit-width': 52 })
  expect((portrait.width + wide.width) * limits['fit-width'] / 100 + pdfSpreadGap).toBeLessThanOrEqual(desktop.width)
  expect(pdfZoomLimits({ width: 640, height: 800 }, rows, true)).toMatchObject({ min: 27, max: 47 })
  expect(pdfZoomLimits(desktop, [[wide]], false).max).toBe(300)
})

it('uses the available width for a narrow column without horizontally clipping either page', () => {
  const narrow = { width: 360, height: 800 }
  const landscape = { width: 1060, height: 748 }
  const reading = pdfZoomPercent('reading', narrow, [portrait, landscape])
  expect(reading).toBe(pdfZoomPercent('fit-width', narrow, [portrait, landscape]))
  expect(landscape.width * reading / 100).toBeLessThanOrEqual(narrow.width)
  expect(pdfZoomPercent(147, narrow, [landscape])).toBe(147)
})

it('keeps small pages at a moderate default while width fit can still fill the reader', () => {
  const small = { width: 400, height: 266 }
  expect(pdfZoomPercent('reading', desktop, [small])).toBe(150)
  expect(pdfZoomPercent('fit-width', desktop, [small])).toBe(300)
})

it('fits both page widths and their gap in a wide spread and stacks them in a narrow column', () => {
  const landscape = { width: 840, height: 590 }
  const pages = [portrait, landscape]
  expect(pdfCanSpread(desktop, pages)).toBe(true)
  const spread = pdfZoomPercent('fit-width', desktop, pages)
  expect(spread).toBe(Math.floor(100 * (desktop.width - pdfSpreadGap) / (portrait.width + landscape.width)))
  const narrow = { width: 620, height: 800 }
  expect(pdfCanSpread(narrow, pages)).toBe(false)
  expect(pdfZoomPercent('fit-width', narrow, pages)).toBe(Math.floor(100 * narrow.width / landscape.width))
  expect(pdfCanSpread(desktop, [portrait, undefined])).toBe(false)
})

it('derives the same display size from fixed previews rendered at different resolutions', () => {
  const preview = (scale: number): PdfPage => ({
    page: 1, label: '1', state: 'ready', text: '', textOrigin: 'native', ocr: 'not-performed',
    image: { mediaType: 'image/png', dataBase64: '', sha256: '', width: 600 * scale, height: 840 * scale },
    transform: { rotation: 0, cropBox: [0, 0, 600, 840], region: null, scale, engine: 'fixture' },
  })
  const size = pdfPageSize(preview(1))
  expect(size).toEqual({ width: 800, height: 1120 })
  expect(pdfPageSize(preview(2))).toEqual(size)
})
