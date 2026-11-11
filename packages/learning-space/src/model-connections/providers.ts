import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type OwnedStorage, type OwnedTransaction, type Migration } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelProviderSchema, saveModelProviderSchema, modelReasoningError, resolveModelCapacity, modelPresetIdSchema, modelProtocolSchema,
  type ModelConfiguration, type ModelConnection, type SaveModelConnection, type ModelProvider, type ModelProfile, type SaveModelProvider, type ModelDirectoryEntry } from '@xunjie/contracts/model-connections';
import { modelScopeOf } from './selection.js';

export const modelProviderMigration: Migration = { version: 20, name: 'model-provider-groups', sql: `
  CREATE TABLE model_providers(scope text NOT NULL,id uuid NOT NULL,body jsonb NOT NULL,PRIMARY KEY(scope,id));
` };
const groupSchema = z.object({ version: z.number().int().positive(), connectionIds: z.array(z.uuid()).max(64),
  name: z.string().trim().min(1).max(120).optional(), enabled: z.boolean().optional(),
  credentialConnection: z.object({ connectionId: z.uuid(), version: z.number().int().positive() }).strict().optional(),
  protocol: modelProtocolSchema.optional(), baseUrl: z.url().optional(),
  presetId: modelPresetIdSchema.optional(), variantId: z.string().min(1).max(80).optional() }).strict();
type Stored = { configuration: ModelConfiguration; version: number; routeId: string; credentialRef: string | null; retired?: true };
const paths = { 'chat-completions': '/chat/completions', responses: '/responses', messages: '/v1/messages' } as const;

export function createModelProviders(storage: OwnedStorage, owner: {
  authorize(identity: SpaceIdentity): Promise<void>;
  assertWritable(): void;
  project(stored: Stored): ModelConnection;
  readCredential(identity: SpaceIdentity, connectionId: string, version: number): Promise<{ value: string }>;
  write(tx: OwnedTransaction, scope: string, input: SaveModelConnection, retired?: true): Promise<ModelConnection>;
  prepare(input: SaveModelProvider, identity: SpaceIdentity): Promise<ReadonlyMap<string, ModelDirectoryEntry> | void>;
  profile(route: Pick<ModelConfiguration, 'protocol' | 'baseUrl' | 'modelId'> & Partial<ModelConfiguration>): ModelProfile;
}) {
  function emptyAnchor(providerId: string, group: z.infer<typeof groupSchema>, anchor?: Stored): ModelConnection {
    if (group.connectionIds.length || !group.name || group.enabled === undefined || !group.protocol || !group.baseUrl
      || !group.credentialConnection || !anchor?.retired || anchor.configuration.providerId !== providerId
      || anchor.configuration.connectionId !== group.credentialConnection.connectionId || anchor.version !== group.credentialConnection.version
      || anchor.configuration.enabled || anchor.configuration.modelEnabled !== false) throw new StorageError('corrupt');
    return owner.project(anchor);
  }
  async function list(identity: SpaceIdentity): Promise<ModelProvider[]> {
    await owner.authorize(identity);
    // A single statement observes heads and membership from one PostgreSQL snapshot.
    const { rows } = await storage.read(`SELECT c.id,c.body,p.id AS provider_id,p.body AS provider,a.body AS anchor
      FROM (SELECT * FROM model_connections WHERE scope=$1 AND NOT (body @> '{"retired":true}')) c
      FULL JOIN (SELECT * FROM model_providers WHERE scope=$1) p
        ON p.scope=c.scope AND p.id=coalesce((c.body->'configuration'->>'providerId')::uuid,c.id)
      LEFT JOIN model_connections a ON a.scope=p.scope AND a.id=(p.body->'credentialConnection'->>'connectionId')::uuid
      ORDER BY coalesce(p.id,c.id),c.id`, [modelScopeOf(identity)]);
    const models = rows.filter(row => row.body).map(row => owner.project(row.body as Stored));
    const groups = new Map(rows.filter(row => row.provider).map(row =>
      [row.provider_id as string, { group: groupSchema.parse(row.provider), anchor: row.anchor as Stored | undefined }]));
    const members = new Map<string, ModelConnection[]>();
    for (const id of groups.keys()) members.set(id, []);
    for (const model of models) {
      const id = model.providerId ?? model.connectionId;
      members.set(id, [...(members.get(id) ?? []), model]);
    }
    return [...members].map(([providerId, children]) => {
      const record = groups.get(providerId), group = record?.group;
      if (!group && children.some(model => model.providerId)) throw new StorageError('corrupt');
      if (group) {
        const byId = new Map(children.map(model => [model.connectionId, model]));
        if (byId.size !== group.connectionIds.length || group.connectionIds.some(id => !byId.has(id))) throw new StorageError('corrupt');
        children = group.connectionIds.map(id => byId.get(id)!);
      }
      if (!children.length) {
        const anchor = emptyAnchor(providerId, group!, record?.anchor);
        return modelProviderSchema.parse({ providerId, version: group!.version, name: group!.name, protocol: group!.protocol,
          baseUrl: group!.baseUrl, presetId: group!.presetId, variantId: group!.variantId, enabled: group!.enabled,
          hasCredential: anchor.hasCredential, credentialConnection: group!.credentialConnection, models: [] });
      }
      if (group?.credentialConnection) throw new StorageError('corrupt');
      const first = children[0]!;
      return modelProviderSchema.parse({ providerId, version: group?.version ?? 0, name: group?.name ?? first.name, protocol: group?.protocol ?? first.protocol,
        baseUrl: group?.baseUrl ?? first.baseUrl, ...(group?.presetId ? { presetId: group.presetId } : {}),
        ...(group?.variantId ? { variantId: group.variantId } : {}),
        enabled: group?.enabled ?? first.providerEnabled ?? true, hasCredential: children.every(model => model.hasCredential), models: children });
    });
  }

  async function save(identity: SpaceIdentity, value: unknown): Promise<ModelProvider> {
    owner.assertWritable(); await owner.authorize(identity);
    const input = saveModelProviderSchema.parse(value), scope = modelScopeOf(identity);
    const fingerprint = createHash('sha256').update(JSON.stringify([scope, input])).digest('hex');
    const prior = await storage.receipt(input.requestId, fingerprint);
    if (prior) return modelProviderSchema.parse(prior.result);
    const preparedProfiles = await owner.prepare(input, identity);
    const receipt = await storage.request({ requestId: input.requestId, fingerprint }, async tx => {
      owner.assertWritable();
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-config:' + scope]);
      const { rows: [row] } = await tx.query('SELECT body FROM model_providers WHERE scope=$1 AND id=$2 FOR UPDATE', [scope, input.providerId]);
      const previous = row ? groupSchema.parse(row.body) : undefined;
      if ((previous?.version ?? 0) !== input.expectedVersion) throw new StorageError('conflict');
      const ids = new Set(input.models.map(model => model.connectionId));
      const removed = new Set(input.removedModels?.map(model => model.connectionId));
      const { rows } = await tx.query('SELECT id,body FROM model_connections WHERE scope=$1', [scope]);
      const heads = new Map(rows.map(row => [row.id as string, row.body as Stored]));
      const siblings = [...heads.values()].filter(head => !head.retired && (head.configuration.providerId ?? head.configuration.connectionId) === input.providerId);
      if (!previous && !siblings.length && !input.models.length) throw new StorageError('invalid');
      for (const model of input.removedModels ?? []) {
        const old = heads.get(model.connectionId);
        if (!old || old.retired || (old.configuration.providerId ?? old.configuration.connectionId) !== input.providerId
          || old.version !== model.expectedVersion || previous && !previous.connectionIds.includes(model.connectionId)) throw new StorageError('conflict');
      }
      if (previous?.connectionIds.some(id => !ids.has(id) && !removed.has(id))
        || siblings.some(head => !ids.has(head.configuration.connectionId) && !removed.has(head.configuration.connectionId)))
        throw new StorageError(previous || input.models.length === 0 ? 'invalid' : 'conflict');
      const presetId = input.presetId ?? previous?.presetId;
      const variantId = presetId === 'custom' ? undefined : input.variantId ?? previous?.variantId;
      const origin = { ...(presetId ? { presetId } : {}), ...(variantId ? { variantId } : {}) };
      const parentUnchanged = input.protocol === (previous?.protocol ?? siblings[0]?.configuration.protocol)
        && input.baseUrl === (previous?.baseUrl ?? siblings[0]?.configuration.baseUrl)
        && presetId === previous?.presetId && variantId === previous?.variantId;
      let inheritedKey: string | undefined;
      const anchor = previous?.credentialConnection ? heads.get(previous.credentialConnection.connectionId) : undefined;
      if (previous && !previous.connectionIds.length) emptyAnchor(input.providerId, previous, anchor);
      const sibling = siblings.find(head => head.credentialRef) ?? anchor;
      if (input.credential.action === 'keep' && sibling?.credentialRef && input.models.some(model => !heads.has(model.connectionId) || heads.get(model.connectionId)?.retired))
        inheritedKey = (await owner.readCredential(identity, sibling.configuration.connectionId, sibling.version)).value;
      const models: ModelConnection[] = [];
      for (const model of input.models) {
        const old = heads.get(model.connectionId);
        if (old && (old.configuration.providerId ?? old.configuration.connectionId) !== input.providerId) throw new StorageError('conflict');
        const preserveRoute = old && parentUnchanged && old.configuration.modelId === model.modelId;
        const protocol = model.protocol ?? (preserveRoute ? old.configuration.protocol : input.protocol);
        const baseUrl = model.baseUrl ?? (preserveRoute ? old.configuration.baseUrl : input.baseUrl);
        let profile = owner.profile({ protocol, baseUrl, modelId: model.modelId, ...origin,
          ...(model.reasoningLevels === undefined ? {} : { reasoningLevels: model.reasoningLevels }) });
        const declared = preparedProfiles?.get(model.modelId);
        if (declared) profile = { ...profile,
          ...(declared.contextWindow ? { contextWindow: declared.contextWindow } : {}),
          ...(declared.maxOutputTokens ? { maxOutputTokens: declared.maxOutputTokens } : {}),
          ...(declared.defaultEffort ? { defaultEffort: declared.defaultEffort } : {}),
          ...(declared.reasoningKind ? { reasoningKind: declared.reasoningKind } : {}),
          ...(declared.efforts !== undefined && model.reasoningLevels === undefined ? { efforts: ['auto', ...declared.efforts.filter(level => level !== 'auto')], source: 'catalogue' } : {}),
        };
        const sameRoute = old && old.configuration.modelId === model.modelId && old.configuration.protocol === protocol
          && old.configuration.baseUrl === baseUrl;
        // An unavailable catalogue cannot erase metadata fixed by an earlier save.
        if (profile.source === 'unknown' && sameRoute && old.configuration.reasoningLevels !== undefined)
          profile = { ...profile, source: old.configuration.reasoningSource ?? 'unknown', efforts: ['auto', ...old.configuration.reasoningLevels] };
        const levels = profile.efforts.filter(level => level !== 'auto');
        const capacity = resolveModelCapacity(model, sameRoute ? resolveModelCapacity(old.configuration, profile) : profile);
        const effort = model.reasoningEffort ?? (sameRoute ? old.configuration.reasoningEffort : profile.defaultEffort);
        const dialect = effort === undefined && sameRoute ? old.configuration.dialect : profile.dialect;
        if (modelReasoningError({ protocol, baseUrl, modelId: model.modelId, ...origin,
          dialect: profile.dialect, reasoningLevels: levels, ...(effort ? { reasoningEffort: effort } : {}) }, capacity.maxOutputTokens))
          throw new StorageError('invalid');
        const credential = (!old || old.retired) && inheritedKey ? { action: 'replace' as const, value: inheritedKey }
          : old?.retired && input.credential.action === 'keep' ? { action: 'clear' as const } : input.credential;
        models.push(await owner.write(tx, scope, {
          requestId: input.requestId, connectionId: model.connectionId, expectedVersion: model.expectedVersion,
          name: input.name, protocol, baseUrl, path: paths[protocol], ...origin,
          providerId: input.providerId, providerEnabled: input.enabled, modelEnabled: model.enabled, enabled: input.enabled && model.enabled,
          modelId: model.modelId, dialect, parameterMode: effort === undefined && sameRoute ? old.configuration.parameterMode
            : effort && !['auto', 'none'].includes(effort) ? 'thinking' : 'plain',
          ...capacity,
          ...(model.imageInput !== undefined ? { imageInput: model.imageInput }
            : sameRoute && old?.configuration.imageInput !== undefined ? { imageInput: old.configuration.imageInput } : {}),
          reasoningLevels: levels, reasoningSource: profile.source,
          ...(effort === undefined ? {} : { reasoningEffort: effort }), credential,
        }));
      }
      let credentialConnection: ModelProvider['credentialConnection'];
      let anchorHasCredential = false;
      // Retain the real route and its history; only the head disappears from current membership.
      for (const model of input.removedModels ?? []) {
        const old = heads.get(model.connectionId)!;
        const retired = await owner.write(tx, scope, { ...old.configuration, requestId: input.requestId,
          expectedVersion: model.expectedVersion, name: input.name, providerId: input.providerId,
          providerEnabled: input.enabled, enabled: false, modelEnabled: false, credential: input.credential }, true);
        credentialConnection = { connectionId: retired.connectionId, version: retired.version };
        anchorHasCredential = retired.hasCredential;
      }
      if (!models.length && !credentialConnection && anchor) {
        const retired = await owner.write(tx, scope, { ...anchor.configuration, requestId: input.requestId,
          expectedVersion: anchor.version, credential: input.credential }, true);
        credentialConnection = { connectionId: retired.connectionId, version: retired.version };
        anchorHasCredential = retired.hasCredential;
      }
      const group = { version: input.expectedVersion + 1, connectionIds: input.models.map(model => model.connectionId),
        name: input.name, enabled: input.enabled, protocol: input.protocol, baseUrl: input.baseUrl, ...origin,
        ...(!models.length ? { credentialConnection } : {}) };
      await tx.query(`INSERT INTO model_providers VALUES($1,$2,$3) ON CONFLICT(scope,id) DO UPDATE SET body=EXCLUDED.body`, [scope, input.providerId, group]);
      return modelProviderSchema.parse({ providerId: input.providerId, version: group.version, name: input.name, protocol: input.protocol,
        baseUrl: input.baseUrl, ...origin, enabled: input.enabled, hasCredential: models.length ? models.every(model => model.hasCredential) : anchorHasCredential,
        ...(!models.length ? { credentialConnection } : {}), models });
    });
    return modelProviderSchema.parse(receipt.result);
  }

  async function validate() {
    const { rows: orphans } = await storage.read(`SELECT c.id FROM model_connections c LEFT JOIN model_providers p
      ON p.scope=c.scope AND p.id=(c.body->'configuration'->>'providerId')::uuid
      WHERE c.body->'configuration'->>'providerId' IS NOT NULL AND NOT (c.body @> '{"retired":true}')
      AND (p.id IS NULL OR NOT (p.body->'connectionIds' ? c.id::text)) LIMIT 1`);
    if (orphans.length) throw new StorageError('corrupt');
    const { rows } = await storage.read('SELECT scope,id,body FROM model_providers');
    for (const row of rows) {
      const group = groupSchema.parse(row.body);
      if (new Set(group.connectionIds).size !== group.connectionIds.length) throw new StorageError('corrupt');
      if (!group.connectionIds.length) {
        const { rows: [anchor] } = await storage.read('SELECT body FROM model_connections WHERE scope=$1 AND id=$2',
          [row.scope, group.credentialConnection?.connectionId]);
        emptyAnchor(String(row.id), group, anchor?.body as Stored | undefined);
        continue;
      }
      if (group.credentialConnection) throw new StorageError('corrupt');
      const { rows: members } = await storage.read('SELECT id,body FROM model_connections WHERE scope=$1 AND id=ANY($2::uuid[])', [row.scope, group.connectionIds]);
      if (members.length !== group.connectionIds.length) throw new StorageError('corrupt');
      let shared: string | undefined;
      for (const member of members) {
        const stored = member.body as Stored, configuration = stored.configuration;
        const key = JSON.stringify([configuration.name, configuration.providerEnabled, configuration.presetId, configuration.variantId]);
        if (stored.retired || configuration.providerId !== row.id || configuration.modelEnabled === undefined || configuration.providerEnabled === undefined
          || configuration.enabled !== (configuration.modelEnabled && configuration.providerEnabled) || shared !== undefined && shared !== key
          || group.presetId !== configuration.presetId || group.variantId !== configuration.variantId
          || group.name !== undefined && group.name !== configuration.name
          || group.enabled !== undefined && group.enabled !== configuration.providerEnabled)
          throw new StorageError('corrupt');
        shared = key;
      }
    }
  }
  return { list, save, validate };
}
