import { useEffect, useState } from 'react'
import { DashboardSection as DashboardView, DASHBOARD_WIDGETS, DEFAULT_BOARD, DEFAULT_TRAY, type DashboardSectionProps as ViewProps } from '@xunjie/ui/dashboard'
const LAYOUT_KEY = 'dashboard.layout.v3'

function loadLayout(storageKey: string): { board: string[]; tray: string[] } {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return { board: DEFAULT_BOARD, tray: DEFAULT_TRAY }
    const parsed = JSON.parse(raw) as { board?: unknown; tray?: unknown }
    const valid = (ids: unknown): ids is string[] =>
      Array.isArray(ids) && ids.every((id) => typeof id === 'string' && id in DASHBOARD_WIDGETS)
    if (!valid(parsed.board) || !valid(parsed.tray)) return { board: DEFAULT_BOARD, tray: DEFAULT_TRAY }
    // 注册表新增组件自动补进托盘，保证升级后不丢入口
    const known = new Set([...parsed.board, ...parsed.tray])
    const extra = Object.keys(DASHBOARD_WIDGETS).filter((id) => !known.has(id))
    return { board: parsed.board, tray: [...parsed.tray, ...extra] }
  } catch {
    return { board: DEFAULT_BOARD, tray: DEFAULT_TRAY }
  }
}

export interface DashboardSectionProps extends Omit<ViewProps, 'layout' | 'onLayoutChange' | 'periodLabel' | 'periodTitle' | 'taskCountLabel' | 'editHint'> {
  storageKey?: string
  demoStatistics?: boolean
}
/** 旧入口只保留持久化和统计来源文案；完整看板展示在正式包内。 */
export function DashboardSection({ storageKey = LAYOUT_KEY, demoStatistics = false, ...props }: DashboardSectionProps) {
  const [layout, setLayout] = useState(() => loadLayout(storageKey))
  useEffect(() => { localStorage.setItem(storageKey, JSON.stringify(layout)) }, [layout, storageKey])
  return <DashboardView {...props} layout={layout} onLayoutChange={setLayout}
    periodLabel={demoStatistics ? '演示统计' : props.data.semesterStart ? '本学期' : '全部任务'}
    periodTitle={demoStatistics ? '完成率、学习时长等为演示数据，课程和任务入口来自真实服务' : undefined}
    taskCountLabel={demoStatistics && props.taskCount !== undefined ? `真实分配 ${props.taskCount} 个任务` : undefined}
    editHint="编辑模式：点卡片右上角 ✕ 移出看板；下方托盘可添加其他组件。排布会自动记住。"
  />
}
