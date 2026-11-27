import { useEffect, useRef, useState, type RefObject } from 'react'
import type { PdfDocument, PdfPage } from '@xunjie/contracts/pdf-materials'
import { useToastFeedback } from '@xunjie/ui/feedback'
import type { RenderTask } from 'pdfjs-dist'
import { PdfContinuousText, type OpenPdfText } from './PdfReaderText'
import { pdfNativePageSize } from './pdfScroll'
import type { PdfSize } from './pdfZoom'

const maxEdge = 4096
const maxPixels = 8 * 1024 * 1024
const emptyPageSizes: ReadonlyMap<number, PdfSize> = new Map()

function sameSize(a: PdfSize | undefined, b: PdfSize | undefined) {
  return !!a && !!b && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5
}

/** Read intrinsic CSS page dimensions for multi-page continuous layout without blocking frames. */
export function usePdfPageSizes(
  openText: OpenPdfText | undefined,
  doc: PdfDocument | null,
  fallbackSize: PdfSize | undefined,
): ReadonlyMap<number, PdfSize> {
  const [sizes, setSizes] = useState<{ documentId: string; map: ReadonlyMap<number, PdfSize> } | null>(null)
  const fallbackRef = useRef(fallbackSize)
  fallbackRef.current = fallbackSize

  useEffect(() => {
    if (!openText || !doc || doc.pageCount <= 1) return
    let active = true
    const documentId = doc.documentId
    void (async () => {
      const source = await openText()
      if (!active) return
      const map = new Map<number, PdfSize>()
      const count = Math.min(doc.pageCount, source.document.numPages)
      for (let start = 1; start <= count && active; start += 16) {
        const end = Math.min(count, start + 15)
        for (let pageNumber = start; pageNumber <= end && active; pageNumber++) {
          const nativePage = await source.document.getPage(pageNumber)
          if (!active) return
          map.set(pageNumber, pdfNativePageSize(nativePage.getViewport({ scale: 1 })))
        }
        if (start + 16 <= count && active) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        }
      }
      if (!active) return
      const baseline = fallbackRef.current
      if (baseline && Array.from(map.values()).every(size => sameSize(size, baseline))) return
      setSizes({ documentId, map })
    })().catch(() => { /* Fallback page size remains usable if the original fails to load. */ })
    return () => { active = false }
  }, [openText, doc])

  return doc && sizes?.documentId === doc.documentId ? sizes.map : emptyPageSizes
}

function PdfContinuousCanvas({ open, pageNumber, size, frame, onDrawnChange }: {
  open: OpenPdfText
  pageNumber: number
  size: PdfSize | undefined
  frame: RefObject<HTMLDivElement | null>
  onDrawnChange(drawn: boolean): void
}) {
  const preview = useRef<HTMLDivElement>(null)
  const drawnCallback = useRef(onDrawnChange)
  drawnCallback.current = onDrawnChange
  const sizeWidth = size?.width
  const sizeHeight = size?.height

  useEffect(() => {
    const target = preview.current!, pageFrame = frame.current!
    let requested = 0
    let generation = 0
    let timer: number | undefined
    let task: RenderTask | undefined
    let activeCanvas: HTMLCanvasElement | undefined
    let isFirstRender = true

    const releaseCanvas = () => {
      if (activeCanvas) {
        activeCanvas.width = 0
        activeCanvas.height = 0
        activeCanvas = undefined
      }
      target.replaceChildren()
      drawnCallback.current(false)
    }

    const render = async (pixels: number, current: number) => {
      const source = await open()
      if (current !== generation) return
      const nativePage = await source.document.getPage(pageNumber)
      if (current !== generation) return
      const base = nativePage.getViewport({ scale: 1 })
      const scale = Math.min(
        pixels / base.width,
        maxEdge / base.width,
        maxEdge / base.height,
        Math.sqrt(maxPixels / (base.width * base.height)),
      )
      const viewport = nativePage.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.floor(viewport.width))
      canvas.height = Math.max(1, Math.floor(viewport.height))
      task = nativePage.render({ canvas, viewport, background: 'rgb(255,255,255)' })
      await task.promise
      if (current === generation) {
        task = undefined
        if (activeCanvas && activeCanvas !== canvas) {
          activeCanvas.width = 0
          activeCanvas.height = 0
        }
        activeCanvas = canvas
        target.replaceChildren(canvas)
        drawnCallback.current(true)
      } else {
        canvas.width = 0
        canvas.height = 0
      }
    }

    const schedule = () => {
      const deviceWidth = pageFrame.getBoundingClientRect().width * window.devicePixelRatio
      if (deviceWidth <= 0) return
      const maxWidth = sizeWidth && sizeHeight
        ? Math.floor(Math.min(maxEdge, maxEdge * sizeWidth / sizeHeight, Math.sqrt(maxPixels * sizeWidth / sizeHeight)))
        : maxEdge
      const next = Math.min(maxWidth, Math.ceil(deviceWidth / 128) * 128)
      if (next <= 0 || next === requested) return
      requested = next
      const current = ++generation
      window.clearTimeout(timer)
      task?.cancel()
      task = undefined
      if (isFirstRender) {
        isFirstRender = false
        void render(next, current).catch(() => {
          if (current === generation) { task = undefined; releaseCanvas() }
        })
        return
      }
      timer = window.setTimeout(() => {
        void render(next, current).catch(() => {
          if (current === generation) { task = undefined; releaseCanvas() }
        })
      }, 120)
    }

    const observer = new ResizeObserver(schedule)
    observer.observe(pageFrame)
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      ++generation
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.clearTimeout(timer)
      task?.cancel()
      releaseCanvas()
    }
  }, [open, pageNumber, sizeWidth, sizeHeight, frame])

  return <div className="pdf-page-preview" aria-hidden="true" ref={preview} />
}

export function PdfContinuousPage({ pageNumber, label, size, percent, fixedPage, openText, viewport, onTextLayout }: {
  pageNumber: number
  label: string | undefined
  size: PdfSize | undefined
  percent: number
  fixedPage: PdfPage | undefined
  openText: OpenPdfText | undefined
  viewport: RefObject<HTMLDivElement | null>
  onTextLayout(): void
}) {
  const frameRef = useRef<HTMLDivElement>(null)
  const [nearViewport, setNearViewport] = useState(() => !!fixedPage || pageNumber <= 2)
  const [canvasDrawn, setCanvasDrawn] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  useToastFeedback(imageFailed ? '固定页图无法在浏览器中显示，请重新定位核对原记录；不会重新渲染替换这份引用。' : '')

  useEffect(() => {
    setImageFailed(false)
  }, [fixedPage?.image?.sha256])

  const effectiveLabel = fixedPage?.label ?? label
  const hasError = !!fixedPage && (fixedPage.state !== 'ready' || !fixedPage.image)
  const hasFixedImage = !hasError && !!fixedPage?.image && !imageFailed

  useEffect(() => {
    if (hasError) return
    const frame = frameRef.current
    if (!frame) return
    const observer = new IntersectionObserver(entries => {
      const entry = entries[entries.length - 1]
      if (entry) setNearViewport(entry.isIntersecting)
    }, { root: viewport.current, rootMargin: '600px 0px' })
    observer.observe(frame)
    return () => observer.disconnect()
  }, [viewport, hasError])

  return <article className="pdf-page" data-pdf-page={pageNumber} tabIndex={-1}
    aria-label={effectiveLabel && effectiveLabel !== String(pageNumber) ? `第 ${pageNumber} 页，页标签 ${effectiveLabel}` : `第 ${pageNumber} 页`}
    style={size ? { width: size.width * percent / 100 } : undefined}>
    {hasError ? <p className="pdf-error" role="status">{fixedPage.state === 'out-of-range' ? '此页超出 PDF 实际页数。'
      : fixedPage.state === 'limit' ? '此页图超出处理尺寸或体积限制，无法显示。'
        : fixedPage.state === 'timeout' ? '此页处理超时，未生成可引用页图。' : '此页图未完整生成，无法引用。'}{fixedPage.detail ? ` ${fixedPage.detail}` : ''}</p>
      : <div className={hasFixedImage ? 'pdf-page-image' : 'pdf-page-sheet'} ref={frameRef}
        style={size ? { aspectRatio: `${size.width} / ${size.height}` } : undefined}>
        {hasFixedImage && <img src={`data:image/png;base64,${fixedPage.image!.dataBase64}`}
          alt={`PDF 第 ${pageNumber} 页固定页图`} draggable={false}
          width={fixedPage.image!.width} height={fixedPage.image!.height} onError={() => setImageFailed(true)} />}
        {imageFailed && <p className="pdf-muted">固定页图无法在浏览器中显示，请重新定位核对原记录。</p>}
        {!hasFixedImage && !imageFailed && !canvasDrawn && <span className="pdf-page-placeholder" aria-hidden="true">第 {pageNumber} 页</span>}
        {openText && nearViewport && !imageFailed && <>
          <PdfContinuousCanvas open={openText} pageNumber={pageNumber} size={size} frame={frameRef} onDrawnChange={setCanvasDrawn} />
          <PdfContinuousText open={openText} pageNumber={pageNumber} frame={frameRef} expectText={!!fixedPage?.text.trim()} onLayout={onTextLayout} />
        </>}
      </div>}
  </article>
}
