import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import { spaceIdentitySchema, type SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelAttemptSchema, modelChatInputSchema } from '@xunjie/contracts/model-connections';
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
export const modelDeviceTaskSchema = z.discriminatedUnion('operation', [
  z.object({ ...taskFields, operation: z.literal('receive'), input: modelChatInputSchema }).strict(),
  z.object({ ...taskFields, operation: z.enum(['dispatch', 'read', 'cancel']) }).strict(),
]).refine(task => task.operation !== 'receive' || task.attemptId === task.input.attemptId);
const receiptSchema = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: modelAttemptSchema }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(['forbidden', 'missing', 'conflict', 'unavailable', 'invalid']) }).strict()]);
type DeviceBinding = z.input<typeof bindingSchema>;
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
      const result = await storage.request({ requestId: `model-device-task:${task.taskId}`, fingerprint: digest([target, task]) }, async tx => {
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
      const receipt = receiptSchema.parse(value);
      const result = await storage.request({ requestId: `model-device-receipt:${id}`, fingerprint: digest([target, receipt]) }, async tx => {
        assertWritable();
        const { rowCount } = await tx.query(`UPDATE model_device_tasks SET receipt=$5
          WHERE scope=$1 AND grant_id=$2 AND installation_id=$3 AND id=$4 AND receipt IS NULL
            AND ($6::text IS NULL OR task->>'attemptId'=$6)`, [...target, id, receipt, receipt.ok ? receipt.value.attemptId : null]);
        if (!rowCount) throw new StorageError('missing');
        return receipt;
      });
      return receiptSchema.parse(result.result);
    },
    async read(identity: SpaceIdentity, binding: DeviceBinding, taskId: string) {
      const target = await scope(identity, binding);
      const id = taskIdSchema.parse(taskId);
      const { rows: [row] } = await storage.read(`SELECT task,receipt FROM model_device_tasks
        WHERE scope=$1 AND grant_id=$2 AND installation_id=$3 AND id=$4`, [...target, id]);
      if (!row) throw new StorageError('missing');
      return { task: modelDeviceTaskSchema.parse(row.task), receipt: row.receipt === null ? null : receiptSchema.parse(row.receipt) };
    },
    async validate() {
      const { rows } = await storage.read('SELECT id,task,receipt FROM model_device_tasks');
      for (const row of rows) {
        const task = modelDeviceTaskSchema.parse(row.task);
        const receipt = row.receipt === null ? null : receiptSchema.parse(row.receipt);
        if (task.taskId !== row.id || (receipt?.ok && receipt.value.attemptId !== task.attemptId))
          throw new StorageError('corrupt');
      }
    },
  };
}
