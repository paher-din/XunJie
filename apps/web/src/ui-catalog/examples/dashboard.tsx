import { useState, type ComponentType, type MouseEvent, type ReactNode } from 'react'
import {
  BadgesWidget, Bars7Widget, DASHBOARD_WIDGETS, DashboardSection, EmptyWidget, HeatDaily, HeatWeekly,
  HeatWidget, MasteryWidget, MosaicWidget, PunchWidget, RadarWidget, RingWidget, StreakWidget,
  TaskProgressWidget, TimelineWidget, TrendWidget, XpWidget, defaultDashboardLayout,
  type DashboardData, type DashboardTask, type SemDay, type WidgetProps,
} from '@xunjie/ui/dashboard'
import type { CatalogEntry } from '../types'

const dashboard = '@xunjie/ui/dashboard'
const widgetsSource = 'packages/ui/src/dashboard/widgets.tsx'
const sectionSource = 'packages/ui/src/dashboard/DashboardSection.tsx'
const exampleSource = 'apps/web/src/ui-catalog/examples/dashboard.tsx'
const now = new Date(2026, 1, 4, 12)
const days: SemDay[] = Array.from({ length: 35 }, (_, index) => ({ d: new Date(2026, 0, index + 1), v: index % 5 === 0 ? 0 : (index % 4 + 1) / 2 }))
const key = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const weeks: SemDay[][] = Array.from({ length: 5 }, (_, index) => days.slice(index * 7, index * 7 + 7))
const data: DashboardData = {
  semesterStart: '2026-01-01', activity: days.map(day => ({ date: key(day.d), hours: day.v })),
  compositionTotalHours: 12, composition: [{ label: '阅读', percent: 40, tone: 'a' }, { label: '实践', percent: 35, tone: 'b' }, { label: '交流', percent: 25, tone: 'c' }],
  badges: [{ icon: '初', label: '示例徽章', unlocked: true, tone: 0 }, { icon: '7', label: '待解锁', unlocked: false, tone: 1 }],
  radar: ['分析', '设计', '实践', '表达', '合作', '反思'].map((axis, index) => ({ axis, value: 0.4 + index * 0.08 })),
  milestones: [{ name: '示例起点', note: '准备', state: 'done' }, { name: '示例阶段', note: '进行中', state: 'now' }, { name: '示例目标', note: '接下来', state: 'next' }],
  mastery: [{ label: '概念 A', percent: 60 }, { label: '概念 B', percent: 35 }],
  xp: { level: 2, total: 240, today: 20, nextLevelRemaining: 60, nextLevelProgress: 70 },
  punch: Array.from({ length: 7 }, (_, day) => Array.from({ length: 24 }, (_, hour) => (day + hour) % 7 === 0 ? 1 : 0)),
}
const tasks: DashboardTask[] = [{ name: '示例项目一', status: '已完成', lastStudiedAt: '2026-02-03' }, { name: '示例项目二', status: '进行中', lastStudiedAt: null }]

function PreviewFrame({ children }: { children: ReactNode }) {
  return <div style={{ width: 'min(100%, 760px)', padding: 24 }}><p style={{ color: 'var(--muted)', fontSize: 12 }}>以下均为合成示例数据</p>{children}</div>
}
function WidgetFrame({ component: Component, empty = false }: { component: ComponentType<WidgetProps>; empty?: boolean }) {
  const [tip, setTip] = useState('')
  const bindTip: WidgetProps['bindTip'] = text => ({ onMouseEnter: () => setTip(text), onMouseLeave: () => setTip('') })
  const props: WidgetProps = { data: empty ? {} : data, tasks: empty ? null : tasks, now, bindTip,
    showTip: (_x, _y, text) => setTip(text), hideTip: () => setTip('') }
  return <PreviewFrame><div className="dash-grid" style={{ display: 'block' }}><div className="db-card" style={{ minHeight: 250 }}><Component {...props} /></div></div><output>{tip}</output></PreviewFrame>
}
function makeWidget(component: ComponentType<WidgetProps>, empty = false) { return function WidgetExample() { return <WidgetFrame component={component} empty={empty} /> } }
const BadgesDemo = makeWidget(BadgesWidget), BadgesEmpty = makeWidget(BadgesWidget, true)
const BarsDemo = makeWidget(Bars7Widget), BarsEmpty = makeWidget(Bars7Widget, true)
const HeatDemo = makeWidget(HeatWidget), HeatEmpty = makeWidget(HeatWidget, true)
const MasteryDemo = makeWidget(MasteryWidget), MasteryEmpty = makeWidget(MasteryWidget, true)
const MosaicDemo = makeWidget(MosaicWidget), MosaicEmpty = makeWidget(MosaicWidget, true)
const PunchDemo = makeWidget(PunchWidget), PunchEmpty = makeWidget(PunchWidget, true)
const RadarDemo = makeWidget(RadarWidget), RadarEmpty = makeWidget(RadarWidget, true)
const RingDemo = makeWidget(RingWidget), RingEmpty = makeWidget(RingWidget, true)
const StreakDemo = makeWidget(StreakWidget), StreakEmpty = makeWidget(StreakWidget, true)
const ProgressDemo = makeWidget(TaskProgressWidget), ProgressEmpty = makeWidget(TaskProgressWidget, true)
const TimelineDemo = makeWidget(TimelineWidget), TimelineEmpty = makeWidget(TimelineWidget, true)
const TrendDemo = makeWidget(TrendWidget), TrendEmpty = makeWidget(TrendWidget, true)
const XpDemo = makeWidget(XpWidget), XpEmpty = makeWidget(XpWidget, true)
function EmptyDemo() { return <PreviewFrame><div className="db-card" style={{ height: 220 }}><EmptyWidget>暂无示例统计</EmptyWidget></div></PreviewFrame> }
function HeatDailyDemo() {
  const [tip, setTip] = useState('')
  const bindTip = (text: string) => ({ onMouseEnter: (_event: MouseEvent<Element>) => setTip(text), onMouseLeave: () => setTip('') })
  return <PreviewFrame><div className="db-card" style={{ height: 270 }}><HeatDaily weeks={weeks} todayKey={key(now)} bindTip={bindTip} /></div><output>{tip}</output></PreviewFrame>
}
function HeatWeeklyDemo() {
  const [tip, setTip] = useState('')
  return <PreviewFrame><div className="db-card" style={{ height: 270 }}><HeatWeekly weeks={weeks} showTip={(_x, _y, text) => setTip(text)} hideTip={() => setTip('')} /></div><output>{tip}</output></PreviewFrame>
}
function DashboardDemo({ empty = false }: { empty?: boolean }) {
  const [layout, setLayout] = useState(defaultDashboardLayout)
  return <PreviewFrame><DashboardSection data={empty ? {} : data} tasks={empty ? null : tasks} now={now} layout={layout} onLayoutChange={setLayout}
    periodLabel="示例周期" editHint="示例布局仅保存在当前预览中" /></PreviewFrame>
}
function DashboardPopulated() { return <DashboardDemo /> }
function DashboardEmpty() { return <DashboardDemo empty /> }
function DashboardRegistryDemo() {
  const [id, setId] = useState('heat')
  const [tip, setTip] = useState('')
  const bindTip: WidgetProps['bindTip'] = text => ({ onMouseEnter: () => setTip(text), onMouseLeave: () => setTip('') })
  const props: WidgetProps = { data, tasks, now, bindTip, showTip: (_x, _y, text) => setTip(text), hideTip: () => setTip('') }
  return <PreviewFrame><label>看板配置项 <select value={id} onChange={event => setId(event.target.value)}>{Object.entries(DASHBOARD_WIDGETS).map(([value, widget]) => <option key={value} value={value}>{widget.name}</option>)}</select></label>
    <div className="db-card" style={{ height: 270, marginTop: 16 }}>{DASHBOARD_WIDGETS[id].render(props)}</div><output>{tip}</output></PreviewFrame>
}

export const dashboardEntries: CatalogEntry[] = [
  { id: 'badges-widget', name: 'BadgesWidget', description: '示例徽章及解锁状态。', importPath: dashboard, source: widgetsSource, exampleSource, props: ['data.badges'], dependencies: ['传入的统计均为合成示例'], states: [{ id: 'sample', name: '示例数据', component: BadgesDemo }, { id: 'empty', name: '无数据', component: BadgesEmpty }] },
  { id: 'bars7-widget', name: 'Bars7Widget', description: '近七日示例时长柱图。', importPath: dashboard, source: widgetsSource, exampleSource, props: ['data.activity, now, bindTip'], dependencies: ['合成示例'], states: [{ id: 'sample', name: '示例数据', component: BarsDemo }, { id: 'empty', name: '无数据', component: BarsEmpty }] },
  { id: 'dashboard-widgets', name: 'DASHBOARD_WIDGETS', description: '看板配置注册表；选择条目渲染其正式组件。', importPath: dashboard, source: sectionSource, exampleSource, props: ['name, span?, render'], dependencies: ['这是配置对象，渲染函数接收 WidgetProps'], states: [{ id: 'registry', name: '选择配置项', component: DashboardRegistryDemo }] },
  { id: 'dashboard-section', name: 'DashboardSection', description: '受控看板及编辑托盘。', importPath: dashboard, source: sectionSource, exampleSource, props: ['data, tasks, now, layout, onLayoutChange', 'periodLabel, editHint'], dependencies: ['布局只保存在示例内存'], states: [{ id: 'sample', name: '示例数据', component: DashboardPopulated }, { id: 'empty', name: '无数据', component: DashboardEmpty }] },
  { id: 'empty-widget', name: 'EmptyWidget', description: '看板空态。', importPath: dashboard, source: widgetsSource, exampleSource, props: ['children'], dependencies: [], states: [{ id: 'empty', name: '空态', component: EmptyDemo }] },
  { id: 'heat-daily', name: 'HeatDaily', description: '每日热力网格。', importPath: dashboard, source: widgetsSource, exampleSource, props: ['weeks, todayKey, bindTip'], dependencies: ['需要可测量宽高的容器'], states: [{ id: 'sample', name: '示例数据', component: HeatDailyDemo }] },
  { id: 'heat-weekly', name: 'HeatWeekly', description: '每周时长曲线。', importPath: dashboard, source: widgetsSource, exampleSource, props: ['weeks, showTip, hideTip'], dependencies: ['需要可测量宽高的容器'], states: [{ id: 'sample', name: '示例数据', component: HeatWeeklyDemo }] },
  { id: 'heat-widget', name: 'HeatWidget', description: '每日与每周视图切换。', importPath: dashboard, source: widgetsSource, exampleSource, props: ['data.activity, now, tooltip 回调'], dependencies: ['合成示例'], states: [{ id: 'sample', name: '示例数据', component: HeatDemo }, { id: 'empty', name: '无数据', component: HeatEmpty }] },
  { id: 'mastery-widget', name: 'MasteryWidget', description: '示例掌握度列表。', importPath: dashboard, source: widgetsSource, exampleSource, props: ['data.mastery'], dependencies: ['合成示例'], states: [{ id: 'sample', name: '示例数据', component: MasteryDemo }, { id: 'empty', name: '无数据', component: MasteryEmpty }] },
  { id: 'mosaic-widget', name: 'MosaicWidget', description: '示例投入构成。', importPath: dashboard, source: widgetsSource, exampleSource, props: ['data.composition, data.compositionTotalHours, bindTip'], dependencies: ['合成示例'], states: [{ id: 'sample', name: '示例数据', component: MosaicDemo }, { id: 'empty', name: '无数据', component: MosaicEmpty }] },
  { id: 'punch-widget', name: 'PunchWidget', description: '示例周时段矩阵。', importPath: dashboard, source: widgetsSource, exampleSource, props: ['data.punch, bindTip'], dependencies: ['合成示例'], states: [{ id: 'sample', name: '示例数据', component: PunchDemo }, { id: 'empty', name: '无数据', component: PunchEmpty }] },
  { id: 'radar-widget', name: 'RadarWidget', description: '示例能力雷达。', importPath: dashboard, source: widgetsSource, exampleSource, props: ['data.radar'], dependencies: ['合成示例'], states: [{ id: 'sample', name: '示例数据', component: RadarDemo }, { id: 'empty', name: '无数据', component: RadarEmpty }] },
  { id: 'ring-widget', name: 'RingWidget', description: '任务完成环。', importPath: dashboard, source: widgetsSource, exampleSource, props: ['tasks: DashboardTask[] | null'], dependencies: ['null 表示未知'], states: [{ id: 'sample', name: '示例数据', component: RingDemo }, { id: 'unknown', name: '未知', component: RingEmpty }] },
  { id: 'streak-widget', name: 'StreakWidget', description: '连续学习展示。', importPath: dashboard, source: widgetsSource, exampleSource, props: ['data.activity, now'], dependencies: ['合成示例'], states: [{ id: 'sample', name: '示例数据', component: StreakDemo }, { id: 'empty', name: '无数据', component: StreakEmpty }] },
  { id: 'task-progress-widget', name: 'TaskProgressWidget', description: '任务完成数量与进度。', importPath: dashboard, source: widgetsSource, exampleSource, props: ['tasks, taskCount?'], dependencies: ['null 表示未知'], states: [{ id: 'sample', name: '示例数据', component: ProgressDemo }, { id: 'unknown', name: '未知', component: ProgressEmpty }] },
  { id: 'timeline-widget', name: 'TimelineWidget', description: '示例里程碑。', importPath: dashboard, source: widgetsSource, exampleSource, props: ['data.milestones'], dependencies: ['合成示例'], states: [{ id: 'sample', name: '示例数据', component: TimelineDemo }, { id: 'empty', name: '无数据', component: TimelineEmpty }] },
  { id: 'trend-widget', name: 'TrendWidget', description: '示例学习时长趋势。', importPath: dashboard, source: widgetsSource, exampleSource, props: ['data.activity'], dependencies: ['合成示例'], states: [{ id: 'sample', name: '示例数据', component: TrendDemo }, { id: 'empty', name: '无数据', component: TrendEmpty }] },
  { id: 'xp-widget', name: 'XpWidget', description: '示例等级与经验值。', importPath: dashboard, source: widgetsSource, exampleSource, props: ['data.xp'], dependencies: ['合成示例'], states: [{ id: 'sample', name: '示例数据', component: XpDemo }, { id: 'empty', name: '无数据', component: XpEmpty }] },
]
