import { useEffect, useMemo, useRef, useState } from 'react'

export interface SmoothStreamOptions {
  /** Normal completion drains the display buffer; stop/failure uses the default immediate flush. */
  drainOnComplete?: boolean
  /** Existing history (including a resumed partial answer) starts fully visible. */
  animateOnMount?: boolean
}
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
const frameMs = 1000 / 30
function boundaries(text: string) {
  const ends = [0]
  if (segmenter) for (const part of segmenter.segment(text)) ends.push(part.index + part.segment.length)
  else { let length = 0; for (const point of text) { length += point.length; ends.push(length) } }
  // A provider may split a surrogate pair or ZWJ sequence between text events.
  if (/[\uD800-\uDBFF\u200d]$/.test(text)) ends.pop()
  return ends
}
function floorIndex(ends: number[], offset: number) {
  let low = 0, high = ends.length - 1
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (ends[middle] <= offset) low = middle; else high = middle - 1 }
  return low
}

/** Bounded reveal for Astryx prose: segment once per received batch, render at most 30 times/s, sleep when caught up. */
export function useSmoothStreamText(text: string, live: boolean, options: SmoothStreamOptions = {}) {
  const animate = useRef(options.animateOnMount ?? live)
  const initial = (options.animateOnMount ?? live) ? 0 : text.length
  const [length, setLength] = useState(initial)
  const shown = useRef(initial), previous = useRef(text), clock = useRef(0)
  const [reduce, setReduce] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  if (previous.current !== text) {
    if (!text.startsWith(previous.current.slice(0, shown.current))) { shown.current = 0; setLength(0) }
    else if (text.length > previous.current.length) animate.current = true
    previous.current = text
  }
  const progressive = !reduce && (live || !!options.drainOnComplete && animate.current)
  const ends = useMemo(() => progressive ? boundaries(text) : [0, text.length], [text, progressive])
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const changed = () => setReduce(!!query?.matches)
    query?.addEventListener?.('change', changed)
    return () => query?.removeEventListener?.('change', changed)
  }, [])
  useEffect(() => {
    if (!progressive) { shown.current = text.length; setLength(text.length); return }
    let frame = 0
    const tick = (now: number) => {
      if (!clock.current) clock.current = now
      const elapsed = now - clock.current
      if (elapsed >= frameMs) {
        clock.current = now
        const index = floorIndex(ends, shown.current), remaining = ends.length - 1 - index
        const seconds = Math.min(elapsed, 100) / 1000
        const count = Math.ceil(Math.max(90 * seconds, remaining * seconds * 2.5))
        const next = ends[Math.min(ends.length - 1, index + count)]
        if (next !== shown.current) { shown.current = next; setLength(next) }
      }
      if (shown.current < ends[ends.length - 1]) frame = requestAnimationFrame(tick)
    }
    if (shown.current < ends[ends.length - 1]) frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [text, ends, progressive])
  return progressive ? text.slice(0, ends[floorIndex(ends, length)]) : text
}
