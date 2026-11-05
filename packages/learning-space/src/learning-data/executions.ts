import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import type { Migration, OwnedStorage } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import { acceptsState, matchesComponentState, componentInstanceId, componentStateName } from '@xunjie/contracts/components';
import { advanceExecution, canonicalValue, defaultExecutionLimits, executionAcceptanceSchema, executionActionSchema,
  executionQuerySchema, executionStopSchema } from '@xunjie/contracts/execution';
import type { ExecutionAction, ExecutionQuery } from '@xunjie/contracts/execution';
import { executionHistoryPageSchema, executionArtifactSchema } from '@xunjie/contracts/execution';
import type { createWorks } from './works.js';
import { verifyPlannedExecution } from './plan.js';
import { createNativeSessions } from './native-sessions.js';
import type { NativeSessionOptions } from './native-sessions.js';
import { readSessionCheckpointPage } from './session-checkpoints.js';
import { createChannelExecutions } from './channel-executions.js';
import type { createNativeChannel } from './native-channel.js';
import { createAgentExecutions, validateAgentExecutionCommands } from './agent-executions.js';
export { agentExecutionMigration } from './agent-executions.js';

/**
 * The `tool-execution` owner keeps the command basis the service really received, the original
 * receipt, the durable stop and the produced artifact. It writes only its own three tables plus the
 * retention references of the resources it really received, and verifies ownership from the
 * learning-data activity it already serves.
 */
export const executionMigration: Migration = { version: 6, name: 'durable-browser-executions', sql: `
  CREATE TABLE execution_commands(request_id uuid PRIMARY KEY,activity_id uuid NOT NULL REFERENCES activities(id),
    input_digest text NOT NULL,execution_ref uuid NOT NULL,body jsonb NOT NULL,acceptance jsonb NOT NULL,
    state text NOT NULL CHECK(state IN ('queued','running','paused','succeeded','failed','cancelled')),
    status_knowledge text NOT NULL CHECK(status_knowledge IN ('confirmed','unknown')),
    stop_requested boolean NOT NULL DEFAULT false,confirmed_seq integer NOT NULL,reason jsonb,output jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE INDEX execution_commands_activity ON execution_commands(activity_id);
  CREATE TABLE execution_stops(stop_id uuid PRIMARY KEY,activity_id uuid NOT NULL REFERENCES activities(id),
    request_id uuid NOT NULL,input_digest text NOT NULL,reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE INDEX execution_stops_request ON execution_stops(request_id);
  CREATE TABLE execution_results(request_id uuid PRIMARY KEY,activity_id uuid NOT NULL REFERENCES activities(id),
    execution_ref uuid NOT NULL,content_id uuid NOT NULL,sha256 text NOT NULL,byte_length integer NOT NULL,
    artifact jsonb NOT NULL,output jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
` };
export const executionActionTextMigration: Migration = { version: 10, name: 'fixed-execution-action-text', sql: `
  ALTER TABLE execution_commands ADD COLUMN action_text text;
  ALTER TABLE native_sessions ADD COLUMN action_text text;
` };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonicalDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
const fail: (code: 'missing' | 'forbidden' | 'invalid' | 'corrupt' | 'identity-conflict') => never = code => {
  throw new StorageError(code);
};
const componentStateMediaType = 'application/vnd.xunjie.component-state+json';

function query(row: Record<string, unknown>): ExecutionQuery {
  const body = executionActionSchema.parse(row.body);
  return executionQuerySchema.parse({ requestId: row.request_id, inputDigest: row.input_digest, scope: body.scope,
    executionRef: row.execution_ref, state: row.state, statusKnowledge: row.status_knowledge,
    stopRequested: row.stop_requested, confirmedSeq: Number(row.confirmed_seq), reason: row.reason ?? null,
    output: row.output ?? null });
}
function sameIdentity(left: { requestId: string; inputDigest: string; executionRef: string }, right: ExecutionQuery) {
  return left.requestId === right.requestId && left.inputDigest === right.inputDigest && left.executionRef === right.executionRef;
}

export function createExecutions(storage: OwnedStorage, options: {
  activity(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
  works: ReturnType<typeof createWorks>;
  native?: NativeSessionOptions;
  channel?: ReturnType<typeof createNativeChannel>;
}) {
  const { activity: authorize, works } = options;
  const native = options.native ? createNativeSessions(storage, options.native) : null;
  const channel = options.channel ? createChannelExecutions(storage, { activity: authorize, works, channel: options.channel,
    ...(options.native?.authorizeComponent ? { authorizeComponent: options.native.authorizeComponent } : {}) }) : null;
  async function find(activityId: string, requestId: string) {
    const { rows: [row] } = await storage.read('SELECT * FROM execution_commands WHERE activity_id=$1 AND request_id=$2',
      [activityId, requestId]);
    return row ? { row, query: query(row) } : null;
  }
  /** The run cites only what this activity's current binding really declared. */
  function verifyBasis(activity: LearningActivity, action: ExecutionAction) {
    const instance = action.execution.instance;
    const binding = activity.course?.components?.find(item => item.key === instance.key);
    if (!binding) fail('forbidden');
    const manifest = binding.definition.manifest;
    if (componentInstanceId(activity.activityId, instance.key) !== instance.instanceId
      || manifest.componentId !== instance.componentId || manifest.version !== instance.componentVersion
      || manifest.stateVersion !== instance.stateVersion || manifest.hostApiVersion !== instance.hostApiVersion
      || binding.definition.digest !== instance.definitionDigest) fail('identity-conflict');
    if (manifest.formatVersion !== 1) fail('missing');
    const operation = manifest.operations?.find(item => item.operationId === action.execution.operation.operationId);
    if (!operation || operation.effect !== action.execution.operation.effect) fail('missing');
    // The course plan the activity was opened with fixes which operation may run and where.
    verifyPlannedExecution(activity, { key: instance.key, definitionDigest: instance.definitionDigest,
      operationId: operation.operationId, location: 'browser' });
    const limits = action.execution.limits;
    // A command may tighten a declared budget; it may never exceed the manifest or the adapter ceiling.
    if (limits.timeMs > operation.budgets.timeMs || limits.outputBytes > operation.budgets.outputBytes
      || !manifest.algorithm || limits.memoryPages > manifest.algorithm.memoryPages
      || limits.inputBytes > defaultExecutionLimits.inputBytes
      || limits.concurrentJobs > defaultExecutionLimits.concurrentJobs
      || limits.queuedJobs > defaultExecutionLimits.queuedJobs) fail('invalid');
    const plan = action.execution.plan;
    if (plan.planDigest !== canonicalDigest({ planId: plan.planId, planVersion: plan.planVersion,
      componentId: manifest.componentId, componentVersion: manifest.version,
      operationId: operation.operationId })) fail('invalid');
    const declared = [{ kind: 'entry' as const, resource: manifest.entry },
      { kind: 'algorithm' as const, resource: manifest.algorithm.resource }];
    const cited = action.execution.basis.resources;
    if (cited.length !== declared.length || declared.some(item => !cited.some(resource => resource.kind === item.kind
      && resource.resourceId === item.resource.resourceId && resource.sha256 === item.resource.sha256
      && resource.byteLength === item.resource.byteLength))) fail('invalid');
  }
  /**
   * The command carries the exact state bytes it was computed from. The service verifies that copy
   * rather than a workspace head that may still be syncing, so acceptance does not depend on the
   * order of two independent uploads.
   */
  function verifyState(action: ExecutionAction) {
    const state = action.execution.basis.state, expected = action.execution.basis.expected.stateContentId;
    if ((state?.contentId ?? null) !== expected) fail('invalid');
    if (!state) return;
    if (state.name !== componentStateName(action.execution.instance.key)) fail('invalid');
    const file = action.execution.basis.works.find(item => item.name === state.name);
    if (!file || file.contentId !== state.contentId || file.kind !== 'state' || file.encoding !== 'json'
      || file.mediaType !== componentStateMediaType) fail('invalid');
    let value: unknown;
    try { value = JSON.parse(file.value); }
    catch { throw new StorageError('corrupt'); }
    if (canonicalDigest(value) !== state.sha256) fail('corrupt');
  }
  /** Acceptance is a real answer under this exact identity; the receipt is the browser's original one. */
  async function accept(identity: SpaceIdentity, activityId: string, value: unknown): Promise<ExecutionQuery> {
    const submittedAction = executionActionSchema.parse((value as { action?: unknown })?.action);
    // This owner entry is authenticated for students, including the installed school's local forward.
    // Agent, preview and self-test roles need their own trusted caller context before they can be accepted.
    if (submittedAction.execution.initiator.kind !== 'student') fail('forbidden');
    return acceptTrusted(identity, activityId, value, async () => {});
  }
  async function acceptTrusted(identity: SpaceIdentity, activityId: string, value: unknown, guard: () => Promise<void>): Promise<ExecutionQuery> {
    const submittedAction = executionActionSchema.parse((value as { action?: unknown })?.action);
    await guard();
    const location = submittedAction.execution.plan.location;
    if (location === 'native') {
      const receiver = submittedAction.receiver.location;
      if (channel && receiver === 'local') return channel.accept(identity, activityId, value, guard);
      if (!native) fail('missing');
      return native.accept(identity, activityId, value, guard);
    }
    const activity = await authorize(identity, activityId);
    const input = z.object({ action: executionActionSchema, acceptance: executionAcceptanceSchema }).strict().parse(value);
    const { action, acceptance } = input;
    const scope = action.scope;
    if (scope.activityId !== activityId || scope.environmentId !== identity.environmentId
      || scope.spaceId !== identity.spaceId || scope.principalId !== identity.principalId) fail('forbidden');
    // Only a broker that really accepted may cite a run; a rejection has no execution reference.
    if (!acceptance.execution) fail('invalid');
    const inputDigest = digest(action), receipt = acceptance.receipt;
    if (receipt.requestId !== action.requestId || receipt.inputDigest !== inputDigest || receipt.state !== 'accepted'
      || JSON.stringify(receipt.receiver) !== JSON.stringify(action.receiver)) fail('invalid');
    verifyBasis(activity, action);
    const existing = await find(activityId, action.requestId);
    if (existing) {
      if (existing.query.inputDigest !== inputDigest) fail('identity-conflict');
      return existing.query;
    }
    verifyState(action);
    for (const file of action.execution.basis.works) await works.registerBasis(identity, activityId, file);
    await guard();
    const begun: ExecutionQuery = executionQuerySchema.parse({ requestId: action.requestId, inputDigest,
      scope, executionRef: acceptance.execution.executionRef, state: 'queued', statusKnowledge: 'confirmed',
      stopRequested: false, confirmedSeq: acceptance.execution.acceptedSeq, reason: null, output: null });
    await storage.request({ requestId: 'execution-accept:' + action.requestId,
      fingerprint: digest({ identity, activityId, inputDigest }) }, async tx => {
      await tx.query(`INSERT INTO execution_commands(request_id,activity_id,input_digest,execution_ref,body,acceptance,
        state,status_knowledge,stop_requested,confirmed_seq,action_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT(request_id) DO NOTHING`, [action.requestId, activityId, inputDigest, begun.executionRef,
        JSON.stringify(action), JSON.stringify(acceptance), begun.state, begun.statusKnowledge, begun.stopRequested,
        begun.confirmedSeq, JSON.stringify(action)]);
      const { rows: [row] } = await tx.query('SELECT * FROM execution_commands WHERE request_id=$1 FOR UPDATE', [action.requestId]);
      if (!row || row.activity_id !== activityId || row.input_digest !== inputDigest) fail('identity-conflict');
      for (const file of action.execution.basis.works) await tx.reference(`execution/${action.requestId}/work/${file.contentId}`, file.contentId);
      const state = action.execution.basis.state;
      if (state) await tx.reference(`execution/${action.requestId}/state`, state.contentId);
      return query(row);
    });
    const saved = await find(activityId, action.requestId);
    if (!saved || !sameIdentity(saved.query, begun)) fail('corrupt');
    return saved.query;
  }
  async function read(identity: SpaceIdentity, activityId: string, requestId: string, guard?: () => Promise<void>) {
    await authorize(identity, activityId); z.uuid().parse(requestId);
    if (channel && await channel.owns(activityId, requestId)) return channel.read(identity, activityId, requestId, guard);
    if (native && await native.owns(activityId, requestId)) return native.read(identity, activityId, requestId);
    const found = await find(activityId, requestId);
    return found ? found.query : null;
  }
  async function history(identity: SpaceIdentity, activityId: string, cursor?: string) {
    await authorize(identity, activityId);
    if (cursor) z.uuid().parse(cursor);
    const { rows } = await storage.read(`SELECT * FROM execution_commands WHERE activity_id=$1
      AND ($2::uuid IS NULL OR request_id>$2::uuid) ORDER BY request_id LIMIT 33`, [activityId, cursor ?? null]);
    const entries = rows.slice(0, 32).map(row => {
      const action = executionActionSchema.parse(row.action_text ? JSON.parse(String(row.action_text)) : row.body);
      const stored = query(row);
      if (canonicalDigest(action) !== canonicalDigest(row.body)
        || row.action_text && createHash('sha256').update(String(row.action_text)).digest('hex') !== stored.inputDigest)
        fail('corrupt');
      return { action, acceptance: executionAcceptanceSchema.parse(row.acceptance), query: stored,
        createdAt: new Date(row.created_at as string).toISOString() };
    });
    return executionHistoryPageSchema.parse({ entries,
      nextCursor: rows.length > 32 ? String(rows[31]!.request_id) : null });
  }
  async function artifact(identity: SpaceIdentity, activityId: string, requestId: string) {
    await authorize(identity, activityId); z.uuid().parse(requestId);
    const { rows: [row] } = await storage.read('SELECT * FROM execution_results WHERE activity_id=$1 AND request_id=$2',
      [activityId, requestId]);
    if (!row) return null;
    const found = await find(activityId, requestId);
    if (!found || found.query.executionRef !== row.execution_ref) return fail('corrupt');
    if (!found.query.output || found.query.output.contentId !== row.content_id
      || found.query.output.artifact?.sha256 !== row.sha256 || found.query.output.artifact?.byteLength !== row.byte_length)
      return fail('corrupt');
    const bytes = Buffer.from(await storage.readResource(String(row.content_id)));
    if (bytes.length !== row.byte_length || createHash('sha256').update(bytes).digest('hex') !== row.sha256) fail('corrupt');
    const metadata = row.artifact as { name: string; mediaType: string };
    return executionArtifactSchema.parse({ executionRef: row.execution_ref, requestId: row.request_id, scope: found.query.scope,
      name: metadata.name, mediaType: metadata.mediaType, sha256: row.sha256, byteLength: row.byte_length,
      text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), output: row.output });
  }
  /** The native session list lets a reopened view find its original reference, never a new run. */
  async function sessions(identity: SpaceIdentity, activityId: string): Promise<ExecutionQuery[]> {
    const local = native ? await native.list(identity, activityId) : [];
    return channel ? [...local, ...await channel.list(identity, activityId)] : local;
  }
  async function control(identity: SpaceIdentity, activityId: string, requestId: string, value: unknown, guard?: () => Promise<void>) {
    if (channel && await channel.owns(activityId, requestId)) return channel.control(identity, activityId, requestId, value, guard);
    if (!native) fail('missing');
    return native.control(identity, activityId, requestId, value, guard);
  }
  /** A reported fact advances only forward; a confirmed terminal fact is never rewritten. */
  async function report(identity: SpaceIdentity, activityId: string, requestId: string, value: unknown) {
    await authorize(identity, activityId); z.uuid().parse(requestId);
    if (channel && await channel.owns(activityId, requestId)) fail('invalid');
    if (native && await native.owns(activityId, requestId)) fail('invalid');
    const next = executionQuerySchema.parse(value);
    if (next.requestId !== requestId) fail('invalid');
    const result = await storage.request({ requestId: 'execution-fact:' + randomUUID(), fingerprint: requestId }, async tx => {
      const { rows: [row] } = await tx.query('SELECT * FROM execution_commands WHERE activity_id=$1 AND request_id=$2 FOR UPDATE',
        [activityId, requestId]);
      if (!row) fail('missing');
      const current = query(row);
      let merged: ExecutionQuery;
      try { merged = advanceExecution(current, next); } catch { throw new StorageError('identity-conflict'); }
      if (JSON.stringify(merged.scope) !== JSON.stringify(current.scope)) fail('identity-conflict');
      if (merged === current) return current;
      // A different state needs a later confirmation sequence, so a stale report cannot rewind.
      if (merged.state !== current.state && merged.confirmedSeq <= current.confirmedSeq) return current;
      await tx.query(`UPDATE execution_commands SET state=$2,status_knowledge=$3,stop_requested=$4,confirmed_seq=$5,
        reason=$6,output=$7,updated_at=clock_timestamp() WHERE request_id=$1`, [requestId, merged.state,
        merged.statusKnowledge, merged.stopRequested, merged.confirmedSeq, merged.reason ? JSON.stringify(merged.reason) : null,
        merged.output ? JSON.stringify(merged.output) : null]);
      return merged;
    });
    return executionQuerySchema.parse(result.result);
  }
  /** Stopping names the original run; the original acceptance is left exactly as it was. */
  async function stop(identity: SpaceIdentity, activityId: string, requestId: string, value: unknown) {
    await authorize(identity, activityId); z.uuid().parse(requestId);
    if (channel && await channel.owns(activityId, requestId)) return channel.stop(identity, activityId, requestId, value);
    if (native && await native.owns(activityId, requestId)) return native.stop(identity, activityId, requestId, value);
    await stopBrowser(activityId, requestId, value);
    // The durable stop receipt is idempotent; the query must reflect a later real result.
    return (await read(identity, activityId, requestId))!;
  }
  async function stopBrowser(activityId: string, requestId: string, value: unknown) {
    const input = executionStopSchema.parse(value);
    await storage.request({ requestId: 'execution-stop:' + input.stopId,
      fingerprint: digest({ activityId, requestId, stopId: input.stopId }) }, async tx => {
      const { rows: [row] } = await tx.query('SELECT * FROM execution_commands WHERE activity_id=$1 AND request_id=$2 FOR UPDATE',
        [activityId, requestId]);
      if (!row) fail('missing');
      const current = query(row);
      await tx.query(`INSERT INTO execution_stops(stop_id,activity_id,request_id,input_digest,reason)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(stop_id) DO NOTHING`, [input.stopId, activityId, requestId,
        current.inputDigest, input.reason]);
      if (['succeeded', 'failed', 'cancelled'].includes(current.state) || current.stopRequested) return current;
      const stopped = executionQuerySchema.parse({ ...current, stopRequested: true });
      await tx.query(`UPDATE execution_commands SET stop_requested=true,updated_at=clock_timestamp() WHERE request_id=$1`, [requestId]);
      return stopped;
    });
    return (await find(activityId, requestId))!.query;
  }
  /** The bytes are stored once under the run's own identity; a lost reply re-reads, never recomputes. */
  async function result(identity: SpaceIdentity, activityId: string, requestId: string, value: unknown) {
    await authorize(identity, activityId); z.uuid().parse(requestId);
    if (channel && await channel.owns(activityId, requestId)) fail('invalid');
    if (native && await native.owns(activityId, requestId)) fail('invalid');
    const input = z.object({ contentId: z.uuid(), output: z.unknown(), text: z.string().max(2000000),
      name: z.string().min(1).max(120), mediaType: z.string().min(1).max(120),
      sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().positive().max(1048576) }).strict().parse(value);
    const found = await find(activityId, requestId);
    if (!found) fail('missing');
    const bytes = Buffer.from(input.text, 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== input.byteLength || sha256 !== input.sha256) fail('invalid');
    const { rows: [previous] } = await storage.read('SELECT * FROM execution_results WHERE request_id=$1', [requestId]);
    if (previous) {
      if (previous.content_id !== input.contentId || previous.sha256 !== sha256) fail('identity-conflict');
      return found.query;
    }
    const artifact = { name: input.name, mediaType: input.mediaType, byteLength: bytes.length, sha256 };
    const output = { contentId: input.contentId, output: input.output, artifact };
    const reference = await storage.stageResource({ uploadId: input.contentId, scope: `execution/${requestId}`, bytes,
      mediaType: input.mediaType, contentVersion: 1 });
    if (reference.resourceId !== input.contentId || reference.sha256 !== sha256 || reference.byteLength !== bytes.length) fail('corrupt');
    const saved = await storage.request({ requestId: 'execution-result:' + requestId,
      fingerprint: digest({ activityId, contentId: input.contentId, sha256 }) }, async tx => {
      const { rows: [row] } = await tx.query('SELECT * FROM execution_commands WHERE activity_id=$1 AND request_id=$2 FOR UPDATE',
        [activityId, requestId]);
      if (!row) fail('missing');
      const current = query(row), existing = current.output;
      // The stored bytes must be the artifact the reported query already named, not a second outcome.
      if (existing && (existing.contentId !== input.contentId || existing.artifact?.sha256 !== sha256
        || existing.artifact?.byteLength !== bytes.length)) fail('identity-conflict');
      await tx.query(`INSERT INTO execution_results(request_id,activity_id,execution_ref,content_id,sha256,byte_length,artifact,output)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(request_id) DO NOTHING`, [requestId, activityId, current.executionRef,
        input.contentId, sha256, bytes.length, JSON.stringify(artifact), JSON.stringify(input.output)]);
      await tx.reference(`execution/${requestId}/result`, input.contentId);
      if (existing) return current;
      const withOutput = executionQuerySchema.parse({ ...current, output });
      await tx.query('UPDATE execution_commands SET output=$2,updated_at=clock_timestamp() WHERE request_id=$1',
        [requestId, JSON.stringify(withOutput.output)]);
      return withOutput;
    });
    return executionQuerySchema.parse(saved.result);
  }
  const agent = createAgentExecutions(storage, { activity: authorize, works, accept: acceptTrusted, read, control, stop,
    reclaim: async (action, value) => {
      const activityId = action.scope.activityId, requestId = action.requestId;
      if (channel && await channel.owns(activityId, requestId)) return channel.reclaimOriginal(action, value);
      if (native && await native.owns(activityId, requestId)) {
        const { rows: [row] } = await storage.read('SELECT session_ref,action FROM native_sessions WHERE activity_id=$1 AND request_id=$2', [activityId, requestId]);
        if (!row || canonicalDigest(row.action) !== canonicalDigest(action)) fail('identity-conflict');
        return native.reclaim(String(row.session_ref));
      }
      const found = await find(activityId, requestId);
      if (!found) return null;
      if (canonicalDigest(found.row.body) !== canonicalDigest(action)) fail('identity-conflict');
      return stopBrowser(activityId, requestId, value);
    },
    verify: async (activity, action) => {
      const instance = action.execution.instance;
      const binding = activity.course?.components?.find(item => item.key === instance.key);
      if (!binding || binding.definition.digest !== instance.definitionDigest
        || binding.definition.manifest.componentId !== instance.componentId
        || binding.definition.manifest.version !== instance.componentVersion
        || binding.definition.manifest.stateVersion !== instance.stateVersion
        || componentInstanceId(activity.activityId, instance.key) !== instance.instanceId) fail('identity-conflict');
      const manifest = binding.definition.manifest;
      if (manifest.formatVersion !== 1) fail('invalid');
      if (activity.course?.helpPolicy?.questions === 'disabled') fail('forbidden');
      verifyState(action);
      const state = action.execution.basis.state;
      const stateFile = state ? action.execution.basis.works.find(item => item.contentId === state.contentId) : undefined;
      if (stateFile && !matchesComponentState(binding, activity.activityId, stateFile)) fail('invalid');
      const operation = action.execution.plan.location === 'native' ? manifest.session : null;
      if (operation) {
        if (action.execution.operation.operationId !== operation.operation.operationId
          || !acceptsState(operation.parameters, action.execution.parameters)) fail('invalid');
        verifyPlannedExecution(activity, { key: instance.key, definitionDigest: instance.definitionDigest,
          operationId: action.execution.operation.operationId, location: 'native' });
      } else {
        verifyBasis(activity, action);
        const declared = manifest.operations?.find(item => item.operationId === action.execution.operation.operationId);
        if (!declared || !acceptsState(declared.parameters, action.execution.parameters)) fail('invalid');
      }
      await options.native?.authorizeComponent?.(activity.identity, activity, action);
    } });
  return { agent, accept, read, history, artifact, report, stop, result, control, sessions,
    /** What the Linux restricted entry can enforce; `null` means it was not measured on this host. */
    linuxEntryIsolation: async () => native ? await native.linuxEntryIsolation() : null,
    /** Maintenance reclaims a session by its executor instance, not by a student's current eligibility. */
    reclaim: async (sessionRef: string) => { if (!native) fail('missing'); return native.reclaim(sessionRef); },
    checkpoints: async (identity: SpaceIdentity, activityId: string, cursor?: string) => {
      await authorize(identity, activityId);
      return readSessionCheckpointPage(storage, identity, activityId, cursor);
    },
    controlReceipt: async (identity: SpaceIdentity, activityId: string, requestId: string, controlId: string) => {
      if (channel && await channel.owns(activityId, requestId)) return channel.controlReceipt(identity, activityId, requestId, controlId);
      return native ? native.controlReceipt(identity, activityId, requestId, controlId) : null;
    },
    closeActivity: async (identity: SpaceIdentity, activityId: string) => {
      await native?.closeActivity(identity, activityId);
      if (channel) for (const query of await channel.list(identity, activityId)) {
        if (!['succeeded', 'failed', 'cancelled'].includes(query.state))
          await channel.stop(identity, activityId, query.requestId, { stopId: query.executionRef, reason: '活动已关闭，停止原会话。' });
      }
    },
    /** Maintenance recovery runs after the storage gate reopens, never against a closed owner. */
    recoverNative: async () => { await native?.resume(); },
    closeNativeDispatch: () => { native?.closeDispatch(); },
    /** Maintenance stops own their live processes before the storage owner drains. */
    shutdown: async () => {
      await native?.shutdown();
      // A service projection cannot terminate a disconnected browser Worker. Do not advertise
      // a safe maintenance stop while any received browser command lacks a confirmed terminal fact.
      const { rows } = await storage.read(`SELECT request_id FROM execution_commands
        WHERE state NOT IN ('succeeded','failed','cancelled') OR status_knowledge<>'confirmed' LIMIT 1`);
      if (rows.length) throw new StorageError('unavailable');
    } };
}

/** Recovery validation: every stored command still names its own activity, basis and artifact. */
export async function validateExecutions(storage: OwnedStorage) {
  await validateAgentExecutionCommands(storage);
  const corrupt = (detail: string): never => {
    const error = new StorageError('corrupt');
    error.message += ` (execution recovery: ${detail})`;
    throw error;
  };
  const { rows } = await storage.read('SELECT * FROM execution_commands');
  for (const row of rows) {
    const stored = query(row), action = executionActionSchema.parse(row.body);
    let inputDigest = digest(action);
    if (row.action_text !== null && row.action_text !== undefined) {
      if (typeof row.action_text !== 'string') corrupt('command text type');
      let original: unknown;
      try { original = JSON.parse(row.action_text as string); }
      catch { corrupt('command text JSON'); }
      const parsed = executionActionSchema.safeParse(original);
      if (!parsed.success || canonicalDigest(original) !== canonicalDigest(action)
        || canonicalDigest(parsed.data) !== canonicalDigest(action)) corrupt('command text projection');
      inputDigest = createHash('sha256').update(row.action_text as string).digest('hex');
    }
    if (inputDigest !== stored.inputDigest) corrupt('command input digest');
    const acceptance = executionAcceptanceSchema.parse(row.acceptance);
    const { rows: [activity] } = await storage.read('SELECT body FROM activities WHERE id=$1', [row.activity_id]);
    const body = activity?.body as LearningActivity | undefined, scope = action.scope;
    if (!body || scope.activityId !== row.activity_id || scope.environmentId !== body.identity.environmentId
      || scope.spaceId !== body.identity.spaceId || scope.principalId !== body.identity.principalId
      || acceptance.receipt.requestId !== stored.requestId
      || acceptance.receipt.inputDigest !== stored.inputDigest || acceptance.receipt.state !== 'accepted'
      || !acceptance.execution || acceptance.execution.executionRef !== stored.executionRef
      || acceptance.execution.acceptedSeq > stored.confirmedSeq
      || JSON.stringify(acceptance.receipt.receiver) !== JSON.stringify(action.receiver)) corrupt('command identity or receipt');
    const state = action.execution.basis.state;
    if (state) {
      const { rows: [content] } = await storage.read(`SELECT activity_id,encoding,media_type FROM work_contents WHERE content_id=$1`,
        [state.contentId]);
      if (!content || content.activity_id !== row.activity_id || content.encoding !== 'json'
        || content.media_type !== componentStateMediaType) throw new StorageError('corrupt');
      const text = Buffer.from(await storage.readResource(state.contentId)).toString('utf8');
      if (canonicalDigest(JSON.parse(text)) !== state.sha256) throw new StorageError('corrupt');
    }
    // A reference must still point at the exact bytes the command was accepted against.
    const { rows: links } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1',
      [`execution/${stored.requestId}/state`]);
    if (state && (links.length !== 1 || links[0]!.resource_id !== state.contentId)) throw new StorageError('corrupt');
    if (!state && links.length) throw new StorageError('corrupt');
  }
  const { rows: stops } = await storage.read('SELECT * FROM execution_stops');
  for (const row of stops) {
    const { rows: [activity] } = await storage.read('SELECT body FROM activities WHERE id=$1', [row.activity_id]);
    if (!activity || typeof row.reason !== 'string' || row.reason.length > 200) corrupt('stop activity or reason');
    const { rows: [command] } = await storage.read('SELECT input_digest,stop_requested,state FROM execution_commands WHERE request_id=$1',
      [row.request_id]);
    if (!command || command.input_digest !== row.input_digest) throw new StorageError('corrupt');
    // A stop received after completion is recorded without rewriting the confirmed terminal fact.
    if (!command.stop_requested && !['succeeded', 'failed', 'cancelled'].includes(String(command.state)))
      throw new StorageError('corrupt');
  }
  const { rows: results } = await storage.read('SELECT * FROM execution_results');
  for (const row of results) {
    const { rows: [command] } = await storage.read('SELECT execution_ref,output FROM execution_commands WHERE request_id=$1',
      [row.request_id]);
    if (!command || command.execution_ref !== row.execution_ref) throw new StorageError('corrupt');
    const output = command.output as { contentId?: string; artifact?: { sha256?: string } } | null;
    if (output && (output.contentId !== row.content_id || output.artifact?.sha256 !== row.sha256)) throw new StorageError('corrupt');
    const bytes = Buffer.from(await storage.readResource(String(row.content_id)));
    if (bytes.length !== row.byte_length || createHash('sha256').update(bytes).digest('hex') !== row.sha256)
      throw new StorageError('corrupt');
    const { rows: links } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1',
      [`execution/${row.request_id}/result`]);
    if (links.length !== 1 || links[0]!.resource_id !== row.content_id) throw new StorageError('corrupt');
  }
}
