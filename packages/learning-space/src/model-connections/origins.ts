import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import { storageOwnerSchema } from '@xunjie/contracts/storage';
import { spaceIdentitySchema, type SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelScopeOf } from './selection.js';

export const modelOriginMigration: Migration = { version: 13, name: 'model-owned-origin-journals', sql: `
  CREATE TABLE model_origin_journals(scope text NOT NULL,association_id uuid NOT NULL,body jsonb NOT NULL,
    PRIMARY KEY(scope,association_id));
` };
const schema = z.object({ formatVersion: z.union([z.literal(1), z.literal(2)]), service: storageOwnerSchema,
  installationId: z.uuid().optional(), grantId: z.uuid().optional(), identity: spaceIdentitySchema,
  recoveryGeneration: z.uuid(), attemptId: z.uuid().optional(), runId: z.uuid().optional(), activityId: z.uuid().optional(),
  authority: z.object({ driverId: z.string().min(1).max(1000), generation: z.number().int().positive(),
    runId: z.uuid(), activityId: z.uuid() }).strict().optional(),
}).strict().refine(value => value.formatVersion !== 2 || !!value.installationId && !!value.grantId);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex');
function normalize(value: unknown) {
  const { authority, ...fixed } = schema.parse(value);
  if (authority && (fixed.runId && fixed.runId !== authority.runId || fixed.activityId && fixed.activityId !== authority.activityId))
    throw new StorageError('identity-conflict');
  return authority ? { ...fixed, runId: authority.runId, activityId: authority.activityId } : fixed;
}
function compatible(saved: ReturnType<typeof normalize>, incoming: ReturnType<typeof normalize>) {
  for (const key of ['formatVersion', 'service', 'installationId', 'grantId', 'identity', 'recoveryGeneration'] as const)
    if (hash(saved[key] ?? null) !== hash(incoming[key] ?? null)) throw new StorageError('identity-conflict');
  for (const key of ['attemptId', 'runId', 'activityId'] as const)
    if (saved[key] !== undefined && incoming[key] !== undefined && saved[key] !== incoming[key]) throw new StorageError('identity-conflict');
}
/** Trusted Node boundary: no bodies or dispatch capability. assert remains usable after revocation.
 * Only bind admits facts, after the host has verified the task's original scope and permit.
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
  return {
    async bind(identity: SpaceIdentity, associationId: string, value: unknown): Promise<void> {
      assertWritable(); await authorize(identity); z.uuid().parse(associationId);
      const incoming = input(identity, associationId, value), scope = modelScopeOf(identity);
      await storage.request({ requestId: 'model-origin:' + hash([scope, associationId, incoming]), fingerprint: hash(incoming) }, async tx => {
        assertWritable();
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-origin:' + scope + ':' + associationId]);
        const { rows: [row] } = await tx.query('SELECT body FROM model_origin_journals WHERE scope=$1 AND association_id=$2 FOR UPDATE', [scope, associationId]);
        const saved = row ? normalize(row.body) : incoming;
        compatible(saved, incoming);
        await tx.query(`INSERT INTO model_origin_journals VALUES($1,$2,$3)
          ON CONFLICT(scope,association_id) DO UPDATE SET body=EXCLUDED.body`, [scope, associationId, { ...saved, ...incoming }]);
        return null;
      });
      compatible(await read(identity, associationId), incoming);
    },
    async assert(identity: SpaceIdentity, associationId: string, value: unknown): Promise<void> {
      compatible(await read(identity, associationId), input(identity, associationId, value));
    },
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
}
