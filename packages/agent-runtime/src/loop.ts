import { operationId } from '@xunjie/storage/identity';
import type { AgentTurn, AgentStep, AgentToolCall, AgentNotification, AgentToolResult } from '@xunjie/contracts/agent-runtime';
import type { ModelToolResult, ModelImageRef } from '@xunjie/contracts/model-connections';
import type { AgentStore, AgentSessionInput } from './store.js';
import type { ModelGatewaySource } from './model.js';
import type { AgentScenario, AgentTool, ModelPort, ToolContext, AskInput, AskOutcome, Facts, ScenarioInput, Json } from './ports.js';
import { buildContext, type TaskFactsPort } from './context.js';
import { createToolRegistry, executeTools } from './tools.js';
import { appendHistory, conversationHistory } from './history.js';
import { budgetExhausted } from './budgets.js';
import { AgentError } from './errors.js';

export interface LoopDependencies {
  store: AgentStore; model: ModelPort; gateway: ModelGatewaySource; scenario: AgentScenario;
  taskFacts?: TaskFactsPort | undefined;
  isActive(turnId: string): Promise<boolean>;
  signalFor(turnId: string): AbortSignal;
  ask(turnId: string, stepId: string, toolCallId: string, input: AskInput): Promise<AskOutcome>;
  onProgress(sessionId: string, turnId: string, stepId: string, attemptId: string, progress: { revision: number; text: string; tools?: readonly Json[] | undefined }): Promise<void>;
}
const MAX_TOOLS_PER_RESPONSE = 8;
const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;

/** The single readable main loop: runTurn → runStep → generate → executeTools. */
export async function runTurn(deps: LoopDependencies, turnId: string): Promise<void> {
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
      if (error instanceof AgentError && error.code === 'cancelled') return; // Stop already closed the Turn.
      const reason = error instanceof AgentError ? error.code : 'internal-error';
      await store.finishTurn(turnId, 'failed', reason === 'budget-exhausted' ? 'budget_exhausted' : reason);
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
  const scenarioInput: ScenarioInput = { identity: session.identity, sessionId, turnId: turn.turnId, stepId: step.stepId,
    inputIds: inputs.map(i => i.inputId), sessionState: { ...persisted, workspaceInputs: asJson(inputs
      .filter(item => item.input.context && typeof item.input.context === 'object' && 'action' in item.input.context)
      .map(item => ({ inputId: item.inputId, action: item.input.context.action as Json }))) } };
  const { budget, usage, counts } = await store.budgetOf(turn.turnId);
  const plan = await buildContext({ store, gateway: deps.gateway, scenario, taskFacts: deps.taskFacts, budget, spent: usage }, scenarioInput, { inputs, notifications });
  const registry = createToolRegistry(plan.tools);
  const response = await model.generate({
    identity: session.identity, sessionId, turnId: turn.turnId, stepId: step.stepId,
    system: plan.system, tools: plan.tools.map(t => t.definition), history: plan.history,
    text: plan.text, images: plan.images, toolResults: [], budget, spent: usage, signal,
    onProgress: progress => deps.onProgress(sessionId, turn.turnId, step.stepId, progress.attemptId, progress),
  });
  const intents = response.toolIntents;
  if (intents.length > MAX_TOOLS_PER_RESPONSE) {
    await store.saveResponse(step.stepId, response.attemptId, { text: response.text, toolIntents: [], resultRef: response.responseRef }, []);
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
    await store.saveResponse(step.stepId, response.attemptId, { text: response.text, toolIntents: asJson(intents) as never, resultRef: response.responseRef }, toolCalls);
    for (const call of toolCalls) await store.saveToolResult(call.toolCallId, { kind: 'not_started', reason: 'budget_exhausted' }, null);
    await store.completeStep(step.stepId);
    throw new AgentError('budget-exhausted');
  }
  await store.saveResponse(step.stepId, response.attemptId, { text: response.text, toolIntents: asJson(intents) as never, resultRef: response.responseRef }, toolCalls);
  const state = await store.sessionState(sessionId);
  const history = appendHistory(conversationHistory(state), [
    ...inputs.map(i => ({ id: i.inputId, version: i.version, role: 'user' as const, text: i.input.text })),
    { id: response.attemptId, version: 1, role: 'assistant' as const, text: response.text, ...(response.responseRef ? { resultRef: response.responseRef } : {}) },
  ]);
  await store.setSessionState(sessionId, { ...state, history: asJson(history) as Facts });

  const savedCalls = await store.toolCallsOf(step.stepId);
  if (savedCalls.length) {
    await executeTools({ calls: savedCalls, registry, store, signal,
      isActive: () => deps.isActive(turn.turnId),
      contextFor: call => toolContext(deps, session.identity, turn, step, call, plan.inputIds) });
    const results = await store.toolCallsOf(step.stepId);
    const feedback: ModelToolResult[] = results.map(call => ({ callId: call.nativeCallId, ...feedbackOf(call.result) }));
    const settled = await model.settleTools(session.identity, response.segmentId, response.segmentSequence, feedback);
    const after = await store.sessionState(sessionId);
    const toolHistory = results.map(call => ({ id: call.toolCallId, version: 1, role: 'user' as const,
      text: JSON.stringify({ tool: call.name, kind: call.result?.kind, summary: call.result && 'summary' in call.result ? call.result.summary : '' }) }));
    await store.setSessionState(sessionId, { ...after, segment: { segmentId: settled.segmentId, sequence: settled.sequence, closed: false },
      history: asJson(appendHistory(conversationHistory(after), toolHistory)) as Facts });
  }
  await store.completeStep(step.stepId);
  return savedCalls.length > 0;
}
function feedbackOf(result: AgentToolResult | null): { outcome: 'success' | 'error' | 'not-executed'; text: string; images: ModelImageRef[] } {
  if (!result) return { outcome: 'not-executed', text: '工具未执行', images: [] };
  switch (result.kind) {
    case 'completed': return { outcome: result.outcome === 'success' ? 'success' : 'error', text: result.summary, images: result.images ?? [] };
    case 'accepted': return { outcome: 'success', text: result.summary, images: [] };
    case 'not_started': return { outcome: 'not-executed', text: result.reason, images: [] };
    case 'interrupted': return { outcome: 'not-executed', text: result.reason, images: [] };
    case 'outcome_unknown': return { outcome: 'error', text: result.reason, images: [] };
  }
}
function toolContext(deps: LoopDependencies, identity: ScenarioInput['identity'], turn: AgentTurn, step: AgentStep, call: AgentToolCall, inputIds: string[]): ToolContext {
  return { identity, sessionId: turn.sessionId, turnId: turn.turnId, stepId: step.stepId, toolCallId: call.toolCallId,
    signal: deps.signalFor(turn.turnId), inputIds,
    ask: input => deps.ask(turn.turnId, step.stepId, call.toolCallId, input) };
}
export type { AgentTool };
