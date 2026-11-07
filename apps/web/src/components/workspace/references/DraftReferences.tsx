import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { questionReferenceKey, questionReferenceSourceId } from '@xunjie/contracts/question-drafts'
import type { QuestionReferenceInput } from '@xunjie/contracts/question-drafts'
import type { ReliableQuestionDraft } from '../../../reliable-workspace/draft'
import type { ReliableActions } from '../../../reliable-workspace/actions'
import { isExecutionAction } from '@xunjie/contracts/execution'
import type { ActionInput } from '@xunjie/contracts/action-intents'
import { snapshotReference, type ReferenceSelection, type ReferenceSource, type WorkspaceReference } from './model'
import { ReferencesContext, type ReferencesController } from './WorkspaceReferences'

const sourceIdOf = (reference: QuestionReferenceInput) => reference.source.kind === 'work'
  ? reference.source.objectId : questionReferenceSourceId(reference.source)
function displayReferences(references: readonly QuestionReferenceInput[], workspaceKey: string): WorkspaceReference[] {
  return references.map(reference => Object.freeze({ id: reference.referenceId, workspaceKey,
    sourceId: sourceIdOf(reference), sourceName: reference.sourceName, kind: reference.range.kind,
    text: reference.copy, source: reference.source,
    range: Object.freeze({ ...reference.range }) }))
}
export interface DraftReferencesProviderProps { workspaceKey: string; draft: ReliableQuestionDraft; actions: ReliableActions; children: ReactNode
  delivery?: ActionInput['delivery']; deliveryReady?: boolean; onCreated?: () => void }
/** Production host consumes the common workspace; availability comes only from registered receivers. */
export function DraftReferencesProvider(props: DraftReferencesProviderProps) {
  return <DraftReferencesSession key={props.workspaceKey} {...props} />
}
function DraftReferencesSession({ workspaceKey, draft, actions, children, delivery, deliveryReady = true, onCreated }: DraftReferencesProviderProps) {
  const state = useSyncExternalStore(draft.subscribe, draft.snapshot)
  const actionState = useSyncExternalStore(actions.subscribe, actions.snapshot)
  const receiver = actionState.receivers.find(item => item.kind === 'question')
  const [busy, setBusy] = useState(false)
  const creating = useRef(false)
  const actionIds = useRef(new Map<string, string>())
  const [open, setOpenState] = useState(false)
  const [pending, setPending] = useState<ReferenceSelection | null>(null)
  const [notice, setNotice] = useState('')
  const sources = useRef(new Map<string, ReferenceSource>())
  const locateSequence = useRef(0)
  const gestures = useRef(new WeakSet<object>())
  const refs = useMemo(() => displayReferences(state.references, workspaceKey), [state.references, workspaceKey])
  const view = useRef({ open, pending }); view.current = { open, pending }
  const inputs = () => draft.snapshot().references.map(reference => ({ ...reference,
    range: { ...reference.range } }))
  const add = useCallback((selection: ReferenceSelection) => {
    if (draft.isReadOnly()) return false
    if (!draft.snapshot().ready) { setNotice('正在读取原问题草稿，请稍后重试。'); return false }
    const snapshot = snapshotReference(selection.snapshot)
    if (!snapshot || snapshot.workspaceKey !== workspaceKey || !sources.current.has(snapshot.sourceId)) return false
    if (!snapshot.source) { setNotice('来源未登记，不能加入引用。'); return false }
    const candidate: QuestionReferenceInput = { referenceId: crypto.randomUUID(), source: snapshot.source,
      range: { ...snapshot.range, kind: snapshot.kind } as QuestionReferenceInput['range'],
      copy: snapshot.text, sourceName: snapshot.sourceName }
    const current = inputs()
    if (current.some(reference => questionReferenceKey(reference) === questionReferenceKey(candidate))) return true
    draft.change(draft.snapshot().question, [...current, candidate], snapshot.basis ? [snapshot.basis] : [])
    return true
  }, [draft, workspaceKey])
  const select = useCallback((selection: ReferenceSelection | null, gesture?: object) => {
    if (draft.isReadOnly()) return
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
  const locate = async (reference: WorkspaceReference) => {
    const sequence = ++locateSequence.current
    if (reference.workspaceKey !== workspaceKey || !reference.source) { setNotice('引用属于其他工作区，当前无法定位。'); return }
    try {
      const result = await sources.current.get(reference.sourceId)?.locate(reference)
      if (sequence !== locateSequence.current) return
      setNotice(result?.ok ? '已定位引用来源。' : result?.reason ?? '来源当前不可用；引用副本仍然保留。')
    } catch { if (sequence === locateSequence.current) setNotice('来源当前不可用；引用副本仍然保留。') }
  }
  const submit = async () => {
    if (!receiver || !actionState.ready) { setNotice('真实 Agent 尚未接入，暂不能发送；问题与引用会自动保存在原工作区。'); return }
    if (!deliveryReady) { setNotice('正在核对本次发送方式，原问题与引用仍保留。'); return }
    if (creating.current || !draft.snapshot().question.trim()) return
    creating.current = true; setBusy(true)
    try {
      const token = draft.capture().token + ':' + JSON.stringify(receiver)
      const items = actions.snapshot().items
      // Only question actions are ever resumed from a draft token; an execution record has no draft.
      const pending = items.find(item => !isExecutionAction(item.input)
        && item.input.draft.token + ':' + JSON.stringify(item.input.receiver) === token
        && !['accepted', 'cancelled', 'failed'].includes(item.phase))
      if (pending) { setNotice('仍在沿原请求核实这次问题，请查看待发与接收记录。'); return }
      const remembered = actionIds.current.get(token)
      const previous = items.find(item => item.input.requestId === remembered)
      const requestId = remembered && !previous ? remembered : crypto.randomUUID()
      actionIds.current.set(token, requestId)
      await actions.create({ requestId, receiver, ...(delivery && receiver.receiverId.startsWith('teaching-agent:') ? { delivery } : {}) })
      onCreated?.()
      setNotice('已保留这次问题，可继续编辑；接收情况见下方记录。')
    } catch { setNotice('这次问题尚未可靠保留，未继续派发。请保留此页，原文仍可复制。') }
    finally { creating.current = false; setBusy(false) }
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
    pending, select, clearSelection, ask, remove, locate, register, submit, busy,
    notice, sendAvailable: !!receiver && actionState.ready && actionState.active, draftReady: state.ready, readOnly: draft.isReadOnly(),
    draftError: state.error, ...(conflict ? { draftConflict: conflict } : {}), draftConflictReady: state.conflictReady,
    resolveDraftConflict: resolveConflict }
  return <ReferencesContext.Provider value={value}>{children}</ReferencesContext.Provider>
}
