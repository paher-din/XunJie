import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { canonicalDigest } from '@xunjie/storage/identity';
import { z } from 'zod';
import { agentInputControlSchema } from '@xunjie/contracts/agent-service';
import { agentDispatchPermitSchema, agentInputSchema, agentWaitResponseSchema, type AgentInput, type AgentRuntimePort, type AgentRuntimeSession,
  type AgentDispatchPermit, type AgentRun, type AgentWaitResponse } from '@xunjie/contracts/agent-runtime';
import { createRunStore } from './store.js';
import { RunDriver, type AdvanceResult } from './driver.js';
import type { AgentCancellationTimers, AgentInputControl, AgentModelProgress, AgentPipeline, AgentExecutionStrategy, AgentRunBudgetOptions, AgentWaitResolution } from './ports.js';
export { agentRuntimeMigrations } from './store.js';
export { agentRuntimeSourceOwner, collectAgentRuntimeSources, validateAgentRuntime, validateAgentRuntimeSources } from './source-closure.js';
export { RunDriver } from './driver.js';
export type { AdvanceResult } from './driver.js';
export type * from './ports.js';

export interface AgentRuntimeOptions {
  authorize(identity: AgentRuntimeSession['identity']): Promise<void>;
  pipeline?: AgentPipeline;
  runBudget?: AgentRunBudgetOptions;
  now?: () => number;
  cancellationTimers?: AgentCancellationTimers;
  /** Isolated inspection does not recover or write until the host explicitly resumes storage and this runtime. */
  readOnly?: boolean;
  execution?(advance: (runId: string) => Promise<import('./driver.js').AdvanceResult>): AgentExecutionStrategy;
}

const subject = ({ environmentId, spaceId, principalId, kind }: AgentRuntimeSession['identity']) =>
  canonicalDigest({ environmentId, spaceId, principalId, kind });
const waitResolutionSchema = agentWaitResponseSchema.omit({ answer: true }).extend({ result: z.record(z.string(), z.json()) }).strict();
const progressSchema = z.object({ revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  text: z.string().max(1_000_000), tools: z.array(z.json()).max(128).optional() }).strict()
  .refine(value => JSON.stringify(value).length <= 4_000_000);

/** The host injects identity authorization; the kernel never resolves a course or workspace. */
export function createAgentRuntime(storage: OwnedStorage, options: AgentRuntimeOptions) {
  const store = createRunStore(storage, options);
  let closed = false;
  let writesClosed = !!options.readOnly, dispatchClosed = !!options.readOnly;
  let bootRecovered = !options.readOnly;
  let ready = options.readOnly ? Promise.resolve([] as AgentRun[]) : store.recover();
  let closing: Promise<void> | undefined, resuming: Promise<void> | undefined;
  let maintenanceEpoch = 0;
  const admitted = new Set<string>();
  const dispatchOpen = () => !closed && !writesClosed && !dispatchClosed;
  const driver = options.pipeline ? new RunDriver(store, { pipeline: options.pipeline, dispatchOpen }) : undefined;
  const advance = async (runId: string): Promise<AdvanceResult> => {
    await ready;
    if (!dispatchOpen() || !driver) return {};
    admitted.add(runId);
    const result = await driver.advance(runId);
    const snapshot = await store.snapshot(runId);
    if (snapshot.run.needsContinue || ['completed', 'failed', 'stopped', 'paused'].includes(snapshot.run.state)
      || snapshot.waits.some(wait => wait.state === 'pending')) admitted.delete(runId);
    if (result.nextRunId) admitted.add(result.nextRunId);
    const terminal = snapshot.run.stopRequested || ['completed', 'failed', 'stopped'].includes(snapshot.run.state);
    return { ...result, waits: { session: snapshot.session, runId: snapshot.run.runId,
      waits: terminal ? [] : snapshot.waits.filter(wait => wait.state === 'pending') } };
  };
  let execution = options.readOnly ? undefined : options.execution?.(advance);
  const failures: unknown[] = [];
  const cancellationRuns = new Set<string>();
  const cancellationTasks = new Map<string, Promise<void>>();
  const cancellationRetries = new Map<string, { failures: number; timer?: { handle: unknown } }>();
  const cancellationTimers: AgentCancellationTimers = options.cancellationTimers ?? {
    setTimeout(callback, delayMs) { const timer = setTimeout(callback, delayMs); timer.unref(); return timer; },
    clearTimeout(timer) { clearTimeout(timer as ReturnType<typeof setTimeout>); },
  };
  function clearCancellationTimer(runId: string) {
    const retry = cancellationRetries.get(runId);
    if (retry?.timer) { cancellationTimers.clearTimeout(retry.timer.handle); delete retry.timer; }
  }
  function retryCancellation(runId: string) {
    if (!dispatchOpen()) return;
    const retry = cancellationRetries.get(runId) ?? { failures: 0 };
    if (retry.timer) return;
    const timer = { handle: undefined as unknown };
    retry.timer = timer;
    cancellationRetries.set(runId, retry);
    const delayMs = Math.min(30_000, 1000 * 2 ** retry.failures);
    retry.failures = Math.min(retry.failures + 1, 5);
    timer.handle = cancellationTimers.setTimeout(() => {
      if (cancellationRetries.get(runId) !== retry || retry.timer !== timer) return;
      delete retry.timer;
      if (dispatchOpen()) void cancelRun(runId).catch(() => {}); // The original delivery stays durable on failure.
    }, delayMs);
  }
  function cancelRun(runId: string): Promise<void> {
    cancellationRuns.add(runId);
    const current = cancellationTasks.get(runId);
    if (current) return current;
    const cancel = options.pipeline?.cancel?.bind(options.pipeline);
    if (!dispatchOpen() || !cancel) return Promise.resolve();
    clearCancellationTimer(runId);
    const task = (async () => {
      const pending = await store.pendingCancellations(runId);
      const errors: unknown[] = [];
      for (const cancellation of pending) {
        if (!dispatchOpen()) return;
        try {
          const snapshot = await store.snapshot(runId), step = snapshot.steps.find(step => step.stepId === cancellation.stepId);
          if (snapshot.run.state !== 'stopped' || !step) throw new StorageError('corrupt');
          if (!dispatchOpen()) return;
          await cancel(snapshot, step);
          if (!dispatchOpen()) return;
          await store.acknowledgeCancellation(cancellation);
        } catch (error) { errors.push(error); }
      }
      if (errors.length) throw errors[0];
      cancellationRuns.delete(runId);
      cancellationRetries.delete(runId);
    })().catch(error => { retryCancellation(runId); throw error; })
      .finally(() => { cancellationTasks.delete(runId); });
    cancellationTasks.set(runId, task);
    return task;
  }
  async function recoverCancellations() {
    // One boot inventory. Later retries and maintenance resume only visit these original runs.
    for (const cancellation of await store.pendingCancellations()) cancellationRuns.add(cancellation.runId);
    await Promise.allSettled([...cancellationRuns].map(cancelRun));
  }
  let cancellationsReady = options.readOnly ? Promise.resolve() : ready.then(recoverCancellations);
  void cancellationsReady.catch(error => { failures.push(error); });
  function wake(runId: string) {
    admitted.add(runId);
    if (execution && dispatchOpen()) void Promise.resolve(execution.wake(runId)).catch(error => { failures.push(error); });
  }
  function writable() { if (closed || writesClosed || closing) throw new StorageError('maintenance'); }
  function closeDispatch() {
    maintenanceEpoch += 1;
    dispatchClosed = true;
    execution?.closeDispatch();
    for (const runId of cancellationRetries.keys()) clearCancellationTimer(runId);
  }
  function closeWrites() { writesClosed = true; closeDispatch(); }
  async function drain() {
    await ready;
    const results = await Promise.allSettled([execution?.drain(), driver?.drain(), cancellationsReady]);
    while (cancellationTasks.size) await Promise.allSettled([...cancellationTasks.values()]);
    const errors: unknown[] = failures.splice(0);
    for (const result of results) if (result.status === 'rejected') {
      errors.push(...(result.reason instanceof AggregateError ? result.reason.errors : [result.reason]));
    }
    if (errors.length) throw new AggregateError([...new Set(errors)], 'Agent execution failed');
  }
  function resume(): Promise<void> {
    if (closed || closing) return Promise.reject(new StorageError('maintenance'));
    if (resuming) return resuming;
    if (!writesClosed && !dispatchClosed) return Promise.resolve();
    const epoch = maintenanceEpoch;
    resuming = (async () => {
      await drain();
      if (closed || closing || epoch !== maintenanceEpoch) throw new StorageError('maintenance');
      await execution?.close?.();
      // A read-only process deferred its one boot recovery. Maintenance of an existing
      // process never re-applies restartPolicy or scans the database for runnable work.
      const deferredRecovery = !bootRecovered;
      if (deferredRecovery) { ready = store.recover(); await ready; bootRecovered = true; }
      if (closed || closing || epoch !== maintenanceEpoch) throw new StorageError('maintenance');
      execution = options.execution?.(advance);
      writesClosed = false;
      dispatchClosed = false;
      if (deferredRecovery) { cancellationsReady = recoverCancellations(); await cancellationsReady; }
      else await Promise.allSettled([...cancellationRuns].map(cancelRun));
      if (closed || closing || epoch !== maintenanceEpoch) throw new StorageError('maintenance');
      for (const runId of [...admitted]) {
        const snapshot = await store.snapshot(runId);
        if (snapshot.run.needsContinue || ['completed', 'failed', 'stopped', 'paused'].includes(snapshot.run.state)
          || snapshot.waits.some(wait => wait.state === 'pending')) { admitted.delete(runId); continue; }
        wake(runId);
      }
    })().finally(() => { resuming = undefined; });
    return resuming;
  }
  async function authorized(identity: AgentRuntimeSession['identity'], sessionId: string) {
    await ready;
    if (closed) throw new StorageError('maintenance');
    await options.authorize(identity);
    const session = await store.session(sessionId);
    if (subject(session.identity) !== subject(identity)) throw new StorageError('forbidden');
    return session;
  }
  const runtime: AgentRuntimePort = {
    async initialize(session) {
      await ready;
      if (closed) throw new StorageError('maintenance');
      await options.authorize(session.identity);
      writable();
      return store.initialize(session);
    },
    async accept(identity, value: AgentInput) {
      const input = agentInputSchema.parse(value);
      await authorized(identity, input.sessionId);
      writable();
      const receipt = await store.accept(input);
      wake(receipt.runId);
      return receipt;
    },
    async run(identity, sessionId, runId) {
      await authorized(identity, sessionId);
      return store.run(sessionId, runId);
    },
    async events(identity, sessionId, after = 0) {
      await authorized(identity, sessionId);
      return store.events(sessionId, after);
    },
    async stop(identity, sessionId, runId, requestId) {
      await authorized(identity, sessionId);
      writable();
      const result = await store.control(sessionId, runId, 'stop', requestId);
      try {
        if (result.state === 'stopped') await cancelRun(runId);
      } finally { wake(runId); }
      return result;
    },
    async continueRun(identity, sessionId, runId, requestId) {
      await authorized(identity, sessionId);
      writable();
      const result = await store.control(sessionId, runId, 'continue', requestId);
      wake(runId);
      return result;
    },
  };
  return { ...runtime, advance,
    async recoverableRuns() {
      const candidates = await ready;
      if (closed) throw new StorageError('maintenance');
      return structuredClone(candidates);
    },
    async recordProgress(identity: AgentRuntimeSession['identity'], permit: AgentDispatchPermit, value: AgentModelProgress) {
      await authorized(identity, permit.sessionId);
      if (!dispatchOpen()) return false;
      return store.recordProgress(agentDispatchPermitSchema.parse(permit), progressSchema.parse(value));
    },
    async inputControl(identity: AgentRuntimeSession['identity'], sessionId: string, inputId: string, value: AgentInputControl) {
      await authorized(identity, sessionId);
      writable();
      // Fingerprints retain the same optional-field semantics as JSON transport.
      const control = JSON.parse(JSON.stringify(agentInputControlSchema.parse(value))) as AgentInputControl;
      const receipt = await store.inputControl(sessionId, z.uuid().parse(inputId), control);
      if (receipt.previousRunId) wake(receipt.previousRunId);
      wake(receipt.input.runId);
      return receipt;
    },
    async sessionSnapshot(identity: AgentRuntimeSession['identity'], sessionId: string) {
      await authorized(identity, sessionId);
      return store.sessionSnapshot(sessionId);
    },
    async request(identity: AgentRuntimeSession['identity'], sessionId: string, requestId: string) {
      await authorized(identity, sessionId);
      return store.request(sessionId, z.uuid().parse(requestId));
    },
    async assertDispatch(identity: AgentRuntimeSession['identity'], permit: AgentDispatchPermit) {
      await authorized(identity, permit.sessionId);
      if (!dispatchOpen()) throw new StorageError('maintenance');
      await store.assertDispatch(permit);
    },
    async snapshot(identity: AgentRuntimeSession['identity'], sessionId: string, runId: string) {
      await authorized(identity, sessionId);
      await store.run(sessionId, runId);
      return store.snapshot(runId);
    },
    async respond(identity: AgentRuntimeSession['identity'], sessionId: string, value: AgentWaitResponse) {
      await authorized(identity, sessionId);
      writable();
      const input = agentWaitResponseSchema.parse(value);
      const validate = options.pipeline?.validateResponse?.bind(options.pipeline)
        ?? (async () => { throw new StorageError('forbidden'); });
      const receipt = await store.respond(sessionId, input, validate);
      wake(receipt.runId);
      return receipt;
    },
    async resolveWait(identity: AgentRuntimeSession['identity'], sessionId: string, value: AgentWaitResolution) {
      await authorized(identity, sessionId);
      writable();
      const { result, ...input } = waitResolutionSchema.parse(value);
      const receipt = await store.resolveWait(sessionId, { ...input, answer: result });
      wake(receipt.runId);
      return receipt;
    },
    closeWrites, closeDispatch, drain, resume,
    close(): Promise<void> {
      if (closing) return closing;
      closeWrites();
      closing = (async () => {
        try { await drain(); await execution?.close?.(); }
        finally { closed = true; }
      })();
      return closing;
    },
  };
}
