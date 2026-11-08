import { questionReferenceKey } from '@xunjie/contracts/question-drafts'
import type { QuestionReferenceInput, QuestionWorkBasis, QuestionSkill } from '@xunjie/contracts/question-drafts'

export interface DraftContent { question: string; references: QuestionReferenceInput[]; bases?: QuestionWorkBasis[]; skills?: QuestionSkill[] }
export interface DraftConflict { source: 'local' | 'remote'; local: DraftContent; other: DraftContent
  at: number; remoteRevision: number; candidateId?: string }
export interface DraftRecord extends DraftContent { key: string; draftId: string; localRevision: number
  remoteRevision: number; revisionId: string | null; bases: QuestionWorkBasis[]; pending: DraftSync | null; conflict?: DraftConflict; contentToken?: string
  /** The owner refused this exact pending: keep its text, never resend it, until the content changes. */
  pendingRejected?: boolean }
export interface DraftSync { requestId: string; draftId: string; baseRevision: number
  question: string; references: QuestionReferenceInput[]; bases: QuestionWorkBasis[]; skills?: QuestionSkill[] }

export class DraftLocalCompetition extends Error {
  constructor(public current: DraftRecord, public candidateId: string) { super('另一标签页修改了问题草稿，请比较并选择。') }
}

let opening: Promise<IDBDatabase> | undefined
/** Additive upgrades preserve the original reliable work and draft stores. */
export function openWorkspaceDatabase(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('xunjie-reliable-works-v1', 11)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains('workspaces')) db.createObjectStore('workspaces', { keyPath: 'key' })
        if (!db.objectStoreNames.contains('candidates')) db.createObjectStore('candidates', { keyPath: 'id' }).createIndex('scope', 'scope')
        if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'key' })
        if (!db.objectStoreNames.contains('draftCandidates')) db.createObjectStore('draftCandidates', { keyPath: 'id' }).createIndex('scope', 'scope')
        if (!db.objectStoreNames.contains('actions')) db.createObjectStore('actions', { keyPath: 'key' }).createIndex('scope', 'scope')
        if (!db.objectStoreNames.contains('workOperations')) db.createObjectStore('workOperations', { keyPath: ['workspace', 'scope', 'operationId'] })
        // v5: the browser execution ledger. Commands and their pending facts commit together;
        // stop requests, result bytes and service synchronisation are separate durable partitions.
        if (!db.objectStoreNames.contains('executionCommands')) db.createObjectStore('executionCommands', { keyPath: 'key' }).createIndex('scope', 'scope')
        if (!db.objectStoreNames.contains('executionPending')) db.createObjectStore('executionPending', { keyPath: ['scope', 'requestId', 'seq'] })
        if (!db.objectStoreNames.contains('executionStops')) db.createObjectStore('executionStops', { keyPath: ['scope', 'stopId'] }).createIndex('scope', 'scope')
        if (!db.objectStoreNames.contains('executionResults')) db.createObjectStore('executionResults', { keyPath: ['scope', 'executionRef'] })
        if (!db.objectStoreNames.contains('executionSync')) db.createObjectStore('executionSync', { keyPath: ['scope', 'requestId'] })
        if (!db.objectStoreNames.contains('nativeSessionJournal')) db.createObjectStore('nativeSessionJournal', { keyPath: 'scope' })
        if (!db.objectStoreNames.contains('nativeSessionRequests')) db.createObjectStore('nativeSessionRequests', { keyPath: 'key' }).createIndex('scope', 'scope')
        if (!db.objectStoreNames.contains('studentResponses')) db.createObjectStore('studentResponses', { keyPath: 'key' }).createIndex('scope', 'scope')
        if (!db.objectStoreNames.contains('agentControls')) db.createObjectStore('agentControls', { keyPath: 'key' }).createIndex('scope', 'scope')
        if (!db.objectStoreNames.contains('pdfMaterials')) db.createObjectStore('pdfMaterials', { keyPath: 'key' }).createIndex('scope', 'scope')
        // v11: personal text notes keep their immutable save/update/remove requests beside the other reliable work.
        if (!db.objectStoreNames.contains('personalMaterials')) db.createObjectStore('personalMaterials', { keyPath: 'key' }).createIndex('scope', 'scope')
      }
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => { db.close(); opening = undefined }
        resolve(db)
      }
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('浏览器存储升级被其他页面阻止。'))
    })
    opening.catch(() => { opening = undefined })
  }
  return opening
}

export class DraftStore {
  async read(key: string): Promise<DraftRecord | undefined> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', 'readonly')
      const request = tx.objectStore('drafts').get(key)
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => reject(tx.error)
      tx.onerror = () => { /* onabort owns failure */ }
    })
  }
  async candidates(key: string): Promise<{ id: string; scope: string; content: DraftContent }[]> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('draftCandidates', 'readonly')
      const request = tx.objectStore('draftCandidates').index('scope').getAll(key)
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => reject(tx.error)
      tx.onerror = () => { /* onabort owns failure */ }
    })
  }
  async candidate(id: string, scope: string, content: DraftContent): Promise<void> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('draftCandidates', 'readwrite')
      tx.objectStore('draftCandidates').put({ id, scope, content })
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
    })
  }
  async change(key: string, update: (current: DraftRecord | undefined) => DraftRecord,
    candidate?: { expected: number; content: DraftContent }, removeCandidate?: string): Promise<DraftRecord> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['drafts', 'draftCandidates'], 'readwrite')
      const store = tx.objectStore('drafts')
      const request = store.get(key)
      let result: DraftRecord
      let failure: unknown
      request.onsuccess = () => {
        const current = request.result as DraftRecord | undefined
        try {
          if (candidate && current && current.localRevision !== candidate.expected) {
            const id = crypto.randomUUID()
            tx.objectStore('draftCandidates').put({ id, scope: key, content: candidate.content })
            failure = new DraftLocalCompetition(current, id)
            return
          }
          result = update(current)
          store.put(result)
          if (removeCandidate) tx.objectStore('draftCandidates').delete(removeCandidate)
        } catch (error) { failure = error; tx.abort() }
      }
      tx.oncomplete = () => failure ? reject(failure) : resolve(result)
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('本机事务没有完成。'))
      tx.onerror = () => { /* onabort owns failure */ }
    })
  }
}
const normalizedContent = (value: DraftContent) => JSON.stringify({ question: value.question,
  references: value.references.map(reference => ({ referenceId: reference.referenceId, identity: questionReferenceKey(reference), rangeKind: reference.range.kind,
    copy: reference.copy, sourceName: reference.sourceName })), ...(value.skills === undefined ? {} : { skills: value.skills }) })
export const sameDraftContent = (a: DraftContent, b: DraftContent) =>
  normalizedContent(a) === normalizedContent(b)
export function initialDraftRecord(key: string, draftId: string): DraftRecord {
  return { key, draftId, localRevision: 0, remoteRevision: 0, revisionId: null, question: '', references: [], bases: [], pending: null }
}
