import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import type { Migration, OwnedStorage, OwnedTransaction } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import { acceptsState, componentInstanceId, componentStateName } from '@xunjie/contracts/components';
import { advanceExecution, canonicalValue, decideExecutionPlacement, executionActionSchema,
  executionControlSchema, executionControlReceiptSchema, executionQuerySchema, executionStopSchema, isTerminalExecutionState } from '@xunjie/contracts/execution';
import type { ExecutionAction, ExecutionQuery } from '@xunjie/contracts/execution';
import { productNativeAdapters } from './native-process.js';
import { verifyPlannedExecution } from './plan.js';
import type { createNativeChannel } from './native-channel.js';
import type { createWorks } from './works.js';
import { createSessionCheckpoints } from './session-checkpoints.js';
import type { NativeObservation } from './native-process.js';

export const channelExecutionMigration: Migration = { version: 11, name: 'school-channel-execution-ledger', sql: `
  CREATE TABLE channel_executions(request_id uuid PRIMARY KEY,activity_id uuid NOT NULL,input_digest text NOT NULL,
    action jsonb NOT NULL,action_text text NOT NULL,activity jsonb NOT NULL,connection_id uuid NOT NULL,execution jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE INDEX channel_executions_activity ON channel_executions(activity_id);
  CREATE TABLE channel_execution_intents(command_id uuid PRIMARY KEY,request_id uuid NOT NULL,
    command jsonb NOT NULL,command_text text NOT NULL,dispatched boolean NOT NULL DEFAULT false,position bigserial UNIQUE);
` };
export const channelCheckpointMigration: Migration = { version: 16, name: 'channel-session-checkpoints', sql: `
  ALTER TABLE channel_executions ADD COLUMN execution_ref uuid
    GENERATED ALWAYS AS ((execution->>'executionRef')::uuid) STORED UNIQUE;
  ALTER TABLE channel_execution_intents ADD COLUMN checkpoint_pending jsonb;
  CREATE VIEW channel_session_sources AS SELECT request_id,activity_id,action,execution_ref AS session_ref,
    (execution#>>'{session,executorInstanceId}')::uuid AS executor_instance_id,
    COALESCE(execution#>'{session,checkpoints}','[]'::jsonb) AS checkpoints FROM channel_executions;
  CREATE TABLE channel_session_checkpoints(checkpoint_id uuid PRIMARY KEY,
    session_ref uuid NOT NULL REFERENCES channel_executions(execution_ref),
    control_id uuid NOT NULL UNIQUE REFERENCES channel_execution_intents(command_id),content_id uuid NOT NULL,
    sha256 text NOT NULL,byte_length integer NOT NULL,applied_seq integer NOT NULL,envelope jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
` };
const checkpointReport = z.object({ query: executionQuerySchema, checkpoint: z.object({
  observation: z.object({ seq: z.number().int().positive(), controlId: z.uuid(), state: z.json(),
    at: z.string(), sessionState: z.enum(['running', 'paused']), checkpoint: z.json() }).strict(),
  environment: z.object({ platform: z.string(), arch: z.string(), node: z.string() }).strict(),
}).strict() }).strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonicalHash = (value: unknown) => hash(canonicalValue(value));
function fail(code: 'forbidden' | 'missing' | 'invalid' | 'identity-conflict' | 'corrupt'): never { throw new StorageError(code); }
const scopeMatches = (scope: ExecutionAction['scope'], identity: SpaceIdentity, activityId: string) =>
  scope.activityId === activityId && scope.environmentId === identity.environmentId
  && scope.spaceId === identity.spaceId && scope.principalId === identity.principalId;

/** 学校保存唯一执行身份；本机仅领取固定快照并报告同一节点确认的事实。 */
export function createChannelExecutions(storage: OwnedStorage, options: {
  activity(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
  works: ReturnType<typeof createWorks>;
  channel: ReturnType<typeof createNativeChannel>;
  authorizeComponent?(identity: SpaceIdentity, activity: LearningActivity, action: ExecutionAction): Promise<void>;
}) {
  const checkpoints = createSessionCheckpoints(storage, true);
  async function find(activityId: string, requestId: string) {
    z.uuid().parse(requestId);
    const { rows: [row] } = await storage.read('SELECT * FROM channel_executions WHERE activity_id=$1 AND request_id=$2', [activityId, requestId]);
    return row ?? null;
  }
  async function cancelledBeforeEnqueue(tx: OwnedTransaction, action: ExecutionAction, current: ExecutionQuery) {
    if (action.execution.initiator.kind !== 'agent' || current.state !== 'queued' || current.statusKnowledge !== 'confirmed') return null;
    const { rows: [agent] } = await tx.query(`SELECT cancelled FROM agent_execution_commands
      WHERE command_id=$1 AND activity_id=$2 AND kind='submit' FOR SHARE`, [action.requestId, action.scope.activityId]);
    if (!agent?.cancelled) return null;
    const { rows: queued } = await tx.query('SELECT command_id FROM native_channel_commands WHERE command_id=$1', [action.requestId]);
    if (queued.length) return null;
    // Closing the original Agent capability fences claims, including a sender that lost
    // its reply and enqueues late. No native command has been accepted or claimed here.
    return executionQuerySchema.parse({ ...current, state: 'cancelled', statusKnowledge: 'confirmed', stopRequested: true,
      confirmedSeq: current.confirmedSeq + 1,
      reason: { code: 'worker-terminated', detail: '原命令在进入执行节点前已取消，未启动会话。' } });
  }
  async function authorize(identity: SpaceIdentity, activityId: string, row?: Record<string, unknown>) {
    const activity = await options.activity(identity, activityId);
    if (row && !scopeMatches(executionActionSchema.parse(row.action).scope, identity, activityId)) fail('forbidden');
    return activity;
  }
  function verify(activity: LearningActivity, action: ExecutionAction) {
    const execution = action.execution, instance = execution.instance;
    const binding = activity.course?.components?.find(item => item.key === instance.key);
    if (!binding) fail('forbidden');
    const manifest = binding.definition.manifest;
    if (manifest.formatVersion !== 1) fail('invalid');
    const declared = manifest.session, session = execution.session;
    if (!declared || !session || execution.plan.location !== 'native'
      || execution.plan.kind !== 'session' || action.receiver.location !== 'local') fail('invalid');
    if (componentInstanceId(activity.activityId, instance.key) !== instance.instanceId
      || manifest.componentId !== instance.componentId || manifest.version !== instance.componentVersion
      || manifest.stateVersion !== instance.stateVersion || manifest.hostApiVersion !== instance.hostApiVersion
      || binding.definition.digest !== instance.definitionDigest) fail('identity-conflict');
    verifyPlannedExecution(activity, { key: instance.key, definitionDigest: instance.definitionDigest,
      operationId: execution.operation.operationId, location: 'native' });
    if (session.adapterId !== declared.adapterId || session.adapterVersion !== declared.adapterVersion
      || execution.operation.operationId !== declared.operation.operationId || execution.operation.effect !== 'input') fail('identity-conflict');
    if (!acceptsState(declared.parameters, execution.parameters)) fail('invalid');
    const budgets = declared.budgets, limits = execution.limits;
    if (limits.timeMs > budgets.operationTimeoutMs || limits.inputBytes > budgets.inputBytes
      || limits.outputBytes > budgets.outputBytes || limits.concurrentJobs > budgets.concurrentSessions
      || limits.queuedJobs > budgets.queuedSessions
      || session.limits.operationTimeoutMs !== budgets.operationTimeoutMs || session.limits.idleMs !== budgets.idleMs
      || session.limits.maxMs !== budgets.maxMs || session.limits.memoryMiB !== budgets.memoryMiB
      || session.limits.concurrentSessions !== budgets.concurrentSessions || session.limits.queuedSessions !== budgets.queuedSessions) fail('invalid');
    const plan = execution.plan;
    if (plan.planId !== 'native-session' || plan.planVersion !== 1 || plan.planDigest !== canonicalHash({
      planId: plan.planId, planVersion: plan.planVersion, componentId: manifest.componentId,
      componentVersion: manifest.version, operationId: execution.operation.operationId }) || execution.basis.resources.length) fail('invalid');
    const adapter = productNativeAdapters.find(item => item.adapterId === session.adapterId && item.adapterVersion === session.adapterVersion);
    if (!adapter?.platforms) fail('forbidden');
    const state = execution.basis.state;
    if ((state?.contentId ?? null) !== execution.basis.expected.stateContentId) fail('invalid');
    if (state) {
      const file = execution.basis.works.find(item => item.name === state.name);
      if (state.name !== componentStateName(instance.key) || !file || file.contentId !== state.contentId
        || file.kind !== 'state' || file.encoding !== 'json' || file.mediaType !== 'application/vnd.xunjie.component-state+json') fail('invalid');
      let value: unknown;
      try { value = JSON.parse(file.value); } catch { return fail('corrupt'); }
      if (canonicalHash(value) !== state.sha256) fail('corrupt');
    }
    return { binding, declared, adapter };
  }
  async function dispatch(identity: SpaceIdentity, activityId: string, row: Record<string, unknown>, guard?: () => Promise<void>) {
    await authorize(identity, activityId, row);
    const { rows } = await storage.read('SELECT command_id,command_text FROM channel_execution_intents WHERE request_id=$1 AND dispatched=false ORDER BY position', [row.request_id]);
    for (const intent of rows) {
      await authorize(identity, activityId, row);
      const latest = await find(activityId, String(row.request_id));
      const query = executionQuerySchema.parse(latest?.execution);
      if (query.statusKnowledge === 'confirmed' && isTerminalExecutionState(query.state)) return;
      const command = JSON.parse(String(intent.command_text)) as { operation: string };
      if (command.operation !== 'stop') {
        if (executionActionSchema.parse(row.action).execution.initiator.kind === 'agent' && !guard) continue;
        await guard?.();
      }
      await options.channel.enqueue(identity, String(row.connection_id), JSON.parse(String(intent.command_text)));
      await storage.request({ requestId: `channel-dispatched:${intent.command_id}`, fingerprint: String(intent.command_id) }, async tx => {
        await tx.query('UPDATE channel_execution_intents SET dispatched=true WHERE command_id=$1', [intent.command_id]);
        return null;
      });
    }
  }
  async function accept(identity: SpaceIdentity, activityId: string, value: unknown, guard?: () => Promise<void>): Promise<ExecutionQuery> {
    const { action } = z.object({ action: executionActionSchema, acceptance: z.unknown().optional() }).strict().parse(value);
    const activity = await authorize(identity, activityId);
    if (!scopeMatches(action.scope, identity, activityId)) fail('forbidden');
    const inputDigest = hash(action), previous = await find(activityId, action.requestId);
    if (previous) {
      if (previous.input_digest !== inputDigest) fail('identity-conflict');
      await dispatch(identity, activityId, previous, guard);
      return (await read(identity, activityId, action.requestId))!;
    }
    const { binding, declared, adapter } = verify(activity, action);
    await options.authorizeComponent?.(identity, activity, action);
    if (declared.controls?.some(effect => !adapter.controls?.includes(effect))
      || declared.checkpointVersion && declared.checkpointVersion !== adapter.checkpointVersion) fail('invalid');
    // Validate the checkpoint before choosing among available devices. Its runtime is
    // part of compatibility, rather than a reason to reject the first arbitrary node.
    const restored = action.execution.resumeFromCheckpoint
      ? await checkpoints.restore(action, binding.configuration, declared.checkpointVersion ?? fail('invalid'), null) : null;
    const nodes = await options.channel.nodes(identity);
    const node = nodes.find(candidate => adapter.platforms!.includes(candidate.platform)
      && candidate.adapters.some(item => item.adapterId === declared.adapterId && item.adapterVersion === declared.adapterVersion)
      && (!restored || candidate.runtime && canonicalHash(candidate.runtime) === canonicalHash(restored.environment)));
    if (!node) fail('missing');
    const coursePlan = activity.course?.executionPlan;
    if (coursePlan) {
      const placement = decideExecutionPlacement({ operationId: action.execution.operation.operationId, kind: 'session',
        adapter: declared, plan: coursePlan, remoteAvailable: false, device: { platform: node.platform,
          browser: { worker: false, webassembly: false, sandboxedFrame: false },
          native: { supported: true, installed: true, authorized: true, prepared: 'ready' } } });
      if (placement.owner !== 'device' || placement.location !== 'native') fail('forbidden');
    }
    const epoch = node.supervisorEpoch;
    const execution = executionQuerySchema.parse({ requestId: action.requestId, inputDigest, scope: action.scope,
      executionRef: randomUUID(), state: 'queued', statusKnowledge: 'confirmed', stopRequested: false,
      confirmedSeq: 1, reason: null, output: null, session: { adapterId: declared.adapterId, adapterVersion: declared.adapterVersion,
        instanceId: action.execution.instance.instanceId, instanceKey: action.execution.instance.key, nodeId: node.nodeId,
        installGeneration: node.installationId, supervisorEpoch: epoch, executorInstanceId: randomUUID(),
        appliedSeq: 0, lastControlId: null, observation: null, observations: [],
        ...(action.execution.resumeFromCheckpoint ? { restoredFrom: action.execution.resumeFromCheckpoint } : {}) } });
    for (const file of action.execution.basis.works) await options.works.registerBasis(identity, activityId, file);
    const command = { commandId: action.requestId, activityId, sessionId: execution.executionRef, operation: 'submit',
      payload: { action, activity, execution, ...(restored ? { restore: { snapshot: restored.snapshot, environment: node.runtime! } } : {}) } };
    await storage.request({ requestId: `channel-execution:${action.requestId}`, fingerprint: hash({ identity, activityId, inputDigest }) }, async tx => {
      await tx.query(`INSERT INTO channel_executions(request_id,activity_id,input_digest,action,action_text,activity,connection_id,execution)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(request_id) DO NOTHING`, [action.requestId, activityId, inputDigest,
        JSON.stringify(action), JSON.stringify(action), JSON.stringify(activity), node.connectionId, JSON.stringify(execution)]);
      const { rows: [saved] } = await tx.query('SELECT * FROM channel_executions WHERE request_id=$1 FOR UPDATE', [action.requestId]);
      if (!saved || saved.activity_id !== activityId || saved.input_digest !== inputDigest) fail('identity-conflict');
      await tx.query('INSERT INTO channel_execution_intents(command_id,request_id,command,command_text) VALUES($1,$2,$3,$4) ON CONFLICT(command_id) DO NOTHING',
        [action.requestId, action.requestId, JSON.stringify(command), JSON.stringify(command)]);
      for (const file of action.execution.basis.works) await tx.reference(`channel/${action.requestId}/work/${file.contentId}`, file.contentId);
      if (action.execution.basis.state) await tx.reference(`channel/${action.requestId}/state`, action.execution.basis.state.contentId);
      if (restored) await tx.reference(`native/${action.requestId}/restore`, restored.contentId);
      return null;
    });
    const saved = (await find(activityId, action.requestId))!;
    await dispatch(identity, activityId, saved, guard);
    return executionQuerySchema.parse(saved.execution);
  }
  async function read(identity: SpaceIdentity, activityId: string, requestId: string, guard?: () => Promise<void>): Promise<ExecutionQuery | null> {
    const row = await find(activityId, requestId);
    await authorize(identity, activityId, row ?? undefined);
    if (!row) return null;
    await dispatch(identity, activityId, row, guard);
    // An unqueued intent has no channel fact yet. Ordinary reads preserve its queued
    // execution; only a trusted caller with the original permit can deliver that intent.
    const { rows: intents } = await storage.read('SELECT command_id FROM channel_execution_intents WHERE request_id=$1 AND dispatched=true ORDER BY position', [requestId]);
    const facts: Awaited<ReturnType<typeof options.channel.query>>[] = [];
    for (const intent of intents) {
      const fact = await options.channel.query(identity, String(intent.command_id));
      const report = checkpointReport.safeParse(fact.result);
      if (report.success) {
        const { query, checkpoint } = report.data, controlId = String(intent.command_id);
        const { rows: [original] } = await storage.read('SELECT command FROM channel_execution_intents WHERE command_id=$1', [controlId]);
        const control = executionControlSchema.parse((original!.command as { payload: { control: unknown } }).payload.control);
        const fixed = executionQuerySchema.parse(row.execution);
        if (control.effect !== 'checkpoint' || controlId !== checkpoint.observation.controlId
          || query.session?.lastControlId !== controlId || query.session?.appliedSeq !== checkpoint.observation.seq
          || checkpoint.observation.seq !== control.expectedSeq + 1 || query.executionRef !== fixed.executionRef
          || query.inputDigest !== fixed.inputDigest || query.requestId !== requestId
          || canonicalHash(query.scope) !== canonicalHash(fixed.scope)
          || !fixed.session || !query.session || ['adapterId', 'adapterVersion', 'instanceId', 'instanceKey',
            'nodeId', 'installGeneration', 'supervisorEpoch', 'executorInstanceId']
            .some(key => fixed.session![key as keyof typeof fixed.session] !== query.session![key as keyof typeof query.session])
          || canonicalHash(query.session.observation) !== canonicalHash(checkpoint.observation.state)) fail('identity-conflict');
        const action = executionActionSchema.parse(row.action);
        const { binding, declared } = verify(row.activity as LearningActivity, action);
        const { rows: [claimed] } = await storage.read('SELECT claim_node FROM native_channel_commands WHERE command_id=$1', [controlId]);
        const runtime = (claimed?.claim_node as { runtime?: unknown } | undefined)?.runtime;
        if (!runtime || canonicalHash(runtime) !== canonicalHash(checkpoint.environment)) fail('forbidden');
        await checkpoints.capture({ action, session_ref: query.executionRef, executor_instance_id: query.session.executorInstanceId },
          controlId, checkpoint.observation as NativeObservation, binding.configuration,
          declared.checkpointVersion ?? fail('invalid'), checkpoint.environment);
        facts.push({ ...fact, result: query });
      } else facts.push(fact);
    }
    const saved = await storage.request({ requestId: `channel-fact:${randomUUID()}`, fingerprint: requestId }, async tx => {
      const { rows: [latest] } = await tx.query('SELECT execution FROM channel_executions WHERE request_id=$1 FOR UPDATE', [requestId]);
      let current = executionQuerySchema.parse(latest!.execution);
      for (const fact of facts) {
        const parsed = executionQuerySchema.safeParse(fact.result);
        if (parsed.success) {
          const next = parsed.data, left = current.session, right = next.session;
          if (!left || !right || next.requestId !== current.requestId || next.inputDigest !== current.inputDigest
            || next.executionRef !== current.executionRef || hash(next.scope) !== hash(current.scope)
            || ['adapterId', 'adapterVersion', 'instanceId', 'instanceKey', 'nodeId', 'installGeneration', 'supervisorEpoch', 'executorInstanceId']
              .some(key => left[key as keyof typeof left] !== right[key as keyof typeof right])) fail('identity-conflict');
          if (next.state !== current.state && next.confirmedSeq <= current.confirmedSeq) continue;
          if (next.confirmedSeq >= current.confirmedSeq && right.appliedSeq >= left.appliedSeq) current = advanceExecution(current,
            executionQuerySchema.parse({ ...next, session: { ...right, checkpoints: left.checkpoints } }));
        } else if (fact.state === 'claimed' || fact.statusKnowledge === 'unknown' || fact.state === 'reported') {
          current = advanceExecution(current, executionQuerySchema.parse({ ...current, statusKnowledge: 'unknown',
            reason: { code: 'resource-unavailable', detail: '原节点尚未确认该动作，保持原执行身份且不重新执行。' } }));
        }
      }
      await tx.query('UPDATE channel_executions SET execution=$2 WHERE request_id=$1', [requestId, JSON.stringify(current)]);
      return current;
    });
    return executionQuerySchema.parse(saved.result);
  }
  async function intent(identity: SpaceIdentity, activityId: string, requestId: string, commandId: string, operation: 'control' | 'stop', payload: unknown, guard?: () => Promise<void>) {
    const row = await find(activityId, requestId);
    const activity = await authorize(identity, activityId, row ?? undefined);
    if (!row) fail('missing');
    const action = executionActionSchema.parse(row.action), current = executionQuerySchema.parse(row.execution);
    const command = { commandId, activityId, sessionId: current.executionRef, operation,
      payload: { requestId, executionRef: current.executionRef, [operation === 'stop' ? 'stop' : 'control']: payload } };
    const { rows: [existing] } = await storage.read('SELECT request_id,command FROM channel_execution_intents WHERE command_id=$1', [commandId]);
    if (existing) {
      if (existing.request_id !== requestId || canonicalHash(existing.command) !== canonicalHash(command)) fail('identity-conflict');
      await dispatch(identity, activityId, row, guard);
      return (await read(identity, activityId, requestId))!;
    }
    if (operation === 'control') {
      await options.authorizeComponent?.(identity, activity, action);
      const control = executionControlSchema.parse(payload);
      const original = (row.activity as LearningActivity).course?.components?.find(item => item.key === action.execution.instance.key)?.definition.manifest;
      const currentBinding = activity.course?.components?.find(item => item.key === action.execution.instance.key);
      const declared = original?.formatVersion === 1 ? original.session : null;
      if (!declared || currentBinding?.definition.digest !== action.execution.instance.definitionDigest) fail('invalid');
      verifyPlannedExecution(activity, { key: action.execution.instance.key, definitionDigest: action.execution.instance.definitionDigest,
        operationId: action.execution.operation.operationId, location: 'native' });
      if (control.effect === 'input' ? control.operationId !== declared.operation.operationId
        : control.operationId !== control.effect || !declared.controls?.includes(control.effect)) fail('invalid');
      if (control.effect === 'input' || control.effect === 'step') {
        if (!acceptsState(declared.operation.parameters, control.parameters)) fail('invalid');
      } else if (!control.parameters || typeof control.parameters !== 'object' || Array.isArray(control.parameters)
        || Object.keys(control.parameters).length) fail('invalid');
      const observed = await read(identity, activityId, requestId);
      if (!observed || !['running', 'paused'].includes(observed.state) || observed.statusKnowledge !== 'confirmed'
        || observed.stopRequested || control.expectedSeq !== observed.session?.appliedSeq) fail('invalid');
      const required = control.effect === 'input' || control.effect === 'pause' ? 'running'
        : control.effect === 'reset' ? observed.state : 'paused';
      if (observed.state !== required) fail('invalid');
    }
    await storage.request({ requestId: `channel-intent:${commandId}`, fingerprint: hash({ identity, command }) }, async tx => {
      const { rows: [locked] } = await tx.query('SELECT execution FROM channel_executions WHERE request_id=$1 FOR UPDATE', [requestId]);
      const latest = executionQuerySchema.parse(locked!.execution);
      if (operation === 'control' && (!['running', 'paused'].includes(latest.state) || latest.statusKnowledge !== 'confirmed'
        || latest.stopRequested || executionControlSchema.parse(payload).expectedSeq !== latest.session?.appliedSeq)) fail('invalid');
      if (operation === 'control') {
        const { rows: pending } = await tx.query(`SELECT command_id FROM channel_execution_intents
          WHERE request_id=$1 AND command#>>'{operation}'='control'
          AND (command#>>'{payload,control,expectedSeq}')::integer=$2`, [requestId, latest.session!.appliedSeq]);
        if (pending.length) fail('identity-conflict');
      }
      await tx.query('INSERT INTO channel_execution_intents(command_id,request_id,command,command_text) VALUES($1,$2,$3,$4)', [commandId, requestId, JSON.stringify(command), JSON.stringify(command)]);
      if (operation === 'stop') {
        const cancelled = await cancelledBeforeEnqueue(tx, action, latest);
        await tx.query('UPDATE channel_executions SET execution=$2 WHERE request_id=$1',
          [requestId, JSON.stringify(cancelled ?? { ...latest, stopRequested: true })]);
      }
      return null;
    });
    await dispatch(identity, activityId, row, guard);
    return (await read(identity, activityId, requestId))!;
  }
  async function control(identity: SpaceIdentity, activityId: string, requestId: string, value: unknown, guard?: () => Promise<void>) {
    const parsed = executionControlSchema.parse(value);
    return intent(identity, activityId, requestId, parsed.controlId, 'control', parsed, guard);
  }
  async function stop(identity: SpaceIdentity, activityId: string, requestId: string, value: unknown) {
    const parsed = executionStopSchema.parse(value);
    return intent(identity, activityId, requestId, parsed.stopId, 'stop', parsed);
  }
  async function list(identity: SpaceIdentity, activityId: string) {
    await authorize(identity, activityId);
    const { rows } = await storage.read('SELECT request_id FROM channel_executions WHERE activity_id=$1 ORDER BY created_at', [activityId]);
    const results: ExecutionQuery[] = [];
    for (const row of rows) { const value = await read(identity, activityId, String(row.request_id)); if (value) results.push(value); }
    return results;
  }
  async function controlReceipt(identity: SpaceIdentity, activityId: string, requestId: string, controlId: string) {
    z.uuid().parse(controlId);
    const query = await read(identity, activityId, requestId);
    if (!query) return null;
    const { rows: [intent] } = await storage.read('SELECT command FROM channel_execution_intents WHERE request_id=$1 AND command_id=$2', [requestId, controlId]);
    if (!intent) return null;
    const control = executionControlSchema.parse((intent.command as { payload: { control: unknown } }).payload.control);
    const fact = await options.channel.query(identity, controlId), seq = control.expectedSeq + 1;
    const originalReply = executionQuerySchema.safeParse(checkpointReport.safeParse(fact.result).data?.query ?? fact.result);
    const applied = originalReply.success && originalReply.data.requestId === requestId
      && originalReply.data.executionRef === query.executionRef && originalReply.data.session?.lastControlId === controlId
      && originalReply.data.session.appliedSeq === seq;
    return executionControlReceiptSchema.parse({ controlId, requestId, executionRef: query.executionRef,
      inputDigest: canonicalHash(control), effect: control.effect, seq,
      status: applied ? 'applied' : fact.state === 'cancelled' ? 'rejected' : fact.state === 'reported' ? 'unknown' : 'dispatching', query });
  }
  async function reclaimOriginal(action: ExecutionAction, value: unknown) {
    const stop = executionStopSchema.parse(value);
    const row = await find(action.scope.activityId, action.requestId);
    if (!row || canonicalHash(row.action) !== canonicalHash(action)) fail('identity-conflict');
    const current = executionQuerySchema.parse(row.execution);
    if (['succeeded', 'failed', 'cancelled'].includes(current.state) && current.statusKnowledge === 'confirmed') return current;
    const unqueued = await storage.request({ requestId: 'channel-unqueued-stop:' + stop.stopId,
      fingerprint: canonicalHash({ action, stop }) }, async tx => {
      const { rows: [locked] } = await tx.query('SELECT execution FROM channel_executions WHERE request_id=$1 FOR UPDATE', [action.requestId]);
      if (!locked) fail('missing');
      const cancelled = await cancelledBeforeEnqueue(tx, action, executionQuerySchema.parse(locked.execution));
      if (!cancelled) return null;
      const command = { commandId: stop.stopId, activityId: action.scope.activityId, sessionId: cancelled.executionRef,
        operation: 'stop', payload: { requestId: action.requestId, executionRef: cancelled.executionRef, stop } };
      await tx.query(`INSERT INTO channel_execution_intents(command_id,request_id,command,command_text)
        VALUES($1,$2,$3,$4) ON CONFLICT(command_id) DO NOTHING`,
        [stop.stopId, action.requestId, JSON.stringify(command), JSON.stringify(command)]);
      const { rows: [saved] } = await tx.query('SELECT request_id,command FROM channel_execution_intents WHERE command_id=$1', [stop.stopId]);
      if (!saved || saved.request_id !== action.requestId || canonicalHash(saved.command) !== canonicalHash(command)) fail('identity-conflict');
      await tx.query('UPDATE channel_executions SET execution=$2 WHERE request_id=$1', [action.requestId, JSON.stringify(cancelled)]);
      return cancelled;
    });
    if (unqueued.result) return executionQuerySchema.parse(unqueued.result);
    const observed = await options.channel.reclaimOriginal(action.requestId, current);
    const saved = await storage.request({ requestId: 'channel-reclaim:' + randomUUID(), fingerprint: hash({ requestId: action.requestId, observed }) }, async tx => {
      const { rows: [latest] } = await tx.query('SELECT execution FROM channel_executions WHERE request_id=$1 FOR UPDATE', [action.requestId]);
      if (!latest) fail('missing');
      const next = advanceExecution(executionQuerySchema.parse(latest.execution), observed);
      await tx.query('UPDATE channel_executions SET execution=$2 WHERE request_id=$1', [action.requestId, JSON.stringify(next)]);
      return next;
    });
    return executionQuerySchema.parse(saved.result);
  }
  return { accept, read, control, stop, list, controlReceipt, reclaimOriginal,
    owns: async (activityId: string, requestId: string) => (await find(activityId, requestId)) !== null };
}

export async function validateChannelExecutions(storage: OwnedStorage) {
  await createSessionCheckpoints(storage, true).validate();
  const { rows } = await storage.read('SELECT * FROM channel_executions');
  for (const row of rows) {
    const action = executionActionSchema.parse(JSON.parse(String(row.action_text))), execution = executionQuerySchema.parse(row.execution);
    if (canonicalHash(action) !== canonicalHash(row.action)) fail('corrupt');
    const activity = row.activity as LearningActivity;
    if (action.requestId !== row.request_id || hash(action) !== row.input_digest || execution.inputDigest !== row.input_digest
      || execution.requestId !== row.request_id || !scopeMatches(action.scope, activity.identity, String(row.activity_id))
      || activity.activityId !== row.activity_id || hash(execution.scope) !== hash(action.scope) || !execution.session) fail('corrupt');
    z.uuid().parse(row.connection_id);
    const { rows: intents } = await storage.read('SELECT command_id,command,command_text FROM channel_execution_intents WHERE request_id=$1 ORDER BY position', [row.request_id]);
    if (!intents.length) fail('corrupt');
    for (const intent of intents) {
      const command = z.object({ commandId: z.uuid(), activityId: z.uuid(), sessionId: z.uuid(),
        operation: z.enum(['submit', 'control', 'stop']), payload: z.unknown() }).strict().parse(JSON.parse(String(intent.command_text)));
      if (canonicalHash(command) !== canonicalHash(intent.command)) fail('corrupt');
      if (command.commandId !== intent.command_id || command.activityId !== row.activity_id || command.sessionId !== execution.executionRef) fail('corrupt');
      if (command.operation === 'submit') {
        const payload = z.object({ action: executionActionSchema, activity: z.unknown(), execution: executionQuerySchema,
          restore: z.object({ snapshot: z.json(), environment: z.object({ platform: z.string(), arch: z.string(), node: z.string() }).strict() }).strict().optional(),
        }).strict().parse(command.payload);
        if (command.commandId !== row.request_id || hash(payload.action) !== row.input_digest
          || canonicalHash(payload.activity) !== canonicalHash(activity) || payload.execution.executionRef !== execution.executionRef
          || payload.execution.inputDigest !== execution.inputDigest || payload.execution.requestId !== row.request_id
          || !payload.execution.session || ['adapterId', 'adapterVersion', 'instanceId', 'instanceKey', 'nodeId', 'installGeneration', 'supervisorEpoch', 'executorInstanceId']
            .some(key => payload.execution.session![key as keyof NonNullable<ExecutionQuery['session']>]
              !== execution.session![key as keyof NonNullable<ExecutionQuery['session']>])) fail('corrupt');
      } else {
        const payload = z.object({ requestId: z.uuid(), executionRef: z.uuid(),
          control: executionControlSchema.optional(), stop: executionStopSchema.optional() }).strict().parse(command.payload);
        if (payload.requestId !== row.request_id || payload.executionRef !== execution.executionRef
          || (command.operation === 'control' ? payload.control?.controlId : payload.stop?.stopId) !== command.commandId) fail('corrupt');
      }
    }
    for (const file of action.execution.basis.works) {
      const { rows: references } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1', [`channel/${action.requestId}/work/${file.contentId}`]);
      if (references.length !== 1 || references[0]!.resource_id !== file.contentId) fail('corrupt');
    }
    const state = action.execution.basis.state;
    const { rows: stateReferences } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1', [`channel/${action.requestId}/state`]);
    if (state ? stateReferences.length !== 1 || stateReferences[0]!.resource_id !== state.contentId : stateReferences.length !== 0) fail('corrupt');
  }
  const { rows: orphaned } = await storage.read('SELECT command_id FROM channel_execution_intents i WHERE NOT EXISTS(SELECT 1 FROM channel_executions e WHERE e.request_id=i.request_id)');
  if (orphaned.length) fail('corrupt');
}
