import { AlgorithmError, type AggregationOutcome } from './algorithm'
import type { AlgorithmJob, AlgorithmReply } from './worker'

/**
 * A real dedicated Worker per run: terminating it is the only confirmed stop there is, and a
 * timeout terminates instead of leaving a running algorithm behind a "stopped" label.
 */
export function runInWorker(job: AlgorithmJob, signal?: AbortSignal): Promise<AggregationOutcome> {
  let worker: Worker
  try { worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'xunjie-algorithm' }) }
  catch { return Promise.reject(new AlgorithmError('resource-unavailable', '当前浏览器无法启动隔离执行线程。')) }
  return new Promise<AggregationOutcome>((resolve, reject) => {
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // Terminating the dedicated worker is the confirmed stop; the thread cannot keep running.
      worker.terminate()
      action()
    }
    const onAbort = () => finish(() => reject(new AlgorithmError('worker-terminated', '执行线程已终止。')))
    const timer = setTimeout(() => finish(() => reject(new AlgorithmError('budget-exceeded',
      `计算超过 ${job.timeMs} ms，已终止本次执行线程。`))), job.timeMs)
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort)
    worker.onmessage = (event: MessageEvent<AlgorithmReply>) => {
      const reply = event.data
      finish(() => reply.ok ? resolve(reply.outcome) : reject(new AlgorithmError(reply.code, reply.detail)))
    }
    worker.onerror = () => finish(() => reject(new AlgorithmError('algorithm-error', '执行线程异常结束，本次执行未完成。')))
    worker.onmessageerror = () => finish(() => reject(new AlgorithmError('algorithm-error', '执行线程返回了无法读取的结果。')))
    worker.postMessage(job, [job.bytes])
  })
}

export interface SlotRelease { release(): void }

/**
 * A cross-tab admission slot. The budget is declared per browser origin, so the lock name is
 * origin-wide and two labels of the same product cannot each start their own maximum.
 * Without Web Locks the same maximum still holds inside this page; only cross-tab admission
 * is impossible, which is stated rather than silently ignored.
 */
export async function acquireSlot(max: number, waitMs: number): Promise<SlotRelease> {
  if (!navigator.locks) return pageSlot(max, waitMs)
  const deadline = Date.now() + waitMs
  for (;;) {
    for (let index = 0; index < max; index++) {
      const slot = await trySlot(`xunjie-execution-slot:${index}`)
      if (slot) return slot
    }
    if (Date.now() >= deadline) throw new AlgorithmError('budget-exceeded', '已达到本浏览器允许的并行计算数量，请稍后再运行。')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

const heldInPage = new Set<symbol>()
async function pageSlot(max: number, waitMs: number): Promise<SlotRelease> {
  const deadline = Date.now() + waitMs
  while (heldInPage.size >= max) {
    if (Date.now() >= deadline) throw new AlgorithmError('budget-exceeded', '已达到本浏览器允许的并行计算数量，请稍后再运行。')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const token = Symbol('execution-slot')
  heldInPage.add(token)
  return { release: () => { heldInPage.delete(token) } }
}
/**
 * A lock is held from the moment its callback starts until `release`, so admission must be
 * observed inside the callback; awaiting the request itself would wait for the slot to be freed.
 */
async function trySlot(name: string): Promise<SlotRelease | null> {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const admitted = new Promise<boolean>(resolve => {
    navigator.locks.request(name, { ifAvailable: true }, lock => {
      if (!lock) { resolve(false); return undefined }
      resolve(true)
      return held
    }).catch(() => resolve(false))
  })
  return (await admitted) ? { release } : null
}
