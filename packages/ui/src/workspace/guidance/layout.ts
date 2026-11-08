/** All geometry uses viewport CSS pixels; percentages belong to the caller. */
export interface Bounds { left: number; top: number; width: number; height: number }
export interface Point { x: number; y: number }
export const intersect = (a: Bounds, b: Bounds): Bounds => {
  const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top)
  return { left, top, width: Math.max(0, Math.min(a.left + a.width, b.left + b.width) - left),
    height: Math.max(0, Math.min(a.top + a.height, b.top + b.height) - top) }
}
export const validBounds = (r: Bounds) => [r.left, r.top, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(n, high))

export function placeGuidance(bounds: Bounds, size: { width: number; height: number }, target: Bounds | null, below = false) {
  const inset = 12, gap = 12
  const width = Math.max(0, bounds.width - inset * 2), height = Math.max(0, bounds.height - inset * 2)
  const w = Math.min(size.width, width), h = Math.min(size.height, height)
  let left = bounds.left + bounds.width - inset - w, top = bounds.top + bounds.height - inset - h
  if (target) {
    left = target.left + target.width / 2 - w / 2
    const above = target.top - gap - h, under = target.top + target.height + gap
    top = below ? under : above
    if (top < bounds.top + inset) top = under
    if (top + h > bounds.top + bounds.height - inset && above >= bounds.top + inset) top = above
  }
  return { left: clamp(left, bounds.left + inset, bounds.left + bounds.width - inset - w),
    top: clamp(top, bounds.top + inset, bounds.top + bounds.height - inset - h), maxWidth: width, maxHeight: height }
}
