import { createHash } from 'node:crypto';
import { StorageError, type OwnedStorage } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelGrantInputSchema, modelGrantSchema, revokeModelGrantSchema, selectModelSchema } from '@xunjie/contracts/model-connections';
import type { ModelAttempt, ModelConnection, ModelCheckPolicy } from '@xunjie/contracts/model-connections';
import type { z } from 'zod';

export const selectionMigrations = [{ version: 5, name: 'explicit-model-use-and-selection', sql: `
  CREATE TABLE model_use_grants(id uuid PRIMARY KEY,owner_scope text NOT NULL,recipient_scope text NOT NULL,body jsonb NOT NULL);
  CREATE INDEX model_grant_recipient ON model_use_grants(recipient_scope);
  CREATE TABLE model_selections(scope text PRIMARY KEY,body jsonb NOT NULL);
` }];
export const modelScopeOf = (identity: SpaceIdentity) => [identity.environmentId, identity.spaceId, identity.principalId].join('.');
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const personalPolicy: ModelCheckPolicy = { checksAllowed: true, maxChecksPerHour: 6, maxOutputTokens: 2048, timeoutMs: 30000 };
type School = { kind: 'school'; connection: ModelConnection; policy: ModelCheckPolicy };
type Personal = { kind: 'personal'; connection: ModelConnection; policy: ModelCheckPolicy; origin: 'self' | 'device' | 'grant'; grantId?: string };
type Source = z.infer<typeof selectModelSchema>['source'];
export function createModelSelections(storage: OwnedStorage, owner: {
  authorize(identity: SpaceIdentity): Promise<void>;
  school(identity: SpaceIdentity): Promise<School | null>;
  connection(scope: string, connectionId: string): Promise<ModelConnection>;
  list(identity: SpaceIdentity): Promise<ModelConnection[]>;
  assertWritable(): void;
}) {
  async function grant(id: string) {
    const { rows: [row] } = await storage.read('SELECT body FROM model_use_grants WHERE id=$1', [id]);
    if (!row) throw new StorageError('forbidden');
    return modelGrantSchema.parse(row.body);
  }
  async function resolve(identity: SpaceIdentity, source?: Source) {
    if (!source || source.kind === 'school') {
      const choice = await owner.school(identity);
      if (!choice || source && choice.connection.connectionId !== source.connectionId) return null;
      return { choice, source: { kind: 'school' as const, ownerScope: 'school:' + identity.environmentId + ':' + identity.spaceId,
        feeSource: 'school:' + identity.environmentId + ':' + identity.spaceId } };
    }
    const authorization = await grant(source.grantId);
    if (modelScopeOf(authorization.recipient) !== modelScopeOf(identity) || authorization.connectionId !== source.connectionId) throw new StorageError('forbidden');
    if (!authorization.active) throw new StorageError('forbidden');
    await owner.authorize(authorization.owner);
    const ownerScope = modelScopeOf(authorization.owner);
    const connection = await owner.connection(ownerScope, authorization.connectionId);
    return { choice: { kind: 'personal' as const, connection, policy: personalPolicy, origin: 'grant' as const, grantId: authorization.grantId },
      source: { kind: 'personal' as const, ownerScope, feeSource: ownerScope, grantId: authorization.grantId, grantVersion: authorization.version } };
  }
  async function current(identity: SpaceIdentity) {
    const { rows: [row] } = await storage.read('SELECT body FROM model_selections WHERE scope=$1', [modelScopeOf(identity)]);
    return row?.body as { version: number; source: Source } | undefined;
  }
  async function read(identity: SpaceIdentity, deviceOwner?: SpaceIdentity) {
    await owner.authorize(identity);
    const saved = await current(identity);
    const options: (School | Personal)[] = [];
    const school = await owner.school(identity); if (school) options.push(school);
    for (const [actor, origin] of [[identity, 'self'], ...(deviceOwner && modelScopeOf(deviceOwner) !== modelScopeOf(identity) ? [[deviceOwner, 'device']] : [])] as [SpaceIdentity, 'self' | 'device'][]) {
      await owner.authorize(actor);
      for (const connection of await owner.list(actor)) options.push({ kind: 'personal', connection, policy: personalPolicy, origin });
    }
    const { rows } = await storage.read('SELECT body FROM model_use_grants WHERE recipient_scope=$1', [modelScopeOf(identity)]);
    for (const row of rows) {
      const item = modelGrantSchema.parse(row.body);
      if (!item.active) continue;
      try { const value = await resolve(identity, { kind: 'personal', grantId: item.grantId, connectionId: item.connectionId }); if (value) options.push(value.choice); }
      catch (error) { if (!(error instanceof StorageError) || !['forbidden', 'missing'].includes(error.code)) throw error; }
    }
    try {
      const resolved = await resolve(identity, saved?.source);
      return { version: saved?.version ?? 0, selected: resolved?.choice ?? null, options };
    } catch (error) {
      if (!(error instanceof StorageError) || !['forbidden', 'missing'].includes(error.code)) throw error;
      return { version: saved?.version ?? 0, selected: null, options, unavailableReason: 'grant-revoked' };
    }
  }
  async function save(identity: SpaceIdentity, value: unknown) {
    owner.assertWritable(); await owner.authorize(identity);
    const input = selectModelSchema.parse(value), scope = modelScopeOf(identity), hash = fingerprint({ scope, input });
    const prior = await storage.receipt('model-selection:' + input.requestId, hash); if (prior) return prior.result;
    const resolved = await resolve(identity, input.source); if (!resolved) throw new StorageError('unavailable');
    const projection = await read(identity);
    return (await storage.request({ requestId: 'model-selection:' + input.requestId, fingerprint: hash }, async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-selection:' + scope]);
      const { rows: [row] } = await tx.query('SELECT body FROM model_selections WHERE scope=$1 FOR UPDATE', [scope]);
      const old = row?.body as { version: number } | undefined;
      if ((old?.version ?? 0) !== input.expectedVersion) throw new StorageError('conflict');
      const saved = { version: input.expectedVersion + 1, source: input.source };
      await tx.query('INSERT INTO model_selections VALUES($1,$2) ON CONFLICT(scope) DO UPDATE SET body=EXCLUDED.body', [scope, saved]);
      return { ...projection, version: saved.version, selected: resolved.choice };
    })).result;
  }
  async function createGrant(identity: SpaceIdentity, grantOwner: SpaceIdentity, value: unknown) {
    owner.assertWritable(); await owner.authorize(identity); await owner.authorize(grantOwner);
    const input = modelGrantInputSchema.parse(value), ownerScope = modelScopeOf(grantOwner), recipientScope = modelScopeOf(identity);
    await owner.connection(ownerScope, input.connectionId);
    const saved = modelGrantSchema.parse({ grantId: input.grantId, connectionId: input.connectionId, owner: grantOwner, recipient: identity, version: 1, active: true });
    return (await storage.request({ requestId: 'model-grant:' + input.requestId, fingerprint: fingerprint({ ownerScope, recipientScope, input }) }, async tx => {
      await tx.query('INSERT INTO model_use_grants VALUES($1,$2,$3,$4)', [input.grantId, ownerScope, recipientScope, saved]); return saved;
    })).result;
  }
  async function revoke(identity: SpaceIdentity, id: string, value: unknown) {
    owner.assertWritable(); await owner.authorize(identity);
    const input = revokeModelGrantSchema.parse(value), authorization = await grant(id), scope = modelScopeOf(identity);
    if (![modelScopeOf(authorization.owner), modelScopeOf(authorization.recipient)].includes(scope)) throw new StorageError('forbidden');
    return (await storage.request({ requestId: 'model-grant-revoke:' + input.requestId, fingerprint: fingerprint({ scope, id, input }) }, async tx => {
      const { rows: [row] } = await tx.query('SELECT body FROM model_use_grants WHERE id=$1 FOR UPDATE', [id]);
      const previous = modelGrantSchema.parse(row!.body);
      if (previous.version !== input.expectedVersion) throw new StorageError('conflict');
      const next = { ...previous, active: false, version: previous.version + 1 };
      await tx.query('UPDATE model_use_grants SET body=$2 WHERE id=$1', [id, next]); return next;
    })).result;
  }
  async function snapshot(identity: SpaceIdentity, expectedVersion: number) {
    await owner.authorize(identity);
    const saved = await current(identity);
    if ((saved?.version ?? 0) !== expectedVersion) throw new StorageError('conflict');
    const result = await resolve(identity, saved?.source);
    if (!result) throw new StorageError('unavailable'); return result;
  }
  async function authorizeAttempt(identity: SpaceIdentity, source: ModelAttempt['source'], connectionId: string) {
    if (!source?.grantId) return;
    const authorization = await grant(source.grantId);
    if (!authorization.active || authorization.connectionId !== connectionId || authorization.version !== source.grantVersion || modelScopeOf(authorization.recipient) !== modelScopeOf(identity)
      || modelScopeOf(authorization.owner) !== source.ownerScope) throw new StorageError('forbidden');
    await owner.authorize(authorization.owner);
  }
  async function validate() {
    const { rows: grants } = await storage.read('SELECT * FROM model_use_grants');
    for (const row of grants) {
      const item = modelGrantSchema.parse(row.body);
      if (item.grantId !== row.id || modelScopeOf(item.owner) !== row.owner_scope || modelScopeOf(item.recipient) !== row.recipient_scope) throw new StorageError('corrupt');
      await owner.connection(modelScopeOf(item.owner), item.connectionId);
    }
    const { rows: selections } = await storage.read('SELECT * FROM model_selections');
    for (const row of selections) {
      const item = selectModelSchema.omit({ requestId: true, expectedVersion: true }).extend({ version: selectModelSchema.shape.expectedVersion }).parse(row.body);
      if (item.source.kind === 'personal') {
        const authorization = await grant(item.source.grantId);
        if (authorization.connectionId !== item.source.connectionId || modelScopeOf(authorization.recipient) !== row.scope) throw new StorageError('corrupt');
      }
    }
  }
  return { read, save, createGrant, revoke, snapshot, authorizeAttempt, validate };
}
