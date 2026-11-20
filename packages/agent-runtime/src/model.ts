import { StorageError } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { modelLearningInputSchema, modelSegmentInputSchema, settleModelToolsSchema,
  type ModelAttempt, type ModelToolResult } from '@xunjie/contracts/model-connections';
import type { LearningModelPort } from '@xunjie/model-gateway/service';
import type { AgentStore } from './store.js';
import type { GenerateInput, GeneratedResponse, ModelPort, Json } from './ports.js';
import { portableHistory } from './history.js';
import { AgentError, ContextCapacityError, ContextPressureError } from './errors.js';
import { measureAttemptCapacity } from './capacity.js';

const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(new AgentError('cancelled')); }, { once: true });
});
/** Stop waiting on an in-flight Gateway RPC as soon as the Turn signal aborts. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(new AgentError('cancelled')); }
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(new AgentError('cancelled')); signal.addEventListener('abort', onAbort, { once: true }); });
  void promise.catch(() => {});
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}
export interface ModelAdapterOptions { maxAttempts?: number | undefined; retryBackoffMs?: readonly number[] | undefined; pollMs?: number | undefined; }
const retryable = (code: string) => ['unavailable', 'rate-limited', 'timeout', 'model-transport', 'dispatch-unconfirmed', 'upstream-http'].includes(code);

/** A host serving one identity passes one port; a host serving many resolves per session (dependencies). */
export type ModelGatewaySource = LearningModelPort | ((identity: GenerateInput['identity'], sessionId: string) =>
  LearningModelPort | Promise<LearningModelPort>);
export const resolveGateway = async (source: ModelGatewaySource, identity: GenerateInput['identity'], sessionId: string): Promise<LearningModelPort> =>
  typeof source === 'function' ? source(identity, sessionId) : source;

/** One logical generate over the existing Gateway: segment boundary, Attempts, native pairing. No second loop. */
export function createModelAdapter(source: ModelGatewaySource, store: AgentStore, options: ModelAdapterOptions = {}): ModelPort {
  const maxAttempts = options.maxAttempts ?? 3;
  const backoff = options.retryBackoffMs ?? [1000, 2000];
  const pollMs = options.pollMs ?? 50;
  const segmentPorts = new Map<string, LearningModelPort>();
  const attemptPorts = new Map<string, LearningModelPort>();
  const single = (): LearningModelPort | undefined => typeof source === 'function' ? undefined : source;

  /** Settle a recovered native batch exactly once from persisted closed facts before reusing/abandoning it. */
  type Segment = NonNullable<Awaited<ReturnType<LearningModelPort['segments']['read']>>>;
  async function settleRecovered(gateway: LearningModelPort, input: GenerateInput,
    actual: Pick<Segment, 'segmentId' | 'sequence' | 'pendingTools'>): Promise<Segment> {
    const pending = (actual.pendingTools ?? []).map(item => item.callId);
    if (!pending.length) return actual as Segment;
    const results = await store.toolResultsByNative(input.sessionId, pending);
    const feedback = pending.map(callId => {
      const result = results.get(callId) ?? null;
      if (!result) return { callId, outcome: 'error' as const, text: '宿主重启，副作用结果未知', images: [] };
      if (result.kind === 'completed') return { callId, outcome: result.outcome === 'success' ? 'success' as const : 'error' as const, text: result.summary, images: result.images ?? [] };
      if (result.kind === 'accepted') return { callId, outcome: 'success' as const, text: result.summary, images: [] };
      return { callId, outcome: 'error' as const, text: result.reason, images: [] };
    });
    return await gateway.segments.settle(input.identity, actual.segmentId, settleModelToolsSchema.parse({
      requestId: operationId('agent-settle-recovered:' + actual.segmentId + ':' + actual.sequence),
      expectedSequence: actual.sequence, results: feedback }));
  }
  async function ensureSegment(input: GenerateInput, prefixDigest: string, gateway: LearningModelPort, round = 0): Promise<{
    segment: Awaited<ReturnType<LearningModelPort['segments']['create']>>; fresh: boolean }> {
    const runtime = await store.turnRuntime(input.turnId);
    if (!runtime) throw new AgentError('turn-runtime-missing');
    const state = await store.sessionState(input.sessionId);
    const saved = state.segment as { segmentId: string; sequence: number; closed?: boolean } | undefined;
    let actual: Segment | undefined = saved ? await gateway.segments.read(input.identity, saved.segmentId) : undefined;
    // A recovered segment may still owe one settlement per original native call, even when the new Turn
    // starts at a different prefix boundary. Settle before either reusing or closing it.
    if (actual && !actual.closed && actual.pendingTools?.length) actual = await settleRecovered(gateway, input, actual);
    if (actual && !actual.closed && state.prefixDigest === prefixDigest
      && (!input.historyProjection?.projectionId || actual.projectionId)) {
      // Backfill identity used by material deduplication when reopening a segment
      // created before these fields existed. The matching prefix proves the basis.
      if (state.segmentSystemDigest !== canonicalDigest(input.system)
        || state.segmentToolsDigest !== canonicalDigest(input.tools)
        || state.segmentConnectionId !== runtime?.model.connection.connectionId
        || state.segmentConnectionVersion !== runtime?.model.connection.version
        || state.segmentEpoch !== input.segmentEpoch) {
        await store.setSessionState(input.sessionId, { ...state,
          segmentSystemDigest: canonicalDigest(input.system), segmentToolsDigest: canonicalDigest(input.tools),
          segmentConnectionId: runtime.model.connection.connectionId,
          segmentConnectionVersion: runtime.model.connection.version, segmentEpoch: input.segmentEpoch }, input.turnId);
      }
      return { segment: actual, fresh: false };
    }
    // A pressure preflight can close a segment created by this same Step.
    // Include the predecessor so a replacement has its own creation receipt.
    const requestId = operationId('agent-segment:' + input.stepId + ':' + round + ':'
      + canonicalDigest({ prefixDigest, previousSegmentId: actual?.segmentId ?? null }));
    if (actual && !actual.closed) {
      await gateway.segments.close(input.identity, actual.segmentId, { requestId: operationId('agent-segment-close:' + requestId), expectedSequence: actual.sequence });
    }
    const segment = await gateway.segments.create(input.identity, modelSegmentInputSchema.parse({
      requestId, segmentId: operationId('agent-model-segment:' + requestId), sessionId: input.sessionId,
      source: { selected: true, selectionVersion: runtime.model.selectionVersion, pinId: runtime.model.pinId }, purpose: 'learning',
      prefix: { system: input.system, tools: input.tools }, portable: portableHistory(input.history),
      projectionId: input.historyProjection?.projectionId,
      ...(actual ? { previousSegmentId: actual.segmentId } : {}),
    }));
    const current = await store.sessionState(input.sessionId);
    await store.setSessionState(input.sessionId, { ...current,
      segment: { segmentId: segment.segmentId, sequence: segment.sequence, closed: false },
      nativeHistorySources: [],
      prefixDigest, segmentSystemDigest: canonicalDigest(input.system), segmentToolsDigest: canonicalDigest(input.tools),
      segmentConnectionId: runtime.model.connection.connectionId,
      segmentConnectionVersion: runtime.model.connection.version, segmentEpoch: input.segmentEpoch }, input.turnId);
    return { segment, fresh: true };
  }

  async function generate(input: GenerateInput): Promise<GeneratedResponse> {
    const gateway = await resolveGateway(source, input.identity, input.sessionId);
    // Images already authorized in visible history stay attached when a retry/segment boundary replaces the native payload.
    const seenImages = new Set<string>();
    const historyImages = input.history.flatMap(entry => entry.images ?? []);
    const images = [...input.images, ...historyImages].filter(image => {
      const key = image.imageId + ':' + image.version;
      if (seenImages.has(key)) return false; seenImages.add(key); return true;
    });
    const runtime = await store.turnRuntime(input.turnId);
    if (!runtime) throw new AgentError('turn-runtime-missing');
    const connection = runtime.model.connection;
    if (!connection.maxOutputTokens) throw new AgentError('max-output-missing');
    const prefixDigest = canonicalDigest({ system: input.system, tools: input.tools,
      route: connection.routeId, version: connection.version, segmentEpoch: input.segmentEpoch });
    let ensured = await ensureSegment(input, prefixDigest, gateway, 0);
    let segment = ensured.segment;
    segmentPorts.set(segment.segmentId, gateway);

    let lastError = 'model-failed';
    for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
      if (input.signal.aborted) throw new AgentError('cancelled');
      // Re-read the live ledger before every real dispatch; earlier Attempts may already have consumed it.
      const live = await store.budgetOf(input.turnId);
      const remainingInput = live.budget.maxInputTokens - live.usage.inputTokens;
      if (remainingInput < 1) throw new AgentError('input-budget-exhausted');
      const estimate = Math.ceil(Buffer.byteLength(JSON.stringify({ system: input.system, tools: input.tools,
        history: input.history, text: input.text, images: input.images }), 'utf8') / 3) + 4096;
      const attemptInputReserve = Math.max(1, Math.min(estimate, remainingInput));
      const attemptMaxOutput = Math.min(connection.maxOutputTokens, live.budget.maxOutputTokens - live.usage.outputTokens);
      if (attemptMaxOutput < 1) throw new AgentError('output-budget-exhausted');
      // A failed publish may close the old segment; every retry starts from a fresh legal boundary.
      // The first attempt already resolved the segment before entering this loop; re-resolving it
      // would lose the `fresh` flag that decides whether fixed material must be inlined again.
      if (attemptNo > 1) {
        ensured = await ensureSegment(input, prefixDigest, gateway, attemptNo);
        segment = ensured.segment;
        segmentPorts.set(segment.segmentId, gateway);
      }
      const attemptNoActual = (await store.attemptsOf(input.stepId)).length + 1;
      const attemptId = operationId('agent-attempt:' + input.stepId + ':' + attemptNoActual);
      attemptPorts.set(attemptId, gateway);
      await store.saveAttempt(input.stepId, { attemptId, attemptNo: attemptNoActual, requestRef: null,
        reserved: { inputTokens: attemptInputReserve, outputTokens: attemptMaxOutput } });
      const permit = { sessionId: input.sessionId, runId: input.turnId, stepId: input.stepId, operationId: attemptId, generation: 1 };
      const timeoutMs = Math.min(input.budget.maxCallMs, Math.max(250, Date.parse(input.budget.deadline) - Date.now()));
      const rebuilt = ensured.fresh || segment.sequence === 0;
      const text = rebuilt ? input.rebuildText ?? input.text : input.text;
      const historySources = rebuilt ? input.rebuildHistorySources ?? input.historySources : input.historySources;
      let fact: ModelAttempt;
      let measured: Awaited<ReturnType<typeof measureAttemptCapacity>> | undefined;
      try {
        fact = await raceAbort(gateway.checks.receive(input.identity, modelLearningInputSchema.parse({
          attemptId, purpose: 'learning', segmentId: segment.segmentId, expectedSequence: segment.sequence,
          input: { text,
            images, toolResults: input.toolResults, observations: [],
            ...(input.historyProjection ? { historyProjection: { ...input.historyProjection,
              baseProjectionId: segment.projectionId ?? null } } : {}) },
          limits: { maxOutputTokens: attemptMaxOutput, timeoutMs }, authority: { formatVersion: 1, permit },
        })), input.signal);
        if (fact.state === 'accepted') {
          const capacity = await raceAbort(measureAttemptCapacity(gateway, { ...input, text }, connection, attemptId,
            attemptMaxOutput, remainingInput), input.signal);
          measured = capacity;
          await store.recordRequestCapacity(input.stepId, attemptId, capacity, fact.requestRef, rebuilt);
          const notSmaller = input.smallerThanBytes !== undefined && capacity.bytes >= input.smallerThanBytes;
          if (!capacity.dispatchable || notSmaller) {
            const reason = notSmaller ? 'request-not-smaller' : capacity.reason;
            await gateway.checks.cancel(input.identity, attemptId);
            await store.finishAttempt(input.stepId, attemptId, { state: 'failed',
              usage: { state: 'final', inputTokens: 0, outputTokens: 0 },
              responseRef: null, error: reason });
            throw new ContextCapacityError(capacity.bytes, false, reason, capacity);
          }
          if (capacity.pressureState === 'compact' && input.allowPressureCompaction) {
            await gateway.checks.cancel(input.identity, attemptId);
            await store.finishAttempt(input.stepId, attemptId, { state: 'failed',
              usage: { state: 'final', inputTokens: 0, outputTokens: 0 },
              responseRef: null, error: 'context-pressure' });
            throw new ContextPressureError(capacity);
          }
          await input.verifyContext?.({ rebuilt });
          await input.adoptContext?.();
          // Persist the source bindings before dispatch, including requests whose reply is lost.
          if (historySources?.length || input.factsDigest) {
            const state = await store.sessionState(input.sessionId);
            const prior = (state.nativeHistorySources ?? []) as unknown as NonNullable<GenerateInput['historySources']>;
            const sources = [...new Map([...prior, ...(historySources ?? [])]
              .map(source => [canonicalDigest(source), source])).values()];
            await store.setSessionState(input.sessionId, { ...state,
              nativeHistorySources: JSON.parse(JSON.stringify(sources)),
              ...(input.factsDigest ? { nativeFactsDigest: input.factsDigest } : {}) }, input.turnId);
          }
          fact = await raceAbort(gateway.checks.dispatch(input.identity, attemptId, { formatVersion: 1, permit }), input.signal);
        }
        const deadline = Math.min(Date.parse(input.budget.deadline), Date.now() + timeoutMs);
        let progressRevision = 0;
        while (!fact.physicalRequestEnded && fact.state !== 'accepted' && fact.state !== 'unknown' && Date.now() < deadline) {
          if (input.signal.aborted) { await gateway.checks.cancel(input.identity, attemptId).catch(() => {}); throw new AgentError('cancelled'); }
          if (input.onProgress) {
            const progress = await raceAbort(gateway.checks.progress(input.identity, attemptId), input.signal);
            if (progress && progress.revision > progressRevision) {
              await input.onProgress({ attemptId, text: progress.text, revision: progress.revision, ...(progress.thinking ? { thinking: progress.thinking } : {}), ...(progress.tools ? { tools: progress.tools as unknown as Json[] } : {}) });
              progressRevision = progress.revision;
            }
          }
          await delay(pollMs, input.signal);
          fact = await raceAbort(gateway.checks.read(input.identity, attemptId), input.signal);
        }
      } catch (error) {
        if (error instanceof AgentError && (error.code === 'context-capacity-preflight' || error.code === 'context-pressure')) throw error;
        if (error instanceof AgentError && error.code === 'context-changed') {
          await gateway.checks.cancel(input.identity, attemptId);
          await store.finishAttempt(input.stepId, attemptId, { state: 'failed',
            usage: { state: 'final', inputTokens: 0, outputTokens: 0 }, responseRef: null, error: error.code });
          throw error;
        }
        if (input.signal.aborted || error instanceof AgentError && error.code === 'cancelled') {
          // Stop/deadline may land during receive, dispatch or a poll delay; cancel the real upstream exactly
          // through the same idempotent path, then settle the Attempt as interrupted.
          await gateway.checks.cancel(input.identity, attemptId).catch(() => {});
          await store.finishAttempt(input.stepId, attemptId, { state: 'interrupted', usage: { state: 'unknown' }, responseRef: null, error: 'cancelled' }).catch(() => {});
          throw new AgentError('cancelled');
        }
        await store.finishAttempt(input.stepId, attemptId, { state: 'failed', usage: { state: 'unknown' }, responseRef: null,
          error: error instanceof AgentError || error instanceof StorageError ? error.code : 'model-transport' });
        lastError = error instanceof StorageError ? error.code : error instanceof AgentError ? error.code : 'model-transport';
        if (attemptNo < maxAttempts && retryable(lastError)) { await delay(backoff[attemptNo - 1] ?? 2000, input.signal); continue; }
        throw new AgentError(lastError);
      }
      if (fact.state === 'unknown' || !fact.physicalRequestEnded) {
        await store.finishAttempt(input.stepId, attemptId, { state: 'failed', usage: fact.usage, responseRef: fact.resultRef, error: 'result-unknown' });
        throw new AgentError('result-unknown');
      }
      if (fact.state === 'completed') {
        await store.finishAttempt(input.stepId, attemptId, { state: 'completed', usage: fact.usage, responseRef: fact.resultRef, error: null });
        const current = await gateway.segments.read(input.identity, segment.segmentId);
        await store.setSessionState(input.sessionId, { ...(await store.sessionState(input.sessionId)), segment: { segmentId: current.segmentId, sequence: current.sequence, closed: current.closed } }, input.turnId);
        return { attemptId, requestRef: fact.requestRef, responseRef: fact.resultRef, text: fact.text,
          toolIntents: fact.toolIntents ?? [], usage: fact.usage, segmentId: segment.segmentId, segmentSequence: current.sequence, rebuilt,
          ...(connection.connectionId && fact.usage.inputTokens !== undefined ? { contextUsage: {
            model: { connectionId: connection.connectionId, version: connection.version }, tokens: fact.usage.inputTokens,
            lowerBound: fact.usage.state !== 'final',
          } } : {}) };
      }
      await store.finishAttempt(input.stepId, attemptId, { state: 'failed', usage: fact.usage, responseRef: fact.resultRef, error: fact.reason || fact.state });
      lastError = fact.reason || fact.state;
      if (lastError === 'context-capacity-exceeded') throw new ContextCapacityError(measured?.bytes ?? 0, true, lastError, measured);
      if (attemptNo < maxAttempts && retryable(lastError)) { await delay(backoff[attemptNo - 1] ?? 2000, input.signal); continue; }
      throw new AgentError('model-failed');
    }
    throw new AgentError(lastError);
  }
  function portFor(identity: GenerateInput['identity'], key: string, cache: Map<string, LearningModelPort>): LearningModelPort {
    const found = cache.get(key);
    if (found) { cache.delete(key); return found; }
    const one = single();
    if (!one) throw new AgentError('model-not-selected');
    return one;
  }
  async function settleTools(identity: GenerateInput['identity'], segmentId: string, expectedSequence: number, results: readonly ModelToolResult[]) {
    const gateway = portFor(identity, segmentId, segmentPorts);
    const segment = await gateway.segments.settle(identity, segmentId, settleModelToolsSchema.parse({
      requestId: operationId('agent-settle:' + segmentId + ':' + expectedSequence), expectedSequence, results }));
    return { segmentId: segment.segmentId, sequence: segment.sequence };
  }
  async function cancel(identity: GenerateInput['identity'], attemptId: string) {
    const gateway = portFor(identity, attemptId, attemptPorts);
    try { await gateway.checks.cancel(identity, attemptId); }
    catch (error) { if (!(error instanceof StorageError) || error.code !== 'missing') throw error; }
  }
  return { generate, settleTools, cancel };
}
