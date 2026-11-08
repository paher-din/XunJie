export interface ModelConnectionTestResult { ok: boolean; text: string }
export interface ModelConnectionTestRowProps {
  testing: boolean
  disabled: boolean
  result: ModelConnectionTestResult | null
  onTest: () => void
}

export function ModelConnectionTestRow({ testing, disabled, result, onTest }: ModelConnectionTestRowProps) {
  return <div className="st-provider-test">
    <button className="outline st-xs" disabled={disabled} onClick={onTest}>
      {testing ? '测试中…' : '连接测试'}
    </button>
    {result && <span role="status" className={'st-test-result inline' + (result.ok ? ' ok' : ' fail')}>
      {result.text}
    </span>}
  </div>
}
