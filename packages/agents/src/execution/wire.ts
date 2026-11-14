import type { AdvanceResult } from '@xunjie/agent-runtime';
import { AsyncWaits } from './async-waits.ts';
import type { TimerScheduler } from './async-waits.ts';
import { DirectRunner } from './direct-runner.ts';
import type { ExecutionStrategy } from './direct-runner.ts';

export interface DirectExecutionOptions {
  timers?: TimerScheduler;
  minDelayMs?: number;
  maxDelayMs?: number;
}

/** Inject as AgentRuntimeOptions.execution. No startup recovery or scan is performed.
 * Each wake replaces this run's prior retry; the runtime rechecks its original operation.
 */
export function createDirectExecution(
  advance: (runId: string) => Promise<AdvanceResult>,
  options: DirectExecutionOptions = {},
): ExecutionStrategy {
  let closed = false;
  const retries = new Map<string, () => void>();
  const clearRetry = (runId: string) => { retries.get(runId)?.(); retries.delete(runId); };
  const waits = new AsyncWaits({ ...options, wake: runId => wake(runId) });
  const runner = new DirectRunner({
    async advance(runId) {
      clearRetry(runId);
      const result = await advance(runId);
      if (!closed) {
        if (result.retryAfterMs !== undefined) {
          retries.set(runId, waits.register({ runId, waitId: 'run-retry:' + runId, delayMs: result.retryAfterMs }));
        }
        if (result.nextRunId && result.nextRunId !== runId) {
          // The runner retains failures for drain; each successor receives its own retry timer.
          void wake(result.nextRunId).catch(() => {});
        }
      }
      return result;
    },
  });
  function wake(runId: string): Promise<void> { clearRetry(runId); return runner.wake(runId); }
  return {
    wake,
    closeDispatch() {
      closed = true;
      waits.stop();
      retries.clear();
      runner.closeDispatch();
    },
    async drain() {
      const results = await Promise.allSettled([waits.drain(), runner.drain()]);
      const failures = results.flatMap(result => result.status === 'fulfilled' ? []
        : result.reason instanceof AggregateError ? result.reason.errors : [result.reason]);
      if (failures.length) throw new AggregateError([...new Set(failures)], 'Direct execution failed');
    },
  };
}
