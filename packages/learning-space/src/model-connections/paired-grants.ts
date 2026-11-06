import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { modelGrantInputSchema, modelGrantSchema, revokeModelGrantSchema } from '@xunjie/contracts/model-connections';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { deviceRawChoiceSchema, deviceModelChoiceSchema, modelDeviceBindingSchema } from './device-choices.js';
import { grantCreateTaskSchema, grantRevokeTaskSchema, modelDeviceTaskSchema } from './device-tasks.js';
import { modelScopeOf } from './selection.js';
import type { createModelGateway } from './index.js';
import type { PairedLearningOptions } from './paired-learning.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex');
const idFor = (value: unknown) => { const d = hash(value); return `${d.slice(0,8)}-${d.slice(8,12)}-4${d.slice(13,16)}-a${d.slice(17,20)}-${d.slice(20,32)}`; };
const creationSchema = z.object({ binding: modelDeviceBindingSchema, task: grantCreateTaskSchema, choice: deviceRawChoiceSchema.shape.choice }).strict();
const revocationSchema = z.object({ binding: modelDeviceBindingSchema, task: grantRevokeTaskSchema }).strict();
type Options = Pick<PairedLearningOptions, 'authorize' | 'authorizeBinding' | 'assertWritable'> & { timeoutMs: number; pollIntervalMs: number };

/** Root grants are an outbox to the actual credential owner. A durable revoke is a local
 * deny immediately; completion is reported only from that owner's inactive grant fact.
 */
export function createPairedModelGrants(storage: OwnedStorage, models: Awaited<ReturnType<typeof createModelGateway>>, options: Options) {
  const parse = (body: unknown) => creationSchema.safeParse(body).success ? creationSchema.parse(body) : revocationSchema.parse(body);
  async function settle(identity: SpaceIdentity, taskId: string) {
    await storage.request({ requestId: 'device-grant-settled:' + taskId, fingerprint: modelScopeOf(identity) }, async tx => {
      for (const table of ['model_device_grant_creations', 'model_device_grant_revocations'])
        await tx.query(`UPDATE ${table} SET settled=true WHERE scope=$1 AND task_id=$2`, [modelScopeOf(identity), taskId]);
      return null;
    });
  }
  async function enqueue(identity: SpaceIdentity, binding?: { grantId: string; installationId: string }) {
    const { rows } = await storage.read(`SELECT body,task_id FROM model_device_grant_creations WHERE scope=$1 AND NOT settled
        AND ($2::text IS NULL OR body->'binding'->>'grantId'=$2 AND body->'binding'->>'installationId'=$3)
      UNION ALL SELECT body,task_id FROM model_device_grant_revocations WHERE scope=$1 AND NOT settled
        AND ($2::text IS NULL OR body->'binding'->>'grantId'=$2 AND body->'binding'->>'installationId'=$3)
      ORDER BY task_id LIMIT 16`, [modelScopeOf(identity), binding?.grantId ?? null, binding?.installationId ?? null]);
    for (const row of rows) {
      const original = parse(row.body), fixed = { grantId: original.binding.grantId, installationId: original.binding.installationId };
      await options.authorizeBinding(identity, original.binding);
      try {
        const record = await models.deviceTasks.read(identity, fixed, original.task.taskId);
        if (record.receipt) await settle(identity, original.task.taskId);
      } catch (error) {
        if (!(error instanceof StorageError) || error.code !== 'missing') throw error;
        await models.deviceTasks.enqueue(identity, fixed, original.task);
      }
    }
  }
  async function authorizeTask(identity: SpaceIdentity, binding: { grantId: string; installationId: string }, taskId: string) {
    await options.authorize(identity); z.uuid().parse(taskId);
    const { rows: [row] } = await storage.read(`SELECT body FROM model_device_grant_creations WHERE scope=$1 AND task_id=$2
      UNION ALL SELECT body FROM model_device_grant_revocations WHERE scope=$1 AND task_id=$2`, [modelScopeOf(identity), taskId]);
    if (!row) throw new StorageError('forbidden');
    const original = parse(row.body);
    if (original.binding.grantId !== binding.grantId || original.binding.installationId !== binding.installationId) throw new StorageError('forbidden');
    await options.authorizeBinding(identity, original.binding);
    const saved = await models.deviceTasks.read(identity, binding, taskId);
    if (hash(saved.task) !== hash(original.task)) throw new StorageError('corrupt');
    return { authorized: true as const };
  }
  async function wait(identity: SpaceIdentity, original: z.infer<typeof creationSchema> | z.infer<typeof revocationSchema>) {
    const binding = { grantId: original.binding.grantId, installationId: original.binding.installationId };
    await options.authorizeBinding(identity, original.binding);
    await models.deviceTasks.enqueue(identity, binding, original.task);
    const until = Date.now() + options.timeoutMs;
    while (true) {
      await options.authorize(identity); await options.authorizeBinding(identity, original.binding);
      const { receipt } = await models.deviceTasks.read(identity, binding, original.task.taskId);
      if (receipt) {
        await settle(identity, original.task.taskId);
        if (!receipt.ok) throw new StorageError(receipt.code);
        const fact = modelGrantSchema.parse(receipt.value);
        if (modelScopeOf(fact.recipient) !== modelScopeOf(identity)) throw new StorageError('identity-conflict');
        if (original.task.operation === 'grant-create' && (original.task.ownerKind === 'self'
          ? modelScopeOf(fact.owner) !== modelScopeOf(identity)
          : fact.owner.kind !== 'personal' || fact.owner.environmentId !== original.binding.owner.environmentId)) throw new StorageError('identity-conflict');
        return fact;
      }
      if (Date.now() >= until) throw new StorageError('unavailable');
      await new Promise(resolve => setTimeout(resolve, options.pollIntervalMs));
    }
  }
  async function create(identity: SpaceIdentity, value: unknown) {
    options.assertWritable(); await options.authorize(identity);
    const input = modelGrantInputSchema.parse(value), scope = modelScopeOf(identity);
    if (input.owner !== 'device' || identity.kind !== 'school') throw new StorageError('forbidden');
    const { rows: [prior] } = await storage.read('SELECT body FROM model_device_grant_creations WHERE scope=$1 AND grant_id=$2', [scope, input.grantId]);
    let original: z.infer<typeof creationSchema>;
    if (prior) {
      original = creationSchema.parse(prior.body);
      if (hash(original.task.input) !== hash(input)) throw new StorageError('identity-conflict');
    } else {
      const { rows: [row] } = await storage.read(`SELECT body FROM model_device_connection_choices WHERE scope=$1 AND connection_id=$2
        AND binding_version=(SELECT max(version) FROM model_member_devices WHERE scope=$1)`, [scope, input.connectionId]);
      if (!row) throw new StorageError('forbidden');
      const raw = deviceRawChoiceSchema.parse(row.body);
      if (!raw.active) throw new StorageError('forbidden');
      await options.authorizeBinding(identity, raw.binding);
      original = creationSchema.parse({ binding: raw.binding, choice: raw.choice,
        task: { taskId: idFor(['device-grant-create', scope, input.requestId]), operation: 'grant-create', ownerKind: raw.ownerKind, input } });
      const accepted = await storage.request({ requestId: 'device-grant-create:' + input.requestId, fingerprint: hash([scope, original]) }, async tx => {
        options.assertWritable();
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-choice-grant:' + input.grantId]);
        if ((await tx.query('SELECT 1 FROM model_use_grants WHERE id=$1', [input.grantId])).rows.length) throw new StorageError('identity-conflict');
        await tx.query('INSERT INTO model_device_grant_creations VALUES($1,$2,$3)', [scope, input.grantId, original]); return original;
      });
      original = creationSchema.parse(accepted.result);
    }
    const fact = await wait(identity, original);
    // Import the confirmed grant before returning to the existing grants -> selection UI flow.
    await storage.request({ requestId: 'device-grant-created:' + original.task.taskId, fingerprint: hash(fact) }, async tx => {
      options.assertWritable();
      const choice = { ...original.choice, origin: 'device', grantId: fact.grantId };
      await tx.query(`INSERT INTO model_device_choices VALUES($1,$2,$3,$4) ON CONFLICT(scope,grant_id,binding_version)
        DO UPDATE SET body=CASE WHEN (model_device_choices.body->'choice'->'connection'->>'version')::integer<=($4::jsonb->'choice'->'connection'->>'version')::integer
          THEN EXCLUDED.body ELSE model_device_choices.body END`, [scope, fact.grantId, original.binding.version, { binding: original.binding, choice, active: fact.active }]);
      return null;
    });
    return fact;
  }
  async function revoke(identity: SpaceIdentity, id: string, value: unknown) {
    options.assertWritable(); await options.authorize(identity); z.uuid().parse(id);
    const input = revokeModelGrantSchema.parse(value), scope = modelScopeOf(identity);
    const { rows: [prior] } = await storage.read('SELECT body FROM model_device_grant_revocations WHERE scope=$1 AND grant_id=$2', [scope, id]);
    let original: z.infer<typeof revocationSchema>;
    if (prior) {
      original = revocationSchema.parse(prior.body);
      if (original.task.input.expectedVersion !== input.expectedVersion) throw new StorageError('conflict');
    } else {
      const { rows: [selected] } = await storage.read('SELECT body FROM model_selections WHERE scope=$1', [scope]);
      const selectedVersion = z.object({ source: z.object({ kind: z.literal('personal'), grantId: z.literal(id) }), device: modelDeviceBindingSchema }).safeParse(selected?.body);
      const { rows: [row] } = await storage.read(`SELECT body FROM model_device_choices WHERE scope=$1 AND grant_id=$2
        AND ($3::integer IS NULL OR binding_version=$3) ORDER BY binding_version DESC LIMIT 1`, [scope, id, selectedVersion.success ? selectedVersion.data.device.version : null]);
      if (!row) throw new StorageError('forbidden');
      const choice = deviceModelChoiceSchema.parse(row.body);
      original = revocationSchema.parse({ binding: choice.binding,
        task: { taskId: idFor(['device-grant-revoke', scope, id]), operation: 'grant-revoke', modelGrantId: id, input } });
      const accepted = await storage.request({ requestId: 'device-grant-revoke:' + input.requestId, fingerprint: hash([scope, id, input]) }, async tx => {
        options.assertWritable();
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-choice-grant:' + id]);
        const { rows: [saved] } = await tx.query('SELECT body FROM model_device_grant_revocations WHERE scope=$1 AND grant_id=$2 FOR UPDATE', [scope, id]);
        if (saved) return saved.body;
        await tx.query('INSERT INTO model_device_grant_revocations VALUES($1,$2,$3)', [scope, id, original]); return original;
      });
      original = revocationSchema.parse(accepted.result);
    }
    return wait(identity, original);
  }
  return { create, revoke, enqueue, authorizeTask };
}

export async function validatePairedModelGrants(storage: OwnedStorage) {
  for (const [table, schema] of [['model_device_grant_creations', creationSchema], ['model_device_grant_revocations', revocationSchema]] as const) {
    const { rows } = await storage.read(`SELECT scope,grant_id,body,task_id,settled FROM ${table}`);
    for (const row of rows) {
      const original = schema.parse(row.body), task = modelDeviceTaskSchema.parse(original.task);
      const id = task.operation === 'grant-create' ? task.input.grantId : task.operation === 'grant-revoke' ? task.modelGrantId : null;
      const { rows: [binding] } = await storage.read('SELECT body FROM model_member_devices WHERE scope=$1 AND version=$2', [row.scope, original.binding.version]);
      if (id !== row.grant_id || !binding || hash(modelDeviceBindingSchema.parse(binding.body)) !== hash(original.binding)) throw new StorageError('corrupt');
      if (row.task_id !== task.taskId) throw new StorageError('corrupt');
      const { rows: [accepted] } = await storage.read('SELECT scope,task,receipt FROM model_device_tasks WHERE id=$1', [task.taskId]);
      if (row.settled && !accepted?.receipt) throw new StorageError('corrupt');
      if (accepted && (accepted.scope !== row.scope || hash(accepted.task) !== hash(task))) throw new StorageError('corrupt');
    }
  }
}
