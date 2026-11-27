import { expect, it } from 'vitest'
import type { PdfPage } from '@xunjie/contracts/pdf-materials'
import { buildPdfTwoPageRows, findActivePdfPage, findPdfTwoPageRowIndex, pdfNativePageSize, type PdfPageSpan } from './pdfScroll'
import { pdfPageSize } from './pdfZoom'

const tallPages: PdfPageSpan[] = [
  { page: 1, top: 0, bottom: 1000 },
  { page: 2, top: 1012, bottom: 2012 },
  { page: 3, top: 2024, bottom: 3024 },
]

it('tracks tall multi-page PDF transitions at top, middle, and bottom', () => {
  const clientHeight = 800
  const scrollHeight = 3024
  expect(findActivePdfPage(tallPages, 0, clientHeight, scrollHeight, 2)).toBe(1)
  expect(findActivePdfPage(tallPages, 1, clientHeight, scrollHeight, 2)).toBe(1)
  expect(findActivePdfPage(tallPages, 750, clientHeight, scrollHeight, 1)).toBe(2)
  expect(findActivePdfPage(tallPages, scrollHeight - clientHeight, clientHeight, scrollHeight, 1)).toBe(3)
})

it('handles short multi-page PDFs where maxScroll is smaller than half the viewport', () => {
  const shortPages: PdfPageSpan[] = [
    { page: 1, top: 0, bottom: 400 },
    { page: 2, top: 412, bottom: 812 },
  ]
  const clientHeight = 700
  const scrollHeight = 812
  expect(findActivePdfPage(shortPages, 0, clientHeight, scrollHeight, 2)).toBe(1)
  expect(findActivePdfPage(shortPages, scrollHeight - clientHeight, clientHeight, scrollHeight, 1)).toBe(2)
})

it('activates a short last page after a tall page when scrolled to the bottom', () => {
  const mixedPages: PdfPageSpan[] = [
    { page: 1, top: 0, bottom: 1400 },
    { page: 2, top: 1412, bottom: 1612 },
  ]
  const clientHeight = 800
  const scrollHeight = 1612
  expect(findActivePdfPage(mixedPages, scrollHeight - clientHeight, clientHeight, scrollHeight, 1)).toBe(2)
})

it('preserves fallbackPage when content fits without scrolling', () => {
  const spans: PdfPageSpan[] = [
    { page: 1, top: 0, bottom: 300 },
    { page: 2, top: 312, bottom: 612 },
  ]
  expect(findActivePdfPage(spans, 0, 800, 612, 2)).toBe(2)
  expect(findActivePdfPage([], 100, 800, 1200, 3)).toBe(3)
})

it('picks the nearest page when the anchor falls in the gap between pages', () => {
  const spans: PdfPageSpan[] = [
    { page: 1, top: 0, bottom: 1000 },
    { page: 2, top: 1040, bottom: 2040 },
  ]
  // clientHeight = 800, scrollHeight = 2040 => baseOffset = 280
  // scrollTop = 730 => anchorY = 1010 (closer to page 1 bottom=1000 than page 2 top=1040)
  expect(findActivePdfPage(spans, 730, 800, 2040, 2)).toBe(1)
  // scrollTop = 750 => anchorY = 1030 (closer to page 2 top=1040)
  expect(findActivePdfPage(spans, 750, 800, 2040, 1)).toBe(2)
})

it('converts 72pt PDF viewport dimensions to 96px CSS pixels identically to pdfPageSize', () => {
  const preview: PdfPage = {
    page: 1, label: '1', state: 'ready', text: '', textOrigin: 'native', ocr: 'not-performed',
    image: { mediaType: 'image/png', dataBase64: '', sha256: '', width: 1200, height: 1680 },
    transform: { rotation: 0, cropBox: [0, 0, 600, 840], region: null, scale: 2, engine: 'fixture' },
  }
  expect(pdfNativePageSize({ width: 600, height: 840 })).toEqual(pdfPageSize(preview))
})

it('builds continuous two-page rows preserving the anchor spread pair', () => {
  expect(buildPdfTwoPageRows(0, 1)).toEqual([])
  expect(buildPdfTwoPageRows(2, 1)).toEqual([[1, 2]])
  expect(buildPdfTwoPageRows(3, 1)).toEqual([[1, 2], [3]])
  expect(buildPdfTwoPageRows(3, 2)).toEqual([[1], [2, 3]])
  expect(buildPdfTwoPageRows(14, 8)).toEqual([
    [1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11], [12, 13], [14],
  ])
  const rows = buildPdfTwoPageRows(14, 8)
  expect(rows.flat()).toEqual(Array.from({ length: 14 }, (_, i) => i + 1))
  expect(findPdfTwoPageRowIndex(rows, 1)).toBe(0)
  expect(findPdfTwoPageRowIndex(rows, 8)).toBe(4)
  expect(findPdfTwoPageRowIndex(rows, 9)).toBe(4)
  expect(findPdfTwoPageRowIndex(rows, 14)).toBe(7)
  expect(findPdfTwoPageRowIndex(rows, 99)).toBe(0)
})
