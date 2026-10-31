import { questionDraftViewSchema } from '@xunjie/contracts/question-drafts'
import type { QuestionDraftSync, QuestionDraftView, QuestionReferenceInput, QuestionWorkBasis } from '@xunjie/contracts/question-drafts'
import { DraftStore, DraftLocalCompetition, initialDraftRecord, sameDraftContent } from './draft-store'
import type { DraftConflict, DraftContent, DraftRecord, DraftSync } from './draft-store'

export const LOCAL_DRAFT_MAX_WAIT_MS = 250
export const NETWORK_DRAFT_MAX_WAIT_MS = 1000
export interface QuestionDraftTransport {
  read(): Promise<QuestionDraftView>
  receipt(requestId: string): Promise<QuestionDraftView | null>
  sync(input: QuestionDraftSync): Promise<QuestionDraftView>
}
export interface QuestionDraftState { ready: boolean; error: string; question: string
  references: QuestionReferenceInput[]; revision: number; revisionId: string | null
  conflict?: DraftConflict; conflictReady: boolean }

const inputReference = (reference: QuestionReferenceInput): QuestionReferenceInput => ({
  referenceId: reference.referenceId, source: reference.source,
  range: { kind: reference.range.kind, start: reference.range.start, end: reference.range.end },
  copy: reference.copy, sourceName: reference.sourceName,
})
const inputReferences = (references: QuestionReferenceInput[]) => references.map(inputReference)
const contentOf = (value: DraftContent): DraftContent => ({ question: value.question,
  references: structuredClone(inputReferences(value.references)) })
function pendingFor(value: DraftContent, revision: number, bases: QuestionWorkBasis[], draftId: string): DraftSync {
  return { requestId: crypto.randomUUID(), draftId, baseRevision: revision,
    question: value.question, references: structuredClone(inputReferences(value.references)), bases: structuredClone(bases) }
}

function mergeBases(existing: QuestionWorkBasis[], added: QuestionWorkBasis[], references: QuestionReferenceInput[]) {
  const merged = new Map<string, QuestionWorkBasis>()
  for (const basis of [...existing, ...added]) merged.set(basis.contentId, basis)
  const workContent = new Set(references.flatMap(reference =>
    reference.source.kind === 'work' ? [reference.source.contentId] : []))
  return [...merged.values()].filter(basis => workContent.has(basis.contentId))
}
function matchesPending(view: QuestionDraftView, pending: NonNullable<DraftRecord['pending']>) {
  return view.revision === pending.baseRevision + 1 && view.question === pending.question
    && JSON.stringify(inputReferences(view.references)) === JSON.stringify(inputReferences(pending.references))
}

/** The page's only question-draft authority; it never calls a model or business receiver. */
export class ReliableQuestionDraft {
  private record: DraftRecord
  private dirty = false
  private editEpoch = 0
  private protecting?: Promise<void>
  private initializing?: Promise<void>
  private sending = false
  private stopped = false
  private disposed = false
  private denied = false
  private localTimer?: ReturnType<typeof setInterval>
  private networkTimer?: ReturnType<typeof setInterval>
  private store = new DraftStore()
  private listeners = new Set<() => void>()
  state: QuestionDraftState = { ready: false, error: '', question: '', references: [],
    revision: 0, revisionId: null, conflictReady: true }
  constructor(readonly key: string, private transport: QuestionDraftTransport) {
    this.record = initialDraftRecord(key, '')
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.state
  private notify(patch: Partial<QuestionDraftState> = {}) {
    this.state = { ...this.state, ...patch, conflictReady: !this.dirty }
    for (const listener of this.listeners) listener()
  }
  private apply(record: DraftRecord, extra: Partial<QuestionDraftState> = {}) {
    this.notify({ question: record.question, references: structuredClone(record.references),
      revision: record.remoteRevision, revisionId: record.revisionId,
      conflict: record.conflict, ...extra })
  }
  async open() {
    if (this.disposed || this.state.ready) return
    this.localTimer ??= setInterval(() => {
      if (this.state.ready) void this.protect().catch(() => {})
      else if (!this.denied) void this.initialize().catch(() => {})
    }, LOCAL_DRAFT_MAX_WAIT_MS)
    this.networkTimer ??= setInterval(() => { void this.synchronize() }, NETWORK_DRAFT_MAX_WAIT_MS)
    window.addEventListener('beforeunload', this.beforeUnload)
    await this.initialize()
    void this.synchronize()
  }
  private async initialize(): Promise<void> {
    if (this.initializing) return this.initializing
    this.initializing = this.load()
    try { await this.initializing } finally { this.initializing = undefined }
  }
  private async load() {
    try {
      let local = await this.store.read(this.key)
      if (!local) {
        if (this.stopped) throw new Error('原问题草稿未缓存在本机。')
        const remote = questionDraftViewSchema.parse(await this.transport.read())
        this.record = { ...initialDraftRecord(this.key, remote.draftId), remoteRevision: remote.revision,
          revisionId: remote.revisionId, question: remote.question, references: inputReferences(remote.references) }
        this.record = await this.store.change(this.key, existing => existing ?? this.record!)
        local = this.record
      }
      this.record = local
      this.pendingBases = local.bases
      const candidates = await this.store.candidates(this.key)
      let conflict = local.conflict
      if (!conflict && candidates[0]) conflict = { source: 'local', local: contentOf(candidates[0].content),
        other: contentOf(local), at: local.localRevision, remoteRevision: local.remoteRevision, candidateId: candidates[0].id }
      if (!this.disposed) {
        this.record = { ...local, conflict }
        this.notify({ ready: true, error: '', question: conflict?.local.question ?? local.question,
          references: structuredClone((conflict?.local ?? local).references),
          revision: local.remoteRevision, revisionId: local.revisionId, conflict })
      }
    } catch (error) {
      if ((error as { code?: unknown }).code === 'forbidden') this.denied = true
      if (!this.disposed) this.notify({ question: this.record.question, references: structuredClone(this.record.references),
        error: this.denied ? '原空间访问资格已失效，问题草稿仍保留在本机；请重新登录原空间。'
          : '暂时无法读取或保护问题草稿，内容不会被替换为空；系统会自动重试。' })
      throw error
    }
  }
  private beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.dirty) { event.preventDefault(); event.returnValue = '' }
  }
  change(question: string, references: QuestionReferenceInput[], addedBases: QuestionWorkBasis[] = []) {
    // Preserve a basis added after the last IndexedDB protection; typing must not drop it.
    const bases = mergeBases([...this.record.bases, ...this.pendingBases], addedBases, references)
    this.editEpoch++; this.dirty = true
    this.pendingBases = bases
    const content = { question, references: structuredClone(inputReferences(references)) }
    this.notify({ question, references: structuredClone(content.references),
      ...(this.state.conflict ? { conflict: { ...this.state.conflict, local: content } } : {}) })
  }
  private pendingBases: QuestionWorkBasis[] = []
  async protect(): Promise<void> {
    if (this.protecting) { await this.protecting; if (this.dirty && !this.state.conflict) return this.protect(); return }
    this.protecting = this.persist()
    try { await this.protecting } finally { this.protecting = undefined }
  }
  private async persist() {
    const epoch = this.editEpoch
    const content = contentOf(this.state)
    const bases = this.pendingBases.length ? this.pendingBases : mergeBases(this.record.bases, [], content.references)
    try {
      if (this.dirty) {
        const conflict = this.state.conflict
        if (conflict?.source === 'local' && conflict.candidateId) {
          await this.store.candidate(conflict.candidateId, this.key, content)
          if (epoch === this.editEpoch) this.dirty = false
          this.notify({ conflict: { ...conflict, local: content } })
          return
        }
        const saved = await this.store.change(this.key, current => {
          const previous = current ?? this.record
          const nextPending = previous.pending ?? { ...pendingFor(content, previous.remoteRevision, bases, previous.draftId) }
          return { ...previous, localRevision: previous.localRevision + 1, question: content.question,
            references: content.references, bases,
            pending: nextPending,
            ...(conflict ? { conflict: { ...conflict, local: content, at: previous.localRevision + 1 } } : {}) }
        }, { expected: this.record.localRevision, content })
        this.record = saved; this.pendingBases = saved.bases
        if (epoch === this.editEpoch) this.dirty = false
        if (this.state.conflict && saved.conflict) this.notify({ conflict: { ...saved.conflict, local: content } })
      } else {
        const current = await this.store.read(this.key)
        if (current && current.localRevision !== this.record.localRevision && epoch === this.editEpoch) {
          this.record = current
          this.apply(current)
        } else if (current && current.localRevision === this.record.localRevision) this.record = current
      }
      if (!this.denied) this.notify({ error: '' })
    } catch (error) {
      if (error instanceof DraftLocalCompetition) {
        this.record = error.current
        const local = contentOf(this.state)
        this.notify({ conflict: { source: 'local', local, other: contentOf(error.current),
          at: error.current.localRevision, remoteRevision: error.current.remoteRevision, candidateId: error.candidateId },
          error: error.message })
      } else this.notify({ error: '本机存储未能保护当前问题草稿。请保留此页面，可复制内容；系统会自动重试。' })
      throw error
    }
  }
  private async synchronize() {
    if (this.stopped || this.denied || this.sending || !this.state.ready || this.state.conflict) return
    this.sending = true
    let attempted: DraftSync | undefined
    try {
      await this.protect()
      const current = await this.store.read(this.key)
      const pending = current?.pending
      if (!current || !pending) {
        const remote = questionDraftViewSchema.parse(await this.transport.read())
        if (this.stopped || this.dirty || this.state.conflict) return
        if (remote.revision !== this.record.remoteRevision) {
          const next = await this.store.change(this.key, saved => {
            if (!saved || saved.pending || saved.localRevision !== current?.localRevision) return saved ?? this.record
            const references = inputReferences(remote.references)
            return { ...saved, remoteRevision: remote.revision, revisionId: remote.revisionId,
              question: remote.question, references, bases: mergeBases([], [], references),
              localRevision: saved.localRevision + 1 }
          })
          if (!this.dirty) { this.record = next; this.apply(next) }
        }
        return
      }
      if (this.stopped || this.denied) return
      const known = await this.transport.receipt(pending.requestId)
      if (this.stopped || this.denied) return
      attempted = pending
      const confirmed = questionDraftViewSchema.parse(known ?? await this.transport.sync(pending))
      if (confirmed.draftId !== pending.draftId || !matchesPending(confirmed, pending)) throw Object.assign(new Error('草稿回执与原请求不符。'), { code: 'corrupt' })
      await this.store.change(this.key, saved => {
        if (!saved || saved.pending?.requestId !== pending.requestId) return saved ?? current
        const same = sameDraftContent(saved, pending)
        return { ...saved, remoteRevision: confirmed.revision, revisionId: confirmed.revisionId,
          bases: mergeBases(saved.bases, [], saved.references),
          pending: same ? null : pendingFor(saved, confirmed.revision, mergeBases(saved.bases, [], saved.references), saved.draftId) }
      }).then(saved => {
        this.record = saved
        if (!this.dirty) this.notify({ revision: saved.remoteRevision, revisionId: saved.revisionId })
      })
    } catch (error) {
      const rawCode = (error as { code?: unknown }).code
      const code = typeof rawCode === 'string' ? rawCode : undefined
      if (code === 'conflict') {
        try {
          const other = questionDraftViewSchema.parse(await this.transport.read())
          // A storage-level conflict can be reported when the owner has not actually
          // advanced past the request base. Keep the same pending identity and retry.
          if (attempted && other.revision === attempted.baseRevision && other.revision === this.record.remoteRevision) {
            this.notify({ error: '' })
            return
          }
          await this.protect()
          this.dirty = true
          const local = contentOf(this.state)
          this.notify({ conflict: { source: 'remote', local, other: { question: other.question,
            references: inputReferences(other.references) }, at: this.record.localRevision,
            remoteRevision: other.revision }, error: '另一客户端修改了问题草稿，请比较并选择。' })
          await this.protect()
        } catch { /* keep the original pending request until the service is available */ }
      } else if (code === 'forbidden' || code === 'stale-generation') {
        this.denied = true
        this.notify({ error: '访问资格已失效，已停止该身份的草稿同步。本机草稿仍保留，请重新登录原空间。' })
      } else if (code === 'corrupt' || (code && !['unavailable', 'maintenance', 'commit-unknown', 'upload-unknown'].includes(code))) {
        this.denied = true
        this.notify({ error: '问题草稿同步无法继续：' + (code ?? 'unknown') + '。内容仍保留，可复制或导出。' })
      }
    } finally { this.sending = false }
  }
  async resolve(question: string, references: QuestionReferenceInput[], addedBases: QuestionWorkBasis[] = []) {
    await this.protect()
    const conflict = this.state.conflict
    if (!conflict) return
    if (this.dirty) throw new Error('当前比较内容仍在保护中。')
    const content = contentOf({ question, references })
    const bases = mergeBases(this.record.bases, addedBases, content.references)
    const saved = await this.store.change(this.key, current => {
      if (!current) throw new Error('本机草稿记录不可读。')
      const revision = conflict.source === 'remote' ? conflict.remoteRevision : current.remoteRevision
      return { ...current, localRevision: current.localRevision + 1, remoteRevision: revision,
        question: content.question, references: content.references, bases,
        conflict: undefined, pending: pendingFor(content, revision, bases, current.draftId) }
    }, { expected: conflict.at, content }, conflict.candidateId)
    this.record = saved; this.dirty = false; this.pendingBases = saved.bases
    this.notify({ question: saved.question, references: structuredClone(saved.references), conflict: undefined,
      revision: saved.remoteRevision, revisionId: saved.revisionId, error: '' })
    void this.synchronize()
  }
  async leave(): Promise<void> { await this.protect(); if (this.dirty) return this.leave() }
  suspend() { this.stopped = true; if (this.networkTimer) clearInterval(this.networkTimer) }
  /** Re-authentication for the same workspace resumes the same record and pending identity. */
  resume() {
    if (this.disposed || !this.stopped) return
    this.stopped = false
    this.networkTimer ??= setInterval(() => { void this.synchronize() }, NETWORK_DRAFT_MAX_WAIT_MS)
    void this.synchronize()
  }
  dispose() {
    this.disposed = true
    this.suspend(); if (this.localTimer) clearInterval(this.localTimer)
    window.removeEventListener('beforeunload', this.beforeUnload)
    this.listeners.clear()
  }
}
