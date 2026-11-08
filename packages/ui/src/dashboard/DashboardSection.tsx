import { Icon, IconText } from '../icons'
import { useEffect, useState } from 'react'
import type { DashboardData, DashboardTask } from './types'
import {
  BadgesWidget,
  Bars7Widget,
  HeatWidget,
  MasteryWidget,
  MosaicWidget,
  PunchWidget,
  RadarWidget,
  RingWidget,
  StreakWidget,
  TaskProgressWidget,
  TimelineWidget,
  TrendWidget,
  WidgetProps,
  XpWidget,
} from './widgets'

export interface WidgetDef {
  name: string
  span?: boolean
  render: (p: WidgetProps) => React.ReactNode
}

/** 看板组件注册表：默认上板 2 个，其余进个性化编辑托盘。 */
export const DASHBOARD_WIDGETS: Record<string, WidgetDef> = {
  heat: { name: '学习活动热力图', render: (p) => <HeatWidget {...p} /> },
  progress: { name: '任务完成', render: (p) => <TaskProgressWidget {...p} /> },
  mosaic: { name: '学习投入构成', render: (p) => <MosaicWidget {...p} /> },
  badges: { name: '成就徽章', render: (p) => <BadgesWidget {...p} /> },
  radar: { name: '知识掌握雷达', render: (p) => <RadarWidget {...p} /> },
  timeline: { name: '里程碑时间线', render: (p) => <TimelineWidget {...p} /> },
  punch: { name: '周节奏气泡矩阵', span: true, render: (p) => <PunchWidget {...p} /> },
  trend: { name: '近 30 天趋势', span: true, render: (p) => <TrendWidget {...p} /> },
  ring: { name: '任务完成环', render: (p) => <RingWidget {...p} /> },
  streak: { name: '连续学习火焰', render: (p) => <StreakWidget {...p} /> },
  mastery: { name: '知识点掌握度', render: (p) => <MasteryWidget {...p} /> },
  xp: { name: '成长等级', render: (p) => <XpWidget {...p} /> },
  bars7: { name: '近 7 日柱状', render: (p) => <Bars7Widget {...p} /> },
}

export const DEFAULT_BOARD = ['progress', 'heat']
export const DEFAULT_TRAY = ['mosaic', 'badges', 'radar', 'timeline', 'punch', 'trend', 'ring', 'streak', 'mastery', 'xp', 'bars7']

export interface DashboardLayout { board: string[]; tray: string[] }
/** 初始布局只包含组件标识，不包含业务统计。 */
export function defaultDashboardLayout(): DashboardLayout {
  return { board: [...DEFAULT_BOARD], tray: [...DEFAULT_TRAY] }
}

export interface DashboardSectionProps {
  data: Partial<DashboardData>
  tasks: DashboardTask[] | null
  taskCount?: number
  now: Date
  continueSlot?: React.ReactNode
  layout: DashboardLayout
  onLayoutChange: (layout: DashboardLayout) => void
  periodLabel: string
  periodTitle?: string
  taskCountLabel?: string
  editHint: string
}

export function DashboardSection({
  data,
  tasks,
  taskCount,
  now,
  continueSlot,
  layout,
  onLayoutChange,
  periodLabel,
  periodTitle,
  taskCountLabel,
  editHint,
}: DashboardSectionProps) {
  const [editing, setEditing] = useState(false)
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const { board, tray } = layout

  // 悬停提示锚定在元素本身上方，而不是跟随鼠标，避免间隙/视差造成的错位感
  const bindTip = (text: string) => ({
    onMouseEnter: (e: React.MouseEvent<Element>) => {
      const r = e.currentTarget.getBoundingClientRect()
      setTip({ x: r.left + r.width / 2, y: r.top, text })
    },
    onMouseLeave: () => setTip(null),
  })
  const showTip = (x: number, y: number, text: string) => setTip({ x, y, text })
  const hideTip = () => setTip(null)

  useEffect(() => {
    const clear = () => setTip(null)
    window.addEventListener('scroll', clear, true)
    window.addEventListener('resize', clear)
    return () => {
      window.removeEventListener('scroll', clear, true)
      window.removeEventListener('resize', clear)
    }
  }, [])

  const props: WidgetProps = { data, tasks, taskCount, now, bindTip, showTip, hideTip }

  return (
    <section className={`dash-section${editing ? ' editing' : ''}`}>
      <div className="dash-sec-head">
        <h2>学习看板</h2>
        <span className="period" title={periodTitle}>
          {periodLabel}
        </span>
        {taskCountLabel !== undefined && <span className="db-side">{taskCountLabel}</span>}
        <button className="outline db-edit-btn" onClick={() => setEditing((v) => !v)}>
          <IconText name={editing ? 'check' : 'pen'}>{editing ? '完成' : '编辑'}</IconText>
        </button>
      </div>
      {editing && (
        <div className="db-edit-hint">
          {editHint}
        </div>
      )}
      <div className="dash-grid">
        {board.map((id) => {
          const w = DASHBOARD_WIDGETS[id]
          return (
            <div key={id} className={`db-card${w.span ? ' span2' : ''}`}>
              {editing && (
                <button
                  className="db-rm"
                  title="移出看板"
                  onClick={() =>
                    onLayoutChange({ board: board.filter((x) => x !== id), tray: [...tray, id] })
                  }
                >
                  <Icon name="close" size={12} />
                </button>
              )}
              {w.render(props)}
              {id === 'progress' && continueSlot}
            </div>
          )
        })}
      </div>
      {editing && (
        <div className="db-tray">
          <span className="t-label">可添加组件</span>
          {tray.length === 0 && <span className="t-empty">已全部上板</span>}
          {tray.map((id) => (
            <span key={id} className="t-item">
              {DASHBOARD_WIDGETS[id].name}
              <button
                title="添加到看板"
                onClick={() =>
                  onLayoutChange({ board: [...board, id], tray: tray.filter((x) => x !== id) })
                }
              >
                <Icon name="add" size={14} />
              </button>
            </span>
          ))}
        </div>
      )}
      {tip && (
        <div
          className="db-tip"
          style={{ left: tip.x, top: tip.y - 8, transform: 'translate(-50%, -100%)' }}
        >
          {tip.text}
        </div>
      )}
    </section>
  )
}
