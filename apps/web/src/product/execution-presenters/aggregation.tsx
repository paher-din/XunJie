import { useRef } from 'react'
import type { ExecutionAction } from '@xunjie/contracts/execution'
import type { ComponentBinding } from '@xunjie/contracts/components'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { componentSource, useSemanticSource } from '../../components/workspace/references/SemanticSource'
import { canonical } from '../../tool-execution/action'
import type { ExecutionRecord } from '../../tool-execution/ledger'
import type { RecordPresenter } from './model'

const aggregates: Record<string, string> = { count: '计数', sum: '求和', mean: '平均' }
interface Parameters { groupColumn: string; valueColumn: string; aggregate: string }
interface Result { rows: number; groups: unknown[]; value: number }
const display = (value: number) => String(Number(Number(value).toFixed(6)))

const isAggregation = (action: { protocolVersion: number }): action is ExecutionAction =>
  action.protocolVersion === 2

/** The table a record was run against, read back from the command's own basis copy. */
function inputRows(action: ExecutionAction): number | null {
  const state = action.execution.basis.state
  const file = state && action.execution.basis.works.find(item => item.name === state.name)
  try {
    const rows = (JSON.parse(file?.value ?? '{}') as { content?: { table?: { rows?: unknown } } }).content?.table?.rows
    return Array.isArray(rows) ? rows.length : null
  } catch { return null }
}

/**
 * Re-saving identical content produces a new content id, so the warning compares the content
 * itself. A missing current file counts as a change.
 */
function sameContent(action: ExecutionAction, value: string | undefined): boolean {
  const state = action.execution.basis.state
  const file = state && action.execution.basis.works.find(item => item.name === state.name)
  if (!value || !file) return false
  try {
    return JSON.stringify(canonical((JSON.parse(value) as { content?: unknown }).content))
      === JSON.stringify(canonical((JSON.parse(file.value) as { content?: unknown }).content))
  } catch { return false }
}

/**
 * The fixed table-aggregation family's own reading of its records: grouping columns, aggregate
 * mode, the CSV it produced and the group anchors a reference can point at.
 */
export const aggregationPresenter: RecordPresenter = {
  id: 'table-aggregation',
  artifactLabel: '下载 CSV',
  matches: action => isAggregation(action),
  Detail({ activity, binding, record, currentValue, authorized }) {
    const action = record.action
    if (!isAggregation(action)) return null
    const parameters = action.execution.parameters as Parameters
    const basis = action.execution.basis.state
    const result = record.query.output?.output as Result | undefined
    const rows = inputRows(action)
    const changed = basis !== null && !sameContent(action, currentValue)
    return <>
      <p className="execution-hint">{`参数：按「${parameters.groupColumn || '未选'}」分组，数值列「${parameters.valueColumn || '未选'}」，方式 ${aggregates[parameters.aggregate] ?? parameters.aggregate}${rows === null ? '' : `；该次输入共 ${rows} 行`}。`}</p>
      {changed && <p className="execution-warn">当前表格已改动：这份结果对应提交时的表格，不是现在的内容。</p>}
      {result && <p className="execution-hint">总计 {display(result.value)}，共 {result.groups.length} 组。</p>}
      {result && record.query.output && <GroupReferences activity={activity} binding={binding} record={record} authorized={authorized} />}
    </>
  },
}

function GroupReferences({ activity, binding, record, authorized }: { activity: LearningActivity
  binding: ComponentBinding; record: ExecutionRecord; authorized: boolean }) {
  const output = record.query.output!, root = useRef<HTMLDetailsElement>(null)
  const select = useSemanticSource({ source: authorized ? componentSource(activity, binding, record.requestId, output.contentId,
    { requestId: record.requestId, executionRef: record.executionRef }) : null,
    title: `${binding.configuration.title} · 固定聚合结果`, content: output.output,
    locate: reference => {
      const keys = reference.range.target?.groupKeys
      if (!Array.isArray(keys)) return { ok: false, reason: '范围适配不可用，副本仍保留。' }
      const row = root.current?.querySelector<HTMLButtonElement>(`[data-group-key="${CSS.escape(String(keys[0]))}"]`)
      if (!row) return { ok: false, reason: '分组已不可用，副本仍保留。' }
      root.current!.open = true; row.focus(); row.scrollIntoView({ block: 'nearest' }); return { ok: true }
    } })
  // Reference selections are snapshots; they never rerun the computation.
  const result = output.output as { groups: { key: string; value: number; count: number }[] }
  return <details ref={root}><summary>聚合分组</summary><ul>
    {result.groups.map(group => <li key={group.key}>
      <button type="button" className="ws-btn ghost" disabled={!authorized} data-group-key={group.key}
        onClick={event => { const element = event.currentTarget; select({ kind: 'semantic', formatVersion: 1, typeId: 'aggregation-groups', version: 1,
          target: { groupKeys: [group.key], fields: ['count', 'value'] }, start: 0, end: 1 }, () => element.getBoundingClientRect(), event.nativeEvent) }}>
        {group.key || '空分组'}：{display(group.value)}（{group.count} 行）
      </button>
    </li>)}
  </ul></details>
}
