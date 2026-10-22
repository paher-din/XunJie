import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { submissionReference, referenceKey, snapshotReference, type ReferenceSelection, type ReferenceSource,
  type ReferenceSubmission, type WorkspaceReference } from './model'
import './references.css'

interface ReferencesController {
  workspaceKey: string
  open: boolean
  setOpen(open: boolean): void
  question: string
  setQuestion(text: string): void
  references: readonly WorkspaceReference[]
  pending: ReferenceSelection | null
  /** A gesture token identifies one completed user selection; passive notifications never add. */
  select(selection: ReferenceSelection | null, gesture?: object): void
  clearSelection(sourceId: string): void
  ask(): void
  remove(id: string): void
  locate(reference: WorkspaceReference): void
  register(source: ReferenceSource): () => void
  submit(): Promise<void>
  busy: boolean
  notice: string
}
const Context = createContext<ReferencesController | null>(null)
export function useWorkspaceReferences(): ReferencesController {
  const value = useContext(Context)
  if (!value) throw new Error('WorkspaceReferencesProvider is required')
  return value
}
export interface WorkspaceReferencesProviderProps {
  workspaceKey: string
  onSubmit(submission: ReferenceSubmission): Promise<void> | void
  children: ReactNode
}
/** Identity is a hard React lifetime boundary, including pending asynchronous sends. */
export function WorkspaceReferencesProvider(props: WorkspaceReferencesProviderProps) {
  return <ReferencesSession key={props.workspaceKey} {...props} />
}
function ReferencesSession({ workspaceKey, onSubmit, children }: WorkspaceReferencesProviderProps) {
  const [open, setOpenState] = useState(false)
  const [question, setQuestionState] = useState('')
  const [references, setReferences] = useState<readonly WorkspaceReference[]>([])
  const [pending, setPending] = useState<ReferenceSelection | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const state = useRef({ open, question, references, pending })
  state.current = { open, question, references, pending }
  const revision = useRef(0), sequence = useRef(0), inFlight = useRef(false), alive = useRef(true)
  const sources = useRef(new Map<string, ReferenceSource>())
  const gestures = useRef(new WeakSet<object>())
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const add = useCallback((selection: ReferenceSelection) => {
    const snapshot = snapshotReference(selection.snapshot)
    if (!snapshot || snapshot.workspaceKey !== workspaceKey || !sources.current.has(snapshot.sourceId)) return
    if (state.current.references.some(ref => referenceKey(ref) === referenceKey(snapshot))) return
    const next = [...state.current.references, Object.freeze({ ...snapshot, id: `${workspaceKey}:${++sequence.current}` })]
    state.current.references = next
    revision.current++
    setReferences(next)
  }, [workspaceKey])
  const select = useCallback((selection: ReferenceSelection | null, gesture?: object) => {
    if (selection && (selection.snapshot.workspaceKey !== workspaceKey || !sources.current.has(selection.snapshot.sourceId))) return
    if (selection) {
      const snapshot = snapshotReference(selection.snapshot)
      selection = snapshot ? { snapshot, anchor: selection.anchor } : null
    }
    state.current.pending = selection
    setPending(selection)
    if (gesture && !gestures.current.has(gesture)) {
      gestures.current.add(gesture)
      if (selection && state.current.open) add(selection)
    }
  }, [workspaceKey, add])
  const clearSelection = useCallback((sourceId: string) => {
    if (state.current.pending?.snapshot.sourceId === sourceId) {
      state.current.pending = null
      setPending(null)
    }
  }, [])
  const register = useCallback((source: ReferenceSource) => {
    if (sources.current.has(source.sourceId)) throw new Error(`Duplicate reference source: ${source.sourceId}`)
    revision.current++
    sources.current.set(source.sourceId, source)
    return () => {
      if (sources.current.get(source.sourceId) === source) {
        revision.current++
        sources.current.delete(source.sourceId)
        clearSelection(source.sourceId)
      }
    }
  }, [clearSelection])
  const setOpen = (value: boolean) => {
    state.current.open = value
    setOpenState(value)
    // Opening an empty composer does not silently import a stale selection.
    state.current.pending = null
    setPending(null)
  }
  const ask = () => {
    const selected = state.current.pending
    if (!selected) return
    const source = sources.current.get(selected.snapshot.sourceId)
    // Selection snapshots already exist before toolbar focus. Do not recapture the DOM here.
    if (!source) { setNotice('来源当前不可用，请重新选择。'); return }
    add(selected)
    setOpen(true)
  }
  const remove = (id: string) => {
    const next = state.current.references.filter(ref => ref.id !== id)
    state.current.references = next
    setReferences(next)
    revision.current++
  }
  const setQuestion = (text: string) => {
    state.current.question = text
    setQuestionState(text)
    revision.current++
  }
  const locate = (reference: WorkspaceReference) => {
    if (reference.workspaceKey !== workspaceKey) { setNotice('引用属于其他工作区，当前无法定位。'); return }
    try {
      const result = sources.current.get(reference.sourceId)?.locate(reference)
      setNotice(result?.ok ? '已定位引用来源。' : result?.reason ?? '来源当前不可用；引用副本仍然保留。')
    } catch { setNotice('来源当前不可用；引用副本仍然保留。') }
  }
  const submit = async () => {
    if (inFlight.current || !state.current.question.trim()) return
    inFlight.current = true
    setBusy(true)
    setNotice('正在交给接收方…')
    const version = revision.current
    const submission: ReferenceSubmission = Object.freeze({ workspaceKey, question: state.current.question,
      references: Object.freeze(state.current.references.map(submissionReference)) })
    try {
      await onSubmit(submission)
      if (!alive.current) return
      if (revision.current === version) {
        state.current.question = ''
        state.current.references = []
        setQuestionState('')
        setReferences([])
        revision.current++
        setNotice('已交给接收方。')
      } else setNotice('已交给接收方；发送期间的新草稿已保留。')
    } catch {
      if (alive.current) setNotice('发送未完成，草稿已保留，请稍后重试。')
    } finally {
      inFlight.current = false
      if (alive.current) setBusy(false)
    }
  }
  return <Context.Provider value={{ workspaceKey, open, setOpen, question, setQuestion, references, pending,
    select, clearSelection, ask, remove, locate, register, submit, busy, notice }}>{children}</Context.Provider>
}

export function WorkspaceReferenceList() {
  const { references, remove, locate } = useWorkspaceReferences()
  return <section className="wr-references" aria-label="上下文引用">
    {references.length === 0 ? <p className="wr-hint">选择材料或代码，可将片段加入问题。</p> :
      <ol>{references.map((ref, index) => <li key={ref.id}>
        <div className="wr-reference-heading"><button type="button" onClick={() => locate(ref)}
          aria-label={`定位引用 ${index + 1}：${ref.sourceName}`}>{ref.sourceName}</button>
          <button type="button" aria-label={`移除引用 ${index + 1}`} onClick={() => remove(ref.id)}>移除</button></div>
        <pre data-kind={ref.kind}>{ref.text}</pre>
      </li>)}</ol>}
  </section>
}
/** Optional composer; callers can also compose the controller and reference list with their own input. */
export function WorkspaceReferenceComposer() {
  const { open, setOpen, question, setQuestion, submit, busy, notice } = useWorkspaceReferences()
  const input = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const questionId = useId()
  useEffect(() => { if (open) input.current?.focus() }, [open])
  if (!open) return <button className="wr-button" type="button" onClick={() => setOpen(true)}>打开对话</button>
  return <section className="wr-composer" aria-label="Agent 问题草稿" data-reference-ui>
    <header><h2>询问 Agent</h2><button type="button" onClick={() => setOpen(false)}>收起对话</button></header>
    <WorkspaceReferenceList />
    <form onSubmit={event => { event.preventDefault(); void submit() }}>
      <label htmlFor={questionId}>你的问题</label>
      <textarea ref={input} id={questionId} value={question}
        onChange={event => setQuestion(event.target.value)} placeholder="写下想讨论的问题…"
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault(); void submit()
          }
        }} />
      <div className="wr-send"><span className="wr-hint">Enter 发送 · Shift + Enter 换行</span>
        <button className="wr-primary" type="submit" disabled={busy || !question.trim()}>{busy ? '发送中…' : '发送问题'}</button></div>
    </form>
    <p role="status" className="wr-notice">{notice}</p>
  </section>
}
