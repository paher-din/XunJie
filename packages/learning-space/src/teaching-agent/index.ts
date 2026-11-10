import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import { actionInputSchema, actionReceiptSchema } from '@xunjie/contracts/action-intents';
import type { ActionInput, ActionReceipt, ActionReceiver } from '@xunjie/contracts/action-intents';
import type { ModelUsage } from '@xunjie/contracts/model-connections';
import {
  teachingAgentReceiverId, teachingContinueInputSchema, teachingConversationSchema, teachingEventSchema,
  teachingModelSwitchInputSchema, teachingModelSwitchSchema,
  teachingRunSchema, teachingSnapshotSchema, teachingStopInputSchema, teachingDispatchAuthoritySchema,
  isRecoverableTeachingPause, teachingAgentCallSchema,
} from '@xunjie/contracts/teaching-agent';
import type {
  TeachingConversation, TeachingEvent, TeachingEventKind, TeachingMessage, TeachingRun, TeachingSnapshot, AgentDefinition,
  TeachingArtifactPreview, ResolvedAgent,
} from '@xunjie/contracts/teaching-agent';
import { fixedInputText, portableContext, type ContextMessage } from './context.js';
import { modelSegmentInputSchema } from '@xunjie/contracts/model-connections';
import { requiresExplanationReview, teachingExplanationText } from './help-policy.js';
import { operationId, canonicalDigest } from './identity.js';
import { teachingToolMigration } from './tool-migrations.js';
import { teachingDeploymentMigration, validateTeachingDependencyBindings, teachingArtifactAdoptionAuthoritySchema,
  type TeachingDispatchAuthority, type TeachingArtifactAdoptionAuthority } from './remote-state.js';
import { teachingArtifactReceiptSchema } from '@xunjie/contracts/teaching-artifacts';
import { chunkChannelMigrationSql, createChunkChannel } from './chunk-channel.js';
import { studentQuestionMigration, createStudentQuestions, validateStudentQuestions } from './student-questions.js';
import { teachingInputMigration, createTeachingInputs } from './inputs.js';
import { orderTeachingWrites } from './input-order.js';
import { createTeachingInputControls } from './input-controls.js';
import { createTeachingRunControls } from './run-controls.js';
import { validateTeachingInputs } from './input-validation.js';
import { insertTeachingRun } from './run-records.js';
import { createTeachingRunDriver, TeachingBudgetError, type TeachingRunLimits } from './driver.js';
import type { TeachingPreparedTool, TeachingToolOutcome, TeachingToolHost, TeachingToolScope } from './tool-types.js';
import type { ModelTool } from '@xunjie/contracts/model-connections';
import { modelLearningInputSchema, modelToolResultSchema } from '@xunjie/contracts/model-connections';
import type { LearningModelPort } from '../model-connections/service.js';
import { createTeachingSegments, teachingSegmentMigration, validateTeachingSegmentTransitions } from './segments.js';
import { loadedTools } from './tool-discovery.js';
import { assembleTeachingAgent, teachingAssemblyMigration, learningAgentDefinition, validateTeachingAssemblyData } from './assembly.js';
import { createTeachingSkills, teachingSkillsMigration, validateTeachingSkills } from './skills.js';
import { createTeachingSkillRuntime } from './skill-runtime.js';
import { abandonTeachingCompactions, createTeachingCompaction, teachingCompactionMigration } from './compaction.js';
import { validateTeachingCompactions } from './compaction-validation.js';
import { createTeachingStudentFacts, studentFactsGoalMigration, studentFactsMigration, validateTeachingStudentFacts } from './student-facts.js';
import { validateTeachingSkillLoads } from './maintenance.js';
export { createTeachingStudentFacts, studentFactsGoalMigration, studentFactsMigration, validateTeachingStudentFacts } from './student-facts.js';

const reasonText = (reason: unknown) => {
  switch (typeof reason === 'string' ? reason : '') {
    case 'model-not-selected': return '尚未选择模型';
    case 'model-unavailable': return '当前模型暂不可用';
    case 'max-output-missing': return '模型未填写最大输出 token';
    case 'course-help-policy-disabled': return '本课程的帮助策略不允许问答';
    case 'activity-closed': return '活动已关闭';
    case 'capacity-exceeded': return '内容超出当前模型窗口';
    case 'result-unknown': return '模型结果尚未确认';
    case 'segment-busy': return '上一段对话仍在收尾';
    default: return '';
  }
};

export const teachingAgentMigrations: readonly Migration[] = [{ version: 1, name: 'durable-learning-conversation', sql: `
  CREATE TABLE teaching_sessions(activity_id uuid PRIMARY KEY,next_seq bigint NOT NULL DEFAULT 1,
    segment_id uuid,segment_fingerprint text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE teaching_requests(request_id uuid PRIMARY KEY,activity_id uuid,input_digest text NOT NULL,
    body jsonb,state text NOT NULL CHECK(state IN ('accepted','cancelled')),run_id uuid,input_id uuid,
    receipt jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE INDEX teaching_requests_activity ON teaching_requests(activity_id);
  CREATE TABLE teaching_runs(run_id uuid PRIMARY KEY,activity_id uuid NOT NULL,request_id uuid NOT NULL,
    input_id uuid NOT NULL,identity jsonb NOT NULL,state text NOT NULL,
    reason text NOT NULL DEFAULT '',stop_requested boolean NOT NULL DEFAULT false,previous_run_id uuid,
    attempt_id uuid,segment_id uuid,model jsonb,usage jsonb NOT NULL,
    generation integer NOT NULL DEFAULT 0,lease_owner text,lease_expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz);
  CREATE INDEX teaching_runs_activity ON teaching_runs(activity_id,created_at);
  CREATE INDEX teaching_runs_active ON teaching_runs(state) WHERE state IN ('received','running','dispatching');
  CREATE TABLE teaching_events(activity_id uuid NOT NULL,seq bigint NOT NULL,event_id uuid NOT NULL UNIQUE,
    kind text NOT NULL,event_version integer NOT NULL,body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(activity_id,seq));
  CREATE TABLE teaching_snapshots(snapshot_id uuid PRIMARY KEY,activity_id uuid NOT NULL,run_id uuid NOT NULL,
    attempt_id uuid NOT NULL,segment_id uuid NOT NULL,body jsonb NOT NULL,resource_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE INDEX teaching_snapshots_run ON teaching_snapshots(run_id);
` }, teachingToolMigration, studentQuestionMigration, teachingDeploymentMigration,
{ version: 5, name: 'agent-owned-chunk-channel', sql: chunkChannelMigrationSql }, { version: 6, name: 'durable-model-switches', sql: `
  ALTER TABLE teaching_sessions ADD COLUMN selection_version integer;
  CREATE TABLE teaching_model_switches(request_id uuid PRIMARY KEY,activity_id uuid NOT NULL,
    selection_version integer NOT NULL,state text NOT NULL CHECK(state IN ('accepted','completed','paused')),
    reason text NOT NULL DEFAULT '',identity jsonb NOT NULL,target jsonb NOT NULL,
    from_segment_id uuid,to_segment_id uuid NOT NULL,close_request_id uuid NOT NULL,create_request_id uuid NOT NULL,
    lease_owner text,lease_expires_at timestamptz,generation integer NOT NULL DEFAULT 0,create_body jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE INDEX teaching_model_switches_activity ON teaching_model_switches(activity_id,created_at);
` }, { version: 7, name: 'logical-run-cumulative-budgets', sql: `
  ALTER TABLE teaching_budgets ADD COLUMN max_input_tokens bigint NOT NULL DEFAULT 1048576,
    ADD COLUMN max_output_tokens bigint NOT NULL DEFAULT 65536,
    ADD COLUMN max_call_ms bigint NOT NULL DEFAULT 600000,
    ADD COLUMN deadline timestamptz;
  UPDATE teaching_budgets b SET deadline=r.created_at+interval '24 hours' FROM teaching_runs r WHERE r.run_id=b.run_id;
  ALTER TABLE teaching_budgets ALTER COLUMN deadline SET NOT NULL;
  INSERT INTO teaching_budgets(run_id,max_model_steps,max_tool_commands,max_parallel_tools,wait_ms,deadline)
    SELECT run_id,16,64,1,86400000,created_at+interval '24 hours' FROM teaching_runs WHERE true ON CONFLICT DO NOTHING;
  ALTER TABLE teaching_steps ADD COLUMN input_reserved bigint,
    ADD COLUMN call_reserved_ms bigint NOT NULL DEFAULT 600000,
    ADD COLUMN call_started_at timestamptz,ADD COLUMN call_settled_ms bigint;
  UPDATE teaching_steps SET input_reserved=COALESCE((plan->'model'->>'contextWindow')::bigint,1048576);
  ALTER TABLE teaching_steps ALTER COLUMN input_reserved SET NOT NULL;
` }, teachingInputMigration, teachingSegmentMigration, teachingAssemblyMigration, teachingSkillsMigration,
  { ...teachingCompactionMigration, version: 12, formerVersion: 11 }, studentFactsMigration, studentFactsGoalMigration];

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = (state: TeachingRun['state']) => ['completed', 'failed', 'stopped', 'paused'].includes(state);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type RunRow = Record<string, unknown>;
type RequestRow = Record<string, unknown>;

export interface TeachingAgentOptions {
  authorize(identity: SpaceIdentity): Promise<void>;
  personalSkillOwners?(identity: SpaceIdentity): Promise<SpaceIdentity[]>;
  identityFor(scope: { environmentId: string; spaceId: string; principalId: string }): Promise<SpaceIdentity>;
  activity(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
  models: LearningModelPort;
  tools?: TeachingToolHost;
  definition?: AgentDefinition | ((scope: TeachingToolScope) => Promise<AgentDefinition>);
  limits?: Partial<TeachingRunLimits>;
  leaseMs?: number;
  scanIntervalMs?: number;
  /** Durable authority identity; separate process namespaces must differ even when they share storage in tests. */
  driverId?: string;
  start?: boolean;
  withAuthority?<T>(authority: TeachingDispatchAuthority, work: () => Promise<T>): Promise<T>;
}

export function createTeachingAgent(storage: OwnedStorage, options: TeachingAgentOptions) {
  storage = orderTeachingWrites(storage);
  const ownerId = options.driverId ?? JSON.stringify([storage.owner.environmentId, storage.owner.serviceId, process.pid]);
  const leaseMs = options.leaseMs ?? 10_000;
  const scanIntervalMs = options.scanIntervalMs ?? 5_000;
  const receiverId = teachingAgentReceiverId(storage.owner.serviceId);
  const identity: ActionReceiver['identity'] = { receiverId, location: 'remote', kind: 'question' };
  const active = new Map<string, Promise<void>>();
  let writesClosed = false;
  let dispatchClosed = false;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const skills = createTeachingSkills(storage, { authorize: options.authorize, activity: options.activity,
    ...(options.personalSkillOwners ? { personalOwners: options.personalSkillOwners } : {}),
    assertWritable() { if (writesClosed || dispatchClosed) throw new StorageError('maintenance'); } });
  const skillRuntime = createTeachingSkillRuntime(skills, options.tools);
  const studentFacts = createTeachingStudentFacts(storage, { activity: options.activity, authorize: options.authorize });
  const tools = skillRuntime.host;
  const segments = createTeachingSegments(storage, { models: options.models, leaseMs,
    assertWritable() { if (writesClosed || dispatchClosed) throw new StorageError('maintenance'); } });
  const compactions = createTeachingCompaction(storage);

  function toRun(row: RunRow): TeachingRun {
    return teachingRunSchema.parse({
      runId: row.run_id, activityId: row.activity_id, requestId: row.request_id, inputId: row.input_id,
      state: row.state, reason: row.reason, stopRequested: row.stop_requested,
      previousRunId: row.previous_run_id ?? null, attemptId: row.attempt_id ?? null, segmentId: row.segment_id ?? null,
      initialResolvedAgentId: row.initial_resolved_agent_id ?? null,
      model: row.model ?? null, usage: row.usage, createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString(),
      completedAt: row.completed_at ? new Date(row.completed_at as string).toISOString() : null,
    });
  }
  async function requestRow(requestId: string) {
    const { rows: [row] } = await storage.read('SELECT * FROM teaching_requests WHERE request_id=$1', [requestId]);
    return row as RequestRow | undefined;
  }
  async function runRow(runId: string) {
    const { rows: [row] } = await storage.read('SELECT * FROM teaching_runs WHERE run_id=$1', [runId]);
    if (!row) throw new StorageError('missing');
    return row as RunRow;
  }
  async function appendEvent(tx: OwnedTransaction, activityId: string, kind: TeachingEventKind, body: Record<string, unknown>) {
    const { rows: [session] } = await tx.query('SELECT next_seq FROM teaching_sessions WHERE activity_id=$1 FOR UPDATE', [activityId]);
    if (!session) throw new StorageError('corrupt');
    const seq = Number(session.next_seq), eventId = randomUUID();
    await tx.query('UPDATE teaching_sessions SET next_seq=$2,updated_at=clock_timestamp() WHERE activity_id=$1', [activityId, seq + 1]);
    await tx.query(`INSERT INTO teaching_events(activity_id,seq,event_id,kind,event_version,body)
      VALUES($1,$2,$3,$4,1,$5)`, [activityId, seq, eventId, kind, JSON.stringify(body)]);
    return { seq, eventId };
  }
  function receipt(input: ActionInput, inputDigest: string, state: 'accepted' | 'cancelled', runId: string | null, inputId: string | null) {
    return actionReceiptSchema.parse({ requestId: input.requestId, receiver: input.receiver, inputDigest, state,
      receiptId: runId ?? input.requestId,
      detail: JSON.stringify({ version: 1, runId, inputId }) });
  }
  function refusal(activity: LearningActivity) {
    if (activity.status !== 'open') return 'activity-closed';
    // A course activity always carries its fixed release policy; missing policy never means allowed.
    if (activity.course && activity.course.helpPolicy?.questions !== 'allowed') return 'course-help-policy-disabled';
    return null;
  }

  async function accept(input: ActionInput, inputDigest: string): Promise<ActionReceipt> {
    if (writesClosed) throw new StorageError('maintenance');
    input = actionInputSchema.parse(input);
    if (digest(input) !== inputDigest) throw new StorageError('invalid');
    if (input.receiver.receiverId !== receiverId) throw new StorageError('forbidden');
    const identity = await options.identityFor(input.scope);
    if (identity.environmentId !== input.scope.environmentId) throw new StorageError('forbidden');
    await options.authorize(identity);
    const activity = await options.activity(identity, input.scope.activityId);
    const existing = await requestRow(input.requestId);
    if (existing) {
      if (existing.input_digest !== inputDigest) throw new StorageError('identity-conflict');
      return actionReceiptSchema.parse(existing.receipt);
    }
    const reason = refusal(activity);
    if (reason) return receipt(input, inputDigest, 'cancelled', null, null);
    const runId = operationId('teaching-run:' + input.requestId);
    const inputId = operationId('teaching-input:' + input.requestId);
    const stored = await storage.request({ requestId: 'teaching-accept:' + input.requestId,
      fingerprint: digest({ scope: input.scope, inputDigest }) }, async tx => {
      const { rows: [prior] } = await tx.query('SELECT state,receipt FROM teaching_requests WHERE request_id=$1 FOR UPDATE', [input.requestId]);
      if (prior) return prior.receipt;
      await tx.query('INSERT INTO teaching_sessions(activity_id) VALUES($1) ON CONFLICT(activity_id) DO NOTHING', [input.scope.activityId]);
      await tx.query('SELECT activity_id FROM teaching_sessions WHERE activity_id=$1 FOR UPDATE', [input.scope.activityId]);
      const { rows: switching } = await tx.query(`SELECT request_id FROM teaching_model_switches
        WHERE activity_id=$1 AND state IN ('accepted','paused') LIMIT 1`, [input.scope.activityId]);
      if (switching.length) throw new StorageError('conflict');
      const { rows: [previous] } = await tx.query('SELECT run_id,state FROM teaching_runs WHERE activity_id=$1 ORDER BY created_at DESC LIMIT 1', [input.scope.activityId]);
      const busy = previous && !terminal(previous.state as TeachingRun['state']);
      const targetRunId = busy ? String(previous.run_id) : runId;
      const accepted = receipt(input, inputDigest, 'accepted', targetRunId, inputId);
      await tx.query(`INSERT INTO teaching_requests(request_id,activity_id,input_digest,body,state,run_id,input_id,receipt)
        VALUES($1,$2,$3,$4,'accepted',$5,$6,$7)`, [input.requestId, input.scope.activityId, inputDigest,
        JSON.stringify(input), targetRunId, inputId, JSON.stringify(accepted)]);
      if (!busy) await insertTeachingRun(tx, { runId, activityId: input.scope.activityId, requestId: input.requestId, inputId,
        identity: activity.identity, previousRunId: previous ? String(previous.run_id) : null }, driver.freezeBudget);
      const received = await appendEvent(tx, input.scope.activityId, 'input', { runId: targetRunId, requestId: input.requestId, inputId,
        question: input.draft.question, references: input.draft.references.map(reference => ({ referenceId: reference.referenceId,
          source: reference.source, sourceName: reference.sourceName, copy: reference.copy })), works: input.works.map(work => ({ objectId: work.objectId,
          name: work.name, kind: work.kind })), goal: activity.goal, activityQuestion: activity.question });
      await inputs.register(tx, input, targetRunId, received.seq);
      await studentFacts.record(tx, { identity: activity.identity, activity, inputId,
        eventId: received.eventId, eventSeq: received.seq, contentVersion: 1, text: input.draft.question });
      if (!busy) await appendEvent(tx, input.scope.activityId, 'run-received', { runId, requestId: input.requestId, inputId });
      return accepted;
    });
    kick(JSON.parse((stored.result as ActionReceipt).detail).runId);
    return actionReceiptSchema.parse(stored.result);
  }

  async function query(requestId: string, inputDigest: string): Promise<ActionReceipt | null> {
    const row = await requestRow(requestId);
    if (!row) return null;
    if (row.input_digest !== inputDigest) return null;
    return actionReceiptSchema.parse(row.receipt);
  }

  async function cancel(requestId: string, inputDigest: string): Promise<ActionReceipt> {
    if (writesClosed) throw new StorageError('maintenance');
    let row = await requestRow(requestId);
    if (!row) {
      const tombstone = actionReceiptSchema.parse({ requestId, inputDigest, receiver: identity, state: 'cancelled',
        receiptId: requestId, detail: JSON.stringify({ version: 1, runId: null, inputId: null }) });
      const committed = await storage.request({ requestId: 'teaching-cancel-tombstone:' + requestId, fingerprint: inputDigest }, async tx => {
        await tx.query(`INSERT INTO teaching_requests(request_id,activity_id,input_digest,body,state,receipt)
          VALUES($1,NULL,$2,NULL,'cancelled',$3) ON CONFLICT(request_id) DO NOTHING`, [requestId, inputDigest, JSON.stringify(tombstone)]);
        const { rows: [current] } = await tx.query('SELECT input_digest,receipt FROM teaching_requests WHERE request_id=$1', [requestId]);
        if (!current) throw new StorageError('corrupt');
        if (current.input_digest !== inputDigest) throw new StorageError('identity-conflict');
        return current.receipt;
      });
      const current = actionReceiptSchema.parse(committed.result);
      if (current.state === 'cancelled') return current;
      // Acceptance may have committed after the optimistic read. Preserve its
      // original receipt and apply the same stop path as an already known Run.
      row = await requestRow(requestId);
      if (!row) throw new StorageError('corrupt');
    }
    if (row.input_digest !== inputDigest) throw new StorageError('identity-conflict');
    // An accepted request is immutable evidence. Cancelling it now closes the run, never rewrites
    // the receipt into a cancellation after the question was already accepted.
    if (row.state === 'accepted' && row.run_id) {
      await storage.request({ requestId: 'teaching-stop-accepted:' + requestId, fingerprint: inputDigest }, async tx => {
        const { rows: [current] } = await tx.query('SELECT activity_id,state,stop_requested FROM teaching_runs WHERE run_id=$1 FOR UPDATE', [row.run_id]);
        if (!current || terminal(current.state as TeachingRun['state']) || current.stop_requested) return null;
        await tx.query('UPDATE teaching_runs SET stop_requested=true,updated_at=clock_timestamp() WHERE run_id=$1', [row.run_id]);
        await abandonTeachingCompactions(tx, String(row.run_id), 'stop-requested');
        await appendEvent(tx, current.activity_id as string, 'stop-requested', { runId: row.run_id, requestId,
          source: 'cancellation-after-accept' });
        return null;
      });
      void stopAttempt(row.run_id as string).catch(() => {});
    }
    return actionReceiptSchema.parse(row.receipt);
  }

  async function stopAttempt(runId: string) {
    const row = await runRow(runId);
    const attemptId = row.attempt_id as string | null;
    if (!attemptId) return;
    await options.models.checks.cancel(runIdentity(row), attemptId).catch(error => {
      if (!(error instanceof StorageError) || !['missing', 'conflict', 'forbidden'].includes(error.code)) throw error;
    });
  }
  function runIdentity(row: RunRow): SpaceIdentity {
    const saved = row.identity as { environmentId: string; spaceId: string; principalId: string; kind: SpaceIdentity['kind']; name: string };
    return { environmentId: saved.environmentId, spaceId: saved.spaceId, principalId: saved.principalId,
      kind: saved.kind, name: saved.name };
  }

  async function claim(runId: string): Promise<{ run: TeachingRun; generation: number } | null> {
    const result = await storage.request({ requestId: 'teaching-claim:' + randomUUID(), fingerprint: 'teaching-claim:' + runId }, async tx => {
      const { rows: [row] } = await tx.query(`SELECT *,lease_expires_at IS NOT NULL
        AND lease_expires_at >= clock_timestamp() AS lease_live FROM teaching_runs WHERE run_id=$1 FOR UPDATE`, [runId]);
      if (!row) return null;
      const run = toRun(row);
      if (terminal(run.state)) return null;
      // kick() already excludes active work in this process. A retry must be able to reclaim
      // its own expired lease after a lost dependency reply, while every live lease stays held.
      if (row.lease_owner && row.lease_live) return null;
      const generation = Number(row.generation) + 1;
      const { rows: [claimed] } = await tx.query(`UPDATE teaching_runs SET lease_owner=$2,
        lease_expires_at=clock_timestamp()+($3 || ' milliseconds')::interval,generation=$4,
        state=CASE WHEN state='received' THEN 'running' ELSE state END,updated_at=clock_timestamp()
        WHERE run_id=$1 RETURNING *`, [runId, ownerId, String(leaseMs), generation]);
      if (!claimed) throw new StorageError('corrupt');
      if (run.state === 'received') await appendEvent(tx, run.activityId, 'run-started', { runId, generation });
      return { run: toRun(claimed), generation };
    });
    return result.result as { run: TeachingRun; generation: number } | null;
  }
  async function assertAuthority(tx: OwnedTransaction, runId: string, generation: number) {
    const { rows: [row] } = await tx.query('SELECT generation,lease_owner,lease_expires_at>=clock_timestamp() AS lease_live FROM teaching_runs WHERE run_id=$1 FOR UPDATE', [runId]);
    if (!row || Number(row.generation) !== generation || row.lease_owner !== ownerId || !row.lease_live) throw new StorageError('conflict');
    return row;
  }
  async function finish(run: TeachingRun, generation: number, state: TeachingRun['state'], reason: string,
    usage: ModelUsage, model: TeachingRun['model'], event: { kind: TeachingEventKind; body: Record<string, unknown> } | null,
    extraEvents: { kind: TeachingEventKind; body: Record<string, unknown> }[] = []) {
    const row = await runRow(run.runId);
    if (riskOwnershipLost(row, generation)) throw new StorageError('conflict');
    const finished = await storage.request({ requestId: 'teaching-finish:' + run.runId + ':' + randomUUID(),
      fingerprint: 'teaching-finish:' + run.runId }, async tx => {
      await assertAuthority(tx, run.runId, generation);
      const { rows: [current] } = await tx.query('SELECT state,reason,stop_requested FROM teaching_runs WHERE run_id=$1', [run.runId]);
      if (!current || terminal(current.state as TeachingRun['state'])) return { finished: true, next: null };
      const finalState = current.stop_requested ? 'stopped' : current.reason === 'wait-expired' ? 'paused' : state;
      const finalReason = current.stop_requested ? 'stop-requested' : current.reason === 'wait-expired' ? 'wait-expired' : reason;
      // An input can arrive after the planner observed an empty unconsumed set.
      // Recheck under the same write order as acceptance before stopping this Run.
      if (finalReason === 'input-removed-before-adoption' && (await inputs.pending(run, tx)).length)
        return { finished: false, next: null };
      const steering = finalState === 'completed' && await inputs.hasSteering(tx, run);
      const { rows: resultWaits } = finalState === 'completed' ? await tx.query(`SELECT state,observed_step_id FROM teaching_waits
        WHERE run_id=$1 AND purpose='result' AND (state='pending' OR (state='consumed' AND observed_step_id IS NULL))`, [run.runId]) : { rows: [] };
      const readyResult = resultWaits.some(wait => wait.state === 'consumed');
      if (finalState === 'completed' && (steering || resultWaits.length)) {
        for (const saved of [event, ...extraEvents]) if (saved && saved.kind !== 'run-completed')
          await appendEvent(tx, run.activityId, saved.kind, saved.body);
        await tx.query(`UPDATE teaching_steps SET phase='completed' WHERE run_id=$1
          AND step_no=(SELECT max(step_no) FROM teaching_steps WHERE run_id=$1)`, [run.runId]);
        const advancing = steering || readyResult;
        await tx.query(`UPDATE teaching_runs SET state=$4,usage=$2,model=$3,
          lease_owner=CASE WHEN $5 THEN lease_owner ELSE NULL END,
          lease_expires_at=CASE WHEN $5 THEN lease_expires_at ELSE NULL END,updated_at=clock_timestamp()
          WHERE run_id=$1`, [run.runId, JSON.stringify(usage), JSON.stringify(model), advancing ? 'running' : 'waiting', advancing]);
        return { finished: !advancing, next: null };
      }
      let stopRecorded = false;
      for (const saved of [event, ...extraEvents]) if (saved) {
        const kind = ['run-completed', 'run-failed'].includes(saved.kind)
          ? current.stop_requested ? 'run-stopped' : current.reason === 'wait-expired' ? 'system-notice' : saved.kind : saved.kind;
        stopRecorded ||= kind === 'run-stopped';
        await appendEvent(tx, run.activityId, kind, kind !== saved.kind
          ? { ...saved.body, reason: finalReason, nativeReason: saved.body.reason ?? '' } : saved.body);
      }
      if (finalState === 'stopped' && !stopRecorded) await appendEvent(tx, run.activityId, 'run-stopped', { runId: run.runId, reason: finalReason });
      await tx.query(`UPDATE teaching_runs SET state=$2,reason=$3,usage=$4,model=$5,
        completed_at=CASE WHEN $6 THEN NULL ELSE clock_timestamp() END,
        lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE run_id=$1`, [run.runId, finalState, finalReason,
        JSON.stringify(usage), JSON.stringify(model), isRecoverableTeachingPause({ state: finalState, reason: finalReason, completedAt: null })]);
      return { finished: true, next: await inputs.afterFinish(tx, run, finalState, finalReason) };
    });
    const result = finished.result as { finished: boolean; next: string | null };
    if (result.next) kick(result.next);
    return result.finished;
  }
  function riskOwnershipLost(row: RunRow, generation: number) {
    return Number(row.generation) !== generation || row.lease_owner !== ownerId;
  }
  async function heartbeat(runId: string, generation: number) {
    await storage.request({ requestId: 'teaching-heartbeat:' + runId + ':' + randomUUID(),
      fingerprint: 'teaching-heartbeat:' + runId }, async tx => {
      await assertAuthority(tx, runId, generation);
      await tx.query("UPDATE teaching_runs SET lease_expires_at=clock_timestamp()+($2 || ' milliseconds')::interval WHERE run_id=$1",
        [runId, String(leaseMs)]);
      return null;
    }).catch(error => {
      if (!(error instanceof StorageError) || !['conflict', 'missing', 'commit-unknown'].includes(error.code)) throw error;
    });
  }
  async function historyThrough(activityId: string, boundary: number, runId?: string): Promise<ContextMessage[]> {
    const { rows } = await storage.read(`SELECT e.seq,e.event_id,e.kind,e.body,i.state AS input_state,i.adopted_run_id,v.body AS fixed_input,
      EXISTS(SELECT 1 FROM teaching_events a WHERE a.activity_id=e.activity_id AND a.kind='input-adopted'
        AND a.body->>'inputId'=e.body->>'inputId') AS adoption_logged
      FROM teaching_events e LEFT JOIN teaching_inputs i ON i.input_id::text=e.body->>'inputId'
      LEFT JOIN teaching_input_revisions v ON v.input_id=i.input_id AND v.version=COALESCE((e.body->>'version')::integer,1)
      WHERE e.activity_id=$1 AND e.seq<$2 AND e.kind IN ('input','input-adopted','assistant','question-created','student-response','tool-result') ORDER BY e.seq`, [activityId, boundary]);
    return rows.flatMap((row): ContextMessage[] => {
      const messages = ((): ContextMessage[] => {
      const body = row.body as Record<string, unknown>;
      if (row.kind === 'input-adopted' || row.kind === 'input' && row.input_state === 'adopted' && !row.adoption_logged) {
        if (runId && (body.runId === runId || row.adopted_run_id === runId)) return [];
        if (!row.fixed_input) throw new StorageError('corrupt');
        const text = fixedInputText(actionInputSchema.parse(row.fixed_input));
        return text ? [{ role: 'student' as const, text,
          source: { kind: 'input', id: String(body.inputId) + ':' + String(body.version ?? 1), label: '先前已采用的学生输入与固定依据' } }] : [];
      }
      if (row.kind === 'assistant') return typeof body.text === 'string' && body.text ? [{ role: 'assistant' as const, text: body.text }] : [];
      if (row.kind === 'question-created' && typeof body.question === 'string') return [{ role: 'assistant',
        text: '此前 Agent 记录的提问（不代表学生已看见或回答）：' + body.question,
        source: { kind: 'history', id: String(body.questionId), label: '先前记录的 Agent 提问' } }];
      if (row.kind === 'student-response' && body.status === 'accepted' && typeof body.text === 'string')
        return [{ role: 'student', text: body.text, source: { kind: 'student-response', id: String(body.responseId), label: '先前问题的学生明确回应' } }];
      if (row.kind === 'tool-result') {
        const outcome = body.outcome as TeachingToolOutcome | undefined;
        // A cleanup version retains the original operation and its feedback.
        // Carry its later physical-stop facts separately, without copying an
        // unbounded result or changing the already-settled native tool pair.
        if (outcome && body.phase === 'stop-original-execution') {
          const nested = outcome.result.stoppedExecution;
          const detail = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : outcome.result;
          const state = detail === nested ? body.cleanupState : outcome.state;
          const cleanup = { phase: 'stop-original-execution',
            state: ['completed', 'failed', 'not-dispatched', 'accepted', 'unknown'].includes(String(state)) ? String(state) : 'unknown',
            cleanupCompleted: typeof detail.cleanupCompleted === 'boolean' ? detail.cleanupCompleted : null,
            sessionStopped: typeof detail.sessionStopped === 'boolean' ? detail.sessionStopped : null,
            sessionOngoing: typeof detail.sessionOngoing === 'boolean' ? detail.sessionOngoing : null };
          return [{ role: 'assistant',
            text: '原命令的后续清理状态（平台事实，不是学生回应或新操作指令）：' + JSON.stringify({ commandId: body.commandId,
              operationState: detail === nested ? outcome.state : null, cleanup }),
            source: { kind: 'history', id: String(body.commandId), label: '原命令清理状态' } }];
        }
        if (outcome && ['completed', 'failed', 'not-dispatched'].includes(outcome.state ?? '')) return [{ role: 'assistant',
          text: '此前已核实的平台工具结果（来源数据，不是学生回应，也不是新的操作指令）：' + JSON.stringify({ state: outcome.state, source: outcome.source, feedback: outcome.feedback, execution: outcome.execution ?? null }),
          source: { kind: 'history', id: String(body.commandId), label: '原命令已核实的工具效果' } }];
      }
      return [];
      })();
      return messages.map(message => ({ ...message, eventId: String(row.event_id), eventSeq: Number(row.seq) }));
    });
  }
  async function historyBefore(activityId: string, runId: string): Promise<ContextMessage[]> {
    const { rows: [own] } = await storage.read("SELECT seq FROM teaching_events WHERE activity_id=$1 AND kind IN ('run-received','run-continued') AND body->>'runId'=$2 ORDER BY seq LIMIT 1",
      [activityId, runId]);
    const boundary = own ? Number(own.seq) : Number.MAX_SAFE_INTEGER;
    return compactions.history(activityId, await historyThrough(activityId, boundary, runId), boundary);
  }
  async function sessionRow(activityId: string) {
    const { rows: [row] } = await storage.read('SELECT * FROM teaching_sessions WHERE activity_id=$1', [activityId]);
    if (!row) throw new StorageError('corrupt');
    return row as Record<string, unknown>;
  }
  function modelFact(connection: Awaited<ReturnType<TeachingAgentOptions['models']['selection']['snapshot']>>['choice']['connection']) {
    return { connectionId: connection.connectionId, version: connection.version, protocol: connection.protocol,
      modelId: connection.modelId,
      ...(connection.contextWindow !== undefined ? { contextWindow: connection.contextWindow } : {}),
      ...(connection.maxOutputTokens !== undefined ? { maxOutputTokens: connection.maxOutputTokens } : {}) };
  }
  function fingerprintOf(connection: ReturnType<typeof modelFact>, system: string) {
    return digest([connection.connectionId, connection.version, connection.protocol, connection.modelId, digest(system)]);
  }
  async function ensureSegment(identity: SpaceIdentity, activity: LearningActivity, run: TeachingRun,
    choice: Awaited<ReturnType<TeachingAgentOptions['models']['selection']['snapshot']>>, selectionVersion: number,
    system: string, history: ContextMessage[], generation: number, tools: ModelTool[], assemblyId?: string, selectionPinId?: string,
    change?: { reason: 'compaction-generation' | 'compaction'; compactionId: string }) {
    const assertCompaction = async (tx: OwnedTransaction, compactionId: string) => {
      const { rows: [current] } = await tx.query('SELECT stop_requested,state FROM teaching_runs WHERE run_id=$1', [run.runId]);
      if (!current || current.stop_requested || terminal(current.state as TeachingRun['state'])) throw new StorageError('conflict');
      const record = await compactions.read(compactionId, tx);
      if (record.state === 'rejected' || !await compactions.matches(tx, activity.activityId, record.source)) throw new StorageError('conflict');
    };
    const completeCompaction = async (tx: OwnedTransaction, transition: { reason: string; compactionId?: string | null; transitionId: string }) => {
      if (transition.reason !== 'compaction' || !transition.compactionId) return;
      await assertCompaction(tx, transition.compactionId);
      const { rows } = await tx.query(`UPDATE teaching_compactions SET state='adopted',adoption_transition_id=$2,
        adopted_at=clock_timestamp() WHERE compaction_id=$1 AND state='generated' RETURNING body,result,result_ref`,
        [transition.compactionId, transition.transitionId]);
      if (rows.length) await appendEvent(tx, activity.activityId, 'context-compacted', { runId: run.runId,
        compactionId: transition.compactionId, transitionId: transition.transitionId,
        source: rows[0]!.body, result: rows[0]!.result, resultRef: rows[0]!.result_ref });
    };
    const pending = await segments.pending(activity.activityId);
    const guardedCompactionId = pending?.compactionId ?? change?.compactionId;
    const authority = { key: `run:${run.runId}:${ownerId}:${generation}`,
      assert: async (tx: OwnedTransaction) => { await assertAuthority(tx, run.runId, generation);
        if (guardedCompactionId) await assertCompaction(tx, guardedCompactionId); } };
    if (pending) {
      if (pending.reason === 'model-switch') throw new StorageError('resource-busy');
      const recovered = await segments.advance(identity, pending.transitionId, authority, completeCompaction);
      return { segmentId: recovered.toSegmentId, sequence: recovered.createResult!.sequence,
        model: recovered.target.model, fresh: true, transitionId: recovered.transitionId, assemblyId: recovered.assemblyId };
    }
    const session = await sessionRow(activity.activityId);
    const segmentId = session.segment_id as string | null;
    const model = modelFact(choice.choice.connection);
    const fingerprint = fingerprintOf(model, system + canonicalDigest(tools));
    if (change && segmentId) {
      const { rows: [received] } = await storage.read(`SELECT * FROM teaching_segment_transitions WHERE activity_id=$1
        AND compaction_id=$2 AND reason=$3 AND state='completed' AND to_segment_id=$4`,
        [activity.activityId, change.compactionId, change.reason, segmentId]);
      if (received) {
        const native = await options.models.segments.read(identity, segmentId);
        if (native.closed || native.pending || native.pendingTools.length || received.fingerprint !== fingerprint
          || received.assembly_id !== assemblyId) throw new StorageError('conflict');
        return { segmentId, sequence: native.sequence, model, fresh: true,
          transitionId: String(received.transition_id), assemblyId: received.assembly_id as string | null };
      }
    }
    if (segmentId) {
      const segment = await options.models.segments.read(identity, segmentId);
      if (segment.pending || segment.pendingTools.length) throw new StorageError('resource-busy');
      if (!change && !segment.closed && session.segment_fingerprint === fingerprint
        && (assemblyId === undefined || session.segment_assembly_id === assemblyId)) {
        return { segmentId, sequence: segment.sequence, model, fresh: false, assemblyId: session.segment_assembly_id as string | null };
      }
    }
    const transitionId = operationId('teaching-segment-transition:' + canonicalDigest([activity.activityId, run.runId, segmentId, fingerprint, assemblyId ?? null,
      ...(change ? [change.reason, change.compactionId] : [])]));
    const createdId = operationId('teaching-transition-segment:' + transitionId);
    const createRequestId = operationId('teaching-transition-create:' + transitionId);
    const portable = modelSegmentInputSchema.shape.portable.safeParse(portableContext(history, activity));
    if (!portable.success) throw new TeachingBudgetError('capacity-exceeded');
    const candidate = modelSegmentInputSchema.parse({ requestId: createRequestId, segmentId: createdId, purpose: 'learning',
      source: { selected: true, selectionVersion, ...(selectionPinId ? { pinId: selectionPinId } : {}) }, prefix: { system, tools },
      portable: portable.data,
      ...(segmentId ? { previousSegmentId: segmentId } : {}) });
    await storage.request({ requestId: 'teaching-transition-receive:' + transitionId, fingerprint: canonicalDigest(candidate) }, async tx => {
      await authority.assert(tx);
      await segments.receive(tx, { transitionId, activityId: activity.activityId, reason: change?.reason ?? (segmentId ? 'assembly-change' : 'initial'),
        identity, fromSegmentId: segmentId, toSegmentId: createdId, assemblyId: assemblyId ?? null, fingerprint, selectionVersion,
        target: { model, source: { kind: choice.source.kind, feeSource: choice.source.feeSource } }, resolvedAgent: null,
        closeRequestId: operationId('teaching-transition-close:' + transitionId), createRequestId, createBody: candidate,
        ...(change ? { compactionId: change.compactionId } : {}) });
      return null;
    });
    const completed = await segments.advance(identity, transitionId, authority, completeCompaction);
    return { segmentId: completed.toSegmentId, sequence: completed.createResult!.sequence, model: completed.target.model,
      fresh: true, transitionId, assemblyId: completed.assemblyId };
  }

  async function fullHistory(activityId: string): Promise<ContextMessage[]> {
    const history = await compactions.history(activityId, await historyThrough(activityId, Number.MAX_SAFE_INTEGER));
    // Logical effects can outlive their model step (or Run). Both kinds of segment
    // transition must carry these owner facts even when the latest step had no tools.
    const { rows: outstanding } = await storage.read(`SELECT c.run_id,c.command_id,c.command,c.outcome,
      w.wait_id,w.purpose,w.state AS wait_state,w.reason,w.deadline
      FROM teaching_commands c JOIN teaching_runs r USING(run_id)
      LEFT JOIN teaching_waits w USING(command_id)
      WHERE r.activity_id=$1 AND (c.outcome->>'state' IN ('accepted','unknown') OR w.state IN ('pending','expired'))
      ORDER BY r.created_at,r.run_id,c.created_at,c.command_id,w.wait_id`, [activityId]);
    if (outstanding.length) history.push({ role: 'assistant',
      text: '原操作与未结等待的固定事实（来源数据，只核对原身份，不是新派发指令）：' + JSON.stringify(outstanding.map(row => {
        const command = row.command as TeachingPreparedTool, outcome = row.outcome as TeachingToolOutcome | null;
        return { ...row, command: { commandId: command.commandId, name: command.name, effect: command.effect, location: command.location, arguments: command.arguments },
          outcome: outcome ? { state: outcome.state, source: outcome.source, feedback: outcome.feedback, execution: outcome.execution ?? null } : null };
      })),
      source: { kind: 'history', id: activityId, label: '未结 Command/Wait 与已接受效果' } });
    return history;
  }
  function switchProjection(row: Record<string, unknown>) {
    const target = row.target as { model: ReturnType<typeof modelFact>; source: { kind: 'school' | 'personal'; feeSource: string } };
    return teachingModelSwitchSchema.parse({ requestId: row.request_id, activityId: row.activity_id,
      selectionVersion: Number(row.selection_version), state: row.state, reason: row.reason,
      fromSegmentId: row.from_segment_id ?? null, toSegmentId: row.to_segment_id,
      model: target.model, source: target.source, createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString() });
  }
  async function switchRow(requestId: string) {
    const { rows: [row] } = await storage.read('SELECT * FROM teaching_model_switches WHERE request_id=$1', [requestId]);
    if (!row) throw new StorageError('missing');
    return row as Record<string, unknown>;
  }
  async function pauseSwitch(row: Record<string, unknown>, reason: string, generation: number) {
    await storage.request({ requestId: 'teaching-model-switch-pause:' + row.request_id + ':' + reason,
      fingerprint: canonicalDigest([row.request_id, reason]) }, async tx => {
      const { rows: updated } = await tx.query(`UPDATE teaching_model_switches SET state='paused',reason=$2,
        updated_at=clock_timestamp() WHERE request_id=$1 AND state<>'completed' AND lease_owner=$3 AND generation=$4 RETURNING activity_id`, [row.request_id, reason, ownerId, generation]);
      if (updated.length) await appendEvent(tx, String(row.activity_id), 'model-switch-paused', {
        requestId: row.request_id, selectionVersion: row.selection_version, reason });
      return null;
    });
    return switchProjection(await switchRow(String(row.request_id)));
  }
  async function assertSwitchAuthority(tx: OwnedTransaction, requestId: string, generation: number) {
    if (writesClosed || dispatchClosed) throw new StorageError('maintenance');
    const { rows: [row] } = await tx.query(`SELECT activity_id FROM teaching_model_switches
      WHERE request_id=$1 AND lease_owner=$2 AND generation=$3 AND lease_expires_at>=clock_timestamp() FOR UPDATE`,
    [requestId, ownerId, generation]);
    if (!row) throw new StorageError('conflict');
    const { rows: active } = await tx.query(`SELECT run_id FROM teaching_runs WHERE activity_id=$1
      AND state IN ('received','running','dispatching','waiting')
      AND NOT (state='waiting' AND NOT stop_requested AND lease_owner IS NULL) LIMIT 1`, [row.activity_id]);
    const { rows: unsettled } = await tx.query(`SELECT c.command_id FROM teaching_commands c JOIN teaching_runs r USING(run_id)
      WHERE r.activity_id=$1 AND ((c.state<>'settled' AND NOT (c.state='waiting' AND c.outcome->>'state'='accepted'))
        OR NOT EXISTS (SELECT 1 FROM teaching_steps s WHERE s.step_id=c.step_id AND s.paired)) LIMIT 1`, [row.activity_id]);
    if (active.length || unsettled.length) throw new StorageError('resource-busy');
  }
  async function performModelSwitchBody(member: SpaceIdentity, requestId: string, generation: number) {
    const row = await switchRow(requestId);
    if (row.state === 'completed') return switchProjection(row);
    try {
      await options.authorize(member);
      const activity = await options.activity(member, String(row.activity_id));
      const authority = { key: `switch:${requestId}:${ownerId}:${generation}`,
        assert: (tx: OwnedTransaction) => assertSwitchAuthority(tx, requestId, generation) };
      const transitionId = operationId('teaching-model-switch-transition:' + requestId);
      let transition = await segments.read(transitionId).catch(error => {
        if (error instanceof StorageError && error.code === 'missing') return null;
        throw error;
      });
      if (!transition) {
        const boundary = await storage.request({ requestId: `teaching-switch-boundary:${requestId}:${generation}`,
          fingerprint: requestId }, async tx => {
          await authority.assert(tx);
          const { rows: [session] } = await tx.query('SELECT segment_id FROM teaching_sessions WHERE activity_id=$1 FOR UPDATE', [activity.activityId]);
          if (!session) throw new StorageError('corrupt');
          return session.segment_id as string | null;
        });
        const choice = await options.models.selection.pinned(member, requestId, Number(row.selection_version));
        // Before any fixed create is received, the running Agent may still reach a new
        // segment. Seal that boundary; an already received create keeps its predecessor.
        const oldId = (row.create_body ? row.from_segment_id : boundary.result) as string | null;
        // A pending queue is not part of the active request. Use its last adopted fixed revision.
        const { rows: [latest] } = await storage.read(`SELECT v.body FROM teaching_inputs i
          JOIN teaching_input_revisions v ON v.input_id=i.input_id AND v.version=i.version
          WHERE i.activity_id=$1 AND i.state='adopted' ORDER BY i.seq DESC LIMIT 1`, [activity.activityId]);
        const fixedInput = latest?.body ? actionInputSchema.parse(latest.body) : actionInputSchema.parse({
          requestId: operationId('model-switch-input:' + requestId), scope: { environmentId: member.environmentId, spaceId: member.spaceId,
            principalId: member.principalId, activityId: activity.activityId }, receiver: identity,
          draft: { token: operationId('model-switch-draft:' + requestId), question: '', references: [], bases: [] }, works: [], evidence: [] });
        const history = await fullHistory(activity.activityId);
        const scope: TeachingToolScope = { identity: member, activity, input: fixedInput, runId: requestId,
          stepId: operationId('model-switch-step:' + requestId), snapshotId: operationId('model-switch-snapshot:' + requestId),
          ...(oldId ? { segmentId: oldId } : {}) };
        const definition = typeof options.definition === 'function' ? await options.definition(scope) : options.definition ?? learningAgentDefinition;
        const assembly = await assembleTeachingAgent(scope, tools, modelFact(choice.choice.connection), history, definition,
          { loaded: await loadedTools(storage, scope), skills: await skillRuntime.state(scope) });
        const portable = modelSegmentInputSchema.shape.portable.safeParse(portableContext(history, activity));
        if (!portable.success) return pauseSwitch(row, 'capacity-exceeded', generation);
        // An in-flight v6 switch keeps the body it received before this migration.
        const candidate = modelSegmentInputSchema.parse(row.create_body ?? { requestId: row.create_request_id, segmentId: row.to_segment_id,
          purpose: 'learning', source: { selected: true, selectionVersion: Number(row.selection_version), pinId: requestId },
          prefix: { system: assembly.context.system, tools: assembly.tools }, portable: portable.data,
          ...(oldId ? { previousSegmentId: oldId } : {}) });
        const matchesAssembly = canonicalDigest(candidate.prefix) === canonicalDigest({ system: assembly.context.system, tools: assembly.tools });
        const saved = await storage.request({ requestId: 'teaching-switch-transition:' + requestId,
          fingerprint: canonicalDigest([requestId, row.to_segment_id]) }, async tx => {
          await authority.assert(tx);
          const received = await segments.receive(tx, { transitionId, activityId: activity.activityId, reason: 'model-switch',
            identity: member, fromSegmentId: oldId, toSegmentId: String(row.to_segment_id),
            assemblyId: matchesAssembly ? assembly.resolvedAgent.resolvedId : null,
            resolvedAgent: matchesAssembly ? assembly.resolvedAgent : null,
            fingerprint: fingerprintOf((row.target as { model: ReturnType<typeof modelFact> }).model,
              candidate.prefix.system + canonicalDigest(candidate.prefix.tools)),
            selectionVersion: Number(row.selection_version), target: row.target as Parameters<typeof segments.receive>[1]['target'],
            closeRequestId: String(row.close_request_id), createRequestId: String(row.create_request_id), createBody: candidate });
          await tx.query('UPDATE teaching_model_switches SET create_body=$2,from_segment_id=$3 WHERE request_id=$1',
            [requestId, JSON.stringify(candidate), oldId]);
          return received;
        });
        transition = saved.result as NonNullable<typeof transition>;
      }
      await segments.advance(member, transitionId, authority, async (tx, completed, created) => {
        const { rows: updated } = await tx.query(`UPDATE teaching_model_switches SET state='completed',reason='',
          updated_at=clock_timestamp() WHERE request_id=$1 AND state<>'completed' RETURNING activity_id`, [requestId]);
        await tx.query(`UPDATE teaching_runs SET state='received',reason='',updated_at=clock_timestamp()
          WHERE activity_id=$1 AND state='waiting' AND reason='model-switch-boundary' AND NOT stop_requested`, [activity.activityId]);
        if (updated.length) await appendEvent(tx, activity.activityId, 'model-switch-completed', {
          requestId, selectionVersion: completed.selectionVersion, fromSegmentId: completed.fromSegmentId,
          toSegmentId: completed.toSegmentId, sequence: created.sequence, target: completed.target, transitionId });
      });
      return switchProjection(await switchRow(requestId));
    } catch (error) {
      const reason = error instanceof StorageError ? error.code === 'resource-busy' ? 'segment-busy' : error.code : 'unavailable';
      return pauseSwitch(row, reason, generation);
    }
  }
  async function performModelSwitch(member: SpaceIdentity, requestId: string) {
    const claim = await storage.request({ requestId: 'teaching-switch-claim:' + randomUUID(), fingerprint: requestId }, async tx => {
      const { rows: [row] } = await tx.query(`UPDATE teaching_model_switches SET lease_owner=$2,
        lease_expires_at=clock_timestamp()+($3 || ' milliseconds')::interval,generation=generation+1
        WHERE request_id=$1 AND state<>'completed' AND (lease_owner IS NULL OR lease_expires_at<clock_timestamp())
        RETURNING generation`, [requestId, ownerId, String(leaseMs)]);
      return row ? Number(row.generation) : null;
    });
    if (claim.result === null) return switchProjection(await switchRow(requestId));
    const generation = Number(claim.result);
    const heartbeat = setInterval(() => {
      void storage.request({ requestId: 'teaching-switch-heartbeat:' + randomUUID(), fingerprint: requestId }, async tx => {
        await tx.query(`UPDATE teaching_model_switches SET lease_expires_at=clock_timestamp()+($4 || ' milliseconds')::interval
          WHERE request_id=$1 AND lease_owner=$2 AND generation=$3`, [requestId, ownerId, generation, String(leaseMs)]);
        return null;
      }).catch(() => {});
    }, Math.max(50, leaseMs / 3));
    try { return await performModelSwitchBody(member, requestId, generation); }
    finally {
      clearInterval(heartbeat);
      await storage.request({ requestId: 'teaching-switch-release:' + randomUUID(), fingerprint: requestId }, async tx => {
        await tx.query('UPDATE teaching_model_switches SET lease_owner=NULL,lease_expires_at=NULL WHERE request_id=$1 AND lease_owner=$2 AND generation=$3', [requestId, ownerId, generation]);
        return null;
      });
    }
  }
  const switching = new Map<string, Promise<ReturnType<typeof switchProjection>>>();
  function applyModelSwitch(member: SpaceIdentity, requestId: string) {
    const existing = switching.get(requestId);
    if (existing) return existing;
    const task = performModelSwitch(member, requestId).finally(() => switching.delete(requestId));
    switching.set(requestId, task);
    return task;
  }
  async function switchModel(member: SpaceIdentity, activityId: string, value: unknown) {
    if (writesClosed) throw new StorageError('maintenance');
    const input = teachingModelSwitchInputSchema.parse(value);
    const activity = await options.activity(member, activityId);
    const choice = await options.models.selection.pin(member, input.requestId, input.selectionVersion);
    const target = { model: modelFact(choice.choice.connection), source: {
      kind: choice.source.kind, feeSource: choice.source.feeSource } };
    const saved = await storage.request({ requestId: 'teaching-model-switch:' + input.requestId,
      fingerprint: canonicalDigest([member, activityId, input, target]) }, async tx => {
      await tx.query('INSERT INTO teaching_sessions(activity_id) VALUES($1) ON CONFLICT(activity_id) DO NOTHING', [activityId]);
      const { rows: [session] } = await tx.query('SELECT * FROM teaching_sessions WHERE activity_id=$1 FOR UPDATE', [activityId]);
      const { rows: pending } = await tx.query(`SELECT request_id FROM teaching_model_switches
        WHERE activity_id=$1 AND state IN ('accepted','paused') AND request_id<>$2 LIMIT 1`, [activityId, input.requestId]);
      if (pending.length) throw new StorageError('conflict');
      const { rows: transitioning } = await tx.query(`SELECT transition_id FROM teaching_segment_transitions
        WHERE activity_id=$1 AND state='accepted' AND reason<>'model-switch' LIMIT 1`, [activityId]);
      if (transitioning.length) throw new StorageError('resource-busy');
      const { rows: inserted } = await tx.query(`INSERT INTO teaching_model_switches(request_id,activity_id,selection_version,
        state,identity,target,from_segment_id,to_segment_id,close_request_id,create_request_id)
        VALUES($1,$2,$3,'accepted',$4,$5,$6,$7,$8,$9) ON CONFLICT(request_id) DO NOTHING RETURNING request_id`,
      [input.requestId, activityId, input.selectionVersion, JSON.stringify(member), JSON.stringify(target),
        session?.segment_id ?? null, operationId('teaching-switch-segment:' + input.requestId),
        operationId('teaching-switch-close:' + input.requestId), operationId('teaching-switch-create:' + input.requestId)]);
      if (inserted.length) await appendEvent(tx, activityId, 'model-switch-requested', {
        requestId: input.requestId, selectionVersion: input.selectionVersion, fromSegmentId: session?.segment_id ?? null, target });
      return null;
    });
    void saved;
    return applyModelSwitch(member, input.requestId);
  }

  type ModelAttemptFact = Awaited<ReturnType<TeachingAgentOptions['models']['checks']['read']>>;
  async function lastProgressEvent(activityId: string, attemptId: string) {
    const { rows: [row] } = await storage.read(`SELECT body FROM teaching_events WHERE activity_id=$1
      AND kind='assistant-progress' AND body->>'attemptId'=$2 ORDER BY seq DESC LIMIT 1`, [activityId, attemptId]);
    const body = row?.body as Record<string, unknown> | undefined;
    return { revision: Number(body?.revision ?? 0), length: Number(body?.length ?? 0) };
  }
  async function awaitAttempt(identity: SpaceIdentity, run: TeachingRun, generation: number, attemptId: string,
    segmentId: string, initial?: ModelAttemptFact): Promise<ModelAttemptFact> {
    let fact = initial ?? await options.models.checks.read(identity, attemptId);
    const { rows: [step] } = await storage.read('SELECT step_id,plan FROM teaching_steps WHERE attempt_id=$1', [attemptId]);
    const activity = await options.activity(identity, run.activityId);
    const bufferProgress = !!(step?.plan as { compaction?: unknown } | undefined)?.compaction
      || requiresExplanationReview(activity);
    const assembly = (step?.plan as { resolvedAgent?: ResolvedAgent } | undefined)?.resolvedAgent;
    const { rows: [priorArtifact] } = await storage.read(`SELECT body FROM teaching_events WHERE activity_id=$1
      AND kind='artifact-progress' AND body->>'attemptId'=$2 ORDER BY seq DESC LIMIT 1`, [run.activityId, attemptId]);
    const known = await lastProgressEvent(run.activityId, attemptId);
    let lastHeartbeat = Date.now(), unknownReads = 0,
      lastRevision = Math.max(known.revision, Number((priorArtifact?.body as { revision?: number } | undefined)?.revision ?? 0)), lastLength = known.length;
    async function publishProgress() {
      if (fact.physicalRequestEnded || (step?.plan as { compaction?: unknown } | undefined)?.compaction) return;
      const live = await options.models.checks.progress(identity, attemptId).catch(() => null);
      if (!live || live.revision <= lastRevision) return;
      const previews = (live.tools ?? []).filter(tool => tool.property === 'html' && tool.text
        && assembly?.tools.some(binding => binding.modelName === tool.name && binding.executor.toolName === 'generate_teaching_artifact')
        && teachingExplanationText(activity, tool.text) === tool.text);
      const delta = bufferProgress ? '' : live.text.slice(lastLength);
      try {
        await storage.request({ requestId: `teaching-progress:${attemptId}:${live.revision}`,
          fingerprint: `teaching-progress:${attemptId}` }, async tx => {
          await assertAuthority(tx, run.runId, generation);
          const { rows: [current] } = await tx.query('SELECT stop_requested FROM teaching_runs WHERE run_id=$1', [run.runId]);
          if (current?.stop_requested) return null;
          if (delta) await appendEvent(tx, run.activityId, 'assistant-progress', { runId: run.runId, attemptId, segmentId,
            revision: live.revision, length: live.text.length, delta });
          for (const preview of previews) await appendEvent(tx, run.activityId, 'artifact-progress', {
            runId: run.runId, stepId: step!.step_id, attemptId, segmentId, callId: preview.callId, name: preview.name,
            commandId: operationId('teaching-command:' + step!.step_id + ':' + preview.callId),
            html: preview.text, revision: live.revision });
          return null;
        });
        lastRevision = live.revision; if (delta) lastLength = live.text.length;
      } catch (error) {
        if (!(error instanceof StorageError) || !['conflict', 'maintenance'].includes(error.code)) throw error;
      }
    }
    await publishProgress();
    // A remote owner may have acknowledged dispatch while its durable attempt is still
    // accepted. That means no physical request has started, not that the answer has ended.
    while (fact.state === 'accepted' || !fact.physicalRequestEnded) {
      const stored = toRun(await runRow(run.runId));
      const { rows: [budget] } = await storage.read(`SELECT deadline<=clock_timestamp() AS expired FROM teaching_budgets WHERE run_id=$1`, [run.runId]);
      if ((stored.stopRequested || budget?.expired) && !fact.cancelRequested) await options.models.checks.cancel(identity, attemptId);
      if (Date.now() - lastHeartbeat > leaseMs / 2) { await heartbeat(run.runId, generation); lastHeartbeat = Date.now(); }
      await sleep(200);
      fact = await options.models.checks.read(identity, attemptId);
      await publishProgress();
      if (fact.state === 'unknown') unknownReads++; else unknownReads = 0;
      if (unknownReads >= 3) break;
    }
    return fact;
  }
  const inputs = createTeachingInputs(storage, { appendEvent, freezeBudget: (tx, runId) => driver.freezeBudget(tx, runId),
    supersedeQuestion: (tx, activityId, runId, inputId) => studentQuestions.supersede(tx, activityId, runId, inputId) });
  const inputControls = createTeachingInputControls(storage, { inputs, appendEvent,
    freezeBudget: (tx, runId) => driver.freezeBudget(tx, runId) });
  const runControls = createTeachingRunControls(storage, { models: options.models, appendEvent,
    freezeBudget: (tx, runId) => driver.freezeBudget(tx, runId) });
  const studentQuestions = createStudentQuestions(storage, { activity: options.activity, appendEvent });
  const driver = createTeachingRunDriver(storage, {
    ...options, tools, skillState: skillRuntime.state, driverId: ownerId, dispatchClosed: () => dispatchClosed, runRow, toRun, requestRow, identity: runIdentity,
    assertAuthority, appendEvent, historyBefore, historyForAssembly: fullHistory, ensureSegment, awaitAttempt, finish, studentQuestions, inputs,
  });

  const starting = new Set<string>();
  function kick(runId: string) {
    if (active.has(runId) || starting.has(runId) || dispatchClosed) return;
    starting.add(runId);
    const task = (async () => {
      const claimed = await claim(runId);
      if (!claimed) return;
      const { run, generation } = claimed;
      const renewal = setInterval(() => {
        if (!dispatchClosed && !writesClosed) void heartbeat(runId, generation).catch(() => {});
      }, Math.max(1, Math.floor(leaseMs / 3)));
      renewal.unref();
      try {
        if (options.withAuthority) await options.withAuthority({ runId, activityId: run.activityId, driverId: ownerId, generation }, () => driver.execute(run, generation));
        else await driver.execute(run, generation);
      } catch (error) {
        // A failed owner commit or lost lease never proves an external operation failed. Keep
        // the original step/attempt/command and let recovery query those identities.
        const reason = error instanceof TeachingBudgetError ? error.message : error instanceof z.ZodError ? 'corrupt' : error instanceof StorageError ? error.code
          : (error as { code?: string }).code === 'capability-unavailable' ? 'model-capability-unavailable' : '';
        if (error instanceof TeachingBudgetError || ['forbidden', 'invalid', 'missing', 'identity-conflict', 'resource-busy', 'corrupt', 'incompatible', 'resource-gone', 'model-capability-unavailable'].includes(reason)) {
          const row = await runRow(runId).catch(() => null);
          if (row && !terminal(row.state as TeachingRun['state'])) await finish(run, generation, 'paused', reason,
            (row.usage as ModelUsage) ?? { state: 'unknown' }, (row.model as TeachingRun['model']) ?? null,
            { kind: 'system-notice', body: { runId, reason } }).catch(() => {});
        }
      } finally { clearInterval(renewal); }
    })().finally(() => { starting.delete(runId); active.delete(runId) });
    active.set(runId, task);
    void task.catch(() => {});
  }
  async function scan() {
    if (dispatchClosed) return;
    const { rows: pendingSwitches } = await storage.read(`SELECT request_id,identity FROM teaching_model_switches
      WHERE state IN ('accepted','paused')`);
    for (const row of pendingSwitches) void applyModelSwitch(row.identity as SpaceIdentity, String(row.request_id)).catch(() => {});
    for (const runId of await driver.pollWaits()) kick(runId);
    const { rows } = await storage.read(`SELECT run_id FROM teaching_runs r WHERE
      (state IN ('received','running','dispatching') OR (state='waiting' AND (stop_requested OR EXISTS
        (SELECT 1 FROM teaching_inputs i WHERE i.waiting_on_run_id=r.run_id AND i.state='pending' AND i.mode='steering') OR EXISTS
        (SELECT 1 FROM teaching_budgets b WHERE b.run_id=r.run_id AND b.deadline<=clock_timestamp()) OR NOT EXISTS
        (SELECT 1 FROM teaching_waits w WHERE w.run_id=r.run_id AND w.state='pending'))))
      AND NOT (state='waiting' AND reason='model-switch-boundary' AND NOT stop_requested AND NOT EXISTS
        (SELECT 1 FROM teaching_budgets b WHERE b.run_id=r.run_id AND b.deadline<=clock_timestamp()) AND EXISTS
        (SELECT 1 FROM teaching_model_switches s WHERE s.activity_id=r.activity_id AND s.state IN ('accepted','paused')))
      AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp()) ORDER BY updated_at,created_at,run_id LIMIT 20`);
    for (const row of rows) kick(row.run_id as string);
  }
  function startTicker() {
    if (ticker) return;
    ticker = setInterval(() => { void scan().catch(() => {}); }, scanIntervalMs);
    ticker.unref?.();
    void scan().catch(() => {});
  }

  async function run(identity: SpaceIdentity, activityId: string, runId: string) {
    await options.activity(identity, activityId);
    const row = await runRow(runId);
    if (row.activity_id !== activityId) throw new StorageError('missing');
    return toRun(row);
  }
  async function conversation(identity: SpaceIdentity, activityId: string, after = 0): Promise<TeachingConversation> {
    await options.activity(identity, activityId);
    const cursor = Math.max(0, Math.trunc(after));
    const { rows } = await storage.read('SELECT * FROM teaching_events WHERE activity_id=$1 AND seq>$2 ORDER BY seq', [activityId, cursor]);
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      if (Number(row.seq) !== cursor + index + 1) throw new StorageError('corrupt');
      if (!teachingEventSchema.safeParse({ activityId, seq: Number(row.seq), eventId: row.event_id, kind: row.kind,
        version: row.event_version, body: row.body, createdAt: new Date(row.created_at as string).toISOString() }).success)
        throw new StorageError('incompatible');
    }
    const { rows: runRows } = await storage.read('SELECT * FROM teaching_runs WHERE activity_id=$1 ORDER BY created_at', [activityId]);
    const messages: TeachingMessage[] = [];
    const artifactPreviews = new Map<string, TeachingArtifactPreview>();
    // Progress and the final answer for one attempt share a stable message identity; polling
    // clients merge them by eventId instead of showing the answer twice.
    const assistantSlots = new Map<string, number>();
    const settledAttempts = new Set<string>();
    for (const row of rows) {
      const kind = row.kind as TeachingEventKind, body = row.body as Record<string, unknown>;
      const base = { eventId: row.event_id as string, seq: Number(row.seq), createdAt: new Date(row.created_at as string).toISOString() };
      const attemptId = typeof body.attemptId === 'string' ? body.attemptId : '';
      if (kind === 'input' || kind === 'input-promoted') messages.push({ ...base, role: 'student', text: String(body.question ?? ''),
        ...(typeof body.inputId === 'string' ? { inputId: body.inputId } : {}), runId: (body.runId as string) ?? null });
      else if (kind === 'student-response' && body.status === 'accepted') messages.push({ ...base, role: 'student',
        kind: 'student-response', text: String(body.text ?? ''), runId: (body.runId as string) ?? null });
      else if (kind === 'native-summary' && body.source === 'model-native' && typeof body.text === 'string' && body.text)
        messages.push({ ...base, role: 'system', kind: 'native-summary', text: body.text,
          ...(body.truncated === true ? { summaryTruncated: true } : {}),
          runId: (body.runId as string) ?? null });
      else if (kind === 'artifact-progress') {
        const commandId = String(body.commandId);
        artifactPreviews.set(commandId, { runId: String(body.runId), stepId: String(body.stepId), attemptId,
          commandId, callId: String(body.callId), name: String(body.name), html: String(body.html),
          revision: Number(body.revision), seq: base.seq, createdAt: artifactPreviews.get(commandId)?.createdAt ?? base.createdAt });
      }
      else if (kind === 'assistant-progress') {
        if (attemptId && settledAttempts.has(attemptId)) continue;
        const delta = typeof body.delta === 'string' ? body.delta : '';
        const at = attemptId ? assistantSlots.get(attemptId) : undefined;
        if (at === undefined) {
          if (attemptId) assistantSlots.set(attemptId, messages.length);
          messages.push({ ...base, eventId: attemptId ? operationId('teaching-assistant:' + attemptId) : base.eventId,
            role: 'assistant', text: delta, runId: (body.runId as string) ?? null, state: 'streaming' });
        } else {
          const prior = messages[at]!;
          messages[at] = { ...prior, seq: base.seq, text: prior.text + delta };
        }
      } else if (kind === 'assistant') {
        const state = body.state === 'stopped' ? 'stopped' : body.state === 'failed' ? 'failed' : 'settled';
        if (attemptId) settledAttempts.add(attemptId);
        const at = attemptId ? assistantSlots.get(attemptId) : undefined;
        if (at === undefined) {
          if (attemptId) assistantSlots.set(attemptId, messages.length);
          messages.push({ ...base, eventId: attemptId ? operationId('teaching-assistant:' + attemptId) : base.eventId,
            role: 'assistant', text: String(body.text ?? ''), runId: (body.runId as string) ?? null, state,
            ...(body.model ? { model: body.model as never } : {}),
            ...(body.modelSource === 'school' || body.modelSource === 'personal' ? { modelSource: body.modelSource } : {}) });
        } else {
          const prior = messages[at]!;
          messages[at] = { ...prior, seq: base.seq, text: String(body.text ?? ''), state,
            ...(body.model ? { model: body.model as never } : {}),
            ...(body.modelSource === 'school' || body.modelSource === 'personal' ? { modelSource: body.modelSource } : {}) };
        }
      }
      else if (kind === 'model-unavailable') messages.push({ ...base, role: 'system',
        text: `暂时无法继续：${reasonText(body.reason) || '没有可用模型'}。请到模型设置检查连接后重试。`,
        runId: (body.runId as string) ?? null });
      else if (kind === 'capacity-paused') {
        const scope = body.requiredScope as { workNames?: unknown; referenceNames?: unknown } | undefined;
        const names = [...new Set([scope?.workNames, scope?.referenceNames].flatMap(value => Array.isArray(value)
          ? value.filter((name): name is string => typeof name === 'string' && name.trim().length > 0) : []))];
        const objects = names.length ? `本次涉及${names.slice(0, 3).map(name => `「${name}」`).join('、')}${names.length > 3
          ? `及另外 ${names.length - 3} 项` : ''}，可先缩小这些对象的范围。` : '';
        messages.push({ ...base, role: 'system',
          text: '这次请求超出可处理的内容范围，完整输入与历史已保留。请缩短问题或减少固定作品、引用的范围后重试。' + objects,
          runId: (body.runId as string) ?? null });
      }
      else if (kind === 'run-failed') messages.push({ ...base, role: 'system',
        text: `本次回答未完成${reasonText(body.reason) ? `：${reasonText(body.reason)}` : ''}。原问题与历史已保留，可明确继续。`,
        runId: (body.runId as string) ?? null });
      else if (kind === 'system-notice' && body.reason === 'step-record-unavailable') messages.push({ ...base, role: 'system',
        text: '原任务的恢复依据不完整，已暂停。原请求和结果仍保留，没有重新执行。',
        runId: (body.runId as string) ?? null });
      else if (kind === 'system-notice' && body.reason === 'skill-loaded') messages.push({ ...base, role: 'system',
        text: `已读取 Skill「${String(body.source)}」${String(body.packageVersion)} · v${String(body.version)} / ${String(body.path)}`
          + `（${Number(body.offset)}–${Number(body.offset) + Number(body.byteLength)} / ${Number(body.totalByteLength)} 字节）。`,
        ...(body.loaded ? { skillSource: body.loaded as never } : {}),
        runId: (body.runId as string) ?? null });
      else if (kind === 'system-notice' && ['required-capability-unavailable', 'capability-conflict', 'tool-capacity-exceeded'].includes(String(body.reason))) {
        const affected = (Array.isArray(body.unavailable) ? body.unavailable : []).flatMap(item => {
          const fact = item as { sourceId?: unknown; reason?: unknown } | null;
          return typeof fact?.sourceId === 'string' ? [fact.sourceId + (typeof fact.reason === 'string' ? `（${fact.reason}）` : '')] : [];
        });
        const reason = body.reason === 'required-capability-unavailable' ? '所需能力暂不可用'
          : body.reason === 'capability-conflict' ? '能力定义发生冲突' : '本次所需工具超过可用容量';
        messages.push({ ...base, role: 'system', runId: (body.runId as string) ?? null,
          text: `本次回答已暂停：${reason}。${affected.length ? '受影响来源：' + affected.join('、') + '。' : ''}原问题与已发生结果仍保留。` });
      }
      else if (kind === 'system-notice' && ['model-step-budget-exhausted', 'tool-budget-exhausted'].includes(String(body.reason)))
        messages.push({ ...base, role: 'system', text: body.reason === 'model-step-budget-exhausted'
          ? '本次任务的计算预算已用尽，已暂停继续生成。原问题、明确回应与已发生的结果仍保留。'
          : '本次任务的工具操作预算已用尽，已暂停新操作。原问题、明确回应与已发生的结果仍保留。',
        runId: (body.runId as string) ?? null });
      else if (kind === 'system-notice' && ['input-token-budget-exhausted', 'output-token-budget-exhausted',
        'model-call-budget-exhausted', 'run-deadline-exceeded', 'input-budget-bound-unavailable'].includes(String(body.reason)))
        messages.push({ ...base, role: 'system', text: body.reason === 'run-deadline-exceeded'
          ? '本次任务已到截止时间，已暂停新操作。原问题、明确回应和已发生的结果仍保留。'
          : body.reason === 'input-budget-bound-unavailable' ? '当前模型缺少窗口上限，暂时无法核定输入预算，任务已暂停。'
          : '本次任务的累计模型预算已用尽，已暂停继续生成。切换模型或重启不会重置原预算。',
        runId: (body.runId as string) ?? null });
      else if (kind === 'model-switch-completed') {
        const target = body.target as { model?: { modelId?: string }; source?: { kind?: string } } | undefined;
        messages.push({ ...base, role: 'system',
          text: `已切换到${target?.source?.kind === 'school' ? '学校' : '个人'}模型${target?.model?.modelId ? `「${target.model.modelId}」` : ''}。已有对话和工具结果保持原出处，下一条问题从新模型继续。`,
          runId: null });
      }
      else if (kind === 'model-switch-paused') messages.push({ ...base, role: 'system',
        text: body.reason === 'segment-busy' ? '模型切换正在等待原回答或工具完成；没有改写在途任务，也没有回退到其他模型。'
          : '模型切换尚未完成；原对话、模型边界和草稿已保留，没有自动改用其他费用来源。', runId: null });
    }
    // A progress message whose run already settled without a final answer (driver loss, pause)
    // must not stay "streaming" forever.
    const runStates = new Map(runRows.map(row => [row.run_id as string, row.state as TeachingRun['state']]));
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]!;
      const state = message.runId ? runStates.get(message.runId) : undefined;
      if (message.role !== 'assistant' || message.state !== 'streaming' || !state
        || ['received', 'running', 'dispatching', 'waiting'].includes(state)) continue;
      messages[index] = { ...message, state: state === 'stopped' ? 'stopped' : state === 'failed' ? 'failed' : 'unknown' };
    }
    // The cursor may only cover events actually delivered in this response; a later commit is
    // read on the next poll instead of being skipped by a concurrent max(seq).
    const { tools, waits } = await driver.records(activityId);
    return teachingConversationSchema.parse({ activityId, cursor: rows.length ? Number(rows.at(-1)!.seq) : cursor, messages,
      runs: runRows.map(toRun), tools, waits, questions: await studentQuestions.list(activityId),
      inputs: await inputs.list(activityId), artifactPreviews: [...artifactPreviews.values()] });
  }
  async function events(identity: SpaceIdentity, activityId: string, after = 0): Promise<TeachingEvent[]> {
    await options.activity(identity, activityId);
    const { rows } = await storage.read('SELECT * FROM teaching_events WHERE activity_id=$1 AND seq>$2 ORDER BY seq',
      [activityId, Math.max(0, Math.trunc(after))]);
    return rows.map(row => teachingEventSchema.parse({ activityId: row.activity_id, seq: Number(row.seq), eventId: row.event_id,
      kind: row.kind, version: row.event_version, body: row.body, createdAt: new Date(row.created_at as string).toISOString() }));
  }
  async function snapshot(identity: SpaceIdentity, activityId: string, snapshotId: string): Promise<TeachingSnapshot> {
    await options.activity(identity, activityId);
    const { rows: [row] } = await storage.read('SELECT * FROM teaching_snapshots WHERE snapshot_id=$1 AND activity_id=$2',
      [snapshotId, activityId]);
    if (!row) throw new StorageError('missing');
    const parsed = teachingSnapshotSchema.parse(row.body);
    const bytes = Buffer.from(await storage.readResource(row.resource_id as string));
    if (canonicalDigest(parsed.payload) !== parsed.payloadSha256) throw new StorageError('corrupt');
    if (bytes.byteLength === 0 || canonicalDigest(JSON.parse(bytes.toString('utf8'))) !== canonicalDigest(parsed)) throw new StorageError('corrupt');
    return parsed;
  }
  async function request(identity: SpaceIdentity, activityId: string, requestId: string) {
    await options.activity(identity, activityId);
    const row = await requestRow(requestId);
    if (!row || row.activity_id !== activityId) return null;
    return actionReceiptSchema.parse(row.receipt);
  }
  async function stop(identity: SpaceIdentity, activityId: string, runId: string, value: unknown) {
    if (writesClosed) throw new StorageError('maintenance');
    await options.activity(identity, activityId);
    const input = teachingStopInputSchema.parse(value);
    const current = toRun(await runRow(runId));
    if (current.activityId !== activityId) throw new StorageError('missing');
    await runControls.stop(activityId, runId, input);
    await stopAttempt(runId);
    await driver.stopTools(toRun(await runRow(runId)));
    kick(runId);
    return toRun(await runRow(runId));
  }
  async function continueRun(identity: SpaceIdentity, activityId: string, runId: string, value: unknown) {
    if (writesClosed) throw new StorageError('maintenance');
    await options.activity(identity, activityId);
    const input = teachingContinueInputSchema.parse(value);
    if (!('version' in input)) {
      // Old committed continue requests remain queryable byte-for-byte. New unqualified
      // controls can only resume a recoverable original Run; they cannot invent a retry input.
      const old = await storage.receipt('teaching-continue:' + input.requestId);
      if (old) {
        const accepted = actionReceiptSchema.parse(old.result);
        const prior = toRun(await runRow(JSON.parse(accepted.detail).runId));
        if (prior.activityId !== activityId || prior.previousRunId !== runId) throw new StorageError('forbidden');
        kick(prior.runId); return prior;
      }
    }
    const receipt = await runControls.continueSelected(identity, activityId, runId,
      'version' in input ? input : { version: 2, requestId: input.requestId, inputs: [] });
    if (receipt.status !== 'accepted' || !receipt.continuedRunId) throw new StorageError('conflict');
    kick(receipt.continuedRunId);
    return toRun(await runRow(receipt.continuedRunId));
  }
  async function capabilities(member: SpaceIdentity, activityId: string) {
    await options.activity(member, activityId);
    try {
      const selection = await options.models.selection.read(member);
      return { receiver: identity, modelAvailable: !!selection.selected,
        ...(selection.selected ? {} : { modelUnavailableReason: selection.unavailableReason ?? 'model-not-selected' }) };
    } catch (error) {
      if (!(error instanceof StorageError)) throw error;
      return { receiver: identity, modelAvailable: false, modelUnavailableReason: error.code };
    }
  }
  /** New Driver dispatch requires a live lease; an owner-held accepted command may be claimed while its Run sleeps. */
  async function assertCommandDispatch(identity: SpaceIdentity, activityId: string,
    association: { runId: string; stepId: string; snapshotId: string; commandId: string; authority?: TeachingDispatchAuthority;
      adoption?: TeachingArtifactAdoptionAuthority }) {
    if (dispatchClosed || writesClosed) throw new StorageError('maintenance');
    await options.authorize(identity);
    if ((await options.activity(identity, activityId)).status !== 'open') throw new StorageError('forbidden');
    const adoption = association.adoption ? teachingArtifactAdoptionAuthoritySchema.parse(association.adoption) : undefined;
    if (adoption && association.authority) throw new StorageError('forbidden');
    if (!adoption) {
      const { rows: [budget] } = await storage.read('SELECT deadline<=clock_timestamp() AS expired FROM teaching_budgets WHERE run_id=$1', [association.runId]);
      if (!budget || budget.expired) throw new StorageError('forbidden');
    }
    await storage.pendingIntents();
    const authority = association.authority ? teachingDispatchAuthoritySchema.parse(association.authority) : undefined;
    if (authority && (authority.runId !== association.runId || authority.activityId !== activityId)) throw new StorageError('forbidden');
    await storage.request({ requestId: 'teaching-verify-command:'+randomUUID(), fingerprint: association.commandId }, async tx => {
      const { rows: [row] } = await tx.query(`SELECT r.*,c.state AS command_state,c.generation AS command_generation,s.snapshot_id,
          c.command,c.outcome,s.attempt_id AS command_attempt_id,
          r.lease_expires_at>=clock_timestamp() AS live
        FROM teaching_commands c JOIN teaching_runs r ON r.run_id=c.run_id JOIN teaching_steps s ON s.step_id=c.step_id
        WHERE c.command_id=$1 AND c.run_id=$2 AND c.step_id=$3 AND r.activity_id=$4 FOR UPDATE OF r,c`,
        [association.commandId, association.runId, association.stepId, activityId]);
      if (dispatchClosed || writesClosed || !row || canonicalDigest(runIdentity(row)) !== canonicalDigest(identity)
        || row.snapshot_id !== association.snapshotId) throw new StorageError('forbidden');
      const noLongerEligible = row.stop_requested || row.reason === 'student-response-expired'
        || terminal(row.state as TeachingRun['state']) && !(adoption && row.state === 'completed');
      if (adoption) {
        const command = row.command as TeachingPreparedTool, outcome = row.outcome as TeachingToolOutcome | null;
        const published = teachingArtifactReceiptSchema.safeParse(outcome?.result.artifact);
        if (command.name !== 'generate_teaching_artifact' || adoption.attemptId && row.command_attempt_id !== adoption.attemptId)
          throw new StorageError('forbidden');
        if (noLongerEligible || row.command_state !== 'settled' || outcome?.state !== 'completed') throw new StorageError('conflict');
        if (!published.success || published.data.kind !== 'publish' || published.data.requestId !== association.commandId
          || published.data.artifactId !== adoption.artifactId || published.data.revisionId !== adoption.revisionId
          || published.data.candidateId !== adoption.candidateId) throw new StorageError('forbidden');
      } else if (noLongerEligible || !['dispatching', 'waiting'].includes(String(row.command_state))
        || authority && (row.generation !== authority.generation || row.command_generation !== authority.generation
          || row.lease_owner !== authority.driverId || !row.live)) throw new StorageError('forbidden');
      return null;
    });
  }
  async function validate() {
    await validateTeachingAgent(storage);
  }
  async function respond(identity: SpaceIdentity, activityId: string, questionId: string, value: unknown) {
    if (writesClosed) throw new StorageError('maintenance');
    const receipt = await studentQuestions.respond(identity, activityId, questionId, value);
    if (receipt.status === 'accepted' && receipt.runId) kick(receipt.runId);
    return receipt;
  }
  async function presentQuestion(identity: SpaceIdentity, activityId: string, questionId: string, value: unknown) {
    if (writesClosed) throw new StorageError('maintenance');
    return studentQuestions.present(identity, activityId, questionId, value);
  }

  async function assertModelDispatch(identity: SpaceIdentity, activityId: string,
    value: TeachingDispatchAuthority & { attemptId: string; dispatch: boolean }) {
    if (dispatchClosed || writesClosed) throw new StorageError('maintenance');
    await options.authorize(identity);
    const { rows: [budget] } = await storage.read('SELECT deadline>clock_timestamp() AS live FROM teaching_budgets WHERE run_id=$1', [value.runId]);
    if (!budget?.live) throw new StorageError('forbidden');
    if (value.activityId !== activityId || (await options.activity(identity, activityId)).status !== 'open') throw new StorageError('forbidden');
    const { rows: [row] } = await storage.read(`SELECT r.*,s.dispatch_permitted,s.dispatch_generation FROM teaching_steps s
      JOIN teaching_runs r USING(run_id) WHERE s.attempt_id=$1 AND r.run_id=$2 AND r.activity_id=$3`,
      [value.attemptId, value.runId, activityId]);
    if (!row || JSON.stringify(runIdentity(row)) !== JSON.stringify(identity) || row.stop_requested || terminal(row.state as TeachingRun['state'])
      || row.reason === 'student-response-expired' || row.generation !== value.generation || value.dispatch && (!row.dispatch_permitted || row.dispatch_generation !== value.generation))
      throw new StorageError('forbidden');
    await storage.request({ requestId: 'teaching-verify-permit:'+randomUUID(), fingerprint: value.attemptId }, async tx => {
      const { rows: [current] } = await tx.query(`SELECT state,reason,stop_requested,generation,lease_owner,lease_expires_at>=clock_timestamp() AS live,
        (SELECT deadline>clock_timestamp() FROM teaching_budgets WHERE run_id=$1) AS budget_live
        FROM teaching_runs WHERE run_id=$1 FOR UPDATE`, [value.runId]);
      if (dispatchClosed || writesClosed || !current || current.stop_requested || terminal(current.state as TeachingRun['state'])
        || current.reason === 'student-response-expired' || current.generation !== value.generation || current.lease_owner !== value.driverId || !current.live || !current.budget_live) throw new StorageError('forbidden');
      return null;
    });
  }

  const receiver: ActionReceiver = { identity, accept, query, cancel };
  if (options.start !== false) startTicker();
  return {
    receiver, migrations: teachingAgentMigrations, accept, query, cancel,
    skills: { list: skills.list, import: skills.import, select: skills.select.bind(skills), disable: skills.disable, read: skills.read },
    studentFacts: { read: studentFacts.read },
    run, conversation, events, snapshot, request, stop, continueRun, switchModel, capabilities, assertCommandDispatch, assertModelDispatch, validate,
    respond, response: studentQuestions.response, presentQuestion,
    async controlInput(identity: SpaceIdentity, activityId: string, inputId: string, value: unknown) {
      if (writesClosed) throw new StorageError('maintenance');
      await options.activity(identity, activityId);
      z.uuid().parse(inputId);
      const receipt = await inputControls.control(activityId, inputId, value);
      if (receipt.replacementInputId) {
        const { rows: [next] } = await storage.read('SELECT waiting_on_run_id FROM teaching_inputs WHERE input_id=$1', [receipt.replacementInputId]);
        if (next) kick(String(next.waiting_on_run_id));
      }
      return receipt;
    },
    async inputControlReceipt(identity: SpaceIdentity, activityId: string, requestId: string) {
      await options.activity(identity, activityId);
      z.uuid().parse(requestId);
      return inputControls.receipt(activityId, requestId);
    },
    closeWrites() { writesClosed = true; if (ticker) clearInterval(ticker); ticker = undefined; },
    closeDispatch() { dispatchClosed = true; if (ticker) clearInterval(ticker); ticker = undefined; },
    async drain() {
      const deadline = Date.now() + 25_000;
      while (active.size || switching.size) {
        if (Date.now() >= deadline) throw new StorageError('maintenance');
        await Promise.allSettled([...active.values(), ...switching.values()]);
      }
    },
    resume() { writesClosed = false; dispatchClosed = false; startTicker(); void scan().catch(() => {}); },
    close() { writesClosed = true; dispatchClosed = true; if (ticker) clearInterval(ticker); ticker = undefined; },
  };
}

/** Recovery validation reads only this owner's durable facts; it never triggers a model call. */
export async function validateTeachingAgent(storage: OwnedStorage) {
  await validateTeachingSkills(storage);
  await validateTeachingSkillLoads(storage);
  await validateTeachingStudentFacts(storage);
  await createChunkChannel(storage).validate(value => {
    const call = teachingAgentCallSchema.safeParse(value);
    return call.success && call.data.operation === 'conversation';
  });
  await validateTeachingSegmentTransitions(storage);
  await validateTeachingDependencyBindings(storage);
  const { rows: requests } = await storage.read('SELECT * FROM teaching_requests');
  for (const row of requests) {
    const saved = actionReceiptSchema.parse(row.receipt);
    if (saved.requestId !== row.request_id || saved.inputDigest !== row.input_digest) throw new StorageError('corrupt');
    if (row.body && digest(actionInputSchema.parse(row.body)) !== row.input_digest) throw new StorageError('corrupt');
    if (row.run_id) {
      const { rows: [run] } = await storage.read('SELECT activity_id FROM teaching_runs WHERE run_id=$1', [row.run_id]);
      if (!run || run.activity_id !== row.activity_id) throw new StorageError('corrupt');
    }
  }
  const { rows: runs } = await storage.read('SELECT * FROM teaching_runs');
  for (const row of runs) {
    const run = teachingRunSchema.parse({
      runId: row.run_id, activityId: row.activity_id, requestId: row.request_id, inputId: row.input_id,
      state: row.state, reason: row.reason, stopRequested: row.stop_requested, previousRunId: row.previous_run_id ?? null,
      attemptId: row.attempt_id ?? null, segmentId: row.segment_id ?? null, model: row.model ?? null, usage: row.usage,
      createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString(),
      completedAt: row.completed_at ? new Date(row.completed_at as string).toISOString() : null,
    });
    const { rows: [request] } = await storage.read('SELECT activity_id FROM teaching_requests WHERE request_id=$1', [run.requestId]);
    if (!request || request.activity_id !== run.activityId) throw new StorageError('corrupt');
  }
  const { rows: sessions } = await storage.read('SELECT * FROM teaching_sessions');
  for (const session of sessions) {
    const { rows } = await storage.read('SELECT * FROM teaching_events WHERE activity_id=$1 ORDER BY seq', [session.activity_id]);
    if (rows.some((row, index) => Number(row.seq) !== index + 1)) throw new StorageError('corrupt');
    for (const row of rows) teachingEventSchema.parse({ activityId: row.activity_id, seq: Number(row.seq), eventId: row.event_id,
      kind: row.kind, version: row.event_version, body: row.body, createdAt: new Date(row.created_at as string).toISOString() });
    const { rows: [last] } = await storage.read('SELECT max(seq)::bigint AS seq FROM teaching_events WHERE activity_id=$1', [session.activity_id]);
    if (Number(last?.seq ?? 0) + 1 !== Number(session.next_seq)) throw new StorageError('corrupt');
  }
  const { rows: snapshots } = await storage.read('SELECT * FROM teaching_snapshots');
  for (const row of snapshots) {
    const body = teachingSnapshotSchema.parse(row.body);
    const bytes = Buffer.from(await storage.readResource(row.resource_id as string));
    if (bytes.byteLength === 0 || canonicalDigest(body.payload) !== body.payloadSha256
      || canonicalDigest(JSON.parse(bytes.toString('utf8'))) !== canonicalDigest(body))
      throw new StorageError('corrupt');
  }
  const { rows: steps } = await storage.read('SELECT * FROM teaching_steps');
  const { rows: budgets } = await storage.read('SELECT * FROM teaching_budgets');
  for (const budget of budgets) {
    for (const field of ['max_model_steps','max_tool_commands','max_parallel_tools','wait_ms','max_input_tokens','max_output_tokens','max_call_ms'])
      if (!Number.isSafeInteger(Number(budget[field])) || Number(budget[field]) < 1) throw new StorageError('corrupt');
    if (!Number.isFinite(new Date(budget.deadline as string).getTime())) throw new StorageError('corrupt');
  }
  for (const step of steps) {
    const plan = step.plan as { input: unknown };
    const input = modelLearningInputSchema.parse(plan.input);
    if (input.attemptId !== step.attempt_id || input.segmentId !== step.segment_id
      || step.step_id !== operationId(`step:${step.run_id}:${step.step_no}`)
      || step.snapshot_id !== operationId('model-snapshot:' + step.step_id)
      || input.limits.maxOutputTokens !== step.output_reserved || !budgets.some(budget => budget.run_id === step.run_id)
      || !Number.isSafeInteger(Number(step.input_reserved)) || Number(step.input_reserved) < 1
      || !Number.isSafeInteger(Number(step.call_reserved_ms)) || Number(step.call_reserved_ms) < 1
      || step.call_settled_ms !== null && (!Number.isSafeInteger(Number(step.call_settled_ms)) || Number(step.call_settled_ms) < 0))
      throw new StorageError('corrupt');
    if (step.phase !== 'planned') {
      const snapshot = snapshots.find(row => row.snapshot_id === step.snapshot_id);
      if (!snapshot || snapshot.run_id !== step.run_id || snapshot.attempt_id !== step.attempt_id
        || snapshot.segment_id !== step.segment_id) throw new StorageError('corrupt');
    }
  }
  const { rows: commands } = await storage.read('SELECT * FROM teaching_commands');
  for (const command of commands) {
    const saved = command.command as { version: number; commandId: string };
    const step = steps.find(step => step.step_id === command.step_id);
    if (!step || step.run_id !== command.run_id || saved.version !== 1 || saved.commandId !== command.command_id
      || saved.commandId !== operationId('teaching-command:' + command.step_id + ':' + command.call_id)) throw new StorageError('corrupt');
    for (const outcome of [command.outcome, command.initial_outcome]) {
      if (outcome) modelToolResultSchema.parse({ callId: command.call_id, ...(outcome as { feedback: object }).feedback });
    }
    if (command.resource_id) {
      const bytes = await storage.readResource(String(command.resource_id));
      if (canonicalDigest(JSON.parse(Buffer.from(bytes).toString('utf8'))) !== canonicalDigest(command.outcome)) throw new StorageError('corrupt');
    }
  }
  const { rows: waits } = await storage.read('SELECT * FROM teaching_waits');
  for (const wait of waits) {
    const command = commands.find(command => command.command_id === wait.command_id);
    if (!command || command.step_id !== wait.step_id || command.run_id !== wait.run_id
      || !['result', 'cleanup'].includes(String(wait.purpose))
      || canonicalDigest(command.command) !== wait.command_digest
      || wait.wait_id !== operationId((wait.purpose === 'cleanup' ? 'teaching-cleanup-wait:' : 'teaching-wait:') + wait.command_id)
      || (wait.state === 'consumed' || wait.purpose === 'cleanup') && command.state !== 'settled') throw new StorageError('corrupt');
    if (wait.observed_step_id) {
      const observed = steps.find(step => step.step_id === wait.observed_step_id);
      const plan = observed?.plan as { inputVersions?: unknown[]; waitVersions?: { waitId: string; outcomeDigest: string }[] } | undefined;
      if (!observed || observed.run_id !== wait.run_id || wait.state !== 'consumed' || wait.purpose !== 'result') throw new StorageError('corrupt');
      if (plan?.inputVersions) {
        const fixed = plan.waitVersions?.find(fixed => fixed.waitId === wait.wait_id);
        const { rows: observations } = await storage.read(`SELECT body FROM teaching_events WHERE activity_id=$1
          AND kind='wait-observed' AND body->>'waitId'=$2 AND body->>'stepId'=$3`, [runs.find(run => run.run_id === wait.run_id)?.activity_id,
          wait.wait_id, wait.observed_step_id]);
        const fact = observations[0]?.body as { outcomeDigest?: string; outcome?: unknown } | undefined;
        // Cleanup can append a new physical-state head. The model consumed the immutable
        // observation committed with its plan, never that later mutable command projection.
        if (!fixed || observations.length !== 1 || !fact?.outcome || fact.outcomeDigest !== fixed.outcomeDigest
          || canonicalDigest(fact.outcome) !== fixed.outcomeDigest) throw new StorageError('corrupt');
        const outcome = fact.outcome as { feedback: object };
        modelToolResultSchema.parse({ callId: command.call_id, ...outcome.feedback });
      }
    }
  }
  await validateStudentQuestions(storage);
  await validateTeachingInputs(storage);
  const { rows: switches } = await storage.read('SELECT * FROM teaching_model_switches');
  for (const row of switches) {
    const target = row.target as { model: unknown; source: unknown };
    teachingModelSwitchSchema.parse({ requestId: row.request_id, activityId: row.activity_id,
      selectionVersion: Number(row.selection_version), state: row.state, reason: row.reason,
      fromSegmentId: row.from_segment_id ?? null, toSegmentId: row.to_segment_id,
      model: target.model, source: target.source, createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString() });
    const session = sessions.find(item => item.activity_id === row.activity_id);
    // A completed switch remains durable history after a later switch advances the
    // session to another segment, so only require the owning session to exist here.
    if (!session) throw new StorageError('corrupt');
  }
  await validateTeachingAssemblyData(storage);
  await validateTeachingCompactions(storage);
}
