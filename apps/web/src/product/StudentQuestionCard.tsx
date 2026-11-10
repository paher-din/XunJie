import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from '@xunjie/ui/feedback'
import { teachingStudentResponseInputSchema, teachingStudentResponseReceiptSchema } from '@xunjie/contracts/teaching-agent'
import type { TeachingStudentQuestion } from '@xunjie/contracts/teaching-agent'
import { canonicalValue } from '@xunjie/contracts/execution'
import { StudentResponseStore, type LocalStudentResponse } from '../reliable-workspace/student-responses'
import { deliverAgentOperation } from '../reliable-workspace/agent-controls'
import { useActivitySession } from './ActivitySession'
import './student-questions.css'

const store = new StudentResponseStore()
const reasons: Record<string, string> = {
  expired: '这次提问已到期，这份回应未用于继续原任务。', cancelled: '原任务已停止，这份回应未用于继续。',
  'already-answered': '这个问题已有明确回应，这份输入没有重复推进任务。',
  'version-mismatch': '问题已变化，这份输入没有用于另一个问题。',
  'question-missing': '原问题当前不可用，这份输入仍保留。',
  'activity-closed': '活动已关闭，这份输入仍保留。', 'run-terminated': '原任务已结束，这份输入仍保留。',
  'question-superseded': '原提问已暂缓，这份回应未用于当前问题，可另行补充。',
}

export function StudentQuestionCard({ question, activityId, scope, readOnly, request, onConfirmed, focusRequested, onFocused }: {
  question: TeachingStudentQuestion; activityId: string; scope: string; readOnly: boolean
  request: (route: string, body?: unknown) => Promise<unknown>
  onConfirmed: () => Promise<void>; focusRequested?: boolean; onFocused?: () => void
}) {
  const { draft, workspace } = useActivitySession()
  const key = JSON.stringify([scope, question.questionId, question.version, question.waitVersion])
  const protection = useSyncExternalStore(workspace.subscribe, () => workspace.inputProtection(key))
  const [record, setRecord] = useState<LocalStudentResponse | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const alive = useRef(false), writable = useRef(!readOnly), card = useRef<HTMLElement>(null)
  writable.current = !readOnly
  const initial = useCallback((): LocalStudentResponse => ({ key, scope, presentationId: crypto.randomUUID(),
    mode: question.options.length ? 'choice' : 'text', optionId: '', text: '' }), [key, scope, question.options.length])
  const deliver = useCallback(async (saved: LocalStudentResponse, notify = false) => {
    if (!saved.input || !alive.current || !writable.current) return
    setBusy(true)
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(canonicalValue({ activityId, questionId: question.questionId, input: saved.input })))
      const inputDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
      if (!alive.current || !writable.current) return
      const receipt = await deliverAgentOperation({ requestId: saved.input.requestId, queryRoute: `responses/${saved.input.requestId}`,
        route: `questions/${question.questionId}/responses`, input: saved.input }, (route, body) => {
        if (!alive.current || !writable.current) throw new Error('原回应入口已关闭。')
        return request(route, body)
      }, value => teachingStudentResponseReceiptSchema.parse(value))
      if (!alive.current || !writable.current) return
      if (receipt.requestId !== saved.input.requestId || receipt.questionId !== question.questionId
        || receipt.questionVersion !== saved.input.questionVersion || receipt.waitVersion !== saved.input.waitVersion || receipt.inputDigest !== inputDigest)
        throw new Error('回应回执不属于原输入。')
      const updated = await store.change(key, current => {
        if (!current || current.input?.requestId !== saved.input!.requestId) throw new Error('原回应需要重新核对。')
        return { ...current, receipt }
      })
      if (alive.current) {
        setRecord(updated); setError('')
        if (notify && receipt.status === 'rejected') toast.warning(reasons[receipt.reason] ?? '这份回应未用于当前问题，输入仍保留。')
        await onConfirmed()
      }
    } catch {
      if (alive.current) {
        const failure = '回应结果尚未确认，输入已保留。请核对原回应；不会另建一次提交。'
        setError(failure); if (notify) toast.error(failure)
      }
    } finally { if (alive.current) setBusy(false) }
  }, [key, activityId, question.questionId, request, onConfirmed])
  useEffect(() => {
    alive.current = true
    void (async () => {
      let saved: LocalStudentResponse
      try {
        const retained = workspace.retainedInput<LocalStudentResponse>(key)
        saved = await store.read(key) ?? retained ?? initial()
        if (saved.scope !== scope) throw new Error('回应不属于当前空间。')
        if (retained) saved = { ...saved, mode: retained.mode, optionId: retained.optionId, text: retained.text }
        else if (writable.current) saved = await store.change(key, current => current ?? saved)
        if (!alive.current) return
        setRecord(saved)
        if (saved.input && !saved.receipt) void deliver(saved)
      } catch { if (alive.current) {
        setRecord(workspace.retainedInput<LocalStudentResponse>(key) ?? initial())
        setError('本机保护暂不可用，请保留或复制输入后重试。')
      } }
    })()
    return () => { alive.current = false }
  }, [key, scope, initial, deliver, workspace])
  useEffect(() => {
    if (!focusRequested || !card.current) return
    card.current.focus({ preventScroll: true }); card.current.scrollIntoView({ block: 'nearest' }); onFocused?.()
  }, [focusRequested, onFocused])
  useEffect(() => {
    if (!record || readOnly || question.state !== 'pending' || !card.current) return
    let submitted = false, visible = false
    const acknowledge = () => {
      if (!submitted && visible && !document.hidden && alive.current && writable.current) {
        submitted = true
        void request(`questions/${question.questionId}/presentations`, { requestId: record.presentationId,
          questionVersion: question.version, waitVersion: question.waitVersion }).catch(() => { submitted = false })
      }
    }
    const observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); acknowledge() })
    observer.observe(card.current); document.addEventListener('visibilitychange', acknowledge)
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', acknowledge) }
  }, [record?.presentationId, readOnly, question.questionId, question.version, question.waitVersion, question.state, request])
  const edit = (change: Partial<Pick<LocalStudentResponse, 'mode' | 'optionId' | 'text'>>) => {
    if (!record || readOnly || busy || record.input && !record.receipt) return
    const value = { ...record, ...change }
    setRecord(value); setError('')
    void workspace.retainInput(key, value, input => store.change(key, current => ({ ...(current ?? input),
      mode: input.mode, optionId: input.optionId, text: input.text }))).catch(() => {})
  }
  const submit = async (skip = false) => {
    if (!record || !writable.current || busy || question.state !== 'pending') return
    setBusy(true)
    try {
      await workspace.protectInput(key)
      if (!alive.current || !writable.current) return
      const saved = await store.change(key, current => {
        if (current?.input && !current.receipt) return current
        const { receipt: _receipt, ...draft } = current ?? record
        return { ...draft, mode: record.mode, text: record.text, optionId: record.optionId,
          input: teachingStudentResponseInputSchema.parse({ requestId: crypto.randomUUID(), questionVersion: question.version,
            waitVersion: question.waitVersion, answer: skip ? { kind: 'skip' } : record.mode === 'choice'
              ? { kind: 'choice', optionId: record.optionId } : { kind: 'text', text: record.text } }) }
      })
      if (!alive.current) return
      setRecord(saved)
      await deliver(saved, true)
    } catch { if (alive.current) {
      const failure = '回应尚未在本机可靠保留，输入仍在这里，请复制或重试。'
      setError(failure); toast.error(failure)
    } }
    finally { if (alive.current) setBusy(false) }
  }
  const pending = !!record?.input && !record.receipt
  const canAnswer = question.state === 'pending' && !readOnly && !pending && !busy
  const valid = record?.mode === 'choice' ? !!record.optionId : !!record?.text.trim()
  const status = question.state === 'answered' ? '回应已接收，内容保留在对话中。' : question.state === 'skipped' ? '你已明确跳过这次提问。'
    : question.state === 'expired' ? '这次提问已到期，回应入口已关闭。' : question.state === 'cancelled' ? '原任务已停止，这次提问已取消。'
      : question.state === 'superseded' ? '已暂缓：你已补充新的方向，原提问关闭，未把未交的内容当作回应。'
        : readOnly ? '当前只读，可以查看原问题与回应。' : '等你明确回应；关闭或忽略不会记作回答。'
  return <section ref={card} role="group" aria-label="Agent 的提问" tabIndex={-1}
    className="student-question" data-student-question={question.questionId} data-state={question.state}>
    <h4>Agent 的提问</h4><p className="preserve-lines student-question-prompt">{question.question}</p>
    <p className="student-question-source">依据：{question.source.detail}</p>
    {question.state === 'pending' && record && <form onSubmit={event => { event.preventDefault(); void submit() }}>
      {question.options.length > 0 && <fieldset disabled={!canAnswer}><legend>选择你的回答</legend>
        {question.options.map(option => <label key={option.id}><input type="radio" name={key} checked={record.mode === 'choice' && record.optionId === option.id}
          onChange={() => edit({ mode: 'choice', optionId: option.id })} />{option.label}</label>)}
        {question.allowText && <label><input type="radio" name={key} checked={record.mode === 'text'} onChange={() => edit({ mode: 'text' })} />用自己的话回答</label>}
      </fieldset>}
      {question.allowText && record.mode === 'text' && <div className="student-question-text">
        <label htmlFor={`student-answer-${question.questionId}`}>你的回应</label>
        <textarea id={`student-answer-${question.questionId}`} value={record.text} disabled={!canAnswer} maxLength={4000}
          onChange={event => edit({ text: event.target.value })} rows={4} />
      </div>}
      <div className="student-question-actions"><button type="submit" className="primary" disabled={!canAnswer || !valid}>提交回应</button>
        {question.skippable && <button type="button" className="outline" disabled={!canAnswer} onClick={() => void submit(true)}>跳过这次提问</button>}</div>
      {pending && !readOnly && <p className="detail">正在核对原回应，输入已保留。</p>}
    </form>}
    <p className="student-question-status" role="status">{status}</p>
    {pending && !readOnly && <button type="button" className="outline" disabled={busy} onClick={() => void deliver(record!, true)}>核对原回应</button>}
    {record?.receipt?.status === 'rejected' && <p className="detail">{reasons[record.receipt.reason] ?? '这份回应未用于当前问题，输入仍保留。'}</p>}
    {(error || protection === 'failed') && <p className="learning-error" role="alert">{error || '输入尚未在本机可靠保留，请复制后重试。'}</p>}
    {record && (record.text || record.optionId) && <button type="button" className="student-response-copy" onClick={() => {
      void navigator.clipboard.writeText(record.text || question.options.find(option => option.id === record.optionId)?.label || '').catch(() => toast.error('暂时无法复制，请直接选中输入文字保存。'))
    }}>复制保留的回应</button>}
    {record && (record.text || record.optionId) && question.state === 'superseded' && !readOnly && <button type="button" className="outline" onClick={() => {
      const text = record.text || question.options.find(option => option.id === record.optionId)?.label || ''
      const current = draft.snapshot()
      draft.change([current.question, text].filter(Boolean).join('\n\n'), current.references)
    }}>作为新的补充放入输入区</button>}
  </section>
}
