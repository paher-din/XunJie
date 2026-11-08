import type { RecordPresenter } from './model'
import { useEffect, useState } from 'react'
import { useActivitySession } from '../ActivitySession'
import type { ExecutionRecord } from '../../tool-execution/ledger'
import type { ExecutionRetainedResource } from '@xunjie/contracts/execution'
import { aluCaseFromAction } from '@xunjie/contracts/alu-learning'
import { comparisonText } from '../../course-tools/alu/cases'

const operationLabel: Record<string, string> = { 'run-single': '显式运行', 'observe-enabled': '自由观察', 'check-all': '全部输入检查' }
const verdictLabel: Record<string, string> = { pass: '检查通过', fail: '检查未通过', inconclusive: '检查不完整' }

export const aluPresenter: RecordPresenter = {
  id: 'icarus-alu',
  artifactLabel: '下载结果资源',
  matches: action => action.protocolVersion === 3 && action.execution.basis.runtime.adapterId === 'icarus-alu',
  Detail({ record }) {
    return <AluRecord record={record} />
  },
}

function AluRecord({ record }: { record: ExecutionRecord }) {
  const { execution } = useActivitySession()
  const [resources, setResources] = useState<ExecutionRetainedResource[]>([])
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    let live = true
    if (!expanded || !record.query.output) return
    void execution.artifact(record.requestId).then(result => {
      if (live) setResources(result?.resources ?? [])
    }).catch(() => { if (live) setError('原结果资源暂时不可读，未重新仿真。') })
    return () => { live = false }
  }, [execution, record.requestId, record.query.output, expanded])
  const operation = record.action.execution.operation.operationId
  const parameters = record.action.execution.parameters as Record<string, number>
  const output = (record.query.statusKnowledge === 'confirmed' ? record.query.output?.output : undefined) as Record<string, unknown> | undefined
  const isCheck = operation === 'check-all'
  const comparison = record.action.protocolVersion === 3 ? aluCaseFromAction(record.action) : null
  return <>
    <p className="execution-hint">{record.action.execution.initiator.kind === 'agent' ? 'Agent 验证' : operationLabel[operation] ?? operation} · {isCheck
      ? '固定检查已启用作品的全部 4096 组输入'
      : `该次输入：${Object.entries(parameters).map(([key, value]) => `${key}=${value}`).join('，')}`}</p>
    {record.query.statusKnowledge === 'unknown' && <p role="status">执行结果尚未确认，请核对原状态；未将上次状态当作本次检查通过。</p>}
    {isCheck && output && <p>检查执行完成：{verdictLabel[String(output.verdict)] ?? '结论未知'}
      {' · '}唯一输入 {String(output.totalInputs ?? '—')} · 实际采样 {String(output.sampledRows ?? '—')} 行
      {' · '}二值比较 {String(output.comparedRows ?? '—')} 行 · 行为错误 {String(output.behaviorErrorInputs ?? '—')} 组
      {' · '}X/Z {String(output.unknownInputs ?? '—')} 组</p>}
    {!isCheck && output && <p>F：{String(output.f || '未取得')}　Cout：{String(output.cout || '未取得')}
      （{output.observationState === 'complete' ? '已取得观察' : output.observationState === 'complete-with-unknown' ? '输出包含 X/Z' : '观察不完整'}）</p>}
    {comparison && <div className="execution-comparison">
      <p>原预测 F：{comparison.draft.predictedF || '未填写'}（{comparisonText(comparison.draft.predictedF, output?.f as string | undefined, 4)}）
        {' · '}Cout：{comparison.draft.predictedCout || '未填写'}（{comparisonText(comparison.draft.predictedCout, output?.cout as string | undefined, 1)}）</p>
      {comparison.draft.reason && <p>原理由：{comparison.draft.reason}</p>}
      {(comparison.draft.helpReported || comparison.draft.priorSources.length > 0) && <p className="execution-hint">
        {comparison.draft.helpReported ? '记录含已报告的帮助来源。' : ''}
        {comparison.draft.priorSources.length > 0 ? '相同作品已有相关观察或检查，原来源仍保留。' : ''}
      </p>}
    </div>}
    {record.query.state === 'succeeded' && isCheck && <p className="execution-hint">执行状态已成功不等于检查通过；完整报告、实际覆盖和反例以保留的 check-report.json 为准。</p>}
    {error && <p role="alert">{error}</p>}
    <details onToggle={event => setExpanded(event.currentTarget.open)}><summary>原依据与结果资源</summary>
      {record.action.protocolVersion === 3 && record.action.execution.basis.works.filter(file => file.kind === 'code').map(file =>
        <details key={file.contentId}><summary>{file.name}（该次运行的只读依据）</summary><pre>{file.value}</pre></details>)}
      {resources.map(resource => <div key={resource.contentId}>
        {resource.name === 'diagnostics.txt' && resource.text && <pre>{resource.text.slice(0, 4000)}{resource.text.length > 4000 ? '\n…（完整内容请下载）' : ''}</pre>}
        <button type="button" className="ws-btn ghost" onClick={() => {
          const url = URL.createObjectURL(new Blob([resource.text], { type: resource.mediaType }))
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = resource.name
          anchor.click()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
        }}>下载 {resource.name}</button>
      </div>)}
      {record.query.output?.artifact && resources.length === 0 && !error &&
        <p className="execution-hint">展开时读取原保留资源；不会重新编译或仿真。</p>}
    </details>
  </>
}
