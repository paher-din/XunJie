import { executionActionSchema, executionControlSchema, type ExecutionAction, type ExecutionControl } from '@xunjie/contracts/execution'
import { openWorkspaceDatabase } from '../reliable-workspace/draft-store'

export type PendingSessionRequest = { kind: 'start'; id: string; action: ExecutionAction }
  | { kind: 'control'; id: string; requestId: string; control: ExecutionControl }
  | { kind: 'stop'; id: string; requestId: string; reason: string }
export interface SessionRequestQueue {
  list(scope: string): Promise<PendingSessionRequest[]>
  put(scope: string, request: PendingSessionRequest): Promise<void>
  remove(scope: string, id: string): Promise<void>
}
/** A durable outgoing-request partition, not another authority for execution state. */
export class SessionRequests implements SessionRequestQueue {
  async list(scope: string): Promise<PendingSessionRequest[]> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('nativeSessionRequests', 'readonly')
      const result = tx.objectStore('nativeSessionRequests').index('scope').getAll(scope)
      tx.oncomplete = () => {
        try { resolve(result.result.map((row: { request: PendingSessionRequest }) => {
          const request = row.request
          if (request.kind === 'start') executionActionSchema.parse(request.action)
          if (request.kind === 'control') executionControlSchema.parse(request.control)
          return request
        })) } catch (error) { reject(error) }
      }
      tx.onabort = () => reject(tx.error)
      tx.onerror = () => {}
    })
  }
  async put(scope: string, request: PendingSessionRequest) {
    const db = await openWorkspaceDatabase()
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('nativeSessionRequests', 'readwrite'), store = tx.objectStore('nativeSessionRequests')
      const key = JSON.stringify([scope, request.id]), existing = store.get(key)
      let failure: unknown
      existing.onsuccess = () => {
        if (existing.result && JSON.stringify(existing.result.request) !== JSON.stringify(request)) {
          failure = new Error('identity-conflict'); tx.abort(); return
        }
        store.put({ key, scope, request: structuredClone(request) })
      }
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(failure ?? tx.error)
      tx.onerror = () => {}
    })
  }
  async remove(scope: string, id: string) {
    const db = await openWorkspaceDatabase()
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('nativeSessionRequests', 'readwrite')
      tx.objectStore('nativeSessionRequests').delete(JSON.stringify([scope, id]))
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
      tx.onerror = () => {}
    })
  }
}
