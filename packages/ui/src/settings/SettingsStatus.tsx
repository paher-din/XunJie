import type { ReactNode } from 'react'
import './settings-status.css'

export type SettingsStatusTone = 'neutral' | 'loading' | 'error'

/** 设置页内的非模态状态层：用于加载、只读、部分失败与可恢复错误。 */
export function SettingsStatus({ tone = 'neutral', title, description, action, className }: {
  tone?: SettingsStatusTone
  title: string
  description?: string
  action?: ReactNode
  className?: string
}) {
  return <div className={'st-status' + (className ? ' ' + className : '')} data-tone={tone}>
    <div className="st-status-copy" role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'} aria-atomic="true" aria-busy={tone === 'loading' || undefined}>
      <div className="st-status-title">{title}</div>
      {description && <p className="st-status-description">{description}</p>}
    </div>
    {action && <div className="st-status-action">{action}</div>}
  </div>
}
