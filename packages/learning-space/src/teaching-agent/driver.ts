import { randomUUID } from 'node:crypto';
import { StorageError, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import { actionInputSchema, type ActionInput } from '@xunjie/contracts/action-intents';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import type { ModelAttempt, ModelLearningInput, ModelTool, ModelUsage } from '@xunjie/contracts/model-connections';
import { teachingEventKindSchema, teachingIgnorableExtensionSchema, teachingSnapshotSchema, teachingToolRecordSchema, teachingWaitSchema,
  type TeachingRun, type TeachingEventKind, type TeachingSnapshot } from '@xunjie/contracts/teaching-agent';
import type { LearningModelPort } from '../model-connections/service.js';
import { cleanupScopeFor } from './tools-execution.js';
import { buildContext, fixedInputText, type ContextMessage } from './context.js';
import { teachingExplanationText, teachingPublicArguments } from './help-policy.js';
import { canonicalDigest, operationId } from './identity.js';
import type { TeachingToolHost, TeachingToolScope, TeachingPreparedTool, TeachingToolOutcome } from './tool-types.js';
import { studentAskDefinition, prepareStudentAsk, type createStudentQuestions } from './student-questions.js';
import { studentResponseObservations } from './student-response-context.js';
import type { createTeachingInputs } from './inputs.js';
import { assembleTeachingAgent, retainTeachingAssembly, manifestFor, TeachingAssemblyError, toolContributions } from './assembly.js';
import { projectToolOutcome, readToolResult, readToolResultDefinition } from './tool-results.js';
import { discoveryContributions, discoveryOutcome, permittedContributions, loadedTools } from './tool-discovery.js';
import { compileOutputSchema } from '../model-connections/chat-native.js';
import type { AgentDefinition, ResolvedAgent, AgentToolBinding } from '@xunjie/contracts/teaching-agent';

type Row = Record<string, unknown>;
type Event = { kind: TeachingEventKind; body: Record<string, unknown> };
type Model = NonNullable<TeachingRun['model']>;
interface ContextFacts { inputs: unknown[]; effects: unknown[]; waits: unknown[]; activity: LearningActivity }
interface Plan {
  input: ModelLearningInput; model: Model; modelSource?: 'school' | 'personal'; sources: TeachingSnapshot['sources']; createdAt: string;
  inputBasis?: ActionInput; inputSequence?: number;
  inputVersions?: { inputId: string; version: number; inputDigest: string }[];
  waitVersions?: { waitId: string; outcomeDigest: string }[];
  resolvedAgent?: ResolvedAgent;
  contextHistory?: ContextMessage[];
  selectionVersion?: number;
  selectionPinId?: string;
  contextFacts?: ContextFacts;
}
export interface TeachingRunLimits {
  maxModelSteps: number;
  maxToolCommands: number;
  maxParallelTools: number;
  waitMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCallMs: number;
  hardDeadlineMs: number;
}
const defaultLimits: TeachingRunLimits = { maxModelSteps: 16, maxToolCommands: 64, maxParallelTools: 1, waitMs: 86_400_000,
  maxInputTokens: 1_048_576, maxOutputTokens: 65_536, maxCallMs: 600_000, hardDeadlineMs: 86_400_000 };
export class TeachingBudgetError extends Error {}
const terminal = (state: unknown) => ['completed', 'failed', 'stopped', 'paused'].includes(String(state));
const pending = (outcome: TeachingToolOutcome) => outcome.state === 'accepted' || outcome.state === 'unknown';
const registryCommand = (command: TeachingPreparedTool) =>
  (command.basis.executorBinding as AgentToolBinding | undefined)?.source?.sourceId === 'platform.tools';
const unsent = (reason: string): TeachingToolOutcome => ({ state: 'not-dispatched',
  feedback: { outcome: 'not-executed', text: reason, images: [] }, result: { reason }, source: { label: '平台执行检查' } });

function combinedUsage(facts: ModelUsage[]): ModelUsage {
  const total: ModelUsage = { state: facts.length && facts.every(fact => fact.state === 'final') ? 'final'
    : facts.some(fact => fact.state !== 'unknown') ? 'partial' : 'unknown' };
  for (const field of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens'] as const) {
    if (facts.length && facts.every(fact => fact[field] !== undefined)) total[field] = facts.reduce((sum, fact) => sum + fact[field]!, 0);
  }
  return total;
}

/** One driver uses these records for both model calls and tool effects. Reads never replay them. */
export function createTeachingRunDriver(storage: OwnedStorage, owner: {
  driverId: string;
  models: LearningModelPort;
  tools?: TeachingToolHost;
  definition?: AgentDefinition | ((scope: TeachingToolScope) => Promise<AgentDefinition>);
  studentQuestions: ReturnType<typeof createStudentQuestions>;
  inputs: ReturnType<typeof createTeachingInputs>;
  limits?: Partial<TeachingRunLimits>;
  dispatchClosed(): boolean;
  runRow(runId: string): Promise<Row>;
  toRun(row: Row): TeachingRun;
  requestRow(requestId: string): Promise<Row | undefined>;
  identity(row: Row): SpaceIdentity;
  activity(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
  authorize(identity: SpaceIdentity): Promise<void>;
  assertAuthority(tx: OwnedTransaction, runId: string, generation: number): Promise<unknown>;
  appendEvent(tx: OwnedTransaction, activityId: string, kind: TeachingEventKind, body: Record<string, unknown>): Promise<unknown>;
  historyBefore(activityId: string, runId: string): Promise<ContextMessage[]>;
  historyForAssembly(activityId: string): Promise<ContextMessage[]>;
  ensureSegment(identity: SpaceIdentity, activity: LearningActivity, run: TeachingRun,
    choice: Awaited<ReturnType<LearningModelPort['selection']['snapshot']>>,
    selectionVersion: number, system: string, history: ContextMessage[], generation: number, tools: ModelTool[], assemblyId?: string, selectionPinId?: string):
    Promise<{ segmentId: string; sequence: number; model: Model; assemblyId?: string | null }>;
  awaitAttempt(identity: SpaceIdentity, run: TeachingRun, generation: number, attemptId: string,
    segmentId: string, initial?: ModelAttempt): Promise<ModelAttempt>;
  finish(run: TeachingRun, generation: number, state: TeachingRun['state'], reason: string, usage: ModelUsage,
    model: TeachingRun['model'], event: Event | null, extras?: Event[]): Promise<boolean>;
}) {
  const limits = { ...defaultLimits, ...owner.limits };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new StorageError('invalid');
  const event = owner.appendEvent;
  async function freezeBudget(tx: OwnedTransaction, runId: string) {
    await tx.query(`INSERT INTO teaching_budgets(run_id,max_model_steps,max_tool_commands,max_parallel_tools,wait_ms,
      max_input_tokens,max_output_tokens,max_call_ms,deadline)
      SELECT run_id,$2,$3,$4,$5,$6,$7,$8,created_at+($9::text || ' milliseconds')::interval FROM teaching_runs WHERE run_id=$1
      ON CONFLICT DO NOTHING`, [runId, limits.maxModelSteps, limits.maxToolCommands, limits.maxParallelTools, limits.waitMs,
      limits.maxInputTokens, limits.maxOutputTokens, limits.maxCallMs, limits.hardDeadlineMs]);
  }
  async function expired(runId: string) {
    const { rows: [row] } = await storage.read('SELECT deadline<=clock_timestamp() AS expired FROM teaching_budgets WHERE run_id=$1', [runId]);
    return row?.expired === true;
  }
  async function transaction(run: TeachingRun, generation: number, effect: (tx: OwnedTransaction) => Promise<void>) {
    await storage.request({ requestId: 'teaching-driver:' + randomUUID(), fingerprint: run.runId }, async tx => {
      await owner.assertAuthority(tx, run.runId, generation);
      await effect(tx);
      return null;
    });
  }
  async function runInTransaction(tx: OwnedTransaction, runId: string): Promise<Row> {
    // Cleanup can race a stop request and the Wait scanner. Never borrow another
    // pool connection while this transaction holds their original command lock.
    const { rows: [row] } = await tx.query('SELECT * FROM teaching_runs WHERE run_id=$1', [runId]);
    if (!row) throw new StorageError('missing');
    return row;
  }
  async function assertDispatch(run: TeachingRun, generation: number) {
    if (await expired(run.runId)) throw new TeachingBudgetError('run-deadline-exceeded');
    if ((await owner.runRow(run.runId)).reason === 'wait-expired') throw new TeachingBudgetError('wait-expired');
    if (owner.dispatchClosed()) throw new StorageError('maintenance');
    await owner.authorize(owner.identity(await owner.runRow(run.runId)));
    const { rows: log } = await storage.read(`SELECT s.next_seq,e.seq,e.kind,e.event_version,
      CASE WHEN e.kind='extension' THEN e.body ELSE NULL END AS extension_body FROM teaching_sessions s
      LEFT JOIN teaching_events e USING(activity_id) WHERE s.activity_id=$1 ORDER BY e.seq`, [run.activityId]);
    if (!log.length || log.some((row, index) => Number(row.seq) !== index + 1) || Number(log[0]!.next_seq) !== log.length + 1)
      throw new StorageError('corrupt');
    if (log.some(row => row.event_version !== 1 || !teachingEventKindSchema.safeParse(row.kind).success
      || row.kind === 'extension' && !teachingIgnorableExtensionSchema.safeParse(row.extension_body).success))
      throw new StorageError('incompatible');
    await transaction(run, generation, async tx => {
      const { rows: [row] } = await tx.query('SELECT stop_requested,state,reason FROM teaching_runs WHERE run_id=$1', [run.runId]);
      if (!row || row.stop_requested || terminal(row.state) || row.reason === 'student-response-expired') throw new StorageError('conflict');
    });
  }
  async function step(runId: string) {
    const { rows: [row] } = await storage.read('SELECT * FROM teaching_steps WHERE run_id=$1 ORDER BY step_no DESC LIMIT 1', [runId]);
    return row as Row | undefined;
  }
  async function commands(stepId: string) {
    const { rows } = await storage.read('SELECT * FROM teaching_commands WHERE step_id=$1 ORDER BY ordinal', [stepId]);
    return rows;
  }
  async function readyWaits(run: TeachingRun, tx?: OwnedTransaction) {
    const read = tx ? tx.query.bind(tx) : storage.read.bind(storage);
    const { rows } = await read(`SELECT c.*,w.wait_id FROM teaching_waits w JOIN teaching_commands c USING(command_id)
      WHERE w.run_id=$1 AND w.purpose='result' AND w.state='consumed' AND w.observed_step_id IS NULL
      ORDER BY w.consumed_at,w.wait_id`, [run.runId]);
    return rows;
  }
  async function fixedContextFacts(tx: OwnedTransaction, run: TeachingRun, activity: LearningActivity, inputIds: string[]): Promise<ContextFacts> {
    const { rows: inputs } = await tx.query(`SELECT i.input_id,i.version,i.seq,v.body FROM teaching_inputs i
      JOIN teaching_input_revisions v ON v.input_id=i.input_id AND v.version=i.version
      WHERE i.adopted_run_id=$1 OR i.input_id=ANY($2::uuid[]) ORDER BY i.seq`, [run.runId, inputIds]);
    const { rows: effects } = await tx.query(`SELECT command_id,call_id,command,outcome FROM teaching_commands
      WHERE run_id=$1 AND outcome IS NOT NULL ORDER BY step_id,ordinal`, [run.runId]);
    const { rows: waits } = await tx.query('SELECT * FROM teaching_waits WHERE run_id=$1 ORDER BY wait_id', [run.runId]);
    return JSON.parse(JSON.stringify({ inputs, effects, waits, activity })) as ContextFacts;
  }
  function outcomeObservations(row: Row) {
    const outcome = row.outcome as TeachingToolOutcome;
    if ((row.command as TeachingPreparedTool).name === studentAskDefinition.name && typeof outcome.result.responseId === 'string')
      return studentResponseObservations(outcome);
    return [{ observationId: operationId('tool-observation:' + row.command_id + ':' + canonicalDigest(outcome)),
      version: 1, source: 'caller' as const, text: JSON.stringify({ commandId: row.command_id, source: outcome.source,
        state: outcome.state, feedback: outcome.feedback.text }).slice(0, 8192) }];
  }
  async function scopeFor(run: TeachingRun, saved: Row, generation?: number): Promise<TeachingToolScope> {
    const identity = owner.identity(await owner.runRow(run.runId));
    const request = await owner.requestRow(run.requestId);
    if (!request) throw new StorageError('corrupt');
    return { identity, activity: await owner.activity(identity, run.activityId),
      input: actionInputSchema.parse((saved.plan as Plan | undefined)?.inputBasis ?? request.body),
      runId: run.runId, stepId: String(saved.step_id), snapshotId: String(saved.snapshot_id),
      ...(typeof saved.segment_id === 'string' ? { segmentId: saved.segment_id } : {}),
      ...(generation === undefined ? {} : { authority: { runId: run.runId, activityId: run.activityId,
        driverId: owner.driverId, generation }, assertDispatch: () => assertDispatch(run, generation) }) };
  }
  async function assertCurrentBinding(scope: TeachingToolScope, binding: AgentToolBinding) {
    if (binding.executor.executorId === 'teaching-student-questions:ask') {
      if (binding.source.contentDigest !== canonicalDigest(studentAskDefinition)) throw new StorageError('forbidden');
      return;
    }
    const internal = [...discoveryContributions(scope), ...discoveryContributions(scope, [readToolResultDefinition])];
    const current = binding.source.sourceId === 'platform.tools' ? internal : await toolContributions(owner.tools, scope);
    if (!current.some(item => canonicalDigest(item) === binding.bindingId)) throw new StorageError('forbidden');
  }
  async function internalToolOutcome(scope: TeachingToolScope, command: TeachingPreparedTool, definition: AgentDefinition) {
    if (command.name === 'read_tool_result') {
      const { rows: [original] } = await storage.read(`SELECT c.binding_id,s.plan FROM teaching_commands c
        JOIN teaching_steps s USING(step_id) WHERE c.command_id=$1 AND c.run_id=$2`, [command.arguments.commandId, scope.runId]);
      const binding = (original?.plan as Plan | undefined)?.resolvedAgent?.tools.find(item => item.bindingId === original?.binding_id);
      if (!binding) throw new StorageError('forbidden');
      await assertCurrentBinding(scope, binding);
      return readToolResult(storage, scope, command.arguments);
    }
    const outcome = await discoveryOutcome(storage, scope, command.name, command.arguments,
      permittedContributions(await toolContributions(owner.tools, scope), definition));
    if (command.basis.frozenOutcome && canonicalDigest(outcome) !== canonicalDigest(command.basis.frozenOutcome))
      throw new StorageError('identity-conflict');
    return outcome;
  }
  async function pause(run: TeachingRun, generation: number, reason: string, model = run.model) {
    const current = owner.toRun(await owner.runRow(run.runId));
    await owner.finish(run, generation, 'paused', reason, current.usage, model ?? current.model,
      { kind: ['model-not-selected', 'model-unavailable', 'model-capability-unavailable', 'max-output-missing'].includes(reason) ? 'model-unavailable' : 'system-notice',
        body: { runId: run.runId, reason } });
  }
  async function pauseAssembly(run: TeachingRun, generation: number, error: TeachingAssemblyError) {
    const current = owner.toRun(await owner.runRow(run.runId));
    await owner.finish(run, generation, 'paused', error.reason, current.usage, current.model,
      { kind: 'system-notice', body: { runId: run.runId, reason: error.reason, unavailable: error.unavailable } });
  }
  async function planNext(run: TeachingRun, generation: number, previous?: Row): Promise<Row | null> {
    const scope = await scopeFor(run, previous ?? { step_id: operationId('step:' + run.runId + ':0'), snapshot_id: run.runId });
    const fixedInputs = await owner.inputs.pending(run);
    const ready = await readyWaits(run);
    const root = fixedInputs.find(item => item.inputId === run.inputId);
    const firstInput = root ?? (!previous ? fixedInputs[0] : undefined);
    if (!previous && !firstInput) {
      const finished = await owner.finish(run, generation, 'stopped', 'input-removed-before-adoption', run.usage, run.model,
        { kind: 'run-stopped', body: { runId: run.runId, reason: 'input-removed-before-adoption' } });
      return finished ? null : planNext(run, generation);
    }
    if (firstInput) scope.input = firstInput.input;
    if (scope.activity.status !== 'open' || scope.activity.course && scope.activity.course.helpPolicy?.questions !== 'allowed')
      throw new StorageError('forbidden');
    let plan: Plan;
    if (previous) {
      const priorPlan = previous.plan as unknown as Plan;
      const { rows: [session] } = await storage.read('SELECT segment_id FROM teaching_sessions WHERE activity_id=$1', [run.activityId]);
      const segmentId = String(session?.segment_id ?? previous.segment_id);
      const native = await owner.models.segments.read(scope.identity, segmentId);
      if (native.pending || native.pendingTools?.length) throw new StorageError('resource-busy');
      const rows = await commands(String(previous.step_id));
      const results = [...rows.filter(row => !ready.some(wait => wait.command_id === row.command_id)
        && ['accepted', 'unknown'].includes(String((row.initial_outcome as TeachingToolOutcome | null)?.state))), ...ready];
      const observations = results.flatMap(outcomeObservations);
      const responses: TeachingSnapshot['sources'] = results.flatMap(row => {
        const command = row.command as TeachingPreparedTool, outcome = row.outcome as TeachingToolOutcome;
        return command.name === studentAskDefinition.name && typeof outcome.result.responseId === 'string'
          ? [{ kind: 'student-response' as const, id: outcome.result.responseId, label: '学生对当前提问的明确回应' }] : [];
      });
      const { rows: [switched] } = segmentId !== previous.segment_id ? await storage.read(`SELECT target FROM teaching_model_switches
        WHERE activity_id=$1 AND to_segment_id=$2 AND state='completed'`, [run.activityId, segmentId]) : { rows: [] };
      const { rows: [transition] } = await storage.read(`SELECT t.*,a.body AS assembly FROM teaching_segment_transitions t
        LEFT JOIN teaching_resolved_agents a ON a.resolved_id::text=t.assembly_id
        WHERE t.activity_id=$1 AND t.to_segment_id=$2 AND t.state='completed'`, [run.activityId, segmentId]);
      const target = (transition?.target ?? switched?.target) as { model: Model; source: { kind: 'school' | 'personal' } } | undefined;
      if (segmentId !== previous.segment_id && !target) throw new StorageError('conflict');
      if (target && !target.model.maxOutputTokens) { await pause(run, generation, 'max-output-missing', target.model); return null; }
      plan = { input: { ...priorPlan.input, segmentId, expectedSequence: native.sequence,
        ...(target?.model.maxOutputTokens ? { limits: { maxOutputTokens: target.model.maxOutputTokens } } : {}),
        input: { text: '', images: [], toolResults: [], observations } }, model: target?.model ?? priorPlan.model,
        ...((target?.source.kind ?? priorPlan.modelSource) ? { modelSource: (target?.source.kind ?? priorPlan.modelSource)! } : {}),
        sources: [...priorPlan.sources, ...responses], createdAt: new Date().toISOString(),
        ...(priorPlan.resolvedAgent ? { resolvedAgent: priorPlan.resolvedAgent } : {}),
        ...(priorPlan.contextHistory ? { contextHistory: priorPlan.contextHistory } : {}),
        ...(priorPlan.selectionVersion !== undefined ? { selectionVersion: priorPlan.selectionVersion } : {}),
        ...(priorPlan.selectionPinId ? { selectionPinId: priorPlan.selectionPinId } : {}) };
      if (transition) {
        if (transition.assembly) plan.resolvedAgent = transition.assembly as ResolvedAgent;
        plan.selectionVersion = Number(transition.selection_version);
        const source = (transition.create_body as { source: { pinId?: string } }).source;
        if (source.pinId) plan.selectionPinId = source.pinId;
      }
      const { rows: [received] } = await storage.read(`SELECT t.*,a.body AS assembly FROM teaching_segment_transitions t
        JOIN teaching_resolved_agents a ON a.resolved_id::text=t.assembly_id
        WHERE t.activity_id=$1 AND t.reason<>'model-switch' AND t.state='accepted'`, [run.activityId]);
      if (received) {
        const fixed = received.assembly as ResolvedAgent;
        const body = received.create_body as { source: { pinId?: string }; portable: { role?: 'user' | 'assistant'; text: string }[] };
        if (!body.source.pinId) throw new StorageError('corrupt');
        const history: ContextMessage[] = body.portable.map(message => ({
          role: message.role === 'assistant' ? 'assistant' : 'student', text: message.text }));
        const selectionVersion = Number(received.selection_version);
        const choice = await owner.models.selection.pinned(scope.identity, body.source.pinId, selectionVersion);
        const restored = await owner.ensureSegment(scope.identity, scope.activity, run, choice, selectionVersion,
          fixed.prompt.system, history, generation, fixed.tools.map(item => item.definition), fixed.resolvedId, body.source.pinId);
        if (restored.assemblyId !== fixed.resolvedId) throw new StorageError('corrupt');
        plan.input.segmentId = restored.segmentId; plan.input.expectedSequence = restored.sequence;
        plan.model = restored.model; plan.resolvedAgent = fixed; plan.contextHistory = history;
        plan.selectionVersion = selectionVersion; plan.selectionPinId = body.source.pinId;
      } else if (segmentId === previous.segment_id && plan.resolvedAgent && plan.selectionVersion !== undefined && plan.selectionPinId) {
        const history = await owner.historyForAssembly(run.activityId);
        let next;
        try { next = await assembleTeachingAgent(scope, owner.tools, plan.model, history,
          typeof owner.definition === 'function' ? await owner.definition(scope) : owner.definition, await loadedTools(storage, scope)); }
        catch (error) {
          if (!(error instanceof TeachingAssemblyError)) throw error;
          await pauseAssembly(run, generation, error); return null;
        }
        if (next.resolvedAgent.resolvedId !== plan.resolvedAgent.resolvedId) {
          await transaction(run, generation, async tx => { await retainTeachingAssembly(tx, next.resolvedAgent); });
          const choice = await owner.models.selection.pinned(scope.identity, plan.selectionPinId, plan.selectionVersion);
          const segment = await owner.ensureSegment(scope.identity, scope.activity, run, choice, plan.selectionVersion,
            next.context.system, history, generation, next.tools, next.resolvedAgent.resolvedId, plan.selectionPinId);
          if (segment.assemblyId !== next.resolvedAgent.resolvedId) throw new StorageError('conflict');
          plan.input.segmentId = segment.segmentId; plan.input.expectedSequence = segment.sequence;
          plan.resolvedAgent = next.resolvedAgent; plan.contextHistory = history;
        }
      }
    } else {
      const { rows: [receivedTransition] } = await storage.read(`SELECT t.*,a.body AS assembly FROM teaching_segment_transitions t
        JOIN teaching_resolved_agents a ON a.resolved_id::text=t.assembly_id WHERE t.activity_id=$1
        AND t.reason<>'model-switch' AND (t.state='accepted' OR t.create_body->'source'->>'pinId'=$2)
        ORDER BY t.accepted_at DESC LIMIT 1`, [run.activityId, run.runId]);
      const receivedSource = (receivedTransition?.create_body as { source?: { pinId?: string } } | undefined)?.source;
      const selection = receivedTransition ? { version: Number(receivedTransition.selection_version), selected: true }
        : await owner.models.selection.read(scope.identity);
      if (!selection.selected) { await pause(run, generation,
        ('unavailableReason' in selection ? selection.unavailableReason : undefined) ?? 'model-not-selected'); return null; }
      const selectionPinId = receivedSource?.pinId ?? run.runId;
      const choice = receivedTransition ? await owner.models.selection.pinned(scope.identity, selectionPinId, selection.version)
        : await owner.models.selection.pin(scope.identity, run.runId, selection.version);
      const connection = choice.choice.connection;
      if (!connection.maxOutputTokens) { await pause(run, generation, 'max-output-missing'); return null; }
      const history: ContextMessage[] = receivedTransition
        ? (receivedTransition.create_body as { portable: { role?: 'user' | 'assistant'; text: string }[] }).portable
          .map(message => ({ role: message.role === 'assistant' ? 'assistant' : 'student', text: message.text }))
        : await owner.historyBefore(run.activityId, run.runId);
      const model = { connectionId: connection.connectionId, version: connection.version, protocol: connection.protocol,
        modelId: connection.modelId, ...(connection.contextWindow ? { contextWindow: connection.contextWindow } : {}),
        maxOutputTokens: connection.maxOutputTokens };
      let assembly;
      try {
        const receivedAgent = receivedTransition?.assembly as ResolvedAgent | undefined;
        assembly = receivedAgent ? { resolvedAgent: receivedAgent,
          context: buildContext(scope.activity, scope.input, history, { definition: receivedAgent.definition }),
          tools: receivedAgent.tools.map(item => item.definition) }
          : await assembleTeachingAgent(scope, owner.tools, model, history,
            typeof owner.definition === 'function' ? await owner.definition(scope) : owner.definition, await loadedTools(storage, scope));
      }
      catch (error) {
        if (!(error instanceof TeachingAssemblyError)) throw error;
        await pauseAssembly(run, generation, error); return null;
      }
      const { context, resolvedAgent, tools } = assembly;
      if (context.system.length > Math.min(400000, resolvedAgent.definition.contextPolicy.maxSystemChars)
        || context.userText.length > Math.min(1000000, resolvedAgent.definition.contextPolicy.maxInputChars)
        || model.contextWindow !== undefined && connection.maxOutputTokens >= model.contextWindow) {
        await owner.finish(run, generation, 'paused', 'capacity-exceeded', run.usage, run.model,
          { kind: 'capacity-paused', body: { runId: run.runId, reason: 'capacity-exceeded',
            requiredScope: { question: scope.input.requestId, references: scope.input.draft.references.map(ref => ref.referenceId),
              works: scope.input.works.map(work => work.contentId), workNames: scope.input.works.map(work => work.name),
              referenceNames: scope.input.draft.references.map(ref => ref.sourceName) },
            systemChars: context.system.length, inputChars: context.userText.length,
            outputReserve: connection.maxOutputTokens, contextWindow: model.contextWindow, counting: 'unknown' } }); return null;
      }
      await transaction(run, generation, async tx => { await retainTeachingAssembly(tx, resolvedAgent); });
      const native = await owner.ensureSegment(scope.identity, scope.activity, run, choice, selection.version,
        context.system, history, generation, tools, resolvedAgent.resolvedId, selectionPinId);
      plan = { input: { attemptId: run.runId, purpose: 'learning', segmentId: native.segmentId, expectedSequence: native.sequence,
        input: { text: context.userText, images: [], toolResults: [], observations: [] }, limits: { maxOutputTokens: connection.maxOutputTokens } },
        model: native.model, modelSource: choice.source.kind, sources: context.sources, createdAt: new Date().toISOString(),
        resolvedAgent, contextHistory: history, selectionVersion: selection.version, selectionPinId };
    }
    // A fresh native segment starts a new user turn. Portable assistant facts are
    // evidence, never an open provider reasoning turn or a substitute for the fixed intent.
    if (previous && plan.input.segmentId !== previous.segment_id && !plan.input.input.text) {
      const settled = (await commands(String(previous.step_id))).map(row => ({ commandId: row.command_id,
        name: (row.command as TeachingPreparedTool).name, state: (row.outcome as TeachingToolOutcome | null)?.state ?? row.state }));
      plan.input.input.text = '同一已接受问题的后续步骤；以下已完成操作不要重跑，请从尚未完成处继续：\n'
        + JSON.stringify(settled) + '\n\n当前固定学生意图与依据：\n' + fixedInputText(scope.input);
    }
    const additions = fixedInputs.filter(item => previous || item.inputId !== firstInput?.inputId);
    const texts = additions.map(item => fixedInputText(item.input));
    if (texts.length) plan.input.input.text = [plan.input.input.text, ...texts].filter(Boolean).join('\n\n---\n\n');
    const policy = plan.resolvedAgent?.definition.contextPolicy;
    if (plan.input.input.text.length > Math.min(1000000, policy?.maxInputChars ?? 1000000)
      || (plan.resolvedAgent?.prompt.system.length ?? 0) > Math.min(400000, policy?.maxSystemChars ?? 400000)) {
      await owner.finish(run, generation, 'paused', 'capacity-exceeded', run.usage, run.model,
        { kind: 'capacity-paused', body: { runId: run.runId, reason: 'capacity-exceeded', counting: 'unknown',
          inputChars: plan.input.input.text.length, policy,
          requiredScope: { questions: fixedInputs.map(item => item.input.requestId),
            references: fixedInputs.flatMap(item => item.input.draft.references.map(ref => ref.referenceId)),
            works: fixedInputs.flatMap(item => item.input.works.map(work => work.contentId)),
            workNames: [...new Set(fixedInputs.flatMap(item => item.input.works.map(work => work.name)))],
            referenceNames: [...new Set(fixedInputs.flatMap(item => item.input.draft.references.map(ref => ref.sourceName)))] } } });
      return null;
    }
    plan.inputBasis = fixedInputs.at(-1)?.input ?? scope.input;
    plan.inputSequence = Math.max((previous?.plan as Plan | undefined)?.inputSequence ?? 0, ...fixedInputs.map(item => item.sequence));
    plan.inputVersions = fixedInputs.map(({ inputId, version, inputDigest }) => ({ inputId, version, inputDigest }));
    plan.waitVersions = ready.map(row => ({ waitId: String(row.wait_id), outcomeDigest: canonicalDigest(row.outcome) }));
    plan.sources.push(...ready.map(row => ({ kind: 'history' as const, id: String(row.wait_id), label: '原操作已核实的结果或回应' })));
    plan.sources.push(...fixedInputs.map(item => ({ kind: 'input' as const, id: item.inputId + ':' + item.version,
      label: item.inputId === run.inputId ? '本次固定输入版本' : '已纳入的学生补充' })));
    const number = previous ? Number(previous.step_no) + 1 : 0;
    const stepId = operationId(`step:${run.runId}:${number}`), attemptId = operationId('model-attempt:' + stepId);
    plan.input.attemptId = attemptId;
    const snapshotId = operationId('model-snapshot:' + stepId);
    await assertDispatch(run, generation);
    let exhausted = '', changed = false;
    await transaction(run, generation, async tx => {
      if (!await owner.inputs.matches(tx, run, fixedInputs)) { changed = true; return; }
      const currentWaits = (await readyWaits(run, tx)).map(row => ({ waitId: String(row.wait_id), outcomeDigest: canonicalDigest(row.outcome) }));
      if (JSON.stringify(currentWaits) !== JSON.stringify(plan.waitVersions)) { changed = true; return; }
      const { rows: [current] } = await tx.query('SELECT stop_requested FROM teaching_runs WHERE run_id=$1', [run.runId]);
      if (current?.stop_requested) throw new StorageError('conflict');
      const { rows: [session] } = await tx.query('SELECT activity_id,segment_id FROM teaching_sessions WHERE activity_id=$1 FOR UPDATE', [run.activityId]);
      if (previous && session?.segment_id !== plan.input.segmentId) {
        // A switch completed after the optimistic plan read. Replan against its new
        // segment on the next scan; never reserve an attempt against the closed one.
        await tx.query(`UPDATE teaching_runs SET state='received',lease_owner=NULL,lease_expires_at=NULL WHERE run_id=$1`, [run.runId]);
        return;
      }
      const { rows: switching } = await tx.query(`SELECT request_id FROM teaching_model_switches
        WHERE activity_id=$1 AND state IN ('accepted','paused') LIMIT 1`, [run.activityId]);
      if (previous && switching.length) {
        await tx.query(`UPDATE teaching_runs SET state='waiting',reason='model-switch-boundary',lease_owner=NULL,lease_expires_at=NULL
          WHERE run_id=$1`, [run.runId]);
        return;
      }
      await freezeBudget(tx, run.runId);
      const { rows: [budget] } = await tx.query(`SELECT *,EXTRACT(EPOCH FROM (deadline-clock_timestamp()))*1000 AS remaining_ms
        FROM teaching_budgets WHERE run_id=$1 FOR UPDATE`, [run.runId]);
      const { rows: [count] } = await tx.query('SELECT count(*)::integer AS total FROM teaching_steps WHERE run_id=$1', [run.runId]);
      if (Number(count?.total) >= Number(budget!.max_model_steps)) { exhausted = 'model-step-budget-exhausted'; return; }
      const { rows: [used] } = await tx.query(`SELECT
        COALESCE(sum(CASE WHEN usage->>'state'='final' AND usage ? 'inputTokens' THEN (usage->>'inputTokens')::bigint ELSE
          GREATEST(input_reserved,COALESCE((usage->>'inputTokens')::bigint,0)) END),0) AS input,
        COALESCE(sum(CASE WHEN usage->>'state'='final' AND usage ? 'outputTokens' THEN (usage->>'outputTokens')::bigint ELSE
          GREATEST(output_reserved,COALESCE((usage->>'outputTokens')::bigint,0)) END),0) AS output,
        COALESCE(sum(COALESCE(call_settled_ms,call_reserved_ms)),0) AS call_ms
        FROM teaching_steps WHERE run_id=$1`, [run.runId]);
      // The configured context window is a conservative input upper bound, not a tokenizer estimate.
      const inputReserve = plan.model.contextWindow;
      if (!inputReserve) { exhausted = 'input-budget-bound-unavailable'; return; }
      if (Number(used!.input) + inputReserve > Number(budget!.max_input_tokens)) { exhausted = 'input-token-budget-exhausted'; return; }
      const outputRemaining = Number(budget!.max_output_tokens) - Number(used!.output);
      if (outputRemaining < 1) { exhausted = 'output-token-budget-exhausted'; return; }
      const callRemaining = Math.floor(Math.min(Number(budget!.max_call_ms) - Number(used!.call_ms), Number(budget!.remaining_ms)));
      if (callRemaining < 250) { exhausted = Number(budget!.remaining_ms) < 250 ? 'run-deadline-exceeded' : 'model-call-budget-exhausted'; return; }
      plan.input.limits.maxOutputTokens = Math.min(plan.input.limits.maxOutputTokens, outputRemaining);
      plan.input.limits.timeoutMs = Math.min(plan.input.limits.timeoutMs ?? callRemaining, callRemaining, 2_147_483_647);
      if (plan.resolvedAgent) plan.contextFacts = await fixedContextFacts(tx, run, scope.activity, fixedInputs.map(item => item.inputId));
      await tx.query(`INSERT INTO teaching_steps(step_id,run_id,step_no,attempt_id,segment_id,snapshot_id,phase,plan,output_reserved,input_reserved,call_reserved_ms)
        VALUES($1,$2,$3,$4,$5,$6,'planned',$7,$8,$9,$10)`, [stepId, run.runId, number, attemptId,
        plan.input.segmentId, snapshotId, JSON.stringify(plan), plan.input.limits.maxOutputTokens, inputReserve, plan.input.limits.timeoutMs]);
      if (plan.resolvedAgent) {
        await retainTeachingAssembly(tx, plan.resolvedAgent);
        await tx.query('UPDATE teaching_steps SET resolved_agent_id=$2 WHERE step_id=$1', [stepId, plan.resolvedAgent.resolvedId]);
        await tx.query('UPDATE teaching_runs SET initial_resolved_agent_id=COALESCE(initial_resolved_agent_id,$2) WHERE run_id=$1',
          [run.runId, plan.resolvedAgent.resolvedId]);
      }
      await tx.query(`UPDATE teaching_runs SET attempt_id=$2,segment_id=$3,model=$4,state='running',updated_at=clock_timestamp()
        WHERE run_id=$1`, [run.runId, attemptId, plan.input.segmentId, JSON.stringify(plan.model)]);
      await owner.inputs.adopt(tx, run, stepId, fixedInputs);
      for (const wait of plan.waitVersions!) {
        await tx.query('UPDATE teaching_waits SET observed_step_id=$2 WHERE wait_id=$1 AND observed_step_id IS NULL', [wait.waitId, stepId]);
        await event(tx, run.activityId, 'wait-observed', { runId: run.runId, stepId, waitId: wait.waitId,
          outcomeDigest: wait.outcomeDigest, outcome: ready.find(row => row.wait_id === wait.waitId)!.outcome });
      }
      await event(tx, run.activityId, 'budget-reserved', { runId: run.runId, stepId, attemptId,
        modelSteps: 1, outputTokens: plan.input.limits.maxOutputTokens, inputTokens: 'unknown', inputReserve,
        callReserveMs: plan.input.limits.timeoutMs, deadline: new Date(budget!.deadline as string).toISOString() });
    });
    if (changed) return planNext(run, generation, previous);
    if (exhausted) { await pause(run, generation, exhausted); return null; }
    const planned = await step(run.runId);
    return planned?.step_id === stepId ? planned : null;
  }
  async function receiveModel(run: TeachingRun, generation: number, saved: Row, scope: TeachingToolScope) {
    const plan = saved.plan as unknown as Plan;
    await assertDispatch(run, generation);
    // Older planned records did not freeze continuity facts. Append them once before
    // the first snapshot write; subsequent retries always read the same retained data.
    if (plan.resolvedAgent && !plan.contextFacts) await transaction(run, generation, async tx => {
      const { rows: [current] } = await tx.query('SELECT plan FROM teaching_steps WHERE step_id=$1 FOR UPDATE', [saved.step_id]);
      const original = current!.plan as Plan;
      plan.contextFacts = original.contextFacts ?? await fixedContextFacts(tx, run, scope.activity, []);
      if (!original.contextFacts) await tx.query('UPDATE teaching_steps SET plan=$2 WHERE step_id=$1',
        [saved.step_id, JSON.stringify({ ...original, contextFacts: plan.contextFacts })]);
    });
    await owner.models.checks.receive(scope.identity, plan.input);
    const payload = await owner.models.checks.requestPayload(scope.identity, String(saved.attempt_id));
    const contextManifest = plan.resolvedAgent ? manifestFor(plan.resolvedAgent, payload, { ...plan.contextFacts!,
      history: plan.contextHistory ?? [], observations: plan.input.input.observations ?? [],
      maxOutputTokens: plan.input.limits.maxOutputTokens }) : undefined;
    const snapshot = teachingSnapshotSchema.parse({ snapshotId: saved.snapshot_id, activityId: run.activityId, runId: run.runId,
      attemptId: saved.attempt_id, segmentId: saved.segment_id, assemblyVersion: plan.resolvedAgent ? 2 : 1, model: plan.model,
      maxOutputTokens: plan.input.limits.maxOutputTokens, ...(plan.model.contextWindow ? { contextWindow: plan.model.contextWindow } : {}),
      sources: plan.sources, payloadSha256: canonicalDigest(payload), payload, createdAt: plan.createdAt,
      ...(plan.resolvedAgent ? { resolvedAgent: plan.resolvedAgent, contextManifest } : {}) });
    const resource = await storage.stageResource({ uploadId: snapshot.snapshotId, scope: 'teaching-snapshot:' + snapshot.snapshotId,
      bytes: Buffer.from(JSON.stringify(snapshot)), mediaType: 'application/json', contentVersion: 1 });
    await transaction(run, generation, async tx => {
      await tx.query(`INSERT INTO teaching_snapshots(snapshot_id,activity_id,run_id,attempt_id,segment_id,body,resource_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(snapshot_id) DO NOTHING`, [snapshot.snapshotId, run.activityId, run.runId,
        snapshot.attemptId, snapshot.segmentId, JSON.stringify(snapshot), resource.resourceId]);
      await tx.reference('teaching-snapshot:' + snapshot.snapshotId, resource.resourceId);
      await tx.query("UPDATE teaching_steps SET phase='model' WHERE step_id=$1", [saved.step_id]);
      if (contextManifest) await tx.query('UPDATE teaching_steps SET context_manifest=$2 WHERE step_id=$1', [saved.step_id, JSON.stringify(contextManifest)]);
      await event(tx, run.activityId, 'context-assembled', { runId: run.runId, stepId: saved.step_id,
        snapshotId: snapshot.snapshotId, attemptId: snapshot.attemptId, segmentId: snapshot.segmentId,
        payloadSha256: snapshot.payloadSha256, sources: snapshot.sources,
        capacity: { counter: 'unavailable', payloadChars: JSON.stringify(payload).length, outputReserve: snapshot.maxOutputTokens,
          contextWindow: snapshot.contextWindow } });
    });
  }
  async function modelResult(run: TeachingRun, generation: number, saved: Row, scope: TeachingToolScope) {
    let fact = await owner.models.checks.read(scope.identity, String(saved.attempt_id));
    if (fact.state === 'accepted') {
      const current = owner.toRun(await owner.runRow(run.runId));
      if (current.stopRequested || await expired(run.runId)) fact = await owner.models.checks.cancel(scope.identity, fact.attemptId);
      else {
        try {
          await assertDispatch(run, generation);
          await transaction(run, generation, async tx => {
            const { rows: [row] } = await tx.query('SELECT stop_requested FROM teaching_runs WHERE run_id=$1', [run.runId]);
            if (row?.stop_requested) throw new StorageError('conflict');
            await tx.query('UPDATE teaching_steps SET dispatch_permitted=true,dispatch_generation=$2,call_started_at=COALESCE(call_started_at,clock_timestamp()) WHERE step_id=$1', [saved.step_id, generation]);
            await tx.query("UPDATE teaching_runs SET state='dispatching',reason='',updated_at=clock_timestamp() WHERE run_id=$1", [run.runId]);
            await event(tx, run.activityId, 'attempt-dispatched', { runId: run.runId, stepId: saved.step_id,
              attemptId: fact.attemptId, segmentId: saved.segment_id, expectedSequence: (saved.plan as unknown as Plan).input.expectedSequence });
          });
          await assertDispatch(run, generation);
          fact = await owner.models.checks.dispatch(scope.identity, fact.attemptId);
        } catch (error) {
          if (!(error instanceof TeachingBudgetError)) throw error;
          fact = await owner.models.checks.cancel(scope.identity, fact.attemptId);
        }
      }
    }
    if (fact.state === 'accepted') {
      // The model owner confirms no dispatch claim. Keep the exact step/attempt and
      // release this logical worker; a later lease retries admission at the same owner.
      const reason = fact.reason || 'learning-admission-wait';
      await transaction(run, generation, async tx => {
        await tx.query(`UPDATE teaching_steps SET dispatch_permitted=false,
          dispatch_generation=NULL,call_started_at=NULL WHERE step_id=$1`, [saved.step_id]);
        await tx.query(`UPDATE teaching_runs SET state='waiting',reason=$2,
          lease_owner=NULL,lease_expires_at=clock_timestamp()+interval '1 second',
          updated_at=clock_timestamp() WHERE run_id=$1`, [run.runId, reason]);
      });
      return false;
    }
    fact = await owner.awaitAttempt(scope.identity, run, generation, String(saved.attempt_id), String(saved.segment_id), fact);
    if (!fact.physicalRequestEnded) { await pause(run, generation, 'result-unknown'); return false; }
    // Includes dispatch acknowledgement/polling and process downtime conservatively. Unknown physical completion retains its full reservation.
    await transaction(run, generation, async tx => {
      await tx.query(`UPDATE teaching_steps SET call_settled_ms=CASE WHEN NOT dispatch_permitted THEN 0
        WHEN call_started_at IS NOT NULL THEN GREATEST(0,CEIL(EXTRACT(EPOCH FROM (clock_timestamp()-call_started_at))*1000))
        ELSE call_reserved_ms END WHERE step_id=$1 AND call_settled_ms IS NULL`, [saved.step_id]);
    });
    if (await expired(run.runId)) {
      if (fact.resultRef) await owner.models.results?.retain(scope.identity, {
        requestId: operationId('retain-model:' + run.runId + ':' + fact.resultRef), resultRef: fact.resultRef,
        consumer: 'run', consumerId: run.runId });
      if (fact.toolIntents?.length) await owner.models.segments.settle(scope.identity, String(saved.segment_id), {
        requestId: operationId('teaching-deadline-pair:' + saved.step_id), expectedSequence: (saved.plan as unknown as Plan).input.expectedSequence + 1,
        results: fact.toolIntents.map(intent => ({ callId: intent.callId, ...unsent('run-deadline-exceeded').feedback })),
      });
      await settleUsage(run, generation, saved, fact, 'final'); await pause(run, generation, 'run-deadline-exceeded'); return false;
    }
    if (fact.state === 'completed' && !fact.resultRef) {
      await pause(run, generation, 'native-result-unavailable'); return false;
    }
    const originalSummary = fact.state === 'completed' ? await owner.models.checks.summary?.(scope.identity, fact.attemptId) : null;
    const summary = originalSummary ? { ...originalSummary, text: teachingExplanationText(scope.activity, originalSummary.text) } : null;
    const publicText = teachingExplanationText(scope.activity, fact.text);
    const stopped = owner.toRun(await owner.runRow(run.runId)).stopRequested;
    const intents = fact.state === 'completed' && fact.resultRef && fact.toolIntents?.length ? fact.toolIntents : [];
    if (!intents.length) {
      const state = stopped || fact.state === 'cancelled' ? 'stopped' : fact.state === 'completed' ? 'completed'
        : fact.state === 'unknown' ? 'paused' : 'failed';
      const extras: Event[] = [];
      if (summary) extras.push({ kind: 'native-summary', body: { runId: run.runId, attemptId: saved.attempt_id,
        resultRef: fact.resultRef, ...summary } });
      if (publicText) extras.push({ kind: 'assistant', body: { runId: run.runId, attemptId: saved.attempt_id,
        segmentId: saved.segment_id, resultRef: fact.resultRef, text: publicText, usage: fact.usage,
        model: (saved.plan as unknown as Plan).model, modelSource: fact.source?.kind ?? (saved.plan as unknown as Plan).modelSource,
        state: state === 'completed' ? 'settled' : state === 'stopped' ? 'stopped' : 'failed' } });
      extras.push({ kind: state === 'completed' ? 'run-completed' : state === 'stopped' ? 'run-stopped' : 'run-failed',
        body: { runId: run.runId, attemptId: saved.attempt_id, reason: fact.reason, usage: fact.usage } });
      if (fact.state === 'completed' && fact.resultRef) await owner.models.results?.retain(scope.identity, {
        requestId: operationId('retain-model:' + run.runId + ':' + fact.resultRef), resultRef: fact.resultRef,
        consumer: 'run', consumerId: run.runId });
      await settleUsage(run, generation, saved, fact, 'final');
      const settled = owner.toRun(await owner.runRow(run.runId));
      const finished = await owner.finish(run, generation, state, stopped ? 'stop-requested' : fact.reason, settled.usage,
        (saved.plan as unknown as Plan).model, extras.shift()!, extras);
      return !finished;
    }
    // All prepared commands, the native result association, and step completion share one commit.
    const prepared = await Promise.all(intents.map(async (intent, ordinal) => {
      const commandId = operationId('teaching-command:' + saved.step_id + ':' + intent.callId);
      const resolved = (saved.plan as Plan).resolvedAgent;
      const binding = resolved?.tools.find(item => item.modelName === intent.name);
      let command: TeachingPreparedTool, outcome: TeachingToolOutcome | null = null;
      try {
        if (stopped) throw new StorageError('forbidden');
        if (resolved && !binding) throw new StorageError('forbidden');
        if (binding && !compileOutputSchema(binding.definition.inputSchema)(intent.arguments)) throw new StorageError('invalid');
        if (binding) await assertCurrentBinding(scope, binding);
        const fixedIntent = binding ? { ...intent, name: binding.executor.toolName } : intent;
        if (fixedIntent.name === studentAskDefinition.name) command = prepareStudentAsk(scope, fixedIntent, commandId);
        else if (binding?.source.sourceId === 'platform.tools') {
          const frozenOutcome = fixedIntent.name === 'read_tool_result' ? undefined : await discoveryOutcome(storage, scope, fixedIntent.name, fixedIntent.arguments,
            permittedContributions(await toolContributions(owner.tools, scope), resolved!.definition));
          command = { version: 1, commandId, name: fixedIntent.name,
            arguments: structuredClone(fixedIntent.arguments), effect: 'read', location: 'owner', conflictKey: run.activityId,
            basis: { executorBinding: binding, ...(frozenOutcome ? { frozenOutcome } : {}), scope: { identity: scope.identity, activityId: run.activityId, runId: run.runId } } };
        }
        else {
          if (!owner.tools) throw new StorageError('forbidden');
          command = await owner.tools.prepare(scope, fixedIntent, commandId);
        }
      } catch (error) {
        if (!(error instanceof StorageError) || !['forbidden', 'invalid', 'missing', 'identity-conflict', 'unavailable'].includes(error.code)) throw error;
        command = { version: 1, commandId, name: teachingExplanationText(scope.activity, intent.name) === intent.name ? intent.name : 'unsupported_tool',
          arguments: teachingPublicArguments(scope.activity, intent.arguments), effect: 'read',
          conflictKey: run.activityId, location: 'owner', basis: { rejected: error.code } };
        outcome = unsent(error.code);
      }
      return { command, bindingId: binding?.bindingId ?? null,
        outcome: stopped ? unsent('run-stopped-before-dispatch') : outcome, callId: intent.callId, ordinal };
    }));
    await transaction(run, generation, async tx => {
      const { rows: [existing] } = await tx.query('SELECT phase FROM teaching_steps WHERE step_id=$1 FOR UPDATE', [saved.step_id]);
      if (existing?.phase !== 'model') return;
      const { rows: [budget] } = await tx.query('SELECT * FROM teaching_budgets WHERE run_id=$1 FOR UPDATE', [run.runId]);
      const { rows: [used] } = await tx.query('SELECT count(*)::integer AS total FROM teaching_commands WHERE run_id=$1', [run.runId]);
      const { rows: [current] } = await tx.query('SELECT stop_requested FROM teaching_runs WHERE run_id=$1', [run.runId]);
      if (publicText) await event(tx, run.activityId, 'assistant', { runId: run.runId, attemptId: saved.attempt_id,
        segmentId: saved.segment_id, resultRef: fact.resultRef, text: publicText, usage: fact.usage,
        model: (saved.plan as Plan).model, modelSource: fact.source?.kind ?? (saved.plan as Plan).modelSource,
        state: current?.stop_requested ? 'stopped' : 'settled' });
      for (const item of prepared) {
        const outcome = current?.stop_requested ? unsent('run-stopped-before-dispatch')
          : Number(used?.total) + item.ordinal >= Number(budget?.max_tool_commands) ? unsent('tool-budget-exhausted') : item.outcome;
        await tx.query(`INSERT INTO teaching_commands(command_id,run_id,step_id,call_id,ordinal,command,state,outcome,initial_outcome,binding_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)`, [item.command.commandId, run.runId, saved.step_id, item.callId, item.ordinal,
          JSON.stringify(item.command), outcome ? 'settled' : 'prepared', outcome ? JSON.stringify(outcome) : null, item.bindingId]);
        await event(tx, run.activityId, 'tool-intent', { runId: run.runId, stepId: saved.step_id, snapshotId: saved.snapshot_id,
          attemptId: saved.attempt_id, resultRef: fact.resultRef, callId: item.callId, command: item.command });
      }
      await tx.query("UPDATE teaching_steps SET phase='tools',result_ref=$2,usage=$3,output_settled=$4 WHERE step_id=$1",
        [saved.step_id, fact.resultRef, JSON.stringify(fact.usage), fact.usage.outputTokens ?? null]);
      if (summary) await event(tx, run.activityId, 'native-summary', { runId: run.runId, attemptId: saved.attempt_id,
        resultRef: fact.resultRef, ...summary });
      await event(tx, run.activityId, 'step-completed', { runId: run.runId, stepId: saved.step_id,
        attemptId: saved.attempt_id, resultRef: fact.resultRef, toolCommands: prepared.map(item => item.command.commandId) });
      await event(tx, run.activityId, 'budget-settled', { runId: run.runId, stepId: saved.step_id, usage: fact.usage,
        unknownReservationHeld: fact.usage.state !== 'final' || fact.usage.outputTokens === undefined || fact.usage.inputTokens === undefined });
      const { rows: usages } = await tx.query('SELECT usage FROM teaching_steps WHERE run_id=$1 ORDER BY step_no', [run.runId]);
      await tx.query('UPDATE teaching_runs SET usage=$2 WHERE run_id=$1',
        [run.runId, JSON.stringify(combinedUsage(usages.map(row => row.usage as ModelUsage ?? { state: 'unknown' })))]);
    });
    return true;
  }
  async function settleUsage(run: TeachingRun, generation: number, saved: Row, fact: ModelAttempt, phase: string) {
    await transaction(run, generation, async tx => {
      const { rows: updated } = await tx.query('UPDATE teaching_steps SET phase=$2,result_ref=$3,usage=$4,output_settled=$5 WHERE step_id=$1 AND usage IS NULL RETURNING step_id',
        [saved.step_id, phase, fact.resultRef, JSON.stringify(fact.usage), fact.usage.outputTokens ?? null]);
      if (updated.length) await event(tx, run.activityId, 'budget-settled', { runId: run.runId, stepId: saved.step_id, usage: fact.usage,
        unknownReservationHeld: fact.usage.state !== 'final' || fact.usage.outputTokens === undefined || fact.usage.inputTokens === undefined });
      const { rows: usages } = await tx.query('SELECT usage FROM teaching_steps WHERE run_id=$1 ORDER BY step_no', [run.runId]);
      await tx.query('UPDATE teaching_runs SET usage=$2 WHERE run_id=$1',
        [run.runId, JSON.stringify(combinedUsage(usages.map(row => row.usage as ModelUsage ?? { state: 'unknown' })))]);
    });
  }

  async function createWait(tx: OwnedTransaction, run: TeachingRun, saved: Row, command: TeachingPreparedTool,
    outcome: TeachingToolOutcome, purpose: 'result' | 'cleanup') {
    const waitId = operationId((purpose === 'cleanup' ? 'teaching-cleanup-wait:' : 'teaching-wait:') + command.commandId);
    const { rows: [budget] } = await tx.query('SELECT wait_ms FROM teaching_budgets WHERE run_id=$1', [run.runId]);
    const { rows: waits } = await tx.query(`INSERT INTO teaching_waits(wait_id,run_id,step_id,command_id,purpose,state,reason,
      identity,command_digest,deadline,next_check_at) VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$8,
      LEAST((SELECT deadline FROM teaching_budgets WHERE run_id=$2),
        COALESCE((SELECT deadline FROM teaching_waits WHERE command_id=$4 AND purpose='result'),
        clock_timestamp()+($9 || ' milliseconds')::interval)),clock_timestamp()+interval '1 second')
      ON CONFLICT(command_id,purpose) DO NOTHING RETURNING wait_id`, [waitId, run.runId, saved.step_id, command.commandId, purpose,
      purpose === 'cleanup' ? 'cleanup' : outcome.state === 'unknown' ? 'unknown' : command.location === 'browser' ? 'browser' : 'execution',
      JSON.stringify(owner.identity(await runInTransaction(tx, run.runId))), canonicalDigest(command), String(budget?.wait_ms ?? limits.waitMs)]);
    if (waits.length) await event(tx, run.activityId, 'wait-created', { runId: run.runId, stepId: saved.step_id,
      commandId: command.commandId, waitId, purpose, execution: outcome.execution ?? null });
  }
  async function saveOutcome(run: TeachingRun, saved: Row, row: Row, outcome: TeachingToolOutcome,
    generation?: number) {
    const command = row.command as unknown as TeachingPreparedTool;
    outcome = projectToolOutcome(outcome, command.commandId);
    const bytes = Buffer.from(JSON.stringify(outcome));
    const uploadId = operationId('tool-result:' + command.commandId + ':' + canonicalDigest(outcome));
    const resource = await storage.stageResource({ uploadId, scope: 'teaching-tool:' + command.commandId,
      bytes, mediaType: 'application/json', contentVersion: 1 });
    await storage.request({ requestId: 'teaching-tool-result:' + uploadId, fingerprint: canonicalDigest(outcome) }, async tx => {
      if (generation !== undefined) await owner.assertAuthority(tx, run.runId, generation);
      const { rows: [current] } = await tx.query('SELECT state,outcome FROM teaching_commands WHERE command_id=$1 FOR UPDATE', [command.commandId]);
      if (!current || current.state === 'settled') return null;
      await tx.query(`UPDATE teaching_commands SET state=$2,outcome=$3,initial_outcome=COALESCE(initial_outcome,$3),
        resource_id=$4,updated_at=clock_timestamp() WHERE command_id=$1`,
        [command.commandId, pending(outcome) ? 'waiting' : 'settled', JSON.stringify(outcome), resource.resourceId]);
      await tx.reference('teaching-tool-result:' + uploadId, resource.resourceId);
      await event(tx, run.activityId, 'tool-result', { runId: run.runId, stepId: saved.step_id,
        commandId: command.commandId, callId: row.call_id, resourceId: resource.resourceId, outcome });
      if (pending(outcome)) {
        await createWait(tx, run, saved, command, outcome, 'result');
      } else {
        const { rows: consumed } = await tx.query(`UPDATE teaching_waits SET state='consumed',consumed_at=clock_timestamp()
          WHERE command_id=$1 AND purpose='result' AND state IN ('pending','expired') RETURNING wait_id`, [command.commandId]);
        if (consumed.length) await event(tx, run.activityId, 'wait-consumed', { runId: run.runId, stepId: saved.step_id,
          commandId: command.commandId, waitId: consumed[0]!.wait_id, terminalRun: terminal((await runInTransaction(tx, run.runId)).state) });
      }
      return null;
    });
  }
  async function pairTools(run: TeachingRun, generation: number, saved: Row, identity: SpaceIdentity, known: Row[]) {
    if (saved.paired) return;
    // Reuse the original fixed settlement even when its reply was lost. Completion/expiry
    // is a separate fact; it cannot change an already accepted native call-pair body.
    await owner.models.segments.settle(identity, String(saved.segment_id), {
      requestId: operationId('teaching-pair:' + saved.step_id), expectedSequence: (saved.plan as unknown as Plan).input.expectedSequence + 1,
      results: known.map(row => ({ callId: row.call_id, ...(row.initial_outcome as TeachingToolOutcome).feedback })),
    });
    if (saved.result_ref) await owner.models.results?.retain(identity, {
      requestId: operationId('retain-model:' + run.runId + ':' + saved.result_ref), resultRef: String(saved.result_ref),
      consumer: 'run', consumerId: run.runId });
    await transaction(run, generation, async tx => {
      const { rows: updated } = await tx.query('UPDATE teaching_steps SET paired=true WHERE step_id=$1 AND paired=false RETURNING step_id', [saved.step_id]);
      if (updated.length) await event(tx, run.activityId, 'tools-paired', { runId: run.runId, stepId: saved.step_id,
        attemptId: saved.attempt_id, commandIds: known.map(row => row.command_id) });
    });
  }
  async function advanceTools(run: TeachingRun, generation: number, saved: Row, scope: TeachingToolScope) {
    async function supersededBeforePermit(tx: OwnedTransaction, row: Row) {
      const direction = await owner.inputs.newerDirection(tx, run, (saved.plan as Plan).inputSequence);
      if (!direction) return false;
      const outcome = unsent('steering-before-dispatch');
      outcome.feedback.text = '学生已补充方向，尚未取得许可的旧操作未执行。';
      const { rows: closed } = await tx.query(`UPDATE teaching_commands SET state='settled',outcome=$2,initial_outcome=$2,
        updated_at=clock_timestamp() WHERE command_id=$1 AND state='prepared' RETURNING command_id`,
        [row.command_id, JSON.stringify(outcome)]);
      if (closed.length) await event(tx, run.activityId, 'tool-result', { runId: run.runId, stepId: saved.step_id,
        commandId: row.command_id, callId: row.call_id, blockedByInputId: direction.inputId, outcome });
      return true;
    }
    const rows = await commands(String(saved.step_id));
    for (const row of rows) {
      const command = row.command as unknown as TeachingPreparedTool;
      const stopped = owner.toRun(await owner.runRow(run.runId)).stopRequested;
      if (row.state === 'prepared') {
        if (stopped) { await saveOutcome(run, saved, row, unsent('run-stopped-before-dispatch'), generation); continue; }
        if (command.name === studentAskDefinition.name) {
          await assertDispatch(run, generation);
          await transaction(run, generation, async tx => {
            if (await supersededBeforePermit(tx, row)) return;
            const { rows: [current] } = await tx.query('SELECT state FROM teaching_commands WHERE command_id=$1 FOR UPDATE', [command.commandId]);
            const { rows: [runRow] } = await tx.query('SELECT stop_requested FROM teaching_runs WHERE run_id=$1', [run.runId]);
            if (current?.state !== 'prepared' || runRow?.stop_requested) return;
            await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['teaching-tool-lanes']);
            const { rows: conflicts } = await tx.query(`SELECT c.command_id FROM teaching_commands c JOIN teaching_runs r USING(run_id)
              WHERE c.state IN ('dispatching','waiting') AND c.command_id<>$1
              AND (c.run_id=$2 OR (r.identity->>'principalId'=$3 AND c.command->>'conflictKey'=$4)) LIMIT 1`,
              [command.commandId, run.runId, scope.identity.principalId, command.conflictKey]);
            if (conflicts.length) return;
            await event(tx, run.activityId, 'tool-permitted', { runId: run.runId, stepId: saved.step_id,
              commandId: command.commandId, generation, effect: command.effect, location: command.location });
            await owner.studentQuestions.open(tx, run, saved, command);
          });
          continue;
        }
        if (!owner.tools && !registryCommand(command)) throw new StorageError('forbidden');
        await assertDispatch(run, generation);
        let permitted = false;
        await transaction(run, generation, async tx => {
          if (await supersededBeforePermit(tx, row)) return;
          const { rows: [current] } = await tx.query('SELECT stop_requested FROM teaching_runs WHERE run_id=$1', [run.runId]);
          if (current?.stop_requested) return;
          // A conservative serial lane is valid for all component effects. Its lock is owned by
          // the Agent command ledger and survives loss of the in-memory driver.
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['teaching-tool-lanes']);
          const { rows: conflicts } = await tx.query(`SELECT c.command_id FROM teaching_commands c JOIN teaching_runs r USING(run_id)
            WHERE c.state IN ('dispatching','waiting') AND c.command_id<>$1
            AND (c.run_id=$2 OR (r.identity->>'principalId'=$3 AND c.command->>'conflictKey'=$4)) LIMIT 1`,
            [command.commandId, run.runId, scope.identity.principalId, command.conflictKey]);
          if (conflicts.length) return;
          const { rows: updated } = await tx.query(`UPDATE teaching_commands SET state='dispatching',generation=$2,
            updated_at=clock_timestamp() WHERE command_id=$1 AND state='prepared' RETURNING command_id`, [command.commandId, generation]);
          if (!updated.length) return;
          permitted = true;
          await event(tx, run.activityId, 'tool-permitted', { runId: run.runId, stepId: saved.step_id,
            commandId: command.commandId, generation, authority: scope.authority, effect: command.effect, location: command.location });
        });
        if (!permitted) continue;
        await assertDispatch(run, generation);
        const resolved = (saved.plan as Plan).resolvedAgent;
        if (resolved) {
          const binding = resolved.tools.find(item => item.bindingId === row.binding_id);
          try {
            if (!binding) throw new StorageError('forbidden');
            await assertCurrentBinding(scope, binding);
          } catch (error) {
            if (!(error instanceof StorageError)) throw error;
            await saveOutcome(run, saved, row, unsent('capability-unavailable:' + error.code), generation);
            continue;
          }
        }
        let outcome: TeachingToolOutcome;
        try {
          if (registryCommand(command)) {
            outcome = await internalToolOutcome(scope, command, (saved.plan as Plan).resolvedAgent!.definition);
          } else outcome = await owner.tools!.dispatch(scope, command);
        }
        catch (error) {
          // A failed source read has no mutating effect to reconcile. An effectful operation's
          // exception may instead be a lost acceptance reply and must keep its original identity.
          outcome = command.effect === 'read' && error instanceof StorageError ? {
            state: 'failed', feedback: { outcome: 'error', text: '固定来源读取失败：' + error.code, images: [] },
            result: { sourceState: error.code === 'missing' ? 'missing' : error.code === 'corrupt' ? 'corrupt' : 'unavailable',
              reason: error.code }, source: { label: '固定来源' },
          } : { state: 'unknown', feedback: { outcome: 'error', text: '原命令回执未确认，正在按原身份核对；未重新执行。', images: [] },
            result: { reason: error instanceof StorageError ? error.code : 'receipt-unconfirmed', commandId: command.commandId },
            source: { label: '原命令核对' } };
        }
        await saveOutcome(run, saved, row, outcome, generation);
      } else if (row.state === 'dispatching') {
        // A previous worker could have lost its reply. Only read the original command identity.
        let known: TeachingToolOutcome | null | undefined;
        if (registryCommand(command)) {
          if (stopped) known = unsent('run-stopped-before-read-recovery');
          else try { known = await internalToolOutcome(scope, command, (saved.plan as Plan).resolvedAgent!.definition); }
          catch (error) {
            if (!(error instanceof StorageError)) throw error;
            known = { state: 'failed', feedback: { outcome: 'error', text: error.code, images: [] },
              result: { reason: error.code }, source: { label: '固定目录或原件读取' } };
          }
        } else known = await owner.tools?.reconcile(scope, command);
        await saveOutcome(run, saved, row, known ?? { state: 'unknown', feedback: { outcome: 'error',
          text: '原命令效果尚未确认；查无记录不作为重跑依据。', images: [] },
          result: { commandId: command.commandId, reason: 'original-command-unknown' }, source: { label: '原命令核对' } }, generation);
      } else if (row.state === 'waiting' && stopped) {
        const known = await owner.tools?.stop(scope, command);
        if (known) await saveOutcome(run, saved, row, known, generation);
      }
    }
    const known = await commands(String(saved.step_id));
    if (known.some(row => !row.initial_outcome)) {
      await transaction(run, generation, async tx => {
        await tx.query("UPDATE teaching_steps SET phase='waiting' WHERE step_id=$1", [saved.step_id]);
        await tx.query(`UPDATE teaching_runs SET state='waiting',lease_owner=NULL,lease_expires_at=NULL,
          updated_at=clock_timestamp() WHERE run_id=$1`, [run.runId]);
      });
      return false;
    }
    await pairTools(run, generation, saved, scope.identity, known);
    const current = owner.toRun(await owner.runRow(run.runId));
    if (current.stopRequested) {
      await owner.finish(run, generation, 'stopped', 'stop-requested', current.usage, current.model,
        { kind: 'run-stopped', body: { runId: run.runId, pendingCommands: known.filter(row => row.state !== 'settled').map(row => row.command_id) } });
      return false;
    }
    if (known.some(row => (row.outcome as TeachingToolOutcome | null)?.result.reason === 'tool-budget-exhausted')) {
      await pause(current, generation, 'tool-budget-exhausted');
      return false;
    }
    if (known.some(row => row.state !== 'settled')) {
      let steering = false;
      await transaction(run, generation, async tx => {
        steering = await owner.inputs.hasSteering(tx, run);
        if (steering) {
          await tx.query("UPDATE teaching_steps SET phase='completed' WHERE step_id=$1", [saved.step_id]);
          await tx.query("UPDATE teaching_runs SET state='running',updated_at=clock_timestamp() WHERE run_id=$1", [run.runId]);
          return;
        }
        await tx.query("UPDATE teaching_steps SET phase='waiting' WHERE step_id=$1", [saved.step_id]);
        await tx.query(`UPDATE teaching_runs SET state='waiting',lease_owner=NULL,lease_expires_at=NULL,
          updated_at=clock_timestamp() WHERE run_id=$1`, [run.runId]);
      });
      return steering;
    }
    await transaction(run, generation, async tx => { await tx.query("UPDATE teaching_steps SET phase='completed' WHERE step_id=$1", [saved.step_id]); });
    return true;
  }
  async function finishExpiredQuestionRun(run: TeachingRun, generation: number) {
    const saved = await step(run.runId);
    if (!saved) throw new StorageError('corrupt');
    for (const row of await commands(String(saved.step_id))) if (row.state === 'prepared')
      await saveOutcome(run, saved, row, unsent('student-response-expired'), generation);
    const known = await commands(String(saved.step_id));
    if (known.some(row => !row.initial_outcome)) throw new StorageError('corrupt');
    try { await pairTools(run, generation, saved, owner.identity(await owner.runRow(run.runId)), known); }
    catch (error) {
      if (!(error instanceof StorageError) || !['forbidden', 'maintenance', 'unavailable', 'resource-busy'].includes(error.code)) throw error;
      // Retry only the original owner write after authority/service recovery, never a generation.
      await transaction(run, generation, async tx => {
        await tx.query("UPDATE teaching_runs SET state='waiting',lease_owner=NULL,lease_expires_at=NULL WHERE run_id=$1", [run.runId]);
      });
      return;
    }
    await transaction(run, generation, async tx => {
      const { rows: [current] } = await tx.query('SELECT state,stop_requested FROM teaching_runs WHERE run_id=$1', [run.runId]);
      if (!current || terminal(current.state)) return;
      const stopped = current.stop_requested === true;
      await tx.query("UPDATE teaching_steps SET phase='completed' WHERE step_id=$1", [saved.step_id]);
      await tx.query(`UPDATE teaching_runs SET state=$2,reason=$3,completed_at=clock_timestamp(),updated_at=clock_timestamp(),
        lease_owner=NULL,lease_expires_at=NULL WHERE run_id=$1`, [run.runId, stopped ? 'stopped' : 'paused', stopped ? 'stop-requested' : 'student-response-expired']);
      await event(tx, run.activityId, stopped ? 'run-stopped' : 'system-notice', { runId: run.runId,
        reason: stopped ? 'stop-requested' : 'student-response-expired', nativeToolsPaired: true });
      await owner.inputs.afterFinish(tx, run, stopped ? 'stopped' : 'paused', stopped ? 'stop-requested' : 'student-response-expired');
    });
  }
  async function execute(initial: TeachingRun, generation: number) {
    let run = initial;
    for (;;) {
      const current = await owner.runRow(run.runId);
      run = owner.toRun(current);
      if (terminal(run.state)) return;
      if (run.reason === 'wait-expired') {
        await pause(run, generation, 'wait-expired');
        await stopTools(owner.toRun(await owner.runRow(run.runId))); return;
      }
      if (await expired(run.runId)) {
        const saved = await step(run.runId);
        if (saved?.phase !== 'model' && saved?.phase !== 'final') {
          if (saved) {
            for (const row of await commands(String(saved.step_id))) if (row.state === 'prepared')
              await saveOutcome(run, saved, row, unsent('run-deadline-exceeded'), generation);
            const known = await commands(String(saved.step_id));
            if (known.length && known.every(row => row.initial_outcome))
              await pairTools(run, generation, saved, owner.identity(current), known);
          }
          await pause(run, generation, 'run-deadline-exceeded');
          await stopTools(owner.toRun(await owner.runRow(run.runId))); return;
        }
      }
      if (run.stopRequested) await stopTools(run);
      if (run.reason === 'student-response-expired') { await finishExpiredQuestionRun(run, generation); return; }
      const identity = owner.identity(current);
      await owner.authorize(identity);
      let saved = await step(run.runId);
      if (!saved && run.attemptId) {
        // An older or damaged record is not evidence that its original paid attempt never ran.
        // Preserve that identity instead of manufacturing a new model plan on recovery.
        await pause(run, generation, 'step-record-unavailable');
        return;
      }
      if (!saved || saved.phase === 'completed') {
        if (run.stopRequested) {
          await owner.finish(run, generation, 'stopped', 'stop-requested', run.usage, run.model,
            { kind: 'run-stopped', body: { runId: run.runId } }); return;
        }
        const planned = await planNext(run, generation, saved);
        if (!planned) return;
        saved = planned;
      }
      const scope = await scopeFor(run, saved, generation);
      if (saved.phase === 'planned') {
        if (run.stopRequested) {
          // The planned identity may already have been received before a storage failure.
          await owner.models.checks.cancel(identity, String(saved.attempt_id)).catch(error => {
            if (!(error instanceof StorageError) || error.code !== 'missing') throw error;
          });
          await owner.finish(run, generation, 'stopped', 'stop-requested', run.usage, run.model,
            { kind: 'run-stopped', body: { runId: run.runId } }); return;
        }
        await receiveModel(run, generation, saved, scope);
        saved = (await step(run.runId))!;
      }
      if (saved.phase === 'model' || saved.phase === 'final') {
        if (!await modelResult(run, generation, saved, scope)) return;
        saved = (await step(run.runId))!;
      }
      if (saved.phase === 'tools' || saved.phase === 'waiting') {
        if (!await advanceTools(run, generation, saved, scope)) return;
      }
    }
  }

  async function saveCleanup(run: TeachingRun, row: Row, stopped: TeachingToolOutcome) {
    const command = row.command as unknown as TeachingPreparedTool;
    // Cleanup owns only this additional fact; the completed operation and its model pair stay settled.
    const original = row.outcome as TeachingToolOutcome;
    const updated = { ...original, result: { ...original.result, stoppedExecution: stopped.result } };
    const uploadId = operationId('tool-cleanup:' + command.commandId + ':' + canonicalDigest(updated));
    const resource = await storage.stageResource({ uploadId, scope: 'teaching-tool:' + command.commandId,
      bytes: Buffer.from(JSON.stringify(updated)), mediaType: 'application/json', contentVersion: 1 });
    await storage.request({ requestId: 'teaching-tool-cleanup:' + uploadId, fingerprint: canonicalDigest(updated) }, async tx => {
      const { rows: [current] } = await tx.query('SELECT state,outcome FROM teaching_commands WHERE command_id=$1 FOR UPDATE', [command.commandId]);
      if (!current || current.state !== 'settled') return null;
      const { rows: [wait] } = await tx.query("SELECT state FROM teaching_waits WHERE command_id=$1 AND purpose='cleanup'", [command.commandId]);
      // A previous terminal cleanup (with or without a Wait) cannot be overwritten by a late check.
      if ((current.outcome as TeachingToolOutcome).result.stoppedExecution && (!wait || wait.state === 'consumed')) return null;
      if (canonicalDigest(current.outcome) !== canonicalDigest(updated)) {
        await tx.query('UPDATE teaching_commands SET outcome=$2,resource_id=$3,updated_at=clock_timestamp() WHERE command_id=$1',
          [command.commandId, JSON.stringify(updated), resource.resourceId]);
        await tx.reference('teaching-tool-cleanup:' + uploadId, resource.resourceId);
        await event(tx, run.activityId, 'tool-result', { runId: run.runId, commandId: command.commandId,
          phase: 'stop-original-execution', outcome: stopped });
      }
      if (pending(stopped)) await createWait(tx, run, row, command, stopped, 'cleanup');
      else {
        const { rows: consumed } = await tx.query(`UPDATE teaching_waits SET state='consumed',consumed_at=clock_timestamp()
          WHERE command_id=$1 AND purpose='cleanup' AND state IN ('pending','expired') RETURNING wait_id`, [command.commandId]);
        if (consumed.length) await event(tx, run.activityId, 'wait-consumed', { runId: run.runId, stepId: row.step_id,
          commandId: command.commandId, waitId: consumed[0]!.wait_id, purpose: 'cleanup',
          terminalRun: terminal((await runInTransaction(tx, run.runId)).state) });
      }
      return null;
    });
  }
  async function stopTools(run: TeachingRun) {
    await owner.studentQuestions.cancelRun(run);
    if (!owner.tools) return;
    const { rows } = await storage.read(`SELECT c.*,s.snapshot_id,s.segment_id FROM teaching_commands c
      JOIN teaching_steps s USING(step_id) WHERE c.run_id=$1 AND c.command->>'effect' IN ('execute','input') ORDER BY c.created_at`, [run.runId]);
    for (const row of rows) {
      if (row.state === 'prepared') continue;
      const scope = cleanupScopeFor(run, row);
      const command = row.command as unknown as TeachingPreparedTool;
      const stopped = await owner.tools.stop(scope, command);
      if (!stopped) continue;
      if (row.state !== 'settled') await saveOutcome(run, row, row, stopped);
      else await saveCleanup(run, row, stopped);
    }
  }

  /** Bounded deterministic queries; no model connection or long-lived Run worker is held. */
  async function pollWaits() {
    await owner.studentQuestions.expire();
    const { rows } = await storage.read(`SELECT w.*,r.state AS run_state FROM teaching_waits w JOIN teaching_runs r USING(run_id)
      WHERE w.state IN ('pending','expired') AND w.reason<>'student' AND w.next_check_at<=clock_timestamp() ORDER BY w.next_check_at,w.wait_id LIMIT 20`);
    const awakened = new Set<string>();
    for (const wait of rows) {
      const run = owner.toRun(await owner.runRow(String(wait.run_id)));
      const { rows: [saved] } = await storage.read('SELECT * FROM teaching_steps WHERE step_id=$1', [wait.step_id]);
      const { rows: [row] } = await storage.read('SELECT * FROM teaching_commands WHERE command_id=$1', [wait.command_id]);
      if (!saved || !row) throw new StorageError('corrupt');
      const command = row.command as unknown as TeachingPreparedTool;
      if (canonicalDigest(command) !== wait.command_digest) throw new StorageError('corrupt');
      try {
        const cleanup = wait.purpose === 'cleanup';
        let outcome: TeachingToolOutcome | null | undefined;
        if (cleanup || run.stopRequested) outcome = await owner.tools?.stop(cleanupScopeFor(run, { ...row, snapshot_id: saved.snapshot_id, segment_id: saved.segment_id }), command);
        else {
          try { outcome = await owner.tools?.reconcile(await scopeFor(run, saved), command); }
          catch (error) {
            if (!(error instanceof StorageError) || !['forbidden', 'missing'].includes(error.code)) throw error;
            outcome = await owner.tools?.stop(cleanupScopeFor(run, { ...row, snapshot_id: saved.snapshot_id, segment_id: saved.segment_id }), command);
          }
        }
        if (cleanup && outcome) await saveCleanup(run, row, outcome);
        if (outcome && !pending(outcome)) {
          if (!cleanup) {
            await saveOutcome(run, saved, row, outcome);
            if (wait.state !== 'expired' && !terminal(run.state)) awakened.add(run.runId);
          }
          continue;
        }
      } catch (error) {
        if (!(error instanceof StorageError) || !['missing', 'forbidden', 'resource-busy', 'maintenance'].includes(error.code)) throw error;
      }
      await storage.request({ requestId: 'teaching-wait-check:' + randomUUID(), fingerprint: String(wait.wait_id) }, async tx => {
        const { rows: [updated] } = await tx.query(`UPDATE teaching_waits SET checks=checks+1,
          next_check_at=clock_timestamp()+(LEAST(30,checks+1)::text || ' seconds')::interval,
          state=CASE WHEN deadline<=clock_timestamp() THEN 'expired' ELSE state END
          WHERE wait_id=$1 AND state=$2 AND next_check_at<=clock_timestamp() RETURNING state`, [wait.wait_id, wait.state]);
        if (wait.state === 'pending' && updated?.state === 'expired') {
          await event(tx, run.activityId, 'wait-expired', { runId: run.runId, waitId: wait.wait_id, commandId: wait.command_id });
          // Expiry stops automatic advancement; bounded checks still archive the original result.
          if (wait.purpose === 'result') {
            // A discussion may be generating while its original tool Wait expires. Keep its
            // physical call/lease for truthful settlement, but bar every later dispatch and FIFO.
            await tx.query(`UPDATE teaching_runs SET reason='wait-expired',
              state=CASE WHEN state='waiting' AND lease_owner IS NULL THEN 'paused' ELSE state END,
              completed_at=CASE WHEN state='waiting' AND lease_owner IS NULL THEN clock_timestamp() ELSE completed_at END,
              updated_at=clock_timestamp() WHERE run_id=$1 AND state IN ('received','running','dispatching','waiting')`, [run.runId]);
            await owner.inputs.afterFinish(tx, run, 'paused', 'wait-expired');
          }
        }
        return null;
      });
    }
    return [...awakened];
  }
  async function records(activityId: string) {
    const { rows } = await storage.read(`SELECT c.*,s.snapshot_id,s.plan AS step_plan FROM teaching_commands c JOIN teaching_steps s USING(step_id)
      JOIN teaching_runs r ON r.run_id=c.run_id WHERE r.activity_id=$1 ORDER BY c.created_at,c.ordinal`, [activityId]);
    return rows.map(row => {
      const command = row.command as unknown as TeachingPreparedTool, outcome = row.outcome as TeachingToolOutcome | null;
      const binding = (row.step_plan as Plan).resolvedAgent?.tools.find(item => item.bindingId === row.binding_id);
      return teachingToolRecordSchema.parse({ commandId: row.command_id, runId: row.run_id, stepId: row.step_id,
        snapshotId: row.snapshot_id, callId: row.call_id, name: command.name, version: command.version, state: row.state,
        effect: command.effect, location: command.location, arguments: command.arguments,
        basis: { ...Object.fromEntries(Object.entries(command.basis).filter(([key]) => !['scope', 'frozenOutcome'].includes(key))),
          ...(binding ? { capability: { bindingId: binding.bindingId, source: binding.source, executor: binding.executor } } : {}) },
        outcome: outcome?.state ?? null, feedback: outcome?.feedback.text ?? '', result: outcome?.result ?? null,
        source: outcome?.source ?? null, createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString() });
    });
  }
  async function waits(activityId: string) {
    const { rows } = await storage.read('SELECT w.* FROM teaching_waits w JOIN teaching_runs r USING(run_id) WHERE r.activity_id=$1 ORDER BY w.deadline', [activityId]);
    return rows.map(row => teachingWaitSchema.parse({ waitId: row.wait_id, runId: row.run_id, stepId: row.step_id,
      commandId: row.command_id, state: row.state, reason: row.reason, deadline: new Date(row.deadline as string).toISOString(),
      nextCheckAt: new Date(row.next_check_at as string).toISOString(), consumedAt: row.consumed_at ? new Date(row.consumed_at as string).toISOString() : null }));
  }
  return { execute, pollWaits, records, waits, stopTools, freezeBudget };
}
