import { useEffect, useRef } from 'react'
import { Icon } from '../icons'

// Adapted from Kubai Icons' line motion runtime (MIT):
// https://github.com/kubai087/kubai-icons/blob/main/packages/core/src/line-motion.js
// The `send` motion uses the `keys` effect: the plane shrinks and flies out, then
// returns from the opposite corner once the feedback is sent.
const TAU = Math.PI * 2
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))
const fixed = (value: number) => +value.toFixed(3)
const easeOut = (u: number) => 1 - (1 - clamp(u)) ** 3
const inOut = (u: number) => {
  u = clamp(u)
  return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2
}
const settle = (t: number, hz = 2.2, damping = 0.55) => {
  if (t <= 0) return 1
  const w = TAU * hz
  const wd = w * Math.sqrt(1 - damping * damping)
  return Math.exp(-damping * w * t) * (Math.cos(wd * t) + (damping * w / wd) * Math.sin(wd * t))
}

const KEYS = {
  x: [3.5, -3.5],
  y: [-3.5, 3.5],
  scale: [0.62, 0.62],
  alpha: [0, 0],
}
const GO = 640
export const SEND_MOTION_DURATION = GO + 420
const SPAN = SEND_MOTION_DURATION
const SEGMENT = GO / KEYS.x.length

type Pose = { x: number; y: number; scale: number; alpha: number }

function poseAt(t: number): Pose {
  if (t <= 0) return { x: 0, y: 0, scale: 1, alpha: 1 }
  if (t < GO) {
    const index = Math.min(KEYS.x.length - 1, Math.floor(t / SEGMENT))
    const u = (t - index * SEGMENT) / SEGMENT
    const ease = index === 0 ? easeOut(u) : inOut(u)
    const from = index === 0
      ? { x: 0, y: 0, scale: 1, alpha: 1 }
      : { x: KEYS.x[index - 1], y: KEYS.y[index - 1], scale: KEYS.scale[index - 1], alpha: KEYS.alpha[index - 1] }
    const to = {
      x: KEYS.x[index], y: KEYS.y[index],
      scale: KEYS.scale[index], alpha: KEYS.alpha[index],
    }
    return {
      x: from.x + (to.x - from.x) * ease,
      y: from.y + (to.y - from.y) * ease,
      scale: from.scale + (to.scale - from.scale) * ease,
      alpha: from.alpha + (to.alpha - from.alpha) * ease,
    }
  }
  const home = settle((t - GO) / 1000)
  const last = KEYS.x.length - 1
  return {
    x: KEYS.x[last] * home,
    y: KEYS.y[last] * home,
    scale: 1 + (KEYS.scale[last] - 1) * home,
    alpha: KEYS.alpha[last] + (1 - KEYS.alpha[last]) * easeOut((t - GO) / 252),
  }
}

function applyPose(svg: SVGSVGElement, pose: Pose) {
  const layer = svg.querySelector<SVGGElement>('[data-l="all"]')
  if (!layer) return
  layer.setAttribute('transform', `translate(${fixed(pose.x + 12)} ${fixed(pose.y + 12)}) rotate(0) scale(${fixed(pose.scale)}) translate(-12 -12)`)
  layer.setAttribute('opacity', String(fixed(clamp(pose.alpha))))
}

function restPose(svg: SVGSVGElement) {
  const layer = svg.querySelector<SVGGElement>('[data-l="all"]')
  layer?.removeAttribute('transform')
  layer?.removeAttribute('opacity')
}

export function AnimatedSendIcon({ playKey, resetKey = 0, size = 14 }: { playKey: number; resetKey?: number; size?: number }) {
  const host = useRef<HTMLSpanElement>(null)
  const lastPlayKey = useRef(playKey)
  const lastResetKey = useRef(resetKey)

  useEffect(() => {
    const svg = host.current?.querySelector<SVGSVGElement>('svg')
    if (!svg) return
    const resetChanged = resetKey !== lastResetKey.current
    const playChanged = playKey !== lastPlayKey.current
    lastResetKey.current = resetKey
    lastPlayKey.current = playKey
    if (resetChanged) restPose(svg)
    if (!playChanged) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      restPose(svg)
      return
    }
    let frame = 0
    const started = performance.now()
    const paint = (now: number) => {
      const elapsed = now - started
      if (elapsed >= SPAN) {
        restPose(svg)
        return
      }
      applyPose(svg, poseAt(elapsed))
      frame = requestAnimationFrame(paint)
    }
    frame = requestAnimationFrame(paint)
    return () => {
      cancelAnimationFrame(frame)
      restPose(svg)
    }
  }, [playKey, resetKey])

  return <span ref={host} className="t-send-icon"><Icon name="send" size={size} /></span>
}
