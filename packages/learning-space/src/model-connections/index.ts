import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { OwnedStorage, Migration } from '@xunjie/storage';
import { StorageError } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelConfigurationSchema, modelConnectionSchema, saveModelConnectionSchema } from '@xunjie/contracts/model-connections';
import type { ModelConfiguration, ModelConnection } from '@xunjie/contracts/model-connections';
import { sealCredential, openCredential } from './vault.js';
import { createChecks, checkMigrations, type CheckSnapshot } from './checks.js';
import type { ModelCheckInput, ModelAttempt } from '@xunjie/contracts/model-connections';

export const modelMigrations: readonly Migration[] = [{ version: 1, name: 'personal-model-connections', sql: `
  CREATE TABLE model_vault (id text PRIMARY KEY,resource_id uuid NOT NULL);
  CREATE TABLE model_credentials (id uuid PRIMARY KEY,scope text NOT NULL,binding text NOT NULL,sealed jsonb NOT NULL);
  CREATE TABLE model_connections (scope text NOT NULL,id uuid NOT NULL,version integer NOT NULL,body jsonb NOT NULL,
    PRIMARY KEY(scope,id));
  CREATE TABLE model_versions (scope text NOT NULL,id uuid NOT NULL,version integer NOT NULL,body jsonb NOT NULL,
    PRIMARY KEY(scope,id,version));
` }, ...checkMigrations, { version: 3, name: 'temporary-check-credentials', sql: `
  ALTER TABLE model_credentials ADD COLUMN temporary boolean NOT NULL DEFAULT false;
` }];
type StoredConnection = { configuration: ModelConfiguration; version: number; routeId: string; credentialRef: string | null };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeOf = (identity: SpaceIdentity) => [identity.environmentId, identity.spaceId, identity.principalId].join('.');
const targetOf = (configuration: ModelConfiguration) => JSON.stringify([configuration.protocol, configuration.baseUrl, configuration.path]);
export interface ModelGatewayOptions { authorize(identity: SpaceIdentity): Promise<void> }

/** Independently owned PostgreSQL schema/resources; no activity, Run or legacy Session is required. */
export async function createModelGateway(storage: OwnedStorage, options: ModelGatewayOptions) {
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
    adapterState: stored.configuration.protocol === 'chat-completions' ? 'ready' : 'not-integrated',
    capabilities: { text: 'unknown', images: 'unknown', tools: 'unknown', strictSchema: 'unknown' } });
  async function list(identity: SpaceIdentity) {
    await options.authorize(identity);
    const { rows } = await storage.read('SELECT body FROM model_connections WHERE scope=$1 ORDER BY id', [scopeOf(identity)]);
    return rows.map(row => projection(row.body as StoredConnection));
  }
  async function save(identity: SpaceIdentity, value: unknown) {
    await options.authorize(identity);
    const input = saveModelConnectionSchema.parse(value), scope = scopeOf(identity);
    const configuration = modelConfigurationSchema.parse(Object.fromEntries(Object.entries(input).filter(([name]) =>
      !['requestId', 'expectedVersion', 'credential'].includes(name))));
    const receipt = await storage.request({ requestId: input.requestId, fingerprint: digest({ scope, input }) }, async tx => {
      // One actor lock serializes creation and CAS even before a connection row exists.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['model-config:' + scope]);
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
        routeId: previous?.routeId ?? randomUUID(), credentialRef };
      await tx.query(`INSERT INTO model_connections VALUES($1,$2,$3,$4) ON CONFLICT(scope,id)
        DO UPDATE SET version=EXCLUDED.version,body=EXCLUDED.body`, [scope, input.connectionId, saved.version, saved]);
      await tx.query('INSERT INTO model_versions VALUES($1,$2,$3,$4)', [scope, input.connectionId, saved.version, saved]);
      return projection(saved);
    });
    return modelConnectionSchema.parse(receipt.result);
  }
  async function stored(identity: SpaceIdentity, id: string) {
    const { rows: [row] } = await storage.read('SELECT body FROM model_connections WHERE scope=$1 AND id=$2', [scopeOf(identity), id]);
    if (!row) throw new StorageError('missing');
    return row.body as StoredConnection;
  }
  async function snapshot(identity: SpaceIdentity, source: ModelCheckInput['source']): Promise<CheckSnapshot> {
    await options.authorize(identity);
    let configuration: ModelConfiguration, credentialRef: string | null, version: number, routeId: string, temporary = false;
    if ('connectionId' in source) {
      const current = await stored(identity, source.connectionId);
      if (current.version !== source.version) throw new StorageError('conflict');
      ({ configuration, credentialRef, version, routeId } = current);
    } else {
      configuration = source.draft; version = 1; routeId = randomUUID(); credentialRef = null;
      if (source.credential.action === 'keep' && source.savedCredential) {
        const saved = await stored(identity, source.savedCredential.connectionId);
        if (saved.version !== source.savedCredential.version || saved.configuration.connectionId !== configuration.connectionId
          || targetOf(saved.configuration) !== targetOf(configuration)) throw new StorageError('conflict');
        credentialRef = saved.credentialRef; version = saved.version; routeId = saved.routeId;
      } else if (source.credential.action === 'replace') {
        credentialRef = randomUUID(); temporary = true;
        const binding = JSON.stringify([scopeOf(identity), configuration.connectionId, targetOf(configuration), credentialRef]);
        const sealed = sealCredential(key, binding, source.credential.value);
        await storage.request({ requestId: randomUUID(), fingerprint: 'temporary-model-credential' }, async tx => {
          await tx.query('INSERT INTO model_credentials(id,scope,binding,sealed,temporary) VALUES($1,$2,$3,$4,true)',
            [credentialRef, scopeOf(identity), binding, sealed]); return { retained: true };
        });
      }
    }
    if (!configuration.enabled || configuration.protocol !== 'chat-completions' || !credentialRef) throw new StorageError('unavailable');
    return { connection: projection({ configuration, credentialRef, routeId, version }), credentialRef, temporary };
  }
  const checks = createChecks(storage, {
    authorize: options.authorize, snapshot,
    async credential(identity, ref) {
      const { rows: [row] } = await storage.read('SELECT binding,sealed FROM model_credentials WHERE id=$1 AND scope=$2', [ref, scopeOf(identity)]);
      if (!row) throw new StorageError('forbidden');
      return openCredential(key, row.binding as string, row.sealed as ReturnType<typeof sealCredential>);
    },
    async assertDispatch(identity, attempt: ModelAttempt, ref) {
      await options.authorize(identity);
      if (Date.now() - Date.parse(attempt.createdAt) > 60000) throw new StorageError('forbidden');
      const { rows: [credential] } = await storage.read('SELECT temporary FROM model_credentials WHERE id=$1 AND scope=$2', [ref, scopeOf(identity)]);
      if (!credential) throw new StorageError('forbidden');
      if (!credential.temporary) {
        const current = await stored(identity, attempt.connection.connectionId);
        if (!current.configuration.enabled || current.credentialRef !== ref) throw new StorageError('forbidden');
      }
    },
    async release(ref) {
      await storage.request({ requestId: randomUUID(), fingerprint: 'release-temporary-credential' }, async tx => {
        await tx.query('DELETE FROM model_credentials WHERE id=$1 AND temporary=true', [ref]); return { released: true };
      });
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
  }
  return { list, save, validate, checks };
}
