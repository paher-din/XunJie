import { useRef, useState, useSyncExternalStore } from 'react'
import { componentStateName, type ComponentBinding } from '@xunjie/contracts/components'
import { isTerminalExecutionState, type ExecutionAction } from '@xunjie/contracts/execution'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { stateLabel } from '../tool-execution/ledger'
import { executionAction, canonical, readComponentState } from '../tool-execution/action'
import { useActivitySession } from './ActivitySession'
import './execution-panel.css'

const aggregates: Record<string, string> = { count: '计数', sum: '求和', mean: '平均' }
interface Parameters { groupColumn: string; valueColumn: string; aggregate: string }
interface Result { rows: number; groups: unknown[]; value: number }

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
const display = (value: number) => String(Number(Number(value).toFixed(6)))

/**
 * The public run record of one mounted component. It reads the execution controller, not the
 * iframe, so switching tools or reloading a view keeps query, stop and download available.
 */
export function ExecutionPanel({ activity, binding, authorized }: {
  activity: LearningActivity; binding: ComponentBinding; authorized: boolean
}) {
  const { workspace, execution } = useActivitySession()
  const state = useSyncExternalStore(execution.subscribe, execution.snapshot)
  const work = useSyncExternalStore(workspace.subscribe, workspace.snapshot)
  const [note, setNote] = useState('')
  const instanceId = `${activity.activityId}:${binding.key}`
  const currentFile = work.files.find(file => file.name === componentStateName(binding.key))
  const records = state.records.filter(record => record.action.scope.activityId === activity.activityId
    && record.action.execution.instance.key === binding.key)
  const running = records.some(record => !isTerminalExecutionState(record.query.state))
  const canRun = authorized && !workspace.accessDenied() && !work.conflict && work.ready && !running
  const rerun = async () => {
    setNote('')
    try {
      const current = readComponentState(workspace, binding, instanceId)
      const action = await executionAction({ workspace, binding, instanceId,
        receiver: { receiverId: execution.receiver.identity.receiverId, location: 'local', kind: 'execution' },
        operationId: binding.definition.manifest.operations?.[0]?.operationId ?? 'aggregate',
        parameters: (current.content as { parameters: unknown }).parameters,
        expectedContentId: current.contentId, requestId: crypto.randomUUID() })
      await execution.submit(action)
      setNote('已按当前表格与参数提交一次计算。')
    } catch (error) {
      setNote(error instanceof Error && error.message === 'conflict'
        ? '表格在提交前发生了变化，本次没有提交。请核对当前表格后重试。'
        : '当前不能发起计算：请核对工作区是否可写、组件是否仍可用。')
    }
  }
  // One identity per record: pressing stop twice is the same stop, not a second one.
  const stopIds = useRef(new Map<string, string>())
  const stop = async (requestId: string) => {
    setNote('')
    const stopId = stopIds.current.get(requestId) ?? crypto.randomUUID()
    stopIds.current.set(requestId, stopId)
    try { await execution.stop(requestId, stopId) }
    catch { setNote('停止请求没有确认。原执行记录仍保留，可再次查询，不要重复发起新运行。') }
  }
  const query = async (requestId: string) => {
    setNote('')
    try { await execution.query(requestId) }
    catch { setNote('执行状态暂时无法核实，已保留原记录。') }
  }
  const download = async (requestId: string) => {
    setNote('')
    const artifact = await execution.artifact(requestId)
    if (!artifact) { setNote('本机没有该运行的结果文件：结果只在发起计算的浏览器中保存。'); return }
    const url = URL.createObjectURL(new Blob([artifact.text], { type: artifact.mediaType }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = artifact.name; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <section className="execution-panel" aria-label="计算记录">
    <header>
      <h2>计算记录</h2>
      <button type="button" className="ws-btn ghost" disabled={!canRun} onClick={() => void rerun()}>用当前表格重新运行</button>
    </header>
    {note && <p role="status" className="execution-note">{note}</p>}
    {!state.ready ? <p className="execution-hint">正在读取本机执行记录…</p>
      : records.length === 0 ? <p className="execution-hint">还没有计算记录。在上方表格视图里选好分组列与数值列后运行计算。</p>
      : <ol className="execution-records">
        {records.map(record => {
          const parameters = record.action.execution.parameters as Parameters
          const basis = record.action.execution.basis.state
          const result = record.query.output?.output as Result | undefined
          const rows = inputRows(record.action)
          const changed = basis !== null && !sameContent(record.action, currentFile?.value)
          const terminal = isTerminalExecutionState(record.query.state)
          return <li key={record.requestId}>
            <p className="execution-title">{binding.configuration.title} · {record.action.execution.operation.operationId} · {stateLabel(record.query)}</p>
            <p className="execution-hint">{`参数：按「${parameters.groupColumn || '未选'}」分组，数值列「${parameters.valueColumn || '未选'}」，方式 ${aggregates[parameters.aggregate] ?? parameters.aggregate}${rows === null ? '' : `；该次输入共 ${rows} 行`}。`}</p>
            {changed && <p className="execution-warn">当前表格已改动：这份结果对应提交时的表格，不是现在的内容。</p>}
            {result && <p className="execution-hint">总计 {display(result.value)}，共 {result.groups.length} 组。</p>}
            {record.query.reason && <p className="execution-warn">{record.query.reason.detail}</p>}
            <div className="execution-actions">
              <button type="button" className="ws-btn ghost" onClick={() => void query(record.requestId)}>核对状态</button>
              {!terminal && <button type="button" className="ws-btn ghost" onClick={() => void stop(record.requestId)}>停止</button>}
              {record.query.output?.artifact && <button type="button" className="ws-btn ghost"
                onClick={() => void download(record.requestId)}>下载 CSV</button>}
            </div>
          </li>
        })}
      </ol>}
  </section>
}
