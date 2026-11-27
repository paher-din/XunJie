import { useEffect, useState, useRef, type RefObject } from 'react'
import { toast } from '@xunjie/ui/feedback'
import { Button } from '@xunjie/ui/foundation'
import { Icon } from '@xunjie/ui/icons'
import type { PdfDocument, PdfPage } from '@xunjie/contracts/pdf-materials'
import type { openPdfText } from './pdfTextEngine'

type PdfTextEngine = typeof import('./pdfTextEngine')
type TextSource = { engine: PdfTextEngine; document: Awaited<ReturnType<typeof openPdfText>['promise']> }
export type OpenPdfText = () => Promise<TextSource>
type LoadOriginal = (document: PdfDocument, signal: AbortSignal) => Promise<Uint8Array>

export function usePdfReaderText(document: PdfDocument | null, loadOriginal: LoadOriginal) {
  const [source, setSource] = useState<{ document: PdfDocument; open: OpenPdfText }>()
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
  open: OpenPdfText; page: PdfPage; width: number; frame: RefObject<HTMLDivElement | null>; onLayout(): void
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

export function PdfContinuousText({ open, pageNumber, frame, expectText, onLayout }: {
  open: OpenPdfText; pageNumber: number; frame: RefObject<HTMLDivElement | null>; expectText: boolean; onLayout(): void
}) {
  const scaled = useRef<HTMLDivElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const [rawState, setRawState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')
  useEffect(() => {
    const node = container.current!, scaledNode = scaled.current!, pageFrame = frame.current!
    let active = true
    let viewportWidth = 0
    let layer: InstanceType<PdfTextEngine['TextLayer']> | undefined
    setRawState('loading')
    const resize = ({ width: displayedWidth }: { width: number }) => {
      if (viewportWidth > 0) scaledNode.style.transform = `scale(${displayedWidth / viewportWidth})`
    }
    const observer = new ResizeObserver(([entry]) => resize(entry.contentRect))
    observer.observe(pageFrame)
    void (async () => {
      const source = await open()
      if (!active) return
      const nativePage = await source.document.getPage(pageNumber)
      if (!active) return
      const scale = 96 / 72
      const viewport = nativePage.getViewport({ scale })
      viewportWidth = viewport.width
      resize(pageFrame.getBoundingClientRect())
      node.style.setProperty('--total-scale-factor', String(scale * nativePage.userUnit))
      node.style.left = '0px'
      node.style.top = '0px'
      layer = new source.engine.TextLayer({ textContentSource: nativePage.streamTextContent(), container: node, viewport })
      const sideways = viewport.rotation % 180 !== 0
      node.style.width = `${sideways ? viewport.height : viewport.width}px`
      node.style.height = `${sideways ? viewport.width : viewport.height}px`
      await layer.render()
      if (active) setRawState(layer.textDivs.some(div => div.textContent?.trim()) ? 'ready' : 'empty')
    })().catch(() => {
      if (active) setRawState('error')
    })
    return () => {
      active = false
      observer.disconnect()
      layer?.cancel()
      node.replaceChildren()
    }
  }, [open, pageNumber, frame])
  const state = rawState === 'error' ? 'unavailable' : rawState === 'empty' && expectText ? 'unavailable' : rawState
  useEffect(() => {
    onLayout()
    return () => { onLayout() }
  }, [state, onLayout])
  return <>
    <div className="pdf-text-scale" ref={scaled}>
      <div className="pdf-page-text" data-text-state={state} aria-hidden={state !== 'ready'} ref={container} />
    </div>
    {state === 'unavailable' && expectText && <span className="pdf-text-unavailable" role="status">原生文字暂不可选</span>}
  </>
}

const highlightName = 'xunjie-pdf-find'
const activeHighlightName = 'xunjie-pdf-find-active'
const matchLimit = 500
const emptyFind = { matches: [] as Range[], index: 0, loading: false, unavailable: false, hasReady: false }

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
  const clip = cropped ? layer.closest('.pdf-page-image, .pdf-page-sheet')?.getBoundingClientRect() : undefined
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

function revealPdfMatch(area: HTMLDivElement, range: Range) {
  const match = range.getBoundingClientRect(), bounds = area.getBoundingClientRect()
  if (match.top < bounds.top + 52 || match.bottom > bounds.bottom - 12)
    area.scrollBy({ top: match.top - bounds.top - 68 })
  if (match.left < bounds.left + 12 || match.right > bounds.right - 12)
    area.scrollBy({ left: match.left - bounds.left - 24 })
}

export function usePdfTextFind(viewport: RefObject<HTMLDivElement | null>, readingId: string | undefined,
  pages: readonly number[], query: string, layout: number, cropped: boolean) {
  const [result, setResult] = useState(emptyFind)
  useEffect(() => {
    const value = query.trim()
    const area = viewport.current
    if (!area || !value || !readingId) { setResult(emptyFind); return }
    const pattern = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
    const matches: Range[] = []
    const layers = pages.flatMap(page => Array.from(
      area.querySelectorAll<HTMLElement>(`[data-pdf-page="${page}"] .pdf-page-text`),
    ))
    for (const layer of layers.filter(layer => layer.dataset.textState === 'ready')) {
      matches.push(...findPageText(layer, pattern, matchLimit - matches.length, cropped))
      if (matches.length >= matchLimit) break
    }
    const hasReady = layers.some(layer => layer.dataset.textState === 'ready')
    setResult({ matches, index: 0, loading: layers.some(layer => layer.dataset.textState === 'loading'),
      unavailable: layers.length > 0 && layers.some(layer => layer.dataset.textState === 'unavailable') && !hasReady,
      hasReady })
    if (!globalThis.Highlight || !CSS.highlights) return
    const highlight = new Highlight(...matches)
    CSS.highlights.set(highlightName, highlight)
    return () => {
      if (CSS.highlights.get(highlightName) === highlight) CSS.highlights.delete(highlightName)
    }
  }, [viewport, readingId, pages, query, layout, cropped])

  const active = result.matches[result.index]
  useEffect(() => {
    const area = viewport.current
    if (!area || !active) return
    revealPdfMatch(area, active)
    if (!globalThis.Highlight || !CSS.highlights) return
    const highlight = new Highlight(active)
    highlight.priority = 1
    CSS.highlights.set(activeHighlightName, highlight)
    return () => {
      if (CSS.highlights.get(activeHighlightName) === highlight) CSS.highlights.delete(activeHighlightName)
    }
  }, [active, viewport])

  const count = result.matches.length
  return { count, total: count >= matchLimit ? `${matchLimit}+` : String(count),
    position: result.index + 1, loading: result.loading, unavailable: result.unavailable, hasReady: result.hasReady,
    step(delta: -1 | 1) {
      if (count === 1 && active && viewport.current) revealPdfMatch(viewport.current, active)
      setResult(previous => {
        const length = previous.matches.length
        return length > 1 ? { ...previous, index: (previous.index + delta + length) % length } : previous
      })
    } }
}

type CopySelection = { text: string; left: number; top: number; above: boolean }

function findCopySelection(area: HTMLDivElement): CopySelection | null {
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount || !selection.anchorNode || !selection.focusNode) return null
  const anchorLayer = selection.anchorNode.parentElement?.closest('.pdf-page-text[data-text-state="ready"]')
  const focusLayer = selection.focusNode.parentElement?.closest('.pdf-page-text[data-text-state="ready"]')
  if (!anchorLayer || !focusLayer || !area.contains(anchorLayer) || !area.contains(focusLayer)) return null
  const frame = anchorLayer.closest('.pdf-page-image, .pdf-page-sheet')
  if (!frame) return null
  const page = frame.getBoundingClientRect(), bounds = area.getBoundingClientRect()
  const clip = anchorLayer === focusLayer
    ? { left: Math.max(page.left, bounds.left), right: Math.min(page.right, bounds.right),
      top: Math.max(page.top, bounds.top), bottom: Math.min(page.bottom, bounds.bottom) }
    : bounds
  const rect = Array.from(selection.getRangeAt(0).getClientRects()).find(rect =>
    rect.width > 0 && rect.height > 0
      && rect.right > clip.left && rect.left < clip.right
      && rect.bottom > clip.top && rect.top < clip.bottom)
  const text = selection.toString()
  if (!rect || !text.trim()) return null
  const above = rect.top - bounds.top >= 48
  return { text, above, left: Math.max(rect.left, clip.left) - bounds.left,
    top: (above ? rect.top - 6 : Math.min(rect.bottom + 6, bounds.bottom - 40)) - bounds.top }
}

export function PdfSelectionCopy({ viewport, readingId, scale, enabled }: {
  viewport: RefObject<HTMLDivElement | null>; readingId?: string; scale: number; enabled: boolean
}) {
  const [selection, setSelection] = useState<CopySelection | null>(null)
  useEffect(() => {
    const area = viewport.current
    if (!area || !enabled || !readingId) { setSelection(null); return }
    let frame = 0, dragging = false
    const sync = () => {
      cancelAnimationFrame(frame)
      if (!dragging) frame = requestAnimationFrame(() => setSelection(findCopySelection(area)))
    }
    const start = () => { dragging = true; setSelection(null); cancelAnimationFrame(frame) }
    const end = () => { if (dragging) { dragging = false; sync() } }
    const observer = new ResizeObserver(sync)
    observer.observe(area)
    area.addEventListener('pointerdown', start)
    area.addEventListener('scroll', sync, { passive: true })
    document.addEventListener('pointerup', end)
    document.addEventListener('pointercancel', end)
    document.addEventListener('selectionchange', sync)
    sync()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      area.removeEventListener('pointerdown', start)
      area.removeEventListener('scroll', sync)
      document.removeEventListener('pointerup', end)
      document.removeEventListener('pointercancel', end)
      document.removeEventListener('selectionchange', sync)
    }
  }, [viewport, readingId, enabled, scale])
  if (!enabled || !selection || !readingId) return null
  return <Button type="button" variant="outline" className="pdf-selection-copy" aria-label="复制选中文字"
    data-above={selection.above} style={{ left: `clamp(6px, ${selection.left}px, calc(100% - 86px))`, top: selection.top }}
    onPointerDown={event => event.preventDefault()} onClick={async () => {
      try {
        await navigator.clipboard.writeText(selection.text)
        toast.success('已复制选中文字')
      } catch { toast.error('无法访问剪贴板，请使用浏览器的复制快捷键。') }
    }}>
    <Icon name="copy" size={14} />复制
  </Button>
}
