import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { poseTransforms, sampleMotion } from './motion'
import type { RigPart } from './motion'
import { useSproutAnimation } from './useSproutAnimation'

type Effect = () => void | (() => void)
type Deps = readonly unknown[] | undefined
type Playback = Parameters<typeof useSproutAnimation>[0]

// Preserve ref/memo identity and effect lifetimes across renders. Only React's
// dispatcher is mocked; the real Hook and motion sampler execute unchanged.
const react = vi.hoisted(() => ({
  dispatcher: undefined as undefined | {
    useRef: (initial: unknown) => unknown
    useMemo: (factory: () => unknown, deps: Deps) => unknown
    useEffect: (effect: Effect, deps: Deps) => void
  },
}))
vi.mock('react', () => ({
  useRef: (initial: unknown) => react.dispatcher!.useRef(initial),
  useMemo: (factory: () => unknown, deps?: Deps) => react.dispatcher!.useMemo(factory, deps),
  useEffect: (effect: Effect, deps?: Deps) => react.dispatcher!.useEffect(effect, deps),
}))

class ElementStub {
  dataset: Record<string, string> = {}
  private attributes = new Map<string, string>()
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
}
class DocumentStub extends EventTarget {
  hidden = false
  get visibilityState() { return this.hidden ? 'hidden' : 'visible' }
}
class MediaStub extends EventTarget {
  constructor(public matches: boolean) { super() }
}

function sameDeps(a: Deps, b: Deps) {
  return a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
}

let disposeHarness: (() => void) | undefined

function mountPlayback(initial: Partial<Playback> = {}, reduced = false) {
  const svg = new ElementStub()
  const document = new DocumentStub()
  const media = new MediaStub(reduced)
  const nodes = new Map<RigPart, ElementStub>()
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  let observerCallback: IntersectionObserverCallback
  const slots = new Map<number, unknown>()
  const effects = new Map<number, { deps: Deps; cleanup?: () => void }>()
  let cursor = 0
  let pendingEffects: Array<() => void> = []
  let mounted = false
  let options: Playback = { motion: 'idle', tool: 'none', ready: true, replay: 0, speed: 1, paused: false, ...initial }

  vi.stubGlobal('document', document)
  vi.stubGlobal('matchMedia', () => media)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { observerCallback = callback }
    observe() {}
    disconnect() {}
  })

  const dispatcher = {
    useRef(initialValue: unknown) {
      const slot = cursor++
      if (!slots.has(slot)) slots.set(slot, { current: initialValue })
      return slots.get(slot)
    },
    useMemo(factory: () => unknown, deps: Deps) {
      const slot = cursor++
      const previous = slots.get(slot) as { deps: Deps; value: unknown } | undefined
      if (!previous || !sameDeps(previous.deps, deps)) slots.set(slot, { deps, value: factory() })
      return (slots.get(slot) as { value: unknown }).value
    },
    useEffect(effect: Effect, deps: Deps) {
      const slot = cursor++
      const previous = effects.get(slot)
      if (!previous || !sameDeps(previous.deps, deps)) pendingEffects.push(() => {
        previous?.cleanup?.()
        const cleanup = effect()
        effects.set(slot, { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined })
      })
    },
  }

  function render(patch: Partial<Playback> = {}) {
    options = { ...options, ...patch }
    cursor = 0
    pendingEffects = []
    react.dispatcher = dispatcher
    let instance: ReturnType<typeof useSproutAnimation>
    try { instance = useSproutAnimation(options) }
    finally { react.dispatcher = undefined }
    instance.svgRef.current = svg as unknown as SVGSVGElement
    if (!mounted) {
      for (const [part, bind] of Object.entries(instance.bind)) {
        const node = new ElementStub()
        nodes.set(part as RigPart, node)
        bind(node as unknown as SVGGElement)
      }
      mounted = true
    }
    for (const effect of pendingEffects) effect()
  }

  function frame() {
    // Requests made inside a frame run on the next frame, as in the browser.
    const scheduled = [...frames.values()]
    frames.clear()
    for (const callback of scheduled) callback(performance.now())
  }
  function advance(ms: number, paint = true) {
    vi.advanceTimersByTime(ms)
    if (paint) frame()
  }
  function hidden(value: boolean) {
    document.hidden = value
    document.dispatchEvent(new Event('visibilitychange'))
  }
  function inView(value: boolean) {
    observerCallback([{ isIntersecting: value, target: svg } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
  }
  function transform(part: RigPart) {
    const value = nodes.get(part)?.getAttribute('transform')
    if (!value) throw new Error(`No rendered transform for ${part}`)
    return value
  }
  function rotation(part: RigPart) {
    const match = transform(part).match(/rotate\(([-\d.]+)/)
    if (!match) throw new Error(`No rotation in ${part}`)
    return Number(match[1])
  }
  function lift() {
    const match = transform('root').match(/^translate\(0 ([-\d.]+)\)/)
    if (!match) throw new Error('No root lift')
    return Number(match[1])
  }
  function snapshot() { return Object.fromEntries([...nodes.keys()].map(part => [part, transform(part)])) }
  function dispose() {
    for (const effect of effects.values()) effect.cleanup?.()
    effects.clear()
  }
  disposeHarness = dispose
  render()
  return { svg, render, frame, advance, hidden, inView, transform, rotation, lift, snapshot, pendingFrames: () => frames.size }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
})
afterEach(() => {
  disposeHarness?.()
  disposeHarness = undefined
  react.dispatcher = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const sleepSurfaces = ['hidden', 'offscreen'] as const
function sleep(h: ReturnType<typeof mountPlayback>, surface: typeof sleepSurfaces[number], value: boolean) {
  if (surface === 'hidden') h.hidden(value)
  else h.inView(!value)
}
function expectSample(h: ReturnType<typeof mountPlayback>, motion: Playback['motion'], elapsed: number, life: number) {
  // The sampler is the oracle for the state/time chosen by the actual Hook;
  // assertions inspect the transforms written to visible nodes, not its locals.
  const expected = poseTransforms(sampleMotion(motion, elapsed, life, 'none'))
  for (const part of ['root', 'torso', 'leafLeft', 'leafRight', 'handRight'] as const) expect(h.transform(part), part).toBe(expected[part])
}

describe('sprout playback: hidden and offscreen recovery', () => {
  it.each(sleepSurfaces)('cancels an airborne feedback on %s and returns grounded without replaying it', surface => {
    const h = mountPlayback({ motion: 'celebrate' })
    h.frame()
    h.advance(420)
    expect(h.lift()).toBeLessThan(-100)
    const airborne = h.snapshot()
    sleep(h, surface, true)
    expect(h.pendingFrames()).toBe(0)
    expect(h.svg.dataset.running).toBe('false')
    h.advance(10_000, false)
    expect(h.snapshot()).toEqual(airborne)
    expect(h.pendingFrames()).toBe(0)
    sleep(h, surface, false)
    h.frame()
    expect(h.svg.dataset.motionState).toBe('idle')
    expect(h.lift()).toBe(0)
    expectSample(h, 'idle', 1660, 420)
    h.advance(300)
    expect(h.svg.dataset.motionState).toBe('idle')
    expect(h.lift()).toBe(0)
    expect(h.pendingFrames()).toBe(1)
  })

  it.each(sleepSurfaces)('pauses the base idle phase while %s rather than catching up its leaf gesture', surface => {
    const h = mountPlayback()
    h.frame()
    h.advance(1340)
    expect(h.rotation('leafLeft')).toBeLessThan(-3)
    const pose = h.snapshot()
    sleep(h, surface, true)
    h.advance(10_000, false)
    expect(h.pendingFrames()).toBe(0)
    sleep(h, surface, false)
    h.frame()
    expect(h.snapshot()).toEqual(pose)
    h.advance(80)
    expectSample(h, 'idle', 1420, 1420)
  })

  it.each(sleepSurfaces)('retains an explicitly paused inspection pose across %s', surface => {
    const h = mountPlayback({ motion: 'celebrate' })
    h.frame()
    h.advance(420)
    h.render({ paused: true })
    h.frame()
    const pose = h.snapshot()
    expect(h.lift()).toBeLessThan(-100)
    sleep(h, surface, true)
    h.advance(10_000, false)
    sleep(h, surface, false)
    h.frame()
    expect(h.snapshot()).toEqual(pose)
    expect(h.svg.dataset.animationTime).toBe('420')
    expect(h.pendingFrames()).toBe(0)
  })

  it('starts a new offscreen request at its queued age, while preserving the paused base clock', () => {
    const h = mountPlayback()
    h.frame()
    h.inView(false)
    h.render({ motion: 'invite', replay: 1 })
    h.frame()
    expect(h.pendingFrames()).toBe(0)
    h.advance(100, false)
    h.inView(true)
    h.frame()
    expect(h.svg.dataset.motionState).toBe('invite')
    expect(h.svg.dataset.animationTime).toBe('100')
    expect(h.lift()).toBe(0)
    h.advance(220)
    expect(h.rotation('handRight')).toBeLessThan(-20)
    expectSample(h, 'invite', 320, 220)
  })

  it('drops a new offscreen request that has already outlived its feedback window', () => {
    const h = mountPlayback()
    h.frame()
    h.inView(false)
    h.render({ motion: 'celebrate', replay: 1 })
    h.frame()
    h.advance(3000, false)
    expect(h.pendingFrames()).toBe(0)
    h.inView(true)
    h.frame()
    expect(h.svg.dataset.motionState).toBe('idle')
    expect(h.lift()).toBe(0)
    h.advance(220)
    expect(h.lift()).toBe(0)
    expectSample(h, 'idle', 3220, 220)
  })
})

describe('sprout playback: finite completion and reduced motion', () => {
  it.each(['invite', 'celebrate'] as const)('renders the real idle leaf gesture after %s completes', motion => {
    const h = mountPlayback({ motion })
    h.frame()
    h.advance(1800)
    expect(h.svg.dataset.motionState).toBe('idle')
    expect(h.lift()).toBe(0)
    h.advance(12_050)
    expect(h.rotation('leafRight')).toBeGreaterThan(8)
    expectSample(h, 'idle', 13_850, 13_850)
    expect(h.pendingFrames()).toBe(1)
  })

  it.each([['invite', 1600], ['celebrate', 1660]] as const)('holds reduced-motion %s for %i ms with one timer and no continuous RAF', (motion, duration) => {
    const h = mountPlayback({ motion }, true)
    h.frame()
    const pose = h.snapshot()
    expect(h.svg.dataset.motionState).toBe(motion)
    expect(h.lift()).toBe(0)
    expect(h.rotation('handRight')).toBeLessThan(0)
    expect(h.pendingFrames()).toBe(0)
    expect(vi.getTimerCount()).toBe(1)
    h.advance(duration - 1, false)
    expect(h.snapshot()).toEqual(pose)
    expect(h.svg.dataset.motionState).toBe(motion)
    expect(h.pendingFrames()).toBe(0)
    h.advance(1)
    expect(h.svg.dataset.motionState).toBe('idle')
    expect(h.rotation('handRight')).toBe(0)
    expect(h.rotation('leafRight')).toBe(0)
    expect(h.lift()).toBe(0)
    expect(h.pendingFrames()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([['invite', 1600], ['celebrate', 1660]] as const)('does not extend reduced-motion %s when controls rerender it', (motion, duration) => {
    const h = mountPlayback({ motion }, true)
    h.frame()
    h.advance(500, false)
    h.render({ tool: 'chalk' })
    h.frame()
    expect(h.svg.dataset.motionState).toBe(motion)
    expect(h.pendingFrames()).toBe(0)
    expect(vi.getTimerCount()).toBe(1)
    h.advance(500, false)
    h.render()
    h.frame()
    h.advance(duration - 1001, false)
    expect(h.svg.dataset.motionState).toBe(motion)
    expect(h.pendingFrames()).toBe(0)
    h.advance(1)
    expect(h.svg.dataset.motionState).toBe('idle')
    expect(h.rotation('handRight')).toBe(0)
    expect(h.pendingFrames()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('sprout playback: seeking and visible time', () => {
  it.each([['celebrate', 420], ['idle', 1340]] as const)('continues %s from a sought pose without snapping or resetting the base phase', (motion, seek) => {
    const h = mountPlayback({ motion, previewTime: seek })
    h.frame()
    const pose = h.snapshot()
    expect(h.pendingFrames()).toBe(0)
    h.render({ previewTime: undefined })
    h.frame()
    expect(h.snapshot()).toEqual(pose)
    expect(h.svg.dataset.animationTime).toBe(String(seek))
    h.advance(110)
    if (motion === 'celebrate') expect(h.lift()).toBeLessThan(-40)
    h.advance(110)
    expectSample(h, motion, seek + 220, seek + 220)
    expect(h.svg.dataset.animationTime).toBe(String(seek + 220))
    expect(h.pendingFrames()).toBe(1)
  })

  it.each(['replay', 'motion'] as const)('gives an explicit %s request priority over the preview being exited', request => {
    const h = mountPlayback({ motion: 'celebrate', previewTime: 420 })
    h.frame()
    const pose = h.snapshot()
    const motion = request === 'motion' ? 'invite' : 'celebrate'
    h.render({ motion, replay: request === 'replay' ? 1 : 0, previewTime: undefined })
    h.frame()
    expect(h.svg.dataset.animationTime).toBe('0')
    expect(h.svg.dataset.motionState).toBe(motion)
    expect(h.snapshot()).toEqual(pose)
    h.advance(110)
    expect(h.lift()).toBeLessThan(-40)
    h.advance(110)
    expect(h.svg.dataset.animationTime).toBe('220')
    expectSample(h, motion, 220, 220)
  })

  it('advances by actual visible time through sparse frames rather than stretching a feedback', () => {
    const h = mountPlayback({ motion: 'celebrate' })
    h.frame()
    for (let t = 100; t <= 400; t += 100) h.advance(100)
    expect(h.svg.dataset.animationTime).toBe('400')
    expect(h.lift()).toBeLessThan(-100)
    // A visible main-thread stall crosses the feedback deadline in one frame.
    h.advance(1300)
    expect(h.svg.dataset.animationTime).toBe('1700')
    expect(h.svg.dataset.motionState).toBe('idle')
    expect(h.lift()).toBe(0)
    expectSample(h, 'idle', 1700, 1700)
  })
})
