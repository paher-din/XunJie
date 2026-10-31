import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { questionReferenceKey, questionReferenceSourceId } from '@xunjie/contracts/question-drafts'
import type { QuestionReferenceInput } from '@xunjie/contracts/question-drafts'
import type { ReliableQuestionDraft } from '../../../reliable-workspace/draft'
import { snapshotReference, type ReferenceSelection, type ReferenceSource, type WorkspaceReference } from './model'
import { ReferencesContext, type ReferencesController } from './WorkspaceReferences'

const sourceIdOf = (reference: QuestionReferenceInput) => reference.source.kind === 'work'
  ? reference.source.objectId : questionReferenceSourceId(reference.source)
function displayReferences(references: readonly QuestionReferenceInput[], workspaceKey: string): WorkspaceReference[] {
  return references.map(reference => Object.freeze({ id: reference.referenceId, workspaceKey,
    sourceId: sourceIdOf(reference), sourceName: reference.sourceName, kind: reference.range.kind,
    text: reference.copy, source: reference.source,
    range: Object.freeze({ start: reference.range.start, end: reference.range.end }) }))
}
export interface DraftReferencesProviderProps { workspaceKey: string; draft: ReliableQuestionDraft; children: ReactNode }
/** Production host: the reliable draft is the only mutable authority; the send path stays unavailable. */
export function DraftReferencesProvider(props: DraftReferencesProviderProps) {
  return <DraftReferencesSession key={props.workspaceKey} {...props} />
}
function DraftReferencesSession({ workspaceKey, draft, children }: DraftReferencesProviderProps) {
  const state = useSyncExternalStore(draft.subscribe, draft.snapshot)
  const [open, setOpenState] = useState(false)
  const [pending, setPending] = useState<ReferenceSelection | null>(null)
  const [notice, setNotice] = useState('')
  const sources = useRef(new Map<string, ReferenceSource>())
  const gestures = useRef(new WeakSet<object>())
  const refs = useMemo(() => displayReferences(state.references, workspaceKey), [state.references, workspaceKey])
  const view = useRef({ open, pending }); view.current = { open, pending }
  const inputs = () => draft.snapshot().references.map(reference => ({ ...reference,
    range: { ...reference.range } }))
  const add = useCallback((selection: ReferenceSelection) => {
    if (!draft.snapshot().ready) { setNotice('正在读取原问题草稿，请稍后重试。'); return false }
    const snapshot = snapshotReference(selection.snapshot)
    if (!snapshot || snapshot.workspaceKey !== workspaceKey || !sources.current.has(snapshot.sourceId)) return false
    if (!snapshot.source) { setNotice('来源未登记，不能加入引用。'); return false }
    const candidate: QuestionReferenceInput = { referenceId: crypto.randomUUID(), source: snapshot.source,
      range: { kind: snapshot.kind, start: snapshot.range.start, end: snapshot.range.end },
      copy: snapshot.text, sourceName: snapshot.sourceName }
    const current = inputs()
    if (current.some(reference => questionReferenceKey(reference) === questionReferenceKey(candidate))) return true
    draft.change(draft.snapshot().question, [...current, candidate], snapshot.basis ? [snapshot.basis] : [])
    return true
  }, [draft, workspaceKey])
  const select = useCallback((selection: ReferenceSelection | null, gesture?: object) => {
    if (selection && (selection.snapshot.workspaceKey !== workspaceKey || !sources.current.has(selection.snapshot.sourceId))) return
    if (selection) {
      const snapshot = snapshotReference(selection.snapshot)
      selection = snapshot ? { snapshot, anchor: selection.anchor } : null
    }
    view.current.pending = selection
    setPending(selection)
    if (gesture && !gestures.current.has(gesture)) {
      gestures.current.add(gesture)
      if (selection && view.current.open) add(selection)
    }
  }, [workspaceKey, add])
  const clearSelection = useCallback((sourceId: string) => {
    if (view.current.pending?.snapshot.sourceId === sourceId) {
      view.current.pending = null
      setPending(null)
    }
  }, [])
  const register = useCallback((source: ReferenceSource) => {
    if (sources.current.has(source.sourceId)) throw new Error(`Duplicate reference source: ${source.sourceId}`)
    sources.current.set(source.sourceId, source)
    return () => {
      if (sources.current.get(source.sourceId) === source) {
        sources.current.delete(source.sourceId)
        clearSelection(source.sourceId)
      }
    }
  }, [clearSelection])
  const setOpen = (value: boolean) => {
    view.current.open = value
    setOpenState(value)
    view.current.pending = null
    setPending(null)
  }
  const ask = () => {
    const selected = view.current.pending
    if (!selected) return
    if (!sources.current.get(selected.snapshot.sourceId)) { setNotice('来源当前不可用，请重新选择。'); return }
    if (!add(selected)) return
    setOpen(true)
    setNotice('')
  }
  const remove = (id: string) => {
    draft.change(draft.snapshot().question, inputs().filter(reference => reference.referenceId !== id))
  }
  const setQuestion = (text: string) => { draft.change(text, inputs()) }
  const locate = (reference: WorkspaceReference) => {
    if (reference.workspaceKey !== workspaceKey || !reference.source) { setNotice('引用属于其他工作区，当前无法定位。'); return }
    try {
      const result = sources.current.get(reference.sourceId)?.locate(reference)
      setNotice(result?.ok ? '已定位引用来源。' : result?.reason ?? '来源当前不可用；引用副本仍然保留。')
    } catch { setNotice('来源当前不可用；引用副本仍然保留。') }
  }
  const submit = async () => {
    setNotice('真实 Agent 尚未接入，暂不能发送；问题与引用会自动保存在原工作区。')
  }
  const resolveConflict = async (side: 'local' | 'other') => {
    const conflict = draft.snapshot().conflict
    if (!conflict) return
    const chosen = side === 'local' ? conflict.local : conflict.other
    try {
      await draft.resolve(chosen.question, chosen.references.map(reference => ({ ...reference, range: { ...reference.range } })))
      setNotice(side === 'local' ? '已采用本页草稿，正在自动保存。' : '已采用另一版本，正在自动保存。')
    } catch { setNotice('草稿分歧尚未完成选择，请稍后重试。') }
  }
  const conflict = state.conflict ? {
    local: { question: state.conflict.local.question, references: displayReferences(state.conflict.local.references, workspaceKey) },
    other: { question: state.conflict.other.question, references: displayReferences(state.conflict.other.references, workspaceKey) },
  } : undefined
  const value: ReferencesController = { workspaceKey, open, setOpen, question: state.question, setQuestion, references: refs,
    pending, select, clearSelection, ask, remove, locate, register, submit, busy: false,
    notice, sendAvailable: false, draftReady: state.ready,
    draftError: state.error, ...(conflict ? { draftConflict: conflict } : {}), draftConflictReady: state.conflictReady,
    resolveDraftConflict: resolveConflict }
  return <ReferencesContext.Provider value={value}>{children}</ReferencesContext.Provider>
}
