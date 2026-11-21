import { StorageError } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { modelContextPressurePolicy, modelLearningInputSchema, modelSegmentInputSchema, type ModelImageRef } from '@xunjie/contracts/model-connections';
import type { LearningModelPort } from '@xunjie/model-gateway/service';
import type { AgentNotification, AgentToolCall, AgentTurnBudget } from '@xunjie/contracts/agent-runtime';
import type { AgentStore } from './store.js';
import type { AgentScenario, ContextMaterial, Facts, HistoryEntry, HistorySource, RuleVersion,
  ScenarioInput, CompactionSource, HistoryProjection, HistoryProjectionReplacement, RequestCapacity } from './ports.js';
import { conversationHistory, appendHistory, historyDigest } from './history.js';
import { raceAbort, resolveGateway, type ModelGatewaySource } from './model.js';
import { AgentError } from './errors.js';
import { measureAttemptCapacity } from './capacity.js';
import { citationToolDefinition } from './citations.js';
import { readbackForSource, stepReadbackScope, type ReadbackPlan, type ReadbackScope } from './readback.js';

/** Latest task facts the scene/product can resolve for explicit references or unresolved effects. */
export interface TaskFactsPort {
  /** Deterministic selection by real association, never text similarity. */
  relevant(input: ScenarioInput, consumedNotifications: readonly AgentNotification[]): Promise<TaskFact[]>;
}
export interface TaskFact { taskId: string; taskVersion: string; name: string; status: string; summary: string; resultRef: string | null; priority: number; }
export const TASK_FACT_LIMITS = Object.freeze({ maxItems: 8, maxChars: 8192, maxItemChars: 512 });
export const TOOL_FEEDBACK_POLICY = Object.freeze({
  recentCompletedSteps: 4,
  candidateBytes: 8 * 1024,
  summaryChars: 1200,
  recentFeedbackBudgetBytes: 24 * 1024,
});

export interface ContextPlan {
  system: string; tools: Awaited<ReturnType<AgentScenario['tools']>>;
  history: HistoryEntry[]; text: string; images: ModelImageRef[];
  rebuildText: string; rebuildMaterials: ContextMaterial[];
  inputIds: string[]; notificationIds: string[];
  materials: ContextMaterial[]; ruleVersions: RuleVersion[];
  factsDigest: string;
  segmentEpoch: number; historyRebuilt: boolean; compacted: boolean;
  historyProjection: HistoryProjection;
  adoptCompaction?: () => Promise<void>;
}
export interface BuildContextOptions {
  store: AgentStore; gateway: ModelGatewaySource; scenario: AgentScenario;
  taskFacts?: TaskFactsPort | undefined; budget: AgentTurnBudget;
  spent: { inputTokens: number; outputTokens: number; inputReserved: number; outputReserved: number };
  compactionBasis?: RequestCapacity;
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
  const runtime = await store.turnRuntime(input.turnId);
  const versions = prepared.ruleVersions?.length ? prepared.ruleVersions
    : [{ kind: 'scene' as const, id: scenario.id, version: scenario.version }];
  const rules = runtime?.rules ?? (runtime ? await store.saveTurnRules(input.turnId, { formatVersion: 1, system: prepared.system,
    digest: canonicalDigest({ system: prepared.system, versions }), versions: [...versions] })
    : { formatVersion: 1 as const, system: prepared.system, digest: canonicalDigest({ system: prepared.system, versions }),
      versions: [...versions] });
  const system = rules.system;
  const exposedFacts = scenario.modelFacts?.(prepared.facts) ?? prepared.facts;
  let state = await store.sessionState(input.sessionId);
  let history = conversationHistory(state);
  const recentToolSteps = new Set((await store.recentCompletedSteps(input.sessionId, TOOL_FEEDBACK_POLICY.recentCompletedSteps))
    .map(step => step.stepId));
  // A real adopted input is a durable fact even when an earlier generate never completed: make it visible once.
  const compactedEntries = Array.isArray(state.compactedEntries) ? state.compactedEntries.map(String) : [];
  const exclude = [...history.map(item => item.id), ...compactedEntries, ...adopted.inputs.map(item => item.inputId)];
  const visible = await store.visibleInputs(input.sessionId, exclude);
  if (visible.length) {
    history = [...history, ...visible.map(item => ({ id: item.id, version: item.version, role: 'user' as const, text: item.text }))];
    // Persist the same history the model saw; otherwise a later completion overwrites it and the request disappears.
    await store.setSessionState(input.sessionId, { ...state, history: JSON.parse(JSON.stringify(history)) as Facts }, input.turnId);
  }
  const beforeAuthorization = historyDigest(history);
  const recordedSources = Array.isArray(state.nativeHistorySources)
    ? state.nativeHistorySources as unknown as NonNullable<HistoryEntry['sources']> : [];
  const nativeReceipts = recordedSources.map((source, index): HistoryEntry => ({
    id: 'native-source:' + index, role: 'user', version: 1, text: '', sources: [source],
  }));
  let rejectedNative = false;
  if (scenario.authorizeHistory) {
    const authorized = await scenario.authorizeHistory(input, [...history, ...nativeReceipts]);
    const receiptIds = new Set(nativeReceipts.map(entry => entry.id));
    const allowed = new Set(authorized.map(entry => entry.id));
    rejectedNative = nativeReceipts.some(entry => !allowed.has(entry.id));
    history = authorized.filter(entry => !receiptIds.has(entry.id));
  }
  const afterAuthorizationDigest = historyDigest(history);
  const rawHistoryDigest = beforeAuthorization;
  const persisted = await store.sessionState(input.sessionId);
  const priorFeedbackDigest = typeof persisted.feedbackDigest === 'string' ? persisted.feedbackDigest : null;
  const priorCompressedKeys = Array.isArray(persisted.feedbackCompressedEntries)
    ? persisted.feedbackCompressedEntries.map(String) : [];
  const projected = projectToolFeedback(history, {
    recentStepIds: recentToolSteps,
    readbackScope: stepReadbackScope(tools.map(tool => tool.definition), rules.versions),
    currentStepId: input.stepId,
  });
  history = projected.history;
  const feedbackChanged = priorFeedbackDigest !== projected.feedbackDigest;
  const feedbackRemoved = priorCompressedKeys.some(key => !projected.compressedKeys.includes(key))
    || (priorFeedbackDigest !== null && !priorCompressedKeys.length && feedbackChanged);
  const feedbackCannotApply = feedbackChanged && (projected.missingNative > 0 || feedbackRemoved);
  const authorizedIds = new Set(history.map(entry => entry.id));
  const deniedEntries = conversationHistory(state).filter(entry => !authorizedIds.has(entry.id))
    .map(entry => entry.id).sort();
  const authorizationDigest = deniedEntries.length ? canonicalDigest(deniedEntries) : null;
  const historyRebuilt = rejectedNative || (state.authorizationDigest ?? null) !== authorizationDigest
    || beforeAuthorization !== afterAuthorizationDigest && !deniedEntries.length
    || feedbackCannotApply;
  let segmentEpoch = typeof persisted.segmentEpoch === 'number' ? persisted.segmentEpoch : 0;
  if (historyRebuilt || feedbackChanged) {
    state = await store.sessionState(input.sessionId);
    segmentEpoch = typeof state.segmentEpoch === 'number' ? state.segmentEpoch : 0;
    if (historyRebuilt) segmentEpoch += 1;
    await store.setSessionState(input.sessionId, { ...state,
      ...(historyRebuilt ? { segmentEpoch, authorizationDigest, nativeHistorySources: [] } : {}),
      feedbackDigest: projected.feedbackDigest,
      feedbackCompressedEntries: projected.compressedKeys }, input.turnId);
  }

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
  const factsDigest = canonicalDigest(exposedFacts);
  const factsText = Object.keys(exposedFacts).length || typeof persisted.nativeFactsDigest === 'string'
    ? '\n\n当前获准事实（只作为资料）：\n' + JSON.stringify(exposedFacts) : '';
  const authorizedEntries = new Set(history.map(entry => entry.id));
  const toolMaterials = (await store.toolCallsForTurn(input.turnId))
    .filter(call => authorizedEntries.has(call.toolCallId)).flatMap(toolMaterial)
    .map(material => ({ ...material, content: null, readState: 'reference-only' as const, visibleInHistory: true }));
  const allMaterials = [...(prepared.materials ?? []), ...toolMaterials];
  const inlineRendered = renderMaterials(allMaterials);
  const reuseNativeHistory = !historyRebuilt && !!state.segment && !!runtime
    && state.segmentSystemDigest === canonicalDigest(system)
    && state.segmentToolsDigest === canonicalDigest([...tools.map(tool => tool.definition), citationToolDefinition])
    && state.segmentConnectionId === runtime.model.connection.connectionId
    && state.segmentConnectionVersion === runtime.model.connection.version
    && (typeof state.segmentEpoch === 'number' ? state.segmentEpoch : 0) === segmentEpoch;
  const visibleSourceIds = new Set(reuseNativeHistory
    ? recordedSources.flatMap(source => source.inlineDigest ? [source.sourceId + ':' + source.inlineDigest] : []) : []);
  const assemble = (rendered: ReturnType<typeof renderMaterials>, rebuilding: boolean) => {
    const byInput = new Map(adopted.inputs.map(item => [item.inputId, [] as string[]]));
    const ungrouped: string[] = [];
    for (const { inputId, text } of rendered.lines) (byInput.get(inputId ?? '') ?? ungrouped).push(text);
    const section = (items: string[]) => items.length
      ? '\n\n本步材料（学生引用不等于学生认同；系统观察不是学生原话）：\n' + items.join('\n\n') : '';
    return (rebuilding ? factsText : '') + adopted.inputs.map(item =>
      item.input.text + section(byInput.get(item.inputId)!)).join('\n\n')
      + section(ungrouped) + (rebuilding || persisted.nativeFactsDigest === factsDigest ? '' : factsText) + factsSection;
  };
  let rendered = visibleSourceIds.size ? renderMaterials(allMaterials, visibleSourceIds) : inlineRendered;

  const compaction = options.compactionBasis && (scenario.compactionFor ? await scenario.compactionFor(input) : scenario.compaction);
  let compacted = false;
  let adoptCompaction: ContextPlan['adoptCompaction'];
  if (runtime && compaction && options.compactionBasis) {
    const { contextWindow, outputReserveTokens, safetyMarginTokens, bytes } = options.compactionBasis;
    const availableInputTokens = (contextWindow ?? 0) - outputReserveTokens - safetyMarginTokens;
    const source = compaction.select(history, [{ id: 'context',
      content: { ...prepared, facts: exposedFacts } as unknown as Facts }],
      availableInputTokens > 0 ? { targetInputBytes: Math.floor(availableInputTokens * modelContextPressurePolicy.target * 3),
        currentInputBytes: bytes } : undefined);
    if (source) {
      const beforeBytes = Buffer.byteLength(JSON.stringify(history), 'utf8');
      const summary = await runCompaction(options, input, source, compaction, segmentEpoch + 1, rawHistoryDigest);
      if (summary && Buffer.byteLength(JSON.stringify(summary.history), 'utf8') < beforeBytes) {
        history = summary.history;
        adoptCompaction = summary.adopt;
        compacted = true;
        segmentEpoch += 1;
      }
    }
  }
  if (compacted) rendered = inlineRendered;
  return { system, tools, history, text: assemble(rendered, false), rebuildText: assemble(inlineRendered, true),
    rebuildMaterials: inlineRendered.materials, images: [], inputIds: adopted.inputs.map(i => i.inputId),
    notificationIds: consumed.map(n => n.notificationId), materials: rendered.materials,
    ruleVersions: rules.versions, factsDigest, segmentEpoch, historyRebuilt, compacted,
    historyProjection: projectionOf(history),
    ...(adoptCompaction ? { adoptCompaction } : {}) };
}

interface ToolFeedbackProjection {
  history: HistoryEntry[];
  feedbackDigest: string | null;
  projectionId: string;
  replacements: HistoryProjectionReplacement[];
  compressedKeys: string[];
  missingNative: number;
}
export interface ToolFeedbackProjectionOptions {
  /** Completed Step ids in the initial retention window (newest first is not required). */
  recentStepIds: ReadonlySet<string>;
  readbackScope: ReadbackScope;
  currentStepId: string;
}
interface ParsedToolFeedback {
  tool: string; kind: string; outcome: string; body: string; taskId: string; requestRef: string;
}
interface FeedbackItem { index: number; entry: HistoryEntry; bytes: number; parsed: ParsedToolFeedback | null; }
const truncateChars = (value: string, max: number) => {
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : value;
};
function readbackOf(entry: HistoryEntry, scope: ReadbackScope): (ReadbackPlan & { sourceId: string; label: string })[] {
  const source = entry.sources?.find(source => source?.sourceId === 'tool:' + entry.id);
  if (!source || typeof source.label !== 'string' || !source.label.trim()) return [];
  return readbackForSource(source.source, scope, source.range).map(plan => ({
    sourceId: source.sourceId, label: truncateChars(source.label, 160), ...plan,
  }));
}
function parseToolFeedback(entry: HistoryEntry): ParsedToolFeedback | null {
  try {
    const feedback: unknown = JSON.parse(entry.text);
    if (!feedback || typeof feedback !== 'object' || Array.isArray(feedback)) return null;
    const text = (key: string) => {
      const value = (feedback as Record<string, unknown>)[key];
      return typeof value === 'string' ? value : '';
    };
    const body = text('summary') || text('reason');
    const outcome = text('outcome');
    return { tool: text('tool'), kind: text('kind'), outcome, body, taskId: text('taskId'), requestRef: text('requestRef') };
  } catch {
    return null;
  }
}
function shortToolFeedback(item: FeedbackItem, options: ToolFeedbackProjectionOptions): HistoryEntry | null {
  const { entry, parsed } = item;
  // Native pending batches are settled separately before dispatch. Failed and unknown
  // results, student messages and the current Step remain outside this rewrite.
  if (entry.feedbackCompressed || entry.stepId === options.currentStepId
    || parsed?.kind !== 'completed' || parsed.outcome !== 'success' || !parsed.body.trim()) return null;
  const readback = readbackOf(entry, options.readbackScope);
  if (!readback.length) return null;
  const short = JSON.stringify({
    tool: parsed.tool,
    kind: parsed.kind,
    outcome: parsed.outcome,
    summary: truncateChars(parsed.body.trim(), TOOL_FEEDBACK_POLICY.summaryChars),
    ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
    ...(parsed.requestRef ? { requestRef: parsed.requestRef } : {}),
    readback,
    note: '早期工具反馈已压缩；需要完整细节时按 readWith 重新读取原版本。',
  });
  if (Buffer.byteLength(short, 'utf8') >= item.bytes) return null;
  return { ...entry, text: short, feedbackCompressed: true };
}
function projectionOf(history: readonly HistoryEntry[]): HistoryProjection {
  const compacted = history.filter(entry => entry.feedbackCompressed)
    .map(({ id, version, text }) => ({ id, version, text }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
  return { projectionId: canonicalDigest({ formatVersion: 1, compacted }),
    replacements: history.flatMap(entry => entry.feedbackCompressed
      ? [{ entryId: entry.id, ...(entry.attemptId ? { attemptId: entry.attemptId } : {}),
        ...(entry.nativeCallId ? { callId: entry.nativeCallId } : {}), text: entry.text }] : []) };
}
/**
 * Keep recent tool interaction intact within a hard cumulative budget. Inside the recent
 * window, oldest compressible feedback is shortened only when the window exceeds the
 * budget. Outside the window, only individual text results above 8 KiB with a real
 * readWith are shortened. The persisted history is never changed: only this Step's
 * model-visible projection is reduced.
 */
export function projectToolFeedback(history: readonly HistoryEntry[], options: ToolFeedbackProjectionOptions): ToolFeedbackProjection {
  const items: FeedbackItem[] = history.flatMap((entry, index) => {
    if (entry.kind !== 'tool-result' || entry.images?.length) return [];
    const parsed = parseToolFeedback(entry);
    return [{ index, entry, parsed, bytes: Buffer.byteLength(parsed?.body ?? entry.text, 'utf8') }];
  });
  const compressed = new Map<number, HistoryEntry>();
  const recent = items.filter(item => item.entry.stepId && options.recentStepIds.has(item.entry.stepId));
  let recentBytes = recent.reduce((total, item) => total + item.bytes, 0);
  if (recentBytes > TOOL_FEEDBACK_POLICY.recentFeedbackBudgetBytes) {
    // Oldest first, even inside the initial retention window. An unreadable or protected
    // result contributes to the budget but cannot be deleted or rewritten to satisfy it.
    for (const item of recent) {
      if (recentBytes <= TOOL_FEEDBACK_POLICY.recentFeedbackBudgetBytes) break;
      const short = shortToolFeedback(item, options);
      if (!short) continue;
      compressed.set(item.index, short);
      recentBytes -= item.bytes - Buffer.byteLength(short.text, 'utf8');
    }
  }
  for (const item of items) {
    if (item.entry.stepId && options.recentStepIds.has(item.entry.stepId)) continue;
    if (item.bytes <= TOOL_FEEDBACK_POLICY.candidateBytes) continue;
    const short = shortToolFeedback(item, options);
    if (short) compressed.set(item.index, short);
  }
  const projected = history.map((entry, index) => compressed.get(index) ?? entry);
  const compressedKeys = projected.filter(entry => entry.feedbackCompressed)
    .map(entry => entry.id + '@' + entry.version);
  const missingNative = projected.filter(entry => entry.feedbackCompressed && !entry.nativeCallId && !entry.stepId).length;
  const projection = projectionOf(projected);
  return { history: projected, feedbackDigest: compressedKeys.length ? projection.projectionId : null,
    projectionId: projection.projectionId, replacements: projection.replacements,
    compressedKeys, missingNative };
}

const materialPriority: Record<ContextMaterial['kind'], number> = {
  'student-message': 0, 'student-reference': 1, 'student-work': 2, 'system-observation': 3,
  'tool-result': 4, 'history-summary': 5, 'course-material': 6, 'private-material': 7,
};
function materialSourceKey(source: Facts): string {
  const text = (key: string) => typeof source[key] === 'string' ? String(source[key]) : '';
  if (source.kind === 'work') return `work:${text('objectId')}:${text('contentId')}`;
  if (source.kind === 'component') return `component:${text('activityId')}:${text('bindingKey')}:${text('requestId')}:${text('contentId')}`;
  if (source.kind === 'course-material') return `course-material:${text('releaseId')}:${text('materialId')}:${text('materialSha256')}`;
  if (source.kind === 'pdf') return `pdf:${text('readingId')}:${text('documentSha256')}`;
  if (source.kind === 'personal-material') return `personal-material:${text('materialId')}:${text('version')}:${text('sha256')}`;
  return JSON.stringify(source);
}
function dedupeMaterials(input: readonly ContextMaterial[]): ContextMaterial[] {
  const ordered = [...input].sort((a, b) => materialPriority[a.kind] - materialPriority[b.kind]);
  const seen = new Map<string, ContextMaterial>();
  for (const item of ordered) {
    const key = JSON.stringify([item.inputId, materialSourceKey(item.source), item.version, item.range, item.digest]);
    const prior = seen.get(key);
    if (!prior || readPreference(item) > readPreference(prior)) seen.set(key, item);
  }
  return [...seen.values()];
}
function readPreference(item: ContextMaterial): number {
  return item.readState === 'included' ? 2 : item.readState === 'reference-only' ? 1 : 0;
}
export function toolMaterial(call: AgentToolCall): ContextMaterial[] {
  if (call.name === 'cite_source' || call.state !== 'closed'
    || call.result?.kind !== 'completed' || call.result.outcome !== 'success') return [];
  const data = call.result.kind === 'completed' && call.result.data && typeof call.result.data === 'object'
    && !Array.isArray(call.result.data) ? call.result.data : {};
  const source = toolSource(call, data);
  const reading = data.reading && typeof data.reading === 'object' && !Array.isArray(data.reading) ? data.reading : null;
  const reference = data.reference && typeof data.reference === 'object' && !Array.isArray(data.reference) ? data.reference : null;
  const explicitRange = data.range ?? reference?.range;
  const range: Facts | null = typeof data.page === 'number'
    ? { page: data.page, ...(typeof data.start === 'number' && typeof data.end === 'number' ? { start: data.start, end: data.end } : {}) }
    : reading && Array.isArray(reading.requestedPages) ? {
      pages: reading.requestedPages,
      ...(reading.region !== undefined ? { region: reading.region } : {}),
      ...(Array.isArray(reading.pages) ? { pageRanges: Object.fromEntries(reading.pages.flatMap(page => {
        if (!page || typeof page !== 'object' || Array.isArray(page) || page.state !== 'ready'
          || typeof page.page !== 'number' || typeof page.text !== 'string') return [];
        return [[page.page, { start: 0, end: page.text.length }]];
      })) } : {}),
    }
    : Array.isArray(data.searchedPages) ? { pages: data.searchedPages }
    : Array.isArray(data.visualPages) ? { pages: data.visualPages }
    : typeof data.start === 'number' && typeof data.end === 'number' ? { start: data.start, end: data.end }
    : typeof data.offset === 'number' && typeof data.length === 'number' ? { offset: data.offset, length: data.length }
    : explicitRange && typeof explicitRange === 'object' && !Array.isArray(explicitRange) ? explicitRange : null;
  const content = JSON.stringify({ tool: call.name, kind: call.result.kind,
    summary: 'summary' in call.result ? call.result.summary : '', source });
  return [{ materialId: 'M-' + canonicalDigest('tool:' + call.toolCallId).slice(0, 24),
    sourceId: 'tool:' + call.toolCallId, kind: 'tool-result', author: 'tool', label: call.name,
    version: typeof source.version === 'string' ? source.version : call.toolCallId, range, digest: canonicalDigest(content), content,
    readState: 'included', source: { kind: 'tool-call', toolCallId: call.toolCallId, nativeCallId: call.nativeCallId,
      toolName: call.name, source }, citationAllowed: data.resultWithheld == null }];
}
function toolSource(call: AgentToolCall, data: Facts): Facts {
  const workspace = data.workspace && typeof data.workspace === 'object' && !Array.isArray(data.workspace) ? data.workspace : null;
  const projectId = workspace?.projectId ?? data.projectId;
  if (call.name === 'create_personal_project' && typeof projectId === 'string') return { kind: 'project-receipt', projectId };
  if (Array.isArray(data.items)) {
    const references = data.items.flatMap(item => item && typeof item === 'object' && !Array.isArray(item)
      && item.reference && typeof item.reference === 'object' && !Array.isArray(item.reference) ? [item.reference] : []);
    if (references.length === data.items.length) return { kind: 'material-list', references };
  }
  const nested = [data.commonSource, data.source, data.reference && typeof data.reference === 'object'
    && !Array.isArray(data.reference) ? (data.reference as Facts).source ?? data.reference : null]
    .find(value => value && typeof value === 'object' && !Array.isArray(value));
  if (nested) return nested as Facts;
  const file = data.file && typeof data.file === 'object' && !Array.isArray(data.file) ? data.file as Facts : null;
  if (typeof file?.objectId === 'string' && typeof file.contentId === 'string')
    return { kind: 'work', objectId: file.objectId, contentId: file.contentId };
  const query = data.query && typeof data.query === 'object' && !Array.isArray(data.query) ? data.query as Facts : null;
  if (typeof query?.requestId === 'string') {
    const scope = query.scope && typeof query.scope === 'object' && !Array.isArray(query.scope) ? query.scope as Facts : null;
    return { kind: 'component', requestId: query.requestId, ...(data.resultWithheld ? { statusOnly: true } : {}),
      ...(typeof scope?.activityId === 'string' ? { activityId: scope.activityId } : {}),
      ...(typeof query.executionRef === 'string' ? { executionRef: query.executionRef } : {}),
      ...(typeof query.inputDigest === 'string' ? { inputDigest: query.inputDigest } : {}) };
  }
  if (call.name === 'student_ask') return { kind: 'student-answer' };
  return { kind: 'tool-evidence', toolCallId: call.toolCallId, toolName: call.name };
}
function renderMaterials(input: readonly ContextMaterial[], visibleSourceIds: ReadonlySet<string> = new Set()) {
  const ordered = dedupeMaterials(input);
  const materials: ContextMaterial[] = [];
  const lines: { inputId: string | undefined; text: string }[] = [];
  const seenBodies = new Set(visibleSourceIds);
  let used = 0;
  for (const item of ordered) {
    const header = `${item.materialId}｜${item.label}｜${item.author}`
      + `${item.version ? '｜版本 ' + item.version : ''}${item.range ? '｜范围 ' + JSON.stringify(item.range) : ''}`
      + (item.source.kind === 'work' && (item.readState === 'included' || item.readState === 'reference-only')
        ? '｜read_work ' + JSON.stringify({ objectId: item.source.objectId, contentId: item.source.contentId }) : '');
    const identity = item.sourceId + ':' + item.digest;
    const alreadyVisible = seenBodies.has(identity)
      && (item.readState === 'included' || item.readState === 'reference-only');
    let content = item.content ?? '';
    const room = Math.max(0, 400_000 - used - header.length - 160);
    if (item.readState !== 'included' && item.readState !== 'reference-only') content = '';
    if (alreadyVisible) {
      const reason = '该固定版本已在本会话当前可见历史中发送，本步只保留引用和回读入口。';
      materials.push({ ...item, content: null, readState: 'reference-only', visibleInHistory: true, readReason: reason });
      content = '';
      lines.push({ inputId: item.inputId, text: `【${header}｜reference-only】\n正文未重复发出：${reason}` });
    } else if (content.length > room) {
      materials.push({ ...item, content: null, readState: 'omitted',
        readReason: item.readReason ?? '本步材料预算不足，只保留了可回读入口。' });
      content = '';
      lines.push({ inputId: item.inputId, text: `【${header}｜omitted】\n正文未发出：本步材料预算不足，请按固定范围读取。` });
    } else {
      materials.push(item);
      if (item.readState === 'included' && content) seenBodies.add(identity);
      lines.push({ inputId: item.inputId, text: `【${header}｜${item.readState}】${content ? '\n' + content : '\n正文未发出'
        + (item.readReason ? '：' + item.readReason : '；可按固定来源读取。')}` });
    }
    used += header.length + content.length + 4;
    if (used >= 400_000) break;
  }
  return { materials, lines };
}
async function runCompaction(options: BuildContextOptions, input: ScenarioInput, source: CompactionSource,
  compaction: NonNullable<AgentScenario['compaction']>, segmentEpoch: number, rawHistoryDigest: string):
  Promise<{ history: HistoryEntry[]; adopt(): Promise<void> } | null> {
  const { store } = options;
  const gateway = await resolveGateway(options.gateway, input.identity, input.sessionId);
  const runtime = await store.turnRuntime(input.turnId);
  if (!runtime) throw new AgentError('turn-runtime-missing');
  const model = runtime.model.connection;
  const prompt = compaction.provider.prompt(source);
  // A durable per-Turn allowance: invalid summaries still consume a real call and its recorded Attempt.
  const used = await store.compactionCount(input.turnId);
  if (used >= compaction.maxPerTurn) return null;
  const live = await store.budgetOf(input.turnId);
  const remainingInput = live.budget.maxInputTokens - live.usage.inputTokens;
  if (remainingInput < 1) throw new AgentError('input-budget-exhausted');
  const inputReserve = Math.max(1, Math.min(remainingInput,
    Math.ceil(Buffer.byteLength(JSON.stringify(prompt) + JSON.stringify(source), 'utf8') / 3) + 4096));
  const maxOutputTokens = Math.min(model.maxOutputTokens ?? 2048, source.policy.maxSummaryTokens, live.budget.maxOutputTokens - live.usage.outputTokens);
  if (maxOutputTokens < 1) throw new AgentError('output-budget-exhausted');
  const timeoutMs = Math.min(live.budget.maxCallMs, Math.max(250, Date.parse(live.budget.deadline) - Date.now()), 60_000);
  const requestId = operationId('agent-compaction:' + input.stepId);
  const segmentId = operationId('agent-compaction-segment:' + requestId);
  const attemptNo = 100 + used;
  const attemptId = operationId('agent-compaction-attempt:' + requestId + ':' + attemptNo);
  const permit = { sessionId: input.sessionId, runId: input.turnId, stepId: input.stepId, operationId: attemptId, generation: 1 };
  await store.saveAttempt(input.stepId, { attemptId, attemptNo, requestRef: null, reserved: { inputTokens: inputReserve, outputTokens: maxOutputTokens } });
  const cancelled = () => options.signal.aborted;
  async function stillAuthorized(entries: HistoryEntry[]) {
    const authorize = options.scenario.authorizeHistory;
    return !authorize || historyDigest(await authorize(input, entries)) === historyDigest(entries);
  }
  const fail = async (error: string) => {
    await gateway.checks.cancel(input.identity, attemptId).catch(() => {});
    await store.finishAttempt(input.stepId, attemptId, { state: 'interrupted', usage: { state: 'unknown' }, responseRef: null, error }).catch(() => {});
    throw new AgentError('cancelled');
  };
  try {
    await store.recordStepContext(input.stepId, {
      purpose: 'compaction', systemDigest: canonicalDigest(prompt.system), historyDigest: historyDigest(source.messages),
      materials: [], historySources: JSON.parse(JSON.stringify(source.messages.flatMap(entry => entry.sources ?? []))),
      summaryProvider: { id: compaction.provider.id, version: compaction.provider.version },
      sourceDigest: source.sourceDigest, retainedDigest: source.retainedDigest, segmentEpoch,
    });
    const segment = await gateway.segments.create(input.identity, modelSegmentInputSchema.parse({ requestId, segmentId, sessionId: input.sessionId,
      source: { selected: true, selectionVersion: runtime.model.selectionVersion, pinId: runtime.model.pinId },
      purpose: 'learning', prefix: { system: prompt.system, tools: [] }, portable: [] }));
    let fact = await raceAbort(gateway.checks.receive(input.identity, modelLearningInputSchema.parse({ attemptId, purpose: 'learning', segmentId,
      expectedSequence: segment.sequence, input: { text: prompt.text, images: [], toolResults: [], observations: [] },
      limits: { maxOutputTokens, timeoutMs }, authority: { formatVersion: 1, permit } })), options.signal);
    if (fact.state === 'accepted') {
      const capacity = await raceAbort(measureAttemptCapacity(gateway, { ...input, system: prompt.system,
        tools: [], history: [], text: prompt.text, images: [], toolResults: [], budget: options.budget,
        spent: options.spent, segmentEpoch, signal: options.signal }, model, attemptId, maxOutputTokens, remainingInput), options.signal);
      await store.recordRequestCapacity(input.stepId, attemptId, capacity, fact.requestRef);
      if (!capacity.dispatchable) {
        await gateway.checks.cancel(input.identity, attemptId);
        await store.finishAttempt(input.stepId, attemptId, { state: 'failed', usage: { state: 'final', inputTokens: 0, outputTokens: 0 },
          responseRef: null, error: capacity.reason });
        return null;
      }
      if (!await stillAuthorized(source.messages)) {
        await gateway.checks.cancel(input.identity, attemptId);
        await store.finishAttempt(input.stepId, attemptId, { state: 'failed',
          usage: { state: 'final', inputTokens: 0, outputTokens: 0 }, responseRef: null, error: 'context-changed' });
        return null;
      }
      fact = await raceAbort(gateway.checks.dispatch(input.identity, attemptId, { formatVersion: 1, permit }), options.signal);
    }
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
    // Compare the raw persisted history, not the compacted projection used to build the summary.
    if (historyDigest(conversationHistory(state)) !== rawHistoryDigest) return null;
    if (!await stillAuthorized([...source.messages, ...source.remainder])) return null;
    const retainedImages = source.messages.flatMap(entry => entry.images ?? []);
    const retainedSources = new Map<string, HistorySource>();
    for (const item of source.messages) for (const source of item.sources ?? [])
      retainedSources.set(source.sourceId, source);
    const history: HistoryEntry[] = [{ id: attemptId, version: 1, role: 'user',
      text: '已核对来源的历史摘要（推断和未知仍保持原性质）：' + JSON.stringify(summary),
      ...(retainedImages.length ? { images: retainedImages } : {}),
      ...(retainedSources.size ? { sources: [...retainedSources.values()] } : {}) }, ...source.remainder];
    let adopted = false;
    return { history, async adopt() {
      if (adopted) return;
      if (cancelled()) throw new AgentError('cancelled');
      const current = await store.sessionState(input.sessionId);
      if (historyDigest(conversationHistory(current)) !== rawHistoryDigest) throw new AgentError('context-changed');
      if (!await stillAuthorized([...source.messages, ...source.remainder])) throw new AgentError('context-changed');
      if (cancelled()) throw new AgentError('cancelled');
      const summarized = new Set(source.messages.map(entry => entry.id));
      const summaryEntry = history[0]!;
      const raw = conversationHistory(current);
      const insertion = raw.findIndex(entry => summarized.has(entry.id));
      const durable = insertion < 0 ? [summaryEntry, ...raw]
        : [...raw.slice(0, insertion), summaryEntry, ...raw.slice(insertion).filter(entry => !summarized.has(entry.id))];
      await store.setSessionState(input.sessionId, { ...current, history: JSON.parse(JSON.stringify(durable)) as Facts,
        compactedEntries: [...new Set([...(Array.isArray(current.compactedEntries) ? current.compactedEntries.map(String) : []),
          ...source.messages.map(entry => entry.id)])],
        segmentEpoch, compactionAdoption: { attemptId, resultRef: fact.resultRef, sourceDigest: source.sourceDigest } }, input.turnId);
      adopted = true;
      await store.appendEvent(input.sessionId, 'context-compacted', { turnId: input.turnId, stepId: input.stepId, attemptId,
        resultRef: fact.resultRef, sourceDigest: source.sourceDigest,
        retainedIds: (source.sourceVersions as { retainedIds?: string[] }).retainedIds ?? [] });
    } };
  } catch (error) {
    if (options.signal.aborted || error instanceof AgentError && error.code === 'cancelled') return fail('cancelled');
    if (error instanceof StorageError && ['maintenance', 'stale-generation', 'missing', 'conflict'].includes(error.code)) throw error;
    await store.finishAttempt(input.stepId, attemptId, { state: 'failed', usage: { state: 'unknown' }, responseRef: null, error: error instanceof Error ? error.message.slice(0, 500) : 'compaction-failed' }).catch(() => {});
    return null;
  }
}

export { appendHistory, historyDigest };
