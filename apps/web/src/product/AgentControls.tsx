import { useCallback, useEffect, useRef, useState } from 'react'
import { teachingControlReceiptSchema, isRecoverableTeachingPause } from '@xunjie/contracts/teaching-agent'
import type { TeachingInput, TeachingRun } from '@xunjie/contracts/teaching-agent'
import { agentControlStore, protectAgentOperation, confirmAgentOperation, deliverAgentOperation,
  type LocalAgentControl, type PendingAgentOperation } from '../reliable-workspace/agent-controls'
import './agent-interaction.css'

type Request = (route: string, body?: unknown) => Promise<unknown>
const controlReasons: Record<string, string> = {
  'input-consumed': '这条输入已采用，修改未生效；你的修改草稿仍保留。',
  'version-mismatch': '输入版本已变化，操作未生效；你的修改草稿仍保留。',
  'input-closed': '这条输入已移除或转为引导，操作未生效。',
  'original-effects-unconfirmed': '原操作仍在核对，暂时不能建立后继任务。',
  'select-inputs': '请先选择要继续处理的输入。', 'run-active': '当前任务仍在运行，请先核对其状态。',
}

/** Every control is protected before delivery. Remounts query the original receipt before retrying. */
function useAgentControl(scope: string, target: string, readOnly: boolean, request: Request, confirmed: () => Promise<void>) {
  const key = JSON.stringify([scope, 'agent-control', target])
  const [record, setRecord] = useState<LocalAgentControl | null>(null)
  const [protectedDraft, setProtectedDraft] = useState(true)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const alive = useRef(false), writable = useRef(!readOnly), delivering = useRef(false), revision = useRef(0)
  const writes = useRef<Promise<unknown>>(Promise.resolve()), onConfirmed = useRef(confirmed)
  writable.current = !readOnly; onConfirmed.current = confirmed
  const deliver = useCallback(async (pending: PendingAgentOperation) => {
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
          ? { ...current, draft: { ...current.draft, editing: false } } : current
      })
      if (alive.current) {
        setRecord(saved); setError(receipt.status === 'rejected' ? controlReasons[receipt.reason] ?? '操作未生效，原内容仍保留。' : '')
        await onConfirmed.current()
      }
    } catch { if (alive.current) setError('结果尚未确认，原操作和草稿已保留。请核对原操作。') }
    finally { delivering.current = false; if (alive.current) setBusy(false) }
  }, [key, target, request])
  useEffect(() => {
    alive.current = true
    void agentControlStore.read(key).then(saved => {
      if (!alive.current) return
      if (saved && saved.scope !== scope) throw new Error('记录不属于当前空间。')
      setRecord(saved ?? { key, scope })
      if (saved?.pending && writable.current) void deliver(saved.pending)
    }).catch(() => { if (alive.current) setError('本机保护暂不可用，请保留或复制输入后重试。') })
    return () => { alive.current = false }
  }, [key, scope, deliver])
  const change = (patch: Partial<Pick<LocalAgentControl, 'draft' | 'selected'>>) => {
    if (!record || !writable.current || record.pending) return
    const version = ++revision.current
    setProtectedDraft(false)
    setRecord({ ...record, ...patch })
    writes.current = writes.current.catch(() => {}).then(() => agentControlStore.change(key, saved => ({ ...(saved ?? record), ...patch })))
    void writes.current.then(() => { if (alive.current && revision.current === version) { setError(''); setProtectedDraft(true) } })
      .catch(() => { if (alive.current) setError('草稿尚未在本机可靠保留，请复制后重试。') })
  }
  const submit = async (route: string, body: Record<string, unknown>) => {
    if (!record || !writable.current || busy) return
    try {
      await writes.current
      if (!alive.current || !writable.current) return
      const current = await agentControlStore.read(key)
      if (current?.pending) { await deliver(current.pending); return }
      const requestId = crypto.randomUUID()
      const pending = { requestId, route, queryRoute: 'controls/' + requestId, input: { ...body, requestId } }
      const saved = await protectAgentOperation(key, scope, pending)
      if (!alive.current) return
      setRecord(saved); await deliver(pending)
    } catch { if (alive.current) setError('操作尚未在本机可靠保留，原内容仍在这里。') }
  }
  return { record, error, busy, protectedDraft, change, submit, retry: () => record?.pending && void deliver(record.pending) }
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
    {input.state === 'paused' && <p className="detail">暂停原因：{input.reason || '原任务未正常完成'}</p>}
    <details><summary>发送时的依据与版本</summary><p className="detail">版本 {input.version}；{input.input.delivery?.basis.source === 'preference' ? '使用当时的个人偏好' : '本次明确选择'}。</p>
      {input.input.draft.references.map(ref => <p className="detail" key={ref.referenceId}>引用：{ref.sourceName}</p>)}
      {input.input.works.map(work => <p className="detail" key={work.objectId}>作品：{work.name}</p>)}
    </details>
    {editable && !editing && !readOnly && <div className="agent-control-actions">
      <button type="button" className="outline" disabled={disabled} onClick={() => control.change({ draft: { text: input.input.draft.question, expectedVersion: input.version, editing: true } })}>编辑</button>
      <button type="button" className="outline" disabled={disabled} onClick={() => void control.submit(`inputs/${input.inputId}/control`, { version: 1, expectedVersion: input.version, operation: 'remove' })}>移除</button>
      {input.mode === 'queue' && <button type="button" className="outline" disabled={disabled} onClick={() => void control.submit(`inputs/${input.inputId}/control`, { version: 1, expectedVersion: input.version, operation: 'promote' })}>改为引导</button>}
    </div>}
    {editing && draft && <div className="agent-input-editor">
      <label>修改待处理内容<textarea aria-label="修改待处理内容" rows={4} value={draft.text} disabled={disabled} maxLength={8000}
        onChange={event => control.change({ draft: { ...draft, text: event.target.value } })} /></label>
      <div className="agent-control-actions">
        <button type="button" className="primary" disabled={disabled || !editable || !draft.text.trim()} onClick={() => void control.submit(`inputs/${input.inputId}/control`,
          { version: 1, operation: 'revise', expectedVersion: draft.expectedVersion, text: draft.text })}>保存修改</button>
        <button type="button" className="outline" disabled={disabled} onClick={() => control.change({ draft: { ...draft, editing: false } })}>保留草稿并收起</button>
        <button type="button" className="outline" onClick={() => void navigator.clipboard.writeText(draft.text)}>复制修改草稿</button>
      </div>
      <p className="detail" role="status">{control.protectedDraft ? '修改草稿已在本机保留。' : '正在保护修改草稿…'}</p>
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
