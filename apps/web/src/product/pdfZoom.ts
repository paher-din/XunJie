import type { PdfPage } from '@xunjie/contracts/pdf-materials'

export const pdfZoomMax = 300
export const pdfSpreadGap = 16
const preferredPdfZoomMin = 50
const pdfSpreadMinWidth = 760
export const pdfZoomStops = [
  { value: 'fit-page', label: '适合整页', edge: 'top' },
  { value: 'fit-width', label: '适合宽度', edge: 'bottom' },
] as const

export type PdfZoom = 'reading' | (typeof pdfZoomStops)[number]['value'] | number
export type PdfSize = { width: number; height: number }

export function pdfCanSpread(viewport: PdfSize, pages: readonly (PdfSize | undefined)[]) {
  return viewport.width >= pdfSpreadMinWidth && pages.length === 2 && pages.every(Boolean)
}

export function pdfPageSize(page: PdfPage): PdfSize | undefined {
  if (!page.image) return
  // PDF points use 72 per inch, while CSS uses 96. Undo the fixed preview's raster scale.
  const scale = page.transform.scale > 0 ? 96 / 72 / page.transform.scale : 1
  return { width: page.image.width * scale, height: page.image.height * scale }
}

export function pdfZoomPercent(zoom: PdfZoom, viewport: PdfSize, pages: readonly (PdfSize | undefined)[]): number {
  if (typeof zoom === 'number') return zoom
  if (!viewport.width || !viewport.height) return 100
  const widths = pages.map(page => page?.width ?? 0)
  const spread = pdfCanSpread(viewport, pages)
  const width = spread ? widths[0] + widths[1] : Math.max(0, ...widths)
  const height = Math.max(0, ...pages.map(page => page?.height ?? 0))
  if (!width || !height) return 100

  const widthPercent = 100 * (viewport.width - (spread ? pdfSpreadGap : 0)) / width
  const heightPercent = 100 * Math.max(1, viewport.height - 26) / height // Page label and its bottom margin.
  // Give ordinary pages a larger reading size while still fitting a narrow column or spread.
  const readingPercent = Math.min(150, Math.max(125, heightPercent * 1.25))
  const wanted = zoom === 'reading' ? Math.min(widthPercent, readingPercent)
    : zoom === 'fit-page' ? Math.min(widthPercent, heightPercent) : widthPercent
  return Math.max(1, Math.min(pdfZoomMax, Math.floor(wanted)))
}

export function pdfZoomSliderMin(viewport: PdfSize, pages: readonly (PdfSize | undefined)[]): number {
  return Math.min(preferredPdfZoomMin, pdfZoomPercent('fit-page', viewport, pages))
}
