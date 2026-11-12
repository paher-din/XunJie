import { Banner } from '@astryxdesign/core/Banner'
import { Icon } from '../icons'
import './model-test-feedback.css'

export interface ModelTestFeedbackProps {
  status: 'running' | 'passed' | 'failed' | 'unverified' | 'cancelled'
  title: string
  message?: string
  suggestion?: string
  onRetry?(): void
  onStop?(): void
}

/** Presentational feedback only. The caller owns the test and retry lifecycle. */
export function ModelTestFeedback({ status, title, message, suggestion, onRetry, onStop }: ModelTestFeedbackProps) {
  const problem = status === 'failed' || status === 'unverified'
  const description = <>
    {message?.trim() && <p className="st-model-test-message">{message}</p>}
    {suggestion?.trim() && <p className="st-model-test-suggestion">{suggestion}</p>}
  </>
  const actions = status === 'running' && onStop
    ? <button type="button" className="st-model-test-action" onClick={onStop}><Icon name="stop" />停止</button>
    : problem && onRetry
      ? <button type="button" className="st-model-test-action" onClick={onRetry}><Icon name="restart" />重试</button>
      : status === 'cancelled' && onRetry
        ? <button type="button" className="st-model-test-action" onClick={onRetry}><Icon name="restart" />重新测试</button>
      : undefined
  if (problem) return <Banner
    className="st-model-test-feedback" data-status={status} status={status === 'failed' ? 'error' : 'warning'}
    title={<span className="st-model-test-title">{title}</span>}
    description={message?.trim() || suggestion?.trim() ? description : undefined}
    icon={<Icon name={status === 'failed' ? 'danger-triangle' : 'info-circle'} tone="neutral" />}
    endContent={actions} collapsible={false} role={status === 'failed' ? 'alert' : 'status'}
  />

  return <div className="st-model-test-feedback st-model-test-plain" data-status={status}>
    <div className="st-model-test-line">
      <div className="st-model-test-result" role="status" aria-atomic="true">
        <Icon name={status === 'passed' ? 'check-circle' : status === 'running' ? 'refresh' : 'minus-circle'} tone="neutral"
          className={status === 'running' ? 'st-model-test-spinning' : undefined} />
        <span className="st-model-test-title">{title}</span>
        {message?.trim() && <span className="st-model-test-message">{message}</span>}
      </div>
      {actions}
    </div>
    {suggestion?.trim() && <p className="st-model-test-suggestion">{suggestion}</p>}
  </div>
}
