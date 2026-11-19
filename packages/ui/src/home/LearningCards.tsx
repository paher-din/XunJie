import type { ReactNode } from 'react'
import { Icon, IconText, type IconName } from '../icons'
import './activity-card-menu.css'

const icons: IconName[] = ['virtual-board', 'code-square', 'structure']

/** Presentation shared by the product catalog and the isolated legacy preview. */
export interface CourseTilesProps {
  courses: string[]; toneOf: (id: string) => number; onOpen: (id: string, keyboard: boolean) => void
  titleOf?: (id: string) => string; summaryOf: (id: string) => string
  actionOf?: (id: string) => string; idKind?: 'course' | 'activity'
}

export function CourseTiles({ courses, toneOf, onOpen, titleOf = id => id, summaryOf, actionOf, idKind = 'course' }: CourseTilesProps) {
  return <div className="course-tiles">
    {courses.map(id => <CourseTile key={id} id={id} title={titleOf(id)} summary={summaryOf(id)}
      tone={toneOf(id)} onOpen={keyboard => onOpen(id, keyboard)}
      action={actionOf?.(id)} idKind={idKind} />)}
  </div>
}
export interface CourseTileProps {
  id: string; title: string; summary: string; tone: number
  action?: string; idKind?: 'course' | 'activity'
  onOpen: (keyboard: boolean) => void
}

export function CourseTile({ id, title, summary, tone, onOpen, action = '查看任务', idKind = 'course' }: CourseTileProps) {
  return <button className="course-tile" data-course-id={idKind === 'course' ? id : undefined}
    data-activity-id={idKind === 'activity' ? id : undefined} onClick={event => onOpen(event.detail === 0)}>
    {/* DESIGN.md C1–C4: the geometric fallback is the confirmed cover. No illustration has been
        produced yet, so never request a non-existent /courses/*.png (which only caused a 404). */}
    <span className={`course-cover-ph course-${tone % 3}`} aria-hidden><Icon name={icons[tone % 3]} size={48} /></span>
    <span className="course-tile-body"><h3>{title}</h3><p>{summary}</p>
      <span className="course-tile-foot"><span className="cb-primary">{action}</span></span>
    </span>
  </button>
}

export interface LearningTaskCardProps {
  title: string; goal?: string; badge?: ReactNode; children?: ReactNode; footer?: ReactNode
  action: string; onOpen: () => void; accessibleLabel?: string; activityId?: string
  opensDialog?: boolean; disabled?: boolean; menu?: ReactNode
}

export function LearningTaskCard({ title, goal, badge, children, footer, action, onOpen, accessibleLabel, activityId,
  opensDialog, disabled, menu }: LearningTaskCardProps) {
  const card = <button type="button" aria-label={accessibleLabel} aria-haspopup={opensDialog ? 'dialog' : undefined}
    disabled={disabled} data-activity-id={activityId} className={`task-card${children ? '' : ' task-card-without-progress'}`} onClick={onOpen}>
    {badge && <div>{badge}</div>}<h3>{title}</h3>{goal && <p>{goal}</p>}{children}
    <div className="card-foot"><span>{footer}</span><span className="action"><IconText name="arrow-right" position="end">{action}</IconText></span></div>
  </button>
  return menu ? <div className="task-card-shell">{card}<div className="task-card-menu">{menu}</div></div> : card
}

export interface LearningCardGridProps { children: ReactNode }

export function LearningCardGrid({ children }: LearningCardGridProps) {
  return <div className="task-card-grid">{children}</div>
}
