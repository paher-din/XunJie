import type { WorkFile, WorkSync, WorkView } from '@xunjie/contracts/learning-data'
import { workFilesSchema } from '@xunjie/contracts/learning-data'
import { openWorkspaceDatabase } from './draft-store'

export interface WorkConflict { source: 'local' | 'remote'; local: WorkFile[]; other: WorkFile[]; at: number; remoteRevision: number; candidateId?: string }
export interface WorkRecord { key: string; localRevision: number; remoteRevision: number; confirmedFiles?: WorkFile[]; files: WorkFile[]; pending: WorkSync | null; pendingRejected?: boolean; conflict?: WorkConflict }
export interface WorkOperation { scope: string; operationId: string; inputDigest: string; name: string; contentId: string }
export interface WorkOperationReceipt { inputDigest: string; confirmation: 'local-protected'; contentId: string | null; requestedContentId: string; superseded: boolean }
export class LocalCompetition extends Error {
  constructor(public current: WorkRecord, public candidateId: string) { super('另一标签页修改了作品，请比较并选择。') }
}

/** A new product namespace: never opens or consumes legacy workspace databases. */
export class WorkStore {
  async operation(workspace: string, scope: string, operationId: string): Promise<WorkOperationReceipt | undefined> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('workOperations', 'readonly')
      const request = tx.objectStore('workOperations').get([workspace, scope, operationId])
      tx.oncomplete = () => resolve(request.result?.receipt)
      tx.onabort = () => reject(tx.error)
    })
  }
  async read(key: string): Promise<WorkRecord | undefined> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('workspaces', 'readonly')
      const request = tx.objectStore('workspaces').get(key)
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => reject(tx.error)
      tx.onerror = () => { /* onabort owns failure */ }
    })
  }
  async candidates(key: string): Promise<{ id: string; scope: string; files: WorkFile[] }[]> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('candidates', 'readonly')
      const request = tx.objectStore('candidates').index('scope').getAll(key)
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => reject(tx.error)
    })
  }
  async candidate(id: string, scope: string, files: WorkFile[]): Promise<void> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('candidates', 'readwrite')
      tx.objectStore('candidates').put({ id, scope, files })
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
    })
  }
  async change(key: string, update: (current: WorkRecord | undefined) => WorkRecord,
    candidate?: { expected: number; files: WorkFile[] }, removeCandidate?: string, operations: WorkOperation[] = []): Promise<WorkRecord> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['workspaces', 'candidates', 'workOperations'], 'readwrite')
      const store = tx.objectStore('workspaces')
      const request = store.get(key)
      let result: WorkRecord
      let failure: unknown
      request.onsuccess = () => {
        const current = request.result as WorkRecord | undefined
        try {
          if (candidate && current && current.localRevision !== candidate.expected) {
            const id = crypto.randomUUID()
            tx.objectStore('candidates').put({ id, scope: key, files: candidate.files })
            failure = new LocalCompetition(current, id)
            return
          }
          result = update(current)
          store.put(result)
          for (const operation of operations) {
            const contentId = result.files.find(file => file.name === operation.name)?.contentId ?? null
            const receipt: WorkOperationReceipt = { inputDigest: operation.inputDigest, confirmation: 'local-protected', contentId,
              requestedContentId: operation.contentId, superseded: contentId !== operation.contentId }
            tx.objectStore('workOperations').add({ workspace: key, scope: operation.scope, operationId: operation.operationId, receipt })
          }
          if (removeCandidate) tx.objectStore('candidates').delete(removeCandidate)
        } catch (error) { failure = error; tx.abort() }
      }
      // Durable acknowledgement occurs only after the entire transaction commits.
      tx.oncomplete = () => failure ? reject(failure) : resolve(result)
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('本机事务没有完成。'))
      tx.onerror = () => { /* onabort owns failure */ }
    })
  }
}
export const sameFiles = (a: WorkFile[], b: WorkFile[]) => JSON.stringify(workFilesSchema.parse(a)) === JSON.stringify(workFilesSchema.parse(b))
export function pendingFor(files: WorkFile[], revision: number): WorkSync {
  return { requestId: crypto.randomUUID(), baseRevision: revision, files: structuredClone(files) }
}
export function initialRecord(key: string, remote: WorkView): WorkRecord {
  return { key, localRevision: 0, remoteRevision: remote.revision, confirmedFiles: remote.files, files: remote.files, pending: null }
}
