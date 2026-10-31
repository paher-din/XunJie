import type { QuestionReferenceInput, QuestionWorkBasis } from '@xunjie/contracts/question-drafts'

export interface DraftContent { question: string; references: QuestionReferenceInput[]; bases?: QuestionWorkBasis[] }
export interface DraftConflict { source: 'local' | 'remote'; local: DraftContent; other: DraftContent
  at: number; remoteRevision: number; candidateId?: string }
export interface DraftRecord extends DraftContent { key: string; draftId: string; localRevision: number
  remoteRevision: number; revisionId: string | null; bases: QuestionWorkBasis[]; pending: DraftSync | null; conflict?: DraftConflict }
export interface DraftSync { requestId: string; draftId: string; baseRevision: number
  question: string; references: QuestionReferenceInput[]; bases: QuestionWorkBasis[] }

export class DraftLocalCompetition extends Error {
  constructor(public current: DraftRecord, public candidateId: string) { super('另一标签页修改了问题草稿，请比较并选择。') }
}

let opening: Promise<IDBDatabase> | undefined
/** Version 2 only adds stores; existing reliable workspace records stay readable. */
export function openWorkspaceDatabase(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('xunjie-reliable-works-v1', 2)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains('workspaces')) db.createObjectStore('workspaces', { keyPath: 'key' })
        if (!db.objectStoreNames.contains('candidates')) db.createObjectStore('candidates', { keyPath: 'id' }).createIndex('scope', 'scope')
        if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'key' })
        if (!db.objectStoreNames.contains('draftCandidates')) db.createObjectStore('draftCandidates', { keyPath: 'id' }).createIndex('scope', 'scope')
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
  references: value.references.map(reference => ({ referenceId: reference.referenceId, source: reference.source,
    range: { kind: reference.range.kind, start: reference.range.start, end: reference.range.end },
    copy: reference.copy, sourceName: reference.sourceName })) })
export const sameDraftContent = (a: DraftContent, b: DraftContent) =>
  normalizedContent(a) === normalizedContent(b)
export function initialDraftRecord(key: string, draftId: string): DraftRecord {
  return { key, draftId, localRevision: 0, remoteRevision: 0, revisionId: null, question: '', references: [], bases: [], pending: null }
}
