import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import { spaceIdentitySchema, type SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelAttemptSchema, modelChatInputSchema, modelGrantSchema, revokeModelGrantSchema, modelGrantInputSchema } from '@xunjie/contracts/model-connections';
import { storageOwnerSchema } from '@xunjie/contracts/storage';
import { learningModelRequestSchema, learningModelReplySchema, parseLearningModelResult } from './service.js';
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
const legacyTaskSchema = z.discriminatedUnion('operation', [
  z.object({ ...taskFields, operation: z.literal('receive'), input: modelChatInputSchema }).strict(),
  z.object({ ...taskFields, operation: z.enum(['dispatch', 'read', 'cancel']) }).strict(),
]).refine(task => task.operation !== 'receive' || task.attemptId === task.input.attemptId);
const receiptSchema = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: modelAttemptSchema }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(['forbidden', 'missing', 'conflict', 'unavailable', 'invalid']) }).strict()]);
/** Version 1 learning tasks bind the original Agent, actor and destination installation.
 * recoveryGeneration is the paired model recipient installationId, never a per-task nonce.
 * These facts are immutable under the existing task-id receipt fingerprint.
 */
const learningTaskV1Schema = z.object({ ...taskFields, operation: z.literal('learning'), formatVersion: z.literal(1),
  origin: z.object({ service: storageOwnerSchema, identity: spaceIdentitySchema, runId: z.uuid(),
    attemptId: z.uuid(), recoveryGeneration: z.uuid() }).strict(),
  request: learningModelRequestSchema,
}).strict().superRefine((task, ctx) => {
  if (task.attemptId !== task.origin.attemptId || JSON.stringify(task.origin.identity) !== JSON.stringify(task.request.identity))
    ctx.addIssue({ code: 'custom', message: 'Learning origin mismatch' });
  if (task.request.operation.startsWith('checks.')) {
    const id = task.request.operation === 'checks.receive'
      ? (task.request.args[0] as { attemptId?: string } | undefined)?.attemptId : task.request.args[0];
    if (id !== task.attemptId) ctx.addIssue({ code: 'custom', message: 'Learning attempt mismatch' });
  }
});
export const modelRunAuthoritySchema = z.object({ driverId: z.string().min(1).max(1000), runId: z.uuid(),
  activityId: z.uuid(), generation: z.number().int().positive() }).strict();
export const learningTaskOriginSchema = z.object({ service: storageOwnerSchema, installationId: z.uuid(), grantId: z.uuid(),
  identity: spaceIdentitySchema, recoveryGeneration: z.uuid(), activityId: z.uuid().optional(), authority: modelRunAuthoritySchema.optional() }).strict().refine(
  origin => !origin.activityId || !origin.authority || origin.activityId === origin.authority.activityId, { message: 'Activity authority mismatch' });
/** V2 carries verified Agent installation/authority. Preparation has no synthetic Run or attempt. */
const learningTaskV2Schema = z.object({ taskId: taskIdSchema, attemptId: z.uuid().optional(),
  operation: z.literal('learning'), formatVersion: z.literal(2), origin: learningTaskOriginSchema,
  request: learningModelRequestSchema }).strict().superRefine((task, ctx) => {
    if (JSON.stringify(task.origin.identity) !== JSON.stringify(task.request.identity))
      ctx.addIssue({ code: 'custom', message: 'Learning identity mismatch' });
    if (task.request.operation === 'checks.receive' || task.request.operation === 'checks.dispatch') {
      if (!task.origin.authority || !task.attemptId) ctx.addIssue({ code: 'custom', message: 'Run authority required' });
    }
    if (task.request.operation.startsWith('checks.')) {
      const id = task.request.operation === 'checks.receive'
        ? (task.request.args[0] as { attemptId?: string } | undefined)?.attemptId : task.request.args[0];
      if (task.attemptId !== id) ctx.addIssue({ code: 'custom', message: 'Learning attempt mismatch' });
    } else if (task.attemptId !== undefined) ctx.addIssue({ code: 'custom', message: 'Unexpected attempt association' });
  });
export const grantCreateTaskSchema = z.object({ taskId: z.uuid(), operation: z.literal('grant-create'), ownerKind: z.enum(['self', 'device']), input: modelGrantInputSchema }).strict();
export const grantRevokeTaskSchema = z.object({ taskId: z.uuid(), operation: z.literal('grant-revoke'), modelGrantId: z.uuid(), input: revokeModelGrantSchema }).strict();
export const modelDeviceTaskSchema = z.union([legacyTaskSchema, learningTaskV1Schema, learningTaskV2Schema, grantRevokeTaskSchema, grantCreateTaskSchema]);
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
  if (task.operation === 'learning' && receipt.ok
    && ['checks.receive', 'checks.read', 'checks.dispatch', 'checks.cancel'].includes(task.request.operation)) {
    const fact = modelAttemptSchema.parse(receipt.value);
    if (fact.attemptId !== task.attemptId || fact.purpose !== 'learning') throw new StorageError('conflict');
  }
  if (task.operation === 'learning' && receipt.ok) parseLearningModelResult(task.request.operation, receipt.value);
  return receipt;
}
type DeviceBinding = z.input<typeof bindingSchema>;
const canonicalDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Internal task store. The transport supplies the verified WP01 binding, never the request body. */
export function createModelDeviceTasks(storage: OwnedStorage, authorize: (identity: SpaceIdentity) => Promise<void>, assertWritable: () => void) {
  async function scope(identity: SpaceIdentity, binding: DeviceBinding) {
    await authorize(identity);
    const actor = spaceIdentitySchema.parse(identity);
    if (actor.kind !== 'school') throw new StorageError('forbidden');
    const { grantId, installationId } = bindingSchema.parse(binding);
    return [modelScopeOf(actor), grantId, installationId] as const;
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
      const result = await storage.request({ requestId: `model-device-task:${task.taskId}`, fingerprint: task.operation === 'learning' && task.formatVersion === 2 ? canonicalDigest([target, task]) : digest([target, task]) }, async tx => {
        assertWritable();
        await tx.query('INSERT INTO model_device_tasks(id,scope,grant_id,installation_id,task) VALUES($1,$2,$3,$4,$5)',
          [task.taskId, ...target, task]);
        return task;
      });
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
      const original = await storage.read(`SELECT task FROM model_device_tasks
        WHERE scope=$1 AND grant_id=$2 AND installation_id=$3 AND id=$4`, [...target, id]);
      if (!original.rows[0]) throw new StorageError('missing');
      const task = modelDeviceTaskSchema.parse(original.rows[0].task);
      const receipt = parseReceipt(task, value, target[0]);
      const result = await storage.request({ requestId: `model-device-receipt:${id}`, fingerprint: task.operation === 'learning' && task.formatVersion === 2 ? canonicalDigest([target, receipt]) : digest([target, receipt]) }, async tx => {
        assertWritable();
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
