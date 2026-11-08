import type { ComponentProps } from 'react'
import { Icon } from '../icons'
import { CourseMark, TeacherBadge, TeacherButton } from './ui'

export interface ProjectCardProps {
  courseKind: ComponentProps<typeof CourseMark>['kind']
  courseTitle?: string
  statusLabel: string
  statusTone: ComponentProps<typeof TeacherBadge>['tone']
  title: string
  description: string
  versionLabel: string
  due?: string
  /** 页面提供已计算、已格式化的展示数量；草稿不传。 */
  numbers?: { assigned: number | string; submitted: number | string; reviewed: number | string }
  footer: string
  actionLabel: string
  onAction: () => void
}

/** 受控项目卡；领域数据、数量计算和导航均由页面提供。 */
export function ProjectCard({ courseKind, courseTitle, statusLabel, statusTone, title, description,
  versionLabel, due, numbers, footer, actionLabel, onAction }: ProjectCardProps) {
  return <article className="t-project-card">
    <div className="t-project-card-top"><CourseMark kind={courseKind} /><TeacherBadge tone={statusTone}>{statusLabel}</TeacherBadge></div><div className="t-eyebrow">{courseTitle}</div><h2>{title}</h2><p>{description}</p><div className="t-project-metadata"><span><Icon name="copy" size={14} />{versionLabel}</span>{due && <span><Icon name="calendar" size={14} />{due}</span>}</div>
    {numbers && <div className="t-project-numbers"><span><b>{numbers.assigned}</b>已分配</span><span><b>{numbers.submitted}</b>已提交</span><span><b>{numbers.reviewed}</b>已审阅</span></div>}
    <div className="t-project-card-footer"><span>{footer}</span><TeacherButton onClick={onAction}>{actionLabel}<Icon name="arrow-right" size={14} /></TeacherButton></div>
  </article>
}
