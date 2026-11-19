import { expect, it } from 'vitest'
import type { PdfPage } from '@xunjie/contracts/pdf-materials'
import { pdfPageSize, pdfZoomPercent } from './pdfZoom'

const portrait = { width: 794, height: 1123 }
const desktop = { width: 1280, height: 800 }

it('opens a wide desktop view between fit page and fit width', () => {
  const reading = pdfZoomPercent('reading', desktop, [portrait])
  expect(reading).toBeGreaterThan(pdfZoomPercent('fit-page', desktop, [portrait]))
  expect(reading).toBeLessThan(pdfZoomPercent('fit-width', desktop, [portrait]))
  expect(portrait.width * reading / 100).toBeLessThanOrEqual(desktop.width)
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
