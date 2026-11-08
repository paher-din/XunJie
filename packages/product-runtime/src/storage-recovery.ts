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
import type { BoundaryUnresolved, OwnerBoundaryMaterial, RecoveryOwner, RecoveryTarget } from './recovery-types.js';
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

/** Authenticate a backup's SQL against the owner's registry before any restore-side DDL.
 * A former version is allowed only as the last entry after an unchanged canonical prefix.
 * Use trusted SQL and discard backup-supplied compatibility metadata for strict finalization.
 */
function restoreMigrations(source: readonly Migration[], target: readonly Migration[]): Migration[] {
  const same = (item: Migration, expected: Migration | undefined) => expected !== undefined
    && item.name === expected.name && item.sql === expected.sql;
  if (source.length > target.length) throw new RecoveryError('incompatible-schema');
  return source.map((item, index) => {
    if (!item || item.version !== index + 1) throw new RecoveryError('incompatible-schema');
    let expected = target[index];
    if (!same(item, expected) || expected?.version !== item.version) {
      if (index !== source.length - 1) throw new RecoveryError('incompatible-schema');
      const alternatives = target.filter(candidate => candidate.formerVersion === item.version
        && Number.isInteger(candidate.formerVersion) && candidate.version > item.version && same(item, candidate));
      if (alternatives.length !== 1) throw new RecoveryError('incompatible-schema');
      expected = alternatives[0];
    }
    return { version: item.version, name: expected!.name, sql: expected!.sql };
  });
}
/**
 * Owner-specific boundary evidence. The storage owner supplies resource facts; an execution
 * owner adds its accepted commands and their dispositions through the same hook.
 */
export interface StorageBoundaryEvidence {
  kind: string;
  unresolved: BoundaryUnresolved[];
  settled: number;
  blocking: { code: string; detail: string }[];
  retained?: { resources: number; checkpoints: number };
  /** Versioned owner payload, validated by the owning service after restore. */
  evidence?: unknown;
}
export function createStorageRecoveryOwner(options: {
  storage: OwnedStorage; binding: StorageBinding; migrations: readonly Migration[]; resources: RuntimeResources;
  resourceRoots?: string[];
  /** The installation this owner belongs to; boundary evidence names it explicitly. */
  installationId: string;
  /** Boundary evidence read through the owner's own tables while its gates are closed. */
  boundary?: (storage: OwnedStorage, input: { boundaryAt: string }) => Promise<StorageBoundaryEvidence>;
  receiverBoundary?: (storage: OwnedStorage, input: { boundaryAt: string }) => Promise<StorageBoundaryEvidence>;
  /** The owner, not backup orchestration, knows how to re-read its domain through its API. */
  validateService: (storage: OwnedStorage) => Promise<void>;
}): RecoveryOwner {
  const participant = options.storage.participant();
  const validateStorage = participant.validate.bind(participant);
  participant.descriptor.resourceRoots = [...new Set([...participant.descriptor.resourceRoots, ...(options.resourceRoots ?? [])])];
  participant.validate = async () => { await validateStorage(); await options.validateService(options.storage); };
  async function material({ boundaryAt }: { boundaryAt: string }, collect = options.boundary) {
      const evidence = collect ? await collect(options.storage, { boundaryAt })
        : { kind: 'xunjie.storage.boundary', unresolved: [], settled: 0, blocking: [] } satisfies StorageBoundaryEvidence;
      const material: OwnerBoundaryMaterial = {
        formatVersion: 1, kind: evidence.kind, serviceId: participant.descriptor.serviceId, boundaryAt,
        source: { environmentId: options.storage.owner.environmentId, installationId: options.installationId },
        schemaVersion: participant.descriptor.schemaVersion, coverage: 'service-received',
        unresolved: evidence.unresolved.map(item => ({ ...item })), settled: evidence.settled,
        retained: evidence.retained ?? { resources: 0, checkpoints: 0 },
        blocking: evidence.blocking.map(item => ({ ...item })),
        ...(evidence.evidence === undefined ? {} : { evidence: evidence.evidence }),
      };
      return material;
  }
  return {
    participant, material,
    ...(options.receiverBoundary ? { receiverMaterial: (input: { boundaryAt: string }) => material(input, options.receiverBoundary) } : {}),
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
  /** Installation identity written into this target's own boundary material. */
  installationId: string;
  onRestored?: (storage: OwnedStorage, binding: StorageBinding) => void | Promise<void>;
  validateService: (storage: OwnedStorage) => Promise<void>;
  /** The owner re-derives its evidence from the restored data and compares it with the material. */
  validateMaterial?: (storage: OwnedStorage, material: OwnerBoundaryMaterial) => Promise<void>;
  boundary?: (storage: OwnedStorage, input: { boundaryAt: string }) => Promise<StorageBoundaryEvidence>;
  receiverBoundary?: (storage: OwnedStorage, input: { boundaryAt: string }) => Promise<StorageBoundaryEvidence>;
}): RecoveryTarget {
  let restored: OwnedStorage | undefined;
  return {
    serviceId: options.owner.serviceId,
    async restore({ targetRoot, directory, recovery, signal }) {
      const data = recovery.data as StorageRecoveryData;
      if (data.owner?.environmentId !== options.owner.environmentId || data.owner?.serviceId !== options.owner.serviceId
        || data.manifest?.owner.environmentId !== options.owner.environmentId || data.manifest.owner.serviceId !== options.owner.serviceId
        || data.manifest.formatVersion !== 1 || !Array.isArray(data.migrations)) throw new RecoveryError('incompatible-storage-owner');
      const sourceMigrations = restoreMigrations(data.migrations, options.migrations);
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
        restored = await finalizeStorageRestore({ binding, admin, migrations: sourceMigrations, manifest: data.manifest, backend: options.backend });
        if (options.migrations.length > sourceMigrations.length) {
          await restored.close(); restored = undefined;
          await provisionStorage({ admin, owner: options.owner, password, migrations: options.migrations });
          restored = await openStorage({ binding, migrations: options.migrations, backend: options.backend });
        }
        await storeCredential(targetRoot, `storage-${options.owner.serviceId}`, JSON.stringify(binding));
        await options.onRestored?.(restored, binding);
        return createStorageRecoveryOwner({ storage: restored, binding, migrations: options.migrations, resources: options.resources,
          resourceRoots: options.resourceRoots, installationId: options.installationId, validateService: options.validateService,
          boundary: options.boundary, receiverBoundary: options.receiverBoundary });
      } catch (error) { await restored?.close(); restored = undefined; throw error; }
    },
    async validate() {
      if (!restored) throw new RecoveryError('restore-incomplete');
      await options.validateService(restored);
    },
    async validateMaterial(_owner, material) {
      if (!restored) throw new RecoveryError('restore-incomplete');
      if (material.serviceId !== options.owner.serviceId) throw new RecoveryError('incompatible-boundary-material');
      await options.validateMaterial?.(restored, material);
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
