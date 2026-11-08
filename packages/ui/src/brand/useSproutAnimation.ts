import { useEffect, useMemo, useRef } from 'react'
import type { SproutMotion, SproutTool } from './artwork'
import { blendPose, MOTION_DURATION, poseTransforms, REST, sampleMotion, staticPose } from './motion'
import type { RigPart, RigPose } from './motion'

interface Playback {
  motion: SproutMotion; tool: SproutTool; ready: boolean; replay: number
  previewTime?: number; speed: number; paused: boolean
}
/** One clock owns all acting channels, retains idle phase, blends interruptions, and sleeps offscreen. */
export function useSproutAnimation(playback: Playback) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const parts = useRef<Partial<Record<RigPart, SVGGElement>>>({})
  const latest = useRef(playback)
  latest.current = playback
  const wake = useRef<() => void>(() => {})
  const bind = useMemo(() => Object.fromEntries(Object.keys(poseTransforms(REST)).map(name => [name, (node: SVGGElement | null) => {
    if (node) parts.current[name as RigPart] = node
    else delete parts.current[name as RigPart]
  }])) as Record<RigPart, (node: SVGGElement | null) => void>, [])
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    let inView = true, raf = 0, disposed = false, lastNow: number | null = null
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    let staticStart: number | null = null, staticSpeed = 1
    let feedbackInterrupted = false
    let life = 0, elapsed = 0, transition = 220, from: RigPose = { ...REST }, current = { ...REST }
    let previousMotion = latest.current.motion, previousTool = latest.current.tool, previousReplay = latest.current.replay
    let queuedMotion = previousMotion, queuedReplay = previousReplay, queuedAt: number | null = null
    let equipStart: number | null = null
    let previousReduced = media.matches
    let previousSeek = latest.current.previewTime
    const written: Partial<Record<RigPart, string>> = {}
    const nodes: Partial<Record<RigPart, SVGGElement>> = {}
    function tick(now: number) {
      raf = 0
      if (disposed) return
      const options = latest.current
      // A tool change plays a 1s fetch-and-present flourish inside the same clock,
      // so props never pop in or out on a static pose. Reduced motion swaps instantly.
      const toolChanged = previousTool !== options.tool
      if (toolChanged && options.ready && !media.matches && options.previewTime === undefined && !options.paused) equipStart = now
      if (equipStart !== null && now - equipStart >= MOTION_DURATION.equip / Math.max(.01, options.speed)) equipStart = null
      const currentMotion: SproutMotion = equipStart !== null ? 'equip' : options.motion
      const finite = currentMotion === 'invite' || currentMotion === 'celebrate' || currentMotion === 'equip'
      const asleep = document.hidden || !inView
      if (staticStart !== null) {
        elapsed = Math.min(MOTION_DURATION[previousMotion], elapsed + Math.max(0, now - staticStart) * staticSpeed)
        staticStart = null
      }
      clearTimeout(settleTimer); settleTimer = undefined
      svg!.dataset.paused = String(asleep || options.paused)
      svg!.dataset.reducedMotion = String(media.matches)
      if (asleep) { feedbackInterrupted = finite && !options.paused && options.previewTime === undefined; lastNow = null; svg!.dataset.running = 'false'; return }
      const dt = lastNow === null ? 0 : Math.max(0, now - lastNow) * options.speed
      lastNow = now
      const restarted = previousMotion !== currentMotion || previousReplay !== options.replay
      if (restarted) {
        from = feedbackInterrupted ? { ...REST } : current; transition = 0
        elapsed = finite && queuedAt !== null ? Math.max(0, now - queuedAt) * options.speed : 0
        queuedAt = null
        previousMotion = currentMotion; previousReplay = options.replay
      } else if (toolChanged) { from = current; transition = 0 }
      previousTool = options.tool
      if (!restarted && previousSeek !== undefined && options.previewTime === undefined) {
        from = current; transition = 0; elapsed = previousSeek; life = previousSeek
      }
      previousSeek = options.previewTime
      if (previousReduced !== media.matches) { from = current; transition = 0; previousReduced = media.matches }
      if (!options.paused && options.previewTime === undefined && !media.matches) { life += dt; elapsed += dt; transition += dt }
      if (feedbackInterrupted) {
        if (finite && !restarted && !options.paused && options.previewTime === undefined) { elapsed = MOTION_DURATION[currentMotion]; from = { ...REST }; transition = 220 }
        feedbackInterrupted = false
      }
      const seek = options.previewTime
      const effectiveMotion = finite && (seek ?? elapsed) >= MOTION_DURATION[currentMotion] ? 'idle' : currentMotion
      const target = media.matches ? staticPose(effectiveMotion, options.tool) : sampleMotion(effectiveMotion, seek ?? elapsed, seek ?? life, options.tool)
      current = media.matches || seek !== undefined ? target : blendPose(from, target, transition / 220)
      const transforms = poseTransforms(current)
      for (const [name, value] of Object.entries(transforms)) {
        const part = name as RigPart
        const node = parts.current[part]
        if (node && (written[part] !== value || nodes[part] !== node || node.getAttribute('transform') !== value)) { node.setAttribute('transform', value); written[part] = value; nodes[part] = node }
      }
      svg!.dataset.animationTime = String(Math.round(seek ?? elapsed))
      svg!.dataset.motionState = effectiveMotion
      const running = options.ready && (effectiveMotion !== 'none' || transition < 220) && seek === undefined && !options.paused && !media.matches
      svg!.dataset.running = String(running)
      if (running) raf = requestAnimationFrame(tick)
      // Static feedback still has a lifetime. Reduced motion needs one timer,
      // not a frame loop or an indefinitely held greeting.
      else if (options.ready && media.matches && finite && effectiveMotion !== 'idle' && seek === undefined && !options.paused) {
        staticStart = now; staticSpeed = options.speed
        settleTimer = setTimeout(() => { elapsed = MOTION_DURATION[currentMotion]; staticStart = null; settleTimer = undefined; schedule() }, (MOTION_DURATION[currentMotion] - elapsed) / Math.max(.01, options.speed))
      }
    }
    function schedule() {
      if (disposed || raf) return
      lastNow = null
      raf = requestAnimationFrame(tick)
    }
    wake.current = () => {
      const options = latest.current
      if (queuedMotion !== options.motion || queuedReplay !== options.replay) {
        queuedAt = performance.now(); queuedMotion = options.motion; queuedReplay = options.replay
      }
      schedule()
    }
    const visibility = () => {
      if (document.hidden || !inView) {
        cancelAnimationFrame(raf); raf = 0; clearTimeout(settleTimer); settleTimer = undefined; staticStart = null; lastNow = null
        const options = latest.current
        feedbackInterrupted = (options.motion === 'invite' || options.motion === 'celebrate') && !options.paused && options.previewTime === undefined
        svg.dataset.paused = 'true'; svg.dataset.running = 'false'
      } else schedule()
    }
    const observer = new IntersectionObserver(entries => { inView = entries.some(entry => entry.isIntersecting); if (!inView) visibility(); else schedule() })
    observer.observe(svg)
    document.addEventListener('visibilitychange', visibility)
    media.addEventListener('change', schedule)
    schedule()
    return () => { disposed = true; cancelAnimationFrame(raf); clearTimeout(settleTimer); observer.disconnect(); document.removeEventListener('visibilitychange', visibility); media.removeEventListener('change', schedule); wake.current = () => {} }
  }, [])
  useEffect(() => { wake.current() })
  return { svgRef, bind }
}
