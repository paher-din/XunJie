import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import { executionActionSchema, executionCheckpointSchema, checkpointResumeSchema, checkpointPageSchema, type ExecutionAction } from '@xunjie/contracts/execution';
import { actionScopeSchema } from '@xunjie/contracts/action-intents';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { NativeObservation } from './native-process.js';

export const sessionRecoveryMigration: Migration = { version: 8, name: 'session-controls-and-checkpoints', sql: `
  ALTER TABLE native_session_operations ADD COLUMN effect text NOT NULL DEFAULT 'input', ADD COLUMN checkpoint_pending jsonb;
  ALTER TABLE native_sessions ADD COLUMN checkpoints jsonb NOT NULL DEFAULT '[]'::jsonb;
  CREATE TABLE native_session_checkpoints(checkpoint_id uuid PRIMARY KEY,
    session_ref uuid NOT NULL REFERENCES native_sessions(session_ref),control_id uuid NOT NULL UNIQUE REFERENCES native_session_operations(control_id),
    content_id uuid NOT NULL,sha256 text NOT NULL,byte_length integer NOT NULL,applied_seq integer NOT NULL,
    envelope jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
` };
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([key, item]) => [key, canonical(item)])) : value;
const bytesOf = (value: unknown) => Buffer.from(JSON.stringify(canonical(value)), 'utf8');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fingerprint = (value: unknown) => sha(bytesOf(value));
const envelopeSchema = z.object({ formatVersion: z.literal(1), sessionRef: z.uuid(), controlId: z.uuid(),
  scope: actionScopeSchema,
  appliedSeq: z.number().int().positive(), executorInstanceId: z.uuid(),
  adapterId: z.string(), adapterVersion: z.number().int().positive(), checkpointVersion: z.number().int().positive(),
  definitionDigest: z.string(), configurationDigest: z.string(), parametersDigest: z.string(),
  environment: z.object({ platform: z.string(), arch: z.string(), node: z.string() }).strict(),
  instanceId: z.string(), state: z.unknown() }).strict();
const environment = () => ({ platform: process.platform, arch: process.arch, node: process.version });
type CheckpointEnvironment = { platform: string; arch: string; node: string };

/** Immutable checkpoint bytes, provenance and retention all belong to the execution owner. */
export function createSessionCheckpoints(storage: OwnedStorage, channel = false) {
  const sessions = channel ? 'channel_session_sources' : 'native_sessions';
  const operations = channel ? 'channel_execution_intents' : 'native_session_operations';
  const registry = channel ? 'channel_session_checkpoints' : 'native_session_checkpoints';
  async function capture(row: Record<string, unknown>, controlId: string, observation: NativeObservation,
    configuration: unknown, checkpointVersion: number, executorEnvironment: CheckpointEnvironment = environment()) {
    const action = executionActionSchema.parse(row.action), session = action.execution.session!;
    const envelope = envelopeSchema.parse({ formatVersion: 1, sessionRef: row.session_ref, controlId,
      scope: action.scope,
      appliedSeq: observation.seq, executorInstanceId: row.executor_instance_id,
      adapterId: session.adapterId, adapterVersion: session.adapterVersion, checkpointVersion,
      definitionDigest: action.execution.instance.definitionDigest, configurationDigest: fingerprint(configuration),
      parametersDigest: fingerprint(action.execution.parameters), environment: executorEnvironment,
      instanceId: action.execution.instance.instanceId, state: observation.checkpoint });
    if (bytesOf(envelope).length > 1048576) throw new StorageError('invalid');
    // Cache the executor's actual response before any blob I/O. A retry never samples a later state.
    await storage.request({ requestId: 'native-checkpoint-capture:' + controlId, fingerprint: fingerprint({ envelope, observation }) }, async tx => {
      await tx.query(`UPDATE ${operations} SET checkpoint_pending=$2 WHERE ${channel ? 'command_id' : 'control_id'}=$1 AND checkpoint_pending IS NULL`,
        [controlId, JSON.stringify({ envelope, observation })]);
      return true;
    });
    return complete(controlId);
  }

  async function complete(controlId: string) {
    const { rows: [operation] } = await storage.read(`SELECT checkpoint_pending FROM ${operations} WHERE ${channel ? 'command_id' : 'control_id'}=$1`, [controlId]);
    if (!operation?.checkpoint_pending) throw new StorageError('missing');
    const pending = operation.checkpoint_pending as { envelope: unknown; observation: NativeObservation };
    const envelope = envelopeSchema.parse(pending.envelope), bytes = bytesOf(envelope), sha256 = sha(bytes);
    // Published facts remain readable even when historical bytes later become unavailable.
    // Restore and maintenance validation still re-read and verify the actual resource.
    const { rows: published } = await storage.read(`SELECT checkpoint_id FROM ${registry} WHERE checkpoint_id=$1`, [controlId]);
    if (published.length) return pending.observation;
    const resource = await storage.stageResource({ uploadId: controlId, scope: `native-checkpoint/${envelope.sessionRef}`,
      bytes, mediaType: 'application/vnd.xunjie.session-checkpoint+json', contentVersion: 1 });
    if (resource.resourceId !== controlId || resource.sha256 !== sha256 || resource.byteLength !== bytes.length
      || sha(await storage.readResource(controlId)) !== sha256) throw new StorageError('corrupt');
    const checkpoint = executionCheckpointSchema.parse({ checkpointId: controlId, sessionRef: envelope.sessionRef,
      sha256, contentId: controlId, appliedSeq: envelope.appliedSeq, byteLength: bytes.length, createdAt: pending.observation.at });
    await storage.request({ requestId: 'native-checkpoint-publish:' + controlId, fingerprint: fingerprint(checkpoint) }, async tx => {
      if (channel) await tx.query('SELECT request_id FROM channel_executions WHERE execution_ref=$1 FOR UPDATE', [envelope.sessionRef]);
      const { rows: [current] } = await tx.query(`SELECT checkpoints FROM ${sessions} WHERE session_ref=$1${channel ? '' : ' FOR UPDATE'}`, [envelope.sessionRef]);
      if (!current) throw new StorageError('missing');
      await tx.query(`INSERT INTO ${registry}(checkpoint_id,session_ref,control_id,content_id,sha256,byte_length,applied_seq,envelope)
        VALUES($1,$2,$1,$1,$3,$4,$5,$6)`, [controlId, envelope.sessionRef, sha256, bytes.length, envelope.appliedSeq, JSON.stringify(envelope)]);
      await tx.reference(`native-checkpoint/${controlId}`, controlId);
      const checkpoints = [...(current.checkpoints as unknown[]), checkpoint].slice(-64);
      await tx.query(channel
        ? `UPDATE channel_executions SET execution=jsonb_set(execution,'{session,checkpoints}',$2::jsonb) WHERE execution_ref=$1`
        : 'UPDATE native_sessions SET checkpoints=$2 WHERE session_ref=$1', [envelope.sessionRef, JSON.stringify(checkpoints)]);
      return checkpoint;
    });
    return pending.observation;
  }

  async function restore(action: ExecutionAction, configuration: unknown, checkpointVersion: number,
    targetEnvironment: CheckpointEnvironment | null = environment()) {
    const resume = checkpointResumeSchema.parse(action.execution.resumeFromCheckpoint);
    const { rows: [row] } = await storage.read(`SELECT c.*,s.action AS original_action FROM ${registry} c
      JOIN ${sessions} s ON s.session_ref=c.session_ref WHERE c.checkpoint_id=$1`, [resume.checkpointId]);
    if (!row) throw new StorageError('missing');
    const original = executionActionSchema.parse(row.original_action);
    if (JSON.stringify(original.scope) !== JSON.stringify(action.scope)) throw new StorageError('forbidden');
    if (row.session_ref !== resume.sessionRef || row.sha256 !== resume.sha256) throw new StorageError('identity-conflict');
    const bytes = await storage.readResource(String(row.content_id));
    if (sha(bytes) !== row.sha256 || bytes.length !== Number(row.byte_length)) throw new StorageError('corrupt');
    const envelope = envelopeSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
    if (fingerprint(envelope) !== fingerprint(row.envelope) || envelope.controlId !== resume.checkpointId
      || envelope.sessionRef !== resume.sessionRef || envelope.appliedSeq !== Number(row.applied_seq)
      || JSON.stringify(envelope.scope) !== JSON.stringify(original.scope)) throw new StorageError('corrupt');
    const { rows: pins } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1', [`native-checkpoint/${resume.checkpointId}`]);
    if (pins.length !== 1 || pins[0]!.resource_id !== row.content_id) throw new StorageError('corrupt');
    const session = action.execution.session!;
    if (envelope.adapterId !== session.adapterId || envelope.adapterVersion !== session.adapterVersion
      || envelope.checkpointVersion !== checkpointVersion || envelope.definitionDigest !== action.execution.instance.definitionDigest
      || envelope.instanceId !== action.execution.instance.instanceId || envelope.configurationDigest !== fingerprint(configuration)
      || envelope.parametersDigest !== fingerprint(action.execution.parameters)
      || targetEnvironment && fingerprint(envelope.environment) !== fingerprint(targetEnvironment))
      throw new StorageError('invalid');
    return { snapshot: envelope.state, contentId: String(row.content_id), environment: envelope.environment };
  }

  async function validate() {
    const { rows } = await storage.read(`SELECT c.*,s.action AS original_action,s.executor_instance_id AS original_executor_instance_id
      FROM ${registry} c JOIN ${sessions} s ON s.session_ref=c.session_ref`);
    for (const row of rows) {
      const envelope = envelopeSchema.parse(row.envelope), bytes = await storage.readResource(String(row.content_id));
      const original = executionActionSchema.parse(row.original_action);
      if (sha(bytes) !== row.sha256 || bytes.length !== Number(row.byte_length) || fingerprint(envelope) !== sha(bytes)
        || envelope.sessionRef !== row.session_ref || envelope.controlId !== row.control_id || row.control_id !== row.checkpoint_id
        || envelope.appliedSeq !== Number(row.applied_seq) || envelope.executorInstanceId !== row.original_executor_instance_id
        || envelope.definitionDigest !== original.execution.instance.definitionDigest || envelope.instanceId !== original.execution.instance.instanceId
        || envelope.adapterId !== original.execution.session?.adapterId || envelope.adapterVersion !== original.execution.session?.adapterVersion
        || JSON.stringify(envelope.scope) !== JSON.stringify(original.scope)
        || envelope.parametersDigest !== fingerprint(original.execution.parameters)) throw new StorageError('corrupt');
      const { rows: pins } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1', [`native-checkpoint/${row.checkpoint_id}`]);
      if (pins.length !== 1 || pins[0]!.resource_id !== row.content_id) throw new StorageError('corrupt');
    }
    const { rows: restored } = await storage.read(`SELECT request_id,action FROM ${sessions}
      WHERE action->'execution'->'resumeFromCheckpoint' IS NOT NULL`);
    for (const row of restored) {
      const action = executionActionSchema.parse(row.action), resume = checkpointResumeSchema.parse(action.execution.resumeFromCheckpoint);
      const { rows: [checkpoint] } = await storage.read(`SELECT c.*,s.action AS original_action FROM ${registry} c
        JOIN ${sessions} s ON s.session_ref=c.session_ref WHERE c.checkpoint_id=$1`, [resume.checkpointId]);
      if (!checkpoint || checkpoint.session_ref !== resume.sessionRef || checkpoint.sha256 !== resume.sha256
        || JSON.stringify(executionActionSchema.parse(checkpoint.original_action).scope) !== JSON.stringify(action.scope)) throw new StorageError('corrupt');
      const { rows: pins } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1', [`native/${row.request_id}/restore`]);
      if (pins.length !== 1 || pins[0]!.resource_id !== checkpoint.content_id) throw new StorageError('corrupt');
    }
  }
  return { capture, complete, restore, validate };
}

/** One owner catalogue spans local and authenticated device sessions, independent of bounded projections. */
export async function readSessionCheckpointPage(storage: OwnedStorage, identity: SpaceIdentity, activityId: string, cursor?: string) {
  const fail = (code: 'forbidden' | 'corrupt'): never => { throw new StorageError(code); };
    if (cursor) z.uuid().parse(cursor);
    const { rows } = await storage.read(`SELECT * FROM (
      SELECT c.checkpoint_id,c.session_ref,c.content_id,c.sha256,c.applied_seq,c.byte_length,c.created_at,
      s.action->'scope' AS scope,s.action->'execution'->'instance'->>'instanceId' AS instance_id,s.request_id FROM native_session_checkpoints c
      JOIN native_sessions s ON s.session_ref=c.session_ref WHERE s.activity_id=$1
      UNION ALL
      SELECT c.checkpoint_id,c.session_ref,c.content_id,c.sha256,c.applied_seq,c.byte_length,c.created_at,
      s.action->'scope',s.action->'execution'->'instance'->>'instanceId',s.request_id FROM channel_session_checkpoints c
      JOIN channel_session_sources s ON s.session_ref=c.session_ref WHERE s.activity_id=$1
      ) checkpoints WHERE ($2::uuid IS NULL OR checkpoint_id>$2::uuid) ORDER BY checkpoint_id LIMIT 65`, [activityId, cursor ?? null]);
    const items = rows.slice(0, 64).map(row => {
      const scope = actionScopeSchema.parse(row.scope);
      if (scope.environmentId !== identity.environmentId || scope.spaceId !== identity.spaceId
        || scope.principalId !== identity.principalId || scope.activityId !== activityId) fail('forbidden');
      if (typeof row.instance_id !== 'string' || !row.instance_id.startsWith(activityId + ':')) fail('corrupt');
      return { checkpointId: row.checkpoint_id, sessionRef: row.session_ref, contentId: row.content_id,
        sha256: row.sha256, appliedSeq: Number(row.applied_seq), byteLength: Number(row.byte_length),
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        requestId: row.request_id, instanceId: row.instance_id, scope };
    });
    return checkpointPageSchema.parse({ items, nextCursor: rows.length > 64 ? items.at(-1)!.checkpointId : null });
}
