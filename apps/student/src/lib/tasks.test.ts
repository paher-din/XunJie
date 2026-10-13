import { describe, expect, it } from 'vitest'
import type { ProjectTask } from '../bridge/types'
import {
  formatDeadline,
  isOverdue,
  pendingCount,
  progressPercent,
  selectContinueTask,
  sortTasks,
} from './tasks'

const NOW = new Date('2026-09-25T16:00:00+08:00')

function task(partial: Partial<ProjectTask> & { id: string }): ProjectTask {
  return {
    name: partial.id,
    course: '课程',
    icon: '▦',
    status: '未开始',
    goal: '',
    last: '',
    stepsDone: 0,
    stepsTotal: 5,
    deadlineAt: null,
    lastStudiedAt: null,
    ...partial,
  }
}

describe('sortTasks', () => {
  it('未完成按截止时间近到远，无截止时间随后，已完成置底', () => {
    const sorted = sortTasks([
      task({ id: 'done', status: '已完成', deadlineAt: '2026-09-20T00:00:00+08:00' }),
      task({ id: 'no-deadline', status: '未开始' }),
      task({ id: 'later', status: '未开始', deadlineAt: '2026-10-12T23:59:00+08:00' }),
      task({ id: 'overdue', status: '进行中', deadlineAt: '2026-09-24T23:59:00+08:00' }),
      task({ id: 'soon', status: '未开始', deadlineAt: '2026-09-30T23:59:00+08:00' }),
    ])
    expect(sorted.map((t) => t.id)).toEqual(['overdue', 'soon', 'later', 'no-deadline', 'done'])
  })

  it('相同截止时间保持稳定顺序', () => {
    const sorted = sortTasks([
      task({ id: 'b', deadlineAt: '2026-10-01T00:00:00+08:00' }),
      task({ id: 'a', deadlineAt: '2026-10-01T00:00:00+08:00' }),
    ])
    expect(sorted.map((t) => t.id)).toEqual(['b', 'a'])
  })
})

describe('isOverdue', () => {
  it('已完成的任务即使过了截止时间也不算逾期', () => {
    const t = task({ id: 'x', status: '已完成', deadlineAt: '2026-09-24T23:59:00+08:00' })
    expect(isOverdue(t, NOW)).toBe(false)
  })

  it('未完成且截止时间已过为逾期', () => {
    const t = task({ id: 'x', status: '进行中', deadlineAt: '2026-09-24T23:59:00+08:00' })
    expect(isOverdue(t, NOW)).toBe(true)
  })
})

describe('selectContinueTask', () => {
  it('恢复最近一次学习且未完成的任务', () => {
    const result = selectContinueTask([
      task({ id: 'older', status: '进行中', lastStudiedAt: '2026-09-24T20:15:00+08:00' }),
      task({ id: 'recent', status: '进行中', lastStudiedAt: '2026-09-25T14:32:00+08:00' }),
      task({ id: 'done-recent', status: '已完成', lastStudiedAt: '2026-09-25T15:00:00+08:00' }),
    ])
    expect(result).toMatchObject({ task: { id: 'recent' }, mode: 'resume' })
  })

  it('没有学习记录时按截止时间推荐未完成任务', () => {
    const result = selectContinueTask([
      task({ id: 'later', deadlineAt: '2026-10-12T23:59:00+08:00' }),
      task({ id: 'sooner', deadlineAt: '2026-09-30T23:59:00+08:00' }),
    ])
    expect(result).toMatchObject({ task: { id: 'sooner' }, mode: 'suggest' })
  })

  it('没有未完成任务时返回 null', () => {
    expect(selectContinueTask([task({ id: 'x', status: '已完成' })])).toBeNull()
  })
})

describe('展示辅助', () => {
  it('progressPercent 为任务完成百分比', () => {
    expect(progressPercent(task({ id: 'x', stepsDone: 3, stepsTotal: 5 }))).toBe(60)
    expect(progressPercent(task({ id: 'y', stepsDone: 0, stepsTotal: 0 }))).toBe(0)
  })

  it('pendingCount 同时计入未开始和进行中', () => {
    const tasks = [
      task({ id: 'a', course: 'C', status: '未开始' }),
      task({ id: 'b', course: 'C', status: '进行中' }),
      task({ id: 'c', course: 'C', status: '已完成' }),
    ]
    expect(pendingCount(tasks, 'C')).toBe(2)
  })

  it('formatDeadline 输出「9月30日 23:59」格式', () => {
    expect(formatDeadline('2026-09-30T23:59:00+08:00')).toBe('9月30日 23:59')
  })
})
