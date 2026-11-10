import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type OwnedStorage, type OwnedTransaction, type Migration } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelProviderSchema, saveModelProviderSchema, modelReasoningError,
  type ModelConfiguration, type ModelConnection, type SaveModelConnection, type ModelProvider, type ModelProfile, type SaveModelProvider } from '@xunjie/contracts/model-connections';
import { modelScopeOf } from './selection.js';

export const modelProviderMigration: Migration = { version: 20, name: 'model-provider-groups', sql: `
  CREATE TABLE model_providers(scope text NOT NULL,id uuid NOT NULL,body jsonb NOT NULL,PRIMARY KEY(scope,id));
` };
const groupSchema = z.object({ version: z.number().int().positive(), connectionIds: z.array(z.uuid()).min(1).max(64) }).strict();
type Stored = { configuration: ModelConfiguration; version: number; routeId: string; credentialRef: string | null };
const paths = { 'chat-completions': '/chat/completions', responses: '/responses', messages: '/v1/messages' } as const;

export function createModelProviders(storage: OwnedStorage, owner: {
  authorize(identity: SpaceIdentity): Promise<void>;
  assertWritable(): void;
  project(stored: Stored): ModelConnection;
  readCredential(identity: SpaceIdentity, connectionId: string, version: number): Promise<{ value: string }>;
  write(tx: OwnedTransaction, scope: string, input: SaveModelConnection): Promise<ModelConnection>;
  prepare(input: SaveModelProvider): Promise<void>;
  profile(route: Pick<ModelConfiguration, 'protocol' | 'baseUrl' | 'modelId'> & Partial<ModelConfiguration>): ModelProfile;
}) {
  async function list(identity: SpaceIdentity): Promise<ModelProvider[]> {
    await owner.authorize(identity);
    // A single statement observes heads and membership from one PostgreSQL snapshot.
    const { rows } = await storage.read(`SELECT c.id,c.body,p.body AS provider FROM model_connections c
      LEFT JOIN model_providers p ON p.scope=c.scope AND p.id=coalesce((c.body->'configuration'->>'providerId')::uuid,c.id)
      WHERE c.scope=$1 ORDER BY c.id`, [modelScopeOf(identity)]);
    const models = rows.map(row => owner.project(row.body as Stored));
    const groups = new Map(rows.filter(row => row.provider).map(row => {
      const model = (row.body as Stored).configuration;
      return [model.providerId ?? model.connectionId, groupSchema.parse(row.provider)];
    }));
    const members = new Map<string, ModelConnection[]>();
    for (const model of models) {
      const id = model.providerId ?? model.connectionId;
      members.set(id, [...(members.get(id) ?? []), model]);
    }
    return [...members].map(([providerId, children]) => {
      const group = groups.get(providerId);
      if (!group && children.some(model => model.providerId)) throw new StorageError('corrupt');
      if (group) {
        const byId = new Map(children.map(model => [model.connectionId, model]));
        if (byId.size !== group.connectionIds.length || group.connectionIds.some(id => !byId.has(id))) throw new StorageError('corrupt');
        children = group.connectionIds.map(id => byId.get(id)!);
      }
      const first = children[0]!;
      return modelProviderSchema.parse({ providerId, version: group?.version ?? 0, name: first.name, protocol: first.protocol,
        baseUrl: first.baseUrl, enabled: first.providerEnabled ?? true, hasCredential: children.every(model => model.hasCredential), models: children });
    });
  }

  async function save(identity: SpaceIdentity, value: unknown): Promise<ModelProvider> {
    owner.assertWritable(); await owner.authorize(identity);
    const input = saveModelProviderSchema.parse(value), scope = modelScopeOf(identity);
    const fingerprint = createHash('sha256').update(JSON.stringify([scope, input])).digest('hex');
    const prior = await storage.receipt(input.requestId, fingerprint);
    if (prior) return modelProviderSchema.parse(prior.result);
    await owner.prepare(input);
    const receipt = await storage.request({ requestId: input.requestId, fingerprint }, async tx => {
      owner.assertWritable();
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-config:' + scope]);
      const { rows: [row] } = await tx.query('SELECT body FROM model_providers WHERE scope=$1 AND id=$2 FOR UPDATE', [scope, input.providerId]);
      const previous = row ? groupSchema.parse(row.body) : undefined;
      if ((previous?.version ?? 0) !== input.expectedVersion) throw new StorageError('conflict');
      const ids = new Set(input.models.map(model => model.connectionId));
      if (previous?.connectionIds.some(id => !ids.has(id))) throw new StorageError('invalid');
      const { rows } = await tx.query('SELECT id,body FROM model_connections WHERE scope=$1', [scope]);
      const heads = new Map(rows.map(row => [row.id as string, row.body as Stored]));
      const siblings = [...heads.values()].filter(head => (head.configuration.providerId ?? head.configuration.connectionId) === input.providerId);
      if (!previous && siblings.some(head => !ids.has(head.configuration.connectionId))) throw new StorageError('conflict');
      let inheritedKey: string | undefined;
      const sibling = siblings.find(head => head.credentialRef);
      if (input.credential.action === 'keep' && sibling && input.models.some(model => !heads.has(model.connectionId)))
        inheritedKey = (await owner.readCredential(identity, sibling.configuration.connectionId, sibling.version)).value;
      const models: ModelConnection[] = [];
      for (const model of input.models) {
        const old = heads.get(model.connectionId);
        if (old && (old.configuration.providerId ?? old.configuration.connectionId) !== input.providerId) throw new StorageError('conflict');
        let profile = owner.profile({ protocol: input.protocol, baseUrl: input.baseUrl, modelId: model.modelId,
          ...(model.reasoningLevels === undefined ? {} : { reasoningLevels: model.reasoningLevels }) });
        const sameRoute = old && old.configuration.modelId === model.modelId && old.configuration.protocol === input.protocol
          && old.configuration.baseUrl === input.baseUrl;
        // An unavailable catalogue cannot erase metadata fixed by an earlier save.
        if (profile.source === 'unknown' && sameRoute && old.configuration.reasoningLevels !== undefined)
          profile = { ...profile, source: old.configuration.reasoningSource ?? 'unknown', efforts: ['auto', ...old.configuration.reasoningLevels] };
        const levels = profile.efforts.filter(level => level !== 'auto');
        const effort = model.reasoningEffort ?? old?.configuration.reasoningEffort;
        const dialect = effort === undefined && sameRoute ? old.configuration.dialect : profile.dialect;
        if (modelReasoningError({ protocol: input.protocol, baseUrl: input.baseUrl, modelId: model.modelId,
          dialect: profile.dialect, reasoningLevels: levels, ...(effort ? { reasoningEffort: effort } : {}) }, model.maxOutputTokens))
          throw new StorageError('invalid');
        const credential = !old && inheritedKey ? { action: 'replace' as const, value: inheritedKey } : input.credential;
        models.push(await owner.write(tx, scope, {
          requestId: input.requestId, connectionId: model.connectionId, expectedVersion: model.expectedVersion,
          name: input.name, protocol: input.protocol, baseUrl: input.baseUrl, path: paths[input.protocol],
          providerId: input.providerId, providerEnabled: input.enabled, modelEnabled: model.enabled, enabled: input.enabled && model.enabled,
          modelId: model.modelId, dialect, parameterMode: effort && !['auto', 'none'].includes(effort)
            ? 'thinking' : effort === 'none' ? 'plain' : old?.configuration.parameterMode ?? 'plain',
          ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
          reasoningLevels: levels, reasoningSource: profile.source,
          ...(effort === undefined ? {} : { reasoningEffort: effort }), credential,
        }));
      }
      const group = { version: input.expectedVersion + 1, connectionIds: input.models.map(model => model.connectionId) };
      await tx.query(`INSERT INTO model_providers VALUES($1,$2,$3) ON CONFLICT(scope,id) DO UPDATE SET body=EXCLUDED.body`, [scope, input.providerId, group]);
      return modelProviderSchema.parse({ providerId: input.providerId, version: group.version, name: input.name, protocol: input.protocol,
        baseUrl: input.baseUrl, enabled: input.enabled, hasCredential: models.every(model => model.hasCredential), models });
    });
    return modelProviderSchema.parse(receipt.result);
  }

  async function validate() {
    const { rows: orphans } = await storage.read(`SELECT c.id FROM model_connections c LEFT JOIN model_providers p
      ON p.scope=c.scope AND p.id=(c.body->'configuration'->>'providerId')::uuid
      WHERE c.body->'configuration'->>'providerId' IS NOT NULL
      AND (p.id IS NULL OR NOT (p.body->'connectionIds' ? c.id::text)) LIMIT 1`);
    if (orphans.length) throw new StorageError('corrupt');
    const { rows } = await storage.read('SELECT scope,id,body FROM model_providers');
    for (const row of rows) {
      const group = groupSchema.parse(row.body);
      if (new Set(group.connectionIds).size !== group.connectionIds.length) throw new StorageError('corrupt');
      const { rows: members } = await storage.read('SELECT id,body FROM model_connections WHERE scope=$1 AND id=ANY($2::uuid[])', [row.scope, group.connectionIds]);
      if (members.length !== group.connectionIds.length) throw new StorageError('corrupt');
      let shared: string | undefined;
      for (const member of members) {
        const configuration = (member.body as Stored).configuration;
        const key = JSON.stringify([configuration.name, configuration.protocol, configuration.baseUrl, configuration.providerEnabled]);
        if (configuration.providerId !== row.id || configuration.modelEnabled === undefined || configuration.providerEnabled === undefined
          || configuration.enabled !== (configuration.modelEnabled && configuration.providerEnabled) || shared !== undefined && shared !== key)
          throw new StorageError('corrupt');
        shared = key;
      }
    }
  }
  return { list, save, validate };
}
