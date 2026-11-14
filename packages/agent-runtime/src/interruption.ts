import type { AgentStore } from './store.js';
import type { AgentCancellationTimers } from './ports.js';

/** The task owner enumerates and idempotently cancels tasks originated by a Turn. */
export interface TaskCancellationPort {
  listNonTerminal(sessionId: string, turnId: string): Promise<{ taskId: string }[]>;
  cancel(sessionId: string, taskId: string): Promise<void>;
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
  function scheduleRetry(sessionId: string, turnId: string) {
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
      if (!closed) void deliverTurn(sessionId, turnId).catch(() => {});
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
      retries.delete(turnId);
    })().catch(error => { scheduleRetry(sessionId, turnId); throw error; })
      .finally(() => { active.delete(turnId); });
    active.set(turnId, task);
    return task;
  }
  async function resumePending() {
    if (!port || closed) return;
    for (const pending of await store.pendingCancellations()) await deliverTurn(pending.sessionId, pending.turnId).catch(() => {});
  }
  async function drain() { while (active.size) await Promise.allSettled([...active.values()]); }
  function close() { closed = true; for (const turnId of retries.keys()) clearTimer(turnId); }
  return { deliverTurn, resumePending, drain, close };
}
