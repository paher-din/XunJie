import { workFilesSchema, workViewSchema } from '@xunjie/contracts/learning-data'
import type { WorkFile, WorkView, WorkSync } from '@xunjie/contracts/learning-data'
import { WorkStore, LocalCompetition, sameFiles, pendingFor, initialRecord } from './store'
import type { WorkRecord, WorkConflict } from './store'

export const LOCAL_MAX_WAIT_MS = 250
export const NETWORK_MAX_WAIT_MS = 1000
export interface WorkTransport { read(): Promise<WorkView>; receipt(requestId: string): Promise<WorkView | null>; sync(input: WorkSync): Promise<WorkView> }
export interface WorkspaceState { files: WorkFile[]; ready: boolean; error: string; conflict?: WorkConflict; conflictReady: boolean; editorEpoch: number }

/** The page/editor's only change and recovery interface. No legacy database or execution ledger access. */
export class ReliableWorkspace {
  private record: WorkRecord
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
  private store = new WorkStore()
  private listeners = new Set<() => void>()
  state: WorkspaceState = { files: [], ready: false, error: '', conflictReady: false, editorEpoch: 0 }
  constructor(readonly key: string, private transport: WorkTransport) { this.record = initialRecord(key, { revision: 0, files: [] }) }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.state
  private notify(patch: Partial<WorkspaceState> = {}) { this.state = { ...this.state, ...patch, conflictReady: !this.dirty }; for (const listener of this.listeners) listener() }
  async open() {
    if (this.disposed || this.state.ready) return
    this.localTimer ??= setInterval(() => {
      if (this.state.ready) void this.protect().catch(() => {})
      else if (!this.denied) void this.initialize().catch(() => {})
    }, LOCAL_MAX_WAIT_MS)
    this.networkTimer ??= setInterval(() => { void this.synchronize() }, NETWORK_MAX_WAIT_MS)
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
      if (!this.disposed) this.notify({ files: conflict?.local ?? this.record.files, ready: true, conflict, error: '' })
    } catch (error) {
      if ((error as { code?: unknown }).code === 'forbidden') this.denied = true
      if (!this.disposed) this.notify({ files: this.record.files, error: this.denied ? '原空间访问资格已失效，请重新登录原空间。'
        : '暂时无法读取或保护原工作区，内容不会被替换为空；系统会自动重试。' })
      throw error
    }
  }
  private beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.dirty) { event.preventDefault(); event.returnValue = '' }
  }
  change(files: WorkFile[]) {
    workFilesSchema.parse(files)
    this.editEpoch++; this.dirty = true
    this.notify({ files: structuredClone(files) })
  }
  edit(objectId: string, value: string) {
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
  async protect(): Promise<void> {
    if (this.protecting) { await this.protecting; if (this.dirty && !this.state.conflict) return this.protect(); return }
    this.protecting = this.persist()
    try { await this.protecting } finally { this.protecting = undefined }
  }
  private async persist() {
    const epoch = this.editEpoch
    const files = structuredClone(this.state.files)
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
            pending: previous.pending ?? pendingFor(files, previous.remoteRevision),
            ...(conflict ? { conflict: { ...conflict, local: files, at: previous.localRevision + 1 } } : {}) }
        }, { expected: this.record.localRevision, files })
        if (epoch === this.editEpoch) this.dirty = false
        if (this.state.conflict && this.record.conflict) this.notify({ conflict: { ...this.record.conflict, local: this.state.files } })
      } else {
        const current = await this.store.read(this.key)
        if (current && current.localRevision !== this.record.localRevision && epoch === this.editEpoch) {
          this.record = current
          this.notify({ files: current.files, editorEpoch: this.state.editorEpoch + 1, conflict: current.conflict })
        } else if (current && current.localRevision === this.record.localRevision) this.record = current
      }
      if (!this.denied) this.notify({ error: '' })
    } catch (error) {
      if (error instanceof LocalCompetition) {
        this.record = error.current
        this.notify({ conflict: { source: 'local', local: files, other: error.current.files, at: error.current.localRevision,
          remoteRevision: error.current.remoteRevision, candidateId: error.candidateId }, error: error.message })
      } else this.notify({ error: '本机存储未能保护当前内容。请保留此页面，可复制或导出作品；系统会自动重试。' })
      throw error
    }
  }
  private async synchronize() {
    if (this.stopped || this.denied || this.sending || !this.state.ready || this.state.conflict) return
    this.sending = true
    try {
      await this.protect()
      const current = await this.store.read(this.key)
      const pending = current?.pending
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
      const confirmed = workViewSchema.parse(known ?? await this.transport.sync(pending))
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
    const conflict = this.state.conflict
    if (!conflict) return
    if (this.dirty) throw new Error('当前比较内容仍在保护中。')
    workFilesSchema.parse(files)
    if (conflict.source === 'remote') files = files.map(file =>
      this.record.confirmedFiles?.some(old => old.objectId === file.objectId) && !conflict.other.some(other => other.objectId === file.objectId)
        ? { ...file, objectId: crypto.randomUUID(), contentId: crypto.randomUUID() } : file)
    const saved = await this.store.change(this.key, current => {
      if (!current) throw new Error('本机作品记录不可读。')
      const revision = conflict.source === 'remote' ? conflict.remoteRevision : current.remoteRevision
      return { ...current, localRevision: current.localRevision + 1, remoteRevision: revision, files,
        confirmedFiles: conflict.source === 'remote' ? conflict.other : current.confirmedFiles,
        conflict: undefined, pending: conflict.source === 'local' && current.pending ? current.pending : pendingFor(files, revision) }
    }, { expected: conflict.at, files }, conflict.candidateId)
    this.record = saved; this.dirty = false
    this.notify({ files, conflict: undefined, error: '', editorEpoch: this.state.editorEpoch + 1 })
    void this.synchronize()
  }
  async leave(): Promise<void> { await this.protect(); if (this.dirty) return this.leave() }
  suspend() { this.stopped = true; if (this.networkTimer) clearInterval(this.networkTimer) }
  dispose() {
    this.disposed = true
    this.suspend(); if (this.localTimer) clearInterval(this.localTimer)
    window.removeEventListener('beforeunload', this.beforeUnload)
    this.listeners.clear()
  }
}
