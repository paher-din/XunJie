import { useRef, useState, type ReactNode } from 'react'
import { Icon, IconText, type IconName } from '../../icons'
import { FluidHighlight } from '../FluidHighlight'
import { useFluidHover, useRegisterFluidHoverItem } from '../../lib/fluidHover'

const icons: IconName[] = ['virtual-board', 'code-square', 'structure']
const covers: Record<string, string> = {
  数字逻辑与部件设计: '/courses/digital-logic.png',
  程序设计基础: '/courses/programming-basics.png',
  数据结构: '/courses/data-structures.png',
}

/** Presentation shared by the product catalog and the isolated legacy preview. */
export function CourseTiles({ courses, toneOf, onOpen, titleOf = id => id, summaryOf }: {
  courses: string[]; toneOf: (id: string) => number; onOpen: (id: string, keyboard: boolean) => void
  titleOf?: (id: string) => string; summaryOf: (id: string) => string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const hover = useFluidHover(ref)
  return <div className="course-tiles" ref={ref} {...hover.handlers}>
    <FluidHighlight activeIndex={hover.activeIndex} rects={hover.itemRects} className="card-grid-highlight" />
    {courses.map((id, index) => <CourseTile key={id} id={id} title={titleOf(id)} summary={summaryOf(id)}
      tone={toneOf(id)} index={index} register={hover.registerItem} onOpen={keyboard => onOpen(id, keyboard)} />)}
  </div>
}
function CourseTile({ id, title, summary, tone, index, register, onOpen }: {
  id: string; title: string; summary: string; tone: number; index: number
  register: (index: number, element: HTMLElement | null) => void; onOpen: (keyboard: boolean) => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  useRegisterFluidHoverItem(register, index, ref)
  const [failed, setFailed] = useState(false)
  return <button ref={ref} className="course-tile" data-course-id={id} onClick={event => onOpen(event.detail === 0)}>
    {covers[title] && !failed ? <img className="course-cover" src={covers[title]} alt="" onError={() => setFailed(true)} />
      : <span className={`course-cover-ph course-${tone % 3}`} aria-hidden><Icon name={icons[tone % 3]} size={48} /></span>}
    <span className="course-tile-body"><h3>{title}</h3><p>{summary}</p>
      <span className="course-tile-foot"><span className="cb-primary">查看任务</span></span>
    </span>
  </button>
}

export function LearningTaskCard({ title, goal, badge, children, footer, action, onOpen, register, index = 0, accessibleLabel, activityId }: {
  title: string; goal?: string; badge?: ReactNode; children?: ReactNode; footer?: ReactNode
  action: string; onOpen: () => void; register?: (index: number, element: HTMLElement | null) => void; index?: number; accessibleLabel?: string; activityId?: string
}) {
  const ref = useRef<HTMLButtonElement>(null)
  useRegisterFluidHoverItem(register ?? (() => {}), index, ref)
  return <button ref={ref} aria-label={accessibleLabel} data-activity-id={activityId} className={`task-card${children ? '' : ' task-card-without-progress'}`} onClick={onOpen}>
    {badge && <div>{badge}</div>}<h3>{title}</h3>{goal && <p>{goal}</p>}{children}
    <div className="card-foot"><span>{footer}</span><span className="action"><IconText name="arrow-right" position="end">{action}</IconText></span></div>
  </button>
}

export function LearningCardGrid({ children }: { children: (register: (index: number, element: HTMLElement | null) => void) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const hover = useFluidHover(ref)
  return <div className="task-card-grid" ref={ref} {...hover.handlers}>
    <FluidHighlight activeIndex={hover.activeIndex} rects={hover.itemRects} className="card-grid-highlight" />
    {children(hover.registerItem)}
  </div>
}
