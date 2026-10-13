import { openWorkspaceDb, txDone } from './draftDb'
import type { CommandContext } from './frozenCommand'
import type { TutorControl, TutorJob, TutorPayload, TutorReceiptKind, TutorCoverage } from './tutoringContracts'

export interface TutorCommand { key: string; path: string; wireJson: string; kind: 'receipt' | 'help' | 'cancel'
  state: 'pending' | 'confirmed' | 'rejected'; result?: unknown; error?: string; question?: string; issuedStopVersion?:number }
export interface TutorMessage { payload: TutorPayload; epoch: number; valid: boolean; shown: boolean
  facts: Partial<Record<TutorReceiptKind, TutorCommand>> }
export interface TutorLedger { key: string; clientId: string; cursor: number; control: TutorControl | null
  messages: TutorMessage[]; commands: TutorCommand[]; job: TutorJob | null; blocked: boolean; coverage?:TutorCoverage; stopVersion?:number }
export const tutorScope = (c: CommandContext) => JSON.stringify([c.mode, c.userId, c.courseId, c.assignmentId,
  c.activityVersionId, c.attemptId, c.trustedRecoveryGeneration, c.preparationEpoch, c.scenarioId ?? null])
export const tutorLedgerKey = (c: CommandContext, clientId: string) => `tutor:ledger:${tutorScope(c)}:${clientId}`
export async function readTutorLedger(key: string): Promise<TutorLedger | undefined> {
  const db = await openWorkspaceDb(), tx = db.transaction('metadata', 'readonly'), done = txDone(tx)
  const value = await new Promise<TutorLedger | undefined>((resolve, reject) => {
    const r = tx.objectStore('metadata').get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error)
  })
  await done; return value
}
export async function writeTutorLedger(ledger: TutorLedger, valid: () => boolean): Promise<void> {
  const db = await openWorkspaceDb()
  if (!valid()) throw new Error('辅导上下文已改变')
  const tx = db.transaction('metadata', 'readwrite'), done = txDone(tx)
  tx.objectStore('metadata').put(structuredClone(ledger))
  await done
}
/** Same tab refresh keeps identity; native origin locks distinguish copied sessionStorage atomically. */
export async function tutorChannel(c: CommandContext): Promise<{ clientId: string; close: () => void }> {
  const key = `tutor:channel:${tutorScope(c)}`
  let clientId = sessionStorage.getItem(key) ?? crypto.randomUUID()
  if(!navigator.locks) return {clientId:crypto.randomUUID(),close:()=>{}}
  const reserve = (id:string) => new Promise<(() => void)|null>(resolve=> {
    void navigator.locks.request(`${key}:${id}`,{ifAvailable:true},async lock=> {
      if(!lock){resolve(null);return}
      await new Promise<void>(release=>{resolve(release)})
    }).catch(()=>resolve(null))
  })
  let release=await reserve(clientId)
  if(!release) {
    clientId=crypto.randomUUID();release=await reserve(clientId)
    // An unavailable lock capability is a new channel, never authority to reuse an old cursor.
    if(!release) return {clientId:crypto.randomUUID(),close:()=>{}}
  }
  sessionStorage.setItem(key, clientId)
  return { clientId, close: release }
}
