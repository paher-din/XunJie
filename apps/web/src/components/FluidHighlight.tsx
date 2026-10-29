import { useEffect, useRef } from 'react'
import type { ItemRect } from '../lib/fluidHover'

// 临界阻尼弹簧（质量 1），观感对齐 fluidfunctionalism 的 spring.fast：
// 快速、无回弹，中途改目标从当前位置接力，不播完再折返。
// 调快慢只动这两个数：STIFFNESS 越高越快，DAMPING ≈ 2·√STIFFNESS 保持临界阻尼。
const STIFFNESS = 1100
const DAMPING = 66

interface SpringState {
  x: number
  y: number
  w: number
  h: number
  vx: number
  vy: number
  vw: number
  vh: number
}

/**
 * 整组共享的 hover 高亮层：绝对定位在容器里，弹性滑向 activeIndex 对应的卡片。
 * 新一轮悬停（之前无高亮）时直接出现在目标位置淡入，不从上次位置飞过来；
 * 高亮消失只做快速淡出。prefers-reduced-motion 时取消滑动、保留淡入淡出。
 */
export function FluidHighlight({
  activeIndex,
  rects,
  className,
}: {
  activeIndex: number | null
  rects: readonly (ItemRect | undefined)[]
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const stateRef = useRef<SpringState | null>(null)
  const rafRef = useRef<number | null>(null)
  const visibleRef = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const target = activeIndex !== null ? rects[activeIndex] : undefined
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }

    if (!target) {
      visibleRef.current = false
      stateRef.current = null
      el.style.opacity = '0'
      return
    }

    const apply = (x: number, y: number, w: number, h: number) => {
      el.style.transform = `translate(${x}px, ${y}px)`
      el.style.width = w + 'px'
      el.style.height = h + 'px'
    }

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!visibleRef.current || reduce || !stateRef.current) {
      stateRef.current = {
        x: target.left,
        y: target.top,
        w: target.width,
        h: target.height,
        vx: 0,
        vy: 0,
        vw: 0,
        vh: 0,
      }
      apply(target.left, target.top, target.width, target.height)
      visibleRef.current = true
      el.style.opacity = '1'
      return
    }

    el.style.opacity = '1'
    let last = performance.now()
    const step = (now: number) => {
      const s = stateRef.current
      if (!s) return
      const dt = Math.min((now - last) / 1000, 0.032)
      last = now
      const targets = { x: target.left, y: target.top, w: target.width, h: target.height }
      for (const axis of ['x', 'y', 'w', 'h'] as const) {
        const v = ('v' + axis) as 'vx' | 'vy' | 'vw' | 'vh'
        const a = -STIFFNESS * (s[axis] - targets[axis]) - DAMPING * s[v]
        s[v] += a * dt
        s[axis] += s[v] * dt
      }
      apply(s.x, s.y, s.w, s.h)
      const settled = (['x', 'y', 'w', 'h'] as const).every((axis) => {
        const v = ('v' + axis) as 'vx' | 'vy' | 'vw' | 'vh'
        return Math.abs(s[axis] - targets[axis]) < 0.1 && Math.abs(s[v]) < 2
      })
      if (settled) {
        apply(targets.x, targets.y, targets.w, targets.h)
        stateRef.current = { ...targets, vx: 0, vy: 0, vw: 0, vh: 0 }
        rafRef.current = null
      } else {
        rafRef.current = requestAnimationFrame(step)
      }
    }
    rafRef.current = requestAnimationFrame(step)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [activeIndex, rects])

  return <div ref={ref} aria-hidden className={className} />
}
