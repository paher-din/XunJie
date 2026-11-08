import type { ComponentType, ReactNode, Ref } from 'react'
import { XunjieLogo } from '../brand/XunjieLogo'
import { Icon } from '../icons'
import { TeacherBadge, TeacherButton } from '../teacher'
import type { TeacherCourseKind } from '../teacher'

/** Router adapters render ordinary links and handle their own active state. */
export interface TeacherLinkProps {
  to: string
  children: ReactNode
  className?: string
  title?: string
  'aria-label'?: string
  end?: boolean
}
export type TeacherLinkComponent = ComponentType<TeacherLinkProps>

export interface TeacherShellCourse {
  id: string
  title: string
  kind: TeacherCourseKind
}
export interface TeacherShellLinks {
  overview: string
  projects: string
  review: string
  materials: string
  settings: string
  studentSpace: string
  liveWorkspace: string
}
export type TeacherAccountAction =
  | { kind: 'link'; to: string; label: string }
  | { kind: 'button'; label: string; onClick: () => void }

export interface TeacherSidebarProps {
  Link: TeacherLinkComponent
  NavLink: TeacherLinkComponent
  links: TeacherShellLinks
  spaceCaption: string
  courses: TeacherShellCourse[]
  selectedCourseId: string
  onSelectCourse: (id: string) => void
  pendingReviewCount: number
  showStudentSpace: boolean
  account: { name: string; detail: string; action: TeacherAccountAction }
}

/** Teacher navigation; the host owns routing, course selection and the session. */
export function TeacherSidebar({ Link, NavLink, links, spaceCaption, courses, selectedCourseId,
  onSelectCourse, pendingReviewCount, showStudentSpace, account }: TeacherSidebarProps) {
  return <aside className="t-sidebar" aria-label="教师导航">
    <Link className="t-brand" to={links.overview}><XunjieLogo label="循阶" /><span>循阶<span>教师工作台</span></span></Link>
    <div className="t-space"><span className="t-space-icon"><Icon name="learning-space" size={20} /></span><div>教学空间<small>{spaceCaption}</small></div><TeacherBadge>教师</TeacherBadge></div>
    <div className="t-nav-label">工作空间</div>
    <nav>
      <NavLink aria-label="教学概览" end to={links.overview}><Icon name="home-2" size={19} /><span>教学概览</span></NavLink>
      <NavLink aria-label="项目与活动" to={links.projects}><Icon name="folder-with-files" size={19} /><span>项目与活动</span></NavLink>
      <NavLink aria-label="学生与审阅" to={links.review}><Icon name="clipboard-check" size={19} /><span>学生与审阅</span>{pendingReviewCount > 0 && <small>{pendingReviewCount}</small>}</NavLink>
      <NavLink aria-label="课程材料" to={links.materials}><Icon name="book-2" size={19} /><span>课程材料</span></NavLink>
    </nav>
    <div className="t-nav-label t-course-label">我的课程</div>
    <div className="t-sidebar-courses">{courses.map(course => <button key={course.id} className={selectedCourseId === course.id ? 'selected' : ''} onClick={() => onSelectCourse(course.id)} aria-pressed={selectedCourseId === course.id} title={course.title}>
      <span className={`t-course-dot ${course.kind === 'hdl' ? 'hdl' : ''}`} /><span>{course.title}</span>
    </button>)}</div>
    <div className="t-sidebar-bottom">
      <NavLink aria-label="工作台设置" to={links.settings}><Icon name="settings" size={19} /><span>工作台设置</span></NavLink>
      {showStudentSpace && <Link aria-label="学生空间入口" to={links.studentSpace}><Icon name="arrow-left" size={18} /><span>学生空间入口</span></Link>}
      <div className="t-account"><span className="t-avatar">教</span><div>{account.name}<small>{account.detail}</small></div>
        {account.action.kind === 'link' ? <Link to={account.action.to} title={account.action.label} aria-label={account.action.label}><Icon name="logout-2" /></Link> : <button className="t-icon-button" title={account.action.label} aria-label={account.action.label} onClick={account.action.onClick}><Icon name="logout-2" /></button>}
      </div>
    </div>
  </aside>
}

export interface TeacherShellFrameProps {
  collapsed: boolean
  sidebar: ReactNode
  children: ReactNode
  mainRef?: Ref<HTMLElement>
  onSkipToMain: () => void
  toast?: ReactNode
}
export function TeacherShellFrame({ collapsed, sidebar, children, mainRef, onSkipToMain, toast }: TeacherShellFrameProps) {
  return <div className={`teacher-shell${collapsed ? ' t-collapsed' : ''}`}>
    <a className="t-skip" href="#teacher-main" onClick={event => { event.preventDefault(); onSkipToMain() }}>跳到主要内容</a>
    {sidebar}
    <main className="t-main" id="teacher-main" ref={mainRef} tabIndex={-1}>{children}</main>
    {toast}
  </div>
}

export interface TeacherPageRegionProps { children: ReactNode }
export function TeacherPageRegion({ children }: TeacherPageRegionProps) {
  return <div className="t-page">{children}</div>
}
export function TeacherPageLoading() {
  return <div className="t-loading" role="status">正在打开工作台…</div>
}

export interface TeacherTopbarProps {
  title: string
  collapsed: boolean
  onToggleNavigation: () => void
  courses: Pick<TeacherShellCourse, 'id' | 'title'>[]
  selectedCourseId: string
  onCourseChange: (id: string) => void
  dark: boolean
  onToggleTheme: () => void
  /** A host-owned tool, such as the execution-node selector, between breadcrumbs and actions. */
  tool?: ReactNode
}
export function TeacherTopbar({ title, collapsed, onToggleNavigation, courses, selectedCourseId,
  onCourseChange, dark, onToggleTheme, tool }: TeacherTopbarProps) {
  return <header className="t-topbar"><div className="t-breadcrumb"><button className="t-icon-button" aria-label={collapsed ? '展开导航' : '收起导航'} aria-expanded={!collapsed} onClick={onToggleNavigation}><Icon name="panel-left-close" size={18} /></button><span>教师工作台</span><span className="t-slash">/</span><strong>{title}</strong></div>
    {tool}
    <div className="t-topbar-actions"><label className="t-course-select"><span className="t-sr-only">当前课程</span><select aria-label="当前课程" value={selectedCourseId} onChange={event => onCourseChange(event.target.value)}><option value="all">全部课程</option>{courses.map(course => <option key={course.id} value={course.id}>{course.title}</option>)}</select></label><button className="t-icon-button" aria-label={dark ? '切换浅色模式' : '切换深色模式'} onClick={onToggleTheme}><Icon name={dark ? 'sun' : 'moon'} size={18} /></button></div>
  </header>
}

export interface TeacherPreviewNoticeProps { Link: TeacherLinkComponent; liveWorkspaceTo: string }
export function TeacherPreviewNotice({ Link, liveWorkspaceTo }: TeacherPreviewNoticeProps) {
  return <div className="t-preview-note"><span><Icon name="info-circle" size={15} />交互预览 · 数据为合成示例，操作仅保存在本机</span><Link to={liveWorkspaceTo}>进入真实工作台<Icon name="arrow-right" size={14} /></Link></div>
}
export interface TeacherCommandNoticeProps { pendingCount: number; retrying: boolean; onRetry: () => void }
export function TeacherCommandNotice({ pendingCount, retrying, onRetry }: TeacherCommandNoticeProps) {
  return <div className="t-command-note"><span>{pendingCount ? `${pendingCount} 个原教师操作待核对，编辑暂时保留。` : '教师操作使用当前课程版本；网络结果未知时保留原请求。'}</span><TeacherButton disabled={retrying} onClick={onRetry}>核对原教师操作</TeacherButton></div>
}
export interface TeacherToastProps { message: string; onClose: () => void }
export function TeacherToast({ message, onClose }: TeacherToastProps) {
  return <div className="t-toast" role="status"><Icon name="check-circle" size={17} />{message}<button aria-label="关闭提示" onClick={onClose}><Icon name="close" size={15} /></button></div>
}
export interface TeacherScopeNoticeProps { error: string; loading: boolean; onRefresh: () => void }
export function TeacherScopeNotice({ error, loading, onRefresh }: TeacherScopeNoticeProps) {
  return <div className={`t-scope-note${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}><Icon name={error ? 'danger-triangle' : 'info-circle'} size={18} /><div>{error ? '课程数据未能读取' : loading ? '正在读取任教课程…' : '已连接当前教学服务'}<p>{error || '设计、分配与反馈由服务端保存。学生进展来自实际尝试，能力判断保留证据与未知。'}</p></div><TeacherButton onClick={onRefresh} disabled={loading} icon="refresh">重新读取</TeacherButton></div>
}
