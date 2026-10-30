import pg from 'pg';
import type { StorageManifest, StorageOwner } from '@xunjie/contracts/storage';
import type { BlobBackend } from './blobs.js';
import type { DatabaseConnection, Migration, OwnedStorage, StorageBinding } from './types.js';
import { identifier, inspectPostgres, storageNames } from './database.js';
import { StorageError, storageFailure } from './errors.js';
import { openRestoringStorage } from './storage.js';
import { validateRestoredSchema } from './restore-schema.js';

const prefix = 'xunjie-restore/1:';
interface RestoreMarker {
  database: string; owner: StorageOwner; phase: 'prepared' | 'fenced' | 'complete';
  sourceGeneration?: string; generation?: string;
}
async function comment(client: pg.Client, role: string, marker: unknown) {
  const { rows: [row] } = await client.query("SELECT format('COMMENT ON ROLE %I IS %L',$1::text,$2::text) AS sql", [role, prefix + JSON.stringify(marker)]);
  await client.query(row.sql);
}
async function administrator<T>(admin: DatabaseConnection, owner: StorageOwner, action: (client: pg.Client) => Promise<T>): Promise<T> {
  const names = storageNames(owner);
  const client = new pg.Client({ ...admin, connectionTimeoutMillis: 5000, statement_timeout: 10_000, application_name: 'xunjie-storage-restore' });
  client.on('error', () => {});
  let locked = false;
  try {
    await client.connect(); await inspectPostgres(client);
    locked = (await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [names.lock])).rows[0].locked;
    if (!locked) throw new StorageError('migration-busy');
    return await action(client);
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw storageFailure(error); }
  finally { await client.end().catch(() => {}); }
}

/** Reserves an empty restore target. The dump itself must create its schema. */
export async function prepareStorageRestore(options: {
  admin: DatabaseConnection; owner: StorageOwner; password: string;
}): Promise<StorageBinding> {
  const names = storageNames(options.owner);
  if (options.password.length < 16) throw new StorageError('invalid');
  return administrator(options.admin, options.owner, async client => {
    await client.query('BEGIN');
    if ((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1 UNION ALL SELECT 1 FROM pg_roles WHERE rolname IN ($2,$3)', [names.schema, names.role, names.migrator])).rowCount) throw new StorageError('conflict');
    for (const [role, login] of [[names.role, true], [names.migrator, false]] as const) {
      const { rows: [statement] } = await client.query("SELECT format('CREATE ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS %s PASSWORD %L',$1::text,$2::text,$3::text) AS sql", [role, login ? 'LOGIN' : 'NOLOGIN', login ? options.password : null]);
      await client.query(statement.sql);
    }
    const { rows: [database] } = await client.query('SELECT oid::text AS oid FROM pg_database WHERE datname=current_database()');
    const { rows: [privileges] } = await client.query(`SELECT has_schema_privilege($1,'public','CREATE') OR has_database_privilege($1,current_database(),'CREATE') AS unsafe`, [names.role]);
    if (privileges.unsafe) throw new StorageError('forbidden');
    const marker: RestoreMarker = { database: database.oid, owner: options.owner, phase: 'prepared' };
    await comment(client, names.migrator, marker);
    await comment(client, names.role, marker);
    await client.query(`GRANT CREATE ON DATABASE ${identifier(options.admin.database)} TO ${identifier(names.migrator)}`);
    await client.query('COMMIT');
    return { owner: { ...options.owner }, schema: names.schema, migratorRole: names.migrator,
      connection: { ...options.admin, user: names.role, password: options.password } };
  });
}

/** Verifies a restored owner without creating business requests or opening gates. */
export async function finalizeStorageRestore(options: {
  binding: StorageBinding; admin: DatabaseConnection; migrations: readonly Migration[];
  manifest: StorageManifest; backend: BlobBackend;
}): Promise<OwnedStorage> {
  const { binding, admin, migrations, manifest, backend } = options;
  const names = storageNames(binding.owner);
  if (binding.schema !== names.schema || binding.connection.user !== names.role || binding.migratorRole !== names.migrator
    || binding.connection.host !== admin.host || binding.connection.port !== admin.port || binding.connection.database !== admin.database) throw new StorageError('forbidden');
  return administrator(admin, binding.owner, async client => {
    const { rows: [row] } = await client.query(`SELECT shobj_description(r.oid,'pg_authid') AS marker,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database FROM pg_roles r WHERE rolname=$1`, [names.migrator]);
    if (!row?.marker?.startsWith(prefix)) throw new StorageError('forbidden');
    let marker: RestoreMarker;
    try { marker = JSON.parse(row.marker.slice(prefix.length)); } catch { throw new StorageError('forbidden'); }
    if (marker.database !== row.database || marker.owner?.environmentId !== binding.owner.environmentId || marker.owner?.serviceId !== binding.owner.serviceId
      || !['prepared','fenced','complete'].includes(marker.phase)) throw new StorageError('forbidden');
    if (marker.phase === 'complete') throw new StorageError('conflict');
    const roles = (await client.query(`SELECT rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
      shobj_description(oid,'pg_authid') AS marker,
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS memberships
      FROM pg_roles r WHERE rolname IN ($1,$2)`, [names.role,names.migrator])).rows;
    if (roles.length !== 2 || roles.some(role => role.marker !== row.marker || role.rolcanlogin !== (role.rolname === names.role)
      || role.rolinherit || role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls || role.memberships)) throw new StorageError('forbidden');
    // This reservation owns these roles. Revocation survives every subsequent
    // validation failure, including an absent or wrong-owner schema.
    await client.query(`REVOKE CREATE ON DATABASE ${identifier(admin.database)} FROM ${identifier(names.migrator)}`);
    const { rows: [schema] } = await client.query('SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1', [names.schema]);
    if (schema?.owner !== names.migrator) throw new StorageError('incompatible');
    // Commit the fence and revoke temporary DDL authority before fallible checks.
    // A failed validation remains inaccessible through the public open interface.
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${identifier(names.schema)}, pg_catalog`);
    const { rows: identities } = await client.query('SELECT * FROM _storage_identity FOR UPDATE');
    const identity = identities[0];
    if (identities.length !== 1 || !identity || identity.environment_id !== binding.owner.environmentId || identity.service_id !== binding.owner.serviceId || identity.core_version !== 1) throw new StorageError('incompatible');
    if (marker.phase === 'prepared') {
      if (identity.writes_open || identity.dispatch_open) throw new StorageError('maintenance');
      const { rows: [fenced] } = await client.query('UPDATE _storage_identity SET writes_open=false,dispatch_open=false,generation=generation+1 RETURNING generation');
      marker = { ...marker, phase: 'fenced', sourceGeneration: identity.generation, generation: fenced.generation };
      await comment(client, names.migrator, marker); await comment(client, names.role, marker);
    } else if (identity.generation !== marker.generation || identity.writes_open || identity.dispatch_open) throw new StorageError('stale-generation');
    await client.query(`REVOKE ALL ON SCHEMA ${identifier(names.schema)} FROM PUBLIC`);
    await client.query(`GRANT USAGE ON SCHEMA ${identifier(names.schema)} TO ${identifier(names.role)}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${identifier(names.schema)} TO ${identifier(names.role)}`);
    await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${identifier(names.schema)} TO ${identifier(names.role)}`);
    await client.query('COMMIT');
    if (manifest.generation !== marker.sourceGeneration) throw new StorageError('incompatible');
    const backup = await client.query(`SELECT 1 FROM ${identifier(names.schema)}._storage_backups WHERE backup_id=$1 AND manifest=$2::jsonb`, [manifest.backupId, JSON.stringify(manifest)]);
    if (backup.rowCount !== 1) throw new StorageError('incompatible');
    if ((await client.query(`SELECT 1 FROM ${identifier(names.schema)}._storage_resources WHERE state IN ('uploading','deleting') LIMIT 1`)).rowCount) throw new StorageError('resource-busy');
    const restored = await openRestoringStorage({ binding, migrations, backend });
    try {
      await validateRestoredSchema(client, binding, migrations);
      await restored.validateManifest(manifest);
      await restored.participant().validate();
      await client.query('BEGIN');
      await comment(client, names.migrator, { ...marker, phase: 'complete' });
      await comment(client, names.role, { ...marker, phase: 'complete' });
      await client.query('COMMIT');
      return restored;
    } catch (error) { await restored.close(); throw error; }
  });
}
