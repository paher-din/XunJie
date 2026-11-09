import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import { storageOwnerSchema } from '@xunjie/contracts/storage';
import { activitySchema, type LearningActivity } from '@xunjie/contracts/learning-data';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { acceptsState, componentInstanceId, matchesComponentState } from '@xunjie/contracts/components';
import { anyExecutionActionSchema, canonicalValue, isTerminalExecutionState, executionQuerySchema,
  executionArtifactSchema, type AnyExecutionAction, type ExecutionQuery } from '@xunjie/contracts/execution';
import { executionRecordEventSchema, executionRecordSchema, executionRecordPageSchema, executionRecordSessionIdentitySchema,
  type ExecutionRecord } from '@xunjie/contracts/execution-records';
import type { createWorks } from './works.js';
import { verifyPlannedExecution } from './plan.js';
import { verifyRuntimeBasis, verifyEnabledRuntimeSource, verifyAluCasePriorSource } from './runtime-basis.js';
import { aluCaseFromAction } from '@xunjie/contracts/alu-learning';

/** Facts and resource replicas only. None of these tables is an executor's command queue. */
export const executionRecordMigration: Migration = { version: 28, name: 'source-owned-execution-records', sql: `
CREATE TABLE execution_records(request_id uuid PRIMARY KEY,activity_id uuid NOT NULL REFERENCES activities(id),
  source_owner jsonb NOT NULL,installation_id uuid NOT NULL,target text NOT NULL,
  action_text text NOT NULL,input_digest text NOT NULL,execution_ref uuid NOT NULL UNIQUE,
  reception jsonb NOT NULL,initial_query jsonb NOT NULL,query jsonb NOT NULL,
  course_digest text NOT NULL,result jsonb,created_at timestamptz NOT NULL);
CREATE INDEX execution_records_activity ON execution_records(activity_id,request_id);
CREATE TABLE execution_record_facts(request_id uuid NOT NULL REFERENCES execution_records(request_id),
  fact_digest text NOT NULL,query jsonb NOT NULL,PRIMARY KEY(request_id,fact_digest));
CREATE TABLE execution_record_observations(request_id uuid NOT NULL REFERENCES execution_records(request_id),
  seq integer NOT NULL,observation jsonb NOT NULL,PRIMARY KEY(request_id,seq));
` };

export interface TrustedExecutionSource {
  sourceOwner: OwnedStorage['owner'];
  installationId: string;
  role: 'tool-execution';
  /** Supplied by the host from the approved binding, never from the event. Defaults to a device. */
  nodeClass?: 'device' | 'school-execution-node';
  assertAuthorized?(): Promise<void>;
}
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown) => sha(JSON.stringify(canonicalValue(value)));
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
function fail(code: 'invalid' | 'forbidden' | 'missing' | 'identity-conflict' | 'corrupt' | 'unavailable'): never { throw new StorageError(code); }
const scopeOf = (activity: LearningActivity) => ({ environmentId: activity.identity.environmentId,
  spaceId: activity.identity.spaceId, principalId: activity.identity.principalId, activityId: activity.activityId });
const courseDigest = (activity: LearningActivity) => hash(activity.course ?? null);
function command(text: string): AnyExecutionAction {
  try {
    const raw: unknown = JSON.parse(text), action = anyExecutionActionSchema.parse(raw);
    if (!same(raw, action)) fail('invalid');
    return action;
  } catch { return fail('invalid'); }
}
function verifyCommand(activity: LearningActivity, action: AnyExecutionAction, target: ExecutionRecord['target']) {
  if (!same(action.scope, scopeOf(activity))) fail('forbidden');
  const e = action.execution, instance = e.instance, binding = activity.course?.components?.find(item => item.key === instance.key);
  if (!binding) return fail('forbidden');
  const m = binding.definition.manifest;
  if (instance.instanceId !== componentInstanceId(activity.activityId, binding.key) || instance.componentId !== m.componentId
    || instance.componentVersion !== m.version || instance.definitionDigest !== binding.definition.digest
    || instance.stateVersion !== m.stateVersion || instance.hostApiVersion !== m.hostApiVersion) fail('identity-conflict');
  if ((target === 'student-browser') !== (e.plan.location === 'browser')
    || target === 'school-runtime' && action.receiver.location !== 'remote'
    || target !== 'school-runtime' && action.receiver.location !== 'local') fail('identity-conflict');
  const budgets = action.protocolVersion === 2 && e.plan.location === 'native'
    ? { ...action.execution.session!.limits, inputBytes: action.execution.limits.inputBytes, outputBytes: action.execution.limits.outputBytes }
    : e.limits;
  verifyPlannedExecution(activity, { key: instance.key, definitionDigest: instance.definitionDigest,
    operationId: e.operation.operationId, location: e.plan.location, target, budgets });
  if (action.protocolVersion === 3) { verifyRuntimeBasis(activity, binding, action); return; }
  if (m.formatVersion !== 1) return fail('invalid');
  const originalPlan = { planId: e.plan.planId, planVersion: e.plan.planVersion,
    componentId: m.componentId, componentVersion: m.version, operationId: e.operation.operationId };
  if (e.plan.planDigest !== hash(originalPlan)) fail('invalid');
  if (e.plan.location === 'native') {
    const declared = m.session, session = action.execution.session;
    if (!declared || !session || session.adapterId !== declared.adapterId || session.adapterVersion !== declared.adapterVersion
      || declared.operation.operationId !== e.operation.operationId || !acceptsState(declared.parameters, e.parameters)
      || e.plan.planId !== 'native-session' || e.plan.planVersion !== 1 || action.execution.basis.resources.length) fail('invalid');
    if (Object.entries(session!.limits).some(([key, value]) => value > declared!.budgets[key as keyof typeof session.limits])
      || action.execution.limits.timeMs > session!.limits.operationTimeoutMs
      || action.execution.limits.inputBytes > declared!.budgets.inputBytes || action.execution.limits.outputBytes > declared!.budgets.outputBytes
      || action.execution.limits.concurrentJobs > session!.limits.concurrentSessions || action.execution.limits.queuedJobs > session!.limits.queuedSessions) fail('invalid');
  } else {
    const op = m.operations?.find(item => item.operationId === e.operation.operationId);
    if (!op || !m.algorithm || op.effect !== e.operation.effect || !acceptsState(op.parameters, e.parameters)
      || action.execution.limits.timeMs > op.budgets.timeMs || action.execution.limits.outputBytes > op.budgets.outputBytes
      || action.execution.limits.memoryPages > m.algorithm.memoryPages) fail('invalid');
    const resources = action.execution.basis.resources;
    if (resources.length !== 2 || !same(resources.find(r => r.kind === 'entry'), { kind: 'entry', ...m.entry })
      || !same(resources.find(r => r.kind === 'algorithm'), { kind: 'algorithm', ...m.algorithm!.resource })) fail('invalid');
  }
  const state = action.execution.basis.state;
  if ((state?.contentId ?? null) !== action.execution.basis.expected.stateContentId) fail('invalid');
  if (state) {
    const file = action.execution.basis.works.find(file => file.contentId === state.contentId);
    if (!file || file.name !== state.name || file.kind !== 'state' || file.encoding !== 'json') fail('invalid');
    let value: unknown;
    try { value = JSON.parse(file!.value); } catch { return fail('invalid'); }
    if (hash(value) !== state.sha256 || !matchesComponentState(binding, activity.activityId, file!)) fail('invalid');
  }
}
function assertQuery(record: Pick<ExecutionRecord, 'requestId' | 'inputDigest' | 'executionRef' | 'actionText' | 'reception'>, query: ExecutionQuery) {
  const action = command(record.actionText);
  if (query.requestId !== record.requestId || query.inputDigest !== record.inputDigest || query.executionRef !== record.executionRef
    || !same(query.scope, action.scope)) fail('identity-conflict');
  const reception = record.reception;
  if (reception.kind === 'browser') {
    const acceptance = reception.acceptance;
    if (action.execution.plan.location !== 'browser' || query.session != null || acceptance.receipt.state !== 'accepted'
      || acceptance.receipt.requestId !== record.requestId || acceptance.receipt.inputDigest !== record.inputDigest
      || !same(acceptance.receipt.receiver, action.receiver) || acceptance.execution?.executionRef !== record.executionRef
      || query.confirmedSeq < acceptance.execution.acceptedSeq) fail('identity-conflict');
  } else {
    if (action.protocolVersion !== 2 || action.execution.plan.location !== 'native' || !query.session
      || reception.requestId !== record.requestId || reception.inputDigest !== record.inputDigest || reception.executionRef !== record.executionRef
      || !same(reception.scope, action.scope) || !same(reception.receiver, action.receiver)
      || reception.receivedSeq > query.confirmedSeq
      || !same(reception.session, executionRecordSessionIdentitySchema.parse(query.session))
      || reception.session.instanceId !== action.execution.instance.instanceId || reception.session.instanceKey !== action.execution.instance.key
      || reception.session.adapterId !== action.execution.session?.adapterId || reception.session.adapterVersion !== action.execution.session?.adapterVersion) fail('identity-conflict');
    const session = query.session;
    if (session.appliedSeq > query.confirmedSeq || session.observations.some(item => item.seq > session.appliedSeq)
      || new Set(session.observations.map(item => item.seq)).size !== session.observations.length
      || new Set(session.observations.map(item => item.controlId)).size !== session.observations.length) fail('invalid');
    const last = session.observations.find(item => item.seq === session.appliedSeq);
    if (last && (last.controlId !== session.lastControlId || !same(last.state, session.observation))) fail('invalid');
  }
}
function verifyObservations(activity: LearningActivity, action: AnyExecutionAction, query: ExecutionQuery) {
  if (!query.session) return;
  const manifest = activity.course?.components?.find(binding => binding.key === action.execution.instance.key)?.definition.manifest;
  if (!manifest || manifest.formatVersion !== 1 || !manifest.session) fail('invalid');
  const shape = manifest.session.operation.result;
  if (query.session.observation !== null && !acceptsState(shape, query.session.observation)
    || query.session.observations.some(observation => !acceptsState(shape, observation.state))) fail('invalid');
}
function mergeQuery(current: ExecutionQuery, next: ExecutionQuery): ExecutionQuery {
  if (next.confirmedSeq < current.confirmedSeq) return current;
  if (current.output && next.output && !same(current.output, next.output)) fail('identity-conflict');
  const terminal = current.statusKnowledge === 'confirmed' && isTerminalExecutionState(current.state);
  if (terminal && next.statusKnowledge === 'confirmed' && isTerminalExecutionState(next.state) && next.state !== current.state) fail('identity-conflict');
  if (terminal && (next.state !== current.state || next.statusKnowledge !== 'confirmed')) return current;
  if (next.confirmedSeq === current.confirmedSeq && (next.state !== current.state
    || current.session && next.session && !same(current.session, next.session))) fail('identity-conflict');
  if (current.session && next.session && next.session.appliedSeq < current.session.appliedSeq) fail('identity-conflict');
  // Unknown is last-confirmed knowledge, never a new guessed state.
  if (next.statusKnowledge === 'unknown' && next.state !== current.state) fail('invalid');
  return executionQuerySchema.parse({ ...next, stopRequested: current.stopRequested || next.stopRequested, output: next.output ?? current.output });
}
function assertResult(record: ExecutionRecord, value: NonNullable<ExecutionRecord['result']>) {
  if (value.requestId !== record.requestId || value.executionRef !== record.executionRef
    || !same(value.scope, command(record.actionText).scope)) fail('identity-conflict');
  const output = record.query.output;
  if (output && (output.contentId !== value.contentId || !same(output.output, value.output)
    || !same(output.artifact, { name: value.name, mediaType: value.mediaType, sha256: value.sha256, byteLength: value.byteLength }))) fail('identity-conflict');
}
function project(row: Record<string, unknown>, activity: LearningActivity): ExecutionRecord {
  try {
    const record = executionRecordSchema.parse({ version: 1, sourceOwner: row.source_owner, installationId: row.installation_id,
      target: row.target, requestId: row.request_id, inputDigest: row.input_digest, executionRef: row.execution_ref,
      actionText: row.action_text, reception: row.reception, initialQuery: row.initial_query, query: row.query,
      observations: [], result: row.result, createdAt: new Date(row.created_at as string).toISOString() });
    const action = command(record.actionText);
    if (row.activity_id !== activity.activityId || row.course_digest !== courseDigest(activity)
      || sha(record.actionText) !== record.inputDigest || action.requestId !== record.requestId) fail('corrupt');
    verifyCommand(activity, action, record.target);
    assertQuery(record, record.initialQuery); assertQuery(record, record.query);
    verifyObservations(activity, action, record.initialQuery); verifyObservations(activity, action, record.query);
    if (record.query.confirmedSeq < record.initialQuery.confirmedSeq) fail('corrupt');
    if (record.result) assertResult(record, record.result);
    return record;
  } catch (error) { if (error instanceof StorageError && error.code === 'forbidden') throw error; return fail('corrupt'); }
}
/** Reader used by references. Its activity must already come from the school's authorized owner.
 * Old installations without migration 28 continue through the existing execution-source path.
 */
export async function readSyncedExecutionRecord(storage: OwnedStorage, activity: LearningActivity, requestId: string) {
  const { rows: [schema] } = await storage.read("SELECT to_regclass(current_schema() || '.execution_records') IS NOT NULL AS present");
  if (schema?.present !== true) return null;
  const { rows: [row] } = await storage.read('SELECT * FROM execution_records WHERE request_id=$1', [z.uuid().parse(requestId)]);
  if (!row) return null;
  return observations(storage, project(row, activity));
}
async function observations(storage: OwnedStorage, record: ExecutionRecord) {
  await verifyRetainedBasis(storage, record);
  const { rows } = await storage.read('SELECT observation FROM execution_record_observations WHERE request_id=$1 ORDER BY seq', [record.requestId]);
  return executionRecordSchema.parse({ ...record, observations: rows.map(row => row.observation) });
}
async function verifyRetainedBasis(storage: OwnedStorage, record: ExecutionRecord) {
  const action = command(record.actionText);
  for (const file of action.execution.basis.works) {
    const { rows: [row] } = await storage.read(`SELECT c.*,o.kind,o.activity_id AS object_activity FROM work_contents c
      JOIN work_objects o USING(object_id) WHERE content_id=$1`, [file.contentId]);
    if (!row || row.activity_id !== action.scope.activityId || row.object_activity !== action.scope.activityId || row.object_id !== file.objectId
      || row.kind !== file.kind || row.encoding !== file.encoding || row.media_type !== file.mediaType) fail('corrupt');
    const reference = await storage.resource(file.contentId), bytes = await storage.readResource(file.contentId);
    if (!same(reference.owner, storage.owner) || reference.scope !== `works/${action.scope.activityId}/${file.objectId}`
      || reference.resourceId !== file.contentId || reference.contentVersion !== 1 || reference.mediaType !== file.mediaType
      || reference.byteLength !== bytes.byteLength || reference.sha256 !== sha(bytes)
      || Buffer.from(bytes).toString(file.encoding === 'base64' ? 'base64' : 'utf8') !== file.value) fail('corrupt');
    const { rows: [pin] } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1',
      [`execution/${record.requestId}/work/${file.contentId}`]);
    if (pin?.resource_id !== file.contentId) fail('corrupt');
  }
}
async function originalResource(storage: OwnedStorage, requestId: string, contentId: string, pin: string,
  metadata: { sha256: string; byteLength: number; mediaType: string }) {
  const ref = await storage.resource(contentId);
  if (!same(ref.owner, storage.owner) || ref.scope !== `execution/${requestId}` || ref.resourceId !== contentId
    || ref.contentVersion !== 1 || ref.sha256 !== metadata.sha256 || ref.byteLength !== metadata.byteLength || ref.mediaType !== metadata.mediaType) fail('corrupt');
  const { rows: [link] } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1', [pin]);
  if (link?.resource_id !== contentId) fail('corrupt');
  const bytes = await storage.readResource(contentId);
  if (sha(bytes) !== metadata.sha256 || bytes.byteLength !== metadata.byteLength) fail('corrupt');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return fail('corrupt'); }
}
/** Always consumes synchronized bytes, never requests the source device. */
export async function readSyncedExecutionArtifact(storage: OwnedStorage, record: ExecutionRecord) {
  const result = record.result;
  if (!result) return null;
  assertResult(record, result);
  if (!record.query.output) return fail('unavailable');
  const prefix = `execution/${record.requestId}`;
  const text = await originalResource(storage, record.requestId, result.contentId, `${prefix}/result`, result);
  const resources = [];
  for (const ref of result.resources ?? []) resources.push({ ...ref,
    text: await originalResource(storage, record.requestId, ref.contentId, `${prefix}/resource/${ref.contentId}`, ref) });
  const { contentId: _contentId, ...metadata } = result;
  return executionArtifactSchema.parse({ ...metadata, text, ...(resources.length ? { resources } : {}) });
}

export function createExecutionRecords(storage: OwnedStorage, options: {
  activity(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
  works: Pick<ReturnType<typeof createWorks>, 'registerBasis'>;
}) {
  async function activity(identity: SpaceIdentity, activityId: string) {
    const value = activitySchema.parse(await options.activity(identity, z.uuid().parse(activityId)));
    if (value.activityId !== activityId || !same(scopeOf(value), { environmentId: identity.environmentId,
      spaceId: identity.spaceId, principalId: identity.principalId, activityId }) || !same(value.target, { ...storage.owner, version: 1 })) fail('forbidden');
    return value;
  }
  async function read(identity: SpaceIdentity, activityId: string, requestId: string) {
    return readSyncedExecutionRecord(storage, await activity(identity, activityId), requestId);
  }
  async function sync(identity: SpaceIdentity, activityId: string, value: unknown, trusted: TrustedExecutionSource): Promise<ExecutionRecord> {
    const currentActivity = await activity(identity, activityId), event = executionRecordEventSchema.parse(value);
    const sourceOwner = storageOwnerSchema.parse(trusted.sourceOwner), installationId = z.uuid().parse(trusted.installationId);
    if (trusted.role !== 'tool-execution' || !same(sourceOwner, event.sourceOwner) || installationId !== event.installationId
      || same(sourceOwner, storage.owner)) fail('forbidden');
    await trusted.assertAuthorized?.();
    let existing = await readSyncedExecutionRecord(storage, currentActivity, event.requestId);
    if (!existing && event.kind !== 'command') return fail('missing');
    const target = command(event.kind === 'command' ? event.actionText : existing!.actionText).execution.plan.location === 'browser'
      ? 'student-browser' : trusted.nodeClass === 'school-execution-node' ? 'school-runtime' : 'student-runtime';
    if (target === 'student-browser' && trusted.nodeClass === 'school-execution-node') fail('forbidden');
    if (existing && (!same(existing.sourceOwner, sourceOwner) || existing.installationId !== installationId
      || existing.inputDigest !== event.inputDigest || existing.executionRef !== event.executionRef || existing.target !== target)) fail('identity-conflict');
    if (event.kind === 'command') {
      const action = command(event.actionText);
      if (sha(event.actionText) !== event.inputDigest || action.requestId !== event.requestId) fail('identity-conflict');
      verifyCommand(currentActivity, action, target);
      const candidate: ExecutionRecord = { version: 1, sourceOwner, installationId, target,
        requestId: event.requestId, inputDigest: event.inputDigest, executionRef: event.executionRef,
        actionText: event.actionText, reception: event.reception, initialQuery: event.query, query: event.query,
        observations: event.query.session?.observations ?? [], result: null, createdAt: event.createdAt };
      assertQuery(candidate, event.query);
      verifyObservations(currentActivity, action, event.query);
      if (existing && (!same(existing.reception, event.reception) || existing.actionText !== event.actionText
        || !same(existing.initialQuery, event.query) || existing.createdAt !== event.createdAt || existing.target !== target)) fail('identity-conflict');
      if (!existing) {
        // Register immutable source bytes at the data owner, never activate a workspace head.
        for (const file of action.execution.basis.works) await options.works.registerBasis(identity, activityId, file);
        if (action.protocolVersion === 3) {
          const enabled = action.execution.basis.enabledBy;
          const original = enabled ? await readSyncedExecutionRecord(storage, currentActivity, enabled.requestId) : null;
          verifyEnabledRuntimeSource(action, original ? command(original.actionText) : undefined, original?.query);
          if (enabled && !original?.result) fail('unavailable');
          for (const prior of aluCaseFromAction(action)?.draft.priorSources ?? []) {
            const original = await readSyncedExecutionRecord(storage, currentActivity, prior.requestId);
            verifyAluCasePriorSource(action, prior, original ? command(original.actionText) : undefined, original?.query);
          }
        }
      }
      existing ??= candidate;
    } else if (!existing) return fail('missing');
    const fixed = existing;
    if (event.kind === 'status') {
      assertQuery(fixed, event.query); verifyObservations(currentActivity, command(fixed.actionText), event.query);
    }
    let resultMetadata: ExecutionRecord['result'] = null;
    if (event.kind === 'result') {
      const result = event.result;
      const { text: _text, resources: extra, ...metadata } = result;
      resultMetadata = { ...metadata, ...(extra ? { resources: extra.map(({ text: _text, ...ref }) => ref) } : {}) };
      assertResult(fixed, resultMetadata);
      if (fixed.result && !same(fixed.result, resultMetadata)) fail('identity-conflict');
      const action = command(fixed.actionText), resources = [{ ...result, text: result.text }, ...(extra ?? [])];
      if (new Set(resources.map(item => item.contentId)).size !== resources.length) fail('invalid');
      const budget = action.protocolVersion === 3 ? action.execution.limits.resultBytes : action.execution.limits.outputBytes;
      if (resources.reduce((n, item) => n + item.byteLength, 0) > budget) fail('invalid');
      for (const resource of resources) {
        const bytes = Buffer.from(resource.text, 'utf8');
        if (bytes.byteLength !== resource.byteLength || sha(bytes) !== resource.sha256) fail('invalid');
      }
      for (const resource of resources) await storage.stageResource({ uploadId: resource.contentId,
        scope: `execution/${event.requestId}`, bytes: Buffer.from(resource.text, 'utf8'), mediaType: resource.mediaType, contentVersion: 1 });
    }
    await storage.request({ requestId: 'execution-record:' + randomUUID(), fingerprint: hash(event) }, async tx => {
      await trusted.assertAuthorized?.();
      // Serializes first admission as well as updates across independent data-owner handles.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['execution-record:' + event.requestId]);
      const { rows: [row] } = await tx.query('SELECT * FROM execution_records WHERE request_id=$1 FOR UPDATE', [event.requestId]);
      if (!row) {
        if (event.kind !== 'command') return fail('missing');
        await tx.query(`INSERT INTO execution_records VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13)`,
          [event.requestId, activityId, JSON.stringify(sourceOwner), installationId, target, event.actionText, event.inputDigest,
            event.executionRef, JSON.stringify(event.reception), JSON.stringify(event.query), JSON.stringify(event.query),
            courseDigest(currentActivity), event.createdAt]);
        for (const file of command(event.actionText).execution.basis.works)
          await tx.reference(`execution/${event.requestId}/work/${file.contentId}`, file.contentId);
      }
      const saved = row ? project(row, currentActivity) : fixed;
      if (!same(saved.sourceOwner, sourceOwner) || saved.installationId !== installationId || saved.inputDigest !== event.inputDigest
        || saved.executionRef !== event.executionRef) fail('identity-conflict');
      if (event.kind === 'command' && (!same(saved.reception, fixed.reception) || saved.actionText !== fixed.actionText
        || !same(saved.initialQuery, event.query) || saved.createdAt !== event.createdAt || saved.target !== target)) fail('identity-conflict');
      if (event.kind !== 'result') {
        assertQuery(saved, event.query);
        await retainObservations(tx, event.requestId, event.query);
        const next = mergeQuery(saved.query, event.query);
        if (saved.result) assertResult({ ...saved, query: next }, saved.result);
        await tx.query('UPDATE execution_records SET query=$2 WHERE request_id=$1', [event.requestId, JSON.stringify(next)]);
        await tx.query('INSERT INTO execution_record_facts VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [event.requestId, hash(event.query), JSON.stringify(event.query)]);
      } else {
        if (saved.result && !same(saved.result, resultMetadata)) fail('identity-conflict');
        assertResult(saved, resultMetadata!);
        await tx.query('UPDATE execution_records SET result=$2 WHERE request_id=$1', [event.requestId, JSON.stringify(resultMetadata)]);
        await tx.reference(`execution/${event.requestId}/result`, event.result.contentId);
        for (const ref of event.result.resources ?? []) await tx.reference(`execution/${event.requestId}/resource/${ref.contentId}`, ref.contentId);
      }
      return null;
    });
    return (await read(identity, activityId, event.requestId))!;
  }
  async function history(identity: SpaceIdentity, activityId: string, cursor?: string) {
    const current = await activity(identity, activityId);
    if (cursor) z.uuid().parse(cursor);
    const { rows } = await storage.read(`SELECT * FROM execution_records WHERE activity_id=$1
      AND ($2::uuid IS NULL OR request_id>$2::uuid) ORDER BY request_id LIMIT 33`, [activityId, cursor ?? null]);
    return executionRecordPageSchema.parse({ entries: await Promise.all(rows.slice(0, 32).map(row => observations(storage, project(row, current)))),
      nextCursor: rows.length > 32 ? rows[31]!.request_id : null });
  }
  async function artifact(identity: SpaceIdentity, activityId: string, requestId: string) {
    const record = await read(identity, activityId, requestId);
    return record ? readSyncedExecutionArtifact(storage, record) : null;
  }
  return { sync, read, history, artifact };
}
async function retainObservations(tx: OwnedTransaction, requestId: string, query: ExecutionQuery) {
  for (const observation of query.session?.observations ?? []) {
    const { rows: [old] } = await tx.query('SELECT observation FROM execution_record_observations WHERE request_id=$1 AND seq=$2', [requestId, observation.seq]);
    if (old && !same(old.observation, observation)) fail('identity-conflict');
    await tx.query('INSERT INTO execution_record_observations VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [requestId, observation.seq, JSON.stringify(observation)]);
  }
}
export async function validateExecutionRecords(storage: OwnedStorage) {
  const { rows } = await storage.read(`SELECT r.*,a.body AS activity_body,a.space_environment_id,a.space_id,a.principal_id
    FROM execution_records r JOIN activities a ON a.id=r.activity_id`);
  for (const row of rows) {
    const activity = activitySchema.parse(row.activity_body);
    if (activity.identity.environmentId !== row.space_environment_id || activity.identity.spaceId !== row.space_id
      || activity.identity.principalId !== row.principal_id || !same(activity.target, { ...storage.owner, version: 1 })) fail('corrupt');
    const record = project(row, activity);
    await verifyRetainedBasis(storage, record);
    // A result may have arrived before its matching status. Validate its actual bytes and
    // pins without inventing a query.output or making the incomplete evidence citeable.
    if (record.result) {
      const result = record.result, prefix = `execution/${record.requestId}`;
      await originalResource(storage, record.requestId, result.contentId, `${prefix}/result`, result);
      for (const ref of result.resources ?? []) await originalResource(storage, record.requestId, ref.contentId, `${prefix}/resource/${ref.contentId}`, ref);
    }
    const { rows: facts } = await storage.read('SELECT * FROM execution_record_facts WHERE request_id=$1', [record.requestId]);
    for (const fact of facts) {
      const query = executionQuerySchema.parse(fact.query);
      if (hash(query) !== fact.fact_digest) fail('corrupt');
      assertQuery(record, query);
      verifyObservations(activity, command(record.actionText), query);
    }
    if (!facts.some(fact => fact.fact_digest === hash(record.initialQuery))) fail('corrupt');
    const { rows: observations } = await storage.read('SELECT * FROM execution_record_observations WHERE request_id=$1', [record.requestId]);
    for (const row of observations) if (!facts.some(fact => executionQuerySchema.parse(fact.query).session?.observations.some(observation =>
      observation.seq === row.seq && same(observation, row.observation)))) fail('corrupt');
    for (const fact of facts) for (const observation of executionQuerySchema.parse(fact.query).session?.observations ?? [])
      if (!observations.some(row => row.seq === observation.seq && same(row.observation, observation))) fail('corrupt');
  }
}
