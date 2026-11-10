import { createHash } from 'node:crypto';
import { componentInstanceId } from '@xunjie/contracts/components';
import { anyExecutionActionSchema, canonicalValue, executionAcceptanceSchema, executionQuerySchema } from '@xunjie/contracts/execution';
import type { AnyExecutionAction, ExecutionAcceptance, ExecutionQuery } from '@xunjie/contracts/execution';
import { activitySchema } from '@xunjie/contracts/learning-data';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { readSyncedExecutionRecord } from './execution-records.js';
import { readStudyExecution } from './study-copies.js';
import type { ExecutionRecord } from '@xunjie/contracts/execution-records';

export interface ExecutionSource {
  action: AnyExecutionAction;
  acceptance: ExecutionAcceptance | null;
  query: ExecutionQuery;
  /** A synchronized source remains owned by its original execution service. */
  record?: ExecutionRecord;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const same = (left: unknown, right: unknown) => JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
const invalid = (): never => { throw new StorageError('invalid'); };
const corrupt = (): never => { throw new StorageError('corrupt'); };

/** The retained activity, including its real principal columns, establishes the component binding. */
export function parseExecutionActivity(row: Record<string, unknown> | undefined, owner: OwnedStorage['owner']): LearningActivity {
  const parsed = activitySchema.safeParse(row?.body);
  if (!row || !parsed.success) return corrupt();
  const activity = parsed.data;
  if (activity.activityId !== row.id || activity.identity.environmentId !== row.space_environment_id
    || activity.identity.spaceId !== row.space_id || activity.identity.principalId !== row.principal_id
    || activity.target.environmentId !== owner.environmentId || activity.target.serviceId !== owner.serviceId) return invalid();
  return activity;
}

/** Shared projection for normal reads and retained-source verification; unknown stays unknown. */
export function executionQueryFromRow(row: Record<string, unknown>, action: AnyExecutionAction): ExecutionQuery {
  return executionQuerySchema.parse({ requestId: row.request_id, inputDigest: row.input_digest, scope: action.scope,
    executionRef: row.execution_ref, state: row.state, statusKnowledge: row.status_knowledge,
    stopRequested: row.stop_requested, confirmedSeq: Number(row.confirmed_seq), reason: row.reason ?? null,
    output: row.output ?? null });
}

/** Pure verification of an original command row against its owner-read activity, also used during maintenance. */
export function parseExecutionSource(row: Record<string, unknown>, activity: LearningActivity): ExecutionSource {
  let source: ExecutionSource;
  try {
    let action = anyExecutionActionSchema.parse(row.body);
    let inputDigest = hash(JSON.stringify(action));
    // Pre-migration rows retain the original schema-projected fallback. New rows preserve the exact
    // received bytes: JSONB alone cannot preserve property order inside unknown parameters.
    if (row.action_text !== null && row.action_text !== undefined) {
      if (typeof row.action_text !== 'string') return corrupt();
      const original: unknown = JSON.parse(row.action_text);
      const fixed = anyExecutionActionSchema.parse(original);
      if (!same(original, action) || !same(fixed, action)) return corrupt();
      inputDigest = hash(row.action_text);
      action = fixed;
    }
    const query = executionQueryFromRow(row, action), acceptance = executionAcceptanceSchema.parse(row.acceptance);
    if (inputDigest !== query.inputDigest || acceptance.receipt.state !== 'accepted' || !acceptance.execution
      || acceptance.receipt.requestId !== query.requestId || acceptance.receipt.inputDigest !== query.inputDigest
      || !same(acceptance.receipt.receiver, action.receiver) || acceptance.execution.executionRef !== query.executionRef
      || acceptance.execution.acceptedSeq > query.confirmedSeq) return corrupt();
    source = { action, acceptance, query };
  } catch (error) {
    if (error instanceof StorageError) throw error;
    return corrupt();
  }
  const { action } = source, scope = action.scope, instance = action.execution.instance;
  const binding = activity.course?.components?.find(item => item.key === instance.key);
  if (!binding || row.activity_id !== activity.activityId || row.request_id !== action.requestId
    || scope.activityId !== activity.activityId || scope.environmentId !== activity.identity.environmentId
    || scope.spaceId !== activity.identity.spaceId || scope.principalId !== activity.identity.principalId) return invalid();
  const manifest = binding.definition.manifest;
  if (instance.instanceId !== componentInstanceId(activity.activityId, binding.key)
    || instance.componentId !== manifest.componentId || instance.componentVersion !== manifest.version
    || instance.stateVersion !== manifest.stateVersion || instance.hostApiVersion !== manifest.hostApiVersion
    || instance.definitionDigest !== binding.definition.digest
    || (action.protocolVersion === 3 ? manifest.formatVersion !== 3 : manifest.formatVersion !== 1)) return invalid();
  return source;
}

/** Read synchronized original facts first, then the legacy owner store. Never contact an executor.
 * Caller identities are constraints, never proof of stored facts.
 */
export async function readExecutionSource(storage: OwnedStorage, activity: LearningActivity,
  reference: { requestId: string; inputDigest?: string; executionRef?: string }): Promise<ExecutionSource> {
  const { rows: [activityRow] } = await storage.read(
    'SELECT id,body,space_environment_id,space_id,principal_id FROM activities WHERE id=$1', [activity.activityId]);
  const saved = parseExecutionActivity(activityRow, storage.owner);
  if (saved.activityId !== activity.activityId || saved.identity.environmentId !== activity.identity.environmentId
    || saved.identity.spaceId !== activity.identity.spaceId || saved.identity.principalId !== activity.identity.principalId) return invalid();
  const record = await readSyncedExecutionRecord(storage, saved, reference.requestId);
  let source: ExecutionSource;
  if (record) source = { action: anyExecutionActionSchema.parse(JSON.parse(record.actionText)), query: record.query,
    acceptance: record.reception.kind === 'browser' ? record.reception.acceptance : null, record };
  else {
    const { rows: [row] } = await storage.read('SELECT * FROM execution_commands WHERE request_id=$1', [reference.requestId]);
    const historical = row ? null : await readStudyExecution(storage, saved, reference.requestId);
    if (!row && !historical) throw new StorageError('unavailable');
    source = parseExecutionSource(row ?? historical!.command, historical?.activity ?? saved);
  }
  if (source.query.requestId !== reference.requestId
    || reference.inputDigest !== undefined && source.query.inputDigest !== reference.inputDigest
    || reference.executionRef !== undefined && source.query.executionRef !== reference.executionRef) return invalid();
  return source;
}
