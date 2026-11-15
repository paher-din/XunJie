import { StorageError } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { modelLearningInputSchema, modelSegmentInputSchema, type ModelImageRef } from '@xunjie/contracts/model-connections';
import type { LearningModelPort } from '@xunjie/model-gateway/service';
import type { AgentNotification, AgentTurnBudget } from '@xunjie/contracts/agent-runtime';
import type { AgentStore } from './store.js';
import type { AgentScenario, Facts, HistoryEntry, ScenarioInput, CompactionSource } from './ports.js';
import { conversationHistory, appendHistory, historyDigest } from './history.js';
import { raceAbort, resolveGateway, type ModelGatewaySource } from './model.js';
import { AgentError } from './errors.js';

/** Latest task facts the scene/product can resolve for explicit references or unresolved effects. */
export interface TaskFactsPort {
  /** Deterministic selection by real association, never text similarity. */
  relevant(input: ScenarioInput, consumedNotifications: readonly AgentNotification[]): Promise<TaskFact[]>;
}
export interface TaskFact { taskId: string; taskVersion: string; name: string; status: string; summary: string; resultRef: string | null; priority: number; }
export const TASK_FACT_LIMITS = Object.freeze({ maxItems: 8, maxChars: 8192, maxItemChars: 512 });

export interface ContextPlan {
  system: string; tools: Awaited<ReturnType<AgentScenario['tools']>>;
  history: HistoryEntry[]; text: string; images: ModelImageRef[];
  inputIds: string[]; notificationIds: string[];
}
export interface BuildContextOptions {
  store: AgentStore; gateway: ModelGatewaySource; scenario: AgentScenario;
  taskFacts?: TaskFactsPort | undefined; budget: AgentTurnBudget;
  spent: { inputTokens: number; outputTokens: number; inputReserved: number; outputReserved: number };
  /** Stop/deadline abort the same signal; a compaction must never adopt after it fires. */
  signal: AbortSignal;
}
const cpLength = (value: string) => Array.from(value).length;
function renderFact(item: { taskId: string; taskVersion: string; name?: string; status: string; summary: string; resultRef: string | null }): string {
  const chars = Array.from(item.summary);
  const summary = chars.length > TASK_FACT_LIMITS.maxItemChars ? chars.slice(0, TASK_FACT_LIMITS.maxItemChars).join('') + '…' : item.summary;
  return JSON.stringify({ taskId: item.taskId, taskVersion: item.taskVersion, ...(item.name ? { name: item.name } : {}), status: item.status, summary, ...(item.resultRef ? { resultRef: item.resultRef } : {}) });
}
/** Assemble the model-visible context: fixed system, current inputs, paired history, selected notifications/task facts. */
export async function buildContext(options: BuildContextOptions, input: ScenarioInput, adopted: { inputs: { inputId: string; input: { text: string } }[]; notifications: AgentNotification[] }): Promise<ContextPlan> {
  const { store, scenario } = options;
  const prepared = await scenario.context(input);
  const tools = await scenario.tools(input);
  const exposedFacts = scenario.modelFacts?.(prepared.facts) ?? prepared.facts;
  const state = await store.sessionState(input.sessionId);
  let history = conversationHistory(state);
  // A real adopted input is a durable fact even when an earlier generate never completed: make it visible once.
  const exclude = [...history.map(item => item.id), ...adopted.inputs.map(item => item.inputId)];
  const visible = await store.visibleInputs(input.sessionId, exclude);
  if (visible.length) {
    history = [...history, ...visible.map(item => ({ id: item.id, version: 1, role: 'user' as const, text: item.text }))];
    // Persist the same history the model saw; otherwise a later completion overwrites it and the request disappears.
    await store.setSessionState(input.sessionId, { ...state, history: JSON.parse(JSON.stringify(history)) as Facts }, input.turnId);
  }
  if (scenario.authorizeHistory) history = await scenario.authorizeHistory(input, history);

  // Task-fact increment区: explicit references / unresolved effects / this step's notifications, deduped by taskId.
  const consumed = adopted.notifications;
  const relevant = options.taskFacts ? await options.taskFacts.relevant(input, consumed) : [];
  const byTask = new Map<string, string>();
  const lines: string[] = [];
  let chars = 0;
  // Every notification the kernel adopted is guaranteed to be visible; it was budgeted before adoption.
  // For one task only the latest admitted version is rendered, never the first/older one.
  const latest = new Map<string, AgentNotification>();
  for (const n of consumed) {
    const prior = latest.get(n.taskId);
    if (!prior || n.taskVersion.localeCompare(prior.taskVersion) > 0) latest.set(n.taskId, n);
  }
  for (const n of latest.values()) {
    byTask.set(n.taskId, n.taskVersion);
    const line = renderFact({ taskId: n.taskId, taskVersion: n.taskVersion, status: n.terminalStatus, summary: n.summary, resultRef: n.resultRef });
    lines.push(line); chars += cpLength(line);
  }
  // Additional referenced facts fill only the remaining fixed budget; overflow stays out and is reported.
  let omitted = 0;
  for (const fact of relevant.sort((a, b) => a.priority - b.priority)) {
    if (byTask.has(fact.taskId)) continue; // already provided by a notification or tool query this Step
    const line = renderFact(fact);
    if (lines.length >= TASK_FACT_LIMITS.maxItems || chars + cpLength(line) > TASK_FACT_LIMITS.maxChars) { omitted++; continue; }
    byTask.set(fact.taskId, fact.taskVersion);
    lines.push(line); chars += cpLength(line);
  }
  const factsSection = lines.length ? '\n\n相关任务事实（只作资料，按 taskId 查询最新结果）：\n' + lines.join('\n') + (omitted ? `\n（另有 ${omitted} 项未列入，可用查询工具分页读取）` : '') : '';
  const factsText = Object.keys(exposedFacts).length ? '\n\n当前获准事实（只作为资料）：\n' + JSON.stringify(exposedFacts) : '';
  const text = adopted.inputs.map(i => i.input.text).join('\n\n') + factsText + factsSection;

  // Compaction: a planning trigger only; the summary attempt is billed but adds no main Step.
  const gateway = resolveGateway(options.gateway, input.identity, input.sessionId);
  const selection = await gateway.selection.read(input.identity);
  const compaction = scenario.compactionFor ? await scenario.compactionFor(input) : scenario.compaction;
  if (selection.selected && compaction) {
    const choice = await gateway.selection.snapshot(input.identity, selection.version);
    const state = await store.sessionState(input.sessionId);
    const adoptedDigest = (state.compactionAdoption as { sourceDigest?: string } | undefined)?.sourceDigest;
    if (compaction.needed(history, choice.choice.connection, text) && adoptedDigest !== canonicalDigest(history)) {
      const source = compaction.select(history, [{ id: 'context', content: { ...prepared, facts: exposedFacts } as Facts }]);
      if (source) {
        const summary = await runCompaction(options, input, source, compaction);
        if (summary) history = summary;
      }
    }
  }
  return { system: prepared.system, tools, history, text, images: [], inputIds: adopted.inputs.map(i => i.inputId), notificationIds: consumed.map(n => n.notificationId) };
}
async function runCompaction(options: BuildContextOptions, input: ScenarioInput, source: CompactionSource,
  compaction: NonNullable<AgentScenario['compaction']>): Promise<HistoryEntry[] | null> {
  const { store } = options;
  const gateway = resolveGateway(options.gateway, input.identity, input.sessionId);
  const selection = await gateway.selection.read(input.identity);
  if (!selection.selected) return null;
  const choice = await gateway.selection.snapshot(input.identity, selection.version);
  const model = choice.choice.connection;
  const prompt = compaction.provider.prompt(source);
  // A durable per-Turn allowance: invalid summaries still consume a real call and its recorded Attempt.
  const used = await store.compactionCount(input.turnId);
  if (used >= compaction.maxPerTurn) return null;
  const live = await store.budgetOf(input.turnId);
  const inputReserve = model.contextWindow ?? live.budget.maxInputTokens;
  if (inputReserve > live.budget.maxInputTokens - live.usage.inputTokens) throw new AgentError('input-budget-exhausted');
  const maxOutputTokens = Math.min(model.maxOutputTokens ?? 2048, source.policy.maxSummaryTokens, live.budget.maxOutputTokens - live.usage.outputTokens);
  if (maxOutputTokens < 1) throw new AgentError('output-budget-exhausted');
  const timeoutMs = Math.min(live.budget.maxCallMs, Math.max(250, Date.parse(live.budget.deadline) - Date.now()), 60_000);
  const requestId = operationId('agent-compaction:' + input.stepId);
  const segmentId = operationId('agent-compaction-segment:' + requestId);
  const pinId = operationId('agent-compaction-pin:' + requestId);
  const attemptNo = 100 + used;
  const attemptId = operationId('agent-compaction-attempt:' + requestId + ':' + attemptNo);
  const permit = { sessionId: input.sessionId, runId: input.turnId, stepId: input.stepId, operationId: attemptId, generation: 1 };
  await store.saveAttempt(input.stepId, { attemptId, attemptNo, requestRef: null, reserved: { inputTokens: inputReserve, outputTokens: maxOutputTokens } });
  const cancelled = () => options.signal.aborted;
  const fail = async (error: string) => {
    await gateway.checks.cancel(input.identity, attemptId).catch(() => {});
    await store.finishAttempt(input.stepId, attemptId, { state: 'interrupted', usage: { state: 'unknown' }, responseRef: null, error }).catch(() => {});
    throw new AgentError('cancelled');
  };
  try {
    await gateway.selection.pin(input.identity, pinId, selection.version);
    const segment = await gateway.segments.create(input.identity, modelSegmentInputSchema.parse({ requestId, segmentId, sessionId: input.sessionId,
      source: { selected: true, selectionVersion: selection.version, pinId }, purpose: 'learning', prefix: { system: prompt.system, tools: [] }, portable: [] }));
    let fact = await raceAbort(gateway.checks.receive(input.identity, modelLearningInputSchema.parse({ attemptId, purpose: 'learning', segmentId,
      expectedSequence: segment.sequence, input: { text: prompt.text, images: [], toolResults: [], observations: [] },
      limits: { maxOutputTokens, timeoutMs }, authority: { formatVersion: 1, permit } })), options.signal);
    if (fact.state === 'accepted') fact = await raceAbort(gateway.checks.dispatch(input.identity, attemptId, { formatVersion: 1, permit }), options.signal);
    const deadline = Math.min(Date.parse(live.budget.deadline), Date.now() + timeoutMs);
    while (!fact.physicalRequestEnded && fact.state !== 'accepted' && fact.state !== 'unknown' && Date.now() < deadline) {
      if (cancelled()) await fail('cancelled');
      await new Promise(resolve => setTimeout(resolve, 50));
      fact = await raceAbort(gateway.checks.read(input.identity, attemptId), options.signal);
    }
    if (fact.state !== 'completed') {
      await store.finishAttempt(input.stepId, attemptId, { state: 'failed', usage: fact.usage, responseRef: fact.resultRef, error: fact.reason || fact.state });
      return null;
    }
    // Finished parsing failures still bill the real call; the original history stays untouched.
    let summary: Awaited<ReturnType<typeof compaction.provider.parse>>;
    try { summary = compaction.provider.parse(fact.text, source); }
    catch (error) {
      await store.finishAttempt(input.stepId, attemptId, { state: 'completed', usage: fact.usage, responseRef: fact.resultRef, error: error instanceof Error ? error.message.slice(0, 500) : 'invalid-summary' });
      return null;
    }
    await store.finishAttempt(input.stepId, attemptId, { state: 'completed', usage: fact.usage, responseRef: fact.resultRef, error: null });
    if (cancelled()) throw new AgentError('cancelled');
    const state = await store.sessionState(input.sessionId);
    // Adopt only if the visible history is still exactly the source the summary was produced from.
    if (historyDigest(conversationHistory(state)) !== historyDigest([...source.messages, ...source.remainder])) return null;
    const retainedImages = [...source.messages, ...source.remainder].flatMap(entry => entry.images ?? []);
    const history: HistoryEntry[] = [{ id: attemptId, version: 1, role: 'user',
      text: '已核对来源的历史摘要（推断和未知仍保持原性质）：' + JSON.stringify(summary),
      ...(retainedImages.length ? { images: retainedImages } : {}) }, ...source.remainder];
    await store.setSessionState(input.sessionId, { ...state, history: JSON.parse(JSON.stringify(history)) as Facts,
      segment: { segmentId, sequence: fact.segment?.sequence ?? 0, closed: false }, prefixDigest: 'compaction:' + attemptId,
      compactionAdoption: { attemptId, resultRef: fact.resultRef, sourceDigest: source.sourceDigest } }, input.turnId);
    await store.appendEvent(input.sessionId, 'context-compacted', { turnId: input.turnId, stepId: input.stepId, attemptId,
      resultRef: fact.resultRef, sourceDigest: source.sourceDigest,
      retainedIds: (source.sourceVersions as { retainedIds?: string[] }).retainedIds ?? [] });
    return history;
  } catch (error) {
    if (error instanceof AgentError && error.code === 'cancelled') throw error;
    if (error instanceof StorageError && ['maintenance', 'stale-generation', 'missing', 'conflict'].includes(error.code)) throw error;
    await store.finishAttempt(input.stepId, attemptId, { state: 'failed', usage: { state: 'unknown' }, responseRef: null, error: error instanceof Error ? error.message.slice(0, 500) : 'compaction-failed' }).catch(() => {});
    return null;
  }
}

export { appendHistory, historyDigest };
