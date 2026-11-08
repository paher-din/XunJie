import type { ReactNode } from 'react'
import { IconText } from '../icons'
import { ProgressBar } from '../foundation'
import { StatusChip, type TaskDisplayStatus } from '../foundation'
import { Button } from '../foundation'

export interface MessageTaskCardProps {
  status: TaskDisplayStatus
  /** undefined omits the course node; an empty string keeps it. */
  course?: string
  title: string
  metadata: readonly ReactNode[]
  /** Omit when progress is unknown; no placeholder is rendered. */
  progress?: { percent: number; done?: boolean }
  onOpen: () => void
}

export function MessageTaskCard({ status, course, title, metadata, progress, onOpen }: MessageTaskCardProps) {
  return (
    <div className="msg-task-card">
      <div className="msg-task-top">
        <StatusChip status={status} />
        {course !== undefined && <span className="msg-task-course">{course}</span>}
      </div>
      <h4>{title}</h4>
      <div className="msg-task-meta">
        {metadata.map((item, index) => <span key={index}>{item}</span>)}
      </div>
      {progress && <ProgressBar percent={progress.percent} done={progress.done} />}
      <Button className="msg-task-enter" onClick={onOpen}>
        <IconText name="arrow-right" position="end">进入任务</IconText>
      </Button>
    </div>
  )
}
