import { useCallback, useEffect, useRef, useState } from 'react'
import { teachingStudentResponseInputSchema, teachingStudentResponseReceiptSchema } from '@xunjie/contracts/teaching-agent'
import type { TeachingStudentQuestion } from '@xunjie/contracts/teaching-agent'
import { canonicalValue } from '@xunjie/contracts/execution'
import { StudentResponseStore, type LocalStudentResponse } from '../reliable-workspace/student-responses'
import './student-questions.css'

const store = new StudentResponseStore()
const reasons: Record<string, string> = {
  expired: '这次提问已到期，这份回应未用于继续原任务。', cancelled: '原任务已停止，这份回应未用于继续。',
  'already-answered': '这个问题已有明确回应，这份输入没有重复推进任务。',
  'version-mismatch': '问题已变化，这份输入没有用于另一个问题。',
  'question-missing': '原问题当前不可用，这份输入仍保留。',
  'activity-closed': '活动已关闭，这份输入仍保留。', 'run-terminated': '原任务已结束，这份输入仍保留。',
}

export function StudentQuestionCard({ question, activityId, scope, readOnly, request, onConfirmed, focusRequested, onFocused }: {
  question: TeachingStudentQuestion; activityId: string; scope: string; readOnly: boolean
  request: (route: string, body?: unknown) => Promise<unknown>
  onConfirmed: () => Promise<void>; focusRequested?: boolean; onFocused?: () => void
}) {
  const key = JSON.stringify([scope, question.questionId, question.version, question.waitVersion])
  const [record, setRecord] = useState<LocalStudentResponse | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [protectedInput, setProtectedInput] = useState(false)
  const alive = useRef(false), writable = useRef(!readOnly), card = useRef<HTMLElement>(null)
  const writes = useRef<Promise<unknown>>(Promise.resolve()), revision = useRef(0)
  writable.current = !readOnly
  const initial = useCallback((): LocalStudentResponse => ({ key, scope, presentationId: crypto.randomUUID(),
    mode: question.options.length ? 'choice' : 'text', optionId: '', text: '' }), [key, scope, question.options.length])
  const deliver = useCallback(async (saved: LocalStudentResponse) => {
    if (!saved.input || !alive.current || !writable.current) return
    setBusy(true)
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(canonicalValue({ activityId, questionId: question.questionId, input: saved.input })))
      const inputDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
      if (!alive.current || !writable.current) return
      const known = await request(`responses/${saved.input.requestId}`)
      if (!alive.current || !writable.current) return
      const receipt = teachingStudentResponseReceiptSchema.parse(known ?? await request(`questions/${question.questionId}/responses`, saved.input))
      if (!alive.current || !writable.current) return
      if (receipt.requestId !== saved.input.requestId || receipt.questionId !== question.questionId
        || receipt.questionVersion !== saved.input.questionVersion || receipt.waitVersion !== saved.input.waitVersion || receipt.inputDigest !== inputDigest)
        throw new Error('回应回执不属于原输入。')
      const updated = await store.change(key, current => {
        if (!current || current.input?.requestId !== saved.input!.requestId) throw new Error('原回应需要重新核对。')
        return { ...current, receipt }
      })
      if (alive.current) { setRecord(updated); setError(''); setProtectedInput(true); await onConfirmed() }
    } catch {
      if (alive.current) setError('回应结果尚未确认，输入已保留。请核对原回应；不会另建一次提交。')
    } finally { if (alive.current) setBusy(false) }
  }, [key, activityId, question.questionId, request, onConfirmed])
  useEffect(() => {
    alive.current = true
    void (async () => {
      let saved: LocalStudentResponse
      try {
        saved = await store.read(key) ?? initial()
        if (saved.scope !== scope) throw new Error('回应不属于当前空间。')
        if (writable.current) saved = await store.change(key, current => current ?? saved)
        if (!alive.current) return
        setRecord(saved); setProtectedInput(true)
        if (saved.input && !saved.receipt) void deliver(saved)
      } catch { if (alive.current) { setRecord(initial()); setError('本机保护暂不可用，请保留或复制输入后重试。') } }
    })()
    return () => { alive.current = false }
  }, [key, scope, initial, deliver])
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
    const value = { ...record, ...change }, version = ++revision.current
    setRecord(value); setProtectedInput(false)
    writes.current = writes.current.catch(() => {}).then(() => store.change(key, current => ({ ...(current ?? value), ...change })))
    void writes.current.then(() => { if (alive.current && revision.current === version) { setProtectedInput(true); setError('') } })
      .catch(() => { if (alive.current) setError('输入尚未在本机可靠保留，请复制后重试。') })
  }
  const submit = async (skip = false) => {
    if (!record || !writable.current || busy || question.state !== 'pending') return
    setBusy(true)
    try {
      await writes.current.catch(() => {})
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
      setRecord(saved); setProtectedInput(true)
      await deliver(saved)
    } catch { if (alive.current) setError('回应尚未在本机可靠保留，输入仍在这里，请复制或重试。') }
    finally { if (alive.current) setBusy(false) }
  }
  const pending = !!record?.input && !record.receipt
  const canAnswer = question.state === 'pending' && !readOnly && !pending && !busy
  const valid = record?.mode === 'choice' ? !!record.optionId : !!record?.text.trim()
  const status = question.state === 'answered' ? '回应已接收，内容保留在对话中。' : question.state === 'skipped' ? '你已明确跳过这次提问。'
    : question.state === 'expired' ? '这次提问已到期，原任务已暂停。' : question.state === 'cancelled' ? '原任务已停止，这次提问已取消。'
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
      {!readOnly && <p className="detail">{pending ? '正在核对原回应，输入已保留。' : protectedInput ? '输入已在本机保留。' : '正在保护输入…'}</p>}
    </form>}
    <p className="student-question-status" role="status">{status}</p>
    {pending && !readOnly && <button type="button" className="outline" disabled={busy} onClick={() => void deliver(record!)}>核对原回应</button>}
    {record?.receipt?.status === 'rejected' && <p className="detail">{reasons[record.receipt.reason] ?? '这份回应未用于当前问题，输入仍保留。'}</p>}
    {error && <p className="learning-error" role="alert">{error}</p>}
    {record && (record.text || record.optionId) && <button type="button" className="student-response-copy" onClick={() => {
      void navigator.clipboard.writeText(record.text || question.options.find(option => option.id === record.optionId)?.label || '').catch(() => setError('暂时无法复制，请直接选中输入文字保存。'))
    }}>复制保留的回应</button>}
  </section>
}
