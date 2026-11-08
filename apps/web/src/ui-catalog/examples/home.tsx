import { useRef, useState } from 'react'
import {
  ContinueTaskCard, CourseBreadcrumb, CourseTile, CourseTiles, HomeCourseRegion, HomeIntro,
  HomeSectionHeading, HomeStatus, HomeTaskCard, LearningCardGrid, LearningTaskCard,
  PreparationEntryCard, TaskToolbar, useFluidHover,
} from '@xunjie/ui/home'
import { FluidHighlight, StatusChip } from '@xunjie/ui/foundation'
import type { CatalogEntry } from '../types'

const importPath = '@xunjie/ui/home'
const exampleSource = 'apps/web/src/ui-catalog/examples/home.tsx'
const sectionsSource = 'packages/ui/src/home/HomeSections.tsx'
const cardsSource = 'packages/ui/src/home/LearningCards.tsx'
const primitivesSource = 'packages/ui/src/home/HomePrimitives.tsx'
const courses = ['示例：C 程序设计', '示例：数字逻辑', '示例：数据结构']

function ContinueDemo({ progress = false }: { progress?: boolean }) {
  const [opened, setOpened] = useState(false)
  return <div className="demo-stack" style={{ width: 'min(480px, 90vw)' }}>
    <div className="db-card" style={{ width: '100%' }}><ContinueTaskCard tag={`项目任务 · ${courses[0]}`} title="示例：统计文本中的词频"
      description={progress ? '已完成分词，接下来检查边界输入。' : undefined}
      meta={progress ? '40%' : '当前获准任务'} metaClassName={progress ? 'pct' : 'db-side'} action={progress ? '继续任务' : '进入任务'} onOpen={() => setOpened(true)} /></div>
    <output>{opened ? '示例：已触发打开任务回调，无页面跳转。' : '本页内存中的示例任务'}</output>
  </div>
}
function BreadcrumbDemo() {
  const [event, setEvent] = useState('')
  return <div className="demo-stack"><CourseBreadcrumb title={courses[1]} onBack={keyboard => setEvent(keyboard ? '键盘返回' : '指针返回')} /><output>{event}</output></div>
}
function SingleCourse({ tone = 0 }: { tone?: number }) {
  const ref = useRef<HTMLDivElement>(null), hover = useFluidHover(ref)
  const [opened, setOpened] = useState('')
  return <div className="demo-stack" style={{ width: 'min(420px, 90vw)' }}><div className="course-tiles" ref={ref} {...hover.handlers} style={{ width: '100%' }}>
    <FluidHighlight activeIndex={hover.activeIndex} rects={hover.itemRects} className="card-grid-highlight" />
    <CourseTile id="sample-course" title={courses[tone]} summary={tone === 2 ? '暂无待完成任务' : '2 个待完成'} tone={tone} index={0} register={hover.registerItem}
      onOpen={keyboard => setOpened(keyboard ? '键盘打开课程' : '指针打开课程')} />
  </div><output>{opened}</output></div>
}
function CoursesDemo({ empty = false }: { empty?: boolean }) {
  const [opened, setOpened] = useState('')
  return <div style={{ width: '100%', padding: 24 }}><CourseTiles courses={empty ? [] : courses} toneOf={id => courses.indexOf(id)} summaryOf={id => id === courses[2] ? '暂无待完成任务' : '2 个待完成'}
    onOpen={(id, keyboard) => setOpened(`${id} · ${keyboard ? '键盘' : '指针'}`)} />
    {empty && <HomeStatus kind="empty" message="示例：课程列表为空" />}<output>{opened}</output></div>
}
function CourseRegionDemo() {
  const [selected, setSelected] = useState(false), regionRef = useRef<HTMLDivElement>(null), headingRef = useRef<HTMLHeadingElement>(null)
  return <div className="home-page" style={{ width: '100%', padding: 24 }}><HomeCourseRegion selected={selected} regionRef={regionRef}>
    <HomeSectionHeading title={selected ? '课程与任务' : '我的课程'} count={selected ? '2 个任务' : '3 门'} headingRef={headingRef} />
    {selected ? <><CourseBreadcrumb title={courses[0]} onBack={() => { setSelected(false); headingRef.current?.focus() }} /><HomeStatus kind="empty" message="示例：选择了课程，业务列表由宿主提供" /></>
      : <CourseTiles courses={courses} toneOf={id => courses.indexOf(id)} summaryOf={() => '2 个示例任务'} onOpen={() => setSelected(true)} />}
  </HomeCourseRegion></div>
}
function IntroDemo({ evening = false }: { evening?: boolean }) {
  return <div style={{ width: '100%', padding: 24 }}><HomeIntro title={`${evening ? '晚上好' : '上午好'}，示例同学`} date="11 月 8 日" /></div>
}
function HeadingDemo({ disabled = false }: { disabled?: boolean }) {
  const [count, setCount] = useState(0)
  return <div style={{ width: '100%', padding: 24 }}><HomeSectionHeading title="课程与任务" count="3 个任务" refresh={{ disabled, onRefresh: () => setCount(value => value + 1) }} /><output>本地刷新回调 {count} 次</output></div>
}
function ErrorDemo() {
  const [retry, setRetry] = useState(false)
  return <HomeStatus kind={retry ? 'loading' : 'error'} message={retry ? '示例：重新读取中…' : '示例：任务暂时无法读取'} retry={{ disabled: false, onRetry: () => setRetry(true) }} />
}
function TaskDemo({ mode = 'progress', primitive = false }: { mode?: 'progress' | 'done' | 'unknown' | 'overdue'; primitive?: boolean }) {
  const [opened, setOpened] = useState(false)
  return <div className="demo-stack" style={{ width: 'min(460px, 90vw)' }}><LearningCardGrid>{register => primitive ? <LearningTaskCard title="示例：文本分析" goal="用清晰的测试描述输入边界。" index={0} register={register}
    action="打开示例" onOpen={() => setOpened(true)} badge={<StatusChip status="进行中" />} footer="示例课程">
    <p>这是调用方提供的任务内容插槽。</p>
  </LearningTaskCard> : <HomeTaskCard title="示例：文本分析" goal="分析空输入、重复词与标点。" register={register} index={0}
    status={mode === 'done' ? '已完成' : mode === 'unknown' ? '已分配' : '进行中'} overdue={mode === 'overdue'}
    progress={mode === 'unknown' ? undefined : { percent: mode === 'done' ? 100 : 40, done: mode === 'done' }}
    footer={mode === 'overdue' ? '截止 11 月 1 日' : '示例：没有真实截止约束'} action={mode === 'done' ? '查看任务' : '进入任务'} onOpen={() => setOpened(true)} />}</LearningCardGrid>
    <output>{opened ? '已触发示例任务回调' : '所有进度均为明确的内存示例'}</output></div>
}
function GridDemo() {
  const [selected, setSelected] = useState('')
  return <div style={{ width: '100%', padding: 24 }}><LearningCardGrid>{register => <>{courses.map((course, index) => <LearningTaskCard key={course} title={`${course} · 任务`} goal="示例任务内容" index={index} register={register}
    action="查看示例" onOpen={() => setSelected(course)} footer="本地示例" />)}</>}</LearningCardGrid><output>{selected}</output></div>
}
function PreparationDemo() {
  const [opened, setOpened] = useState(false)
  return <div style={{ width: '100%', padding: 24 }}><PreparationEntryCard flag="独立目录示例" title="示例：数字逻辑准备" description="观察四位加法器的输入与输出。" note="仅使用内存，不创建真实学习活动。"
    action="进入示例" onOpen={() => setOpened(true)} /><output>{opened ? '已触发示例打开回调' : ''}</output></div>
}
function ToolbarDemo({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState('全部'), [query, setQuery] = useState(initial)
  return <div style={{ width: '100%', padding: 24 }}><TaskToolbar filters={['全部', '进行中', '已完成']} value={value} query={query} onFilter={setValue} onQuery={setQuery} />
    <output>示例筛选：{value}；搜索：{query || '空'}</output></div>
}

export const homeEntries: CatalogEntry[] = [
  { id: 'continue-task-card', name: 'ContinueTaskCard', description: '继续任务内嵌卡，区分未知完成度与明确示例进度。', importPath, source: primitivesSource, exampleSource, props: ['tag/title/description', 'meta/metaClassName/action/onOpen'], dependencies: ['Button', 'IconText'], states: [
    { id: 'assigned', name: '已分配，无进度', component: () => <ContinueDemo /> }, { id: 'progress', name: '带进度说明', component: () => <ContinueDemo progress /> },
  ] },
  { id: 'course-breadcrumb', name: 'CourseBreadcrumb', description: '课程返回入口，显示键盘与指针回调差异。', importPath, source: sectionsSource, exampleSource, props: ['title/onBack(keyboard)'], dependencies: ['IconText'], states: [{ id: 'interactive', name: '返回与键盘操作', component: BreadcrumbDemo }] },
  { id: 'course-tile', name: 'CourseTile', description: '独立课程卡，提供实际注册 ref 与布局。', importPath, source: cardsSource, exampleSource, props: ['id/title/summary/tone', 'index/register/onOpen'], dependencies: ['Icon', 'useFluidHover'], states: [
    { id: 'pending', name: '有待完成任务', component: () => <SingleCourse /> }, { id: 'clear', name: '无待完成任务', component: () => <SingleCourse tone={2} /> },
  ] },
  { id: 'course-tiles', name: 'CourseTiles', description: '多课程卡组与共享悬停高亮。', importPath, source: cardsSource, exampleSource, props: ['courses/toneOf/titleOf/summaryOf/onOpen'], dependencies: ['CourseTile', 'FluidHighlight'], states: [
    { id: 'courses', name: '三类封面与打开回调', component: () => <CoursesDemo /> }, { id: 'empty', name: '空数组，由宿主提供空态', component: () => <CoursesDemo empty /> },
  ] },
  { id: 'home-course-region', name: 'HomeCourseRegion', description: '课程选择区域与定位 ref。', importPath, source: sectionsSource, exampleSource, props: ['selected/regionRef/children'], dependencies: ['HomeSectionHeading', 'CourseTiles'], states: [{ id: 'selection', name: '选择／返回课程', component: CourseRegionDemo }] },
  { id: 'home-intro', name: 'HomeIntro', description: '问候与日期由调用方明确提供。', importPath, source: sectionsSource, exampleSource, props: ['title/date'], dependencies: [], states: [
    { id: 'morning', name: '上午问候', component: () => <IntroDemo /> }, { id: 'evening', name: '晚间问候', component: () => <IntroDemo evening /> },
  ] },
  { id: 'home-section-heading', name: 'HomeSectionHeading', description: '区域标题、数量与刷新操作。', importPath, source: sectionsSource, exampleSource, props: ['title/count/headingRef/refresh'], dependencies: [], states: [
    { id: 'refresh', name: '刷新回调', component: () => <HeadingDemo /> }, { id: 'disabled', name: '刷新禁用', component: () => <HeadingDemo disabled /> },
  ] },
  { id: 'home-status', name: 'HomeStatus', description: '读取、失败重试和空结果状态。', importPath, source: sectionsSource, exampleSource, props: ['kind/message/searchIcon/retry'], dependencies: ['Icon'], states: [
    { id: 'loading', name: '读取中', component: () => <HomeStatus kind="loading" message="示例：正在读取任务…" /> }, { id: 'error', name: '失败／重试', component: ErrorDemo },
    { id: 'empty', name: '空结果', component: () => <HomeStatus kind="empty" searchIcon message="示例：此课程没有匹配的任务" /> },
  ] },
  { id: 'home-task-card', name: 'HomeTaskCard', description: '完整任务内容、状态、逾期和可选进度。', importPath, source: sectionsSource, exampleSource, props: ['status/overdue/progress', 'title/goal/footer/action/onOpen'], dependencies: ['LearningTaskCard', 'StatusChip', 'ProgressBar'], states: [
    { id: 'progress', name: '进行中', component: () => <TaskDemo /> }, { id: 'done', name: '已完成', component: () => <TaskDemo mode="done" /> },
    { id: 'unknown', name: '未知进度', component: () => <TaskDemo mode="unknown" /> }, { id: 'overdue', name: '逾期', component: () => <TaskDemo mode="overdue" /> },
  ] },
  { id: 'learning-card-grid', name: 'LearningCardGrid', description: '任务网格与鼠标／键盘高亮注册。', importPath, source: cardsSource, exampleSource, props: ['children(register)'], dependencies: ['FluidHighlight'], states: [{ id: 'interactive', name: '三张任务卡', component: GridDemo }] },
  { id: 'learning-task-card', name: 'LearningTaskCard', description: '可组合的任务卡内容与打开操作。', importPath, source: cardsSource, exampleSource, props: ['title/goal/badge/children/footer', 'register/index/action/onOpen'], dependencies: ['IconText'], states: [
    { id: 'slots', name: '状态与内容插槽', component: () => <TaskDemo primitive /> }, { id: 'grid', name: '无进度的简洁卡片', component: GridDemo },
  ] },
  { id: 'preparation-entry-card', name: 'PreparationEntryCard', description: '准备入口的明确示例文案与本地回调。', importPath, source: sectionsSource, exampleSource, props: ['flag/title/description/note/action/onOpen'], dependencies: ['Icon', 'IconText'], states: [{ id: 'interactive', name: '打开回调', component: PreparationDemo }] },
  { id: 'task-toolbar', name: 'TaskToolbar', description: '受控筛选与搜索；清除后恢复输入焦点。', importPath, source: primitivesSource, exampleSource, props: ['filters/value/onFilter/query/onQuery'], dependencies: ['Icon'], states: [
    { id: 'empty', name: '空搜索', component: () => <ToolbarDemo /> }, { id: 'query', name: '搜索／清除', component: () => <ToolbarDemo initial="示例问题" /> },
  ] },
]
