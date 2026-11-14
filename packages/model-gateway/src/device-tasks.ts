import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import { spaceIdentitySchema, type SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelAttemptSchema, modelChatInputSchema, modelGrantSchema, revokeModelGrantSchema, modelGrantInputSchema } from '@xunjie/contracts/model-connections';
import { storageOwnerSchema } from '@xunjie/contracts/storage';
import { learningModelRequestSchema, learningModelReplySchema, parseLearningModelResult } from './service.js';
import { agentDispatchPermitSchema } from '@xunjie/contracts/agent-runtime';
import { fixedPermit, fixedSessionRequest, requestWithPermit } from './session-permits.js';
import { modelScopeOf } from './selection.js';

export const modelDeviceTaskMigration: Migration = { version: 10, name: 'paired-model-device-tasks', sql: `
  CREATE TABLE model_device_tasks (
    id uuid PRIMARY KEY, scope text NOT NULL, grant_id uuid NOT NULL, installation_id uuid NOT NULL,
    task jsonb NOT NULL, receipt jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );
  CREATE INDEX model_device_tasks_pending ON model_device_tasks(scope,grant_id,installation_id,created_at,id)
    WHERE receipt IS NULL;
` };

const bindingSchema = z.object({ grantId: z.uuid(), installationId: z.uuid() }).strict();
const taskIdSchema = z.uuid();
const taskFields = { taskId: taskIdSchema, attemptId: z.uuid() };
const diagnosticTaskSchema = z.discriminatedUnion('operation', [
  z.object({ ...taskFields, operation: z.literal('receive'), input: modelChatInputSchema }).strict(),
  z.object({ ...taskFields, operation: z.enum(['dispatch', 'read', 'cancel']) }).strict(),
]).refine(task => task.operation !== 'receive' || task.attemptId === task.input.attemptId);
const receiptSchema = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: modelAttemptSchema }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(['forbidden', 'missing', 'conflict', 'unavailable', 'invalid']) }).strict()]);
/** Configuration refresh has no Agent session or dispatch capability. */
const configurationTaskSchema = z.object({ taskId: taskIdSchema, attemptId: z.never().optional(), operation: z.literal('learning'), formatVersion: z.literal(2),
  origin: z.object({ service: storageOwnerSchema, installationId: z.uuid(), grantId: z.uuid(), identity: spaceIdentitySchema,
    recoveryGeneration: z.uuid() }).strict(),
  request: learningModelRequestSchema.refine(request => request.operation === 'selection.read' && request.args.length === 0,
    { message: 'Configuration tasks can only read model options' }),
}).strict().refine(task => JSON.stringify(task.origin.identity) === JSON.stringify(task.request.identity),
  { message: 'Learning identity mismatch' });
/** Session tasks carry only the host's generation-fenced permit, never an activity/worker lease. */
const learningTaskV3Schema = z.object({ taskId: taskIdSchema, attemptId: z.uuid().optional(),
  operation: z.literal('learning'), formatVersion: z.literal(3),
  origin: z.object({ service: storageOwnerSchema, installationId: z.uuid(), grantId: z.uuid(), identity: spaceIdentitySchema,
    recoveryGeneration: z.uuid(), sessionId: z.uuid(), authority: agentDispatchPermitSchema.optional() }).strict(),
  request: learningModelRequestSchema,
}).strict().superRefine((task, ctx) => {
  const { origin, request } = task;
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (JSON.stringify(origin.identity) !== JSON.stringify(request.identity)) issue('Learning identity mismatch');
  if (origin.authority && origin.sessionId !== origin.authority.sessionId) issue('Session authority mismatch');
  if (request.operation === 'segments.create' && (request.args[0] as { sessionId?: string }).sessionId !== origin.sessionId)
    issue('Segment session mismatch');
  if (request.operation === 'checks.receive' || request.operation === 'checks.dispatch') {
    if (!origin.authority || !task.attemptId) issue('Session dispatch authority required');
    if (request.operation === 'checks.dispatch' && request.args[1] !== undefined
      && canonicalDigest((request.args[1] as { permit?: unknown }).permit) !== canonicalDigest(origin.authority)) issue('Dispatch permit mismatch');
    if (request.operation === 'checks.receive') {
      const authority = (request.args[0] as { authority?: { permit?: unknown } }).authority;
      if (!authority || canonicalDigest(authority.permit) !== canonicalDigest(origin.authority)) issue('Attempt permit mismatch');
    }
  }
  if (request.operation.startsWith('checks.')) {
    const id = request.operation === 'checks.receive' ? (request.args[0] as { attemptId?: string })?.attemptId : request.args[0];
    if (task.attemptId !== id) issue('Learning attempt mismatch');
  } else if (task.attemptId !== undefined) issue('Unexpected attempt association');
});
export const grantCreateTaskSchema = z.object({ taskId: z.uuid(), operation: z.literal('grant-create'), ownerKind: z.enum(['self', 'device']), input: modelGrantInputSchema }).strict();
export const grantRevokeTaskSchema = z.object({ taskId: z.uuid(), operation: z.literal('grant-revoke'), modelGrantId: z.uuid(), input: revokeModelGrantSchema }).strict();
export const modelDeviceTaskSchema = z.union([diagnosticTaskSchema, configurationTaskSchema, learningTaskV3Schema, grantRevokeTaskSchema, grantCreateTaskSchema]);
function parseReceipt(task: z.infer<typeof modelDeviceTaskSchema>, value: unknown, expectedScope?: string) {
  if (task.operation === 'grant-revoke' || task.operation === 'grant-create') {
    const receipt = learningModelReplySchema.parse(value);
    if (receipt.ok) {
      const fact = modelGrantSchema.parse(receipt.value);
      if (expectedScope && modelScopeOf(fact.recipient) !== expectedScope) throw new StorageError('conflict');
      if (task.operation === 'grant-revoke' ? fact.grantId !== task.modelGrantId || fact.active || fact.version <= task.input.expectedVersion
        : fact.grantId !== task.input.grantId || !fact.active || fact.connectionId !== task.input.connectionId) throw new StorageError('conflict');
    }
    return receipt;
  }
  const receipt = task.operation === 'learning' ? learningModelReplySchema.parse(value) : receiptSchema.parse(value);
  if (task.operation !== 'learning' && receipt.ok && modelAttemptSchema.parse(receipt.value).purpose === 'learning')
    throw new StorageError('conflict');
  if (task.operation === 'learning' && receipt.ok
    && ['checks.receive', 'checks.read', 'checks.dispatch', 'checks.cancel'].includes(task.request.operation)) {
    const fact = modelAttemptSchema.parse(receipt.value);
    if (fact.attemptId !== task.attemptId || fact.purpose !== 'learning') throw new StorageError('conflict');
    if (task.formatVersion === 3 && task.origin.authority) {
      if (!fact.authority || canonicalDigest(fixedPermit(fact.authority.permit)) !== canonicalDigest(fixedPermit(task.origin.authority))) throw new StorageError('identity-conflict');
      if (['checks.receive', 'checks.dispatch'].includes(task.request.operation) && ['accepted', 'dispatched'].includes(fact.state)
        && fact.authority.permit.generation < task.origin.authority.generation) throw new StorageError('stale-generation');
    }
  }
  if (task.operation === 'learning' && receipt.ok) parseLearningModelResult(task.request.operation, receipt.value);
  return receipt;
}
type DeviceBinding = z.input<typeof bindingSchema>;
const canonicalDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

type SessionTask = z.infer<typeof learningTaskV3Schema>;
const fixedSessionTask = (task: SessionTask) => ({ ...task, request: fixedSessionRequest(requestWithPermit(task.request, task.origin.authority)),
  origin: { ...task.origin, ...(task.origin.authority ? { authority: fixedPermit(task.origin.authority) } : {}) } });
/** Internal task store. The transport supplies the verified WP01 binding, never the request body. */
export function createModelDeviceTasks(storage: OwnedStorage, authorize: (identity: SpaceIdentity) => Promise<void>, assertWritable: () => void) {
  async function scope(identity: SpaceIdentity, binding: DeviceBinding) {
    await authorize(identity);
    const actor = spaceIdentitySchema.parse(identity);
    if (actor.kind !== 'school') throw new StorageError('forbidden');
    const { grantId, installationId } = bindingSchema.parse(binding);
    return [modelScopeOf(actor), grantId, installationId] as const;
  }
  async function renewTask(target: readonly [string, string, string], task: SessionTask) {
    const { rows: [row] } = await storage.read('SELECT task FROM model_device_tasks WHERE scope=$1 AND grant_id=$2 AND installation_id=$3 AND id=$4', [...target, task.taskId]);
    if (!row) return null;
    const saved = modelDeviceTaskSchema.parse(row.task);
    const fingerprint = canonicalDigest([target, fixedSessionTask(task)]);
    if (saved.operation !== 'learning' || saved.formatVersion !== 3 || canonicalDigest([target, fixedSessionTask(saved)]) !== fingerprint)
      throw new StorageError('identity-conflict');
    if ((task.origin.authority?.generation ?? 0) <= (saved.origin.authority?.generation ?? 0)) return saved;
    await storage.request({ requestId: 'model-device-current-permit:' + task.taskId + ':' + task.origin.authority!.generation,
      fingerprint: canonicalDigest([fingerprint, task.origin.authority]) }, async tx => {
      assertWritable();
      const { rows: [locked] } = await tx.query('SELECT task FROM model_device_tasks WHERE scope=$1 AND grant_id=$2 AND installation_id=$3 AND id=$4 FOR UPDATE', [...target, task.taskId]);
      if (!locked) throw new StorageError('missing');
      const current = modelDeviceTaskSchema.parse(locked.task);
      if (current.operation !== 'learning' || current.formatVersion !== 3 || canonicalDigest([target, fixedSessionTask(current)]) !== fingerprint)
        throw new StorageError('identity-conflict');
      if ((task.origin.authority?.generation ?? 0) <= (current.origin.authority?.generation ?? 0)) return null;
      await tx.query(`UPDATE model_device_tasks SET task=$5,receipt=CASE WHEN $6 THEN NULL ELSE receipt END
        WHERE scope=$1 AND grant_id=$2 AND installation_id=$3 AND id=$4`, [...target, task.taskId, task,
        ['checks.receive', 'checks.dispatch'].includes(task.request.operation)]);
      return null;
    });
    const { rows: [current] } = await storage.read('SELECT task FROM model_device_tasks WHERE scope=$1 AND grant_id=$2 AND installation_id=$3 AND id=$4', [...target, task.taskId]);
    return modelDeviceTaskSchema.parse(current!.task);
  }
  return {
    async enqueue(identity: SpaceIdentity, binding: DeviceBinding, value: z.input<typeof modelDeviceTaskSchema>) {
      assertWritable();
      const target = await scope(identity, binding);
      const task = modelDeviceTaskSchema.parse(value);
      if (task.operation === 'learning') {
        if (modelScopeOf(task.origin.identity) !== target[0]) throw new StorageError('forbidden');
        if (task.origin.recoveryGeneration !== binding.installationId) throw new StorageError('stale-generation');
      }
      if (task.operation === 'learning' && task.formatVersion === 3) {
        const current = await renewTask(target, task); if (current) return current;
      }
      const result = await storage.request({ requestId: `model-device-task:${task.taskId}`, fingerprint: task.operation === 'learning' && task.formatVersion === 3
        ? canonicalDigest([target, fixedSessionTask(task)]) : task.operation === 'learning' && task.formatVersion === 2 ? canonicalDigest([target, task]) : digest([target, task]) }, async tx => {
        assertWritable();
        await tx.query('INSERT INTO model_device_tasks(id,scope,grant_id,installation_id,task) VALUES($1,$2,$3,$4,$5)',
          [task.taskId, ...target, task]);
        return task;
      });
      if (task.operation === 'learning' && task.formatVersion === 3) return (await renewTask(target, task))!;
      return modelDeviceTaskSchema.parse(result.result);
    },
    async pending(identity: SpaceIdentity, binding: DeviceBinding) {
      assertWritable();
      const target = await scope(identity, binding);
      const { rows } = await storage.read(`SELECT task FROM model_device_tasks
        WHERE scope=$1 AND grant_id=$2 AND installation_id=$3 AND receipt IS NULL ORDER BY created_at,id LIMIT 16`, target);
      assertWritable();
      return rows.map(row => modelDeviceTaskSchema.parse(row.task));
    },
    async complete(identity: SpaceIdentity, binding: DeviceBinding, taskId: string, value: unknown) {
      assertWritable();
      const target = await scope(identity, binding);
      const id = taskIdSchema.parse(taskId);
      const original = await storage.read(`SELECT task,receipt FROM model_device_tasks
        WHERE scope=$1 AND grant_id=$2 AND installation_id=$3 AND id=$4`, [...target, id]);
      if (!original.rows[0]) throw new StorageError('missing');
      const task = modelDeviceTaskSchema.parse(original.rows[0].task);
      const receipt = parseReceipt(task, value, target[0]);
      if (task.operation === 'learning' && task.formatVersion === 3 && original.rows[0].receipt !== null) {
        const previous = parseReceipt(task, original.rows[0].receipt, target[0]);
        if (canonicalDigest(previous) !== canonicalDigest(receipt)) throw new StorageError('identity-conflict');
        return previous;
      }
      const result = await storage.request({ requestId: task.operation === 'learning' && task.formatVersion === 3
        ? `model-device-receipt:${id}:${task.origin.authority?.generation ?? 0}` : `model-device-receipt:${id}`, fingerprint: task.operation === 'learning' && task.formatVersion >= 2 ? canonicalDigest([target, receipt]) : digest([target, receipt]) }, async tx => {
        assertWritable();
        if (task.operation === 'learning' && task.formatVersion === 3) {
          const { rows: [locked] } = await tx.query('SELECT task,receipt FROM model_device_tasks WHERE scope=$1 AND grant_id=$2 AND installation_id=$3 AND id=$4 FOR UPDATE', [...target, id]);
          if (!locked) throw new StorageError('missing');
          const current = modelDeviceTaskSchema.parse(locked.task);
          if (current.operation !== 'learning' || current.formatVersion !== 3
            || canonicalDigest(fixedSessionTask(current)) !== canonicalDigest(fixedSessionTask(task))) throw new StorageError('identity-conflict');
          parseReceipt(current, receipt, target[0]);
          if (locked.receipt !== null) {
            const previous = parseReceipt(current, locked.receipt, target[0]);
            if (canonicalDigest(previous) !== canonicalDigest(receipt)) throw new StorageError('identity-conflict');
            return previous;
          }
        }
        const { rowCount } = await tx.query(`UPDATE model_device_tasks SET receipt=$5
          WHERE scope=$1 AND grant_id=$2 AND installation_id=$3 AND id=$4 AND receipt IS NULL
            AND ($6::text IS NULL OR task->>'attemptId'=$6)`, [...target, id, receipt, task.operation !== 'learning' && task.operation !== 'grant-revoke' && task.operation !== 'grant-create' && receipt.ok ? modelAttemptSchema.parse(receipt.value).attemptId : null]);
        if (!rowCount) throw new StorageError('missing');
        return receipt;
      });
      return parseReceipt(task, result.result, target[0]);
    },
    async read(identity: SpaceIdentity, binding: DeviceBinding, taskId: string) {
      const target = await scope(identity, binding);
      const id = taskIdSchema.parse(taskId);
      const { rows: [row] } = await storage.read(`SELECT task,receipt FROM model_device_tasks
        WHERE scope=$1 AND grant_id=$2 AND installation_id=$3 AND id=$4`, [...target, id]);
      if (!row) throw new StorageError('missing');
      const task = modelDeviceTaskSchema.parse(row.task);
      return { task, receipt: row.receipt === null ? null : parseReceipt(task, row.receipt, target[0]) };
    },
    async validate() {
      const { rows } = await storage.read('SELECT id,scope,installation_id,task,receipt FROM model_device_tasks');
      for (const row of rows) {
        const task = modelDeviceTaskSchema.parse(row.task);
        const receipt = row.receipt === null ? null : parseReceipt(task, row.receipt, String(row.scope));
        if (task.operation === 'learning' && (modelScopeOf(task.origin.identity) !== row.scope || task.origin.recoveryGeneration !== row.installation_id)) throw new StorageError('corrupt');
        if (task.taskId !== row.id || (task.operation !== 'learning' && task.operation !== 'grant-create' && task.operation !== 'grant-revoke' && receipt?.ok && modelAttemptSchema.parse(receipt.value).attemptId !== task.attemptId))
          throw new StorageError('corrupt');
      }
    },
  };
}
