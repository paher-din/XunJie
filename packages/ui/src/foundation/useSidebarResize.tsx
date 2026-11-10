// Adapted from Astryx ResizeHandle / resizeGesture, @astryxdesign/core 0.7.11.
// Copyright (c) Meta Platforms, Inc. and affiliates. MIT; see THIRD_PARTY_NOTICES.md.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject, type TransitionEvent } from 'react'
import './sidebar-resize.css'

const DEFAULT_WIDTH = 248
const MIN_WIDTH = 152
const MAX_WIDTH = 360
const COLLAPSE_AT = 96
const EXPAND_AT = 112
const RAIL_WIDTH = 60
const clamp = (width: number, max: number) => Math.max(MIN_WIDTH, Math.min(max, width))

interface Drag {
  pointerId: number
  startX: number
  startSize: number
  expandedWidth: number
  wasCollapsed: boolean
  collapsed: boolean
  size: number
  moved: boolean
  target: HTMLButtonElement
}

/** Astryx's pill, pointer capture and splitter keys adapted to the existing 60px rail. */
export function useSidebarResize(containerRef: RefObject<HTMLDivElement | null>, collapsed: boolean,
  immersive: boolean, onCollapsedChange?: (collapsed: boolean) => void) {
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [maxWidth, setMaxWidth] = useState(MAX_WIDTH)
  const [resizing, setResizing] = useState(false)
  const [snapping, setSnapping] = useState(false)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const drag = useRef<Drag | null>(null)
  const pointerGestures = useRef({ previousDragged: false, currentDragged: false })
  const collapseChange = useRef(onCollapsedChange)
  collapseChange.current = onCollapsedChange
  const maximum = useRef(maxWidth)
  maximum.current = maxWidth
  const enabled = !!onCollapsedChange && !immersive
  const visibleWidth = Math.min(width, maxWidth)
  const edge = immersive ? 0 : Math.min(dragWidth ?? (collapsed ? RAIL_WIDTH : visibleWidth), maxWidth)
  const openness = Math.max(0, Math.min(1, (edge - RAIL_WIDTH) / (MIN_WIDTH - RAIL_WIDTH)))

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container || !enabled) return
    // Keep navigation below 40% of its shell, with enough room for its controls.
    const measure = () => setMaxWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(container.clientWidth * 0.4))))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef, enabled])

  const finish = useCallback((outcome: 'commit' | 'revert') => {
    const active = drag.current
    if (!active) return
    // Clear before releasing capture: lostpointercapture must not cancel a completed drag.
    drag.current = null
    active.target.ownerDocument.documentElement.classList.remove('xj-sidebar-resizing')
    if (active.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId)
    setResizing(false)
    setSnapping(false)
    setDragWidth(null)
    if (outcome === 'revert') {
      setWidth(active.expandedWidth)
      collapseChange.current?.(active.wasCollapsed)
    } else if (active.moved) {
      // Keep the state reached while holding the pointer, including its hysteresis zone.
      const shouldCollapse = active.collapsed
      setWidth(shouldCollapse ? active.expandedWidth : clamp(active.size, maximum.current))
      collapseChange.current?.(shouldCollapse)
    }
  }, [])

  // Capture loss, browser cancellation and leaving the surface end a gesture;
  // only an explicit Escape means the user wants to undo it.
  useEffect(() => () => finish('commit'), [enabled, finish])

  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    const next = active.startSize + event.clientX - active.startX
    if (Math.abs(event.clientX - active.startX) > 1) active.moved = true
    if (!active.moved) return
    pointerGestures.current.currentDragged = true
    active.size = Math.max(RAIL_WIDTH, Math.min(maxWidth, next))
    if (!active.collapsed && active.size <= COLLAPSE_AT) {
      active.collapsed = true
      setSnapping(true)
      onCollapsedChange?.(true)
    } else if (active.collapsed && active.size >= EXPAND_AT) {
      active.collapsed = false
      setSnapping(true)
      onCollapsedChange?.(false)
    }
    // Apply the same bounds while painting and committing, so release cannot
    // reveal a different width from the one already shown under the pointer.
    setDragWidth(active.collapsed ? RAIL_WIDTH : clamp(active.size, maxWidth))
  }

  const onTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && event.propertyName === '--sidebar-edge') setSnapping(false)
  }

  const handle = enabled && <button type="button" className="sidebar-resize-handle" role="separator"
    aria-label="调整侧栏宽度" aria-orientation="vertical"
    aria-valuemin={RAIL_WIDTH} aria-valuemax={maxWidth} aria-valuenow={Math.round(edge)}
    aria-valuetext={!resizing && collapsed ? '侧栏已收起' : `侧栏宽度 ${Math.round(edge)} 像素`}
    title="拖动调整宽度，双击收起或展开"
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary || drag.current) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      pointerGestures.current = { previousDragged: pointerGestures.current.currentDragged, currentDragged: false }
      // A press may interrupt the toggle animation; track the edge under the hand.
      const handleRect = event.currentTarget.getBoundingClientRect()
      const shellLeft = containerRef.current?.getBoundingClientRect().left ?? 0
      const startSize = handleRect.left + handleRect.width / 2 - shellLeft
      drag.current = { pointerId: event.pointerId, startX: event.clientX,
        startSize, expandedWidth: width, size: startSize, moved: false,
        wasCollapsed: collapsed, collapsed, target: event.currentTarget }
      setDragWidth(startSize)
      setSnapping(false)
      event.currentTarget.ownerDocument.documentElement.classList.add('xj-sidebar-resizing')
      setResizing(true)
    }}
    onPointerMove={move}
    onPointerUp={event => {
      if (drag.current?.pointerId !== event.pointerId) return
      move(event)
      finish('commit')
    }}
    onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) finish('commit') }}
    onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) finish('commit') }}
    onDoubleClick={event => {
      if (pointerGestures.current.previousDragged || pointerGestures.current.currentDragged) {
        event.preventDefault()
        return
      }
      onCollapsedChange?.(!collapsed)
    }}
    onKeyDown={event => {
      const step = event.shiftKey ? 50 : 10
      switch (event.key) {
        case 'ArrowLeft':
          if (!collapsed) {
            if (visibleWidth <= MIN_WIDTH) onCollapsedChange?.(true)
            else setWidth(clamp(visibleWidth - step, maxWidth))
          }
          break
        case 'ArrowRight':
          if (collapsed) onCollapsedChange?.(false)
          else setWidth(clamp(visibleWidth + step, maxWidth))
          break
        case 'Home': onCollapsedChange?.(true); break
        case 'End': setWidth(maxWidth); onCollapsedChange?.(false); break
        case 'Enter': onCollapsedChange?.(!collapsed); break
        case 'Escape': if (drag.current) finish('revert'); else return; break
        default: return
      }
      event.preventDefault()
    }}><span className="sidebar-resize-pill" aria-hidden="true" /></button>

  return { width: visibleWidth, minWidth: MIN_WIDTH, edge, openness, resizing, snapping, onTransitionEnd, handle }
}
