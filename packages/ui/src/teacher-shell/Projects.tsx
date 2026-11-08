import type { ReactNode } from 'react'
import { Icon } from '../icons'

export interface TeacherProjectGridProps { children: ReactNode }
export function TeacherProjectGrid({ children }: TeacherProjectGridProps) {
  return <div className="t-project-grid">{children}</div>
}

export interface TeacherCourseFilterProps { courseTitle: string; onClear: () => void }
export function TeacherCourseFilter({ courseTitle, onClear }: TeacherCourseFilterProps) {
  return <div className="t-course-filter">当前课程：{courseTitle}<button onClick={onClear}>清除页面筛选<Icon name="close" size={13} /></button></div>
}

export interface TeacherProjectTab { id: string; label: string; count: number }
export interface TeacherProjectsToolbarProps {
  tabs: TeacherProjectTab[]
  selectedTab: string
  onSelectTab: (id: string) => void
  query: string
  onQueryChange: (value: string) => void
}
export function TeacherProjectsToolbar({ tabs, selectedTab, onSelectTab, query, onQueryChange }: TeacherProjectsToolbarProps) {
  return <div className="t-toolbar"><div className="t-tabs" aria-label="活动状态">{tabs.map(tab => <button key={tab.id} aria-pressed={tab.id === selectedTab} className={tab.id === selectedTab ? 'active' : ''} onClick={() => onSelectTab(tab.id)}>{tab.label}<small>{tab.count}</small></button>)}</div><label className="t-search"><Icon name="minimalistic-magnifier" size={17} /><input aria-label="搜索项目" placeholder="搜索项目名称或内容" value={query} onChange={event => onQueryChange(event.target.value)} />{query && <button aria-label="清除搜索" onClick={() => onQueryChange('')}><Icon name="close" size={14} /></button>}</label></div>
}
