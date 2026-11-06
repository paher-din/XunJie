import type { TeachingStudentResponseInput, TeachingStudentResponseReceipt } from '@xunjie/contracts/teaching-agent'
import { openWorkspaceDatabase } from './draft-store'

export interface LocalStudentResponse {
  key: string; scope: string; presentationId: string
  mode: 'choice' | 'text'; optionId: string; text: string
  input?: TeachingStudentResponseInput; receipt?: TeachingStudentResponseReceipt
}

/** The fixed response identity and its input commit together before any business POST. */
export class StudentResponseStore {
  async read(key: string): Promise<LocalStudentResponse | undefined> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('studentResponses', 'readonly'), request = tx.objectStore('studentResponses').get(key)
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => reject(tx.error)
      tx.onerror = () => {}
    })
  }
  async change(key: string, update: (saved: LocalStudentResponse | undefined) => LocalStudentResponse): Promise<LocalStudentResponse> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('studentResponses', 'readwrite'), store = tx.objectStore('studentResponses'), request = store.get(key)
      let result: LocalStudentResponse, failure: unknown
      request.onsuccess = () => {
        try { result = update(request.result); if (result.key !== key) throw new Error('回应不属于当前问题。'); store.put(result) }
        catch (error) { failure = error; tx.abort() }
      }
      tx.oncomplete = () => resolve(result)
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('回应尚未在本机可靠保留。'))
      tx.onerror = () => {}
    })
  }
}
