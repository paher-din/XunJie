import type { ComponentCapability, PreparationCapability, PreparationDevice, PreparationReasonCode,
  PreparationStage, PreparationStatus, PreparationVerification } from '@xunjie/contracts/components'

/**
 * Preparation facts live in their own database, apart from `xunjie-reliable-works-v1`. Student work, drafts,
 * receipts and learning evidence are never written here, and this store is never a source for them.
 */
const databaseName = 'xunjie-component-preparation-v1'
const databaseVersion = 1

export interface PreparationCheck {
  fingerprint: string
  checkId: string
  verification: PreparationVerification
  reason: PreparationReasonCode
}
export interface PreparationDiagnostic { at: string; stage: PreparationStage; reason: PreparationReasonCode; detail: string }
export interface PreparationRecord {
  preparationId: string
  scopeKey: string
  requestId: string
  requestDigest: string
  componentId: string
  version: number
  definitionDigest: string
  configurationDigest: string
  selfTestVersion: number
  stage: PreparationStage
  status: PreparationStatus
  reason: PreparationReasonCode
  device: PreparationDevice
  deviceFingerprint: string
  environmentId: string | null
  checks: PreparationCheck[]
  capabilities: PreparationCapability[]
  cachedDependencies: string[]
  cacheHit: boolean
  resourceBytes: number
  durationMs: number
  reportId: string | null
  reportRequestId: string | null
  reportSubmitted: boolean
  diagnostics: PreparationDiagnostic[]
  createdAt: string
  updatedAt: string
}
export interface CheckResult {
  fingerprint: string
  checkId: string
  componentId: string
  version: number
  selfTestVersion: number
  verification: PreparationVerification
  reason: PreparationReasonCode
  capabilities: ComponentCapability[]
  observedAt: string
}
export interface CachedResource { sha256: string; byteLength: number; mediaType: string; bytes: Uint8Array; storedAt: string }
export interface ActiveEnvironment {
  scopeKey: string
  environmentId: string
  preparationId: string
  componentId: string
  version: number
  definitionDigest: string
  activatedAt: string
}

/** The Module's persistence boundary. Production uses IndexedDB; tests inject failures at this seam only. */
export interface PreparationStore {
  read(preparationId: string): Promise<PreparationRecord | undefined>
  write(record: PreparationRecord): Promise<void>
  list(scopeKey: string): Promise<PreparationRecord[]>
  readCheck(fingerprint: string): Promise<CheckResult | undefined>
  writeCheck(result: CheckResult): Promise<void>
  readResource(digest: string): Promise<CachedResource | undefined>
  writeResource(resource: CachedResource): Promise<void>
  dropResource(digest: string): Promise<void>
  readEnvironment(scopeKey: string): Promise<ActiveEnvironment | undefined>
  writeEnvironment(environment: ActiveEnvironment): Promise<void>
}

let opening: Promise<IDBDatabase> | undefined
function open(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, databaseVersion)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains('preparations')) db.createObjectStore('preparations', { keyPath: 'preparationId' }).createIndex('scope', 'scopeKey')
        if (!db.objectStoreNames.contains('checks')) db.createObjectStore('checks', { keyPath: 'fingerprint' })
        if (!db.objectStoreNames.contains('resources')) db.createObjectStore('resources', { keyPath: 'sha256' })
        if (!db.objectStoreNames.contains('environments')) db.createObjectStore('environments', { keyPath: 'scopeKey' })
      }
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => { db.close(); opening = undefined }
        resolve(db)
      }
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('浏览器准备存储升级被其他页面阻止。'))
    })
    opening.catch(() => { opening = undefined })
  }
  return opening
}

function transact<T>(store: string, mode: IDBTransactionMode, run: (target: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(db => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode)
    const request = run(tx.objectStore(store))
    tx.oncomplete = () => resolve(request.result)
    tx.onabort = () => reject(tx.error)
    tx.onerror = () => { /* onabort owns failure */ }
  }))
}

export const preparationStore: PreparationStore = {
  read: (preparationId: string) => transact<PreparationRecord | undefined>('preparations', 'readonly', store => store.get(preparationId) as IDBRequest<PreparationRecord | undefined>),
  write: (record: PreparationRecord) => transact('preparations', 'readwrite', store => store.put(record)).then(() => undefined),
  /** Oldest first: the caller resumes the identity that already exists rather than minting a second one. */
  list: (scopeKey: string) => open().then(db => new Promise<PreparationRecord[]>((resolve, reject) => {
    const tx = db.transaction('preparations', 'readonly')
    const request = tx.objectStore('preparations').index('scope').getAll(scopeKey)
    tx.oncomplete = () => resolve((request.result as PreparationRecord[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    tx.onabort = () => reject(tx.error)
    tx.onerror = () => { /* onabort owns failure */ }
  })),
  readCheck: (fingerprint: string) => transact<CheckResult | undefined>('checks', 'readonly', store => store.get(fingerprint) as IDBRequest<CheckResult | undefined>),
  writeCheck: (result: CheckResult) => transact('checks', 'readwrite', store => store.put(result)).then(() => undefined),
  readResource: (digest: string) => transact<CachedResource | undefined>('resources', 'readonly', store => store.get(digest) as IDBRequest<CachedResource | undefined>),
  writeResource: (resource: CachedResource) => transact('resources', 'readwrite', store => store.put(resource)).then(() => undefined),
  dropResource: (digest: string) => transact('resources', 'readwrite', store => store.delete(digest)).then(() => undefined),
  readEnvironment: (scopeKey: string) => transact<ActiveEnvironment | undefined>('environments', 'readonly', store => store.get(scopeKey) as IDBRequest<ActiveEnvironment | undefined>),
  writeEnvironment: (environment: ActiveEnvironment) => transact('environments', 'readwrite', store => store.put(environment)).then(() => undefined),
}

/**
 * Cross-tab mutual exclusion for one preparation identity. Without Web Locks two tabs may prepare the same
 * component concurrently; the persistent record still converges, so this is an optimization, not a guarantee.
 */
export async function withPreparationLock<T>(name: string, run: () => Promise<T>): Promise<T> {
  const locks = (navigator as Navigator & { locks?: { request(name: string, callback: () => Promise<T>): Promise<T> } }).locks
  if (!locks) return run()
  return locks.request(`xunjie-preparation:${name}`, run)
}
