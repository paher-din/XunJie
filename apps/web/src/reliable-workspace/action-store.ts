import type { FixedAction } from '@xunjie/contracts/execution'
import type { ExecutionAcceptance } from '@xunjie/contracts/execution'
import type { ActionInput, ActionView, ActionReceipt } from '@xunjie/contracts/action-intents'
import { openWorkspaceDatabase } from './draft-store'

export type ActionPhase = 'unprotected' | 'waiting-dependencies' | 'ready' | 'dispatched' | 'accepted' | 'cancelled' | 'failed'
export interface LocalAction {
  key: string; scope: string; input: FixedAction; phase: ActionPhase; cancelRequested: boolean
  remote?: ActionView; error: string; history?: boolean; draftSettled?: boolean
  /** Persisted before prepare; absent on legacy records means the send history is unknown. */
  preparationAttempted?: boolean
  /** Legacy question actions keep their restorable draft; an execution action never has one. */
  recovered?: Omit<ActionInput['draft'], 'token'> & { draftId: string }
  localReceipt?: ActionReceipt
  localAcceptance?: ExecutionAcceptance
}
export class ActionStore {
  async list(scope?: string): Promise<LocalAction[]> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('actions', 'readonly'), store = tx.objectStore('actions')
      const request = scope === undefined ? store.getAll() : store.index('scope').getAll(scope)
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => reject(tx.error)
      tx.onerror = () => {}
    })
  }
  async change(scope: string, requestId: string, update: (saved: LocalAction | undefined) => LocalAction): Promise<LocalAction> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      // Every phase, fixed basis and cancellation transition belongs to one reliable transaction.
      const tx = db.transaction('actions', 'readwrite'), store = tx.objectStore('actions')
      const request = store.get(JSON.stringify([scope, requestId]))
      let result: LocalAction, failure: unknown
      request.onsuccess = () => {
        try {
          result = update(request.result)
          // Returning the very same record means no fact changed, so no write is issued.
          if (result !== request.result) store.put(result)
        } catch (error) { failure = error; tx.abort() }
      }
      tx.oncomplete = () => resolve(result)
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('动作与依据尚未可靠保留。'))
      tx.onerror = () => {}
    })
  }
}
