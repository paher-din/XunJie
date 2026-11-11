import { Children, useState, type ReactNode } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Icon } from '../icons'
import './model-test-feedback.css'

export interface ModelTestFeedbackProps {
  status: 'running' | 'passed' | 'failed' | 'unverified' | 'cancelled'
  title: string
  message?: string
  suggestion?: string
  details?: string
  onRetry?(): void
  onStop?(): void
  children?: ReactNode
}

function DiagnosticDetails({ details }: { details: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(details)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }
  return <details className="st-model-test-diagnostic">
    <summary>诊断详情</summary>
    <div className="st-model-test-copy-row">
      <button type="button" className="st-model-test-action" onClick={() => void copy()}>
        <Icon name={copyState === 'copied' ? 'check' : 'copy'} />
        {copyState === 'copied' ? '已复制' : '复制诊断'}
      </button>
      <span role="status">{copyState === 'copied' ? '诊断已复制' : copyState === 'failed' ? '复制失败，请手动选择下方内容复制。' : ''}</span>
    </div>
    <pre tabIndex={0} aria-label="诊断内容">{details}</pre>
  </details>
}

/** Presentational feedback only. The caller owns the test and retry lifecycle. */
export function ModelTestFeedback({ status, title, message, suggestion, details, onRetry, onStop, children }: ModelTestFeedbackProps) {
  const problem = status === 'failed' || status === 'unverified'
  const hasExtra = Boolean(details?.trim()) || Children.toArray(children).length > 0
  const description = <>
    {message?.trim() && <p className="st-model-test-message">{message}</p>}
    {suggestion?.trim() && <p className="st-model-test-suggestion">{suggestion}</p>}
  </>
  const actions = status === 'running' && onStop
    ? <button type="button" className="st-model-test-action" onClick={onStop}><Icon name="stop" />停止</button>
    : problem && onRetry
      ? <button type="button" className="st-model-test-action" onClick={onRetry}><Icon name="restart" />重试</button>
      : undefined
  const extra = status !== 'passed' && <>
    {details?.trim() && <DiagnosticDetails key={details} details={details} />}
    {children}
  </>
  if (problem) return <Banner
    className="st-model-test-feedback" data-status={status} status={status === 'failed' ? 'error' : 'warning'}
    title={<span className="st-model-test-title">{title}</span>}
    description={message?.trim() || suggestion?.trim() ? description : undefined}
    icon={<Icon name={status === 'failed' ? 'danger-triangle' : 'info-circle'} tone="neutral" />}
    endContent={actions} collapsible={false} role={status === 'failed' ? 'alert' : 'status'}
  >{hasExtra ? extra : undefined}</Banner>

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
    {extra}
  </div>
}
