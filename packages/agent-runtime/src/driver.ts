import { StorageError } from '@xunjie/storage';
import { operationId } from '@xunjie/storage/identity';
import type { AgentRuntimeSession, AgentWait } from '@xunjie/contracts/agent-runtime';
import type { AgentPipeline, AgentOperationResult, AgentExecutionSnapshot, AgentStep } from './ports.js';
import type { RunStore } from './store.js';

export interface RunDriverOptions {
  pipeline: AgentPipeline;
  dispatchOpen(): boolean;
}
export interface AdvanceResult {
  pending?: boolean;
  /** Only the current fixed operation is eligible for this timed wake. */
  retryAfterMs?: number;
  /** A terminal run hands its queued successor back to the host execution strategy. */
  nextRunId?: string;
  /** Committed pending facts for host observation. Empty waits withdraw only this run's registrations. */
  waits?: { session: AgentRuntimeSession; runId: string; waits: AgentWait[] };
}

/** Advances fixed operations. Scheduling, course rules and model protocols are injected. */
export class RunDriver {
  private readonly store: RunStore;
  private readonly options: RunDriverOptions;
  private readonly active = new Map<string, Promise<AdvanceResult>>();
  constructor(store: RunStore, options: RunDriverOptions) { this.store = store; this.options = options; }
  advance(runId: string): Promise<AdvanceResult> {
    const current = this.active.get(runId);
    if (current) return current;
    const task = this.execute(runId).catch((error: unknown): AdvanceResult => {
      // Storage may fence writes before an admitted effect returns. Leave the saved
      // operation intact so maintenance resume reconciles its original owner.
      if (!this.options.dispatchOpen() && error instanceof StorageError
        && ['maintenance', 'stale-generation'].includes(error.code)) return {};
      throw error;
    }).then(async result => {
      const next = await this.store.successor(runId);
      return next ? { ...result, nextRunId: next } : result;
    }).finally(() => { this.active.delete(runId); });
    this.active.set(runId, task);
    return task;
  }
  private async execute(runId: string): Promise<AdvanceResult> {
    if (!this.options.dispatchOpen()) return {};
    const generation = await this.store.begin(runId);
    if (generation === null) return {};
    for (let turns = 0; turns < 128; turns++) {
      const snapshot = await this.store.snapshot(runId);
      if (snapshot.run.generation !== generation || snapshot.run.stopRequested
        || ['completed', 'failed', 'stopped'].includes(snapshot.run.state)) return {};
      if (snapshot.waits.some(wait => wait.state === 'pending')) return {};
      const unfinished = snapshot.steps.find(step => step.state !== 'completed');
      if (!unfinished) {
        if (!this.options.dispatchOpen() || snapshot.run.needsContinue || snapshot.run.state === 'paused') return {};
        if (!await this.store.allowPlan(runId, generation)) return {};
        const number = snapshot.steps.length + 1;
        const ids = { stepId: operationId('agent-step:' + runId + ':' + number),
          operationId: operationId('agent-operation:' + runId + ':' + number) };
        const decision = await this.options.pipeline.plan(snapshot, ids);
        if (decision.kind !== 'operation') {
          if (await this.store.decide(snapshot, generation, decision)) return {};
        } else await this.store.prepare(snapshot, generation, decision);
        continue;
      }
      let result: AgentOperationResult | null;
      if (unfinished.state !== 'prepared') {
        // A lost response is queried at its original owner. null never permits replay.
        result = await this.options.pipeline.reconcile(snapshot, unfinished);
        if (!result) {
          await this.store.settle(snapshot, unfinished, { state: 'unknown', value: { reason: 'original-result-unconfirmed' } },
            { state: snapshot.state, pause: 'result-unknown' });
          return {};
        }
      } else {
        if (!this.options.dispatchOpen() || snapshot.run.needsContinue || snapshot.run.state === 'paused') return {};
        const permit = await this.store.permit(runId, generation, unfinished.stepId);
        if (!permit) continue;
        const assertDispatch = async () => {
          if (!this.options.dispatchOpen()) throw new StorageError('maintenance');
          await this.store.assertDispatch(permit);
        };
        try {
          await assertDispatch();
          result = await this.options.pipeline.dispatch(snapshot, unfinished, permit, assertDispatch);
        } catch (error) {
          // The operation may have committed despite transport failure. Preserve its identity.
          const current = await this.store.snapshot(runId);
          if (current.run.stopRequested || current.run.generation !== generation) return {};
          result = await this.options.pipeline.reconcile(current, unfinished).catch(() => null);
          if (!result) {
            await this.store.settle(current, unfinished, { state: 'unknown', value: { reason: 'original-result-unconfirmed' } },
              { state: current.state, pause: 'result-unknown' });
            return {};
          }
        }
      }
      const applied = await this.options.pipeline.apply(snapshot, unfinished, result);
      await this.store.settle(snapshot, unfinished, result, applied);
      if (result.state === 'accepted' || result.state === 'unknown' || applied.wait || applied.pause) {
        return result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs };
      }
      if (result.state === 'not-dispatched') return { retryAfterMs: result.retryAfterMs ?? 1000 };
    }
    // Yield CPU without resetting this run's durable operation and dispatch budgets.
    return { pending: true };
  }
  async drain() { while (this.active.size) await Promise.allSettled([...this.active.values()]); }
}
