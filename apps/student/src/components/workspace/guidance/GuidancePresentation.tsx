import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { CompanionButton } from '../../CompanionButton'
import type { CompanionCue } from '../../CompanionButton'
import type { SproutTool } from '../../../brand/artwork'
import { intersect, placeGuidance, validBounds } from './layout'
import type { Bounds } from './layout'
import './guidance.css'

export type GuidanceTarget = Element | (() => Element | Bounds | null)
export interface GuidanceAction { id: string; label: string; disabled?: boolean; primary?: boolean }
export interface GuidanceReceipt { presentationId: string; actionId: string; source: 'action' | 'companion' }
export interface GuidanceItem {
  /** A new logical presentation needs a new id, including replacement with new content. */
  id: string
  label?: string
  content: { kind: 'text'; text: string } | { kind: 'card'; title: string; body: ReactNode }
  target?: GuidanceTarget
  preferBelow?: boolean
  actions: readonly GuidanceAction[]
}
export interface GuidancePresentationProps {
  item: GuidanceItem
  state?: 'showing' | 'busy' | 'waiting' | 'quiet' | 'hidden'
  /** Caller-owned entry, e.g. reopen or open chat. No implicit teaching action. */
  companionAction?: GuidanceAction
  appearance?: { tool?: SproutTool; cue?: CompanionCue; attention?: boolean }
  onAction: (receipt: GuidanceReceipt) => void
}

function visibleBounds(element: Element, viewport: Bounds): Bounds | null {
  if (!element.isConnected || !element.getClientRects().length) return null
  let bounds = element.getBoundingClientRect() as Bounds
  if (!validBounds(bounds)) return null
  bounds = intersect(bounds, viewport)
  for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor)
    if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none' || Number(style.opacity) === 0 || ancestor.hasAttribute('inert') || ancestor.getAttribute('aria-hidden') === 'true') return null
    if (ancestor !== element) {
      const rect = ancestor.getBoundingClientRect()
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) bounds = intersect(bounds, { left: rect.left, width: rect.width, top: bounds.top, height: bounds.height })
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) bounds = intersect(bounds, { left: bounds.left, width: bounds.width, top: rect.top, height: rect.height })
    }
  }
  return validBounds(bounds) ? bounds : null
}

function resolveTarget(target: GuidanceTarget | undefined, bounds: Bounds): Bounds | null {
  try {
    const value = typeof target === 'function' ? target() : target
    if (!value) return null
    if (value instanceof Element) return visibleBounds(value, bounds)
    if (!validBounds(value)) return null
    const clipped = intersect(value, bounds)
    return validBounds(clipped) ? clipped : null
  } catch { return null }
}

/** Mount inside a positioned presentation area. Only this area intersecting the
 * visible viewport is used. The portal avoids ancestor transforms/overflow.
 * Card business callbacks remain the caller's responsibility; this layer owns
 * only its supplied actions. It never emits on animation, visibility or render. */
export function GuidancePresentation(props: GuidancePresentationProps) {
  if (props.state === 'hidden') return null
  return <VisibleGuidance key={props.item.id} {...props} />
}

function VisibleGuidance({ item, state = 'showing', companionAction, appearance, onAction }: GuidancePresentationProps) {
  const scope = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null)
  const headingId = useId()
  const current = useRef({ item, state, companionAction, onAction })
  const alive = useRef(false)
  const remeasure = useRef<() => void>(() => {})
  // Quiet/showing transitions invalidate a press begun in the preceding state.
  const epoch = useRef(0), previousState = useRef(state)
  const presses = useRef(new WeakMap<EventTarget, number>())
  const [layout, setLayout] = useState<ReturnType<typeof placeGuidance> & { anchored: boolean; available: boolean } | null>(null)
  useLayoutEffect(() => {
    current.current = { item, state, companionAction, onAction }
    if (previousState.current !== state) { epoch.current++; previousState.current = state }
    remeasure.current()
  })
  useLayoutEffect(() => {
    alive.current = true
    let raf = 0
    const measure = () => {
      cancelAnimationFrame(raf)
      if (!alive.current) return
      const view = window.visualViewport
      const viewport = { left: view?.offsetLeft ?? 0, top: view?.offsetTop ?? 0, width: view?.width ?? innerWidth, height: view?.height ?? innerHeight }
      const area = scope.current && visibleBounds(scope.current, viewport)
      if (area && panel.current) {
        const target = resolveTarget(current.current.item.target, area)
        // Set constraints before measuring, so reflowing long content stays inside the area.
        panel.current.style.maxWidth = `${Math.max(0, area.width - 24)}px`
        panel.current.style.maxHeight = `${Math.max(0, area.height - 24)}px`
        const rect = panel.current.getBoundingClientRect()
        const next = { ...placeGuidance(area, rect, target, current.current.item.preferBelow), anchored: !!target, available: area.width > 24 && area.height > 80 }
        setLayout(old => old && Object.keys(next).every(key => old[key as keyof typeof next] === next[key as keyof typeof next]) ? old : next)
      } else setLayout(old => old?.available === false ? old : { left: 0, top: 0, maxWidth: 0, maxHeight: 0, anchored: false, available: false })
      if (!document.hidden) raf = requestAnimationFrame(measure)
    }
    const visibility = () => { cancelAnimationFrame(raf); if (!document.hidden) measure() }
    remeasure.current = measure
    measure()
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    window.visualViewport?.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('scroll', measure)
    return () => {
      remeasure.current = () => {}; alive.current = false; epoch.current++
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
      window.visualViewport?.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('scroll', measure)
    }
  }, [])
  const begin = (event: SyntheticEvent) => { presses.current.set(event.currentTarget, epoch.current); event.stopPropagation() }
  const respond = (event: React.MouseEvent<HTMLButtonElement>, actionId: string, source: GuidanceReceipt['source']) => {
    event.stopPropagation()
    if (!alive.current || !event.currentTarget.isConnected) return
    const pressedAt = presses.current.get(event.currentTarget)
    presses.current.delete(event.currentTarget)
    if (pressedAt !== undefined && pressedAt !== epoch.current) return
    const now = current.current
    if (source === 'action' && now.state === 'quiet') return
    const action = source === 'companion' ? now.companionAction : now.item.actions.find(action => action.id === actionId)
    if (!action || action.id !== actionId || action.disabled) return
    now.onAction({ presentationId: item.id, actionId, source })
  }
  const rich = item.content.kind === 'card'
  const visible = layout?.available === true
  return <>
    <div ref={scope} className="guidance-scope" />
    {createPortal(<div ref={panel} className={`guidance-presentation${rich ? ' guidance-card' : ''}`}
      data-presentation-id={item.id} data-placement={layout?.anchored ? 'target' : 'rest'} data-state={state}
      style={{ left: layout?.left ?? 0, top: layout?.top ?? 0, maxWidth: layout?.maxWidth, maxHeight: layout?.maxHeight, visibility: visible ? 'visible' : 'hidden' }}
      onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      {state !== 'quiet' && <section className="guidance-bubble" aria-labelledby={headingId}>
        <div className="guidance-content" tabIndex={0} role="region" aria-label="引导内容">
          <div id={headingId} className="guidance-label">{item.label ?? '学习助手'}</div>
          {state === 'busy' && <div className="guidance-status" role="status">正在处理</div>}
          {state === 'waiting' && <div className="guidance-status" role="status">等待你的操作</div>}
          {item.content.kind === 'text' ? <div className="guidance-text">{item.content.text}</div> : <><strong className="guidance-title">{item.content.title}</strong>{item.content.body}</>}
        </div>
        {item.actions.length > 0 && <div className="guidance-actions">
          {item.actions.map(action => <button type="button" key={action.id} disabled={action.disabled}
            className={action.primary ? 'guidance-primary' : undefined} onPointerDown={begin} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') begin(event) }}
            onClick={event => respond(event, action.id, 'action')}>{action.label}</button>)}
        </div>}
      </section>}
      <CompanionButton className="guidance-companion" aria-label={companionAction?.label ?? '学习助手形象'}
        disabled={companionAction?.disabled} tabIndex={companionAction ? 0 : -1}
        aria-hidden={companionAction ? undefined : true} working={state === 'busy'} attention={appearance?.attention || state === 'waiting'}
        tool={appearance?.tool} cue={appearance?.cue}
        onPointerDown={begin} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') begin(event) }}
        onClick={event => { if (companionAction) respond(event, companionAction.id, 'companion') }} />
    </div>, document.body)}
  </>
}
