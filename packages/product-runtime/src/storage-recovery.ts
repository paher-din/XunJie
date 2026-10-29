import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import pg from 'pg';
import { finalizeStorageRestore, openStorage, prepareStorageRestore, provisionStorage } from '@xunjie/storage';
import type { BlobBackend, DatabaseConnection, Migration, OwnedStorage, StorageBinding } from '@xunjie/storage';
import type { StorageManifest, StorageOwner } from '@xunjie/contracts/storage';
import type { RuntimeResources } from './postgres.js';
import { resolveCredential, storeCredential } from './postgres.js';
import { recoveryPg } from './recovery-postgres.js';
import { RecoveryError } from './recovery.js';
import type { RecoveryOwner, RecoveryTarget } from './recovery-types.js';
import { checkIndependentDirectory, ensureRecoverySpace } from './recovery-files.js';
import { readJson } from './io.js';
import type { RuntimeEnvironment } from '@xunjie/contracts/product-runtime';

interface StorageRecoveryData {
  owner: StorageOwner;
  schema: string;
  migrations: Migration[];
  manifest: StorageManifest;
  databaseIdentity: { systemIdentifier: string; databaseOid: string };
  resourceRoots: string[];
}
export function createStorageRecoveryOwner(options: {
  storage: OwnedStorage; binding: StorageBinding; migrations: readonly Migration[]; resources: RuntimeResources;
  resourceRoots?: string[];
  /** The owner, not backup orchestration, knows how to re-read its domain through its API. */
  validateService: (storage: OwnedStorage) => Promise<void>;
}): RecoveryOwner {
  const participant = options.storage.participant();
  const validateStorage = participant.validate.bind(participant);
  participant.descriptor.resourceRoots = [...new Set([...participant.descriptor.resourceRoots, ...(options.resourceRoots ?? [])])];
  participant.validate = async () => { await validateStorage(); await options.validateService(options.storage); };
  return {
    participant,
    async export({ backupId, directory, signal }) {
      let exportFailure: unknown;
      return options.storage.snapshot(backupId, async ({ databaseSnapshot, manifest }) => {
        try {
        const client = new pg.Client({ ...options.binding.connection, connectionTimeoutMillis: 5000 });
        let version: string;
        let databaseIdentity: StorageRecoveryData['databaseIdentity'];
        try {
          await client.connect();
          // pg_control_system is administrator-only; immutable system identity was
          // bound by the runtime. Owner export uses database identity available to its role.
          const { rows: [row] } = await client.query(`SELECT current_setting('server_version') AS version,
            (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
            current_database() AS name`);
          version = row.version.split(' ')[0];
          databaseIdentity = { systemIdentifier: `${options.binding.connection.host}:${options.binding.connection.port}`, databaseOid: `${row.name}/${row.oid}` };
        } finally { await client.end(); }
        await recoveryPg({ resources: options.resources, connection: options.binding.connection, tool: 'pg_dump', signal,
          args: ['--format=custom', '--no-owner', '--no-acl', `--schema=${options.binding.schema}`, `--snapshot=${databaseSnapshot}`, '-f', join(directory, 'schema.dump')] });
        for (const reference of manifest.resources) {
          signal.throwIfAborted();
          const bytes = await options.storage.readResourceObject(reference.resourceId);
          await ensureRecoverySpace(directory, bytes.byteLength);
          await writeFile(join(directory, `${reference.resourceId}.blob`), bytes, { mode: 0o600, flag: 'wx' });
        }
        const data: StorageRecoveryData = { owner: options.storage.owner, schema: options.binding.schema,
          migrations: options.migrations.map(item => ({ ...item })), manifest, databaseIdentity,
          resourceRoots: [...participant.descriptor.resourceRoots] };
        return { formatVersion: 1 as const, schemaVersion: participant.descriptor.schemaVersion, engineVersion: version, data };
        } catch (error) { exportFailure = error; throw error; }
      }).catch(error => { throw exportFailure ?? error; });
    },
    release: id => options.storage.releaseBackup(id),
    close: () => options.storage.close(),
  };
}

export function createStorageRecoveryTarget(options: {
  owner: StorageOwner;
  admin: () => Promise<DatabaseConnection>;
  resources: RuntimeResources;
  backend: BlobBackend;
  migrations: readonly Migration[];
  resourceRoots?: string[];
  onRestored?: (storage: OwnedStorage, binding: StorageBinding) => void | Promise<void>;
  validateService: (storage: OwnedStorage) => Promise<void>;
}): RecoveryTarget {
  let restored: OwnedStorage | undefined;
  return {
    serviceId: options.owner.serviceId,
    async restore({ targetRoot, directory, recovery, signal }) {
      const data = recovery.data as StorageRecoveryData;
      if (data.owner?.environmentId !== options.owner.environmentId || data.owner?.serviceId !== options.owner.serviceId
        || data.manifest?.owner.environmentId !== options.owner.environmentId || data.manifest.owner.serviceId !== options.owner.serviceId
        || data.manifest.formatVersion !== 1 || !Array.isArray(data.migrations)) throw new RecoveryError('incompatible-storage-owner');
      if (data.migrations.length > options.migrations.length || data.migrations.some((item, index) => {
        const target = options.migrations[index];
        return item.version !== target?.version || item.name !== target?.name || item.sql !== target?.sql;
      })) throw new RecoveryError('incompatible-schema');
      if (!Array.isArray(data.resourceRoots)) throw new RecoveryError('missing-resource-location');
      const location = options.backend.location;
      if (!location) throw new RecoveryError('unverifiable-resource-target');
      if (location.kind === 'file') {
        for (const sourceRoot of data.resourceRoots.filter(isAbsolute)) await checkIndependentDirectory(sourceRoot, location.root);
      } else if (data.resourceRoots.includes(`s3:${location.endpoint}/${location.bucket}`)) throw new RecoveryError('target-resource-conflict');
      const admin = await options.admin();
      const client = new pg.Client(admin);
      try {
        await client.connect();
        const { rows: [row] } = await client.query('SELECT current_database() AS name, (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid');
        if (`${admin.host}:${admin.port}` === data.databaseIdentity.systemIdentifier && `${row.name}/${row.oid}` === data.databaseIdentity.databaseOid) throw new RecoveryError('target-database-conflict');
      } finally { await client.end(); }
      const password = randomBytes(32).toString('base64url');
      const binding = await prepareStorageRestore({ admin, owner: options.owner, password });
      try {
        await recoveryPg({ resources: options.resources, connection: admin, tool: 'pg_restore', signal,
          args: ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', `--role=${binding.migratorRole}`, join(directory, 'schema.dump')] });
        for (const reference of data.manifest.resources) {
          signal.throwIfAborted();
          if (reference.locator.backendId !== options.backend.id) throw new RecoveryError('incompatible-resource-backend');
          // Even matching bytes in an occupied target can belong to another environment.
          try { await options.backend.get(reference.locator.key); throw new RecoveryError('target-resource-conflict'); }
          catch (error) { if ((error as { code?: string }).code !== 'missing') throw error; }
          const bytes = await readFile(join(directory, `${reference.resourceId}.blob`));
          if (location.kind === 'file') await ensureRecoverySpace(location.root, bytes.byteLength);
          await options.backend.put(reference.locator.key, bytes);
        }
        restored = await finalizeStorageRestore({ binding, admin, migrations: data.migrations, manifest: data.manifest, backend: options.backend });
        if (options.migrations.length > data.migrations.length) {
          await restored.close(); restored = undefined;
          await provisionStorage({ admin, owner: options.owner, password, migrations: options.migrations });
          restored = await openStorage({ binding, migrations: options.migrations, backend: options.backend });
        }
        await storeCredential(targetRoot, `storage-${options.owner.serviceId}`, JSON.stringify(binding));
        await options.onRestored?.(restored, binding);
        return createStorageRecoveryOwner({ storage: restored, binding, migrations: options.migrations, resources: options.resources,
          resourceRoots: options.resourceRoots, validateService: options.validateService });
      } catch (error) { await restored?.close(); restored = undefined; throw error; }
    },
    async validate() {
      if (!restored) throw new RecoveryError('restore-incomplete');
      await options.validateService(restored);
    },
  };
}

/** Fresh owner modules reopen the rotated target credential, never the source login. */
export async function openRecoveredStorage(options: {
  root: string; serviceId: string; migrations: readonly Migration[]; backend: BlobBackend;
}): Promise<OwnedStorage> {
  let binding: StorageBinding;
  try { binding = JSON.parse(await resolveCredential(options.root, `storage-${options.serviceId}`)) as StorageBinding; }
  catch { throw new RecoveryError('invalid-private-storage-binding'); }
  const environment = await readJson<RuntimeEnvironment>(join(options.root, 'environment.json'));
  if (binding?.owner?.environmentId !== environment.environmentId || binding.owner.serviceId !== options.serviceId) throw new RecoveryError('owner-identity-conflict');
  return openStorage({ binding, migrations: options.migrations, backend: options.backend });
}
