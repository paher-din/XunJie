import { randomUUID } from 'node:crypto';
import { StorageError, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import { actionInputSchema, type ActionInput } from '@xunjie/contracts/action-intents';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import type { ModelAttempt, ModelLearningInput, ModelTool, ModelUsage } from '@xunjie/contracts/model-connections';
import { teachingEventKindSchema, teachingSnapshotSchema, teachingToolRecordSchema, teachingWaitSchema,
  type TeachingRun, type TeachingEventKind, type TeachingSnapshot } from '@xunjie/contracts/teaching-agent';
import type { createModelGateway } from '../model-connections/index.js';
import { buildContext, type ContextMessage } from './context.js';
import { canonicalDigest, operationId } from './identity.js';
import type { TeachingToolHost, TeachingToolScope, TeachingPreparedTool, TeachingToolOutcome } from './tool-types.js';
import { studentAskDefinition, prepareStudentAsk, type createStudentQuestions } from './student-questions.js';

type Row = Record<string, unknown>;
type Event = { kind: TeachingEventKind; body: Record<string, unknown> };
type Model = NonNullable<TeachingRun['model']>;
interface Plan {
  input: ModelLearningInput; model: Model; sources: TeachingSnapshot['sources']; createdAt: string;
}
export interface TeachingRunLimits {
  maxModelSteps: number;
  maxToolCommands: number;
  maxParallelTools: number;
  waitMs: number;
}
const defaultLimits: TeachingRunLimits = { maxModelSteps: 16, maxToolCommands: 64, maxParallelTools: 1, waitMs: 86_400_000 };
const terminal = (state: unknown) => ['completed', 'failed', 'stopped', 'paused'].includes(String(state));
const pending = (outcome: TeachingToolOutcome) => outcome.state === 'accepted' || outcome.state === 'unknown';
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
  models: Awaited<ReturnType<typeof createModelGateway>>;
  tools?: TeachingToolHost;
  studentQuestions: ReturnType<typeof createStudentQuestions>;
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
  ensureSegment(identity: SpaceIdentity, activity: LearningActivity, run: TeachingRun,
    choice: Awaited<ReturnType<Awaited<ReturnType<typeof createModelGateway>>['selection']['snapshot']>>,
    selectionVersion: number, system: string, history: ContextMessage[], generation: number, tools: ModelTool[]):
    Promise<{ segmentId: string; sequence: number; model: Model }>;
  awaitAttempt(identity: SpaceIdentity, run: TeachingRun, generation: number, attemptId: string,
    segmentId: string, initial?: ModelAttempt): Promise<ModelAttempt>;
  finish(run: TeachingRun, generation: number, state: TeachingRun['state'], reason: string, usage: ModelUsage,
    model: TeachingRun['model'], event: Event | null, extras?: Event[]): Promise<void>;
}) {
  const limits = { ...defaultLimits, ...owner.limits };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new StorageError('invalid');
  const event = owner.appendEvent;
  async function transaction(run: TeachingRun, generation: number, effect: (tx: OwnedTransaction) => Promise<void>) {
    await storage.request({ requestId: 'teaching-driver:' + randomUUID(), fingerprint: run.runId }, async tx => {
      await owner.assertAuthority(tx, run.runId, generation);
      await effect(tx);
      return null;
    });
  }
  async function assertDispatch(run: TeachingRun, generation: number) {
    if (owner.dispatchClosed()) throw new StorageError('maintenance');
    await owner.authorize(owner.identity(await owner.runRow(run.runId)));
    const { rows: log } = await storage.read(`SELECT s.next_seq,e.seq,e.kind,e.event_version FROM teaching_sessions s
      LEFT JOIN teaching_events e USING(activity_id) WHERE s.activity_id=$1 ORDER BY e.seq`, [run.activityId]);
    if (!log.length || log.some((row, index) => Number(row.seq) !== index + 1 || row.event_version !== 1
      || !teachingEventKindSchema.safeParse(row.kind).success) || Number(log[0]!.next_seq) !== log.length + 1)
      throw new StorageError('corrupt');
    await transaction(run, generation, async tx => {
      const { rows: [row] } = await tx.query('SELECT stop_requested,state FROM teaching_runs WHERE run_id=$1', [run.runId]);
      if (!row || row.stop_requested || terminal(row.state)) throw new StorageError('conflict');
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
  async function scopeFor(run: TeachingRun, saved: Row, generation?: number): Promise<TeachingToolScope> {
    const identity = owner.identity(await owner.runRow(run.runId));
    const request = await owner.requestRow(run.requestId);
    if (!request) throw new StorageError('corrupt');
    return { identity, activity: await owner.activity(identity, run.activityId), input: actionInputSchema.parse(request.body),
      runId: run.runId, stepId: String(saved.step_id), snapshotId: String(saved.snapshot_id),
      ...(typeof saved.segment_id === 'string' ? { segmentId: saved.segment_id } : {}),
      ...(generation === undefined ? {} : { assertDispatch: () => assertDispatch(run, generation) }) };
  }
  async function pause(run: TeachingRun, generation: number, reason: string, model = run.model) {
    const current = owner.toRun(await owner.runRow(run.runId));
    await owner.finish(run, generation, 'paused', reason, current.usage, model ?? current.model,
      { kind: ['model-not-selected', 'model-unavailable', 'model-capability-unavailable', 'max-output-missing'].includes(reason) ? 'model-unavailable' : 'system-notice',
        body: { runId: run.runId, reason } });
  }
  async function planNext(run: TeachingRun, generation: number, previous?: Row) {
    const scope = await scopeFor(run, previous ?? { step_id: operationId('step:' + run.runId + ':0'), snapshot_id: run.runId });
    if (scope.activity.status !== 'open' || scope.activity.course && scope.activity.course.helpPolicy?.questions !== 'allowed')
      throw new StorageError('forbidden');
    let plan: Plan;
    if (previous) {
      const priorPlan = previous.plan as unknown as Plan;
      const native = await owner.models.segments.read(scope.identity, String(previous.segment_id));
      if (native.pending || native.pendingTools?.length) throw new StorageError('resource-busy');
      const rows = await commands(String(previous.step_id));
      const observations = rows.filter(row => (row.initial_outcome as TeachingToolOutcome | null)?.state === 'accepted'
        || (row.initial_outcome as TeachingToolOutcome | null)?.state === 'unknown').map(row => ({
          observationId: operationId('tool-observation:' + row.command_id), version: 1, source: 'caller' as const,
          text: JSON.stringify({ commandId: row.command_id, source: (row.outcome as TeachingToolOutcome).source,
            state: (row.outcome as TeachingToolOutcome).state, feedback: (row.outcome as TeachingToolOutcome).feedback.text }).slice(0, 8192),
        }));
      const responses: TeachingSnapshot['sources'] = rows.flatMap(row => {
        const command = row.command as TeachingPreparedTool, outcome = row.outcome as TeachingToolOutcome;
        return command.name === studentAskDefinition.name && typeof outcome.result.responseId === 'string'
          ? [{ kind: 'student-response' as const, id: outcome.result.responseId, label: '学生对当前提问的明确回应' }] : [];
      });
      plan = { input: { ...priorPlan.input, expectedSequence: native.sequence,
        input: { text: '', images: [], toolResults: [], observations } }, model: priorPlan.model,
        sources: [...priorPlan.sources, ...responses], createdAt: new Date().toISOString() };
    } else {
      const selection = await owner.models.selection.read(scope.identity);
      if (!selection.selected) { await pause(run, generation, selection.unavailableReason ?? 'model-not-selected'); return null; }
      const choice = await owner.models.selection.snapshot(scope.identity, selection.version);
      const connection = choice.choice.connection;
      if (!connection.maxOutputTokens) { await pause(run, generation, 'max-output-missing'); return null; }
      const history = await owner.historyBefore(run.activityId, run.runId);
      const context = buildContext(scope.activity, scope.input, history, { maxOutputTokens: connection.maxOutputTokens,
        ...(connection.contextWindow !== undefined ? { contextWindow: connection.contextWindow } : {}) });
      if (context.system.length > 400000 || context.userText.length > 1000000) {
        await owner.finish(run, generation, 'paused', 'capacity-exceeded', run.usage, run.model,
          { kind: 'capacity-paused', body: { runId: run.runId, reason: 'capacity-exceeded' } }); return null;
      }
      const tools = [studentAskDefinition, ...(owner.tools ? await owner.tools.definitions(scope) : [])];
      const native = await owner.ensureSegment(scope.identity, scope.activity, run, choice, selection.version,
        context.system, history, generation, tools);
      plan = { input: { attemptId: run.runId, purpose: 'learning', segmentId: native.segmentId, expectedSequence: native.sequence,
        input: { text: context.userText, images: [], toolResults: [], observations: [] }, limits: { maxOutputTokens: connection.maxOutputTokens } },
        model: native.model, sources: context.sources, createdAt: new Date().toISOString() };
    }
    const number = previous ? Number(previous.step_no) + 1 : 0;
    const stepId = operationId(`step:${run.runId}:${number}`), attemptId = operationId('model-attempt:' + stepId);
    plan.input.attemptId = attemptId;
    const snapshotId = operationId('model-snapshot:' + stepId);
    await assertDispatch(run, generation);
    let exhausted = false;
    await transaction(run, generation, async tx => {
      const { rows: [current] } = await tx.query('SELECT stop_requested FROM teaching_runs WHERE run_id=$1', [run.runId]);
      if (current?.stop_requested) throw new StorageError('conflict');
      await tx.query(`INSERT INTO teaching_budgets VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [run.runId, limits.maxModelSteps, limits.maxToolCommands, limits.maxParallelTools, limits.waitMs]);
      const { rows: [budget] } = await tx.query('SELECT * FROM teaching_budgets WHERE run_id=$1 FOR UPDATE', [run.runId]);
      const { rows: [count] } = await tx.query('SELECT count(*)::integer AS total FROM teaching_steps WHERE run_id=$1', [run.runId]);
      if (Number(count?.total) >= Number(budget!.max_model_steps)) { exhausted = true; return; }
      await tx.query(`INSERT INTO teaching_steps(step_id,run_id,step_no,attempt_id,segment_id,snapshot_id,phase,plan,output_reserved)
        VALUES($1,$2,$3,$4,$5,$6,'planned',$7,$8)`, [stepId, run.runId, number, attemptId,
        plan.input.segmentId, snapshotId, JSON.stringify(plan), plan.input.limits.maxOutputTokens]);
      await tx.query(`UPDATE teaching_runs SET attempt_id=$2,segment_id=$3,model=$4,state='running',updated_at=clock_timestamp()
        WHERE run_id=$1`, [run.runId, attemptId, plan.input.segmentId, JSON.stringify(plan.model)]);
      await event(tx, run.activityId, 'budget-reserved', { runId: run.runId, stepId, attemptId,
        modelSteps: 1, outputTokens: plan.input.limits.maxOutputTokens, inputTokens: 'unknown' });
    });
    if (exhausted) { await pause(run, generation, 'model-step-budget-exhausted'); return null; }
    return (await step(run.runId))!;
  }
  async function receiveModel(run: TeachingRun, generation: number, saved: Row, scope: TeachingToolScope) {
    const plan = saved.plan as unknown as Plan;
    await assertDispatch(run, generation);
    await owner.models.checks.receive(scope.identity, plan.input);
    const payload = await owner.models.checks.requestPayload(scope.identity, String(saved.attempt_id));
    const snapshot = teachingSnapshotSchema.parse({ snapshotId: saved.snapshot_id, activityId: run.activityId, runId: run.runId,
      attemptId: saved.attempt_id, segmentId: saved.segment_id, assemblyVersion: 1, model: plan.model,
      maxOutputTokens: plan.input.limits.maxOutputTokens, ...(plan.model.contextWindow ? { contextWindow: plan.model.contextWindow } : {}),
      sources: plan.sources, payloadSha256: canonicalDigest(payload), payload, createdAt: plan.createdAt });
    const resource = await storage.stageResource({ uploadId: snapshot.snapshotId, scope: 'teaching-snapshot:' + snapshot.snapshotId,
      bytes: Buffer.from(JSON.stringify(snapshot)), mediaType: 'application/json', contentVersion: 1 });
    await transaction(run, generation, async tx => {
      await tx.query(`INSERT INTO teaching_snapshots(snapshot_id,activity_id,run_id,attempt_id,segment_id,body,resource_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(snapshot_id) DO NOTHING`, [snapshot.snapshotId, run.activityId, run.runId,
        snapshot.attemptId, snapshot.segmentId, JSON.stringify(snapshot), resource.resourceId]);
      await tx.reference('teaching-snapshot:' + snapshot.snapshotId, resource.resourceId);
      await tx.query("UPDATE teaching_steps SET phase='model' WHERE step_id=$1", [saved.step_id]);
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
      if (current.stopRequested) fact = await owner.models.checks.cancel(scope.identity, fact.attemptId);
      else {
        await assertDispatch(run, generation);
        await transaction(run, generation, async tx => {
          const { rows: [row] } = await tx.query('SELECT stop_requested FROM teaching_runs WHERE run_id=$1', [run.runId]);
          if (row?.stop_requested) throw new StorageError('conflict');
          await tx.query('UPDATE teaching_steps SET dispatch_permitted=true WHERE step_id=$1', [saved.step_id]);
          await tx.query("UPDATE teaching_runs SET state='dispatching',updated_at=clock_timestamp() WHERE run_id=$1", [run.runId]);
          await event(tx, run.activityId, 'attempt-dispatched', { runId: run.runId, stepId: saved.step_id,
            attemptId: fact.attemptId, segmentId: saved.segment_id, expectedSequence: (saved.plan as unknown as Plan).input.expectedSequence });
        });
        await assertDispatch(run, generation);
        fact = await owner.models.checks.dispatch(scope.identity, fact.attemptId);
      }
    }
    fact = await owner.awaitAttempt(scope.identity, run, generation, String(saved.attempt_id), String(saved.segment_id), fact);
    if (!fact.physicalRequestEnded) { await pause(run, generation, 'result-unknown'); return false; }
    if (fact.state === 'completed' && !fact.resultRef) {
      await pause(run, generation, 'native-result-unavailable'); return false;
    }
    const summary = fact.state === 'completed' ? await owner.models.checks.summary?.(scope.identity, fact.attemptId) : null;
    const stopped = owner.toRun(await owner.runRow(run.runId)).stopRequested;
    const intents = fact.state === 'completed' && fact.resultRef && fact.toolIntents?.length ? fact.toolIntents : [];
    if (!intents.length) {
      const state = stopped || fact.state === 'cancelled' ? 'stopped' : fact.state === 'completed' ? 'completed'
        : fact.state === 'unknown' ? 'paused' : 'failed';
      const extras: Event[] = [];
      if (summary) extras.push({ kind: 'native-summary', body: { runId: run.runId, attemptId: saved.attempt_id,
        resultRef: fact.resultRef, ...summary } });
      if (fact.text) extras.push({ kind: 'assistant', body: { runId: run.runId, attemptId: saved.attempt_id,
        segmentId: saved.segment_id, resultRef: fact.resultRef, text: fact.text, usage: fact.usage,
        model: (saved.plan as unknown as Plan).model, state: state === 'completed' ? 'settled' : state === 'stopped' ? 'stopped' : 'failed' } });
      extras.push({ kind: state === 'completed' ? 'run-completed' : state === 'stopped' ? 'run-stopped' : 'run-failed',
        body: { runId: run.runId, attemptId: saved.attempt_id, reason: fact.reason, usage: fact.usage } });
      if (fact.state === 'completed' && fact.resultRef) await owner.models.results?.retain(scope.identity, {
        requestId: operationId('retain-model:' + run.runId + ':' + fact.resultRef), resultRef: fact.resultRef,
        consumer: 'run', consumerId: run.runId });
      await settleUsage(run, generation, saved, fact, 'final');
      const settled = owner.toRun(await owner.runRow(run.runId));
      await owner.finish(run, generation, state, stopped ? 'stop-requested' : fact.reason, settled.usage,
        (saved.plan as unknown as Plan).model, extras.shift()!, extras);
      return false;
    }
    // All prepared commands, the native result association, and step completion share one commit.
    const prepared = await Promise.all(intents.map(async (intent, ordinal) => {
      const commandId = operationId('teaching-command:' + saved.step_id + ':' + intent.callId);
      let command: TeachingPreparedTool, outcome: TeachingToolOutcome | null = null;
      try {
        if (intent.name === studentAskDefinition.name) command = prepareStudentAsk(scope, intent, commandId);
        else {
          if (!owner.tools) throw new StorageError('forbidden');
          command = await owner.tools.prepare(scope, intent, commandId);
        }
      } catch (error) {
        if (!(error instanceof StorageError) || !['forbidden', 'invalid', 'missing', 'identity-conflict'].includes(error.code)) throw error;
        command = { version: 1, commandId, name: intent.name, arguments: intent.arguments, effect: 'read',
          conflictKey: run.activityId, location: 'owner', basis: { rejected: error.code } };
        outcome = unsent(error.code);
      }
      return { command, outcome: stopped ? unsent('run-stopped-before-dispatch') : outcome, callId: intent.callId, ordinal };
    }));
    await transaction(run, generation, async tx => {
      const { rows: [existing] } = await tx.query('SELECT phase FROM teaching_steps WHERE step_id=$1 FOR UPDATE', [saved.step_id]);
      if (existing?.phase !== 'model') return;
      const { rows: [budget] } = await tx.query('SELECT * FROM teaching_budgets WHERE run_id=$1 FOR UPDATE', [run.runId]);
      const { rows: [used] } = await tx.query('SELECT count(*)::integer AS total FROM teaching_commands WHERE run_id=$1', [run.runId]);
      const { rows: [current] } = await tx.query('SELECT stop_requested FROM teaching_runs WHERE run_id=$1', [run.runId]);
      for (const item of prepared) {
        const outcome = current?.stop_requested ? unsent('run-stopped-before-dispatch')
          : Number(used?.total) + item.ordinal >= Number(budget?.max_tool_commands) ? unsent('tool-budget-exhausted') : item.outcome;
        await tx.query(`INSERT INTO teaching_commands(command_id,run_id,step_id,call_id,ordinal,command,state,outcome,initial_outcome)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`, [item.command.commandId, run.runId, saved.step_id, item.callId, item.ordinal,
          JSON.stringify(item.command), outcome ? 'settled' : 'prepared', outcome ? JSON.stringify(outcome) : null]);
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
        unknownReservationHeld: fact.usage.outputTokens === undefined });
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
        unknownReservationHeld: fact.usage.outputTokens === undefined });
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
      COALESCE((SELECT deadline FROM teaching_waits WHERE command_id=$4 AND purpose='result'),
        clock_timestamp()+($9 || ' milliseconds')::interval),clock_timestamp()+interval '1 second')
      ON CONFLICT(command_id,purpose) DO NOTHING RETURNING wait_id`, [waitId, run.runId, saved.step_id, command.commandId, purpose,
      purpose === 'cleanup' ? 'cleanup' : outcome.state === 'unknown' ? 'unknown' : command.location === 'browser' ? 'browser' : 'execution',
      JSON.stringify(owner.identity(await owner.runRow(run.runId))), canonicalDigest(command), String(budget?.wait_ms ?? limits.waitMs)]);
    if (waits.length) await event(tx, run.activityId, 'wait-created', { runId: run.runId, stepId: saved.step_id,
      commandId: command.commandId, waitId, purpose, execution: outcome.execution ?? null });
  }
  async function saveOutcome(run: TeachingRun, saved: Row, row: Row, outcome: TeachingToolOutcome,
    generation?: number) {
    const command = row.command as unknown as TeachingPreparedTool;
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
          commandId: command.commandId, waitId: consumed[0]!.wait_id, terminalRun: terminal((await owner.runRow(run.runId)).state) });
      }
      return null;
    });
  }
  async function advanceTools(run: TeachingRun, generation: number, saved: Row, scope: TeachingToolScope) {
    const rows = await commands(String(saved.step_id));
    for (const row of rows) {
      const command = row.command as unknown as TeachingPreparedTool;
      const stopped = owner.toRun(await owner.runRow(run.runId)).stopRequested;
      if (row.state === 'prepared') {
        if (stopped) { await saveOutcome(run, saved, row, unsent('run-stopped-before-dispatch'), generation); continue; }
        if (command.name === studentAskDefinition.name) {
          await assertDispatch(run, generation);
          await transaction(run, generation, async tx => {
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
        if (!owner.tools) throw new StorageError('forbidden');
        await assertDispatch(run, generation);
        let permitted = false;
        await transaction(run, generation, async tx => {
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
            commandId: command.commandId, generation, effect: command.effect, location: command.location });
        });
        if (!permitted) continue;
        await assertDispatch(run, generation);
        let outcome: TeachingToolOutcome;
        try { outcome = await owner.tools.dispatch(scope, command); }
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
        const known = await owner.tools?.reconcile(scope, command);
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
    if (!saved.paired) {
      // This is an owner write, not a paid model call. Accepted long jobs close the native
      // call pair now; their later result is a separately sourced observation.
      await owner.models.segments.settle(scope.identity, String(saved.segment_id), {
        requestId: operationId('teaching-pair:' + saved.step_id), expectedSequence: (saved.plan as unknown as Plan).input.expectedSequence + 1,
        results: known.map(row => ({ callId: row.call_id, ...(row.initial_outcome as TeachingToolOutcome).feedback })),
      });
      if (saved.result_ref) await owner.models.results?.retain(scope.identity, {
        requestId: operationId('retain-model:' + run.runId + ':' + saved.result_ref), resultRef: String(saved.result_ref),
        consumer: 'run', consumerId: run.runId });
      await transaction(run, generation, async tx => {
        const { rows: updated } = await tx.query('UPDATE teaching_steps SET paired=true WHERE step_id=$1 AND paired=false RETURNING step_id', [saved.step_id]);
        if (updated.length) await event(tx, run.activityId, 'tools-paired', { runId: run.runId, stepId: saved.step_id,
          attemptId: saved.attempt_id, commandIds: known.map(row => row.command_id) });
      });
    }
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
      await transaction(run, generation, async tx => {
        await tx.query("UPDATE teaching_steps SET phase='waiting' WHERE step_id=$1", [saved.step_id]);
        await tx.query(`UPDATE teaching_runs SET state='waiting',lease_owner=NULL,lease_expires_at=NULL,
          updated_at=clock_timestamp() WHERE run_id=$1`, [run.runId]);
      });
      return false;
    }
    await transaction(run, generation, async tx => { await tx.query("UPDATE teaching_steps SET phase='completed' WHERE step_id=$1", [saved.step_id]); });
    return true;
  }
  async function execute(initial: TeachingRun, generation: number) {
    let run = initial;
    for (;;) {
      const current = await owner.runRow(run.runId);
      run = owner.toRun(current);
      if (terminal(run.state)) return;
      if (run.stopRequested) await stopTools(run);
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
          terminalRun: terminal((await owner.runRow(run.runId)).state) });
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
      const scope = await scopeFor(run, { ...row, step_id: row.step_id });
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
        const scope = await scopeFor(run, saved);
        const cleanup = wait.purpose === 'cleanup';
        const outcome = cleanup || run.stopRequested ? await owner.tools?.stop(scope, command) : await owner.tools?.reconcile(scope, command);
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
          if (wait.purpose === 'result') await tx.query(`UPDATE teaching_runs SET state='paused',reason='wait-expired',lease_owner=NULL,lease_expires_at=NULL,
            updated_at=clock_timestamp() WHERE run_id=$1 AND state='waiting'`, [run.runId]);
        }
        return null;
      });
    }
    return [...awakened];
  }
  async function records(activityId: string) {
    const { rows } = await storage.read(`SELECT c.*,s.snapshot_id FROM teaching_commands c JOIN teaching_steps s USING(step_id)
      JOIN teaching_runs r ON r.run_id=c.run_id WHERE r.activity_id=$1 ORDER BY c.created_at,c.ordinal`, [activityId]);
    return rows.map(row => {
      const command = row.command as unknown as TeachingPreparedTool, outcome = row.outcome as TeachingToolOutcome | null;
      return teachingToolRecordSchema.parse({ commandId: row.command_id, runId: row.run_id, stepId: row.step_id,
        snapshotId: row.snapshot_id, callId: row.call_id, name: command.name, version: command.version, state: row.state,
        effect: command.effect, location: command.location, arguments: command.arguments,
        basis: Object.fromEntries(Object.entries(command.basis).filter(([key]) => key !== 'scope')),
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
  return { execute, pollWaits, records, waits, stopTools };
}
