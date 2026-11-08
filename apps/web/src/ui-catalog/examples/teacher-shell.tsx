import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { ProjectCard, TeacherButton, TeacherDialog } from '@xunjie/ui/teacher'
import {
  TeacherActivityDetail, TeacherAttentionPanel, TeacherCommandNotice, TeacherCourseCard, TeacherCourseFilter,
  TeacherCoursesSection, TeacherDesignCard, TeacherFixedActivity, TeacherOverviewColumns, TeacherOverviewStats,
  TeacherPageHeading, TeacherPageLoading, TeacherPageRegion, TeacherPreviewActivity, TeacherPreviewAssignments,
  TeacherPreviewNotice, TeacherProjectGrid, TeacherProjectsToolbar, TeacherScopeNotice, TeacherShellFrame,
  TeacherSidebar, TeacherToast, TeacherTopbar,
  type TeacherCourseCardData, type TeacherFixedActivityView, type TeacherLinkProps, type TeacherPreviewActivityView,
  type TeacherShellCourse, type TeacherShellLinks, type TeacherStatistic,
} from '@xunjie/ui/teacher-shell'
import '@xunjie/ui/styles/teacher/teacher.css'
import '@xunjie/ui/styles/teacher/review-materials.css'
import type { CatalogEntry } from '../types'

/** 样本、链接与操作均只保存在当前预览中。 */
const courses: TeacherShellCourse[] = [
  { id: 'example-c', title: '示例程序设计', kind: 'c' },
  { id: 'example-hdl', title: '示例数字逻辑', kind: 'hdl' },
]
const links: TeacherShellLinks = {
  overview: '/example/overview', projects: '/example/projects', review: '/example/review', materials: '/example/materials',
  settings: '/example/settings', studentSpace: '/example/student', liveWorkspace: '/example/teacher',
}
const courseCards: TeacherCourseCardData[] = [
  { ...courses[0], code: 'EX 101', term: '示例学期', activityCount: 2, summary: '3 位示例学生' },
  { ...courses[1], code: 'EX 203', term: '示例学期', activityCount: 1, summary: '2 条示例分配' },
]
const stats: TeacherStatistic[] = [
  { label: '任教课程', value: 2, unit: '门', icon: 'book-2', note: '示例课程' },
  { label: '开放活动', value: 3, unit: '个', icon: 'folder-with-files', note: '示例活动' },
  { label: '等待审阅', value: 1, unit: '份', icon: 'clipboard-check', note: '示例提交' },
  { label: '设计草稿', value: 1, unit: '个', icon: 'pen-new-square', note: '示例草稿' },
]
const attention = [
  { id: 'example-learner', name: '示例同学', activityTitle: '示例项目', avatarIndex: 0, to: '/example/review?learner=example' },
]
const draft = { title: '示例课程草稿', revision: 2, sourceLabel: '本机示例草稿', to: '/example/design' }
const fixed: TeacherFixedActivityView = {
  audience: '示例读书小组', artifact: '示例报告', routes: ['比较两种方案'],
  goals: [{ id: 'example-goal', title: '解释示例数据', domain: '示例领域', version: 1 }],
  tasks: [{ id: 'example-task', title: '完成示例调查' }], milestones: [{ id: 'example-milestone', title: '提交示例报告' }],
  rubric: [{ id: 'example-rubric', description: '用示例证据说明判断' }], helpPolicy: '示例帮助政策：允许概念提示。',
  materials: [{ status: 'available', id: 'example-material', title: '示例材料', text: '这里是示例材料正文。' },
    { status: 'redacted', id: 'example-hidden' }, { status: 'unavailable', id: 'example-unavailable' }],
  assignments: [{ id: 'example-assignment', name: '示例同学', active: true }],
}
const snapshot: TeacherPreviewActivityView = {
  revision: 2, audience: '示例读书小组', deliverable: '示例报告', choices: '比较两种方案', foundation: '示例前置知识', duration: '示例课时',
  goals: [{ id: 'example-goal', title: '解释示例数据', evidence: '给出示例依据' }],
  milestones: [{ id: 'example-milestone', title: '提交示例报告', evidence: '报告与简短说明' }],
  rubric: [{ id: 'example-rubric', criterion: '示例判断', description: '用示例证据说明判断' }],
  helpPolicy: '示例帮助政策：允许概念提示。',
  materials: [{ id: 'example-material', title: '示例材料', version: 1, content: '这里是示例材料正文。', student: true, tutor: false, teacherDesign: true }],
}
const assignments = [{ id: 'example-student', name: '示例同学' }]

const NavigationContext = createContext<{ path: string; navigate: (path: string) => void }>({ path: links.overview, navigate: () => {} })
function ExampleLink({ to, children, className, title, 'aria-label': ariaLabel }: TeacherLinkProps) {
  const navigation = useContext(NavigationContext)
  const active = to === navigation.path
  return <a href={`#example-${encodeURIComponent(to)}`} className={[className, active ? 'active' : ''].filter(Boolean).join(' ') || undefined}
    title={title} aria-label={ariaLabel} aria-current={active ? 'page' : undefined}
    onClick={event => { event.preventDefault(); navigation.navigate(to) }}>{children}</a>
}
function useExampleTheme() {
  const [dark, setDark] = useState(() => new URLSearchParams(window.location.search).get('theme') === 'dark')
  useEffect(() => {
    const root = document.documentElement
    const previous = root.dataset.theme
    const colorScheme = root.style.colorScheme
    return () => {
      if (previous === undefined) delete root.dataset.theme
      else root.dataset.theme = previous
      root.style.colorScheme = colorScheme
    }
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }, [dark])
  return [dark, setDark] as const
}
function Stage({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(links.overview)
  return <NavigationContext.Provider value={{ path, navigate: setPath }}><div className="teacher-shell"
    style={{ display: 'block', width: '100%', height: 'auto', minHeight: '100vh', padding: 24, overflow: 'visible' }}>
    <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 20 }}>示例数据 · 操作仅在当前预览中生效</p>
    {children}<output>{path !== links.overview && `示例跳转：${path}`}</output>
  </div></NavigationContext.Provider>
}
function ExampleSidebar({ preview, courseId, onCourse, onLogout }: { preview: boolean; courseId: string; onCourse: (id: string) => void; onLogout: () => void }) {
  return <TeacherSidebar Link={ExampleLink} NavLink={ExampleLink} links={links} courses={courses} selectedCourseId={courseId}
    onSelectCourse={onCourse} spaceCaption={preview ? '示例学期 · 预览' : '示例任教课程'} pendingReviewCount={preview ? 2 : 0} showStudentSpace
    account={{ name: preview ? '示例教师预览' : '示例教师账号', detail: preview ? '隔离示例数据' : '示例教师账号',
      action: preview ? { kind: 'link', to: links.liveWorkspace, label: '登录真实工作台' } : { kind: 'button', label: '退出登录', onClick: onLogout } }} />
}
function ShellDemo({ initiallyCollapsed }: { initiallyCollapsed: boolean }) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed)
  const [courseId, setCourseId] = useState('all')
  const [path, setPath] = useState(links.overview)
  const [dark, setDark] = useExampleTheme()
  const [message, setMessage] = useState('')
  const mainRef = useRef<HTMLElement>(null)
  return <NavigationContext.Provider value={{ path, navigate: setPath }}><div style={{ width: '100%' }}>
    <TeacherShellFrame collapsed={collapsed} mainRef={mainRef} onSkipToMain={() => mainRef.current?.focus()}
      sidebar={<ExampleSidebar preview courseId={courseId} onCourse={id => setCourseId(courseId === id ? 'all' : id)} onLogout={() => setMessage('示例退出')} />}>
      <TeacherTopbar title="教学概览" collapsed={collapsed} onToggleNavigation={() => setCollapsed(value => !value)} courses={courses}
        selectedCourseId={courseId} onCourseChange={setCourseId} dark={dark} onToggleTheme={() => setDark(value => !value)} />
      <TeacherPreviewNotice Link={ExampleLink} liveWorkspaceTo={links.liveWorkspace} />
      <TeacherPageRegion><TeacherPageHeading eyebrow="示例教学空间" title="示例教学概览" description="此处展示组件组合，所有操作只影响当前预览。"
        onCreateProject={() => setMessage('已触发示例设计操作')} /><output>{message || (path !== links.overview ? `示例跳转：${path}` : '可操作导航、课程和主题按钮')}</output></TeacherPageRegion>
    </TeacherShellFrame></div>
  </NavigationContext.Provider>
}
function ShellExpanded() { return <ShellDemo initiallyCollapsed={false} /> }
function ShellCollapsed() { return <ShellDemo initiallyCollapsed /> }
function SidebarDemo({ preview }: { preview: boolean }) {
  const [courseId, setCourseId] = useState('all')
  const [path, setPath] = useState(links.overview)
  const [message, setMessage] = useState('')
  return <NavigationContext.Provider value={{ path, navigate: setPath }}><div className="teacher-shell" style={{ width: '100%' }}>
    <ExampleSidebar preview={preview} courseId={courseId} onCourse={id => setCourseId(courseId === id ? 'all' : id)} onLogout={() => setMessage('已触发示例退出')} />
    <main style={{ padding: 32 }}><p>示例数据 · 所有操作仅在当前预览中生效</p><output>{message || `示例导航：${path}；课程：${courseId}`}</output></main>
  </div></NavigationContext.Provider>
}
function SidebarPreview() { return <SidebarDemo preview /> }
function SidebarLive() { return <SidebarDemo preview={false} /> }
function TopbarDemo() {
  const [collapsed, setCollapsed] = useState(false)
  const [courseId, setCourseId] = useState('all')
  const [dark, setDark] = useExampleTheme()
  return <Stage><TeacherTopbar title="示例项目与活动" collapsed={collapsed} onToggleNavigation={() => setCollapsed(value => !value)}
    courses={courses} selectedCourseId={courseId} onCourseChange={setCourseId} dark={dark} onToggleTheme={() => setDark(value => !value)} />
    <output>示例课程：{courseId}；导航：{collapsed ? '收起' : '展开'}；主题按钮：{dark ? '深色' : '浅色'}</output></Stage>
}
function PageRegionDemo() { return <Stage><TeacherPageRegion><h1>示例页面区域</h1><p>这里放置调用方提供的示例页面内容。</p></TeacherPageRegion></Stage> }
function PageLoadingDemo() { return <Stage><TeacherPageLoading /></Stage> }
function PreviewNoticeDemo() { return <Stage><TeacherPreviewNotice Link={ExampleLink} liveWorkspaceTo={links.liveWorkspace} /></Stage> }
function CommandDemo({ initialCount, initialRetrying = false }: { initialCount: number; initialRetrying?: boolean }) {
  const [count, setCount] = useState(initialCount)
  const [retrying, setRetrying] = useState(initialRetrying)
  const [message, setMessage] = useState('')
  return <Stage><TeacherCommandNotice pendingCount={count} retrying={retrying} onRetry={() => { setCount(0); setMessage('已核对示例请求') }} />
    {retrying && <TeacherButton onClick={() => setRetrying(false)}>结束示例等待</TeacherButton>}<output>{message}</output></Stage>
}
function CommandReady() { return <CommandDemo initialCount={0} /> }
function CommandPending() { return <CommandDemo initialCount={2} /> }
function CommandRetrying() { return <CommandDemo initialCount={2} initialRetrying /> }
function ToastDemo() {
  const [visible, setVisible] = useState(true)
  return <Stage><TeacherButton onClick={() => setVisible(true)}>显示示例提示</TeacherButton>{visible && <TeacherToast message="示例设置已更新" onClose={() => setVisible(false)} />}</Stage>
}
function ScopeDemo({ initial }: { initial: 'connected' | 'loading' | 'error' }) {
  const [state, setState] = useState(initial)
  return <Stage><TeacherScopeNotice error={state === 'error' ? '示例错误：课程读取失败。' : ''} loading={state === 'loading'} onRefresh={() => setState('connected')} />
    {state === 'loading' && <TeacherButton onClick={() => setState('connected')}>完成示例读取</TeacherButton>}</Stage>
}
function ScopeConnected() { return <ScopeDemo initial="connected" /> }
function ScopeLoading() { return <ScopeDemo initial="loading" /> }
function ScopeError() { return <ScopeDemo initial="error" /> }

function HeadingDemo({ disabled }: { disabled: boolean }) {
  const [message, setMessage] = useState('')
  return <Stage><TeacherPageHeading eyebrow="示例教学空间" title="示例项目与活动" description="这里是用于预览的示例描述。"
    actionDisabled={disabled} onCreateProject={() => setMessage('已触发示例项目设计')} /><output>{message}</output></Stage>
}
function HeadingReady() { return <HeadingDemo disabled={false} /> }
function HeadingDisabled() { return <HeadingDemo disabled /> }
function StatsReady() { return <Stage><TeacherOverviewStats stats={stats} /></Stage> }
function StatsUnknown() { return <Stage><TeacherOverviewStats stats={stats.map(item => ({ ...item, value: '—', note: '示例数据暂不可用' }))} /></Stage> }
function OverviewColumnsDemo() {
  const [message, setMessage] = useState('')
  return <Stage><TeacherOverviewColumns><TeacherAttentionPanel Link={ExampleLink} reviewTo={links.review} items={attention} />
    <TeacherDesignCard Link={ExampleLink} onCreateProject={() => setMessage('已触发示例设计')} /></TeacherOverviewColumns><output>{message}</output></Stage>
}
function AttentionList() { return <Stage><TeacherAttentionPanel Link={ExampleLink} reviewTo={links.review} items={attention} /></Stage> }
function AttentionEmpty() { return <Stage><TeacherAttentionPanel Link={ExampleLink} reviewTo={links.review} items={[]} /></Stage> }
function DesignDemo({ mode }: { mode: 'draft' | 'empty' | 'disabled' }) {
  const [message, setMessage] = useState('')
  return <Stage><TeacherDesignCard Link={ExampleLink} draft={mode === 'draft' ? draft : undefined} disabled={mode === 'disabled'}
    onCreateProject={() => setMessage('已触发示例设计')} /><output>{message}</output></Stage>
}
function DesignDraft() { return <DesignDemo mode="draft" /> }
function DesignEmpty() { return <DesignDemo mode="empty" /> }
function DesignDisabled() { return <DesignDemo mode="disabled" /> }
function CourseCardDemo({ kind }: { kind: 'c' | 'hdl' }) {
  const [message, setMessage] = useState('')
  return <Stage><div style={{ maxWidth: 540 }}><TeacherCourseCard course={kind === 'c' ? courseCards[0] : courseCards[1]}
    onView={id => setMessage(`已查看示例课程：${id}`)} /></div><output>{message}</output></Stage>
}
function CourseCardC() { return <CourseCardDemo kind="c" /> }
function CourseCardHdl() { return <CourseCardDemo kind="hdl" /> }
function CoursesDemo({ empty }: { empty: boolean }) {
  const [message, setMessage] = useState('')
  return <Stage><TeacherCoursesSection Link={ExampleLink} projectsTo={links.projects} courses={empty ? [] : courseCards}
    onViewCourse={id => setMessage(`已查看示例课程：${id}`)} /><output>{message}</output></Stage>
}
function CoursesPopulated() { return <CoursesDemo empty={false} /> }
function CoursesEmpty() { return <CoursesDemo empty /> }
function ProjectGridDemo() {
  const [message, setMessage] = useState('')
  return <Stage><TeacherProjectGrid>
    <ProjectCard courseKind="c" courseTitle="示例课程" statusLabel="已开放" statusTone="progress" title="示例报告项目" description="这是示例活动。"
      versionLabel="来源 revision 2" numbers={{ assigned: 3, submitted: 1, reviewed: 0 }} footer="示例固定版本" actionLabel="活动详情" onAction={() => setMessage('已打开示例活动')} />
    <ProjectCard courseKind="hdl" courseTitle="示例课程" statusLabel="草稿" statusTone="neutral" title="示例计数器草稿" description="这是示例草稿。"
      versionLabel="草稿 revision 1" footer="示例草稿" actionLabel="继续设计" onAction={() => setMessage('已打开示例草稿')} />
  </TeacherProjectGrid><output>{message}</output></Stage>
}
function CourseFilterDemo() {
  const [visible, setVisible] = useState(true)
  return <Stage>{visible ? <TeacherCourseFilter courseTitle="示例程序设计" onClear={() => setVisible(false)} /> : <TeacherButton onClick={() => setVisible(true)}>恢复示例筛选</TeacherButton>}
    <output>{visible ? '示例课程筛选中' : '已清除示例筛选'}</output></Stage>
}
function ToolbarDemo({ initialQuery = '' }: { initialQuery?: string }) {
  const [tab, setTab] = useState('all')
  const [query, setQuery] = useState(initialQuery)
  const examples = [{ title: '示例报告项目', status: 'active' }, { title: '示例计数器草稿', status: 'draft' }]
  const tabs = [{ id: 'all', label: '全部', count: 2 }, { id: 'active', label: '已开放', count: 1 },
    { id: 'draft', label: '草稿', count: 1 }, { id: 'paused', label: '已暂停', count: 0 }]
  const filtered = examples.filter(item => (tab === 'all' || item.status === tab) && item.title.includes(query.trim()))
  return <Stage><TeacherProjectsToolbar tabs={tabs} selectedTab={tab} onSelectTab={setTab} query={query} onQueryChange={setQuery} />
    <output>{filtered.length ? `示例结果：${filtered.map(item => item.title).join('、')}` : '没有匹配的示例项目'}</output></Stage>
}
function ToolbarAll() { return <ToolbarDemo /> }
function ToolbarNoResults() { return <ToolbarDemo initialQuery="未匹配" /> }
function FixedActivityDemo() { return <Stage><TeacherFixedActivity fixed={fixed} /></Stage> }
function PreviewActivityDemo({ empty }: { empty: boolean }) {
  return <Stage><TeacherPreviewActivity snapshot={empty ? { ...snapshot, materials: [] } : snapshot} /></Stage>
}
function PreviewActivityFilled() { return <PreviewActivityDemo empty={false} /> }
function PreviewActivityEmpty() { return <PreviewActivityDemo empty /> }
function AssignmentsFilled() { return <Stage><TeacherPreviewAssignments assignments={assignments} /></Stage> }
function AssignmentsEmpty() { return <Stage><TeacherPreviewAssignments assignments={[]} /></Stage> }
function ActivityDetailDemo({ mode }: { mode: 'real' | 'preview' | 'summary' }) {
  const [open, setOpen] = useState(true)
  return <Stage><TeacherButton onClick={() => setOpen(true)}>打开示例活动详情</TeacherButton>
    <TeacherDialog open={open} onOpenChange={setOpen} title="示例活动" description="此活动与材料均为目录示例。">
      <TeacherActivityDetail statusLabel="已开放" statusTone="progress" description="这是一段示例活动说明。" activityId="example-activity"
        courseTitle="示例程序设计" assigned={1} versionLabel="来源蓝图 revision 2" fixed={mode === 'real' ? fixed : undefined}
        snapshot={mode === 'preview' ? snapshot : undefined} previewAssignments={mode === 'preview' ? assignments : undefined}
        showPreviewSummaryNote={mode === 'summary'} onClose={() => setOpen(false)} />
    </TeacherDialog></Stage>
}
function ActivityDetailReal() { return <ActivityDetailDemo mode="real" /> }
function ActivityDetailPreview() { return <ActivityDetailDemo mode="preview" /> }
function ActivityDetailSummary() { return <ActivityDetailDemo mode="summary" /> }

const shellImport = '@xunjie/ui/teacher-shell'
const exampleSource = 'apps/web/src/ui-catalog/examples/teacher-shell.tsx'
const teacherStyles = '@xunjie/ui/styles/teacher/teacher.css'
export const teacherShellEntries: CatalogEntry[] = [
  { id: 'teacher-shell-frame', name: 'TeacherShellFrame', description: '教师工作台外壳、侧栏和主区域。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/Shell.tsx', exampleSource: exampleSource,
    props: ['collapsed, sidebar, children', 'mainRef?, onSkipToMain, toast?'], dependencies: [teacherStyles, '宿主提供侧栏、页面内容与聚焦回调'], states: [
      { id: 'expanded', name: '展开', component: ShellExpanded, viewport: 'wide', height: 720 }, { id: 'collapsed', name: '收起', component: ShellCollapsed, viewport: 'wide', height: 720 },
    ] },
  { id: 'teacher-sidebar', name: 'TeacherSidebar', description: '教师导航、课程选择和账户入口。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/Shell.tsx', exampleSource: exampleSource,
    props: ['Link, NavLink, links, spaceCaption', 'courses, selectedCourseId, onSelectCourse', 'pendingReviewCount, showStudentSpace, account'], dependencies: [teacherStyles, '链接适配器与账户动作由宿主提供；示例不会离开目录'], states: [
      { id: 'preview', name: '示例预览账户', component: SidebarPreview, viewport: 'wide', height: 720 }, { id: 'live', name: '示例教师账户', component: SidebarLive, viewport: 'wide', height: 720 },
    ] },
  { id: 'teacher-topbar', name: 'TeacherTopbar', description: '教师工作台面包屑、课程与主题操作。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/Shell.tsx', exampleSource: exampleSource,
    props: ['title, collapsed, onToggleNavigation', 'courses, selectedCourseId, onCourseChange', 'dark, onToggleTheme, tool?'], dependencies: [teacherStyles, '主题的实际应用及工具内容由宿主负责'], states: [{ id: 'interactive', name: '交互', component: TopbarDemo, viewport: 'wide' }] },
  { id: 'teacher-page-region', name: 'TeacherPageRegion', description: '教师页面内容区域。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/Shell.tsx', exampleSource: exampleSource,
    props: ['children: ReactNode'], dependencies: [teacherStyles], states: [{ id: 'content', name: '页面内容', component: PageRegionDemo }] },
  { id: 'teacher-page-loading', name: 'TeacherPageLoading', description: '页面切换时的加载提示。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/Shell.tsx', exampleSource: exampleSource,
    props: ['无属性'], dependencies: [teacherStyles], states: [{ id: 'loading', name: '加载中', component: PageLoadingDemo }] },
  { id: 'teacher-preview-notice', name: 'TeacherPreviewNotice', description: '标识合成预览并提供真实工作台入口。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/Shell.tsx', exampleSource: exampleSource,
    props: ['Link: TeacherLinkComponent', 'liveWorkspaceTo: string'], dependencies: [teacherStyles, '链接适配器由宿主提供；示例只更新本地状态'], states: [{ id: 'preview', name: '预览提示', component: PreviewNoticeDemo, viewport: 'wide' }] },
  { id: 'teacher-command-notice', name: 'TeacherCommandNotice', description: '待核对教师操作数量与重试入口。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/Shell.tsx', exampleSource: exampleSource,
    props: ['pendingCount, retrying, onRetry'], dependencies: [teacherStyles, '请求状态和重试命令由宿主提供'], states: [
      { id: 'ready', name: '无待核对', component: CommandReady }, { id: 'pending', name: '待核对', component: CommandPending }, { id: 'retrying', name: '核对中', component: CommandRetrying },
    ] },
  { id: 'teacher-toast', name: 'TeacherToast', description: '可关闭的教师工作台提示。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/Shell.tsx', exampleSource: exampleSource,
    props: ['message: string', 'onClose: () => void'], dependencies: [teacherStyles, '固定定位；是否显示由宿主控制'], states: [{ id: 'visible', name: '显示 / 关闭', component: ToastDemo }] },
  { id: 'teacher-scope-notice', name: 'TeacherScopeNotice', description: '课程连接、读取和错误提示。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/Shell.tsx', exampleSource: exampleSource,
    props: ['error: string', 'loading: boolean', 'onRefresh: () => void'], dependencies: [teacherStyles, '示例重试只修改本地状态'], states: [
      { id: 'connected', name: '已连接', component: ScopeConnected }, { id: 'loading', name: '读取中', component: ScopeLoading }, { id: 'error', name: '读取失败 / 重试', component: ScopeError },
    ] },
  { id: 'teacher-page-heading', name: 'TeacherPageHeading', description: '教师概览和项目页标题与设计入口。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/Overview.tsx', exampleSource: exampleSource,
    props: ['eyebrow, title, description', 'actionDisabled?, onCreateProject'], dependencies: [teacherStyles], states: [
      { id: 'ready', name: '可操作', component: HeadingReady }, { id: 'disabled', name: '不可操作', component: HeadingDisabled },
    ] },
  { id: 'teacher-overview-stats', name: 'TeacherOverviewStats', description: '教师概览的摘要统计。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/Overview.tsx', exampleSource: exampleSource,
    props: ['stats: TeacherStatistic[]'], dependencies: [teacherStyles, '数量和不可用状态由宿主提供'], states: [
      { id: 'values', name: '示例数量', component: StatsReady, viewport: 'wide' }, { id: 'unknown', name: '数据不可用', component: StatsUnknown, viewport: 'wide' },
    ] },
  { id: 'teacher-overview-columns', name: 'TeacherOverviewColumns', description: '概览关注面板与设计面板的布局容器。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/Overview.tsx', exampleSource: exampleSource,
    props: ['children: ReactNode'], dependencies: [teacherStyles], states: [{ id: 'columns', name: '双栏', component: OverviewColumnsDemo, viewport: 'wide', height: 520 }] },
  { id: 'teacher-attention-panel', name: 'TeacherAttentionPanel', description: '待关注学生列表和空状态。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/Overview.tsx', exampleSource: exampleSource,
    props: ['Link, reviewTo', 'items: TeacherAttentionItem[]'], dependencies: [teacherStyles, '学生与深链由宿主提供'], states: [
      { id: 'list', name: '有待审阅', component: AttentionList }, { id: 'empty', name: '无待审阅', component: AttentionEmpty },
    ] },
  { id: 'teacher-design-card', name: 'TeacherDesignCard', description: '新建设计或继续示例草稿。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/Overview.tsx', exampleSource: exampleSource,
    props: ['Link, draft?: TeacherResumeDraft', 'disabled?, onCreateProject'], dependencies: [teacherStyles, '草稿和操作由宿主提供'], states: [
      { id: 'draft', name: '继续草稿', component: DesignDraft }, { id: 'empty', name: '新建项目', component: DesignEmpty }, { id: 'disabled', name: '不可新建', component: DesignDisabled },
    ] },
  { id: 'teacher-course-card', name: 'TeacherCourseCard', description: '课程封面、活动数量与查看入口。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/Overview.tsx', exampleSource: exampleSource,
    props: ['course: TeacherCourseCardData', 'onView: (id: string) => void'], dependencies: [teacherStyles], states: [
      { id: 'c', name: '示例程序设计', component: CourseCardC, height: 500 }, { id: 'hdl', name: '示例数字逻辑', component: CourseCardHdl, height: 500 },
    ] },
  { id: 'teacher-courses-section', name: 'TeacherCoursesSection', description: '课程卡列表及空态。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/Overview.tsx', exampleSource: exampleSource,
    props: ['Link, projectsTo', 'courses: TeacherCourseCardData[], onViewCourse'], dependencies: [teacherStyles], states: [
      { id: 'courses', name: '课程列表', component: CoursesPopulated, viewport: 'wide', height: 600 }, { id: 'empty', name: '无课程', component: CoursesEmpty },
    ] },
  { id: 'teacher-project-grid', name: 'TeacherProjectGrid', description: '教师项目卡网格容器。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/Projects.tsx', exampleSource: exampleSource,
    props: ['children: ReactNode'], dependencies: [teacherStyles, '@xunjie/ui/teacher 的 ProjectCard'], states: [{ id: 'cards', name: '示例卡片', component: ProjectGridDemo, viewport: 'wide', height: 620 }] },
  { id: 'teacher-course-filter', name: 'TeacherCourseFilter', description: '当前课程筛选及清除入口。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/Projects.tsx', exampleSource: exampleSource,
    props: ['courseTitle: string', 'onClear: () => void'], dependencies: [teacherStyles], states: [{ id: 'selected', name: '课程筛选 / 清除', component: CourseFilterDemo }] },
  { id: 'teacher-projects-toolbar', name: 'TeacherProjectsToolbar', description: '受控活动状态筛选和搜索。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/Projects.tsx', exampleSource: exampleSource,
    props: ['tabs: TeacherProjectTab[], selectedTab, onSelectTab', 'query, onQueryChange'], dependencies: [teacherStyles, '筛选计数和结果由宿主计算'], states: [
      { id: 'all', name: '全部活动', component: ToolbarAll }, { id: 'no-results', name: '搜索无结果', component: ToolbarNoResults },
    ] },
  { id: 'teacher-fixed-activity', name: 'TeacherFixedActivity', description: '真实固定活动的展示数据结构。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/ActivityDetail.tsx', exampleSource: exampleSource,
    props: ['fixed: TeacherFixedActivityView'], dependencies: [teacherStyles, '@xunjie/ui/styles/teacher/review-materials.css', '示例包含可查看、隐藏及不可用材料'], states: [{ id: 'materials', name: '固定活动与材料状态', component: FixedActivityDemo, height: 700 }] },
  { id: 'teacher-preview-activity', name: 'TeacherPreviewActivity', description: '本机预览快照的要求与材料。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/ActivityDetail.tsx', exampleSource: exampleSource,
    props: ['snapshot: TeacherPreviewActivityView'], dependencies: [teacherStyles, '示例快照不代表真实活动'], states: [
      { id: 'materials', name: '有示例材料', component: PreviewActivityFilled, height: 700 }, { id: 'empty-materials', name: '无材料', component: PreviewActivityEmpty, height: 700 },
    ] },
  { id: 'teacher-preview-assignments', name: 'TeacherPreviewAssignments', description: '预览模式的示例学生分配。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/ActivityDetail.tsx', exampleSource: exampleSource,
    props: ['assignments: TeacherPreviewAssignment[]'], dependencies: [teacherStyles], states: [
      { id: 'assigned', name: '示例分配', component: AssignmentsFilled }, { id: 'empty', name: '无分配', component: AssignmentsEmpty },
    ] },
  { id: 'teacher-activity-detail', name: 'TeacherActivityDetail', description: '真实固定活动与预览快照的详情内容。', importPath: shellImport, source: 'packages/ui/src/teacher-shell/ActivityDetail.tsx', exampleSource: exampleSource,
    props: ['statusLabel, statusTone, description, activityId, courseTitle?, assigned, versionLabel', 'fixed?, snapshot?, previewAssignments?, showPreviewSummaryNote, onClose'], dependencies: [teacherStyles, '@xunjie/ui/styles/teacher/review-materials.css', '示例通过 @xunjie/ui/teacher 的 TeacherDialog Portal 展示'], states: [
      { id: 'real', name: '真实活动展示结构', component: ActivityDetailReal, height: 700 }, { id: 'preview', name: '预览快照', component: ActivityDetailPreview, height: 700 }, { id: 'summary', name: '预置摘要', component: ActivityDetailSummary, height: 600 },
    ] },
]
