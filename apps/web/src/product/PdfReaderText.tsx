import { useEffect, useState, useRef, type RefObject } from 'react'
import type { PdfDocument, PdfPage } from '@xunjie/contracts/pdf-materials'
import type { openPdfText } from './pdfTextEngine'

type PdfTextEngine = typeof import('./pdfTextEngine')
type TextSource = { engine: PdfTextEngine; document: Awaited<ReturnType<typeof openPdfText>['promise']> }
type OpenText = () => Promise<TextSource>
type LoadOriginal = (document: PdfDocument, signal: AbortSignal) => Promise<Uint8Array>

export function usePdfReaderText(document: PdfDocument | null, loadOriginal: LoadOriginal) {
  const [source, setSource] = useState<{ document: PdfDocument; open: OpenText }>()
  useEffect(() => {
    if (!document) return
    const controller = new AbortController()
    let task: ReturnType<typeof openPdfText> | undefined
    let pending: Promise<TextSource> | undefined
    // One original and one worker per open document, shared by consecutive page reads.
    const open = () => pending ??= Promise.all([loadOriginal(document, controller.signal), import('./pdfTextEngine')])
      .then(async ([data, engine]) => {
        controller.signal.throwIfAborted()
        task = engine.openPdfText(data)
        return { engine, document: await task.promise }
      })
    setSource({ document, open })
    return () => {
      controller.abort()
      if (task) void task.destroy().catch(() => {})
    }
  }, [document, loadOriginal])
  return source?.document === document ? source.open : undefined
}

export function PdfReaderText({ open, page, width, frame, onLayout }: {
  open: OpenText; page: PdfPage; width: number; frame: RefObject<HTMLDivElement | null>; onLayout(): void
}) {
  const scaled = useRef<HTMLDivElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  useEffect(() => {
    const node = container.current!, scaledNode = scaled.current!, imageFrame = frame.current!
    let active = true
    let layer: InstanceType<PdfTextEngine['TextLayer']> | undefined
    setState('loading')
    const resize = ({ width: displayedWidth }: { width: number }) => {
      scaledNode.style.transform = `scale(${displayedWidth / width})`
    }
    resize(imageFrame.getBoundingClientRect())
    const observer = new ResizeObserver(([entry]) => resize(entry.contentRect))
    observer.observe(imageFrame)
    void (async () => {
      const source = await open()
      if (!active) return
      const nativePage = await source.document.getPage(page.page)
      if (!active) return
      const { scale, cropBox, region, rotation } = page.transform
      if (scale <= 0 || cropBox.length !== 4 || !nativePage.view.every((value, index) => value === cropBox[index]))
        throw new Error('PDF 文字与固定页图的尺寸不一致。')
      const viewport = nativePage.getViewport({ scale, rotation })
      node.style.setProperty('--total-scale-factor', String(scale * nativePage.userUnit))
      node.style.left = `${-viewport.width * (region?.x ?? 0)}px`
      node.style.top = `${-viewport.height * (region?.y ?? 0)}px`
      layer = new source.engine.TextLayer({ textContentSource: nativePage.streamTextContent(), container: node, viewport })
      // Match the original viewport exactly before scaling it to the displayed image.
      const sideways = viewport.rotation % 180 !== 0
      node.style.width = `${sideways ? viewport.height : viewport.width}px`
      node.style.height = `${sideways ? viewport.width : viewport.height}px`
      await layer.render()
      if (active) setState(layer.textDivs.some(div => div.textContent?.trim()) ? 'ready' : 'unavailable')
    })().catch(() => {
      if (active) setState('unavailable')
    })
    return () => {
      active = false
      observer.disconnect()
      layer?.cancel()
      node.replaceChildren()
    }
  }, [open, page, width, frame])
  useEffect(onLayout, [state, onLayout])
  return <>
    <div className="pdf-text-scale" ref={scaled}>
      <div className="pdf-page-text" data-text-state={state} aria-hidden={state !== 'ready'} ref={container} />
    </div>
    {state === 'unavailable' && <span className="pdf-text-unavailable" role="status">原生文字暂不可选</span>}
  </>
}

const highlightName = 'xunjie-pdf-find'
const matchLimit = 500

function findPageText(layer: HTMLElement, pattern: RegExp, limit: number, cropped: boolean): Range[] {
  const runs: { node: Text; start: number; end: number }[] = []
  let text = ''
  for (const child of layer.children) {
    if (child.tagName === 'BR') { text += '\n'; continue }
    const node = child.firstChild
    if (!(node instanceof Text) || !node.length) continue
    const start = text.length
    text += node.data
    runs.push({ node, start, end: text.length })
  }
  const clip = cropped ? layer.closest('.pdf-page-image')?.getBoundingClientRect() : undefined
  let first = 0, last = 0
  const matches: Range[] = []
  for (const match of text.matchAll(pattern)) {
    const start = match.index, end = start + match[0].length
    while (runs[first] && runs[first].end <= start) first++
    last = Math.max(first, last)
    while (runs[last] && runs[last].end < end) last++
    if (!runs[last] || start < runs[first].start || end <= runs[last].start) continue
    const range = document.createRange()
    range.setStart(runs[first].node, start - runs[first].start)
    range.setEnd(runs[last].node, end - runs[last].start)
    if (clip && !Array.from(range.getClientRects()).some(rect =>
      rect.right > clip.left && rect.left < clip.right && rect.bottom > clip.top && rect.top < clip.bottom)) continue
    matches.push(range)
    if (matches.length >= limit) break
  }
  return matches
}

export function usePdfTextFind(viewport: RefObject<HTMLDivElement | null>, readingId: string | undefined,
  query: string, layout: number, cropped: boolean) {
  const [result, setResult] = useState({ count: 0, loading: false, unavailable: false })
  const firstMatch = useRef<Range | undefined>(undefined)
  useEffect(() => {
    firstMatch.current = undefined
    const value = query.trim()
    const area = viewport.current
    if (!area || !value || !readingId) { setResult({ count: 0, loading: false, unavailable: false }); return }
    const pattern = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
    const matches: Range[] = []
    const layers = Array.from(area.querySelectorAll<HTMLElement>('.pdf-page-text'))
    for (const layer of layers.filter(layer => layer.dataset.textState === 'ready')) {
      matches.push(...findPageText(layer, pattern, matchLimit - matches.length, cropped))
      if (matches.length >= matchLimit) break
    }
    firstMatch.current = matches[0]
    setResult({ count: matches.length, loading: layers.some(layer => layer.dataset.textState === 'loading'),
      unavailable: layers.length > 0 && layers.every(layer => layer.dataset.textState === 'unavailable') })
    if (!globalThis.Highlight || !CSS.highlights) return
    const highlight = new Highlight(...matches)
    CSS.highlights.set(highlightName, highlight)
    return () => {
      if (CSS.highlights.get(highlightName) === highlight) CSS.highlights.delete(highlightName)
    }
  }, [viewport, readingId, query, layout, cropped])
  return { ...result, count: result.count >= matchLimit ? `${matchLimit}+` : result.count, revealMatch() {
    const area = viewport.current
    if (!area || !firstMatch.current) return
    const match = firstMatch.current.getBoundingClientRect(), bounds = area.getBoundingClientRect()
    if (match.top < bounds.top + 12 || match.bottom > bounds.bottom - 12)
      area.scrollBy({ top: match.top - bounds.top - 24 })
    if (match.left < bounds.left + 12 || match.right > bounds.right - 12)
      area.scrollBy({ left: match.left - bounds.left - 24 })
  } }
}
