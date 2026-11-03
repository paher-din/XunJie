import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { OwnedStorage, Migration, OwnedTransaction } from '@xunjie/storage';
import { StorageError } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelConfigurationSchema, modelConnectionSchema, saveModelConnectionSchema, schoolModelInputSchema, schoolModelSchema } from '@xunjie/contracts/model-connections';
import type { ModelConfiguration, ModelConnection, ModelCheckPolicy } from '@xunjie/contracts/model-connections';
import type { z } from 'zod';
import { sealCredential, openCredential } from './vault.js';
import { createChecks, checkMigrations, type CheckSnapshot } from './checks.js';
import type { ModelCheckInput, ModelAttempt } from '@xunjie/contracts/model-connections';
import { createModelSelections, selectionMigrations } from './selection.js';
import { createModelImages } from './images.js';
import { createChatWork, chatWorkMigrations } from './chat-work.js';
import { createModelRouting, modelRoutingMigrations } from './routing.js';
import { measuredCapabilities } from './capabilities.js';
import { createModelResults } from './results.js';
import { adapterReady } from './transport.js';

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
` }];
type StoredConnection = { configuration: ModelConfiguration; version: number; routeId: string; credentialRef: string | null; policy?: ModelCheckPolicy };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeOf = (identity: SpaceIdentity) => [identity.environmentId, identity.spaceId, identity.principalId].join('.');
const targetOf = (configuration: ModelConfiguration) => JSON.stringify([configuration.protocol, configuration.baseUrl, configuration.path]);
export interface ModelGatewayOptions { authorize(identity: SpaceIdentity): Promise<void>;
  schoolDefault?(identity: SpaceIdentity): Promise<z.infer<typeof schoolModelSchema> | null>;
  dispatcher?: { id: string; hasEnded(id: string): Promise<boolean> } }

/** Independently owned PostgreSQL schema/resources; no activity, Run or legacy Session is required. */
export async function createModelGateway(storage: OwnedStorage, options: ModelGatewayOptions) {
  let writesClosed = false;
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
  async function persist(scope: string, value: unknown, policy?: ModelCheckPolicy) {
    const input = saveModelConnectionSchema.parse(value);
    const configuration = modelConfigurationSchema.parse(Object.fromEntries(Object.entries(input).filter(([name]) =>
      !['requestId', 'expectedVersion', 'credential'].includes(name))));
    const receipt = await storage.request({ requestId: input.requestId, fingerprint: digest({ scope, input, policy }) }, async tx => {
      // One actor lock serializes creation and CAS even before a connection row exists.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-config:' + scope]);
      if (policy) {
        const { rows: [existing] } = await tx.query('SELECT id FROM model_connections WHERE scope=$1', [scope]);
        if (existing && existing.id !== input.connectionId) throw new StorageError('conflict');
      }
      const { rows: [row] } = await tx.query('SELECT body FROM model_connections WHERE scope=$1 AND id=$2 FOR UPDATE', [scope, input.connectionId]);
      const previous = row?.body as StoredConnection | undefined;
      if ((previous?.version ?? 0) !== input.expectedVersion) throw new StorageError('conflict');
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
    });
    return modelConnectionSchema.parse(receipt.result);
  }
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
    async save(spaceId: string, value: unknown) {
      if (writesClosed) throw new StorageError('maintenance');
      const { policy, ...input } = schoolModelInputSchema.parse(value);
      const connection = await persist(schoolScope(spaceId), input, policy);
      return schoolModelSchema.parse({ kind: 'school', connection, policy });
    },
  };
  const selection = createModelSelections(storage, {
    authorize: options.authorize, school: schoolDefault, list,
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
  async function snapshot(identity: SpaceIdentity, source: ModelCheckInput['source']): Promise<CheckSnapshot> {
    await options.authorize(identity);
    if ('school' in source) {
      const current = await schoolDefault(identity);
      if (!current || current.connection.connectionId !== source.school.connectionId || current.connection.version !== source.school.version) throw new StorageError('conflict');
      const { rows: [row] } = await storage.read('SELECT body FROM model_connections WHERE scope=$1 AND id=$2', [schoolScope(identity.spaceId), source.school.connectionId]);
      if (!row) throw new StorageError('unavailable');
      const stored = row.body as StoredConnection;
      if (!stored.configuration.enabled || !stored.credentialRef || !stored.policy?.checksAllowed || projection(stored).adapterState !== 'ready') throw new StorageError('unavailable');
      return { connection: projection(stored), credentialRef: stored.credentialRef, policy: stored.policy,
        source: { kind: 'school', ownerScope: schoolScope(identity.spaceId), feeSource: schoolScope(identity.spaceId) } };
    }
    if ('selected' in source) {
      const chosen = await selection.snapshot(identity, source.selectionVersion);
      if (!chosen.choice.policy.checksAllowed) throw new StorageError('unavailable');
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
  async function assertDispatch(identity: SpaceIdentity, attempt: Pick<ModelAttempt, 'connection' | 'source' | 'createdAt'>, ref: string) {
      await options.authorize(identity);
      if (Date.now() - Date.parse(attempt.createdAt) > 60000) throw new StorageError('forbidden');
      const ownerScope = attempt.source?.ownerScope ?? scopeOf(identity);
      if (attempt.source?.kind === 'school' && (identity.kind !== 'school' || ownerScope !== schoolScope(identity.spaceId))) throw new StorageError('forbidden');
      if (attempt.source?.kind === 'personal' && ownerScope !== scopeOf(identity) && !attempt.source.grantId) throw new StorageError('forbidden');
      await selection.authorizeAttempt(identity, attempt.source, attempt.connection.connectionId);
      const { rows: [credential] } = await storage.read('SELECT temporary FROM model_credentials WHERE id=$1 AND scope=$2', [ref, ownerScope]);
      if (!credential) throw new StorageError('forbidden');
      if (!credential.temporary) {
        const { rows: [head] } = await storage.read('SELECT body FROM model_connections WHERE scope=$1 AND id=$2', [ownerScope, attempt.connection.connectionId]);
        if (!head) throw new StorageError('forbidden');
        const current = head.body as StoredConnection;
        if (!current.configuration.enabled || current.credentialRef !== ref) throw new StorageError('forbidden');
        if (attempt.source?.kind === 'school' && !current.policy?.checksAllowed) throw new StorageError('forbidden');
      }
  }
  const images = createModelImages(storage, options.authorize, () => { if (writesClosed) throw new StorageError('maintenance'); });
  const routing = createModelRouting(storage, options.authorize, () => { if (writesClosed) throw new StorageError('maintenance'); });
  const results = createModelResults(storage, options.authorize);
  const segments = createChatWork(storage, images, { authorize: options.authorize, snapshot, assertDispatch,
    readPortable: results.read,
    assertWritable() { if (writesClosed) throw new StorageError('maintenance'); } });
  const checks = createChecks(storage, {
    dispatcher: options.dispatcher,
    authorize: options.authorize, snapshot, assertDispatch, prepareChat: segments.prepare, publishChat: segments.publish,
    async credential(_identity, ref) {
      // The private dispatcher already checked this attempt's actor and immutable owner scope.
      const { rows: [row] } = await storage.read('SELECT binding,sealed FROM model_credentials WHERE id=$1', [ref]);
      if (!row) throw new StorageError('forbidden');
      return openCredential(key, row.binding as string, row.sealed as ReturnType<typeof sealCredential>);
    },
  });
  async function validate() {
    const { rows } = await storage.read('SELECT body FROM model_versions');
    for (const row of rows) {
      const stored = row.body as StoredConnection;
      projection(stored);
      if (stored.credentialRef) {
        const { rows: [credential] } = await storage.read('SELECT binding,sealed FROM model_credentials WHERE id=$1', [stored.credentialRef]);
        if (!credential) throw new StorageError('corrupt');
        try { openCredential(key, credential.binding as string, credential.sealed as ReturnType<typeof sealCredential>); }
        catch { throw new StorageError('corrupt'); }
      }
    }
    await checks.validate();
    await selection.validate();
    await segments.validate();
    await routing.validate();
  }
  return { list, save, school, selection, images, segments, routing, results, validate, checks,
    closeWrites() { writesClosed = true; checks.closeAdmission(); checks.closeDispatch(); },
    resume() { writesClosed = false; checks.resume(); } };
}
