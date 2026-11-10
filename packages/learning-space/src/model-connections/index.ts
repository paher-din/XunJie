import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { OwnedStorage, Migration, OwnedTransaction } from '@xunjie/storage';
import { StorageError } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelConfigurationSchema, modelConnectionSchema, saveModelConnectionSchema, schoolModelInputSchema, schoolModelSchema,
  modelBaseUrlError, getModelPreset, resolvePresetModelRoute, modelProviderPresets } from '@xunjie/contracts/model-connections';
import type { ModelConfiguration, ModelConnection, ModelCheckPolicy, SaveModelConnection } from '@xunjie/contracts/model-connections';
import { z } from 'zod';
import { sealCredential, openCredential } from './vault.js';
import { createChecks, checkMigrations, type CheckSnapshot } from './checks.js';
import { learningAdmissionMigration, type LearningAdmissionPolicy } from './learning-admission.js';
export type { LearningAdmissionPolicy } from './learning-admission.js';
export { learningAdmissionPolicySchema, defaultLearningAdmissionPolicy } from './learning-admission.js';
import type { ModelCheckInput, ModelAttempt } from '@xunjie/contracts/model-connections';
import { modelDeviceChoicesMigration, modelDeviceRevocationsMigration } from './device-choices.js';
import { createModelSelections, selectionMigrations } from './selection.js';
import { createModelImages } from './images.js';
import { createChatWork, chatWorkMigrations } from './chat-work.js';
import { createModelRouting, modelRoutingMigrations } from './routing.js';
import { measuredCapabilities } from './capabilities.js';
import { createModelResults } from './results.js';
import { adapterReady } from './transport.js';
import { modelOriginMigration, modelOriginAuthorizationMigration, modelOriginSuccessionMigration, createModelOrigins } from './origins.js';
export { modelOriginSuccessionSchema, modelOriginRecoveryOperationSchema } from './origins.js';
import { pairedLearningMigration, validatePairedLearning } from './paired-learning.js';
export { createPairedLearningModels } from './paired-learning.js';
export type { PairedModelOrigin, PairedLearningOptions, ModelDeviceBinding } from './paired-learning.js';
import { createModelDeviceTasks, modelDeviceTaskMigration } from './device-tasks.js';
import { modelTargetFetch, validateModelTarget, type ModelTargetClass } from './network-policy.js';
import { createModelProviders, modelProviderMigration } from './providers.js';
import { createModelProfiles, modelPresetCatalogues } from './profiles.js';
import { cataloguePersistence, createCatalogueCache, modelCatalogueMigration } from './catalogue-cache.js';
import { createModelDirectory, type DirectorySource } from './directory.js';

export const modelMigrations: readonly Migration[] = [{ version: 1, name: 'personal-model-connections', sql: `
  CREATE TABLE model_vault (id text PRIMARY KEY,resource_id uuid NOT NULL);
  CREATE TABLE model_credentials (id uuid PRIMARY KEY,scope text NOT NULL,binding text NOT NULL,sealed jsonb NOT NULL);
  CREATE TABLE model_connections (scope text NOT NULL,id uuid NOT NULL,version integer NOT NULL,body jsonb NOT NULL,
    PRIMARY KEY(scope,id));
  CREATE TABLE model_versions (scope text NOT NULL,id uuid NOT NULL,version integer NOT NULL,body jsonb NOT NULL,
    PRIMARY KEY(scope,id,version));
` }, ...checkMigrations, { version: 3, name: 'temporary-check-credentials', sql: `
  ALTER TABLE model_credentials ADD COLUMN temporary boolean NOT NULL DEFAULT false;
` }, { version: 4, name: 'school-model-default', sql: `
  CREATE UNIQUE INDEX model_school_default ON model_connections(scope) WHERE scope LIKE 'school:%';
` }, ...selectionMigrations, ...chatWorkMigrations, ...modelRoutingMigrations, { version: 8, name: 'native-call-input-validation-metadata', sql: `
  ALTER TABLE model_attempts ADD COLUMN input_metadata jsonb;
` }, { version: 9, name: 'messages-upstream-facts-contract', sql: `
  ALTER TABLE model_attempts ADD CONSTRAINT model_attempt_upstream_object
    CHECK (NOT (body ? 'upstream') OR jsonb_typeof(body->'upstream')='object');
` }, modelDeviceTaskMigration, { version: 11, name: 'learning-attempt-progress', sql: `
  CREATE TABLE model_attempt_progress(attempt_id uuid PRIMARY KEY,scope text NOT NULL,body jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
` }, pairedLearningMigration, modelOriginMigration, modelDeviceChoicesMigration, modelDeviceRevocationsMigration, { version: 16, name: 'fixed-authorized-model-selection-pins', sql: `
  CREATE TABLE model_selection_pins(id uuid PRIMARY KEY,scope text NOT NULL,selection_version integer NOT NULL,
    source jsonb NOT NULL,body jsonb NOT NULL);
  ALTER TABLE model_paired_grants DROP CONSTRAINT model_paired_grants_kind_check;
  ALTER TABLE model_paired_grants ADD CONSTRAINT model_paired_grants_kind_check CHECK(kind IN ('segment','attempt','pin'));
` }, modelOriginAuthorizationMigration, modelOriginSuccessionMigration, learningAdmissionMigration, modelProviderMigration, modelCatalogueMigration, { version: 22, name: 'direct-personal-model-routes', sql: `
  ALTER TABLE model_paired_grants ALTER COLUMN grant_id DROP NOT NULL;
` }];
type StoredConnection = { configuration: ModelConfiguration; version: number; routeId: string; credentialRef: string | null; policy?: ModelCheckPolicy };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeOf = (identity: SpaceIdentity) => [identity.environmentId, identity.spaceId, identity.principalId].join('.');
const targetOf = (configuration: ModelConfiguration) => JSON.stringify([configuration.protocol, configuration.baseUrl, configuration.path]);
export interface ModelGatewayOptions { authorize(identity: SpaceIdentity): Promise<void>;
  deviceOwner?(identity: SpaceIdentity): Promise<SpaceIdentity | null>;
  catalogueFetch?: typeof fetch;
  /** Trusted composition/test transport; the target is still checked before credentials leave. */
  supplierFetch?: typeof fetch;
  catalogueNow?: () => number;
  /** Recheck live remote authorization immediately before the SDK opens its request. */
  authorizeDispatch?(identity: SpaceIdentity): Promise<void>;
  /** Live check for a running original attempt; MUST bypass any task admission cache. */
  authorizeActive?(identity: SpaceIdentity, attemptId: string): Promise<void>;
  authorizationPollMs?: number;
  /** Trusted owner policy; a version cannot be reused with different values. */
  learningAdmissionPolicy?: LearningAdmissionPolicy;
  /** Trusted product composition; omitted holders use the school/public policy. */
  holder?: 'school' | 'device';
  schoolDefault?(identity: SpaceIdentity): Promise<z.infer<typeof schoolModelSchema> | null>;
  dispatcher?: { id: string; hasEnded(id: string): Promise<boolean> } }

/** Independently owned PostgreSQL schema/resources; no activity, Run or legacy Session is required. */
export async function createModelGateway(storage: OwnedStorage, options: ModelGatewayOptions) {
  let writesClosed = false;
  const targetClass = (source?: ModelAttempt['source']): ModelTargetClass => source?.kind === 'school'
    ? 'school-approved' : options.holder === 'device' ? 'device' : 'public';
  const { rows: [existingKey] } = await storage.read('SELECT resource_id FROM model_vault WHERE id=$1', ['credentials']);
  let keyId = existingKey?.resource_id as string | undefined;
  if (!keyId) {
    const resource = await storage.stageResource({ uploadId: randomUUID(), scope: 'credential-encryption-key', bytes: randomBytes(32),
      mediaType: 'application/octet-stream', contentVersion: 1 });
    const keyReceipt = await storage.request({ requestId: 'model-vault-initialize', fingerprint: 'model-vault-v1' }, async tx => {
      await tx.query('INSERT INTO model_vault VALUES($1,$2)', ['credentials', resource.resourceId]);
      await tx.reference('model-vault-key', resource.resourceId);
      return resource.resourceId;
    });
    keyId = keyReceipt.result as string;
  }
  const key = await storage.readResource(keyId);
  if (key.byteLength !== 32) throw new StorageError('corrupt');
  const projection = (stored: StoredConnection): ModelConnection => modelConnectionSchema.parse({ ...stored.configuration,
    version: stored.version, routeId: stored.routeId, hasCredential: !!stored.credentialRef,
    adapterState: adapterReady(stored.configuration) ? 'ready' : 'not-integrated',
    ...measuredCapabilities(stored.configuration) });
  async function list(identity: SpaceIdentity) {
    await options.authorize(identity);
    const { rows } = await storage.read('SELECT body FROM model_connections WHERE scope=$1 ORDER BY id', [scopeOf(identity)]);
    return rows.map(row => projection(row.body as StoredConnection));
  }
  async function save(identity: SpaceIdentity, value: unknown) {
    if (writesClosed) throw new StorageError('maintenance');
    await options.authorize(identity);
    return persist(scopeOf(identity), value);
  }
  async function writeConnection(tx: OwnedTransaction, scope: string, value: SaveModelConnection, policy?: ModelCheckPolicy, providerWrite = false) {
    const input = saveModelConnectionSchema.parse(value);
    const configuration = modelConfigurationSchema.parse(Object.fromEntries(Object.entries(input).filter(([name]) =>
      !['requestId', 'expectedVersion', 'credential'].includes(name))));
    if (policy) {
      const { rows: [existing] } = await tx.query('SELECT id FROM model_connections WHERE scope=$1', [scope]);
      if (existing && existing.id !== input.connectionId) throw new StorageError('conflict');
    }
    const { rows: [row] } = await tx.query('SELECT body FROM model_connections WHERE scope=$1 AND id=$2 FOR UPDATE', [scope, input.connectionId]);
    const previous = row?.body as StoredConnection | undefined;
    if (!providerWrite && (previous?.configuration.providerId || configuration.providerId)) throw new StorageError('conflict');
    if ((previous?.version ?? 0) !== input.expectedVersion) throw new StorageError('conflict');
    await validateModelTarget(configuration, policy ? 'school-approved' : targetClass());
    let credentialRef = previous?.credentialRef ?? null;
    if (input.credential.action === 'keep' && credentialRef && previous && targetOf(previous.configuration) !== targetOf(configuration))
      throw new StorageError('conflict');
    if (input.credential.action === 'clear') credentialRef = null;
    if (input.credential.action === 'replace') {
      credentialRef = randomUUID();
      const binding = JSON.stringify([scope, input.connectionId, input.expectedVersion + 1, targetOf(configuration)]);
      const sealed = sealCredential(key, binding, input.credential.value);
      await tx.query('INSERT INTO model_credentials(id,scope,binding,sealed) VALUES($1,$2,$3,$4)', [credentialRef, scope, binding, sealed]);
    }
    const saved: StoredConnection = { configuration, version: input.expectedVersion + 1,
      routeId: previous?.routeId ?? randomUUID(), credentialRef, ...(policy ? { policy } : {}) };
    await tx.query(`INSERT INTO model_connections VALUES($1,$2,$3,$4) ON CONFLICT(scope,id)
      DO UPDATE SET version=EXCLUDED.version,body=EXCLUDED.body`, [scope, input.connectionId, saved.version, saved]);
    await tx.query('INSERT INTO model_versions VALUES($1,$2,$3,$4)', [scope, input.connectionId, saved.version, saved]);
    return projection(saved);
  }
  async function persist(scope: string, value: unknown, policy?: ModelCheckPolicy) {
    const input = saveModelConnectionSchema.parse(value);
    const receipt = await storage.request({ requestId: input.requestId, fingerprint: digest({ scope, input, policy }) }, async tx => {
      // The same scope lock serializes legacy writes and complete provider saves.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-config:' + scope]);
      return writeConnection(tx, scope, input, policy);
    });
    return modelConnectionSchema.parse(receipt.result);
  }
  const directoryCache = createCatalogueCache(options.catalogueNow, cataloguePersistence(storage));
  await directoryCache.initialize();
  const catalogue = createModelProfiles(options.catalogueFetch, options.catalogueNow, directoryCache);
  const profiles = { async read(identity: SpaceIdentity, value: unknown) { await options.authorize(identity); return catalogue.read(value); } };
  const directory = createModelDirectory(catalogue, { authorize: options.authorize, key,
    ...(options.catalogueNow ? { now: options.catalogueNow } : {}),
    source(input) {
      if (input.presetId && input.presetId !== 'custom') {
        const variant = getModelPreset(input.presetId, input.variantId);
        if (!variant) throw new StorageError('invalid');
        const protocol = input.protocol ?? (variant.baseUrls['chat-completions'] ? 'chat-completions' : variant.baseUrls.responses ? 'responses' : 'messages');
        const baseUrl = variant.baseUrls[protocol];
        if (!baseUrl || input.baseUrl && input.baseUrl.replace(/\/+$/, '') !== baseUrl.replace(/\/+$/, '')) throw new StorageError('invalid');
        return { baseUrl, protocol, modelsUrl: variant.modelsUrl, catalogues: modelPresetCatalogues(input.presetId, variant.id),
          route: (modelId, supported) => resolvePresetModelRoute(input.presetId!, input.variantId, modelId, supported),
          models: variant.models.map(model => ({ ...model, ...resolvePresetModelRoute(input.presetId!, input.variantId, model.modelId, model.protocols) })) };
      }
      if (!input.baseUrl) return;
      const protocol = input.protocol ?? 'chat-completions';
      if (modelBaseUrlError(input.baseUrl, protocol)) throw new StorageError('invalid');
      const baseUrl = input.baseUrl.replace(/\/+$/, '');
      // Legacy/custom connections retain their identity and protocol. Reuse a known list
      // endpoint only when all exact matching channels agree and its origin is unchanged.
      const normalized = (url: string) => new URL(url).href.replace(/\/+$/, '');
      const known = modelProviderPresets.flatMap(preset => preset.variants).filter(variant => {
        const address = variant.baseUrls[protocol];
        return address && normalized(address) === normalized(baseUrl) && new URL(variant.modelsUrl).origin === new URL(baseUrl).origin;
      });
      const candidates = [...new Set(known.map(variant => variant.modelsUrl))];
      const modelsUrl = candidates.length === 1 ? candidates[0]! : baseUrl + (protocol === 'messages' ? '/v1/models' : '/models');
      return { baseUrl, protocol, modelsUrl, catalogues: [], models: [] };
    },
    async credential(identity, input, source) {
      if (input.credential?.action === 'replace') return input.credential.value;
      if (input.credential?.action === 'clear' || !input.savedCredential) return '';
      const current = await stored(identity, input.savedCredential.connectionId);
      if (current.version !== input.savedCredential.version) throw new StorageError('conflict');
      const saved = current.configuration;
      if (input.presetId && input.presetId !== 'custom') {
        const requested = getModelPreset(input.presetId, input.variantId);
        const existing = saved.presetId === input.presetId ? getModelPreset(saved.presetId, saved.variantId) : undefined;
        if (!requested || !existing || existing.id !== requested.id
          || existing.baseUrls[saved.protocol]?.replace(/\/+$/, '') !== saved.baseUrl.replace(/\/+$/, '')) throw new StorageError('conflict');
      } else if (saved.baseUrl.replace(/\/+$/, '') !== source.baseUrl.replace(/\/+$/, '')
        || saved.protocol !== source.protocol) throw new StorageError('conflict');
      return (await readCredential(identity, input.savedCredential.connectionId, input.savedCredential.version)).value;
    },
    async requestFetch(source: DirectorySource) {
      const endpoint = new URL(source.modelsUrl);
      const target = { baseUrl: endpoint.origin, path: endpoint.pathname + endpoint.search + endpoint.hash } as ModelConfiguration;
      if (options.supplierFetch) { await validateModelTarget(target, targetClass()); return options.supplierFetch; }
      return modelTargetFetch(target, targetClass());
    },
  });
  const providers = createModelProviders(storage, { authorize: options.authorize, project: projection, readCredential,
    prepare: async (input, identity) => {
      if (!input.presetId || input.presetId === 'custom') return;
      const saved = input.credential.action === 'keep' ? input.models.find(model => model.expectedVersion > 0) : undefined;
      const data = await directory.read(identity, { presetId: input.presetId, ...(input.variantId ? { variantId: input.variantId } : {}),
        baseUrl: input.baseUrl, protocol: input.protocol, credential: input.credential, refresh: false,
        ...(saved ? { savedCredential: { connectionId: saved.connectionId, version: saved.expectedVersion } } : {}) });
      return new Map(data.models.map(model => [model.modelId, model]));
    },
    profile: catalogue.resolve,
    assertWritable() { if (writesClosed) throw new StorageError('maintenance'); },
    write: (tx, scope, input) => writeConnection(tx, scope, input, undefined, true) });
  const schoolScope = (spaceId: string) => 'school:' + storage.owner.environmentId + ':' + spaceId;
  async function schoolDefault(identity: SpaceIdentity) {
    if (identity.kind !== 'school') return null;
    if (identity.environmentId !== storage.owner.environmentId) return options.schoolDefault ? options.schoolDefault(identity) : null;
    const { rows: [row] } = await storage.read('SELECT body FROM model_connections WHERE scope=$1', [schoolScope(identity.spaceId)]);
    if (!row) return null;
    const stored = row.body as StoredConnection;
    return schoolModelSchema.parse({ kind: 'school', connection: projection(stored), policy: stored.policy });
  }
  const school = {
    async read(identity: SpaceIdentity) {
      await options.authorize(identity);
      return schoolDefault(identity);
    },
    async save(spaceId: string, value: unknown) {
      if (writesClosed) throw new StorageError('maintenance');
      const { policy, ...input } = schoolModelInputSchema.parse(value);
      const connection = await persist(schoolScope(spaceId), input, policy);
      return schoolModelSchema.parse({ kind: 'school', connection, policy });
    },
  };
  const selection = createModelSelections(storage, {
    authorize: options.authorize, school: schoolDefault, list,
    ...(options.deviceOwner ? { deviceOwner: options.deviceOwner } : {}),
    assertWritable() { if (writesClosed) throw new StorageError('maintenance'); },
    async connection(scope, connectionId) {
      const { rows: [row] } = await storage.read('SELECT body FROM model_connections WHERE scope=$1 AND id=$2', [scope, connectionId]);
      if (!row) throw new StorageError('missing'); return projection(row.body as StoredConnection);
    },
  });
  async function stored(identity: SpaceIdentity, id: string) {
    const { rows: [row] } = await storage.read('SELECT body FROM model_connections WHERE scope=$1 AND id=$2', [scopeOf(identity), id]);
    if (!row) throw new StorageError('missing');
    return row.body as StoredConnection;
  }
  async function uncheckedSnapshot(identity: SpaceIdentity, source: ModelCheckInput['source'], learning = false, selectedSource?: unknown): Promise<CheckSnapshot> {
    await options.authorize(identity);
    if ('school' in source) {
      const current = await schoolDefault(identity);
      if (!current || current.connection.connectionId !== source.school.connectionId || current.connection.version !== source.school.version) throw new StorageError('conflict');
      const { rows: [row] } = await storage.read('SELECT body FROM model_connections WHERE scope=$1 AND id=$2', [schoolScope(identity.spaceId), source.school.connectionId]);
      if (!row) throw new StorageError('unavailable');
      const stored = row.body as StoredConnection;
      if (!stored.configuration.enabled || !stored.credentialRef || (!learning && !stored.policy?.checksAllowed) || projection(stored).adapterState !== 'ready') throw new StorageError('unavailable');
      return { connection: projection(stored), credentialRef: stored.credentialRef,
        ...(stored.policy ? { policy: stored.policy } : {}),
        source: { kind: 'school', ownerScope: schoolScope(identity.spaceId), feeSource: schoolScope(identity.spaceId) } };
    }
    if ('selected' in source) {
      const chosen = source.pinId ? await selection.pinned(identity, source.pinId, source.selectionVersion)
        : selectedSource ? await selection.resolveChoice(identity, selectedSource) : await selection.snapshot(identity, source.selectionVersion);
      if (!learning && !chosen.choice.policy.checksAllowed) throw new StorageError('unavailable');
      const ownerScope = chosen.source.ownerScope;
      const { rows: [row] } = await storage.read('SELECT body FROM model_connections WHERE scope=$1 AND id=$2', [ownerScope, chosen.choice.connection.connectionId]);
      if (!row) throw new StorageError('unavailable');
      const stored = row.body as StoredConnection;
      if (!stored.configuration.enabled || !stored.credentialRef || projection(stored).adapterState !== 'ready') throw new StorageError('unavailable');
      return { connection: projection(stored), credentialRef: stored.credentialRef, policy: stored.policy ?? chosen.choice.policy,
        source: chosen.source };
    }
    let configuration: ModelConfiguration, credentialRef: string | null, version: number, routeId: string;
    let retain: ((tx: OwnedTransaction) => Promise<void>) | undefined;
    if ('connectionId' in source) {
      const current = await stored(identity, source.connectionId);
      if (current.version !== source.version) throw new StorageError('conflict');
      ({ configuration, credentialRef, version, routeId } = current);
    } else {
      configuration = source.draft; version = 1; routeId = randomUUID(); credentialRef = null;
      // Reject unsupported/disabled snapshots before any temporary secret is retained.
      if (!configuration.enabled || !adapterReady(configuration)) throw new StorageError('unavailable');
      if (source.credential.action === 'keep' && source.savedCredential) {
        const saved = await stored(identity, source.savedCredential.connectionId);
        if (saved.version !== source.savedCredential.version || saved.configuration.connectionId !== configuration.connectionId
          || targetOf(saved.configuration) !== targetOf(configuration)) throw new StorageError('conflict');
        credentialRef = saved.credentialRef; version = saved.version; routeId = saved.routeId;
      } else if (source.credential.action === 'replace') {
        credentialRef = randomUUID();
        const binding = JSON.stringify([scopeOf(identity), configuration.connectionId, targetOf(configuration), credentialRef]);
        const sealed = sealCredential(key, binding, source.credential.value);
        const retainedRef = credentialRef;
        retain = async tx => {
          await tx.query('INSERT INTO model_credentials(id,scope,binding,sealed,temporary) VALUES($1,$2,$3,$4,true)',
            [retainedRef, scopeOf(identity), binding, sealed]);
        };
      }
    }
    if (!configuration.enabled || !adapterReady(configuration) || !credentialRef) throw new StorageError('unavailable');
    return { connection: projection({ configuration, credentialRef, routeId, version }), credentialRef,
      source: { kind: 'personal', ownerScope: scopeOf(identity), feeSource: scopeOf(identity) }, ...(retain ? { retain } : {}) };
  }
  async function snapshot(identity: SpaceIdentity, source: ModelCheckInput['source'], learning = false, selectedSource?: unknown): Promise<CheckSnapshot> {
    const fixed = await uncheckedSnapshot(identity, source, learning, selectedSource);
    await validateModelTarget(fixed.connection, targetClass(fixed.source));
    return fixed;
  }
  async function assertDispatch(identity: SpaceIdentity, attempt: Pick<ModelAttempt, 'connection' | 'source' | 'createdAt' | 'purpose'>, ref: string) {
      await options.authorize(identity);
      const learning = attempt.purpose === 'learning';
      // Probe freshness is a connection-check rule, not a generation deadline for learning runs.
      if (!learning && Date.now() - Date.parse(attempt.createdAt) > 60000) throw new StorageError('forbidden');
      const ownerScope = attempt.source?.ownerScope ?? scopeOf(identity);
      if (attempt.source?.kind === 'school' && (identity.kind !== 'school' || ownerScope !== schoolScope(identity.spaceId))) throw new StorageError('forbidden');
      await selection.authorizeAttempt(identity, attempt.source, attempt.connection.connectionId);
      const { rows: [credential] } = await storage.read('SELECT temporary FROM model_credentials WHERE id=$1 AND scope=$2', [ref, ownerScope]);
      if (!credential) throw new StorageError('forbidden');
      if (!credential.temporary) {
        const { rows: [head] } = await storage.read('SELECT body FROM model_connections WHERE scope=$1 AND id=$2', [ownerScope, attempt.connection.connectionId]);
        if (!head) throw new StorageError('forbidden');
        const current = head.body as StoredConnection;
        if (!current.configuration.enabled || current.credentialRef !== ref) throw new StorageError('forbidden');
        if (!learning && attempt.source?.kind === 'school' && !current.policy?.checksAllowed) throw new StorageError('forbidden');
      }
      await validateModelTarget(attempt.connection, targetClass(attempt.source));
  }
  const images = createModelImages(storage, options.authorize, () => { if (writesClosed) throw new StorageError('maintenance'); });
  const origins = createModelOrigins(storage, options.authorize, () => { if (writesClosed) throw new StorageError('maintenance'); });
  const routing = createModelRouting(storage, options.authorize, () => { if (writesClosed) throw new StorageError('maintenance'); });
  const results = createModelResults(storage, options.authorize);
  const deviceTasks = createModelDeviceTasks(storage, options.authorize, () => {
    if (writesClosed) throw new StorageError('maintenance');
  });
  const segments = createChatWork(storage, images, { authorize: options.authorize,
    snapshot: (identity, source, learning, selectedSource) => snapshot(identity, source, learning, selectedSource), assertDispatch,
    readPortable: results.read,
    assertWritable() { if (writesClosed) throw new StorageError('maintenance'); } });
  const checks = createChecks(storage, {
    dispatcher: options.dispatcher, authorizationPollMs: options.authorizationPollMs,
    learningAdmissionPolicy: options.learningAdmissionPolicy,
    async assertActive(identity, attempt, ref) {
      if (options.authorizeActive) await options.authorizeActive(identity, attempt.attemptId);
      else if (options.authorizeDispatch) await options.authorizeDispatch(identity);
      else await options.authorize(identity);
      await assertDispatch(identity, attempt, ref);
    },
    authorize: options.authorize, snapshot, assertDispatch, prepareChat: segments.prepare, publishChat: segments.publish,
    async requestFetch(identity, attempt) {
      if (options.authorizeDispatch) await options.authorizeDispatch(identity);
      else await options.authorizeActive?.(identity, attempt.attemptId);
      return modelTargetFetch(attempt.connection, targetClass(attempt.source));
    },
    async credential(_identity, ref) {
      // The private dispatcher already checked this attempt's actor and immutable owner scope.
      const { rows: [row] } = await storage.read('SELECT binding,sealed FROM model_credentials WHERE id=$1', [ref]);
      if (!row) throw new StorageError('forbidden');
      return openCredential(key, row.binding as string, row.sealed as ReturnType<typeof sealCredential>);
    },
  });
  async function validate() {
    const { rows: invalidHeads } = await storage.read(`
      WITH latest AS (SELECT DISTINCT ON (scope,id) scope,id,version,body
        FROM model_versions ORDER BY scope,id,version DESC)
      SELECT 1 FROM latest FULL JOIN model_connections AS head USING (scope,id)
      WHERE latest.version IS DISTINCT FROM head.version OR latest.body IS DISTINCT FROM head.body LIMIT 1`);
    if (invalidHeads.length) throw new StorageError('corrupt');
    const { rows } = await storage.read('SELECT scope,id,version,body FROM model_versions');
    for (const row of rows) {
      const stored = row.body as StoredConnection;
      projection(stored);
      if (stored.version !== row.version || stored.configuration.connectionId !== row.id)
        throw new StorageError('corrupt');
      if (stored.credentialRef) {
        const { rows: [credential] } = await storage.read(`SELECT binding,sealed FROM model_credentials
          WHERE id=$1 AND scope=$2 AND temporary=false`, [stored.credentialRef, row.scope]);
        if (!credential) throw new StorageError('corrupt');
        try {
          const [scope, id, version, target] = JSON.parse(credential.binding as string);
          if (scope !== row.scope || id !== row.id || !Number.isSafeInteger(version) || version < 1
            || version > stored.version || target !== targetOf(stored.configuration)) throw new StorageError('corrupt');
          openCredential(key, credential.binding as string, credential.sealed as ReturnType<typeof sealCredential>);
        }
        catch { throw new StorageError('corrupt'); }
      }
    }
    await checks.validate();
    await selection.validate();
    await segments.validate();
    await routing.validate();
    await deviceTasks.validate();
    await validatePairedLearning(storage);
    await origins.validate();
    await providers.validate();
    await directory.validate();
  }
  async function readCredential(identity: SpaceIdentity, connectionId: string, version: number) {
    await options.authorize(identity);
    z.uuid().parse(connectionId); z.number().int().positive().parse(version);
    const current = await stored(identity, connectionId);
    if (current.version !== version) throw new StorageError('conflict');
    let value = '';
    if (current.credentialRef) {
      const { rows: [row] } = await storage.read('SELECT binding,sealed FROM model_credentials WHERE id=$1 AND scope=$2 AND temporary=false',
        [current.credentialRef, scopeOf(identity)]);
      if (!row) throw new StorageError('forbidden');
      value = openCredential(key, row.binding as string, row.sealed as ReturnType<typeof sealCredential>);
    }
    return { connectionId, version: current.version, value };
  }
  return { list, save, readCredential, providers, profiles, directory, school, selection, images, segments, routing, results, deviceTasks, origins, validate,
    checks: { ...checks, async drain() { await Promise.all([checks.drain(), directory.drain()]); } },
    closeWrites() { writesClosed = true; directory.close(); checks.closeAdmission(); checks.closeDispatch(); },
    resume() { writesClosed = false; directory.resume(); checks.resume(); } };
}
