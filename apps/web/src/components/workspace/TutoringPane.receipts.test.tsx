// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { TutorMessageView, TUTOR_BODY_SELECTOR } from './TutoringPane'
import type { TutorMessage } from '../../workspace/tutoringStore'
import type { TutoringWorkspace } from '../../workspace/tutoringWorkspace'

it('legacy observer reports original action only for visible formal body pixels, never source-only or hidden content', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  const observations: Array<{ callback: IntersectionObserverCallback; target?: Element; disconnected: boolean }> = []
  vi.stubGlobal('IntersectionObserver', class {
    record: typeof observations[number]
    constructor(callback: IntersectionObserverCallback) { this.record = { callback, disconnected: false }; observations.push(this.record) }
    observe(target: Element) { this.record.target = target }
    unobserve() {}
    disconnect() { this.record.disconnected = true }
  })
  const rect = (height = 100) => ({ left: 0, top: 0, right: 300, bottom: height, width: 300, height, x: 0, y: 0, toJSON: () => ({}) })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => rect())
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [rect()] as unknown as DOMRectList)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const computed = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => new Proxy(computed(element), {
    get(target, key) { if (key === 'opacity') return target.opacity || '1'; return Reflect.get(target, key) },
  }))
  const outer = document.createElement('div'), host = document.createElement('div')
  outer.className = 'ws-chatpop'; host.className = 'ws-chatbody'; outer.append(host); document.body.append(outer)
  const root = createRoot(host), fact = vi.fn()
  const client = { context: { mode: 'real' }, fact, hdlSourceStatus: () => null } as unknown as TutoringWorkspace
  const message: TutorMessage = { epoch: 1, valid: true, shown: true, facts: {}, payload: {
    actionId: 'original-action', contentHash: 'a'.repeat(64), disposition: 'pending', createdAt: '', basisRevised: false, content: '真正获准正文',
  } }
  try {
    act(() => root.render(<TutorMessageView client={client} message={message} synchronized scroller={host} />))
    expect(observations).toHaveLength(1)
    const body = host.querySelector('[data-testid="tutor-message"]')!.querySelector(TUTOR_BODY_SELECTOR)!
    expect(observations[0].target).toBe(body)
    expect(body.textContent).toBe('真正获准正文')
    expect(fact).not.toHaveBeenCalled()
    const intersect = (height: number) => observations[0].callback([{ target: body, isIntersecting: true,
      intersectionRect: rect(height) } as IntersectionObserverEntry], {} as IntersectionObserver)
    intersect(0)
    expect(fact).not.toHaveBeenCalled()
    intersect(0.5)
    expect(fact.mock.calls).toEqual([['original-action', 'displayed']])
    ;(body as HTMLElement).style.display = 'none'
    intersect(100)
    expect(fact).toHaveBeenCalledTimes(1)
    act(() => root.render(<TutorMessageView client={client} message={{ ...message, valid: false }} synchronized scroller={host} />))
    expect(observations[0].disconnected).toBe(true)
    expect(observations).toHaveLength(1)
  } finally {
    act(() => root.unmount()); outer.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  }
})
