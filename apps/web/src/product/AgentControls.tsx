import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from '@xunjie/ui/feedback'
import { teachingControlReceiptSchema, isRecoverableTeachingPause } from '@xunjie/contracts/teaching-agent'
import type { TeachingInput, TeachingRun } from '@xunjie/contracts/teaching-agent'
import { QUESTION_TEXT_MAX_LENGTH } from '@xunjie/contracts/question-drafts'
import { agentControlStore, protectAgentOperation, confirmAgentOperation, deliverAgentOperation,
  type LocalAgentControl, type PendingAgentOperation } from '../reliable-workspace/agent-controls'
import './agent-interaction.css'
import { useActivitySession } from './ActivitySession'

type Request = (route: string, body?: unknown) => Promise<unknown>
const controlReasons: Record<string, string> = {
  'input-consumed': '这条输入已采用，修改未生效；你的修改草稿仍保留。',
  'version-mismatch': '输入版本已变化，操作未生效；你的修改草稿仍保留。',
  'input-closed': '这条输入已移除或转为引导，操作未生效。',
  'original-effects-unconfirmed': '原操作仍在核对，暂时不能建立后继任务。',
  'select-inputs': '请先选择要继续处理的输入。', 'run-active': '当前任务仍在运行，请先核对其状态。',
}
const pauseReasons: Record<string, string> = {
  'stop-requested': '你已停止原任务，等待你决定如何继续。',
  'student-response-expired': '原提问等待回应的期限已到，自动推进已暂停。',
  'wait-expired': '原操作等待结果的期限已到，自动推进已暂停。',
  'model-not-selected': '尚未选择模型，可以检查设置后继续。',
  'model-unavailable': '当前模型暂不可用，输入仍保留。',
  'capacity-exceeded': '内容超出当前模型的容量，请缩小问题或引用范围后继续。',
  'compaction-source-capacity-exceeded': '保留当前问题和依据后，历史仍无法放入模型窗口。请缩小本次作品或引用范围。',
  'compaction-source-changed': '问题或依据已变化，旧的历史摘要未采用。请选择要继续处理的输入。',
  'compaction-basis-changed': '本次可用能力或规则已变化，旧的历史摘要未采用。请选择要继续处理的输入。',
  'compaction-invalid-summary': '历史整理结果未能核对原始依据，已暂停；完整交流仍保留。',
  'model-step-budget-exhausted': '本次任务的计算预算已用尽。',
  'tool-budget-exhausted': '本次任务的操作预算已用尽。',
  'input-token-budget-exhausted': '本次任务的输入额度已用尽。',
  'output-token-budget-exhausted': '本次任务的输出额度已用尽。',
  'model-call-budget-exhausted': '本次任务的调用时间已用尽。',
  'run-deadline-exceeded': '本次任务的总期限已到。',
}

/** Every control is protected before delivery. Remounts query the original receipt before retrying. */
function useAgentControl(scope: string, target: string, readOnly: boolean, request: Request, confirmed: () => Promise<void>) {
  const { workspace } = useActivitySession()
  const key = JSON.stringify([scope, 'agent-control', target])
  const protection = useSyncExternalStore(workspace.subscribe, () => workspace.inputProtection(key))
  const [record, setRecord] = useState<LocalAgentControl | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const alive = useRef(false), writable = useRef(!readOnly), delivering = useRef(false)
  const onConfirmed = useRef(confirmed)
  writable.current = !readOnly; onConfirmed.current = confirmed
  const deliver = useCallback(async (pending: PendingAgentOperation, notify = false) => {
    if (!alive.current || !writable.current || delivering.current) return
    delivering.current = true; setBusy(true)
    const guardedRequest: Request = (route, body) => {
      if (!alive.current || !writable.current) throw new Error('当前入口已关闭。')
      return request(route, body)
    }
    try {
      const receipt = await deliverAgentOperation(pending, guardedRequest, value => {
        const receipt = teachingControlReceiptSchema.parse(value)
        if (receipt.requestId !== pending.requestId || ('inputId' in receipt ? 'input:' + receipt.inputId : 'run:' + receipt.runId) !== target)
          throw new Error('回执不属于原操作。')
        return receipt
      })
      await confirmAgentOperation(key, pending, receipt)
      const saved = await agentControlStore.change(key, current => {
        if (!current) throw new Error('原记录暂不可用。')
        return receipt.status === 'accepted' && pending.input.operation === 'revise' && current.draft && current.draft.text === pending.input.text
          ? { ...current, draft: { ...current.draft, editing: false,
            expectedVersion: 'input' in receipt && receipt.input ? receipt.input.version : current.draft.expectedVersion } } : current
      })
      if (alive.current) {
        const failure = receipt.status === 'rejected' ? controlReasons[receipt.reason] ?? '操作未生效，原内容仍保留。' : ''
        setRecord(saved); setError(failure)
        if (notify && failure) toast.error(failure)
        await onConfirmed.current()
      }
    } catch { if (alive.current) {
      const failure = '结果尚未确认，原操作和草稿已保留。请核对原操作。'
      setError(failure); if (notify) toast.error(failure)
    } }
    finally { delivering.current = false; if (alive.current) setBusy(false) }
  }, [key, target, request])
  useEffect(() => {
    alive.current = true
    void agentControlStore.read(key).then(saved => {
      if (!alive.current) return
      if (saved && saved.scope !== scope) throw new Error('记录不属于当前空间。')
      const retained = workspace.retainedInput<LocalAgentControl>(key)
      setRecord(retained ? { ...(saved ?? retained), draft: retained.draft, selected: retained.selected } : saved ?? { key, scope })
      if (saved?.pending && writable.current) void deliver(saved.pending)
    }).catch(() => { if (alive.current) {
      setRecord(workspace.retainedInput<LocalAgentControl>(key) ?? null)
      setError('本机保护暂不可用，请保留或复制输入后重试。')
    } })
    return () => { alive.current = false }
  }, [key, scope, deliver, workspace])
  const change = (patch: Partial<Pick<LocalAgentControl, 'draft' | 'selected'>>) => {
    if (!record || !writable.current || record.pending) return
    const value = { ...record, ...patch }
    setRecord(value); setError('')
    void workspace.retainInput(key, value, input => agentControlStore.change(key, saved => ({ ...(saved ?? input),
      draft: input.draft, selected: input.selected }))).catch(() => {})
  }
  const submit = async (route: string, body: Record<string, unknown>) => {
    if (!record || !writable.current || busy) return
    try {
      await workspace.protectInput(key)
      if (!alive.current || !writable.current) return
      const current = await agentControlStore.read(key)
      if (current?.pending) { await deliver(current.pending, true); return }
      const requestId = crypto.randomUUID()
      const pending = { requestId, route, queryRoute: 'controls/' + requestId, input: { ...body, requestId } }
      const saved = await workspace.trackInput(protectAgentOperation(key, scope, pending))
      if (!alive.current) return
      setRecord(saved); await deliver(pending, true)
    } catch { if (alive.current) {
      const failure = '操作尚未在本机可靠保留，原内容仍在这里。'
      setError(failure); toast.error(failure)
    } }
  }
  return { record, error: error || (protection === 'failed' ? '草稿尚未在本机可靠保留，请复制后重试。' : ''), busy,
    protectedDraft: protection === 'protected', change, submit, retry: () => record?.pending && void deliver(record.pending, true) }
}

export function AgentInputRecord({ input, scope, readOnly, request, onConfirmed }: {
  input: TeachingInput; scope: string; readOnly: boolean; request: Request; onConfirmed: () => Promise<void>
}) {
  const control = useAgentControl(scope, 'input:' + input.inputId, readOnly, request, onConfirmed)
  const editing = control.record?.draft?.editing, draft = control.record?.draft
  const editable = ['pending', 'paused'].includes(input.state)
  const disabled = readOnly || !control.record || control.busy || !!control.record.pending
  const status = input.state === 'adopted' ? '已纳入下一步' : input.state === 'removed' ? '已移除 · 接收记录保留'
    : input.state === 'superseded' ? '已转为新的引导输入' : input.state === 'paused' ? '已暂停 · 等你选择如何继续'
      : input.mode === 'queue' ? '已收到 · 等待本轮结束' : '已收到 · 等待下一步纳入'
  return <div className="agent-input-record" data-input-id={input.inputId} data-state={input.state}>
    <p className="detail">{status} · {input.mode === 'queue' ? '本轮结束后处理' : '引导当前任务'}</p>
    {input.version > 1 && <div className="preserve-lines"><span className="detail">当前版本：{input.version}</span><p>{input.input.draft.question}</p></div>}
    {input.state === 'paused' && <><p className="detail">{pauseReasons[input.reason] ?? '原任务未正常完成，输入仍保留，可选择后继续。'}</p>
      {input.reason && <details><summary>技术详情</summary><p className="detail">{input.reason}</p></details>}</>}
    <details><summary>发送时的依据与版本</summary><p className="detail">版本 {input.version}；{input.input.delivery?.basis.source === 'preference' ? '使用当时的个人偏好' : '本次明确选择'}。</p>
      {input.input.draft.references.map(ref => <p className="detail" key={ref.referenceId}>引用：{ref.sourceName}</p>)}
      {input.input.works.map(work => <p className="detail" key={work.objectId}>作品：{work.name}</p>)}
    </details>
    {editable && !editing && !readOnly && <div className="agent-control-actions">
      <button type="button" className="outline" disabled={disabled} onClick={() => control.change({ draft: { text: draft?.text ?? input.input.draft.question,
        expectedVersion: draft?.expectedVersion ?? input.version, editing: true } })}>编辑</button>
      <button type="button" className="outline" disabled={disabled} onClick={() => void control.submit(`inputs/${input.inputId}/control`, { version: 1, expectedVersion: input.version, operation: 'remove' })}>移除</button>
      {input.mode === 'queue' && <button type="button" className="outline" disabled={disabled} onClick={() => void control.submit(`inputs/${input.inputId}/control`, { version: 1, expectedVersion: input.version, operation: 'promote' })}>改为引导</button>}
    </div>}
    {!editable && !editing && draft && (draft.text !== input.input.draft.question || draft.expectedVersion !== input.version) && <button type="button"
      className="outline" disabled={disabled} onClick={() => control.change({ draft: { ...draft, editing: true } })}>查看保留的修改草稿</button>}
    {editing && draft && <div className="agent-input-editor">
      <label>修改待处理内容<textarea aria-label="修改待处理内容" rows={4} value={draft.text} disabled={disabled} maxLength={QUESTION_TEXT_MAX_LENGTH}
        onChange={event => control.change({ draft: { ...draft, text: event.target.value } })} /></label>
      <div className="agent-control-actions">
        <button type="button" className="primary" disabled={disabled || !editable || !draft.text.trim()} onClick={() => void control.submit(`inputs/${input.inputId}/control`,
          { version: 1, operation: 'revise', expectedVersion: draft.expectedVersion, text: draft.text })}>保存修改</button>
        <button type="button" className="outline" disabled={disabled} onClick={() => control.change({ draft: { ...draft, editing: false } })}>保留草稿并收起</button>
        <button type="button" className="outline" onClick={() => void navigator.clipboard.writeText(draft.text)
          .catch(() => toast.error('暂时无法复制，请直接选中输入文字保存。'))}>复制修改草稿</button>
      </div>
      {control.protectedDraft && <p className="detail" role="status">修改草稿已在本机保留。</p>}
      {!editable && <p className="detail">这条输入已处理，当前修改没有被采用。可复制后另行补充。</p>}
    </div>}
    {control.record?.pending && !readOnly && <button className="outline" type="button" disabled={control.busy} onClick={control.retry}>核对原操作</button>}
    {control.error && <p role="alert" className="learning-error">{control.error}</p>}
  </div>
}

export function AgentRunControls({ run, inputs, scope, readOnly, request, onConfirmed }: {
  run: TeachingRun; inputs: TeachingInput[]; scope: string; readOnly: boolean; request: Request; onConfirmed: () => Promise<void>
}) {
  const control = useAgentControl(scope, 'run:' + run.runId, readOnly, request, onConfirmed)
  const active = ['received', 'running', 'dispatching', 'waiting'].includes(run.state)
  const resumable = isRecoverableTeachingPause(run)
  const choices = inputs.filter(input => input.state === 'paused' || input.state === 'pending')
  const selected = control.record?.selected ?? []
  const disabled = readOnly || !control.record || control.busy || !!control.record.pending
  return <div className="agent-run-controls">
    {active ? !readOnly && <button type="button" className="outline" disabled={disabled || run.stopRequested}
      onClick={() => void control.submit(`runs/${run.runId}/stop`, {})}>停止</button> : <>
      {choices.length > 0 && <fieldset disabled={disabled}><legend>选择要继续处理的输入</legend>{choices.map(input => <label key={input.inputId}>
        <input type="checkbox" checked={selected.some(item => item.inputId === input.inputId)} onChange={event => control.change({ selected: event.target.checked
          ? [...selected, { inputId: input.inputId, expectedVersion: input.version }] : selected.filter(item => item.inputId !== input.inputId) })} />
        <span>{input.input.draft.question}</span></label>)}</fieldset>}
      {!readOnly && (resumable || choices.length > 0) && <button className="outline" type="button" disabled={disabled || !resumable && !selected.length}
        onClick={() => void control.submit(`runs/${run.runId}/continue`, { version: 2, inputs: selected })}>{resumable ? '继续原任务' : '继续选中的输入'}</button>}
      {!resumable && !choices.length && <p className="detail">原任务已结束，可在输入区提出新的问题。</p>}
    </>}
    {control.record?.pending && !readOnly && <button className="outline" type="button" disabled={control.busy} onClick={control.retry}>核对原操作</button>}
    {control.error && <p role="alert" className="learning-error">{control.error}</p>}
  </div>
}
