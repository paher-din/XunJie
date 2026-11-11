import { Banner } from '@astryxdesign/core/Banner'
import { Icon } from '../icons'
import './skill-import-feedback.css'

export interface SkillImportFeedbackProps {
  summary: string
  failures: readonly { path: string; message: string }[]
  retryLabel: string
  disabled?: boolean
  onRetry(): void
  onChooseFolder?(): void
  onDismiss?(): void
}

/** Results only; the caller retains file references, requests and retry decisions. */
export function SkillImportFeedback({ summary, failures, retryLabel, disabled = false, onRetry, onChooseFolder, onDismiss }: SkillImportFeedbackProps) {
  return <Banner className="st-skill-import-feedback" status="warning" role="status" aria-label="技能导入结果"
    title={<span className="st-skill-import-summary">{summary}</span>}
    icon={<Icon name="info-circle" size={18} tone="neutral" />} collapsible={false}
    endContent={onDismiss && <button type="button" className="st-skill-import-dismiss" aria-label="关闭导入结果" disabled={disabled} onClick={onDismiss}>
      <Icon name="close" size={16} /></button>}>
    {failures.length > 0 && <ul className="st-skill-import-problems" aria-label="未完成的技能" tabIndex={failures.length > 3 ? 0 : undefined}>
      {failures.map(failure => <li key={failure.path}><strong>{failure.path}</strong><p>{failure.message}</p></li>)}
    </ul>}
    <div className="st-skill-import-actions">
      <button type="button" className="primary" disabled={disabled} onClick={onRetry}>{retryLabel}</button>
      {onChooseFolder && <button type="button" className="outline" disabled={disabled} onClick={onChooseFolder}>重新选择文件夹</button>}
    </div>
  </Banner>
}
