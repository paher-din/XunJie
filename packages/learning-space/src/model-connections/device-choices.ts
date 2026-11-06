import { z } from 'zod';
import { storageOwnerSchema } from '@xunjie/contracts/storage';
import { personalModelChoiceSchema } from '@xunjie/contracts/model-connections';

export const modelDeviceIdentitySchema = z.object({ owner: storageOwnerSchema, installationId: z.uuid(), grantId: z.uuid(), connectionId: z.uuid() }).strict();
export const modelDeviceBindingSchema = modelDeviceIdentitySchema.extend({ version: z.number().int().positive() });
export const deviceModelChoiceSchema = z.object({ binding: modelDeviceBindingSchema,
  choice: personalModelChoiceSchema.extend({ grantId: z.uuid() }), active: z.boolean() }).strict();
export const modelDeviceChoicesMigration = { version: 14, name: 'root-owned-device-model-choices', sql: `
  ALTER TABLE model_paired_requests ADD COLUMN ordinal bigint GENERATED ALWAYS AS IDENTITY;
  CREATE TABLE model_device_choice_heads(scope text NOT NULL,binding_version integer NOT NULL,ordinal bigint NOT NULL,PRIMARY KEY(scope,binding_version));
  CREATE TABLE model_device_choices(scope text NOT NULL,grant_id uuid NOT NULL,binding_version integer NOT NULL,body jsonb NOT NULL,
    PRIMARY KEY(scope,grant_id,binding_version));
` };

export const modelDeviceRevocationsMigration = { version: 15, name: 'fixed-owner-device-grant-revocations', sql: `
  CREATE TABLE model_device_connection_choices(scope text NOT NULL,binding_version integer NOT NULL,connection_id uuid NOT NULL,body jsonb NOT NULL,PRIMARY KEY(scope,binding_version,connection_id));
  CREATE TABLE model_device_grant_creations(scope text NOT NULL,grant_id uuid NOT NULL,body jsonb NOT NULL,
    task_id uuid GENERATED ALWAYS AS ((body->'task'->>'taskId')::uuid) STORED,settled boolean NOT NULL DEFAULT false,PRIMARY KEY(scope,grant_id));
  CREATE UNIQUE INDEX model_device_grant_creation_task ON model_device_grant_creations(task_id);
  CREATE INDEX model_device_grant_creation_pending ON model_device_grant_creations(scope,(body->'binding'->>'grantId'),(body->'binding'->>'installationId'),task_id) WHERE NOT settled;
  CREATE TABLE model_device_grant_revocations(scope text NOT NULL,grant_id uuid NOT NULL,body jsonb NOT NULL,
    task_id uuid GENERATED ALWAYS AS ((body->'task'->>'taskId')::uuid) STORED,settled boolean NOT NULL DEFAULT false,PRIMARY KEY(scope,grant_id));
  CREATE UNIQUE INDEX model_device_grant_revocation_task ON model_device_grant_revocations(task_id);
  CREATE INDEX model_device_grant_revocation_pending ON model_device_grant_revocations(scope,(body->'binding'->>'grantId'),(body->'binding'->>'installationId'),task_id) WHERE NOT settled;
  CREATE TABLE model_paired_grants(scope text NOT NULL,kind text NOT NULL CHECK(kind IN ('segment','attempt')),id uuid NOT NULL,
    grant_id uuid NOT NULL,binding_version integer NOT NULL,PRIMARY KEY(scope,kind,id));
  INSERT INTO model_paired_grants
    SELECT scope,'segment',(body->'request'->'args'->0->>'segmentId')::uuid,
      (body->'forwarded'->'args'->1->>'grantId')::uuid,(body->'destination'->'binding'->>'version')::integer
    FROM model_paired_requests WHERE body->'request'->>'operation'='segments.create' AND body->'destination'->>'kind'='device'
      AND body->'forwarded'->'args'->1->>'kind'='personal' ON CONFLICT DO NOTHING;
  INSERT INTO model_paired_grants
    SELECT t.scope,'segment',(t.task->'request'->'args'->0->>'segmentId')::uuid,
      (t.receipt->'value'->'source'->>'grantId')::uuid,(r.body->'destination'->'binding'->>'version')::integer
    FROM model_device_tasks t JOIN model_paired_requests r ON r.id=t.id
    WHERE t.task->>'operation'='learning' AND t.task->'request'->>'operation'='checks.receive'
      AND t.receipt->>'ok'='true' AND t.receipt->'value'->'source'->>'grantId' IS NOT NULL
      AND r.body->'destination'->>'kind'='device' ON CONFLICT DO NOTHING;
  INSERT INTO model_paired_grants
    SELECT r.scope,'attempt',(r.body->'request'->'args'->0->>'attemptId')::uuid,g.grant_id,g.binding_version
    FROM model_paired_requests r JOIN model_paired_grants g ON g.scope=r.scope AND g.kind='segment'
      AND g.id=(r.body->'request'->'args'->0->>'segmentId')::uuid
    WHERE r.body->'request'->>'operation'='checks.receive' ON CONFLICT DO NOTHING;
` };

export const deviceRawChoiceSchema = z.object({ binding: modelDeviceBindingSchema, choice: personalModelChoiceSchema,
  ownerKind: z.enum(['self', 'device']), active: z.boolean() }).strict();
