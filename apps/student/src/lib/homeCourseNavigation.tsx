import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'

type ReturnPoint = { top: number; courseId: string; keyboard: boolean }
type FocusTarget = { kind: 'heading' } | { kind: 'course'; courseId: string }
type Entry = { top: number; origin?: ReturnPoint; focus?: FocusTarget }
type Pending = { courseId: string | null; origin?: ReturnPoint; keyboard: boolean }
type Memory = { entries: Map<string, Entry>; pending?: Pending }

const HomeNavigationContext = createContext<Memory | null>(null)

/** Lives with the shell, so a task round trip retains each home history entry. */
export function HomeNavigationProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const memory = useMemo<Memory>(() => ({ entries: new Map() }), [scope])
  return <HomeNavigationContext value={memory}>{children}</HomeNavigationContext>
}

// Layout offsets exclude page-enter transforms, which must not shift the scroll target.
function layoutTop(element: HTMLElement): number {
  let top = 0
  for (let node: HTMLElement | null = element; node; node = node.offsetParent as HTMLElement | null) {
    top += node.offsetTop
  }
  return top
}

export function useHomeCourseNavigation(courseId: string | null, ready: boolean) {
  const context = useContext(HomeNavigationContext)
  if (!context) throw new Error('HomeNavigationProvider is required')
  const memory = context
  const location = useLocation()
  const [, setSearchParams] = useSearchParams()
  const regionRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useLayoutEffect(() => {
    const region = regionRef.current
    const heading = headingRef.current
    const main = region?.closest<HTMLElement>('.main')
    if (!ready || !region || !heading || !main) return

    const pending = memory.pending?.courseId === courseId ? memory.pending : undefined
    memory.pending = undefined
    let entry = memory.entries.get(location.key)
    const isNewEntry = !entry
    const headingTop = () => Math.max(0, layoutTop(heading) - layoutTop(main) - main.clientTop - 24)
    if (!entry) {
      entry = {
        top: courseId ? headingTop() : pending?.origin?.top ?? 0,
        origin: pending?.origin,
        focus: pending?.keyboard
          ? courseId ? { kind: 'heading' }
            : pending.origin ? { kind: 'course', courseId: pending.origin.courseId } : undefined
          : undefined,
      }
      memory.entries.set(location.key, entry)
    }
    const focus = entry.focus
    const target = focus?.kind === 'heading' ? heading
      : focus ? [...region.querySelectorAll<HTMLButtonElement>('[data-course-id]')]
        .find(button => button.dataset.courseId === focus.courseId) : undefined
    const top = entry.top
    // Above-the-fold widgets measure themselves after mount; their final height can
    // move this heading. Follow that layout only until the user interacts with the page.
    let followLayout = isNewEntry && !!courseId
    const stopFollowing = () => { followLayout = false }
    const restore = () => {
      main.scrollTo(0, followLayout ? headingTop() : top)
      target?.focus({ preventScroll: true })
    }
    restore()
    // Query data may have arrived in this commit; reapply after its layout has settled.
    const frame = requestAnimationFrame(restore)
    const observer = new ResizeObserver(() => {
      if (followLayout) main.scrollTo(0, headingTop())
    })
    if (followLayout && region.parentElement) observer.observe(region.parentElement)
    const interactionEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
    for (const type of interactionEvents) main.addEventListener(type, stopFollowing, { passive: true, capture: true })
    const onScroll = () => { entry.top = main.scrollTop }
    main.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      for (const type of interactionEvents) main.removeEventListener(type, stopFollowing, true)
      main.removeEventListener('scroll', onScroll)
    }
  }, [courseId, ready, location.key, memory])

  function setCourse(nextCourseId: string | null, keyboard: boolean) {
    const main = regionRef.current?.closest<HTMLElement>('.main')
    const current = memory.entries.get(location.key)
    if (main && current) current.top = main.scrollTop
    const origin = nextCourseId
      ? { top: main?.scrollTop ?? 0, courseId: nextCourseId, keyboard }
      : current?.origin ?? (courseId && main && headingRef.current ? {
        top: Math.max(0, layoutTop(headingRef.current) - layoutTop(main) - main.clientTop - 24),
        courseId,
        keyboard,
      } : undefined)
    // Browser Back to this overview returns focus to the card used to leave it.
    if (nextCourseId && current) current.focus = keyboard ? { kind: 'course', courseId: nextCourseId } : undefined
    memory.pending = { courseId: nextCourseId, origin, keyboard: keyboard || !!origin?.keyboard }
    setSearchParams(previous => {
      const next = new URLSearchParams(previous)
      if (nextCourseId) next.set('course', nextCourseId)
      else next.delete('course')
      return next
    })
  }

  return { regionRef, headingRef, setCourse }
}
