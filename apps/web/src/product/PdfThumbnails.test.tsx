// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PdfThumbnails } from './PdfThumbnails'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type ObservedEntry = { target: Element; isIntersecting: boolean }
let observerCallbacks: Array<(entries: ObservedEntry[]) => void> = []
let observedElements: Element[] = []

class FakeIntersectionObserver {
  private readonly callback: (entries: ObservedEntry[]) => void
  constructor(callback: (entries: ObservedEntry[]) => void) {
    this.callback = callback
    observerCallbacks.push(callback)
  }
  observe(target: Element) {
    observedElements.push(target)
  }
  disconnect() {
    observerCallbacks = observerCallbacks.filter(item => item !== this.callback)
  }
  unobserve() {}
  takeRecords() { return [] }
}

const originalObserver = globalThis.IntersectionObserver

function flushFrames() {
  return new Promise<void>(resolve => setTimeout(resolve, 20))
}

describe('PdfThumbnails', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    observerCallbacks = []
    observedElements = []
    globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    globalThis.IntersectionObserver = originalObserver
  })

  it('uses a button toggle, renders visible thumbnails sequentially, and reuses cache on reopen', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const getPageCalls: number[] = []
    const renderCalls: number[] = []

    const open = vi.fn(async () => ({
      engine: {} as never,
      document: {
        getPage: vi.fn(async (pageNumber: number) => {
          getPageCalls.push(pageNumber)
          return {
            getViewport: ({ scale }: { scale: number }) => ({ width: 200 * scale, height: 300 * scale }),
            render: () => {
              inFlight += 1
              maxInFlight = Math.max(maxInFlight, inFlight)
              renderCalls.push(pageNumber)
              return {
                promise: new Promise<void>(resolve => setTimeout(() => {
                  inFlight -= 1
                  resolve()
                }, 10)),
                cancel: () => {},
              }
            },
          }
        }),
      } as never,
    }))

    await act(async () => {
      root.render(
        <PdfThumbnails open={open} pageCount={3} page={1} enabled={true} visible={true} onNavigate={() => {}} />,
      )
    })

    const toggle = host.querySelector('button.pdf-thumbnails-toggle') as HTMLButtonElement | null
    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('nav[aria-label="PDF 页面缩略图"]')).toBeNull()

    await act(async () => {
      toggle!.click()
    })

    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    const nav = host.querySelector('nav[aria-label="PDF 页面缩略图"]')
    expect(nav).not.toBeNull()
    expect(observedElements).toHaveLength(3)

    await act(async () => {
      for (const callback of observerCallbacks) {
        callback(observedElements.map(target => ({ target, isIntersecting: true })))
      }
      await flushFrames()
      await flushFrames()
      await flushFrames()
      await flushFrames()
    })

    expect(maxInFlight).toBe(1)
    expect(renderCalls).toEqual([1, 2, 3])
    expect(nav!.querySelectorAll('canvas:not([hidden])')).toHaveLength(3)

    // Collapse unmounts the nav cleanly (in jsdom height is 0, so it unmounts synchronously).
    await act(async () => {
      toggle!.click()
    })
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('nav[aria-label="PDF 页面缩略图"]')).toBeNull()

    // Re-open reuses cached canvases without calling getPage or render again.
    const previousGetPageCount = getPageCalls.length
    const previousRenderCount = renderCalls.length
    await act(async () => {
      toggle!.click()
    })
    const reopenedNav = host.querySelector('nav[aria-label="PDF 页面缩略图"]')
    expect(reopenedNav).not.toBeNull()
    expect(reopenedNav!.querySelectorAll('canvas:not([hidden])')).toHaveLength(3)
    expect(getPageCalls).toHaveLength(previousGetPageCount)
    expect(renderCalls).toHaveLength(previousRenderCount)
  })
})
