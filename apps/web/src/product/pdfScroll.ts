import type { PdfSize } from './pdfZoom'

export type PdfPageSpan = { page: number; top: number; bottom: number }

/** Convert PDF points (72 DPI) to CSS pixels (96 DPI), matching `pdfPageSize`. */
export function pdfNativePageSize(viewport: { width: number; height: number }): PdfSize {
  const scale = 96 / 72
  return { width: viewport.width * scale, height: viewport.height * scale }
}

/** Pick the active page for the current scroll position using a bottom-aware anchor. */
export function findActivePdfPage(
  spans: readonly PdfPageSpan[],
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  fallbackPage: number,
): number {
  if (spans.length === 0 || clientHeight <= 0) return fallbackPage
  const maxScroll = Math.max(0, scrollHeight - clientHeight)
  if (maxScroll <= 1) return fallbackPage
  if (scrollTop <= 1) return spans[0].page

  const baseOffset = clientHeight * 0.35
  const bottomOffset = Math.max(baseOffset, clientHeight - 16)
  const zone = Math.min(maxScroll, clientHeight * 0.5)
  const remaining = Math.max(0, maxScroll - scrollTop)
  const progress = zone > 0 && remaining < zone ? 1 - remaining / zone : 0
  const anchorY = scrollTop + baseOffset + progress * (bottomOffset - baseOffset)

  let bestPage = spans[0].page
  let bestDistance = Infinity
  for (const span of spans) {
    if (span.top <= anchorY && anchorY <= span.bottom) return span.page
    const distance = anchorY < span.top ? span.top - anchorY : anchorY - span.bottom
    if (distance < bestDistance) {
      bestDistance = distance
      bestPage = span.page
    }
  }
  return bestPage
}

/** Group all pages into 1- or 2-page rows so `[anchorPage, anchorPage + 1]` stay paired. */
export function buildPdfTwoPageRows(pageCount: number, anchorPage: number): number[][] {
  if (pageCount <= 0) return []
  const rows: number[][] = []
  let start = 1
  if (anchorPage >= 2 && anchorPage % 2 === 0) {
    rows.push([1])
    start = 2
  }
  for (let page = start; page <= pageCount; page += 2) {
    rows.push(page + 1 <= pageCount ? [page, page + 1] : [page])
  }
  return rows
}

/** Return the row index containing `page`, or `0` if absent. */
export function findPdfTwoPageRowIndex(rows: readonly (readonly number[])[], page: number): number {
  const index = rows.findIndex(row => row.includes(page))
  return index >= 0 ? index : 0
}
