import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProjectTask } from '../../bridge/types'
import { DashboardSection } from './DashboardSection'
import { demoDashboard, demoTasks } from '../../bridge/mockData'
import { HeatWidget, TaskProgressWidget, TrendWidget, XpWidget, type WidgetProps } from './widgets'

const now = new Date('2026-10-15T10:00:00+08:00')
const props: WidgetProps = {
  data: {}, tasks: null, taskCount: 3, now,
  bindTip: () => ({ onMouseEnter: () => {}, onMouseLeave: () => {} }),
  showTip: () => {}, hideTip: () => {},
}
const task = (id: string, status: ProjectTask['status']): ProjectTask => ({
  id, name: id, status, course: 'C', icon: '', goal: '', last: '',
  stepsDone: 0, stepsTotal: 1, deadlineAt: null, lastStudiedAt: null,
})

describe('原首页看板的真实数据空态', () => {
  it('经明确授权的演示统计使用独立样例分母，真实分配数和任务入口另列', () => {
    const html = renderToStaticMarkup(createElement(DashboardSection, {
      data: demoDashboard, tasks: demoTasks, taskCount: 1, now, demoStatistics: true,
      continueSlot: createElement('button', null, '本人真实任务'),
    }))
    expect(html).toContain('演示统计')
    expect(html).toContain('真实分配 1 个任务')
    expect(html).toContain('/ 8 个任务 · 37.5%')
    expect(html).toContain('db-hm-col')
    expect(html).toContain('本人真实任务')
    expect(html).not.toContain('暂无统计')
    expect(html).not.toMatch(/NaN|undefined/)
  })

  it('保留原看板和内嵌入口，分开显示已知分配数与未知完成进度', () => {
    const html = renderToStaticMarkup(createElement(DashboardSection, {
      data: {}, tasks: null, taskCount: 3, now,
      continueSlot: createElement('button', null, '真实任务入口'),
    }))
    expect(html).toContain('学习看板')
    expect(html).toContain('全部任务')
    expect(html).toContain('—<small> / 3 个任务')
    expect(html).toContain('完成进度暂无统计')
    expect(html).toContain('真实任务入口')
    expect(html).toContain('每日')
    expect(html).toContain('每周')
    expect(html).toContain('暂无学习时长统计')
    expect(html).not.toContain('0%')
    expect(html).not.toMatch(/NaN|undefined/)
  })

  it('保留已提供的真实零及完成率，不把它们改成未知', () => {
    const zero = renderToStaticMarkup(createElement(TaskProgressWidget, { ...props, tasks: [] }))
    expect(zero).toContain('0<small> / 0 个任务 · 0%')
    expect(zero).not.toContain('暂无统计')
    const completed = renderToStaticMarkup(createElement(TaskProgressWidget, {
      ...props, tasks: [task('one', '已完成'), task('two', '进行中')],
    }))
    expect(completed).toContain('1<small> / 2 个任务 · 50%')
    expect(completed).toContain('width:50%')
  })

  it('无时长序列保留切换与空态，真实零时长日期仍显示原热力图', () => {
    const empty = renderToStaticMarkup(createElement(HeatWidget, { ...props, data: { activity: [] } }))
    expect(empty).toContain('暂无学习时长统计')
    expect(empty).not.toMatch(/<svg|NaN|undefined/)
    const zeroDay = renderToStaticMarkup(createElement(HeatWidget, {
      ...props, data: { activity: [{ date: '2026-10-15', hours: 0 }] },
    }))
    expect(zeroDay).toContain('db-hm-col')
    expect(zeroDay).toContain('today')
    expect(zeroDay).not.toContain('暂无学习时长统计')
  })

  it('未接通的趋势与成长等级不生成空曲线或虚构 XP', () => {
    const trend = renderToStaticMarkup(createElement(TrendWidget, props))
    const xp = renderToStaticMarkup(createElement(XpWidget, props))
    expect(trend).toContain('暂无学习时长统计')
    expect(trend).not.toContain('<svg')
    expect(xp).toContain('暂无成长等级统计')
    expect(xp).not.toContain('XP')
  })
})
