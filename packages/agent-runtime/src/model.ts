import { StorageError } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { modelLearningInputSchema, modelSegmentInputSchema, settleModelToolsSchema,
  type ModelAttempt, type ModelToolResult } from '@xunjie/contracts/model-connections';
import type { LearningModelPort } from '@xunjie/model-gateway/service';
import type { AgentStore } from './store.js';
import type { GenerateInput, GeneratedResponse, ModelPort, Json } from './ports.js';
import { portableHistory } from './history.js';
import { AgentError } from './errors.js';

const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(new AgentError('cancelled')); }, { once: true });
});
export interface ModelAdapterOptions { maxAttempts?: number | undefined; retryBackoffMs?: readonly number[] | undefined; pollMs?: number | undefined; }
const retryable = (code: string) => ['unavailable', 'rate-limited', 'timeout', 'model-transport', 'dispatch-unconfirmed'].includes(code);

/** A host serving one identity passes one port; a host serving many resolves per session (dependencies). */
export type ModelGatewaySource = LearningModelPort | ((identity: GenerateInput['identity'], sessionId: string) => LearningModelPort);
export const resolveGateway = (source: ModelGatewaySource, identity: GenerateInput['identity'], sessionId: string): LearningModelPort =>
  typeof source === 'function' ? source(identity, sessionId) : source;

/** One logical generate over the existing Gateway: segment boundary, Attempts, native pairing. No second loop. */
export function createModelAdapter(source: ModelGatewaySource, store: AgentStore, options: ModelAdapterOptions = {}): ModelPort {
  const maxAttempts = options.maxAttempts ?? 3;
  const backoff = options.retryBackoffMs ?? [1000, 2000];
  const pollMs = options.pollMs ?? 50;
  const segmentPorts = new Map<string, LearningModelPort>();
  const attemptPorts = new Map<string, LearningModelPort>();
  const single = (): LearningModelPort | undefined => typeof source === 'function' ? undefined : source;

  async function ensureSegment(input: GenerateInput, prefixDigest: string, gateway: LearningModelPort) {
    const state = await store.sessionState(input.sessionId);
    const saved = state.segment as { segmentId: string; sequence: number; closed?: boolean } | undefined;
    const actual = saved ? await gateway.segments.read(input.identity, saved.segmentId) : undefined;
    if (actual && !actual.closed && state.prefixDigest === prefixDigest) return actual;
    const requestId = operationId('agent-segment:' + input.stepId + ':' + canonicalDigest({ prefixDigest, step: input.stepId }));
    if (actual && !actual.closed) {
      await gateway.segments.close(input.identity, actual.segmentId, { requestId: operationId('agent-segment-close:' + requestId), expectedSequence: actual.sequence });
    }
    const selection = await gateway.selection.read(input.identity);
    if (!selection.selected) throw new AgentError('model-not-selected');
    const pinId = operationId('agent-pin:' + requestId);
    await gateway.selection.pin(input.identity, pinId, selection.version);
    const segment = await gateway.segments.create(input.identity, modelSegmentInputSchema.parse({
      requestId, segmentId: operationId('agent-model-segment:' + requestId), sessionId: input.sessionId,
      source: { selected: true, selectionVersion: selection.version, pinId }, purpose: 'learning',
      prefix: { system: input.system, tools: input.tools }, portable: portableHistory(input.history),
      ...(actual ? { previousSegmentId: actual.segmentId } : {}),
    }));
    await store.setSessionState(input.sessionId, { ...state, segment: { segmentId: segment.segmentId, sequence: segment.sequence, closed: false }, prefixDigest });
    return segment;
  }

  async function generate(input: GenerateInput): Promise<GeneratedResponse> {
    const gateway = resolveGateway(source, input.identity, input.sessionId);
    const selection = await gateway.selection.read(input.identity);
    if (!selection.selected) throw new AgentError('model-not-selected');
    const choice = await gateway.selection.snapshot(input.identity, selection.version);
    const connection = choice.choice.connection;
    if (!connection.maxOutputTokens) throw new AgentError('max-output-missing');
    const prefixDigest = canonicalDigest({ system: input.system, tools: input.tools, route: connection.routeId, version: connection.version });
    const segment = await ensureSegment(input, prefixDigest, gateway);
    segmentPorts.set(segment.segmentId, gateway);
    const maxOutputTokens = Math.min(connection.maxOutputTokens, input.budget.maxOutputTokens - input.spent.outputTokens - input.spent.outputReserved);
    if (maxOutputTokens < 1) throw new AgentError('output-budget-exhausted');
    const inputReserve = connection.contextWindow ?? input.budget.maxInputTokens;
    if (inputReserve > input.budget.maxInputTokens - input.spent.inputTokens - input.spent.inputReserved) throw new AgentError('input-budget-exhausted');

    let lastError = 'model-failed';
    for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
      if (input.signal.aborted) throw new AgentError('cancelled');
      const attemptId = operationId('agent-attempt:' + input.stepId + ':' + attemptNo);
      attemptPorts.set(attemptId, gateway);
      await store.saveAttempt(input.stepId, { attemptId, attemptNo, requestRef: null, reserved: { inputTokens: inputReserve, outputTokens: maxOutputTokens } });
      const permit = { sessionId: input.sessionId, runId: input.turnId, stepId: input.stepId, operationId: attemptId, generation: 1 };
      const timeoutMs = Math.min(input.budget.maxCallMs, Math.max(250, Date.parse(input.budget.deadline) - Date.now()));
      let fact: ModelAttempt;
      try {
        fact = await gateway.checks.receive(input.identity, modelLearningInputSchema.parse({
          attemptId, purpose: 'learning', segmentId: segment.segmentId, expectedSequence: segment.sequence,
          input: { text: input.text, images: input.images, toolResults: input.toolResults, observations: [] },
          limits: { maxOutputTokens, timeoutMs }, authority: { formatVersion: 1, permit },
        }));
        if (fact.state === 'accepted') fact = await gateway.checks.dispatch(input.identity, attemptId, { formatVersion: 1, permit });
        const deadline = Math.min(Date.parse(input.budget.deadline), Date.now() + timeoutMs);
        let progressRevision = 0;
        while (!fact.physicalRequestEnded && fact.state !== 'accepted' && fact.state !== 'unknown' && Date.now() < deadline) {
          if (input.signal.aborted) { await gateway.checks.cancel(input.identity, attemptId).catch(() => {}); throw new AgentError('cancelled'); }
          if (input.onProgress) {
            const progress = await gateway.checks.progress(input.identity, attemptId);
            if (progress && progress.revision > progressRevision) {
              await input.onProgress({ attemptId, text: progress.text, revision: progress.revision, ...(progress.tools ? { tools: progress.tools as unknown as Json[] } : {}) });
              progressRevision = progress.revision;
            }
          }
          await delay(pollMs, input.signal);
          fact = await gateway.checks.read(input.identity, attemptId);
        }
      } catch (error) {
        if (input.signal.aborted || error instanceof AgentError && error.code === 'cancelled') {
          await store.finishAttempt(input.stepId, attemptId, { state: 'interrupted', usage: { state: 'unknown' }, responseRef: null, error: 'cancelled' });
          throw new AgentError('cancelled');
        }
        await store.finishAttempt(input.stepId, attemptId, { state: 'failed', usage: { state: 'unknown' }, responseRef: null, error: error instanceof Error ? error.message.slice(0, 500) : 'model-transport' });
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
        await store.setSessionState(input.sessionId, { ...(await store.sessionState(input.sessionId)), segment: { segmentId: current.segmentId, sequence: current.sequence, closed: current.closed } });
        return { attemptId, requestRef: fact.requestRef, responseRef: fact.resultRef, text: fact.text,
          toolIntents: fact.toolIntents ?? [], usage: fact.usage, segmentId: segment.segmentId, segmentSequence: current.sequence };
      }
      await store.finishAttempt(input.stepId, attemptId, { state: 'failed', usage: fact.usage, responseRef: fact.resultRef, error: fact.reason || fact.state });
      lastError = fact.reason || fact.state;
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
