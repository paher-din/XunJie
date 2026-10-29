import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { isSupportedPostgresVersion } from '@xunjie/storage';
import type { RuntimeEnvironment } from '@xunjie/contracts/product-runtime';
import { runtimeEnvironmentSchema } from '@xunjie/contracts/product-runtime';
import { atomicJson, exists, readJson } from './io.js';
import type { MaintenanceParticipant } from './maintenance.js';
import { databaseBinding, inspectDatabase, resolveCredential, startDatabase, storeCredential } from './postgres.js';
import type { DatabaseConfiguration, RuntimeResources } from './postgres.js';
import type { InstalledConfiguration, InstallOptions } from './runtime.js';
import { openProductRuntime } from './runtime.js';
import { recoveryPg } from './recovery-postgres.js';
import type { RecoveryDatabaseConnection } from './recovery-postgres.js';
import { RecoveryError, restoreRecoverySet } from './recovery.js';
import { verifyRecovery } from './recovery-files.js';
import type { RecoveryOwner, RecoveryTarget } from './recovery-types.js';
import type { RecoveryManifest } from './recovery-types.js';

export async function recoveryDatabase(root: string): Promise<RecoveryDatabaseConnection | null> {
  const config = await readJson<InstalledConfiguration>(join(root, 'installation.json'));
  const binding = await databaseBinding(root, config.database);
  if (!binding) return null;
  const { credentialRef, ...connection } = binding;
  return { ...connection, password: await resolveCredential(root, credentialRef) };
}

export function createRuntimeRecoveryOwner(options: { root: string; participant: MaintenanceParticipant; requiredServiceIds?: string[] }): RecoveryOwner {
  return {
    participant: options.participant,
    async export({ directory, signal }) {
      const root = options.root;
      const config = await readJson<InstalledConfiguration>(join(root, 'installation.json'));
      const environment = await readJson<RuntimeEnvironment>(join(root, 'environment.json'));
      const credentials: Record<string, string> = {};
      if (await exists(join(root, 'credentials'))) for (const ref of await readdir(join(root, 'credentials'))) {
        credentials[ref] = await resolveCredential(root, ref);
      }
      const tls = config.tls ? { certificate: await readFile(config.tls.certificateFile, 'utf8'),
        key: await readFile(config.tls.keyFile, 'utf8') } : undefined;
      const database = await recoveryDatabase(root);
      let engineVersion: string | undefined;
      let databaseIdentity: { systemIdentifier: string; databaseOid: string } | undefined;
      if (database) {
        const client = new pg.Client(database); client.on('error', () => {});
        try {
          await client.connect();
          const { rows: [identity] } = await client.query(`SELECT current_setting('server_version') AS version,
            (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
            (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid`);
          engineVersion = identity.version.split(' ')[0];
          databaseIdentity = { systemIdentifier: identity.system_identifier, databaseOid: identity.database_oid };
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          const { rows: [row] } = await client.query('SELECT pg_export_snapshot() AS snapshot');
          // Runtime owns the installation database's public schema. Other owner schemas export themselves.
          await recoveryPg({ resources: config.resources, connection: database, tool: 'pg_dump', signal,
            args: ['--format=custom', '--no-owner', '--no-acl', '--schema=public', `--snapshot=${row.snapshot}`, '-f', join(directory, 'runtime.dump')] });
          await client.query('COMMIT');
        } finally { await client.end(); }
      }
      return { formatVersion: 1, schemaVersion: '1', ...(engineVersion ? { engineVersion } : {}),
        data: { environment, configuration: { ...config, requiredServiceIds: options.requiredServiceIds ?? config.requiredServiceIds }, credentials, tls, databaseIdentity } };
    },
    async release() {},
  };
}

/** Runtime metadata and native database lifecycle remain owned by the original runtime module. */
export function createRuntimeRecoveryTarget(options: { root: string; resources: RuntimeResources; serviceId: string;
  database?: DatabaseConfiguration; databaseCredential?: string;
  installation?: Omit<InstallOptions, 'database' | 'requiredServiceIds'> }): RecoveryTarget {
  return {
    serviceId: options.serviceId,
    async restore({ directory, recovery, signal }) {
      if (recovery.schemaVersion !== '1' || recovery.formatVersion !== 1) throw new RecoveryError('incompatible-runtime-format');
      const data = recovery.data as { environment: RuntimeEnvironment; configuration: InstalledConfiguration;
        databaseIdentity?: { systemIdentifier: string; databaseOid: string } };
      const source = runtimeEnvironmentSchema.parse(data.environment);
      if (source.services[0]?.serviceId !== options.serviceId) throw new RecoveryError('owner-identity-conflict');
      if (recovery.engineVersion && (!isSupportedPostgresVersion(recovery.engineVersion)
        || !isSupportedPostgresVersion(options.resources.postgresVersion ?? ''))) throw new RecoveryError('incompatible-engine');
      const sourceMajor = recovery.engineVersion ? Number.parseInt(recovery.engineVersion) : undefined;
      const targetMajor = options.resources.postgresVersion ? Number.parseInt(options.resources.postgresVersion) : undefined;
      if (sourceMajor && (!targetMajor || sourceMajor > targetMajor)) throw new RecoveryError('incompatible-engine');
      const runtime = openProductRuntime({ root: options.root, resources: options.resources });
      const databaseConfiguration = options.database ?? (data.configuration.database.mode === 'none' ? { mode: 'none' } as const : { mode: 'managed' } as const);
      if (databaseConfiguration.mode === 'external') {
        if (!options.databaseCredential) throw new RecoveryError('target-database-credential-required');
        await storeCredential(options.root, databaseConfiguration.credentialRef, options.databaseCredential);
      }
      const installed = await runtime.install({ profile: databaseConfiguration.mode === 'none' ? 'remote' : databaseConfiguration.mode === 'external' ? 'school' : 'local',
        ...options.installation, database: databaseConfiguration,
        requiredServiceIds: data.configuration.requiredServiceIds });
      const environment: RuntimeEnvironment = { ...source, installationId: randomUUID(),
        clientNamespace: `xunjie.v1.${source.environmentId}.recovery.${randomUUID()}`,
        profile: installed.environment.profile,
        services: source.services.map((service, index) => index === 0 ? { ...service, endpoint: installed.environment.services[0]!.endpoint } : service) };
      await atomicJson(join(options.root, 'environment.json'), environment);
      const config = await readJson<InstalledConfiguration>(join(options.root, 'installation.json'));
      // Outgoing identities are retained. Their credentials must be reissued by each receiver.
      await atomicJson(join(options.root, 'installation.json'), { ...config, connections: data.configuration.connections });
      await startDatabase(options.root, options.resources, config.database);
      if (config.database.mode !== 'none'
        && (await inspectDatabase(options.root, config.database)).version.split(' ')[0] !== options.resources.postgresVersion) {
        throw new RecoveryError('target-engine-version-mismatch');
      }
      const database = await recoveryDatabase(options.root);
      if (database) {
        const client = new pg.Client(database);
        try {
          await client.connect();
          const { rows: [identity] } = await client.query(`SELECT (SELECT system_identifier::text FROM pg_control_system()) AS id,
            (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid`);
          if (identity.id === data.databaseIdentity?.systemIdentifier && identity.oid === data.databaseIdentity?.databaseOid) throw new RecoveryError('target-database-conflict');
          const { rows: [objects] } = await client.query("SELECT count(*)::integer AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'");
          if (objects.count !== 0) throw new RecoveryError('target-database-conflict');
        } finally { await client.end(); }
        await recoveryPg({ resources: options.resources, connection: database, tool: 'pg_restore', signal,
          args: ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '--clean', '--if-exists', join(directory, 'runtime.dump')] });
      } else if (sourceMajor) throw new RecoveryError('target-database-required');
      const participant: MaintenanceParticipant = {
        descriptor: { serviceId: options.serviceId, schemaVersion: '1', resourceRoots: [], configurationRefs: ['installation'] },
        async closeWrites() {}, async closeDispatch() {}, async drain() {},
        async validate() { if (database) await inspectDatabase(options.root, config.database); },
        async resume() {},
      };
      return createRuntimeRecoveryOwner({ root: options.root, participant });
    },
    async validate(owner) { await owner.participant.validate(); },
  };
}

export async function restoreProductRecovery(options: { root: string; backupDirectory: string; resources: RuntimeResources;
  key: Uint8Array; targets?: readonly RecoveryTarget[]; database?: DatabaseConfiguration; databaseCredential?: string;
  installation?: Omit<InstallOptions, 'database' | 'requiredServiceIds'>; minimumFreeBytes?: number }) {
  const manifest = await verifyRecovery(options.backupDirectory, options.key);
  const runtimeId = manifest.source.services[0]?.serviceId;
  if (!runtimeId) throw new RecoveryError('runtime-participant-missing');
  return restoreRecoverySet({ backupDirectory: options.backupDirectory, targetRoot: options.root, key: options.key,
    ...(options.minimumFreeBytes === undefined ? {} : { minimumFreeBytes: options.minimumFreeBytes }),
    targets: [createRuntimeRecoveryTarget({ root: options.root, resources: options.resources, serviceId: runtimeId,
      ...(options.database ? { database: options.database } : {}), databaseCredential: options.databaseCredential,
      installation: options.installation }), ...(options.targets ?? [])] });
}

/** All upgrade kinds build an isolated target from a held, consistent logical backup. */
export async function upgradeProductRecovery(options: {
  kind: 'schema' | 'pg-minor' | 'pg-major';
  sourceRoot: string;
  root: string;
  backupDirectory: string;
  key: Uint8Array;
  resources: RuntimeResources;
  backup: () => Promise<RecoveryManifest>;
  targets?: readonly RecoveryTarget[];
  database?: DatabaseConfiguration;
  databaseCredential?: string;
  installation?: Omit<InstallOptions, 'database' | 'requiredServiceIds'>;
  minimumFreeBytes?: number;
}) {
  if (!['schema', 'pg-minor', 'pg-major'].includes(options.kind)) throw new RecoveryError('unsupported-upgrade');
  const id = randomUUID(), startedAt = new Date().toISOString();
  const save = async (phase: string, detail: Record<string, unknown> = {}) => {
    await atomicJson(join(options.sourceRoot, `upgrade-${id}.json`), { formatVersion: 1, operationId: id,
      kind: options.kind, phase, startedAt, updatedAt: new Date().toISOString(), ...detail });
  };
  await save('backing-up');
  let manifest: RecoveryManifest | undefined;
  try {
    manifest = await options.backup();
    const sourceVersion = manifest.services.find(item => item.serviceId === manifest!.source.services[0]?.serviceId)?.engineVersion;
    if (options.kind !== 'schema') {
      const source = sourceVersion?.split('.').map(Number), target = options.resources.postgresVersion?.split('.').map(Number);
      if (!source || !target || (options.kind === 'pg-minor'
        ? target[0] !== source[0] || target[1]! <= source[1]!
        : target[0]! <= source[0]!)) throw new RecoveryError('incompatible-upgrade-version');
    }
    await save('restoring', { backupId: manifest.backupId, sourceVersion, targetVersion: options.resources.postgresVersion });
    const restored = await restoreProductRecovery({ root: options.root, backupDirectory: join(options.backupDirectory, manifest.backupId),
      key: options.key, resources: options.resources, targets: options.targets, database: options.database,
      databaseCredential: options.databaseCredential, installation: options.installation, minimumFreeBytes: options.minimumFreeBytes });
    if (options.kind === 'schema' && restored.owners.every(owner => owner.participant.descriptor.schemaVersion
      === manifest!.services.find(item => item.serviceId === owner.participant.descriptor.serviceId)?.schemaVersion)) throw new RecoveryError('no-schema-upgrade-registered');
    await save('isolated', { backupId: manifest.backupId, sourceVersion, targetVersion: options.resources.postgresVersion });
    return restored;
  } catch (error) {
    await save('failed', { backupId: manifest?.backupId, error: error instanceof RecoveryError ? error.code : 'upgrade-failed' });
    throw error;
  }
}
