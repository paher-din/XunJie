import { IconText } from '../icons'
import './workspace-status-bar.css'

interface WorkspaceStatusBarProps {
  closed: boolean
  workLabel: string
  workDescription?: string
  attention: boolean
  executionLabel?: string
}

export function WorkspaceStatusBar({ closed, workLabel, workDescription, attention, executionLabel }: WorkspaceStatusBarProps) {
  const activityLabel = closed ? '已关闭' : '进行中'
  return <section className="ui-workspace-status" aria-label="工作区状态">
    <span role="status" className="ui-workspace-work" data-attention={attention} title={workDescription} aria-label={workDescription}>
      <IconText name="folder-with-files" size={14} tone="neutral">{workLabel}</IconText>
    </span>
    <span role="status" className="ui-workspace-status-item ui-workspace-activity" data-closed={closed}
      title={`活动${activityLabel}`} aria-label={`活动${activityLabel}`}>{activityLabel}</span>
    {executionLabel && <span role="status" className="ui-workspace-status-item">{executionLabel}</span>}
  </section>
}
