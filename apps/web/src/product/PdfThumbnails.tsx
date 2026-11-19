import { useEffect, useRef, useState } from 'react'
import { Button } from '@xunjie/ui/foundation'
import { Icon } from '@xunjie/ui/icons'
import type { RenderTask } from 'pdfjs-dist'
import type { usePdfReaderText } from './PdfReaderText'

type OpenDocument = ReturnType<typeof usePdfReaderText>

export function PdfThumbnails({ open, pageCount, page, enabled, visible, onNavigate }: {
  open: OpenDocument; pageCount: number; page: number; enabled: boolean; visible: boolean; onNavigate(page: number): void
}) {
  const [expanded, setExpanded] = useState(false)
  return <details className="pdf-thumbnails" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>页面缩略图</summary>
    {visible && expanded && <nav className="pdf-thumbnail-grid" aria-label="PDF 页面缩略图">
      {Array.from({ length: pageCount }, (_, index) => index + 1).map(number =>
        <Button key={number} type="button" variant="outline" className="pdf-thumbnail"
          aria-current={page === number ? 'page' : undefined} disabled={!enabled} onClick={() => onNavigate(number)}>
          <ThumbnailPreview open={open} page={number} />
          <span>第 {number} 页</span>
        </Button>)}
    </nav>}
  </details>
}

function ThumbnailPreview({ open, page }: { open: OpenDocument; page: number }) {
  const target = useRef<HTMLCanvasElement>(null)
  const [drawn, setDrawn] = useState(false)
  useEffect(() => {
    const canvas = target.current
    if (!canvas || !open) return
    let active = true
    let task: RenderTask | undefined
    setDrawn(false)
    const render = async () => {
      const source = await open()
      if (!active) return
      const nativePage = await source.document.getPage(page)
      if (!active) return
      const base = nativePage.getViewport({ scale: 1 })
      const scale = Math.min(112 / base.width, 144 / base.height)
      const viewport = nativePage.getViewport({ scale })
      canvas.width = Math.max(1, Math.ceil(viewport.width))
      canvas.height = Math.max(1, Math.ceil(viewport.height))
      task = nativePage.render({ canvas, viewport })
      await task.promise
      if (active) { task = undefined; setDrawn(true) }
    }
    const observer = new IntersectionObserver(entries => {
      if (!active || !entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      void render().catch(() => { /* A page number still provides navigation. */ })
    }, { root: canvas.closest('.pdf-reader-sidebar'), rootMargin: '80px 0px' })
    observer.observe(canvas.parentElement!)
    return () => {
      active = false
      observer.disconnect()
      task?.cancel()
    }
  }, [open, page])
  return <span className="pdf-thumbnail-image" aria-hidden="true">
    {!drawn && <Icon name="file-text" size={16} />}
    <canvas ref={target} hidden={!drawn} />
  </span>
}
