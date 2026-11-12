export interface ModelConnectionTestResult { ok: boolean; text: string }
export interface ModelConnectionTestRowProps {
  testing: boolean
  disabled: boolean
  result: ModelConnectionTestResult | null
  onTest: () => void
}

export function ModelConnectionTestRow({ disabled, result, onTest }: ModelConnectionTestRowProps) {
  return <div className="st-provider-test">
    <button className="outline st-xs" disabled={disabled} onClick={onTest}>
      连接测试
    </button>
    {result && <span role="status" className={'st-test-result inline' + (result.ok ? ' ok' : ' fail')}>
      {result.text}
    </span>}
  </div>
}
