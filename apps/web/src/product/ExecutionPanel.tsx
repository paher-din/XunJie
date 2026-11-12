import { componentStateName, type ComponentBinding } from '@xunjie/contracts/components'
import { isTerminalExecutionState } from '@xunjie/contracts/execution'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { useRef, useSyncExternalStore } from 'react'
import { toast } from '@xunjie/ui/feedback'
import type { ExecutionRecord } from '../tool-execution/ledger'
import { stateLabel } from '../tool-execution/ledger'
import { observeExecutionDevice } from '../tool-execution/device'
import { executionAction, readComponentState } from '../tool-execution/action'
import { useActivitySession } from './ActivitySession'
import { recordPresenters } from './execution-presenters'
import './execution-panel.css'

/**
 * The public run record of one mounted component. It reads the execution controller, not the
 * iframe, so switching tools or reloading a view keeps query, stop and download available.
 *
 * What a record means — its parameters, its result summary, its artifact name — comes from the
 * presenter of its own run family. This panel only owns the list, the controls and the plumbing.
 */
export function ExecutionPanel({ activity, binding, authorized, requestIds }: {
  activity: LearningActivity; binding: ComponentBinding; authorized: boolean; requestIds?: ReadonlySet<string>
}) {
  const { workspace, execution } = useActivitySession()
  const state = useSyncExternalStore(execution.subscribe, execution.snapshot)
  const work = useSyncExternalStore(workspace.subscribe, workspace.snapshot)
  const instanceId = `${activity.activityId}:${binding.key}`
  const currentFile = work.files.find(file => file.name === componentStateName(binding.key))
  const canRead = authorized && !workspace.accessDenied()
  const access = useRef(canRead)
  access.current = canRead
  const records = (canRead ? state.records : []).filter(record => record.action.scope.activityId === activity.activityId
    && record.action.execution.instance.key === binding.key && (!requestIds || requestIds.has(record.requestId)))
  const running = records.some(record => !isTerminalExecutionState(record.query.state))
  const canRun = authorized && !workspace.isReadOnly() && !workspace.accessDenied() && !work.conflict && work.ready && !running
  const rerun = async () => {
    try {
      // Only a format 1 aggregate component re-runs from this panel; other families own their form.
      if (binding.definition.manifest.formatVersion !== 1) { toast.info('这类组件从它自己的实验区发起运行。'); return }
      const current = readComponentState(workspace, binding, instanceId)
      const action = await executionAction({ workspace, binding, instanceId,
        receiver: { receiverId: execution.receiver.identity.receiverId, location: 'local', kind: 'execution' },
        operationId: binding.definition.manifest.operations?.[0]?.operationId ?? 'aggregate',
        parameters: (current.content as { parameters: unknown }).parameters,
        expectedContentId: current.contentId, requestId: crypto.randomUUID(),
        placement: activity.course?.executionPlan ? { plan: activity.course.executionPlan,
          device: observeExecutionDevice(), remoteAvailable: false } : undefined })
      await execution.submit(action)
      toast.success('已按当前表格与参数提交一次计算。')
    } catch (error) {
      toast.error(error instanceof Error && error.message === 'conflict'
        ? '表格在提交前发生了变化，本次没有提交。请核对当前表格后重试。'
        : '当前不能发起计算：请核对工作区是否可写、组件是否仍可用。')
    }
  }
  // One identity per record: pressing stop twice is the same stop, not a second one.
  const stopIds = useRef(new Map<string, string>())
  const stop = async (requestId: string) => {
    const stopId = stopIds.current.get(requestId) ?? crypto.randomUUID()
    stopIds.current.set(requestId, stopId)
    try { await execution.stop(requestId, stopId) }
    catch { toast.error('停止请求没有确认。原执行记录仍保留，可再次查询，不要重复发起新运行。') }
  }
  const query = async (requestId: string) => {
    try { await execution.query(requestId) }
    catch { toast.error('执行状态暂时无法核实，已保留原记录。') }
  }
  const download = async (requestId: string) => {
    if (!access.current) return
    let artifact
    try { artifact = await execution.artifact(requestId) }
    catch { toast.error('当前空间资格已失效，不能读取结果。'); return }
    if (!access.current) return
    if (!artifact) { toast.error('本机没有该运行的结果文件：结果只在发起计算的浏览器中保存。'); return }
    const url = URL.createObjectURL(new Blob([artifact.text], { type: artifact.mediaType }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = artifact.name; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const supported = binding.definition.manifest.formatVersion === 1
  return <section className="execution-panel" aria-label="计算记录">
    <header>
      <h2>{supported ? '计算记录' : '运行记录'}</h2>
      {supported && <button type="button" className="ws-btn ghost" disabled={!canRun}
        onClick={() => void rerun()}>用当前表格重新运行</button>}
    </header>
    {state.error && <p role="alert" className="execution-warn">{state.error}</p>}
    {!state.ready ? <p className="execution-hint" role="status" aria-label="正在读取本机执行记录" />
      : records.length === 0 ? <p className="execution-hint">{supported
        ? '还没有计算记录。在上方表格视图里选好分组列与数值列后运行计算。'
        : '还没有运行记录。在实验区设置输入后运行一次。'}</p>
      : <ol className="execution-records">
        {records.map(record => <RecordItem key={record.requestId} activity={activity} binding={binding} record={record}
          currentValue={currentFile?.value} authorized={canRead} readOnly={workspace.isReadOnly()}
          onQuery={query} onStop={stop} onDownload={download} />)}
      </ol>}
  </section>
}

function RecordItem({ activity, binding, record, currentValue, authorized, readOnly, onQuery, onStop, onDownload }: {
  activity: LearningActivity; binding: ComponentBinding; record: ExecutionRecord
  currentValue: string | undefined; authorized: boolean; readOnly: boolean
  onQuery: (requestId: string) => Promise<void>; onStop: (requestId: string) => Promise<void>
  onDownload: (requestId: string) => Promise<void>
}) {
  const presenter = recordPresenters.find(record.action)
  const terminal = isTerminalExecutionState(record.query.state)
  return <li data-execution-request-id={record.requestId} tabIndex={-1}>
    <p className="execution-title">{binding.configuration.title} · {stateLabel(record.query)}</p>
    {presenter
      ? presenter.Detail({ activity, binding, record, currentValue, authorized })
      : <p className="execution-hint">这条记录来自本产品未登记呈现的运行类型，只显示真实状态与诊断，不推断其含义。</p>}
    {record.query.reason && <p className="execution-warn">{record.query.reason.detail}</p>}
    <div className="execution-actions">
      <button type="button" className="ws-btn ghost" disabled={!authorized} onClick={() => void onQuery(record.requestId)}>核对状态</button>
      {!terminal && <button type="button" className="ws-btn ghost" disabled={readOnly} onClick={() => void onStop(record.requestId)}>停止</button>}
      {record.query.output?.artifact && <button type="button" className="ws-btn ghost"
        disabled={!authorized} onClick={() => void onDownload(record.requestId)}>{presenter?.artifactLabel ?? '下载结果'}</button>}
    </div>
  </li>
}
