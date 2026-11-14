import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import { storageOwnerSchema } from '@xunjie/contracts/storage';
import { spaceIdentitySchema, type SpaceIdentity } from '@xunjie/contracts/spaces';
import { agentDispatchPermitSchema } from '@xunjie/contracts/agent-runtime';
import { modelScopeOf } from './selection.js';

export const modelOriginMigration: Migration = { version: 13, name: 'model-owned-origin-journals', sql: `
  CREATE TABLE model_origin_journals(scope text NOT NULL,association_id uuid NOT NULL,body jsonb NOT NULL,
    PRIMARY KEY(scope,association_id));
` };
export const modelOriginAuthorizationMigration: Migration = { version: 17, name: 'same-installation-model-origin-authorizations', sql: `
  CREATE TABLE model_origin_authorizations(scope text NOT NULL,association_id uuid NOT NULL,grant_id uuid NOT NULL,
    PRIMARY KEY(scope,association_id,grant_id),
    FOREIGN KEY(scope,association_id) REFERENCES model_origin_journals(scope,association_id));
  INSERT INTO model_origin_authorizations(scope,association_id,grant_id)
    SELECT scope,association_id,(body->>'grantId')::uuid FROM model_origin_journals WHERE body->>'formatVersion'='2';
` };
export const modelOriginSuccessionMigration: Migration = { version: 18, name: 'model-origin-recovery-authorizations', sql: `
  ALTER TABLE model_origin_authorizations ADD COLUMN installation_id uuid;
  UPDATE model_origin_authorizations a SET installation_id=(j.body->>'installationId')::uuid
    FROM model_origin_journals j WHERE a.scope=j.scope AND a.association_id=j.association_id;
  ALTER TABLE model_origin_authorizations ALTER COLUMN installation_id SET NOT NULL;
  ALTER TABLE model_origin_authorizations ADD COLUMN succession jsonb;
  ALTER TABLE model_origin_authorizations ADD COLUMN recipient_generation uuid;
  UPDATE model_origin_authorizations a SET recipient_generation=(j.body->>'recoveryGeneration')::uuid
    FROM model_origin_journals j WHERE a.scope=j.scope AND a.association_id=j.association_id;
  ALTER TABLE model_origin_authorizations ALTER COLUMN recipient_generation SET NOT NULL;
  ALTER TABLE model_origin_authorizations ADD COLUMN recipient_proof jsonb;
  ALTER TABLE model_origin_authorizations DROP CONSTRAINT model_origin_authorizations_pkey;
  ALTER TABLE model_origin_authorizations ADD PRIMARY KEY(scope,association_id,installation_id,grant_id,recipient_generation);
` };
// Evidence is admitted only from the authenticated host permit, never from an Agent request.
export const modelOriginSuccessionSchema = z.object({ formatVersion: z.literal(1), backupId: z.uuid(),
  sourceEnvironmentId: z.uuid(), sourceServiceId: z.uuid(), sourceInstallationId: z.uuid(), targetInstallationId: z.uuid() }).strict();
export const modelOriginRecoveryOperationSchema = z.enum(['checks.read', 'checks.progress', 'checks.summary', 'checks.requestPayload', 'checks.cancel']);
type RecoveryOperation = z.infer<typeof modelOriginRecoveryOperationSchema>;
const successionSchema = z.array(modelOriginSuccessionSchema).min(1).max(64);
const recipientSchema = z.object({ formatVersion: z.literal(1), backupId: z.uuid(), modelOwner: storageOwnerSchema,
  sourceInstallationId: z.uuid(), targetInstallationId: z.uuid() }).strict();
const recoverySchema = z.object({ operation: modelOriginRecoveryOperationSchema, successions: successionSchema.optional(),
  recipient: recipientSchema.optional() }).strict().refine(value => !!value.successions || !!value.recipient);
export const modelSessionOriginSchema = z.object({ formatVersion: z.literal(3), service: storageOwnerSchema,
  installationId: z.uuid(), grantId: z.uuid(), identity: spaceIdentitySchema, recoveryGeneration: z.uuid(),
  sessionId: z.uuid(), attemptId: z.uuid().optional(), runId: z.uuid().optional(), stepId: z.uuid().optional(),
  operationId: z.uuid().optional(), authority: agentDispatchPermitSchema.optional(),
}).strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex');
function normalize(value: unknown) {
  const parsed = modelSessionOriginSchema.parse(value);
  const { authority, ...fixed } = parsed;
  if (authority && (authority.sessionId !== fixed.sessionId || fixed.runId && fixed.runId !== authority.runId
    || fixed.stepId && fixed.stepId !== authority.stepId || fixed.operationId && fixed.operationId !== authority.operationId))
    throw new StorageError('identity-conflict');
  // A segment belongs to a session and can serve subsequent runs. An attempt fixes one effect.
  return authority && fixed.attemptId ? { ...fixed, runId: authority.runId, stepId: authority.stepId, operationId: authority.operationId } : fixed;
}
function compatible(saved: ReturnType<typeof normalize>, incoming: ReturnType<typeof normalize>) {
  for (const key of ['formatVersion', 'service', 'identity'] as const)
    if (hash(saved[key] ?? null) !== hash(incoming[key] ?? null)) throw new StorageError('identity-conflict');
  for (const key of ['attemptId', 'runId'] as const)
    if (saved[key] !== undefined && incoming[key] !== undefined && saved[key] !== incoming[key]) throw new StorageError('identity-conflict');
  if (saved.sessionId !== incoming.sessionId) throw new StorageError('identity-conflict');
  for (const key of ['runId', 'stepId', 'operationId'] as const)
    if (saved[key] !== undefined && saved[key] !== incoming[key]) throw new StorageError('identity-conflict');
}
function succession(saved: ReturnType<typeof normalize>, installationId: string, value: unknown) {
  const facts = successionSchema.parse(value);
  let current = saved.installationId;
  const seen = new Set([current]);
  for (const fact of facts) {
    if (fact.sourceEnvironmentId !== saved.service.environmentId || fact.sourceServiceId !== saved.service.serviceId
      || fact.sourceInstallationId !== current || seen.has(fact.targetInstallationId)) throw new StorageError('identity-conflict');
    current = fact.targetInstallationId; seen.add(current);
  }
  if (current !== installationId || saved.installationId === installationId) throw new StorageError('identity-conflict');
  return facts;
}
function recipient(owner: OwnedStorage['owner'], generation: string, value: unknown) {
  const proof = recipientSchema.parse(value);
  if (hash(proof.modelOwner) !== hash(owner) || proof.targetInstallationId !== generation
    || proof.sourceInstallationId === proof.targetInstallationId) throw new StorageError('identity-conflict');
  // A formally restored snapshot can contain journals from earlier recipient generations.
  // The trusted runtime proves takeover of this entire logical owner, not just one journal hop.
  return proof;
}
/** Trusted Node boundary: no bodies or dispatch capability. assert remains usable after revocation.
 * Only bind admits a new credential, after the host has verified its CURRENT scope and task permit.
 * The original owner/installation never changes. The host's fenced recovery chain grants only
 * original-attempt reads and cancellation, never receive/dispatch or a new model effect.
 */
export function createModelOrigins(storage: OwnedStorage, authorize: (identity: SpaceIdentity) => Promise<void>, assertWritable: () => void) {
  async function read(identity: SpaceIdentity, associationId: string) {
    spaceIdentitySchema.parse(identity); z.uuid().parse(associationId);
    const { rows: [row] } = await storage.read('SELECT body FROM model_origin_journals WHERE scope=$1 AND association_id=$2', [modelScopeOf(identity), associationId]);
    if (!row) throw new StorageError('missing');
    return normalize(row.body);
  }
  function input(identity: SpaceIdentity, associationId: string, value: unknown) {
    const incoming = normalize(value);
    if (hash(incoming.identity) !== hash(spaceIdentitySchema.parse(identity)) || incoming.attemptId && incoming.attemptId !== associationId)
      throw new StorageError('identity-conflict');
    return incoming;
  }
  async function assert(identity: SpaceIdentity, associationId: string, value: unknown, operation?: RecoveryOperation): Promise<void> {
    const saved = await read(identity, associationId), incoming = input(identity, associationId, value);
    compatible(saved, incoming);
    const successor = saved.installationId !== incoming.installationId;
    const recoveredRecipient = saved.recoveryGeneration !== incoming.recoveryGeneration;
    if ((successor || recoveredRecipient) && (!modelOriginRecoveryOperationSchema.safeParse(operation).success || !saved.attemptId
      || incoming.attemptId !== saved.attemptId)) throw new StorageError('identity-conflict');
    if (!successor && !recoveredRecipient && saved.grantId === incoming.grantId) return;
    const { rows } = await storage.read(`SELECT grant_id FROM model_origin_authorizations
      WHERE scope=$1 AND association_id=$2 AND grant_id=$3 AND installation_id=$4 AND recipient_generation=$5`,
      [modelScopeOf(identity), associationId, incoming.grantId, incoming.installationId, incoming.recoveryGeneration]);
    if (!rows.length) throw new StorageError('identity-conflict');
  }
  return {
    async bind(identity: SpaceIdentity, associationId: string, value: unknown, recovery?: z.infer<typeof recoverySchema>): Promise<void> {
      assertWritable(); await authorize(identity); z.uuid().parse(associationId);
      const incoming = input(identity, associationId, value), scope = modelScopeOf(identity);
      const proof = recovery === undefined ? undefined : recoverySchema.parse(recovery);
      await storage.request({ requestId: 'model-origin:' + hash([scope, associationId, incoming, proof ?? null]), fingerprint: hash([incoming, proof ?? null]) }, async tx => {
        assertWritable();
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-origin:' + scope + ':' + associationId]);
        const { rows: [row] } = await tx.query('SELECT body FROM model_origin_journals WHERE scope=$1 AND association_id=$2 FOR UPDATE', [scope, associationId]);
        const saved = row ? normalize(row.body) : incoming;
        compatible(saved, incoming);
        const successor = saved.installationId !== incoming.installationId;
        const recoveredRecipient = saved.recoveryGeneration !== incoming.recoveryGeneration;
        if ((successor || recoveredRecipient) && (!proof || !saved.attemptId || incoming.attemptId !== saved.attemptId))
          throw new StorageError('identity-conflict');
        if (proof?.recipient && (!row || !recoveredRecipient)) throw new StorageError('identity-conflict');
        if (successor && !proof?.successions || recoveredRecipient && !proof?.recipient) throw new StorageError('identity-conflict');
        const evidence = successor ? succession(saved, incoming.installationId!, proof!.successions) : null;
        const recipientEvidence = recoveredRecipient ? recipient(storage.owner, incoming.recoveryGeneration, proof!.recipient) : null;
        // Preserve the first credential as provenance; current authorization is separate evidence.
        await tx.query(`INSERT INTO model_origin_journals VALUES($1,$2,$3)
          ON CONFLICT(scope,association_id) DO UPDATE SET body=EXCLUDED.body`, [scope, associationId,
          { ...incoming, ...saved }]);
        await tx.query(`INSERT INTO model_origin_authorizations(scope,association_id,grant_id,installation_id,succession,recipient_generation,recipient_proof)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [scope, associationId, incoming.grantId, incoming.installationId,
          evidence ? JSON.stringify(evidence) : null, incoming.recoveryGeneration, recipientEvidence ? JSON.stringify(recipientEvidence) : null]);
        return null;
      });
      await assert(identity, associationId, incoming, proof?.operation);
    },
    assert, read,
    validate: () => validateModelOrigins(storage),
  };
}
export async function validateModelOrigins(storage: OwnedStorage) {
  const { rows } = await storage.read('SELECT scope,association_id,body FROM model_origin_journals');
  for (const row of rows) {
    const value = normalize(row.body);
    if (modelScopeOf(value.identity) !== row.scope || value.attemptId && value.attemptId !== row.association_id
      || hash(value) !== hash(row.body)) throw new StorageError('corrupt');
  }
  const { rows: authorizations } = await storage.read(`SELECT a.grant_id,a.installation_id,a.succession,a.recipient_generation,a.recipient_proof,j.body FROM model_origin_authorizations a
    JOIN model_origin_journals j USING(scope,association_id)`);
  for (const row of authorizations) {
    const saved = normalize(row.body);
    if (!z.uuid().safeParse(row.grant_id).success || !z.uuid().safeParse(row.installation_id).success
      || !z.uuid().safeParse(row.recipient_generation).success)
      throw new StorageError('corrupt');
    if (row.installation_id === saved.installationId) {
      if (row.succession !== null) throw new StorageError('corrupt');
    } else {
      try {
        if (!saved.attemptId) throw new StorageError('corrupt');
        succession(saved, String(row.installation_id), row.succession);
      } catch { throw new StorageError('corrupt'); }
    }
    if (row.recipient_generation === saved.recoveryGeneration) {
      if (row.recipient_proof !== null) throw new StorageError('corrupt');
    } else {
      try {
        if (!saved.attemptId) throw new StorageError('corrupt');
        recipient(storage.owner, String(row.recipient_generation), row.recipient_proof);
      } catch { throw new StorageError('corrupt'); }
    }
  }
}
