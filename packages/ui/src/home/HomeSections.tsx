import type { ReactNode, Ref } from 'react'
import { Icon, IconText } from '../icons'
import { ProgressBar, StatusChip, type TaskDisplayStatus } from '../foundation'
import { LearningTaskCard, type LearningTaskCardProps } from './LearningCards'

export interface HomeIntroProps { title: ReactNode; date: ReactNode }
export function HomeIntro({ title, date }: HomeIntroProps) {
  return <div className="intro"><h1>{title}</h1><span className="date">{date}</span></div>
}

export interface HomeCourseRegionProps { selected: boolean; regionRef?: Ref<HTMLDivElement>; children: ReactNode }
export function HomeCourseRegion({ selected, regionRef, children }: HomeCourseRegionProps) {
  return <div className="course-region" data-course-selected={selected} ref={regionRef}>{children}</div>
}

export interface HomeSectionHeadingProps {
  title: ReactNode; count: ReactNode; headingRef?: Ref<HTMLHeadingElement>
  refresh?: { disabled: boolean; onRefresh: () => void }
}
export function HomeSectionHeading({ title, count, headingRef, refresh }: HomeSectionHeadingProps) {
  return <div className="sectionhead">
    <h2 ref={headingRef} tabIndex={-1}>{title}<small>{count}</small></h2>
    {refresh && <button className="outline" type="button" disabled={refresh.disabled} onClick={refresh.onRefresh}>刷新任务</button>}
  </div>
}

export interface CourseBreadcrumbProps { title: string; onBack: (keyboard: boolean) => void }
export function CourseBreadcrumb({ title, onBack }: CourseBreadcrumbProps) {
  return <div className="course-breadcrumb">
    <button onClick={event => onBack(event.detail === 0)}><IconText name="alt-arrow-left">全部课程</IconText></button>
    <span>/</span><strong>{title}</strong>
  </div>
}

export interface HomeStatusProps {
  kind: 'loading' | 'error' | 'empty'; message: string; searchIcon?: boolean
  retry?: { disabled: boolean; onRetry: () => void }
}
export function HomeStatus({ kind, message, searchIcon, retry }: HomeStatusProps) {
  if (kind === 'loading') return <p role="status" aria-label={message} />
  if (kind === 'error') return <div className="empty" role="alert">
    <p>{message}</p>{retry && <button type="button" disabled={retry.disabled} onClick={retry.onRetry}>重试</button>}
  </div>
  return <div className="empty">{searchIcon && <Icon name="folder-search" size={22} />}{message}</div>
}

export interface PreparationEntryCardProps {
  flag: string; title: string; description: string; note: string; action: string; onOpen: () => void
}
export function PreparationEntryCard({ flag, title, description, note, action, onOpen }: PreparationEntryCardProps) {
  return <section className="prep-entry">
    <div className="prep-entry-body">
      <p className="prep-entry-flag"><Icon name="shield-check" size={15} tone="neutral" />{flag}</p>
      <h2>{title}</h2><p>{description}</p><p className="prep-entry-note">{note}</p>
    </div>
    <button className="primary" onClick={onOpen}><IconText name="arrow-right" position="end">{action}</IconText></button>
  </section>
}

export interface HomeTaskCardProps extends Omit<LearningTaskCardProps, 'badge' | 'children'> {
  status: TaskDisplayStatus; overdue?: boolean; progress?: { percent: number; done: boolean }
}
/** 显示状态与进度，不推算完成度、截止时间或动作。 */
export function HomeTaskCard({ status, overdue = false, progress, ...card }: HomeTaskCardProps) {
  return <LearningTaskCard {...card}
    badge={<><StatusChip status={status} />{overdue && <span className="status overdue">已逾期</span>}</>}>
    {progress && <><div className="progresslabel"><span>任务进度</span><span>{progress.percent}%</span></div>
      <ProgressBar percent={progress.percent} done={progress.done} /></>}
  </LearningTaskCard>
}
