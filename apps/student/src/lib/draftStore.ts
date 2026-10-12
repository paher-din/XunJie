/**
 * 本机草稿存储契约（P-02 批准的新库 `xunjie-i0-workspace` v1 的访问面）。
 *
 * 记录按 模式 / 账号 / Attempt / 文件实例 隔离：clientFileKey 是四段组合，路径与
 * editor version 都不参与身份。同一实例的草稿写入以 draftRevision 做事务 CAS：
 * 旧修订的写入被拒绝、不覆盖新正文，败方文本留作冲突候选。
 *
 * 保护状态只认写入结果：事务 complete 才「已保护」；失败保留内存正文并显示未保护。
 * 布局重置、设置页清缓存不碰这个库；也不迁移或清空既有浏览器数据。
 */

export interface DraftScope {
  /** 运行模式：正式 / 准备 / 演示。 */
  mode: string
  /** 账号标识；演示模式是固定的本地账号。 */
  account: string
  /** Attempt 归属；演示模式按任务计。 */
  attemptKey: string
}

export function scopeKey(scope: DraftScope): string {
  return [scope.mode, scope.account, scope.attemptKey].join('\u0000')
}

export function clientFileKey(scope: DraftScope, fileId: string): string {
  return `${scopeKey(scope)}\u0000${fileId}`
}

/** 从落库键取回本机文件实例 ID（`clientFileKey` 的最后一段）。 */
export function localFileIdOf(clientFileKey: string): string {
  return clientFileKey.split('\u0000').at(-1)!
}

export interface DraftRecord {
  clientFileKey: string
  fileId: string
  text: string
  draftRevision: number
  updatedAt: number
}

export interface InstanceRecord {
  clientFileKey: string
  fileId: string
  path: string
  createdAt: number
  lifecycle: 'active' | 'recycled'
}

export interface WorkspaceUiRecord {
  scopeKey: string
  activeFileId: string | null
  openFileIds: string[]
  created: Array<{ fileId: string; path: string }>
}

export type SaveDraftResult =
  | { ok: true; draftRevision: number }
  | { ok: false; reason: 'conflict' | 'error'; message?: string }

/**
 * CAS 判定（纯函数）：期望修订与库中修订一致才写；新修订 = 库中修订 + 1。
 * 库里还没有记录时期望必须是 null，已有记录时期望必须是当前修订。
 */
export function decideSave(
  storedRevision: number | null,
  expectedRevision: number | null,
): { ok: true; draftRevision: number } | { ok: false; reason: 'conflict' } {
  if (storedRevision !== expectedRevision) return { ok: false, reason: 'conflict' }
  return { ok: true, draftRevision: (storedRevision ?? 0) + 1 }
}

export interface DraftRepository {
  loadUi(scopeKey: string): Promise<WorkspaceUiRecord | null>
  saveUi(record: WorkspaceUiRecord): Promise<void>
  loadDraft(clientFileKey: string): Promise<DraftRecord | null>
  saveDraft(record: DraftRecord, expectedRevision: number | null): Promise<SaveDraftResult>
  saveInstance(record: InstanceRecord): Promise<void>
  /** 读这个文件实例的本机记录（05 的生命周期意图、本机新建的路径与创建时间都在这里）。 */
  loadInstance(clientFileKey: string): Promise<InstanceRecord | null>
  /** 败方正文的保留处：不覆盖赢方，也不丢学生的字。 */
  keepCandidate(clientFileKey: string, text: string, reason: string): Promise<void>
}

/** 内存实现：单测与无 IndexedDB 环境用，CAS 走同一个 decideSave。 */
export function memoryDraftRepository(): DraftRepository {
  const drafts = new Map<string, DraftRecord>()
  const ui = new Map<string, WorkspaceUiRecord>()
  const instances = new Map<string, InstanceRecord>()
  const candidates: Array<{ clientFileKey: string; text: string; reason: string }> = []
  return {
    async loadUi(key) {
      return ui.get(key) ?? null
    },
    async saveUi(record) {
      ui.set(record.scopeKey, { ...record })
    },
    async loadDraft(key) {
      const record = drafts.get(key)
      return record ? { ...record } : null
    },
    async saveDraft(record, expectedRevision) {
      const decision = decideSave(drafts.get(record.clientFileKey)?.draftRevision ?? null, expectedRevision)
      if (!decision.ok) return decision
      drafts.set(record.clientFileKey, { ...record, draftRevision: decision.draftRevision })
      return { ok: true, draftRevision: decision.draftRevision }
    },
    async saveInstance(record) {
      instances.set(record.clientFileKey, { ...record })
    },
    async loadInstance(key) {
      const record = instances.get(key)
      return record ? { ...record } : null
    },
    async keepCandidate(clientFileKey, text, reason) {
      candidates.push({ clientFileKey, text, reason })
    },
  }
}
