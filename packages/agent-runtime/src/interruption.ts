import type { AgentStore } from './store.js';
import type { AgentCancellationTimers, ToolEffectReference } from './ports.js';

/** The task owner enumerates and idempotently cancels tasks originated by a Turn. */
export interface TaskCancellationPort {
  listNonTerminal(sessionId: string, turnId: string): Promise<{ taskId: string }[]>;
  cancel(sessionId: string, taskId: string): Promise<void>;
  /** False includes a request still in flight with no owner record yet; keep the intent pending. */
  cancelCall?(sessionId: string, turnId: string, toolCallId: string, reference: ToolEffectReference): Promise<boolean>;
}
export interface CancellationRunner {
  deliverTurn(sessionId: string, turnId: string): Promise<void>;
  resumePending(): Promise<void>;
  drain(): Promise<void>;
  close(): void;
}
/** Durable cancel intent survives restart; delivery is retried idempotently and never resumes execution. */
export function createCancellationRunner(store: AgentStore, port: TaskCancellationPort | undefined, timers: AgentCancellationTimers): CancellationRunner {
  const active = new Map<string, Promise<void>>();
  const retries = new Map<string, { failures: number; timer?: { handle: unknown } }>();
  let closed = false;
  function clearTimer(turnId: string) { const r = retries.get(turnId); if (r?.timer) { timers.clearTimeout(r.timer.handle); delete r.timer; } }
  function scheduleRetry(turnId: string, deliver: () => Promise<void>) {
    if (closed) return;
    const retry = retries.get(turnId) ?? { failures: 0 };
    if (retry.timer) return;
    const timer = { handle: undefined as unknown };
    retry.timer = timer; retries.set(turnId, retry);
    const delayMs = Math.min(30_000, 1000 * 2 ** retry.failures);
    retry.failures = Math.min(retry.failures + 1, 5);
    timer.handle = timers.setTimeout(() => {
      if (retries.get(turnId) !== retry || retry.timer !== timer) return;
      delete retry.timer;
      if (!closed) void deliver().catch(() => {});
    }, delayMs);
  }
  function deliverTurn(sessionId: string, turnId: string): Promise<void> {
    const current = active.get(turnId);
    if (current) return current;
    if (!port || closed) return Promise.resolve();
    clearTimer(turnId);
    const task = (async () => {
      const tasks = await port.listNonTerminal(sessionId, turnId);
      const delivered: string[] = [];
      const errors: unknown[] = [];
      for (const task of tasks) {
        if (closed) return;
        try { await port.cancel(sessionId, task.taskId); delivered.push(task.taskId); }
        catch (error) { errors.push(error); }
      }
      const remaining = await port.listNonTerminal(sessionId, turnId).catch(() => tasks);
      await store.acknowledgeCancellation(turnId, delivered, remaining.length === 0 && errors.length === 0);
      if (errors.length) throw errors[0];
      if (remaining.length) scheduleRetry(turnId, () => deliverTurn(sessionId, turnId));
      else retries.delete(turnId);
    })().catch(error => { scheduleRetry(turnId, () => deliverTurn(sessionId, turnId)); throw error; })
      .finally(() => { active.delete(turnId); });
    active.set(turnId, task);
    return task;
  }
  function deliverCall(pending: Awaited<ReturnType<AgentStore['pendingCallCancellations']>>[number]): Promise<void> {
    const key = 'call:' + pending.requestId;
    const current = active.get(key);
    if (current) return current;
    if (!port?.cancelCall || closed) return Promise.resolve();
    clearTimer(key);
    const task = (async () => {
      const done = await port.cancelCall!(pending.sessionId, pending.turnId, pending.toolCallId, pending.reference);
      if (done) { await store.acknowledgeCallCancellation(pending.requestId); retries.delete(key); }
      else scheduleRetry(key, () => deliverCall(pending));
    })().catch(error => { scheduleRetry(key, () => deliverCall(pending)); throw error; })
      .finally(() => { active.delete(key); });
    active.set(key, task);
    return task;
  }
  async function resumePending() {
    if (!port || closed) return;
    for (const pending of await store.pendingCancellations()) await deliverTurn(pending.sessionId, pending.turnId).catch(() => {});
    if (port.cancelCall) for (const pending of await store.pendingCallCancellations()) await deliverCall(pending).catch(() => {});
  }
  async function drain() { while (active.size) await Promise.allSettled([...active.values()]); }
  function close() { closed = true; for (const turnId of retries.keys()) clearTimer(turnId); }
  return { deliverTurn, resumePending, drain, close };
}
