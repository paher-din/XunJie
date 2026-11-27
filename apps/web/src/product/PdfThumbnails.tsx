import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@xunjie/ui/foundation'
import { Icon } from '@xunjie/ui/icons'
import type { RenderTask } from 'pdfjs-dist'
import type { usePdfReaderText } from './PdfReaderText'

type OpenDocument = ReturnType<typeof usePdfReaderText>

const THUMB_WIDTH = 56
const THUMB_HEIGHT = 72
const OPEN_DURATION_MS = 240
const CLOSE_DURATION_MS = 200
const EASE_OUT = 'cubic-bezier(0.3, 1, 0.35, 1)'

function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function nextFrame() {
  return new Promise<void>(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 0)
  })
}

function clearPanelStyles(panel: HTMLDivElement) {
  panel.style.height = ''
  panel.style.overflow = ''
  panel.style.transition = ''
  panel.style.opacity = ''
  panel.style.transform = ''
}

export function PdfThumbnails({ open, pageCount, page, facingPage, enabled, visible, onNavigate }: {
  open: OpenDocument; pageCount: number; page: number; facingPage?: number; enabled: boolean; visible: boolean; onNavigate(page: number): void
}) {
  const [expanded, setExpanded] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [renderReady, setRenderReady] = useState(false)
  const panelId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const cacheRef = useRef<Map<number, HTMLCanvasElement>>(new Map())
  const listenersRef = useRef<Map<number, (canvas: HTMLCanvasElement) => void>>(new Map())
  const currentPageRef = useRef(page)
  currentPageRef.current = page

  const subscribe = useCallback((pageNumber: number, listener: (canvas: HTMLCanvasElement) => void) => {
    listenersRef.current.set(pageNumber, listener)
    return () => {
      if (listenersRef.current.get(pageNumber) === listener) listenersRef.current.delete(pageNumber)
    }
  }, [])

  const clearCache = useCallback(() => {
    for (const canvas of cacheRef.current.values()) {
      canvas.width = 0
      canvas.height = 0
    }
    cacheRef.current.clear()
  }, [])

  useEffect(() => clearCache, [open, clearCache])

  const toggle = () => {
    if (!expanded) {
      setMounted(true)
      setExpanded(true)
    } else {
      setExpanded(false)
    }
  }

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!visible) {
      setRenderReady(false)
      if (panel) clearPanelStyles(panel)
      return
    }
    if (!mounted || !panel) return

    let active = true
    let fallbackTimer: number | undefined

    if (expanded) {
      setRenderReady(false)
      const fromRect = panel.getBoundingClientRect()
      const fromComputed = getComputedStyle(panel)
      const fromOpacity = fromComputed.opacity
      const fromTransform = fromComputed.transform

      panel.style.transition = 'none'
      panel.style.height = 'auto'
      panel.style.opacity = ''
      panel.style.transform = ''

      const sidebar = panel.closest('.pdf-reader-sidebar')
      const fullHeight = panel.scrollHeight
      const availableSidebarHeight = sidebar
        ? Math.max(180, sidebar.clientHeight - Math.max(0, panel.getBoundingClientRect().top - sidebar.getBoundingClientRect().top))
        : fullHeight
      const targetHeight = Math.min(fullHeight, availableSidebarHeight)

      if (prefersReducedMotion() || targetHeight <= 0) {
        clearPanelStyles(panel)
        setRenderReady(true)
        return
      }

      const startHeight = fromRect.height
      panel.style.overflow = 'hidden'
      panel.style.height = `${startHeight}px`
      panel.style.opacity = startHeight > 0 ? fromOpacity : '0'
      panel.style.transform = startHeight > 0 && fromTransform !== 'none' ? fromTransform : 'translateY(-4px)'
      void panel.offsetHeight

      panel.style.transition = `height ${OPEN_DURATION_MS}ms ${EASE_OUT}, opacity 200ms ${EASE_OUT}, transform ${OPEN_DURATION_MS}ms ${EASE_OUT}`
      panel.style.height = `${targetHeight}px`
      panel.style.opacity = '1'
      panel.style.transform = 'translateY(0)'

      const finish = () => {
        if (!active) return
        active = false
        window.clearTimeout(fallbackTimer)
        panel.removeEventListener('transitionend', onTransitionEnd)
        clearPanelStyles(panel)
        setRenderReady(true)
      }
      const onTransitionEnd = (event: TransitionEvent) => {
        if (event.target === panel && event.propertyName === 'height') finish()
      }
      panel.addEventListener('transitionend', onTransitionEnd)
      fallbackTimer = window.setTimeout(finish, OPEN_DURATION_MS + 20)
      return () => {
        active = false
        window.clearTimeout(fallbackTimer)
        panel.removeEventListener('transitionend', onTransitionEnd)
      }
    }

    setRenderReady(false)
    const startHeight = panel.getBoundingClientRect().height
    if (prefersReducedMotion() || startHeight <= 0) {
      clearPanelStyles(panel)
      setMounted(false)
      return
    }

    const sidebar = panel.closest('.pdf-reader-sidebar')
    const cappedStart = sidebar ? Math.min(startHeight, Math.max(180, sidebar.clientHeight)) : startHeight
    const fromComputed = getComputedStyle(panel)
    const fromOpacity = fromComputed.opacity
    const fromTransform = fromComputed.transform

    panel.style.transition = 'none'
    panel.style.overflow = 'hidden'
    panel.style.height = `${cappedStart}px`
    panel.style.opacity = fromOpacity
    panel.style.transform = fromTransform !== 'none' ? fromTransform : 'translateY(0)'
    void panel.offsetHeight

    panel.style.transition = `height ${CLOSE_DURATION_MS}ms ${EASE_OUT}, opacity 160ms ${EASE_OUT}, transform ${CLOSE_DURATION_MS}ms ${EASE_OUT}`
    panel.style.height = '0px'
    panel.style.opacity = '0'
    panel.style.transform = 'translateY(-4px)'

    const finish = () => {
      if (!active) return
      active = false
      window.clearTimeout(fallbackTimer)
      panel.removeEventListener('transitionend', onTransitionEnd)
      clearPanelStyles(panel)
      setMounted(false)
    }
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === panel && event.propertyName === 'height') finish()
    }
    panel.addEventListener('transitionend', onTransitionEnd)
    fallbackTimer = window.setTimeout(finish, CLOSE_DURATION_MS + 20)
    return () => {
      active = false
      window.clearTimeout(fallbackTimer)
      panel.removeEventListener('transitionend', onTransitionEnd)
    }
  }, [expanded, visible, mounted])

  useEffect(() => {
    if (!visible || !expanded || !renderReady) return
    navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [visible, expanded, renderReady, page])

  useEffect(() => {
    const nav = navRef.current
    if (!open || !visible || !mounted || !renderReady || !nav) return
    let active = true
    let running = false
    let activeTask: RenderTask | undefined
    const visiblePages = new Set<number>()
    const failedPages = new Set<number>()

    const pickNextPage = () => {
      let best: number | undefined
      let bestDistance = Infinity
      for (const candidate of visiblePages) {
        if (cacheRef.current.has(candidate) || failedPages.has(candidate)) continue
        const distance = Math.abs(candidate - currentPageRef.current)
        if (distance < bestDistance || (distance === bestDistance && (best === undefined || candidate < best))) {
          best = candidate
          bestDistance = distance
        }
      }
      return best
    }

    const pump = async () => {
      if (running || !active) return
      running = true
      try {
        while (active) {
          const nextPage = pickNextPage()
          if (nextPage === undefined) break
          try {
            const source = await open()
            if (!active) break
            const nativePage = await source.document.getPage(nextPage)
            if (!active) break
            const base = nativePage.getViewport({ scale: 1 })
            const dpr = Math.min(window.devicePixelRatio || 1, 2)
            const scale = Math.min((THUMB_WIDTH * dpr) / base.width, (THUMB_HEIGHT * dpr) / base.height)
            const viewport = nativePage.getViewport({ scale })
            const offscreen = document.createElement('canvas')
            offscreen.width = Math.max(1, Math.ceil(viewport.width))
            offscreen.height = Math.max(1, Math.ceil(viewport.height))
            activeTask = nativePage.render({ canvas: offscreen, viewport, background: 'rgb(255,255,255)' })
            await activeTask.promise
            activeTask = undefined
            if (!active) {
              offscreen.width = 0
              offscreen.height = 0
              break
            }
            const previous = cacheRef.current.get(nextPage)
            if (previous && previous !== offscreen) {
              previous.width = 0
              previous.height = 0
            }
            cacheRef.current.set(nextPage, offscreen)
            listenersRef.current.get(nextPage)?.(offscreen)
          } catch {
            activeTask = undefined
            if (active) failedPages.add(nextPage)
          }
          if (!active) break
          await nextFrame()
        }
      } finally {
        running = false
      }
    }

    const observer = new IntersectionObserver(entries => {
      if (!active) return
      for (const entry of entries) {
        const number = Number((entry.target as HTMLElement).dataset.thumbPage)
        if (!Number.isInteger(number) || number < 1) continue
        if (entry.isIntersecting) visiblePages.add(number)
        else visiblePages.delete(number)
      }
      void pump()
    }, { root: nav.closest('.pdf-reader-sidebar'), rootMargin: '120px 0px' })

    for (const item of nav.querySelectorAll<HTMLElement>('[data-thumb-page]')) {
      observer.observe(item)
    }

    return () => {
      active = false
      observer.disconnect()
      activeTask?.cancel()
      activeTask = undefined
    }
  }, [open, visible, mounted, renderReady, pageCount])

  return <div className="pdf-thumbnails" data-open={expanded ? 'true' : 'false'}>
    <button
      type="button"
      className="pdf-thumbnails-toggle"
      aria-expanded={expanded}
      aria-controls={panelId}
      onClick={toggle}
    >
      <span>页面缩略图</span>
      <Icon name="alt-arrow-down" size={12} variant="linear" tone="neutral" className="pdf-thumbnails-chevron" />
    </button>
    {visible && mounted && (
      <div
        id={panelId}
        ref={panelRef}
        className="pdf-thumbnails-panel"
        data-open={expanded ? 'true' : 'false'}
        aria-hidden={!expanded || undefined}
        inert={!expanded ? true : undefined}
      >
        <nav ref={navRef} className="pdf-thumbnail-grid" aria-label="PDF 页面缩略图">
          {Array.from({ length: pageCount }, (_, index) => index + 1).map(number =>
            <Button key={number} type="button" variant="outline" className="pdf-thumbnail" data-thumb-page={number}
              data-in-view={number === page || number === facingPage || undefined}
              aria-description={number === facingPage ? '当前双页中的第二页' : undefined}
              aria-current={page === number ? 'page' : undefined} disabled={!enabled} onClick={() => onNavigate(number)}>
              <ThumbnailPreview page={number} open={open} cache={cacheRef} subscribe={subscribe} />
              <span>第 {number} 页</span>
            </Button>)}
        </nav>
      </div>
    )}
  </div>
}

const ThumbnailPreview = memo(function ThumbnailPreview({ page, open, cache, subscribe }: {
  page: number
  open: OpenDocument
  cache: { current: Map<number, HTMLCanvasElement> }
  subscribe(page: number, listener: (canvas: HTMLCanvasElement) => void): () => void
}) {
  const targetRef = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'loading' | 'cached' | 'drawn'>(() => (cache.current.has(page) ? 'cached' : 'loading'))

  useLayoutEffect(() => {
    const canvas = targetRef.current
    if (!canvas) return

    const blit = (source: HTMLCanvasElement) => {
      canvas.width = source.width
      canvas.height = source.height
      canvas.getContext('2d')?.drawImage(source, 0, 0)
    }

    const cached = cache.current.get(page)
    if (cached) {
      blit(cached)
      setState('cached')
      return
    }

    setState('loading')
    return subscribe(page, source => {
      blit(source)
      setState('drawn')
    })
  }, [page, open, cache, subscribe])

  const drawn = state !== 'loading'
  return <span className="pdf-thumbnail-image" data-loading={!drawn || undefined} aria-hidden="true">
    {!drawn && <Icon name="file-text" size={16} />}
    <canvas ref={targetRef} hidden={!drawn} data-fade={state === 'drawn' || undefined} />
  </span>
})
