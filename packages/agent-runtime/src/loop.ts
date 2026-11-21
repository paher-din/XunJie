import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import type { AgentTurn, AgentStep, AgentToolCall, AgentNotification, AgentToolResult } from '@xunjie/contracts/agent-runtime';
import type { ModelToolResult, ModelImageRef } from '@xunjie/contracts/model-connections';
import type { AgentStore, AgentSessionInput } from './store.js';
import type { ModelGatewaySource } from './model.js';
import type { AgentScenario, AgentTool, ContextMaterial, HistoryEntry, ModelPort, ToolContext, AskInput, AskOutcome,
  Facts, ScenarioInput, Json, ToolEffectReference } from './ports.js';
import { buildContext, toolMaterial, type TaskFactsPort } from './context.js';
import { createToolRegistry, executeTools } from './tools.js';
import { appendHistory, conversationHistory, historyDigest } from './history.js';
import { budgetExhausted } from './budgets.js';
import { AgentError, ContextCapacityError, ContextPressureError } from './errors.js';
import { createCitationTool } from './citations.js';
import { ensureTurnRuntime } from './runtime-config.js';

export interface LoopDependencies {
  store: AgentStore; model: ModelPort; gateway: ModelGatewaySource; scenario: AgentScenario;
  taskFacts?: TaskFactsPort | undefined;
  isActive(turnId: string): Promise<boolean>;
  signalFor(turnId: string): AbortSignal;
  /** A Turn's frozen deadline aborts the model/tool signal; expiry is recorded for the failure reason. */
  armTurn(turnId: string, deadline: string | null): void;
  disarmTurn(turnId: string): void;
  deadlineReached(turnId: string): boolean;
  ask(turnId: string, stepId: string, toolCallId: string, input: AskInput): Promise<AskOutcome>;
  onLateAcceptance?(turnId: string): void;
  onCallTimeout?(turnId: string, call: AgentToolCall, reference: ToolEffectReference): Promise<void>;
  onProgress(sessionId: string, turnId: string, stepId: string, attemptId: string, progress: { revision: number; text: string; thinking?: string; tools?: readonly Json[] | undefined }): Promise<void>;
}
const MAX_TOOLS_PER_RESPONSE = 8;
const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const sourceString = (source: Facts, key: string) => typeof source[key] === 'string' ? String(source[key]) : '';
/** A source is compactable only when this Step actually exposes a reader for its fixed identity. */
function hasFixedReadback(source: Facts, tools: ReadonlySet<string>): boolean {
  const kind = sourceString(source, 'kind');
  if (kind === 'work') return tools.has('read_work') && !!sourceString(source, 'objectId') && !!sourceString(source, 'contentId');
  if (kind === 'component' || kind === 'experiment-reference') return (tools.has('read_result') || tools.has('execution_query'))
    && !!sourceString(source, 'requestId');
  if (kind === 'course-material') return tools.has('read_material') && !!sourceString(source, 'materialId')
    && !!sourceString(source, 'materialSha256');
  if (kind === 'personal-material') return tools.has('read_personal_material') && !!sourceString(source, 'materialId')
    && !!sourceString(source, 'version');
  if (kind === 'pdf') return (tools.has('read_pdf') || tools.has('read_pdf_text'))
    && !!sourceString(source, 'documentId') && !!sourceString(source, 'documentSha256');
  if (kind === 'tool-call') {
    const nested = source.source;
    return !!nested && typeof nested === 'object' && !Array.isArray(nested)
      && hasFixedReadback(nested as Facts, tools);
  }
  return false;
}

/** The single readable main loop: runTurn → runStep → generate → executeTools. */
export async function runTurn(deps: LoopDependencies, turnId: string): Promise<void> {
  const { store } = deps;
  deps.armTurn(turnId, (await store.budgetOf(turnId)).budget.deadline);
  try {
    const sessionId = await turnSession(store, turnId);
    const session = await store.session(sessionId);
    try {
      await ensureTurnRuntime(store, { scenario: { id: deps.scenario.id, version: deps.scenario.version },
        gateway: deps.gateway }, session.identity, sessionId, turnId);
    } catch (error) {
      // A legacy/import-only Turn may legitimately have nothing to generate. Context history
      // still needs to be assembled; the actual model call fails explicitly with no selection.
      if (!(error instanceof AgentError) || error.code !== 'model-not-selected') throw error;
    }
    await runTurnLoop(deps, turnId);
  } catch (error) {
    if (error instanceof AgentError && error.code === 'cancelled') return;
    const sessionId = await turnSession(store, turnId).catch(() => null);
    if (sessionId) {
      const turn = await store.turn(sessionId, turnId).catch(() => null);
      if (turn?.state === 'active') {
        const reason = error instanceof AgentError ? error.code : 'internal-error';
        await store.finishTurn(turnId, 'failed', reason).catch(() => {});
      }
    }
    if (error instanceof AgentError) return;
    throw error;
  } finally { deps.disarmTurn(turnId); }
}
async function runTurnLoop(deps: LoopDependencies, turnId: string): Promise<void> {
  const { store } = deps;
  let force = true;
  while (await deps.isActive(turnId)) {
    const turn = await store.turn(await turnSession(store, turnId), turnId);
    const { budget, usage, counts } = await store.budgetOf(turnId);
    if (budgetExhausted(budget, usage, counts, Date.now())) { await store.finishTurn(turnId, 'failed', 'budget_exhausted'); return; }
    let opened;
    try { opened = await store.openStep(turnId, { budgetBasis: asJson(budget) }, force); }
    catch (error) {
      if (error instanceof AgentError && error.code === 'budget-exhausted') { await store.finishTurn(turnId, 'failed', 'budget_exhausted'); return; }
      throw error;
    }
    if (opened.kind === 'none') { await store.finishTurn(turnId, 'completed', ''); return; }
    let hadTools: boolean;
    try { hadTools = await runStep(deps, turn, opened.step, opened.inputs, opened.notifications); }
    catch (error) {
      // A Turn deadline is a real failure; a student Stop already closed the Turn.
      if (deps.deadlineReached(turnId)) { await store.finishTurn(turnId, 'failed', 'deadline-exceeded'); return; }
      if (error instanceof AgentError && error.code === 'cancelled') return;
      const reason = error instanceof AgentError ? error.code : 'internal-error';
      // Every hard budget reason is one structured category so automatic wake is blocked in the same commit.
      const normalized = /^(budget-exhausted|(input|output|step|tool)-budget-exhausted)$/.test(reason) ? 'budget_exhausted' : reason;
      await store.finishTurn(turnId, 'failed', normalized);
      return;
    }
    if (hadTools) { force = true; continue; }
    force = false;
    if (await store.finishTurn(turnId, 'completed', '')) return;
    force = true; // new input arrived during the natural-end check
  }
}
async function turnSession(store: AgentStore, turnId: string): Promise<string> {
  const { rows } = await store.storage.read('SELECT session_id FROM agent_turns WHERE turn_id=$1', [turnId]);
  return String(rows[0]!.session_id);
}
async function runStep(deps: LoopDependencies, turn: AgentTurn, step: AgentStep, inputs: AgentSessionInput[], notifications: AgentNotification[]): Promise<boolean> {
  const { store, model, scenario } = deps;
  const sessionId = turn.sessionId;
  const signal = deps.signalFor(turn.turnId);
  const session = await store.session(sessionId);
  const persisted = await store.sessionState(sessionId);
  // Workspace actions are a durable Session basis: later Steps, answers, steering and notification Turns
  // reuse the last validated action while new action-bearing inputs update it.
  const workspaceInputs = await store.workspaceInputs(sessionId);
  const originInputId = await store.turnOriginInput(turn.turnId);
  const visibleAnswerInputIds = (Array.isArray(persisted.answerInbox) ? persisted.answerInbox as Facts[] : [])
    .map(item => item.inputId).filter((id): id is string => typeof id === 'string');
  const scenarioInput: ScenarioInput = { identity: session.identity, sessionId, turnId: turn.turnId, stepId: step.stepId,
    inputIds: inputs.map(i => i.inputId),
    inputs: inputs.map(input => ({ inputId: input.inputId, requestId: input.input.requestId,
      text: input.input.text, context: input.input.context as Facts })),
    sessionState: { ...persisted, workspaceInputs: asJson(workspaceInputs) } };
  const { budget, usage, counts } = await store.budgetOf(turn.turnId);
  let plan = await buildContext({ store, gateway: deps.gateway, scenario, taskFacts: deps.taskFacts, budget, spent: usage, signal }, scenarioInput, { inputs, notifications });
  // The tool definition is stable for the whole Turn. Adding or removing it between Steps
  // would change the native prefix and force a second segment even when the route is fixed.
  const generate = async (options: { smallerThanBytes?: number; allowPressureCompaction?: boolean } = {}) => {
    await store.recordStepContext(step.stepId, {
      ruleVersions: asJson(plan.ruleVersions), materials: asJson(plan.materials.map(materialMetadata)),
      rebuildMaterials: asJson(plan.rebuildMaterials.map(materialMetadata)),
      systemDigest: canonicalDigest(plan.system), historyDigest: historyDigest(plan.history),
      historySources: asJson(plan.history.flatMap(entry => entry.sources ?? [])),
      segmentEpoch: plan.segmentEpoch, compacted: plan.compacted,
      toolNames: [...plan.tools.map(tool => tool.definition.name), 'cite_source'],
    });
    return model.generate({
      identity: session.identity, sessionId, turnId: turn.turnId, stepId: step.stepId,
      system: plan.system, tools: [...plan.tools, createCitationTool(plan.materials)].map(tool => tool.definition), history: plan.history,
      text: plan.text, rebuildText: plan.rebuildText, images: plan.images, toolResults: [], budget, spent: usage, signal,
      ...(scenario.messageImages && inputs.length ? { messageImages: {
        resolve: route => scenario.messageImages!(scenarioInput, inputs.map(item => item.input.context), route),
        async assertActive() {
          if (signal.aborted || !await deps.isActive(turn.turnId)) throw new AgentError('cancelled');
        },
      } } : {}),
      historyProjection: plan.historyProjection,
      historySources: materialsAsHistorySources(plan.materials),
      rebuildHistorySources: materialsAsHistorySources(plan.rebuildMaterials),
      factsDigest: plan.factsDigest,
      segmentEpoch: plan.segmentEpoch,
      ...(scenario.authorizeHistory ? { async verifyContext({ rebuilt }) {
        const current = await store.sessionState(sessionId);
        const sources = Array.isArray(current.nativeHistorySources)
          ? current.nativeHistorySources as unknown as NonNullable<HistoryEntry['sources']> : [];
        const nativeEntries = sources.map((source, index): HistoryEntry => ({
          id: 'dispatch-native:' + index, version: 1, role: 'user', text: '', sources: [source],
        }));
        // The final request may inline `rebuildMaterials` on a fresh segment or keep the
        // current `materials` reference-only view on a continued native segment. Check both
        // the content-bearing receipts and the recorded native sources at dispatch time.
        const materialEntries = materialsAsHistorySources(rebuilt ? plan.rebuildMaterials : plan.materials)
          .map((source, index): HistoryEntry => ({
            id: 'dispatch-material:' + index, version: 1, role: 'user', text: '', sources: [source],
          }));
        const entries = [...plan.history, ...nativeEntries, ...materialEntries];
        if (historyDigest(await scenario.authorizeHistory!(scenarioInput, entries)) !== historyDigest(entries))
          throw new AgentError('context-changed');
      } } : {}),
      ...(plan.adoptCompaction ? { adoptContext: plan.adoptCompaction } : {}),
      ...(options.smallerThanBytes !== undefined ? { smallerThanBytes: options.smallerThanBytes } : {}),
      allowPressureCompaction: options.allowPressureCompaction ?? !plan.compacted,
      onProgress: progress => deps.onProgress(sessionId, turn.turnId, step.stepId, progress.attemptId, progress),
    });
  };
  let response;
  let revocationRetry = false;
  try { response = await generate();
  } catch (error) {
    if (error instanceof AgentError && error.code === 'context-changed') {
      if (revocationRetry) throw error;
      revocationRetry = true;
      // The context assembled earlier in this Step can become stale before dispatch. Rebuild
      // once from current owner authorization; only the rebuilt, rechecked payload may send.
      plan = await buildContext({ store, gateway: deps.gateway, scenario, taskFacts: deps.taskFacts,
        budget, spent: usage, signal }, scenarioInput, { inputs, notifications });
      response = await generate({ allowPressureCompaction: false });
    } else if (error instanceof ContextPressureError) {
      const compacted = await buildContext({ store, gateway: deps.gateway, scenario, taskFacts: deps.taskFacts,
        budget, spent: usage, signal, compactionBasis: error.capacity }, scenarioInput, { inputs, notifications });
      plan = compacted;
      try {
        response = await generate({ allowPressureCompaction: false,
          ...(plan.compacted ? { smallerThanBytes: error.capacity.bytes } : {}) });
      } catch (candidateError) {
        if (!plan.compacted || !(candidateError instanceof ContextCapacityError) || candidateError.sent) throw candidateError;
        plan = await buildContext({ store, gateway: deps.gateway, scenario, taskFacts: deps.taskFacts,
          budget, spent: usage, signal }, scenarioInput, { inputs, notifications });
        response = await generate({ allowPressureCompaction: false });
      }
    } else {
      if (!(error instanceof AgentError) || !['context-capacity-exceeded', 'context-capacity-preflight'].includes(error.code)) throw error;
      const rejectedCandidate = plan.compacted && error.code === 'context-capacity-preflight';
      if (plan.compacted && !rejectedCandidate) throw error;
      // One bounded retry, only after a real synchronous reduction. The provider never repeats the same payload.
      plan = await buildContext({ store, gateway: deps.gateway, scenario, taskFacts: deps.taskFacts,
        budget, spent: usage, signal,
        ...(!rejectedCandidate && error instanceof ContextCapacityError && error.capacity ? { compactionBasis: error.capacity } : {}),
      }, scenarioInput, { inputs, notifications });
      if (!rejectedCandidate && !plan.compacted) {
        await store.recordStepContext(step.stepId, {
          ruleVersions: plan.ruleVersions as never[], materials: plan.materials.map(materialMetadata) as never[],
          systemDigest: canonicalDigest(plan.system), historyDigest: historyDigest(plan.history),
          segmentEpoch: plan.segmentEpoch, failure: 'context-capacity-exceeded',
        } as Facts).catch(() => {});
        throw error;
      }
      response = await generate({ ...(!rejectedCandidate && error instanceof ContextCapacityError ? { smallerThanBytes: error.bytes } : {}),
        allowPressureCompaction: !plan.compacted });
    }
  }
  const dispatchedMaterials = response.rebuilt ? plan.rebuildMaterials : plan.materials;
  const plannedCitation = createCitationTool(dispatchedMaterials);
  const plannedTools = [...plan.tools, plannedCitation];
  const plannedToolNames = new Set(plannedTools.map(tool => tool.definition.name));
  const registry = createToolRegistry(plannedTools);
  const historySources = materialsAsHistorySources(dispatchedMaterials);
  const responseSources = [...new Map([...plan.history.flatMap(entry => entry.sources ?? []), ...historySources]
    .map(source => [source.sourceId, source])).values()];
  const normalized = normalizeInlineCitations(response.text, dispatchedMaterials);
  const text = normalized.text;
  const intents = response.toolIntents;
  if (intents.length > MAX_TOOLS_PER_RESPONSE) {
    await store.saveResponse(step.stepId, response.attemptId, { text, toolIntents: [], resultRef: response.responseRef, ...(response.contextUsage ? { contextUsage: response.contextUsage } : {}) }, []);
    throw new AgentError('protocol-error'); // whole response rejected; zero dispatch
  }
  const toolCalls: { toolCallId: string; nativeCallId: string; name: string; input: Facts; executionMode: 'foreground' | 'background' }[] = [];
  for (const intent of intents) {
    const tool = registry.get(intent.name);
    const args = intent.arguments as Facts;
    const mode = (args.executionMode as string) === 'background' ? 'background' : 'foreground';
    const input = { ...args }; delete (input as Facts).executionMode;
    toolCalls.push({ toolCallId: operationId('agent-tool:' + response.attemptId + ':' + intent.callId),
      nativeCallId: intent.callId, name: intent.name, input, executionMode: mode });
  }
  if (counts.toolCalls + toolCalls.length > budget.maxToolCalls) {
    await store.saveResponse(step.stepId, response.attemptId, { text, toolIntents: asJson(intents) as never, resultRef: response.responseRef, ...(response.contextUsage ? { contextUsage: response.contextUsage } : {}) }, toolCalls);
    for (const call of toolCalls) await store.saveToolResult(call.toolCallId, { kind: 'not_started', reason: 'budget_exhausted' }, null);
    await store.completeStep(step.stepId);
    throw new AgentError('budget-exhausted');
  }
  await store.saveResponse(step.stepId, response.attemptId, { text, toolIntents: asJson(intents) as never, resultRef: response.responseRef, ...(response.contextUsage ? { contextUsage: response.contextUsage } : {}) }, toolCalls);
  if (normalized.citations.length) await store.appendEvent(sessionId, 'inline-citations', {
    turnId: turn.turnId, stepId: step.stepId, attemptId: response.attemptId, citations: normalized.citations });
  const state = await store.sessionState(sessionId);
  const history = appendHistory(conversationHistory(state), [
    ...inputs.map(i => ({ id: i.inputId, version: i.version, role: 'user' as const, text: i.input.text, turnId: turn.turnId })),
    { id: response.attemptId, version: 1, role: 'assistant' as const, text, turnId: turn.turnId,
      ...(response.responseRef ? { resultRef: response.responseRef } : {}),
      ...(responseSources.length ? { sources: responseSources } : {}) },
  ]);
  await store.setSessionState(sessionId, { ...state, history: asJson(history) as Facts }, turn.turnId);

  const savedCalls = await store.toolCallsOf(step.stepId);
  if (savedCalls.length) {
    await executeTools({ calls: savedCalls, registry, store, signal, budget,
      isActive: () => deps.isActive(turn.turnId),
      ...(deps.onLateAcceptance ? { onLateAcceptance: () => deps.onLateAcceptance!(turn.turnId) } : {}),
      ...(deps.onCallTimeout ? { onCallTimeout: (call: AgentToolCall, reference: ToolEffectReference) => deps.onCallTimeout!(turn.turnId, call, reference) } : {}),
      contextFor: call => toolContext(deps, session.identity, turn, step, call, response.segmentId, plan.inputIds, originInputId, visibleAnswerInputIds) })
      .then(outcome => { if (outcome === 'stopped') throw new AgentError('cancelled'); });
    const results = await store.toolCallsOf(step.stepId);
    const feedback: ModelToolResult[] = results.map(call => ({ callId: call.nativeCallId, ...feedbackOf(call.result) }));
    const settled = await model.settleTools(session.identity, response.segmentId, response.segmentSequence, feedback);
    const after = await store.sessionState(sessionId);
    const toolHistory = results.map(call => {
      const toolSources = materialsAsHistorySources(toolMaterial(call));
      return { id: call.toolCallId, version: 1, role: 'user' as const, turnId: turn.turnId, stepId: step.stepId,
        kind: 'tool-result' as const,
        attemptId: response.attemptId,
        nativeCallId: call.nativeCallId,
        readback: toolSources.some(source => hasFixedReadback(source.source, plannedToolNames)),
        text: JSON.stringify({ tool: call.name, kind: call.result?.kind, outcome: feedbackOf(call.result).outcome,
          summary: call.result && 'summary' in call.result ? call.result.summary : call.result && 'reason' in call.result ? call.result.reason : '',
          ...effectReferences(call.result) }),
        ...(call.result?.kind === 'completed' && call.result.images?.length ? { images: call.result.images } : {}),
        sources: [...historySources, ...toolSources] };
    });
    await store.setSessionState(sessionId, { ...after, segment: { segmentId: settled.segmentId, sequence: settled.sequence, closed: false },
      history: asJson(appendHistory(conversationHistory(after), toolHistory)) as Facts }, turn.turnId);
  }
  await store.completeStep(step.stepId);
  return savedCalls.length > 0;
}
function materialMetadata(material: ContextMaterial) {
  const { content, ...rest } = material;
  return { ...rest, contentBytes: Buffer.byteLength(content ?? '', 'utf8'),
    contentDigest: content === null ? null : canonicalDigest(content) };
}
/**
 * Some models render the internal citation tool as an XML-like marker in prose. Keep only
 * markers that name a material actually sent in this Step, retain their claim and material
 * identity as structured evidence, and remove every marker from the visible conversation.
 */
function normalizeInlineCitations(text: string, materials: readonly ContextMaterial[],
  ): { text: string; citations: { claim: string; materialId: string }[] } {
  const allowed = new Set(materials.filter(material => material.citationAllowed
    && material.readState === 'included').map(material => material.materialId));
  const citations: { claim: string; materialId: string }[] = [];
  const seen = new Set<string>();
  const attributes = (value: string) => Object.fromEntries([...value.matchAll(/([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/g)]
    .map(match => [match[1]!, match[2]!.replaceAll('&quot;', '"').replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>')]));
  const clean = text.replace(/<cite_source\b([^>]*)>/gi, (_match, raw: string) => {
    const value = attributes(raw), materialId = value.materialId, claim = value.claim?.trim();
    if (!materialId || !claim || !allowed.has(materialId) || citations.length >= MAX_TOOLS_PER_RESPONSE) return '';
    const key = JSON.stringify({ claim, materialId });
    if (seen.has(key)) return '';
    seen.add(key);
    citations.push({ claim, materialId });
    return '';
  }).split('</cite_source>').join('').replace(/[ \t]+\n/g, '\n').replace(/(?:\n\s*){3,}/g, '\n\n').trim();
  return { text: clean, citations };
}
function materialsAsHistorySources(materials: readonly ContextMaterial[]) {
  const sources = new Map<string, NonNullable<HistoryEntry['sources']>[number]>();
  for (const material of materials) if (material.readState === 'included' || material.readState === 'reference-only')
    sources.set(material.sourceId, { sourceId: material.sourceId, label: material.label, source: material.source,
      ...(material.readState === 'included' && material.content !== null ? { inlineDigest: material.digest } : {}),
      ...(material.range ? { range: material.range } : {}) });
  return [...sources.values()];
}
function feedbackOf(result: AgentToolResult | null): { outcome: 'success' | 'error' | 'not-executed'; text: string; images: ModelImageRef[] } {
  if (!result) return { outcome: 'not-executed', text: '工具未执行', images: [] };
  switch (result.kind) {
    case 'completed': return { outcome: result.outcome === 'success' ? 'success' : 'error', text: result.summary, images: result.images ?? [] };
    case 'accepted': return { outcome: 'success', text: result.summary, images: [] };
    case 'not_started': return { outcome: 'not-executed', text: result.reason, images: [] };
    case 'interrupted': return { outcome: 'not-executed', text: result.reason, images: [] };
    case 'outcome_unknown': return { outcome: 'error', text: JSON.stringify({ kind: result.kind, reason: result.reason, ...effectReferences(result) }), images: [] };
  }
}
function effectReferences(result: AgentToolResult | null): { taskId?: string; requestRef?: string } {
  if (result?.kind === 'accepted') return { taskId: result.taskId };
  if (result?.kind !== 'outcome_unknown') return {};
  return { ...(result.taskId ? { taskId: result.taskId } : {}), ...(result.requestRef ? { requestRef: result.requestRef } : {}) };
}
function toolContext(deps: LoopDependencies, identity: ScenarioInput['identity'], turn: AgentTurn, step: AgentStep, call: AgentToolCall,
  segmentId: string, inputIds: string[], originInputId: string | null, visibleAnswerInputIds: readonly string[]): ToolContext {
  const deadline = (step.snapshot.budgetBasis as { deadline?: string } | undefined)?.deadline;
  return { identity, sessionId: turn.sessionId, turnId: turn.turnId, stepId: step.stepId, toolCallId: call.toolCallId, segmentId,
    ...(deadline ? { deadline: String(deadline) } : {}),
    signal: deps.signalFor(turn.turnId),
    async assertActive() {
      if (deps.signalFor(turn.turnId).aborted || !await deps.isActive(turn.turnId)) throw new AgentError('cancelled');
    },
    inputIds, originInputId, visibleAnswerInputIds, ask: input => deps.ask(turn.turnId, step.stepId, call.toolCallId, input) };
}
export type { AgentTool };
