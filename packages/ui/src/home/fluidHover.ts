import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/*
 * 2-D fluid hover：移植自 fluidfunctionalism 的 use-fluid-hover（docs/card 的
 * CardGroup 同款行为），去掉 framer-motion / Tailwind 依赖。
 * 规则：指针在某张卡内则该卡胜出；否则取中心离指针最近的卡——指针落在间隙、
 *  padding 或最后一行之外时高亮也不断线。间隙点击在阈值内路由到高亮卡。
 */

export interface ItemRect {
  top: number
  left: number
  width: number
  height: number
}

export function pickNearest(
  point: { x: number; y: number },
  rects: readonly (ItemRect | undefined)[],
  containerRect: { left: number; top: number },
): number | null {
  let closest: number | null = null
  let closestDist = Infinity
  let containing: number | null = null
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]
    if (!r) continue
    const left = containerRect.left + r.left
    const top = containerRect.top + r.top
    if (point.x >= left && point.x <= left + r.width && point.y >= top && point.y <= top + r.height) {
      containing = i
    }
    const d = Math.hypot(point.x - (left + r.width / 2), point.y - (top + r.height / 2))
    if (d < closestDist) {
      closestDist = d
      closest = i
    }
  }
  return containing ?? closest
}

export interface FluidHover {
  activeIndex: number | null
  itemRects: readonly (ItemRect | undefined)[]
  registerItem: (index: number, el: HTMLElement | null) => void
  handlers: {
    onMouseMove: (e: React.MouseEvent) => void
    onMouseLeave: () => void
    onClick: (e: React.MouseEvent) => void
  }
}

export function useFluidHover<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  { gapClickDistance = 16 }: { gapClickDistance?: number } = {},
): FluidHover {
  const itemsRef = useRef(new Map<number, HTMLElement>())
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const activeIndexRef = useRef<number | null>(null)
  activeIndexRef.current = activeIndex
  const [itemRects, setItemRects] = useState<readonly (ItemRect | undefined)[]>([])
  const rectsRef = useRef<readonly (ItemRect | undefined)[]>([])
  const measureRafRef = useRef<number | null>(null)
  const moveRafRef = useRef<number | null>(null)
  const itemRoRef = useRef<ResizeObserver | null>(null)

  // 子项是容器的直接子元素且容器 position:relative，offset* 即容器坐标系下的布局值，
  // 不受祖先 transform 影响。
  const runMeasurement = useCallback(() => {
    const container = containerRef.current
    if (!container) return false
    const rects: (ItemRect | undefined)[] = []
    let complete = true
    itemsRef.current.forEach((el, i) => {
      if (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0) {
        complete = false
        return
      }
      rects[i] = {
        top: el.offsetTop,
        left: el.offsetLeft,
        width: el.offsetWidth,
        height: el.offsetHeight,
      }
    })
    if (!complete) return false
    rectsRef.current = rects
    setItemRects(rects)
    return true
  }, [containerRef])

  const scheduleMeasurement = useCallback(
    (attemptsLeft = 3) => {
      if (measureRafRef.current !== null) cancelAnimationFrame(measureRafRef.current)
      measureRafRef.current = requestAnimationFrame(() => {
        measureRafRef.current = null
        if (!runMeasurement() && attemptsLeft > 1) scheduleMeasurement(attemptsLeft - 1)
      })
    },
    [runMeasurement],
  )

  const getItemRo = useCallback(() => {
    if (itemRoRef.current === null && typeof ResizeObserver !== 'undefined') {
      itemRoRef.current = new ResizeObserver(() => scheduleMeasurement())
    }
    return itemRoRef.current
  }, [scheduleMeasurement])

  const registerItem = useCallback(
    (index: number, el: HTMLElement | null) => {
      if (el) {
        itemsRef.current.set(index, el)
        getItemRo()?.observe(el)
      } else {
        const prev = itemsRef.current.get(index)
        if (prev) itemRoRef.current?.unobserve(prev)
        itemsRef.current.delete(index)
        if (index === activeIndexRef.current) setActiveIndex(null)
      }
      scheduleMeasurement()
    },
    [getItemRo, scheduleMeasurement],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const { clientX, clientY } = e
      if (moveRafRef.current !== null) cancelAnimationFrame(moveRafRef.current)
      moveRafRef.current = requestAnimationFrame(() => {
        moveRafRef.current = null
        const container = containerRef.current
        if (!container) return
        const cr = container.getBoundingClientRect()
        setActiveIndex(
          pickNearest({ x: clientX, y: clientY }, rectsRef.current, { left: cr.left, top: cr.top }),
        )
      })
    },
    [containerRef],
  )

  const handleMouseLeave = useCallback(() => {
    if (moveRafRef.current !== null) {
      cancelAnimationFrame(moveRafRef.current)
      moveRafRef.current = null
    }
    setActiveIndex(null)
  }, [])

  // 间隙点击路由：落在卡与卡之间的点击（阈值距离内）触发高亮卡，所见即所点。
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as Node | null
      if (!target || !target.isConnected) return
      for (const el of itemsRef.current.values()) {
        if (el.contains(target)) return
      }
      if ((target as Element).closest?.('button, a, input, [role="button"]')) return
      const index = activeIndexRef.current
      if (index === null) return
      const el = itemsRef.current.get(index)
      if (!el) return
      const r = el.getBoundingClientRect()
      const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right)
      const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom)
      if (Math.hypot(dx, dy) > gapClickDistance) return
      el.click()
    },
    [gapClickDistance],
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => scheduleMeasurement())
    ro.observe(container)
    return () => ro.disconnect()
  }, [containerRef, scheduleMeasurement])

  useEffect(
    () => () => {
      if (measureRafRef.current !== null) cancelAnimationFrame(measureRafRef.current)
      if (moveRafRef.current !== null) cancelAnimationFrame(moveRafRef.current)
      itemRoRef.current?.disconnect()
      itemRoRef.current = null
    },
    [],
  )

  return {
    activeIndex,
    itemRects,
    registerItem,
    handlers: {
      onMouseMove: handleMouseMove,
      onMouseLeave: handleMouseLeave,
      onClick: handleClick,
    },
  }
}

export function useRegisterFluidHoverItem(
  registerItem: ((index: number, el: HTMLElement | null) => void) | undefined,
  index: number,
  ref: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!registerItem) return
    registerItem(index, ref.current)
    return () => registerItem(index, null)
  }, [index, registerItem, ref])
}
