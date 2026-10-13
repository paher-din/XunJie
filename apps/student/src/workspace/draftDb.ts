import {
  decideSave,
  type DraftRecord,
  type DraftRepository,
  type InstanceRecord,
  type SaveDraftResult,
  type WorkspaceUiRecord,
} from '../lib/draftStore'

/**
 * P-02 批准的新库 `xunjie-i0-workspace` 的共享连接。
 *
 * 02 的五个 store 保留；03 经负责人明确批准升 v2，只新增 outbox / metadata。
 * 草稿写入在单个 readwrite 事务里「读修订 → CAS 判定 → 写」，事务 complete 才算保护成功；
 * 冲突不写、不覆盖赢方，败方正文进 candidates。
 */

const DB_NAME = 'xunjie-i0-workspace'
const DB_VERSION = 2

let opening: Promise<IDBDatabase> | null = null
let connectionClosed = false

export function openWorkspaceDb(): Promise<IDBDatabase> {
  if (opening === null) opening = startOpen()
  // 连接被关掉（版本升级让连接、外部删库）后重新开，不让一次失败把整个会话楔死
  return opening.then((db) => {
    if (!connectionClosed) return db
    connectionClosed = false
    opening = startOpen()
    return opening
  })
}

function startOpen(): Promise<IDBDatabase> {
  const fresh = openFresh()
  // 打开失败（被阻塞 / 存储禁用）不能把 rejected promise 缓存成永久状态
  fresh.catch(() => {
    if (opening === fresh) opening = null
  })
  return fresh
}

function openFresh(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts', { keyPath: 'clientFileKey' })
      }
      if (!db.objectStoreNames.contains('ui')) {
        db.createObjectStore('ui', { keyPath: 'scopeKey' })
      }
      if (!db.objectStoreNames.contains('instances')) {
        db.createObjectStore('instances', { keyPath: 'clientFileKey' })
      }
      if (!db.objectStoreNames.contains('confirmed')) {
        db.createObjectStore('confirmed', { keyPath: 'clientFileKey' })
      }
      if (!db.objectStoreNames.contains('candidates')) {
        db.createObjectStore('candidates', { keyPath: 'id', autoIncrement: true })
      }
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'commandKey' })
      if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata', { keyPath: 'key' })
    }
    request.onsuccess = () => {
      const db = request.result
      // 后续版本升级时老标签页主动让连接，不把 delete/open 阻塞成死等
      db.onversionchange = () => {
        connectionClosed = true
        db.close()
      }
      db.onclose = () => {
        connectionClosed = true
      }
      resolve(db)
    }
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'))
    request.onblocked = () => reject(new Error('IndexedDB 被其他连接阻塞'))
  })
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('写入事务被中止'))
    tx.onerror = () => reject(tx.error ?? new Error('写入事务失败'))
  })
}

function getRecord<T>(db: IDBDatabase, store: string, key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const request = tx.objectStore(store).get(key)
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null)
    request.onerror = () => reject(request.error ?? new Error('读取失败'))
  })
}

function putRecord(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  const tx = db.transaction(store, 'readwrite')
  tx.objectStore(store).put(value)
  return txDone(tx)
}

export const idbDraftRepository: DraftRepository = {
  async loadUi(key) {
    return getRecord<WorkspaceUiRecord>(await openWorkspaceDb(), 'ui', key)
  },

  async saveUi(record) {
    await putRecord(await openWorkspaceDb(), 'ui', record)
  },

  async loadDraft(key) {
    return getRecord<DraftRecord>(await openWorkspaceDb(), 'drafts', key)
  },

  async saveDraft(record, expectedRevision) {
    const db = await openWorkspaceDb()
    const tx = db.transaction('drafts', 'readwrite')
    const store = tx.objectStore('drafts')
    const decision = await new Promise<SaveDraftResult>((resolve) => {
      const request = store.get(record.clientFileKey)
      request.onsuccess = () => {
        const stored = request.result as DraftRecord | undefined
        const result = decideSave(stored?.draftRevision ?? null, expectedRevision)
        if (!result.ok) {
          resolve(result)
          return
        }
        store.put({ ...record, draftRevision: result.draftRevision })
        resolve({ ok: true, draftRevision: result.draftRevision })
      }
      request.onerror = () => resolve({ ok: false, reason: 'error', message: String(request.error) })
    })
    if (decision.ok) await txDone(tx)
    return decision
  },

  async loadInstance(key) {
    return getRecord<InstanceRecord>(await openWorkspaceDb(), 'instances', key)
  },

  async saveInstance(record: InstanceRecord) {
    await putRecord(await openWorkspaceDb(), 'instances', record)
  },

  async keepCandidate(clientFileKey, text, reason) {
    await putRecord(await openWorkspaceDb(), 'candidates', { clientFileKey, text, reason, createdAt: Date.now() })
  },
}
