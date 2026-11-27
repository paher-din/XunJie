/**
 * 作业审阅左栏排序规格。
 *
 * 清单按处理状态分段：待审阅 → 待复核 → 已反馈 → 已完成。
 * - 待审阅排在待复核之前：新提交先进入初审，待复核的稿件再按提交时间排在其后。
 * - 队列段（待审阅 / 待复核）组内先到先审：提交越早越靠前，保证等待时长不可被插队。
 * - 归档段（已反馈 / 已完成）组内最近提交在前：回答「最近发生了什么」。
 * 同分钟的提交按版本降序、姓名、提交 ID 决出稳定次序，刷新和重排不会抖动。
 * 单状态视图沿用同一组内规则，只是不再显示分组标题。
 */
import { submissionLabel, type SubmissionState, type TeacherSubmission } from './data'

export type ReviewView = 'all' | 'inbox' | SubmissionState

export interface ReviewGroup {
  id: SubmissionState
  label: string
  items: TeacherSubmission[]
}

const STATE_ORDER: Record<ReviewView, SubmissionState[]> = {
  inbox: ['pending', 'revised'],
  all: ['pending', 'revised', 'feedback', 'done'],
  pending: ['pending'],
  revised: ['revised'],
  feedback: ['feedback'],
  done: ['done'],
}

const nameCollator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

const submittedTime = (iso: string) => {
  const time = Date.parse(iso)
  return Number.isFinite(time) ? time : 0
}

const isQueueState = (state: SubmissionState) => state === 'pending' || state === 'revised'

export function orderSubmissions(items: readonly TeacherSubmission[], view: ReviewView): TeacherSubmission[] {
  const order = STATE_ORDER[view]
  const rank = new Map(order.map((state, index) => [state, index]))
  return [...items].sort((a, b) => {
    const byState = (rank.get(a.state) ?? order.length) - (rank.get(b.state) ?? order.length)
    if (byState) return byState
    const direction = isQueueState(a.state) ? 1 : -1
    const time = submittedTime(a.submittedAt) - submittedTime(b.submittedAt)
    if (time) return time * direction
    if (a.version !== b.version) return b.version - a.version
    const byName = nameCollator.compare(a.studentName, b.studentName)
    if (byName) return byName
    return a.submissionId.localeCompare(b.submissionId)
  })
}

export function submissionGroups(items: readonly TeacherSubmission[], view: ReviewView): ReviewGroup[] {
  const ordered = orderSubmissions(items, view)
  return STATE_ORDER[view].flatMap(state => {
    const groupItems = ordered.filter(item => item.state === state)
    return groupItems.length ? [{ id: state, label: submissionLabel[state], items: groupItems }] : []
  })
}

/** 按本地日历日计算等待天数；跨时区与夏令时不会因小时差跳档。 */
export function waitingDays(submittedAt: string, now = Date.now()): number | null {
  const submitted = new Date(submittedAt)
  if (Number.isNaN(submitted.getTime())) return null
  const today = new Date(now)
  const from = new Date(submitted.getFullYear(), submitted.getMonth(), submitted.getDate())
  const to = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000))
}

export function waitingText(submittedAt: string, now = Date.now()): string {
  const days = waitingDays(submittedAt, now)
  if (days === null) return '提交时间未知'
  return days === 0 ? '今天提交' : `等待 ${days} 天`
}
