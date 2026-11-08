import type { ReactNode } from 'react'
import { Icon } from '../icons'
import type { IconName } from '../icons'
import { CourseMark, TeacherBadge, TeacherButton, TeacherEmpty } from '../teacher'
import type { TeacherCourseKind } from '../teacher'
import type { TeacherLinkComponent } from './Shell'

export interface TeacherPageHeadingProps {
  eyebrow: ReactNode
  title: string
  description: string
  actionDisabled?: boolean
  onCreateProject: () => void
}
export function TeacherPageHeading({ eyebrow, title, description, actionDisabled, onCreateProject }: TeacherPageHeadingProps) {
  return <div className="t-heading"><div><div className="t-eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div><TeacherButton primary icon="add" disabled={actionDisabled} onClick={onCreateProject}>设计新项目</TeacherButton></div>
}

export interface TeacherStatistic { label: string; value: number | string; unit: string; icon: IconName; note: string }
export interface TeacherOverviewStatsProps { stats: TeacherStatistic[] }
export function TeacherOverviewStats({ stats }: TeacherOverviewStatsProps) {
  return <section className="t-stats" aria-label="教学摘要">{stats.map(stat => <div className="t-stat" key={stat.label}><div><span>{stat.label}</span><Icon name={stat.icon} size={18} /></div><strong>{stat.value}<small>{stat.unit}</small></strong><p>{stat.note}</p></div>)}</section>
}

export interface TeacherOverviewColumnsProps { children: ReactNode }
export function TeacherOverviewColumns({ children }: TeacherOverviewColumnsProps) {
  return <div className="t-overview-columns">{children}</div>
}

export interface TeacherAttentionItem { id: string; name: string; activityTitle: string; avatarIndex: number; to: string }
export interface TeacherAttentionPanelProps { Link: TeacherLinkComponent; reviewTo: string; items: TeacherAttentionItem[] }
export function TeacherAttentionPanel({ Link, reviewTo, items }: TeacherAttentionPanelProps) {
  return <section className="t-panel"><div className="t-section-heading"><h2>需要你关注</h2><Link to={reviewTo}>查看全部<Icon name="alt-arrow-right" size={15} /></Link></div>
    {items.length ? <div className="t-attention-list">{items.map(item => <Link key={item.id} className="t-attention-row" to={item.to}><span className={`t-avatar t-avatar-${item.avatarIndex}`}>{item.name[0]}</span><div><strong>{item.name}<TeacherBadge tone="pending">待审阅</TeacherBadge></strong><p>{item.activityTitle}</p></div><Icon name="alt-arrow-right" size={17} /></Link>)}</div> : <div className="t-inline-empty"><Icon name="clipboard-check" size={24} /><p>当前没有等待审阅的提交</p></div>}
    <div className="t-panel-foot"><Icon name="info-circle" size={15} /><span>作品结果、实际帮助与能力判断分别查看。</span></div>
  </section>
}

export interface TeacherResumeDraft { title: string; revision: number; sourceLabel: string; to: string }
export interface TeacherDesignCardProps { Link: TeacherLinkComponent; draft?: TeacherResumeDraft; disabled?: boolean; onCreateProject: () => void }
export function TeacherDesignCard({ Link, draft, disabled, onCreateProject }: TeacherDesignCardProps) {
  return <section className="t-panel t-design-card"><div className="t-section-heading"><h2>下一次好项目，从这里开始</h2><span className="t-quiet-icon"><Icon name="lightbulb" size={23} /></span></div><p>把课程目标、探索空间和评价依据，放进同一份可编辑的项目蓝图。</p>
    <div className="t-design-steps"><span><i>01</i>提供材料</span><Icon name="arrow-right" size={14} /><span><i>02</i>完善蓝图</span><Icon name="arrow-right" size={14} /><span><i>03</i>预览分配</span></div>
    {draft ? <Link className="t-resume-draft" to={draft.to}><span><Icon name="file-text" size={19} /><span><strong>{draft.title}</strong><small>{draft.sourceLabel} · revision {draft.revision}</small></span></span><Icon name="arrow-right" size={18} /></Link> : <TeacherButton icon="add" disabled={disabled} onClick={onCreateProject}>从新项目开始</TeacherButton>}
  </section>
}

export interface TeacherCourseCardData {
  id: string
  title: string
  kind: TeacherCourseKind
  code?: string
  term?: string
  activityCount: number
  summary: string
}
export interface TeacherCourseCardProps { course: TeacherCourseCardData; onView: (id: string) => void }
export function TeacherCourseCard({ course, onView }: TeacherCourseCardProps) {
  return <article className="t-course-card"><div className={`t-course-cover ${course.kind === 'hdl' ? 'hdl' : ''}`}><CourseMark kind={course.kind} />{course.code && <span>{course.code}</span>}<div className="t-course-geometry" aria-hidden="true" /></div><div className="t-course-card-body"><div><h3>{course.title}</h3><TeacherBadge>{course.activityCount} 个活动</TeacherBadge></div>{course.term && <p>{course.term}</p>}<div className="t-course-card-bottom"><span>{course.summary}</span><TeacherButton onClick={() => onView(course.id)}>查看活动<Icon name="arrow-right" size={14} /></TeacherButton></div></div></article>
}
export interface TeacherCoursesSectionProps { Link: TeacherLinkComponent; projectsTo: string; courses: TeacherCourseCardData[]; onViewCourse: (id: string) => void }
export function TeacherCoursesSection({ Link, projectsTo, courses, onViewCourse }: TeacherCoursesSectionProps) {
  return <section><div className="t-section-heading t-course-heading"><div><h2>我的课程</h2><p>围绕课程组织活动、材料与教学反馈。</p></div><Link to={projectsTo}>管理项目<Icon name="alt-arrow-right" size={15} /></Link></div>
    <div className="t-courses-grid">{courses.map(course => <TeacherCourseCard key={course.id} course={course} onView={onViewCourse} />)}</div>{!courses.length && <TeacherEmpty title="暂无可显示的任教课程">课程信息以当前教学服务的会话和授权为准。</TeacherEmpty>}
  </section>
}
