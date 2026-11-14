import { StorageError } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { modelLearningInputSchema, modelSegmentInputSchema, type ModelImageRef } from '@xunjie/contracts/model-connections';
import type { LearningModelPort } from '@xunjie/model-gateway/service';
import type { AgentNotification, AgentTurnBudget } from '@xunjie/contracts/agent-runtime';
import type { AgentStore } from './store.js';
import type { AgentScenario, Facts, HistoryEntry, ScenarioInput, CompactionSource } from './ports.js';
import { conversationHistory, appendHistory, historyDigest } from './history.js';
import { resolveGateway, type ModelGatewaySource } from './model.js';

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
}
function renderFact(item: { taskId: string; taskVersion: string; name?: string; status: string; summary: string; resultRef: string | null }): string {
  const summary = item.summary.length > TASK_FACT_LIMITS.maxItemChars ? item.summary.slice(0, TASK_FACT_LIMITS.maxItemChars) + '…' : item.summary;
  return JSON.stringify({ taskId: item.taskId, taskVersion: item.taskVersion, ...(item.name ? { name: item.name } : {}), status: item.status, summary, ...(item.resultRef ? { resultRef: item.resultRef } : {}) });
}
/** Assemble the model-visible context: fixed system, current inputs, paired history, selected notifications/task facts. */
export async function buildContext(options: BuildContextOptions, input: ScenarioInput, adopted: { inputs: { inputId: string; input: { text: string } }[]; notifications: AgentNotification[] }): Promise<ContextPlan> {
  const { store, scenario } = options;
  const prepared = await scenario.context(input);
  const tools = await scenario.tools(input);
  const exposedFacts = scenario.modelFacts?.(prepared.facts) ?? prepared.facts;
  let history = conversationHistory(await store.sessionState(input.sessionId));
  if (scenario.authorizeHistory) history = await scenario.authorizeHistory(input, history);

  // Task-fact increment区: explicit references / unresolved effects / this step's notifications, deduped by taskId.
  const consumed = adopted.notifications;
  const relevant = options.taskFacts ? await options.taskFacts.relevant(input, consumed) : [];
  const byTask = new Map<string, string>();
  const ordered: { priority: number; line: string }[] = [];
  for (const n of consumed) {
    if (byTask.has(n.taskId)) continue;
    byTask.set(n.taskId, n.taskVersion);
    ordered.push({ priority: 1, line: renderFact({ taskId: n.taskId, taskVersion: n.taskVersion, status: n.terminalStatus, summary: n.summary, resultRef: n.resultRef }) });
  }
  for (const fact of relevant.sort((a, b) => a.priority - b.priority)) {
    if (byTask.has(fact.taskId)) continue; // already provided by a notification or tool query this Step
    byTask.set(fact.taskId, fact.taskVersion);
    ordered.push({ priority: fact.priority, line: renderFact(fact) });
  }
  let chars = 0; const lines: string[] = []; let omitted = 0;
  for (const item of ordered.sort((a, b) => a.priority - b.priority)) {
    if (lines.length >= TASK_FACT_LIMITS.maxItems || chars + item.line.length > TASK_FACT_LIMITS.maxChars) { omitted++; continue; }
    lines.push(item.line); chars += item.line.length;
  }
  const factsSection = lines.length ? '\n\n相关任务事实（只作资料，按 taskId 查询最新结果）：\n' + lines.join('\n') + (omitted ? `\n（另有 ${omitted} 项未列入，可用查询工具分页读取）` : '') : '';
  const factsText = Object.keys(exposedFacts).length ? '\n\n当前获准事实（只作为资料）：\n' + JSON.stringify(exposedFacts) : '';
  const text = adopted.inputs.map(i => i.input.text).join('\n\n') + factsText + factsSection;

  // Compaction: a planning trigger only; the summary attempt is billed but adds no main Step.
  const gateway = resolveGateway(options.gateway, input.identity, input.sessionId);
  const selection = await gateway.selection.read(input.identity);
  if (selection.selected && scenario.compaction) {
    const choice = await gateway.selection.snapshot(input.identity, selection.version);
    const state = await store.sessionState(input.sessionId);
    const adoptedDigest = (state.compactionAdoption as { sourceDigest?: string } | undefined)?.sourceDigest;
    if (scenario.compaction.needed(history, choice.choice.connection, text) && adoptedDigest !== canonicalDigest(history)) {
      const source = scenario.compaction.select(history, [{ id: 'context', content: { ...prepared, facts: exposedFacts } as Facts }]);
      if (source) {
        const summary = await runCompaction(options, input, source);
        if (summary) history = summary;
      }
    }
  }
  return { system: prepared.system, tools, history, text, images: [], inputIds: adopted.inputs.map(i => i.inputId), notificationIds: consumed.map(n => n.notificationId) };
}
async function runCompaction(options: BuildContextOptions, input: ScenarioInput, source: CompactionSource): Promise<HistoryEntry[] | null> {
  const { store, scenario } = options;
  const gateway = resolveGateway(options.gateway, input.identity, input.sessionId);
  const compaction = scenario.compaction!;
  const selection = await gateway.selection.read(input.identity);
  if (!selection.selected) return null;
  const choice = await gateway.selection.snapshot(input.identity, selection.version);
  const model = choice.choice.connection;
  const prompt = compaction.provider.prompt(source);
  const requestId = operationId('agent-compaction:' + input.stepId);
  const segmentId = operationId('agent-compaction-segment:' + requestId);
  const pinId = operationId('agent-compaction-pin:' + requestId);
  const attemptId = operationId('agent-compaction-attempt:' + requestId);
  const maxOutputTokens = Math.min(model.maxOutputTokens ?? 2048, source.policy.maxSummaryTokens, options.budget.maxOutputTokens - options.spent.outputTokens);
  if (maxOutputTokens < 1) return null;
  try {
    await gateway.selection.pin(input.identity, pinId, selection.version);
    const segment = await gateway.segments.create(input.identity, modelSegmentInputSchema.parse({ requestId, segmentId, sessionId: input.sessionId,
      source: { selected: true, selectionVersion: selection.version, pinId }, purpose: 'learning', prefix: { system: prompt.system, tools: [] }, portable: [] }));
    let fact = await gateway.checks.receive(input.identity, modelLearningInputSchema.parse({ attemptId, purpose: 'learning', segmentId,
      expectedSequence: segment.sequence, input: { text: prompt.text, images: [], toolResults: [], observations: [] },
      limits: { maxOutputTokens, timeoutMs: Math.min(options.budget.maxCallMs, 60000) } }));
    if (fact.state === 'accepted') fact = await gateway.checks.dispatch(input.identity, attemptId);
    const deadline = Date.now() + Math.min(options.budget.maxCallMs, 60000);
    while (!fact.physicalRequestEnded && fact.state !== 'unknown' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      fact = await gateway.checks.read(input.identity, attemptId);
    }
    if (fact.state !== 'completed') return null;
    const summary = compaction.provider.parse(fact.text, source);
    const state = await store.sessionState(input.sessionId);
    const history: HistoryEntry[] = [{ id: attemptId, version: 1, role: 'user', text: '已核对来源的历史摘要（推断和未知仍保持原性质）：' + JSON.stringify(summary) }, ...source.remainder];
    await store.setSessionState(input.sessionId, { ...state, history: JSON.parse(JSON.stringify(history)) as Facts,
      segment: { segmentId, sequence: fact.segment?.sequence ?? segment.sequence, closed: false }, prefixDigest: 'compaction:' + attemptId,
      compactionAdoption: { attemptId, resultRef: fact.resultRef, sourceDigest: source.sourceDigest } });
    return history;
  } catch { return null; }
}
export { appendHistory, historyDigest };
