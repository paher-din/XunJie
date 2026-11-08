import { useId, type ReactNode } from 'react'
import { ProgressBar } from '../foundation'

export interface TaskProgressProps {
  percent: number
  done: boolean
  status: string
  title: string
  ariaLabel: string
}

export interface TaskInfoProps {
  name: string
  status: ReactNode
  demoNotice?: ReactNode
  goal: string
  percent: number
  done: boolean
  currentProgress: string
  stage: ReactNode
  deadline: string
  course: string
}

/** Controlled task displays; callers supply business status, progress and formatted text. */
export function TaskProgress({ percent, done, status, title, ariaLabel }: TaskProgressProps) {
  const gradientId = useId()
  const activeGradientId = `${gradientId}-progress`
  const doneGradientId = `${gradientId}-done`
  const r = 8
  const c = 2 * Math.PI * r
  return (
    <span
      className={done ? 'ws-taskprogress done' : 'ws-taskprogress'}
      title={title}
    >
      <svg width="24" height="24" viewBox="0 0 24 24" role="img" aria-label={ariaLabel}>
        <defs>
          <linearGradient id={activeGradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--steel-1)' }} />
            <stop offset="1" style={{ stopColor: 'var(--steel-2)' }} />
          </linearGradient>
          <linearGradient id={doneGradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--steel-ok)' }} />
            <stop offset="1" style={{ stopColor: 'var(--progress-fill-done)' }} />
          </linearGradient>
        </defs>
        <circle
          cx="12"
          cy="12"
          r={r}
          fill="none"
          style={{ stroke: done ? 'var(--tint-green-line)' : 'var(--tint-blue-line)' }}
          strokeWidth="3"
        />
        <circle
          className="ws-taskprogress-arc"
          cx="12"
          cy="12"
          r={r}
          fill="none"
          stroke={`url(#${done ? doneGradientId : activeGradientId})`}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - percent / 100)}
          transform="rotate(-90 12 12)"
        />
      </svg>
      <span className="ws-taskprogress-text">
        <b>{percent}%</b>
        <span>{status}</span>
      </span>
    </span>
  )
}

/** 任务信息卡内容；演示说明仅在调用方显式提供时展示。 */
export function TaskInfo({ name, status, demoNotice, goal, percent, done, currentProgress, stage, deadline, course }: TaskInfoProps) {
  return (
    <div className="ws-taskinfo">
      <h2>{name}</h2>
      {status}
      {demoNotice != null && <p className="ws-demo-flag">{demoNotice}</p>}
      <p className="ws-taskinfo-goal">{goal}</p>
      <div className="progresslabel">
        <span>任务进度</span>
        <span>{percent}%</span>
      </div>
      <ProgressBar percent={percent} done={done} />
      <div className="ws-kv-list">
        <div className="ws-kv">
          <span>当前进展</span>
          <b>{currentProgress}</b>
        </div>
        <div className="ws-kv">
          <span>阶段</span>
          <b>{stage}</b>
        </div>
        <div className="ws-kv">
          <span>截止时间</span>
          <b>{deadline}</b>
        </div>
        <div className="ws-kv">
          <span>课程</span>
          <b>{course}</b>
        </div>
      </div>
    </div>
  )
}
