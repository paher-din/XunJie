import { useEffect, useRef, type RefObject } from 'react'
import type { PdfPage } from '@xunjie/contracts/pdf-materials'
import type { RenderTask } from 'pdfjs-dist'
import type { usePdfReaderText } from './PdfReaderText'

const maxEdge = 4096
const maxPixels = 8 * 1024 * 1024

/** The screen can use more pixels than the fixed PNG retained for citations. */
export function PdfPagePreview({ open, page, image, frame }: {
  open: NonNullable<ReturnType<typeof usePdfReaderText>>
  page: PdfPage
  image: NonNullable<PdfPage['image']>
  frame: RefObject<HTMLDivElement | null>
}) {
  const preview = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const target = preview.current!, pageFrame = frame.current!
    const { rotation, cropBox } = page.transform
    const { width, height } = image
    const maxWidth = Math.floor(Math.min(maxEdge, maxEdge * width / height, Math.sqrt(maxPixels * width / height)))
    let requested = 0
    let generation = 0
    let timer: number | undefined
    let task: RenderTask | undefined

    const render = async (pixels: number, current: number) => {
      const source = await open()
      if (current !== generation) return
      const nativePage = await source.document.getPage(page.page)
      if (current !== generation || nativePage.view.length !== cropBox.length
        || !nativePage.view.every((coordinate, index) => coordinate === cropBox[index])) return
      const base = nativePage.getViewport({ scale: 1, rotation })
      const scale = Math.min(pixels / base.width, maxEdge / base.height, Math.sqrt(maxPixels / (base.width * base.height)))
      const viewport = nativePage.getViewport({ scale, rotation })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.floor(viewport.width))
      canvas.height = Math.max(1, Math.floor(viewport.height))
      task = nativePage.render({ canvas, viewport, background: 'rgb(255,255,255)' })
      await task.promise
      if (current === generation) { task = undefined; target.replaceChildren(canvas) }
    }

    const schedule = () => {
      const deviceWidth = pageFrame.getBoundingClientRect().width * window.devicePixelRatio
      const widthForScreen = Math.min(maxWidth, Math.ceil(deviceWidth / 128) * 128)
      const next = deviceWidth > width && widthForScreen > width ? widthForScreen : 0
      if (next === requested) return
      requested = next
      const current = ++generation
      window.clearTimeout(timer)
      task?.cancel()
      task = undefined
      if (!next) { target.replaceChildren(); return }
      // Keep a stable page visible while the slider is moving.
      timer = window.setTimeout(() => { void render(next, current).catch(() => {
        if (current === generation) { task = undefined; target.replaceChildren() }
      }) }, 120)
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
      target.replaceChildren()
    }
  }, [open, page, image, frame])
  return <div className="pdf-page-preview" aria-hidden="true" ref={preview} />
}
