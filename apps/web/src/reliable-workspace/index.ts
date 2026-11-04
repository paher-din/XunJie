import { ReliableStateCoordinator } from './coordinator'
import { workFilesSchema, workViewSchema } from '@xunjie/contracts/learning-data'
import type { WorkFile, WorkView, WorkSync } from '@xunjie/contracts/learning-data'
import { WorkStore, LocalCompetition, sameFiles, pendingFor, initialRecord } from './store'
import type { WorkRecord, WorkConflict, WorkOperation, WorkOperationReceipt } from './store'
import { ReliableActions } from './actions'
import type { ActionTransport } from './actions'
import type { ReliableQuestionDraft } from './draft'
import { componentStateMediaType, componentStateName, matchesComponentState, type ComponentBinding } from '@xunjie/contracts/components'

export { LOCAL_MAX_WAIT_MS, NETWORK_MAX_WAIT_MS } from './coordinator'
export interface WorkTransport { read(): Promise<WorkView>; receipt(requestId: string): Promise<WorkView | null>; sync(input: WorkSync): Promise<WorkView> }
export interface WorkspaceState { files: WorkFile[]; ready: boolean; error: string; conflict?: WorkConflict; conflictReady: boolean; editorEpoch: number }

/** The page/editor's only change and recovery interface. No legacy database or execution ledger access. */
export class ReliableWorkspace extends ReliableStateCoordinator {
  private record: WorkRecord
  private editEpoch = 0
  private sending = false
  private store = new WorkStore()
  private operations = new Map<string, WorkOperation>()
  private inputs = new Set<Promise<unknown>>()
  private listeners = new Set<() => void>()
  state: WorkspaceState = { files: [], ready: false, error: '', conflictReady: false, editorEpoch: 0 }
  constructor(readonly key: string, private transport: WorkTransport,
    private components?: { activityId: string; bindings: ComponentBinding[] }) { super(); this.record = initialRecord(key, { revision: 0, files: [] }) }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.state
  trackInput<T>(input: Promise<T>): Promise<T> {
    this.inputs.add(input)
    const settled = () => { this.inputs.delete(input) }
    void input.then(settled, settled)
    return input
  }
  protected unprotectedInput() { return super.unprotectedInput() || this.inputs.size > 0 }
  async leave(): Promise<void> {
    while (this.inputs.size) await Promise.all([...this.inputs])
    await super.leave()
  }
  /** An execution start sends the protected component state as its basis, so the owner must know it. */
  async flush(): Promise<void> {
    await this.leave()
    const deadline = Date.now() + 5_000
    while (this.state.ready && !this.stopped && !this.denied && !this.state.conflict && Date.now() < deadline) {
      const current = await this.store.read(this.key)
      if (!current?.pending || current.pendingRejected) return
      await this.synchronize()
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  /** Local confirmations belong to this workspace, atomically committed with the protected files. */
  async applyOperation(operation: WorkOperation, apply: () => void, retainUnknown: () => void): Promise<WorkOperationReceipt> {
    if (!navigator.locks) { retainUnknown(); throw new Error('capability-unavailable') }
    return navigator.locks.request(`xunjie-work-operation:${this.key}:${operation.scope}:${operation.operationId}`, async () => {
      let previous: WorkOperationReceipt | undefined
      try { previous = await this.store.operation(this.key, operation.scope, operation.operationId) }
      catch { retainUnknown(); throw new Error('outcome-unknown') }
      if (previous) {
        if (previous.inputDigest !== operation.inputDigest) throw new Error('conflict')
        return previous
      }
      const key = operation.scope + ':' + operation.operationId
      const pending = this.operations.get(key)
      if (pending) {
        if (pending.inputDigest !== operation.inputDigest) throw new Error('conflict')
        await super.leave()
        const receipt = await this.store.operation(this.key, operation.scope, operation.operationId)
        if (!receipt) throw new Error('outcome-unknown')
        return receipt
      }
      try { apply() } catch (error) {
        if (this.state.conflict) await this.protect()
        throw error
      }
      this.operations.set(key, operation)
      let protectedInput = false
      try {
        await super.leave()
        protectedInput = true
        if (this.state.conflict) throw new Error('conflict')
        const receipt = await this.store.operation(this.key, operation.scope, operation.operationId)
        if (!receipt) throw new Error('outcome-unknown')
        return receipt
      } catch (error) {
        // An unconfirmed operation stays paired with the dirty input for automatic protection/re-query.
        if (this.state.conflict) this.operations.delete(key)
        if (protectedInput && !this.state.conflict) throw new Error('outcome-unknown')
        throw error
      }
    })
  }
  actions(draft: ReliableQuestionDraft, transport: ActionTransport) {
    return new ReliableActions(this.key, draft, () => {
      if (!this.state.ready || this.state.conflict) throw new Error('请先读取作品并处理分歧。')
      return structuredClone(this.state.files)
    }, transport, { denied: () => this.accessDenied() || draft.accessDenied(),
      confirmed: () => { this.confirmAccess(); draft.confirmAccess() } })
  }
  private notify(patch: Partial<WorkspaceState> = {}) { this.state = { ...this.state, ...patch, conflictReady: !this.dirty }; for (const listener of this.listeners) listener() }
  protected ready() { return this.state.ready }
  protected conflicted() { return !!this.state.conflict }
  protected clearListeners() { this.listeners.clear() }
  protected async load() {
    try {
      const local = await this.store.read(this.key)
      if (local) this.record = local
      else {
        if (this.stopped) throw new Error('原作品内容未缓存在本机。')
        const remote = workViewSchema.parse(await this.transport.read())
        this.record = initialRecord(this.key, remote)
        this.record = await this.store.change(this.key, existing => existing ?? this.record)
      }
      const candidates = await this.store.candidates(this.key)
      let conflict = this.record.conflict
      if (!conflict && candidates[0]) conflict = { source: 'local', local: candidates[0].files, other: this.record.files,
        at: this.record.localRevision, remoteRevision: this.record.remoteRevision, candidateId: candidates[0].id }
      let files = conflict?.local ?? this.record.files
      // Repair only a legacy display path whose complete immutable binding still matches.
      // The original pending identity stays intact until the owner explicitly refuses it.
      if (this.components && !conflict) files = files.map(file => {
        if (file.mediaType !== componentStateMediaType) return file
        const binding = this.components!.bindings.find(binding => matchesComponentState(binding, this.components!.activityId,
          { ...file, name: componentStateName(binding.key) }))
        const name = binding && componentStateName(binding.key)
        return name && file.name !== name && !files.some(other => other.objectId !== file.objectId && other.name === name) ? { ...file, name } : file
      })
      if (!sameFiles(files, conflict?.local ?? this.record.files)) { this.editEpoch++; this.dirty = true }
      if (!this.disposed) this.notify({ files, ready: true, conflict, error: this.record.pendingRejected ? '原作品请求未通过校验，请修正内容；原文仍保留。' : '' })
    } catch (error) {
      if ((error as { code?: unknown }).code === 'forbidden') this.denied = true
      if (!this.disposed) this.notify({ files: this.record.files, error: this.denied ? '原空间访问资格已失效，请重新登录原空间。'
        : '暂时无法读取或保护原工作区，内容不会被替换为空；系统会自动重试。' })
      throw error
    }
  }
  change(files: WorkFile[], retainInput = false) {
    this.validateComponentEdits(files)
    if (!retainInput) workFilesSchema.parse(files)
    this.editEpoch++; this.dirty = true
    this.notify({ files: structuredClone(files) })
    if (retainInput) workFilesSchema.parse(files)
  }
  private validateComponentBindings(files: WorkFile[]) {
    if (!this.components) return
    for (const file of files) {
      const binding = this.components.bindings.find(binding => componentStateName(binding.key) === file.name)
      if (binding ? !matchesComponentState(binding, this.components.activityId, file) : file.mediaType === componentStateMediaType)
        throw new Error('组件状态身份和位置由活动绑定固定，不能作为普通文件更改。')
    }
  }
  private validateComponentEdits(files: WorkFile[]) {
    this.validateComponentBindings(files)
    if (!this.components) return
    for (const previous of this.state.files.filter(file => file.mediaType === componentStateMediaType)) {
      const file = files.find(file => file.objectId === previous.objectId)
      if (!file || file.mediaType !== componentStateMediaType || file.kind !== 'state' || file.encoding !== 'json')
        throw new Error('请在组件中修改状态，状态对象不可作为普通文件删除或替换。')
    }
  }
  /** A stale component view keeps its candidate in this same protected workspace, never in an iframe-only buffer. */
  retainConflict(files: WorkFile[]) {
    const other = structuredClone(this.state.conflict?.other ?? this.state.files)
    this.change(files, true)
    this.notify({ conflict: { source: 'local', local: structuredClone(files), other,
      at: this.record.localRevision, remoteRevision: this.record.remoteRevision }, error: '组件读取的状态已变化，请在「作品」中比较双方内容。' })
  }
  edit(objectId: string, value: string) {
    if (this.state.files.find(file => file.objectId === objectId)?.mediaType === componentStateMediaType) throw new Error('请在组件中编辑状态。')
    const files = this.state.files.map(file => file.objectId === objectId ? { ...file, value, contentId: crypto.randomUUID() } : file)
    this.editEpoch++; this.dirty = true
    this.notify({ files, ...(this.state.conflict ? { conflict: { ...this.state.conflict, local: files } } : {}) })
    workFilesSchema.parse(files)
  }
  create(name: string, kind: 'text' | 'code' = 'code') {
    const file: WorkFile = { objectId: crypto.randomUUID(), contentId: crypto.randomUUID(), name, kind, encoding: 'utf8', mediaType: 'text/plain', value: '' }
    this.change([...this.state.files, file]); return file.objectId
  }
  rename(objectId: string, name: string) { this.change(this.state.files.map(f => f.objectId === objectId ? { ...f, name } : f)) }
  remove(objectId: string) { this.change(this.state.files.filter(f => f.objectId !== objectId)) }
  protected async persist() {
    const epoch = this.editEpoch
    const files = structuredClone(this.state.files)
    const operations = [...this.operations.entries()]
    try {
      if (this.dirty) {
        workFilesSchema.parse(files)
        const conflict = this.state.conflict
        if (conflict?.source === 'local' && conflict.candidateId) {
          await this.store.candidate(conflict.candidateId, this.key, files)
          if (epoch === this.editEpoch) this.dirty = false
          this.notify({ conflict: { ...conflict, local: this.state.files } })
          return
        }
        this.record = await this.store.change(this.key, current => {
          const previous = current ?? this.record
          return { ...previous, localRevision: previous.localRevision + 1, files,
            pending: previous.pending && !previous.pendingRejected ? previous.pending : pendingFor(files, previous.remoteRevision),
            pendingRejected: false,
            ...(conflict ? { conflict: { ...conflict, local: files, at: previous.localRevision + 1 } } : {}) }
        }, { expected: this.record.localRevision, files }, undefined, operations.map(([, value]) => value))
        for (const [key, value] of operations) if (this.operations.get(key) === value) this.operations.delete(key)
        if (epoch === this.editEpoch) this.dirty = false
        if (this.state.conflict && this.record.conflict) this.notify({ conflict: { ...this.record.conflict, local: this.state.files } })
      } else {
        const current = await this.store.read(this.key)
        if (current && current.localRevision !== this.record.localRevision && epoch === this.editEpoch) {
          if (this.state.conflict) {
            // An unresolved comparison keeps this page's files; the other side only advances.
            this.record = current
            this.notify({ conflict: { ...this.state.conflict, other: structuredClone(current.files), at: current.localRevision } })
            return
          }
          this.record = current
          this.notify({ files: current.files, editorEpoch: this.state.editorEpoch + 1, conflict: current.conflict })
        } else if (current && current.localRevision === this.record.localRevision) this.record = current
      }
      if (!this.denied) this.notify({ error: this.record.pendingRejected ? '原作品请求未通过校验，请修正内容；原文仍保留。' : '' })
    } catch (error) {
      if (error instanceof LocalCompetition) {
        for (const [key, value] of operations) if (this.operations.get(key) === value) this.operations.delete(key)
        this.record = error.current
        this.notify({ conflict: { source: 'local', local: files, other: error.current.files, at: error.current.localRevision,
          remoteRevision: error.current.remoteRevision, candidateId: error.candidateId }, error: error.message })
      } else this.notify({ error: '本机存储未能保护当前内容。请保留此页面，可复制或导出作品；系统会自动重试。' })
      throw error
    }
  }
  protected async synchronize() {
    if (this.stopped || this.denied || this.sending || !this.state.ready || this.state.conflict) return
    this.sending = true
    let attempted: WorkSync | undefined
    try {
      await this.protect()
      const current = await this.store.read(this.key)
      const pending = current?.pending
      if (current?.pendingRejected) return
      if (!current || !pending) {
        // Also discover changes from a separate client without interpreting failures as an empty workspace.
        const remote = workViewSchema.parse(await this.transport.read())
        if (this.stopped || this.dirty || this.state.conflict) return
        if (remote.revision !== this.record.remoteRevision) {
          const next = await this.store.change(this.key, saved => {
            if (!saved || saved.pending || saved.localRevision !== current?.localRevision) return saved ?? this.record
            return { ...saved, remoteRevision: remote.revision, confirmedFiles: remote.files, files: remote.files, localRevision: saved.localRevision + 1 }
          })
          if (!this.dirty) { this.record = next; this.notify({ files: next.files, editorEpoch: this.state.editorEpoch + 1 }) }
        }
        return
      }
      if (this.stopped || this.denied) return
      const known = await this.transport.receipt(pending.requestId)
      if (this.stopped || this.denied) return
      let confirmed: WorkView
      if (known) confirmed = workViewSchema.parse(known)
      else { attempted = pending; confirmed = workViewSchema.parse(await this.transport.sync(pending)) }
      if (confirmed.revision !== pending.baseRevision + 1 || !sameFiles(confirmed.files, pending.files)) throw Object.assign(new Error('服务回执与原请求不符。'), { code: 'corrupt' })
      // Acknowledgement can only settle the exact durable pending request; memory and subsequent edits are untouched.
      await this.store.change(this.key, saved => {
        if (!saved || saved.pending?.requestId !== pending.requestId) return saved ?? current
        return { ...saved, remoteRevision: confirmed.revision, confirmedFiles: confirmed.files,
          pending: sameFiles(saved.files, pending.files) ? null : pendingFor(saved.files, confirmed.revision) }
      })
    } catch (error) {
      const rawCode = (error as { code?: unknown }).code
      const code = typeof rawCode === 'string' ? rawCode : undefined
      if (code === 'conflict') {
        try {
          const other = workViewSchema.parse(await this.transport.read())
          await this.protect()
          // Freeze the comparison from the latest memory state before the following asynchronous transaction.
          this.dirty = true
          this.notify({ conflict: { source: 'remote', local: structuredClone(this.state.files), other: other.files,
            at: this.record.localRevision, remoteRevision: other.revision }, error: '另一客户端修改了作品，请比较并选择。' })
          await this.protect()
        } catch { /* retain original request until the original service is available */ }
      } else if (code === 'invalid' && attempted) {
        // A direct invalid sync response is definitive rejection, never a lost acceptance ACK.
        const requestId = attempted.requestId, baseline = this.record
        try {
          this.record = await this.store.change(this.key, saved => {
            if (!saved || saved.pending?.requestId !== requestId) return saved ?? baseline
            const corrected = !sameFiles(saved.files, saved.pending.files)
            return { ...saved, pendingRejected: !corrected,
              pending: corrected ? pendingFor(saved.files, saved.remoteRevision) : saved.pending }
          })
          this.notify({ error: this.record.pendingRejected ? '原作品请求未通过校验，请修正内容；原文仍保留。' : '' })
        } catch { /* Keep querying the original request until its rejection can be protected locally. */ }
      } else if (code === 'forbidden' || code === 'stale-generation') {
        this.denied = true
        this.notify({ error: '访问资格已失效，已停止该身份的同步。本机作品仍保留，请重新登录原空间。' })
      } else if (code && !['unavailable', 'maintenance', 'commit-unknown', 'upload-unknown'].includes(code)) {
        this.denied = true; this.notify({ error: '作品同步无法继续：' + code + '。内容仍保留，可复制或导出。' })
      }
      // Temporary network loss remains quiet; the same pending identity is queried on the next bounded tick.
    } finally { this.sending = false }
  }
  async resolve(files: WorkFile[]) {
    await this.protect()
    await this.withProtection(() => this.resolveProtected(files))
  }
  private async resolveProtected(files: WorkFile[]) {
    const conflict = this.state.conflict
    if (!conflict) return
    if (this.dirty) throw new Error('当前比较内容仍在保护中。')
    workFilesSchema.parse(files)
    // An explicit choice may adopt another client's object or its valid empty state.
    // Keep binding validation, but do not impose ordinary-edit identity retention.
    this.validateComponentBindings(files)
    if (conflict.source === 'remote') files = files.map(file =>
      this.record.confirmedFiles?.some(old => old.objectId === file.objectId) && !conflict.other.some(other => other.objectId === file.objectId)
        ? { ...file, objectId: crypto.randomUUID(), contentId: crypto.randomUUID() } : file)
    // Captured before the transaction so input made during the choice is never overwritten by it.
    const epoch = this.editEpoch
    const saved = await this.store.change(this.key, current => {
      if (!current) throw new Error('本机作品记录不可读。')
      const revision = conflict.source === 'remote' ? conflict.remoteRevision : current.remoteRevision
      return { ...current, localRevision: current.localRevision + 1, remoteRevision: revision, files,
        confirmedFiles: conflict.source === 'remote' ? conflict.other : current.confirmedFiles,
        conflict: undefined, pending: conflict.source === 'local' && current.pending ? current.pending : pendingFor(files, revision) }
    }, { expected: conflict.at, files }, conflict.candidateId)
    this.record = saved
    // Later input wins: the transaction result is only the durable baseline, and the editor keeps its own content.
    if (epoch !== this.editEpoch) { this.notify({ conflict: undefined, error: '' }); return }
    this.dirty = false
    this.notify({ files, conflict: undefined, error: '', editorEpoch: this.state.editorEpoch + 1 })
    void this.synchronize()
  }
}
