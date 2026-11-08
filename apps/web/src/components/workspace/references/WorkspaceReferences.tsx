import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { QUESTION_TEXT_MAX_LENGTH } from '@xunjie/contracts/question-drafts'
import type { QuestionSkill } from '@xunjie/contracts/question-drafts'
import { submissionReference, referenceKey, snapshotReference, type ReferenceSelection, type ReferenceSource,
  type ReferenceSubmission, type WorkspaceReference } from './model'
import './references.css'
import { composerView, rememberComposerCaret, rememberComposerView, beginComposerComposition, endComposerComposition } from './composer-view'

export interface ReferencesController {
  viewActive?: boolean
  skills?: DraftSkillsController
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
  /** False when the real business receiver is not connected yet; drafts still persist. */
  sendAvailable: boolean
  draftReady: boolean
  readOnly?: boolean
  draftError: string
  draftConflict?: { local: DraftReferenceContent; other: DraftReferenceContent }
  draftConflictReady: boolean
  resolveDraftConflict?(side: 'local' | 'other'): Promise<void> | void
}
export interface DraftSkillsController {
  selected: QuestionSkill[]
  defaults?: QuestionSkill[]; explicit?: boolean
  options: { skillId: string; version: number; name: string; description: string; unavailable?: string; fixed?: boolean }[]
  loading: boolean; error: string; reload(): void; choose(skills?: QuestionSkill[]): void
  isCurrent?(): boolean
}
export interface DraftReferenceContent { question: string; references: readonly WorkspaceReference[]; skills?: QuestionSkill[] }
export const ReferencesContext = createContext<ReferencesController | null>(null)
export function useWorkspaceReferences(): ReferencesController {
  const value = useContext(ReferencesContext)
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
  const locateSequence = useRef(0)
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
  const locate = async (reference: WorkspaceReference) => {
    const sequence = ++locateSequence.current
    if (reference.workspaceKey !== workspaceKey) { setNotice('引用属于其他工作区，当前无法定位。'); return }
    try {
      const result = await sources.current.get(reference.sourceId)?.locate(reference)
      if (sequence !== locateSequence.current) return
      setNotice(result?.ok ? '已定位引用来源。' : result?.reason ?? '来源当前不可用；引用副本仍然保留。')
    } catch { if (sequence === locateSequence.current) setNotice('来源当前不可用；引用副本仍然保留。') }
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
  return <ReferencesContext.Provider value={{ workspaceKey, open, setOpen, question, setQuestion, references, pending,
    select, clearSelection, ask, remove, locate, register, submit, busy, notice, sendAvailable: true,
    draftReady: true, draftError: '', draftConflictReady: true }}>{children}</ReferencesContext.Provider>
}

export function WorkspaceReferenceList() {
  const { references, remove, locate, readOnly } = useWorkspaceReferences()
  return <section className="wr-references" aria-label="上下文引用">
    {references.length === 0 ? <p className="wr-hint">选择材料或代码，可将片段加入问题。</p> :
      <ol>{references.map((ref, index) => <li key={ref.id}>
        <div className="wr-reference-heading"><button type="button" onClick={() => locate(ref)}
          aria-label={`定位引用 ${index + 1}：${ref.sourceName}`}>{ref.sourceName}</button>
          <button type="button" aria-label={`移除引用 ${index + 1}`} disabled={readOnly} onClick={() => remove(ref.id)}>移除</button></div>
        <pre data-kind={ref.kind}>{ref.text}</pre>
      </li>)}</ol>}
  </section>
}

function WorkspaceDraftSkills({ inputRef }: { inputRef: RefObject<HTMLTextAreaElement | null> }) {
  const { skills, draftReady, readOnly, viewActive = true } = useWorkspaceReferences()
  const pointerInput = useRef<{ input: HTMLTextAreaElement; start: number; end: number; direction: 'forward' | 'backward' | 'none' } | null>(null)
  if (!skills) return null
  const known = new Set(skills.options.map(item => `${item.skillId}:${item.version}`))
  const unknown = skills.selected.filter(item => !known.has(`${item.skillId}:${item.version}`))
  const selectedCount = skills.selected.length + skills.options.filter(option => option.fixed
    && !skills.selected.some(item => item.skillId === option.skillId && item.version === option.version)).length
  return <details className="wr-skills" onPointerDownCapture={event => {
    pointerInput.current = null
    const input = inputRef.current
    if (!viewActive || event.button !== 0 || !input || document.activeElement !== input
      || !(event.target as Element).closest('summary,button,input,label')) return
    pointerInput.current = { input, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection }
    // Pointer activation edits this question's options without moving its insertion point.
    // Keyboard activation has no pointer capture and retains normal control focus.
    event.preventDefault()
  }} onPointerCancel={() => { pointerInput.current = null }} onKeyDownCapture={() => { pointerInput.current = null }}
    onClick={event => {
      const saved = pointerInput.current
      if (!saved) return
      if (!viewActive || !saved.input.isConnected) { pointerInput.current = null; return }
      saved.input.focus({ preventScroll: true })
      saved.input.setSelectionRange(saved.start, saved.end, saved.direction)
      // A label forwards its activation to the input after its own click bubbles.
      // Keep the pointer snapshot until that control click has also completed.
      if ((event.target as Element).closest('input,button,summary')) pointerInput.current = null
    }}>
    <summary>本次问题的 Skills{skills.explicit === false ? ' · 按范围设置'
      : selectedCount ? ` · 已选 ${selectedCount}` : ' · 未选择'}</summary>
    {skills.loading && <p className="wr-hint" role="status">正在读取 Skills…</p>}
    {skills.error && <p className="wr-notice" role="alert">{skills.error}</p>}
    {!skills.loading && !skills.options.length && !unknown.length && <p className="wr-hint">尚无可选 Skill，可在个人设置中导入并配置范围。</p>}
    {skills.options.map(option => {
      const checked = option.fixed || skills.selected.some(item => item.skillId === option.skillId && item.version === option.version)
      return <label className="wr-skill-option" key={`${option.skillId}:${option.version}`}>
        <input type="checkbox" checked={checked} disabled={readOnly || !draftReady || skills.loading || !!skills.error || option.fixed || !!option.unavailable && !checked}
          onChange={event => skills.choose(event.target.checked
            ? [...skills.selected.filter(item => item.skillId !== option.skillId), { skillId: option.skillId, version: option.version }]
            : skills.selected.filter(item => item.skillId !== option.skillId))} />
        <span><strong>{option.name} · v{option.version}</strong><small>{option.description}</small>
          {option.fixed && <small>课程固定选用</small>}
          {option.unavailable && <small>{option.unavailable}</small>}</span>
      </label>
    })}
    {unknown.map(option => <label className="wr-skill-option" key={`${option.skillId}:${option.version}`}>
      <input type="checkbox" checked disabled={readOnly || !draftReady || skills.loading || !!skills.error} onChange={() => skills.choose(skills.selected.filter(item => item.skillId !== option.skillId))} />
      <span>已选 Skill · v{option.version}<small>原版本暂时无法读取；选择仍保留。</small></span>
    </label>)}
    <button type="button" disabled={skills.loading} onClick={skills.reload}>重新读取 Skills</button>
    {skills.explicit && <button type="button" disabled={readOnly || !draftReady || skills.loading || !!skills.error} onClick={() => skills.choose()}>使用范围设置</button>}
  </details>
}
/** Optional composer; callers can also compose the controller and reference list with their own input. */
export function WorkspaceReferenceComposer({ closeFocusRef, sendBlocked = false, blockedHint, blockedLabel, submitLabel }: {
  closeFocusRef?: RefObject<HTMLElement | null>; sendBlocked?: boolean
  blockedHint?: string; blockedLabel?: string; submitLabel?: string
} = {}) {
  const { open, setOpen, question, setQuestion, submit, busy, notice, sendAvailable, draftReady, draftError,
    draftConflict, draftConflictReady, resolveDraftConflict, readOnly, skills, workspaceKey, viewActive = true } = useWorkspaceReferences()
  const canSend = sendAvailable && !sendBlocked
  const input = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const questionId = useId()
  useLayoutEffect(() => {
    if (!open || !viewActive || !input.current || !draftReady) return
    const element = input.current, saved = composerView(workspaceKey)
    if (saved.start !== undefined) element.setSelectionRange(saved.start, saved.end ?? saved.start, saved.direction)
    // Restore once at the visible-view boundary, never after a catalog/draft response.
    const active = document.activeElement
    if ((saved.focused || saved.start === undefined) && (!active || active === document.body || active === document.documentElement || active === element
      || active.closest('[inert]') || active.classList.contains('main')))
      element.focus({ preventScroll: true })
  }, [open, viewActive, workspaceKey])
  useLayoutEffect(() => {
    if (!open || !viewActive || !input.current || !draftReady) return
    const saved = composerView(workspaceKey)
    // A delayed IndexedDB read may restore a range, but cannot initiate focus.
    if (saved.start !== undefined) input.current.setSelectionRange(saved.start, saved.end ?? saved.start, saved.direction)
  }, [draftReady, open, viewActive, workspaceKey])
  useLayoutEffect(() => {
    const element = input.current
    return () => {
      if (element && draftReady) rememberComposerCaret(workspaceKey, element)
      endComposerComposition(workspaceKey)
    }
  }, [open, workspaceKey, draftReady])
  if (!open) return <button className="wr-button" type="button" onClick={() => setOpen(true)}>打开对话</button>
  return <section className="wr-composer" aria-label="Agent 问题草稿" data-reference-ui onFocusCapture={event => {
    if (event.target !== input.current) rememberComposerView(workspaceKey, { focused: false })
  }}>
    <header><h2>询问 Agent</h2><button type="button" onClick={() => { setOpen(false); closeFocusRef?.current?.focus() }}>收起对话</button></header>
    {draftConflict && <div className="wr-conflict" role="alert">
      <h3>问题草稿存在分歧</h3>
      <p>本页与另一版本均保留，请比较后明确选择。</p>
      <div className="wr-conflict-columns">
        <div><h4>本页草稿</h4><p className="wr-conflict-question">{draftConflict.local.question || '（问题尚未填写）'}</p>
          {!!draftConflict.local.skills?.length && <p>Skills：{draftConflict.local.skills.map(skill => `${skills?.options.find(option => option.skillId === skill.skillId)?.name ?? '原 Skill'} · v${skill.version}`).join('、')}</p>}
          <ul>{draftConflict.local.references.map(reference => <li key={reference.id}>
            <strong>{reference.sourceName}</strong><pre>{reference.text}</pre></li>)}</ul></div>
        <div><h4>另一版本</h4><p className="wr-conflict-question">{draftConflict.other.question || '（问题尚未填写）'}</p>
          {!!draftConflict.other.skills?.length && <p>Skills：{draftConflict.other.skills.map(skill => `${skills?.options.find(option => option.skillId === skill.skillId)?.name ?? '原 Skill'} · v${skill.version}`).join('、')}</p>}
          <ul>{draftConflict.other.references.map(reference => <li key={reference.id}>
            <strong>{reference.sourceName}</strong><pre>{reference.text}</pre></li>)}</ul></div>
      </div>
      <div className="wr-send">
        <button type="button" disabled={!draftConflictReady} onClick={() => void resolveDraftConflict?.('local')}>采用本页草稿</button>
        <button type="button" disabled={!draftConflictReady} onClick={() => void resolveDraftConflict?.('other')}>采用另一版本</button>
      </div>
    </div>}
    {draftError && <p role="alert" className="wr-notice">{draftError}</p>}
    <WorkspaceReferenceList />
    <WorkspaceDraftSkills inputRef={input} />
    <form onSubmit={event => { event.preventDefault(); if (canSend) void submit() }}>
      <label htmlFor={questionId}>你的问题</label>
      <textarea ref={input} id={questionId} value={question} disabled={!draftReady} readOnly={readOnly} maxLength={QUESTION_TEXT_MAX_LENGTH}
        onChange={event => { setQuestion(event.target.value); rememberComposerCaret(workspaceKey, event.currentTarget) }} placeholder="写下想讨论的问题…"
        onFocus={event => rememberComposerCaret(workspaceKey, event.currentTarget, true)}
        onBlur={event => rememberComposerCaret(workspaceKey, event.currentTarget)}
        onSelect={event => { if (draftReady) rememberComposerCaret(workspaceKey, event.currentTarget) }}
        onCompositionStart={() => { composing.current = true; beginComposerComposition(workspaceKey) }} onCompositionEnd={event => {
          if (event.currentTarget.value !== question) setQuestion(event.currentTarget.value)
          rememberComposerCaret(workspaceKey, event.currentTarget)
          composing.current = false; endComposerComposition(workspaceKey)
        }}
        onKeyDown={event => {
          if (canSend && event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault(); void submit()
          }
        }} />
      <div className="wr-send"><span className="wr-hint">{sendBlocked ? blockedHint ?? '当前回答结束后再发送；问题会先保存在草稿中。'
        : sendAvailable ? 'Enter 发送 · Shift + Enter 换行'
          : readOnly ? '还原校验环境中的问题与引用只读，接管后可继续编辑。'
            : '真实 Agent 尚未接入；问题与引用会自动保存在原工作区，暂不能发送。'}</span>
        <button className="wr-primary" type="submit" disabled={!canSend || busy || !question.trim()}>
          {sendBlocked ? blockedLabel ?? '等待当前回答' : sendAvailable ? busy ? '发送中…' : submitLabel ?? '发送问题' : '发送问题（尚未接入）'}</button></div>
    </form>
    <p role="status" className="wr-notice">{notice}</p>
  </section>
}
