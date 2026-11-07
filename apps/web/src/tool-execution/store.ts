import { advanceExecution, type AnyExecutionAction, type ExecutionAcceptance, type ExecutionQuery } from '@xunjie/contracts/execution'
import { openWorkspaceDatabase } from '../reliable-workspace/draft-store'
import { recordKey, type ExecutionRecord } from './ledger'
import type { ExecutionRetainedResource } from '@xunjie/contracts/execution'

export interface PendingExecutionFact { scope: string; requestId: string; seq: number; query: ExecutionQuery; at: number }
export interface StopRecord { scope: string; stopId: string; requestId: string; inputDigest: string; reason: string
  state: 'requested' | 'confirmed'; at: number }
export interface ResultRecord { scope: string; executionRef: string; requestId: string; name: string; mediaType: string
  sha256: string; byteLength: number; text: string; output: unknown; at: number; resources?:ExecutionRetainedResource[] }
export interface SyncRecord { scope: string; requestId: string; command: boolean; factSeq: number; result: boolean; at: number; stopIds?:string[] }

const done = (tx: IDBTransaction, resolve: () => void, reject: (error: unknown) => void, failure: () => unknown) => {
  tx.oncomplete = () => resolve()
  tx.onabort = () => reject(failure() ?? tx.error ?? new Error('本机执行记录没有完成。'))
  tx.onerror = () => { /* onabort owns failure */ }
}

/**
 * The browser execution ledger. A command is only reported as accepted after its record and its
 * pending fact commit in the same transaction, so no accepted run can exist only in memory.
 */
export class ExecutionStore {
  async read(scope: string, requestId: string): Promise<ExecutionRecord | undefined> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('executionCommands', 'readonly')
      const request = tx.objectStore('executionCommands').get(recordKey(scope, requestId))
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => reject(tx.error)
      tx.onerror = () => { /* onabort owns failure */ }
    })
  }
  async list(scope: string): Promise<ExecutionRecord[]> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('executionCommands', 'readonly')
      const request = tx.objectStore('executionCommands').index('scope').getAll(scope)
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => reject(tx.error)
      tx.onerror = () => { /* onabort owns failure */ }
    })
  }
  /** Identical identity returns the original acceptance; different input under one request is refused. */
  async accept(scope: string, action: AnyExecutionAction, inputDigest: string, acceptance: ExecutionAcceptance,
    generation: number, canCommit: () => boolean = () => true): Promise<ExecutionRecord> {
    const db = await openWorkspaceDatabase()
    // The record is keyed by the same workspace scope every later read, list and result lookup uses.
    const key = recordKey(scope, action.requestId)
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['executionCommands', 'executionPending', 'executionStops'], 'readwrite')
      const store = tx.objectStore('executionCommands'), facts = tx.objectStore('executionPending')
      let result: ExecutionRecord, failure: unknown
      // A durable pre-accept block is read inside this transaction, so a late acceptance cannot revive it.
      const blocked = tx.objectStore('executionStops').index('scope').getAll(scope)
      blocked.onsuccess = () => {
        if ((blocked.result as StopRecord[]).some(stop => stop.requestId === action.requestId)) {
          failure = Object.assign(new Error('执行开始前已取消，不能再接收。'), { code: 'cancelled' })
          tx.abort(); return
        }
        const request = store.get(key)
        request.onsuccess = () => {
          const previous = request.result as ExecutionRecord | undefined
          if (previous) {
            if (previous.inputDigest !== inputDigest) { failure = Object.assign(new Error('同一执行身份不能改变输入。'), { code: 'identity-conflict' }); tx.abort(); return }
            result = previous; return
          }
          if (!canCommit()) {
            failure = Object.assign(new Error('候选输入已改变或反馈已暂停，未接收旧观察。'), { code: 'candidate-changed' })
            tx.abort(); return
          }
          const query: ExecutionQuery = { requestId: action.requestId, inputDigest, scope: action.scope,
            executionRef: acceptance.execution!.executionRef, state: 'queued', statusKnowledge: 'confirmed',
            stopRequested: false, confirmedSeq: acceptance.execution!.acceptedSeq, reason: null, output: null }
          result = { scope, requestId: action.requestId, inputDigest,
            executionRef: query.executionRef, action, acceptance, query, generation, startedAt: null, stoppedAt: null, createdAt: Date.now() }
          store.put({ ...result, key })
          facts.put({ scope: result.scope, requestId: result.requestId, seq: query.confirmedSeq, query, at: Date.now() })
        }
      }
      done(tx, () => resolve(result), reject, () => failure)
    })
  }
  /**
   * One executor owns a run from its first effect. The claim is written in the same transaction
   * that records `running`, so two pages cannot both start the same command, and a page that is
   * not the recorded executor can never claim it.
   */
  async claim(scope: string, requestId: string, generation: number, at: number): Promise<ExecutionRecord | null> {
    const db = await openWorkspaceDatabase()
    const key = recordKey(scope, requestId)
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['executionCommands', 'executionPending'], 'readwrite')
      const store = tx.objectStore('executionCommands'), facts = tx.objectStore('executionPending')
      const request = store.get(key)
      let result: ExecutionRecord | null, failure: unknown
      request.onsuccess = () => {
        const current = request.result as ExecutionRecord | undefined
        if (!current) { result = null; return }
        if (current.startedAt !== null || current.generation !== generation
          || ['succeeded', 'failed', 'cancelled'].includes(current.query.state) || current.query.stopRequested) {
          result = null; return
        }
        try {
          const merged = advanceExecution(current.query, { ...current.query, state: 'running',
            statusKnowledge: 'confirmed', confirmedSeq: current.query.confirmedSeq + 1, reason: null })
          result = { ...current, query: merged, startedAt: at }
          store.put({ ...result, key })
          facts.put({ scope, requestId, seq: merged.confirmedSeq, query: merged, at })
        } catch (error) { failure = error; tx.abort() }
      }
      done(tx, () => resolve(result ?? null), reject, () => failure)
    })
  }
  /**
   * A newer page takes over a command only when it provably never started. A started run keeps
   * its owner, so an old page can neither be replaced nor silently continued elsewhere.
   */
  async adopt(scope: string, requestId: string, generation: number): Promise<boolean> {
    const db = await openWorkspaceDatabase()
    const key = recordKey(scope, requestId)
    return new Promise((resolve, reject) => {
      const tx = db.transaction('executionCommands', 'readwrite')
      const store = tx.objectStore('executionCommands')
      const request = store.get(key)
      let adopted = false, failure: unknown
      request.onsuccess = () => {
        const current = request.result as ExecutionRecord | undefined
        try {
          if (!current || current.startedAt !== null || current.generation === generation) return
          store.put({ ...current, generation, key }); adopted = true
        } catch (error) { failure = error; tx.abort() }
      }
      done(tx, () => resolve(adopted), reject, () => failure)
    })
  }
  /**
   * Progress is merged, never recomputed from the caller's view, and a terminal fact stays
   * terminal. A fact from an executor that no longer owns the run is refused.
   */
  async record(scope: string, requestId: string, change: (current: ExecutionQuery) => ExecutionQuery,
    patch: Partial<Pick<ExecutionRecord, 'startedAt' | 'stoppedAt'>> = {}, owner?: number): Promise<ExecutionRecord> {
    const db = await openWorkspaceDatabase()
    const key = recordKey(scope, requestId)
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['executionCommands', 'executionPending'], 'readwrite')
      const store = tx.objectStore('executionCommands'), facts = tx.objectStore('executionPending')
      const request = store.get(key)
      let result: ExecutionRecord, failure: unknown
      request.onsuccess = () => {
        const current = request.result as ExecutionRecord | undefined
        if (!current) { failure = new Error('原执行记录不可读。'); tx.abort(); return }
        if (owner !== undefined && current.generation !== owner) {
          failure = Object.assign(new Error('原执行已由其他页面接管，本次结果不再写入。'), { code: 'stale-generation' })
          tx.abort(); return
        }
        try {
          const next = change(current.query)
          const merged = advanceExecution(current.query, next)
          result = { ...current, query: merged, ...patch }
          if (merged !== current.query) {
            store.put({ ...result, key })
            if (merged.confirmedSeq > current.query.confirmedSeq)
              facts.put({ scope, requestId, seq: merged.confirmedSeq, query: merged, at: Date.now() })
          } else if (patch.startedAt !== undefined || patch.stoppedAt !== undefined) store.put({ ...result, key })
        } catch (error) { failure = error; tx.abort() }
      }
      done(tx, () => resolve(result), reject, () => failure)
    })
  }
  async stop(record: StopRecord): Promise<void> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('executionStops', 'readwrite')
      tx.objectStore('executionStops').put(record)
      done(tx, () => resolve(), reject, () => undefined)
    })
  }
  async stops(scope: string): Promise<StopRecord[]> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('executionStops', 'readonly')
      const request = tx.objectStore('executionStops').index('scope').getAll(scope)
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => reject(tx.error)
      tx.onerror = () => { /* onabort owns failure */ }
    })
  }
  async result(value: ResultRecord): Promise<void> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('executionResults', 'readwrite')
      const store=tx.objectStore('executionResults'), request=store.get([value.scope,value.executionRef])
      request.onsuccess=()=>{
        const previous=request.result as ResultRecord|undefined
        if(previous && (previous.sha256!==value.sha256 || previous.text!==value.text || JSON.stringify(previous.resources)!==JSON.stringify(value.resources))) {tx.abort();return}
        if(!previous)store.put(value)
      }
      done(tx, () => resolve(), reject, () => undefined)
    })
  }
  async readResult(scope: string, executionRef: string): Promise<ResultRecord | undefined> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('executionResults', 'readonly')
      const request = tx.objectStore('executionResults').get([scope, executionRef])
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => reject(tx.error)
      tx.onerror = () => { /* onabort owns failure */ }
    })
  }
  async sync(value: SyncRecord): Promise<void> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('executionSync', 'readwrite')
      tx.objectStore('executionSync').put(value)
      done(tx, () => resolve(), reject, () => undefined)
    })
  }
  async synced(scope: string, requestId: string): Promise<SyncRecord | undefined> {
    const db = await openWorkspaceDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('executionSync', 'readonly')
      const request = tx.objectStore('executionSync').get([scope, requestId])
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => reject(tx.error)
      tx.onerror = () => { /* onabort owns failure */ }
    })
  }
}
