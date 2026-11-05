import { createHash, randomUUID } from 'node:crypto';
import { StorageError, type Migration, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import { actionInputSchema, actionReceiptSchema } from '@xunjie/contracts/action-intents';
import type { ActionInput, ActionReceipt, ActionReceiver } from '@xunjie/contracts/action-intents';
import type { ModelUsage } from '@xunjie/contracts/model-connections';
import {
  teachingAgentReceiverId, teachingContinueInputSchema, teachingConversationSchema, teachingEventSchema,
  teachingRunSchema, teachingSnapshotSchema, teachingStopInputSchema,
} from '@xunjie/contracts/teaching-agent';
import type {
  TeachingConversation, TeachingEvent, TeachingEventKind, TeachingMessage, TeachingRun, TeachingSnapshot,
} from '@xunjie/contracts/teaching-agent';
import { buildContext, type ContextMessage } from './context.js';
import type { createModelGateway } from '../model-connections/index.js';

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
` }];

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** PostgreSQL jsonb does not preserve object key order; reconstruction hashes use a canonical form. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}
const canonicalDigest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const terminal = (state: TeachingRun['state']) => ['completed', 'failed', 'stopped', 'paused'].includes(state);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function operationId(value: string) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type RunRow = Record<string, unknown>;
type RequestRow = Record<string, unknown>;

export interface TeachingAgentOptions {
  authorize(identity: SpaceIdentity): Promise<void>;
  identityFor(scope: { environmentId: string; spaceId: string; principalId: string }): Promise<SpaceIdentity>;
  activity(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
  models: Awaited<ReturnType<typeof createModelGateway>>;
  leaseMs?: number;
  scanIntervalMs?: number;
  /** Durable authority identity; separate process namespaces must differ even when they share storage in tests. */
  driverId?: string;
  start?: boolean;
}

export function createTeachingAgent(storage: OwnedStorage, options: TeachingAgentOptions) {
  const ownerId = options.driverId ?? JSON.stringify([storage.owner.environmentId, storage.owner.serviceId, process.pid]);
  const leaseMs = options.leaseMs ?? 10_000;
  const scanIntervalMs = options.scanIntervalMs ?? 5_000;
  const receiverId = teachingAgentReceiverId(storage.owner.serviceId);
  const identity: ActionReceiver['identity'] = { receiverId, location: 'remote', kind: 'question' };
  const active = new Map<string, Promise<void>>();
  let writesClosed = false;
  let dispatchClosed = false;
  let ticker: ReturnType<typeof setInterval> | undefined;

  function toRun(row: RunRow): TeachingRun {
    return teachingRunSchema.parse({
      runId: row.run_id, activityId: row.activity_id, requestId: row.request_id, inputId: row.input_id,
      state: row.state, reason: row.reason, stopRequested: row.stop_requested,
      previousRunId: row.previous_run_id ?? null, attemptId: row.attempt_id ?? null, segmentId: row.segment_id ?? null,
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
    const accepted = receipt(input, inputDigest, 'accepted', runId, inputId);
    const stored = await storage.request({ requestId: 'teaching-accept:' + input.requestId,
      fingerprint: digest({ scope: input.scope, inputDigest }) }, async tx => {
      const { rows: [prior] } = await tx.query('SELECT state,receipt FROM teaching_requests WHERE request_id=$1 FOR UPDATE', [input.requestId]);
      if (prior) return prior.receipt;
      await tx.query('INSERT INTO teaching_sessions(activity_id) VALUES($1) ON CONFLICT(activity_id) DO NOTHING', [input.scope.activityId]);
      await tx.query(`INSERT INTO teaching_requests(request_id,activity_id,input_digest,body,state,run_id,input_id,receipt)
        VALUES($1,$2,$3,$4,'accepted',$5,$6,$7)`, [input.requestId, input.scope.activityId, inputDigest,
        JSON.stringify(input), runId, inputId, JSON.stringify(accepted)]);
      await tx.query(`INSERT INTO teaching_runs(run_id,activity_id,request_id,input_id,identity,state,usage)
        VALUES($1,$2,$3,$4,$5,'received',$6)`, [runId, input.scope.activityId, input.requestId, inputId,
        JSON.stringify({ environmentId: input.scope.environmentId, spaceId: input.scope.spaceId,
          principalId: input.scope.principalId, kind: activity.identity.kind, name: activity.identity.name }),
        JSON.stringify({ state: 'unknown' })]);
      await appendEvent(tx, input.scope.activityId, 'input', { runId, requestId: input.requestId, inputId,
        question: input.draft.question, references: input.draft.references.map(reference => ({ referenceId: reference.referenceId,
          source: reference.source, sourceName: reference.sourceName, copy: reference.copy })), works: input.works.map(work => ({ objectId: work.objectId,
          name: work.name, kind: work.kind })), goal: activity.goal, activityQuestion: activity.question });
      await appendEvent(tx, input.scope.activityId, 'run-received', { runId, requestId: input.requestId, inputId });
      return accepted;
    });
    kick(runId);
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
    const row = await requestRow(requestId);
    if (!row) {
      const tombstone = actionReceiptSchema.parse({ requestId, inputDigest, receiver: identity, state: 'cancelled',
        receiptId: requestId, detail: JSON.stringify({ version: 1, runId: null, inputId: null }) });
      await storage.request({ requestId: 'teaching-cancel-tombstone:' + requestId, fingerprint: inputDigest }, async tx => {
        await tx.query(`INSERT INTO teaching_requests(request_id,activity_id,input_digest,body,state,receipt)
          VALUES($1,NULL,$2,NULL,'cancelled',$3) ON CONFLICT(request_id) DO NOTHING`, [requestId, inputDigest, JSON.stringify(tombstone)]);
      });
      return tombstone;
    }
    if (row.input_digest !== inputDigest) throw new StorageError('identity-conflict');
    // An accepted request is immutable evidence. Cancelling it now closes the run, never rewrites
    // the receipt into a cancellation after the question was already accepted.
    if (row.state === 'accepted' && row.run_id) {
      await storage.request({ requestId: 'teaching-stop-accepted:' + requestId, fingerprint: inputDigest }, async tx => {
        const { rows: [current] } = await tx.query('SELECT activity_id,state,stop_requested FROM teaching_runs WHERE run_id=$1 FOR UPDATE', [row.run_id]);
        if (!current || terminal(current.state as TeachingRun['state']) || current.stop_requested) return null;
        await tx.query('UPDATE teaching_runs SET stop_requested=true,updated_at=clock_timestamp() WHERE run_id=$1', [row.run_id]);
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
      if (active.has(runId) && row.lease_owner === ownerId) return null;
      if (row.lease_owner && row.lease_owner !== ownerId && row.lease_live) return null;
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
    const { rows: [row] } = await tx.query('SELECT generation,lease_owner FROM teaching_runs WHERE run_id=$1 FOR UPDATE', [runId]);
    if (!row || Number(row.generation) !== generation || row.lease_owner !== ownerId) throw new StorageError('conflict');
    return row;
  }
  async function finish(run: TeachingRun, generation: number, state: TeachingRun['state'], reason: string,
    usage: ModelUsage, model: TeachingRun['model'], event: { kind: TeachingEventKind; body: Record<string, unknown> } | null,
    extraEvents: { kind: TeachingEventKind; body: Record<string, unknown> }[] = []) {
    const row = await runRow(run.runId);
    if (riskOwnershipLost(row, generation)) throw new StorageError('conflict');
    await storage.request({ requestId: 'teaching-finish:' + run.runId + ':' + randomUUID(),
      fingerprint: 'teaching-finish:' + run.runId }, async tx => {
      await assertAuthority(tx, run.runId, generation);
      const { rows: [current] } = await tx.query('SELECT state FROM teaching_runs WHERE run_id=$1', [run.runId]);
      if (!current || terminal(current.state as TeachingRun['state'])) return null;
      if (event) await appendEvent(tx, run.activityId, event.kind, event.body);
      for (const extra of extraEvents) await appendEvent(tx, run.activityId, extra.kind, extra.body);
      await tx.query(`UPDATE teaching_runs SET state=$2,reason=$3,usage=$4,model=$5,completed_at=clock_timestamp(),
        lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE run_id=$1`, [run.runId, state, reason,
        JSON.stringify(usage), JSON.stringify(model)]);
      return null;
    });
  }
  function riskOwnershipLost(row: RunRow, generation: number) {
    return Number(row.generation) !== generation || row.lease_owner !== ownerId;
  }
  async function close(run: TeachingRun, generation: number, state: TeachingRun['state'], reason: string,
    usage: ModelUsage, model: TeachingRun['model'], event: { kind: TeachingEventKind; body: Record<string, unknown> } | null) {
    const row = await runRow(run.runId);
    if (riskOwnershipLost(row, generation)) throw new StorageError('conflict');
    try { await finish(run, generation, state, reason, usage, model, event); }
    catch (error) {
      // A complete native result whose final commit failed stays recoverable under the original attempt.
      if (!(error instanceof StorageError) || error.code !== 'conflict') throw error;
    }
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
  async function historyBefore(activityId: string, runId: string): Promise<ContextMessage[]> {
    const { rows: [own] } = await storage.read("SELECT seq FROM teaching_events WHERE activity_id=$1 AND kind='input' AND body->>'runId'=$2 LIMIT 1",
      [activityId, runId]);
    const boundary = own ? Number(own.seq) : Number.MAX_SAFE_INTEGER;
    const { rows } = await storage.read(`SELECT kind,body FROM teaching_events WHERE activity_id=$1
      AND seq < $2 AND kind IN ('input','assistant') ORDER BY seq`, [activityId, boundary]);
    return rows.flatMap((row): ContextMessage[] => {
      const body = row.body as Record<string, unknown>;
      if (row.kind === 'input') return typeof body.question === 'string' && body.question ? [{ role: 'student' as const, text: body.question }] : [];
      if (row.kind === 'assistant') return typeof body.text === 'string' && body.text ? [{ role: 'assistant' as const, text: body.text }] : [];
      return [];
    });
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
    system: string, history: ContextMessage[], generation: number) {
    const session = await sessionRow(activity.activityId);
    let segmentId = session.segment_id as string | null;
    const model = modelFact(choice.choice.connection);
    const fingerprint = fingerprintOf(model, system);
    let previousSegmentId: string | undefined;
    if (segmentId) {
      const segment = await options.models.segments.read(identity, segmentId);
      if (!segment.closed && !segment.pending && session.segment_fingerprint === fingerprint) {
        return { segmentId, sequence: segment.sequence, model, fresh: false };
      }
      if (segment.pending) throw new StorageError('resource-busy');
      if (!segment.closed) {
        await options.models.segments.close(identity, segmentId, { requestId: randomUUID(), expectedSequence: segment.sequence });
      }
      previousSegmentId = segmentId;
      segmentId = null;
    }
    const createdId = randomUUID();
    await options.models.segments.create(identity, { requestId: randomUUID(), segmentId: createdId, purpose: 'learning',
      source: { selected: true, selectionVersion }, prefix: { system, tools: [] },
      portable: history.map(message => ({ role: message.role === 'student' ? 'user' as const : 'assistant' as const,
        text: message.text })),
      ...(previousSegmentId ? { previousSegmentId } : {}) });
    const segment = await options.models.segments.read(identity, createdId);
    await storage.request({ requestId: 'teaching-segment:' + run.runId + ':' + randomUUID(),
      fingerprint: 'teaching-segment:' + run.runId }, async tx => {
      await assertAuthority(tx, run.runId, generation);
      await tx.query('UPDATE teaching_sessions SET segment_id=$2,segment_fingerprint=$3,updated_at=clock_timestamp() WHERE activity_id=$1',
        [activity.activityId, createdId, fingerprint]);
      return null;
    });
    return { segmentId: createdId, sequence: segment.sequence, model, fresh: true };
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
    const known = await lastProgressEvent(run.activityId, attemptId);
    let lastHeartbeat = Date.now(), unknownReads = 0, lastRevision = known.revision, lastLength = known.length;
    async function publishProgress() {
      if (fact.physicalRequestEnded) return;
      const live = await options.models.checks.progress(identity, attemptId).catch(() => null);
      if (!live || live.revision <= lastRevision || live.text.length <= lastLength) return;
      const delta = live.text.slice(lastLength);
      try {
        await storage.request({ requestId: `teaching-progress:${attemptId}:${live.revision}`,
          fingerprint: `teaching-progress:${attemptId}` }, async tx => {
          await assertAuthority(tx, run.runId, generation);
          await appendEvent(tx, run.activityId, 'assistant-progress', { runId: run.runId, attemptId, segmentId,
            revision: live.revision, length: live.text.length, delta });
          return null;
        });
        lastRevision = live.revision; lastLength = live.text.length;
      } catch (error) {
        if (!(error instanceof StorageError) || !['conflict', 'maintenance'].includes(error.code)) throw error;
      }
    }
    await publishProgress();
    while (!fact.physicalRequestEnded) {
      const stored = toRun(await runRow(run.runId));
      if (stored.stopRequested && !fact.cancelRequested) await options.models.checks.cancel(identity, attemptId);
      if (Date.now() - lastHeartbeat > leaseMs / 2) { await heartbeat(run.runId, generation); lastHeartbeat = Date.now(); }
      await sleep(200);
      fact = await options.models.checks.read(identity, attemptId);
      await publishProgress();
      if (fact.state === 'unknown') unknownReads++; else unknownReads = 0;
      if (unknownReads >= 3) break;
    }
    return fact;
  }
  async function settleAttempt(run: TeachingRun, generation: number, fact: ModelAttemptFact, model: TeachingRun['model'],
    segmentId: string) {
    const stopped = toRun(await runRow(run.runId)).stopRequested;
    const resultState = stopped ? 'stopped' : fact.state === 'completed' ? 'completed'
      : fact.state === 'cancelled' ? 'stopped' : fact.state === 'failed' || fact.state === 'incomplete' ? 'failed' : 'paused';
    const events: { kind: TeachingEventKind; body: Record<string, unknown> }[] = [];
    if (fact.text) events.push({ kind: 'assistant', body: { runId: run.runId, attemptId: fact.attemptId,
      segmentId, text: fact.text, usage: fact.usage, model, state: stopped ? 'stopped' : fact.state === 'completed' ? 'settled' : 'failed' } });
    if (resultState === 'completed') events.push({ kind: 'run-completed', body: { runId: run.runId, attemptId: fact.attemptId, usage: fact.usage } });
    else if (resultState === 'stopped') events.push({ kind: 'run-stopped', body: { runId: run.runId, attemptId: fact.attemptId, reason: fact.reason,
      text: fact.text, usage: fact.usage, stoppedByRequest: stopped } });
    else events.push({ kind: 'run-failed', body: { runId: run.runId, attemptId: fact.attemptId, reason: fact.reason || fact.state,
      text: fact.text, usage: fact.usage, state: fact.state } });
    const first = events.shift()!;
    await finish(run, generation, resultState, fact.reason || (stopped ? 'stop-requested' : ''), fact.usage, model, first, events);
  }
  async function execute(run: TeachingRun, generation: number) {
    const identity = runIdentity(await runRow(run.runId));
    await options.authorize(identity);
    const activity = await options.activity(identity, run.activityId);
    const request = await requestRow(run.requestId);
    if (!request) throw new StorageError('corrupt');
    if (request.state === 'cancelled') {
      await close(run, generation, 'stopped', 'cancelled-before-start', { state: 'unknown' }, run.model, {
        kind: 'run-stopped', body: { runId: run.runId, reason: 'cancelled-before-start' } });
      return;
    }
    const reason = refusal(activity);
    if (reason) {
      await close(run, generation, 'failed', reason, { state: 'unknown' }, null, {
        kind: 'run-failed', body: { runId: run.runId, reason } });
      return;
    }
    // An expired lease takes over an existing attempt by querying the original identity, never by
    // creating a second paid generation with the same question.
    if (run.attemptId) {
      if (!run.segmentId || !run.model) {
        await close(run, generation, 'paused', 'attempt-unavailable', { state: 'unknown' }, run.model, {
          kind: 'system-notice', body: { runId: run.runId, attemptId: run.attemptId, reason: 'attempt-unavailable' } });
        return;
      }
      let fact: ModelAttemptFact;
      try { fact = await options.models.checks.read(identity, run.attemptId); }
      catch (error) {
        if (!(error instanceof StorageError) || !['missing', 'forbidden'].includes(error.code)) throw error;
        await close(run, generation, 'paused', 'attempt-unavailable', { state: 'unknown' }, run.model, {
          kind: 'system-notice', body: { runId: run.runId, attemptId: run.attemptId, reason: 'attempt-unavailable' } });
        return;
      }
      // The prior driver may have stopped between persisting the attempt and dispatching it.
      if (fact.state === 'accepted') {
        fact = toRun(await runRow(run.runId)).stopRequested
          ? await options.models.checks.cancel(identity, run.attemptId)
          : await options.models.checks.dispatch(identity, run.attemptId);
      }
      try { fact = await awaitAttempt(identity, run, generation, run.attemptId, run.segmentId, fact); }
      catch (error) {
        if (!(error instanceof StorageError) || !['missing', 'forbidden'].includes(error.code)) throw error;
        await close(run, generation, 'paused', 'attempt-unavailable', { state: 'unknown' }, run.model, {
          kind: 'system-notice', body: { runId: run.runId, attemptId: run.attemptId, reason: 'attempt-unavailable' } });
        return;
      }
      if (!fact.physicalRequestEnded) {
        await close(run, generation, 'paused', 'result-unknown', fact.usage, run.model, {
          kind: 'system-notice', body: { runId: run.runId, attemptId: run.attemptId, reason: 'result-unknown' } });
        return;
      }
      await settleAttempt(run, generation, fact, run.model, run.segmentId);
      return;
    }
    const selection = await options.models.selection.read(identity);
    if (!selection.selected) {
      const unavailable = selection.unavailableReason ?? 'model-not-selected';
      await close(run, generation, 'paused', unavailable, { state: 'unknown' }, null, {
        kind: 'model-unavailable', body: { runId: run.runId, reason: unavailable } });
      return;
    }
    const choice = await options.models.selection.snapshot(identity, selection.version);
    const model = modelFact(choice.choice.connection);
    const maxOutputTokens = choice.choice.connection.maxOutputTokens;
    if (maxOutputTokens === undefined) {
      await close(run, generation, 'paused', 'max-output-missing', { state: 'unknown' }, model, {
        kind: 'model-unavailable', body: { runId: run.runId, reason: 'max-output-missing' } });
      return;
    }
    const history = await historyBefore(run.activityId, run.runId);
    const input = actionInputSchema.parse(request.body);
    const context = buildContext(activity, input, history,
      { ...(choice.choice.connection.contextWindow !== undefined ? { contextWindow: choice.choice.connection.contextWindow } : {}), maxOutputTokens });
    // The learning transport accepts 400k prefix and 1M user characters. Exceeding either is a
    // definite capacity result; the complete input stays in the request, never truncated.
    if (context.system.length > 400_000 || context.userText.length > 1_000_000) {
      const capacity = { ...context.capacity, status: 'over-window' as const };
      await close(run, generation, 'paused', 'capacity-exceeded', { state: 'unknown' }, model, {
        kind: 'capacity-paused', body: { runId: run.runId, reason: 'capacity-exceeded', capacity } });
      return;
    }
    let segment: { segmentId: string; sequence: number; model: typeof model };
    try {
      segment = await ensureSegment(identity, activity, run, choice, selection.version, context.system, history, generation);
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== 'resource-busy') throw error;
      await close(run, generation, 'paused', 'segment-busy', { state: 'unknown' }, model, {
        kind: 'system-notice', body: { runId: run.runId, reason: 'segment-busy' } });
      return;
    }
    if (dispatchClosed) throw new StorageError('maintenance');
    if (toRun(await runRow(run.runId)).stopRequested) {
      await close(run, generation, 'stopped', 'stop-requested', { state: 'unknown' }, model, {
        kind: 'run-stopped', body: { runId: run.runId, reason: 'stop-requested' } });
      return;
    }
    const attemptId = randomUUID();
    const attempt = await options.models.checks.receive(identity, { attemptId, purpose: 'learning', segmentId: segment.segmentId,
      expectedSequence: segment.sequence, input: { text: context.userText }, limits: { maxOutputTokens } });
    const payload = await options.models.checks.requestPayload(identity, attemptId);
    // Without a matching tokenizer the character count stays an uncertainty fact. It is recorded
    // with the payload but never converted into tokens or used to shrink the saved window.
    const payloadChars = JSON.stringify(payload).length;
    const capacity = { ...context.capacity, payloadChars, inputChars: Math.max(context.capacity.inputChars, payloadChars),
      status: 'within-upper-bound' as const };
    const snapshot: TeachingSnapshot = teachingSnapshotSchema.parse({ snapshotId: randomUUID(), activityId: run.activityId,
      runId: run.runId, attemptId, segmentId: segment.segmentId, assemblyVersion: 1, model, maxOutputTokens,
      ...(choice.choice.connection.contextWindow !== undefined ? { contextWindow: choice.choice.connection.contextWindow } : {}),
      sources: context.sources, payloadSha256: canonicalDigest(payload), payload,
      createdAt: new Date().toISOString() });
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const resource = await storage.stageResource({ uploadId: randomUUID(), scope: 'teaching-snapshot:' + snapshot.snapshotId,
      bytes, mediaType: 'application/json', contentVersion: 1 });
    try {
      await storage.request({ requestId: 'teaching-snapshot:' + snapshot.snapshotId, fingerprint: digest(snapshot) }, async tx => {
        await assertAuthority(tx, run.runId, generation);
        await tx.query(`INSERT INTO teaching_snapshots(snapshot_id,activity_id,run_id,attempt_id,segment_id,body,resource_id)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [snapshot.snapshotId, run.activityId, run.runId, attemptId, segment.segmentId,
          JSON.stringify(snapshot), resource.resourceId]);
        await tx.reference('teaching-snapshot:' + snapshot.snapshotId, resource.resourceId);
        await tx.query(`UPDATE teaching_runs SET attempt_id=$2,segment_id=$3,model=$4,state='dispatching',
          updated_at=clock_timestamp() WHERE run_id=$1`, [run.runId, attemptId, segment.segmentId, JSON.stringify(model)]);
        await appendEvent(tx, run.activityId, 'context-assembled', { runId: run.runId, snapshotId: snapshot.snapshotId,
          attemptId, segmentId: segment.segmentId, payloadSha256: snapshot.payloadSha256, capacity,
          sources: context.sources.map(source => ({ kind: source.kind, label: source.label })) });
        return null;
      });
    } catch (error) {
      // The prepared attempt owns the segment slot; release it if this run can no longer dispatch.
      await options.models.checks.cancel(identity, attemptId).catch(() => {});
      throw error;
    }
    if (dispatchClosed) {
      await options.models.checks.cancel(identity, attemptId).catch(() => {});
      throw new StorageError('maintenance');
    }
    const current = toRun(await runRow(run.runId));
    if (riskOwnershipLost(await runRow(run.runId), generation)) {
      await options.models.checks.cancel(identity, attemptId).catch(() => {});
      throw new StorageError('conflict');
    }
    if (current.stopRequested) {
      await options.models.checks.cancel(identity, attemptId);
    } else {
      await options.models.checks.dispatch(identity, attemptId);
    }
    await storage.request({ requestId: 'teaching-dispatch:' + attemptId, fingerprint: 'teaching-dispatch:' + attemptId }, async tx => {
      await assertAuthority(tx, run.runId, generation);
      await tx.query('UPDATE teaching_runs SET state=$2,updated_at=clock_timestamp() WHERE run_id=$1', [run.runId, 'dispatching']);
      await appendEvent(tx, run.activityId, 'attempt-dispatched', { runId: run.runId, attemptId, segmentId: segment.segmentId,
        expectedSequence: segment.sequence });
      return null;
    });
    const fact = await awaitAttempt(identity, run, generation, attemptId, segment.segmentId);
    if (!fact.physicalRequestEnded) {
      await close(run, generation, 'paused', 'result-unknown', fact.usage, model, {
        kind: 'system-notice', body: { runId: run.runId, attemptId, reason: 'result-unknown' } });
      return;
    }
    await settleAttempt(run, generation, fact, model, segment.segmentId);
  }

  const starting = new Set<string>();
  function kick(runId: string) {
    if (active.has(runId) || starting.has(runId) || dispatchClosed) return;
    starting.add(runId);
    const task = (async () => {
      const claimed = await claim(runId);
      if (!claimed) return;
      const { run, generation } = claimed;
      try { await execute(run, generation); }
      catch (error) {
        if (error instanceof StorageError && ['conflict', 'maintenance'].includes(error.code)) return;
        const row = await runRow(runId).catch(() => null);
        if (row && !terminal(row.state as TeachingRun['state'])) {
          if (row.attempt_id) await options.models.checks.cancel(runIdentity(row), row.attempt_id as string).catch(() => {});
          const reason = error instanceof StorageError ? error.code : 'driver-failed';
          await finish(run, generation, 'paused', reason, { state: 'unknown' },
            (row.model as TeachingRun['model'] | null) ?? null, { kind: 'system-notice', body: { runId, reason } }).catch(() => {});
        }
      }
    })().finally(() => { starting.delete(runId); active.delete(runId) });
    active.set(runId, task);
    void task.catch(() => {});
  }
  async function scan() {
    if (dispatchClosed) return;
    const { rows } = await storage.read(`SELECT run_id FROM teaching_runs WHERE state IN ('received','running','dispatching')
      AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp()) ORDER BY created_at LIMIT 20`);
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
    const { rows: runRows } = await storage.read('SELECT * FROM teaching_runs WHERE activity_id=$1 ORDER BY created_at', [activityId]);
    const messages: TeachingMessage[] = [];
    // Progress and the final answer for one attempt share a stable message identity; polling
    // clients merge them by eventId instead of showing the answer twice.
    const assistantSlots = new Map<string, number>();
    const settledAttempts = new Set<string>();
    for (const row of rows) {
      const kind = row.kind as TeachingEventKind, body = row.body as Record<string, unknown>;
      const base = { eventId: row.event_id as string, seq: Number(row.seq), createdAt: new Date(row.created_at as string).toISOString() };
      const attemptId = typeof body.attemptId === 'string' ? body.attemptId : '';
      if (kind === 'input') messages.push({ ...base, role: 'student', text: String(body.question ?? ''),
        runId: (body.runId as string) ?? null });
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
            role: 'assistant', text: String(body.text ?? ''), runId: (body.runId as string) ?? null, state });
        } else {
          const prior = messages[at]!;
          messages[at] = { ...prior, seq: base.seq, text: String(body.text ?? ''), state };
        }
      }
      else if (kind === 'model-unavailable') messages.push({ ...base, role: 'system',
        text: `暂时无法继续：${reasonText(body.reason) || '没有可用模型'}。请到模型设置检查连接后重试。`,
        runId: (body.runId as string) ?? null });
      else if (kind === 'capacity-paused') messages.push({ ...base, role: 'system',
        text: '这次请求超出当前模型窗口，完整问题与历史已保留。请更换窗口更大的模型或新建更聚焦的问题。',
        runId: (body.runId as string) ?? null });
      else if (kind === 'run-failed') messages.push({ ...base, role: 'system',
        text: `本次回答未完成${reasonText(body.reason) ? `：${reasonText(body.reason)}` : ''}。原问题与历史已保留，可明确继续。`,
        runId: (body.runId as string) ?? null });
    }
    // A progress message whose run already settled without a final answer (driver loss, pause)
    // must not stay "streaming" forever.
    const runStates = new Map(runRows.map(row => [row.run_id as string, row.state as TeachingRun['state']]));
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]!;
      const state = message.runId ? runStates.get(message.runId) : undefined;
      if (message.role !== 'assistant' || message.state !== 'streaming' || !state
        || ['received', 'running', 'dispatching'].includes(state)) continue;
      messages[index] = { ...message, state: state === 'stopped' ? 'stopped' : state === 'failed' ? 'failed' : 'unknown' };
    }
    // The cursor may only cover events actually delivered in this response; a later commit is
    // read on the next poll instead of being skipped by a concurrent max(seq).
    return teachingConversationSchema.parse({ activityId, cursor: rows.length ? Number(rows.at(-1)!.seq) : cursor, messages,
      runs: runRows.map(toRun) });
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
    if (bytes.byteLength === 0) throw new StorageError('corrupt');
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
    await storage.request({ requestId: 'teaching-stop:' + input.requestId, fingerprint: 'teaching-stop:' + runId }, async tx => {
      const { rows: [row] } = await tx.query('SELECT state,stop_requested FROM teaching_runs WHERE run_id=$1 FOR UPDATE', [runId]);
      if (!row) throw new StorageError('missing');
      if (terminal(row.state as TeachingRun['state']) || row.stop_requested) return null;
      await tx.query('UPDATE teaching_runs SET stop_requested=true,updated_at=clock_timestamp() WHERE run_id=$1', [runId]);
      await appendEvent(tx, activityId, 'stop-requested', { runId, requestId: input.requestId, source: 'student' });
      return null;
    });
    await stopAttempt(runId);
    kick(runId);
    return toRun(await runRow(runId));
  }
  async function continueRun(identity: SpaceIdentity, activityId: string, runId: string, value: unknown) {
    if (writesClosed) throw new StorageError('maintenance');
    await options.activity(identity, activityId);
    const input = teachingContinueInputSchema.parse(value);
    const previous = toRun(await runRow(runId));
    if (previous.activityId !== activityId) throw new StorageError('missing');
    if (!terminal(previous.state)) throw new StorageError('conflict');
    const previousRequest = await requestRow(previous.requestId);
    if (!previousRequest?.body) throw new StorageError('corrupt');
    const original = actionInputSchema.parse(previousRequest.body);
    const newRunId = operationId('teaching-run:' + input.requestId);
    const inputId = operationId('teaching-input:' + input.requestId);
    const body = actionInputSchema.parse({ ...original, requestId: input.requestId,
      draft: { ...original.draft, question: '请继续' } });
    const inputDigest = digest(body);
    const accepted = receipt(body, inputDigest, 'accepted', newRunId, inputId);
    await storage.request({ requestId: 'teaching-continue:' + input.requestId, fingerprint: inputDigest }, async tx => {
      const { rows: [prior] } = await tx.query('SELECT state,receipt FROM teaching_requests WHERE request_id=$1 FOR UPDATE', [input.requestId]);
      if (prior) return prior.receipt;
      await tx.query('INSERT INTO teaching_sessions(activity_id) VALUES($1) ON CONFLICT(activity_id) DO NOTHING', [activityId]);
      await tx.query(`INSERT INTO teaching_requests(request_id,activity_id,input_digest,body,state,run_id,input_id,receipt)
        VALUES($1,$2,$3,$4,'accepted',$5,$6,$7)`, [input.requestId, activityId, inputDigest, JSON.stringify(body),
        newRunId, inputId, JSON.stringify(accepted)]);
      await tx.query(`INSERT INTO teaching_runs(run_id,activity_id,request_id,input_id,identity,state,previous_run_id,usage)
        VALUES($1,$2,$3,$4,$5,'received',$6,$7)`, [newRunId, activityId, input.requestId, inputId,
        JSON.stringify(identity), previous.runId, JSON.stringify({ state: 'unknown' })]);
      await appendEvent(tx, activityId, 'input', { runId: newRunId, requestId: input.requestId, inputId,
        question: '请继续', references: original.draft.references.map(reference => ({ referenceId: reference.referenceId,
          source: reference.source, sourceName: reference.sourceName, copy: reference.copy })),
        works: original.works.map(work => ({ objectId: work.objectId, name: work.name, kind: work.kind })),
        continuedFrom: previous.runId });
      await appendEvent(tx, activityId, 'run-continued', { runId: newRunId, previousRunId: previous.runId, requestId: input.requestId });
      return accepted;
    });
    kick(newRunId);
    return toRun(await runRow(newRunId));
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
  async function validate() {
    await validateTeachingAgent(storage);
  }

  const receiver: ActionReceiver = { identity, accept, query, cancel };
  if (options.start !== false) startTicker();
  return {
    receiver, migrations: teachingAgentMigrations, accept, query, cancel,
    run, conversation, events, snapshot, request, stop, continueRun, capabilities, validate,
    closeWrites() { writesClosed = true; if (ticker) clearInterval(ticker); ticker = undefined; },
    closeDispatch() { dispatchClosed = true; if (ticker) clearInterval(ticker); ticker = undefined; },
    async drain() {
      const deadline = Date.now() + 25_000;
      while (active.size) {
        if (Date.now() >= deadline) throw new StorageError('maintenance');
        await Promise.allSettled([...active.values()]);
      }
    },
    resume() { writesClosed = false; dispatchClosed = false; startTicker(); void scan().catch(() => {}); },
    close() { if (ticker) clearInterval(ticker); ticker = undefined; },
  };
}

/** Recovery validation reads only this owner's durable facts; it never triggers a model call. */
export async function validateTeachingAgent(storage: OwnedStorage) {
  const { rows: requests } = await storage.read('SELECT * FROM teaching_requests');
  for (const row of requests) {
    const saved = actionReceiptSchema.parse(row.receipt);
    if (saved.requestId !== row.request_id || saved.inputDigest !== row.input_digest) throw new StorageError('corrupt');
    if (row.body) actionInputSchema.parse(row.body);
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
    const { rows } = await storage.read('SELECT seq FROM teaching_events WHERE activity_id=$1 ORDER BY seq', [session.activity_id]);
    if (rows.some((row, index) => Number(row.seq) !== index + 1)) throw new StorageError('corrupt');
    const { rows: [last] } = await storage.read('SELECT max(seq)::bigint AS seq FROM teaching_events WHERE activity_id=$1', [session.activity_id]);
    if (Number(last?.seq ?? 0) + 1 !== Number(session.next_seq)) throw new StorageError('corrupt');
  }
  const { rows: snapshots } = await storage.read('SELECT * FROM teaching_snapshots');
  for (const row of snapshots) {
    const body = teachingSnapshotSchema.parse(row.body);
    const bytes = Buffer.from(await storage.readResource(row.resource_id as string));
    if (bytes.byteLength === 0 || canonicalDigest(body.payload) !== body.payloadSha256)
      throw new StorageError('corrupt');
  }
}
