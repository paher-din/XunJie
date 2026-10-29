import { createHash } from 'node:crypto';
import pg from 'pg';
import { storageOwnerSchema } from '@xunjie/contracts/storage';
import type { StorageOwner } from '@xunjie/contracts/storage';
import type { DatabaseConnection, Migration, StorageBinding } from './types.js';
import { StorageError, storageFailure } from './errors.js';

export const identifier = (value: string): string => '"' + value.replaceAll('"', '""') + '"';
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export function storageNames(owner: StorageOwner) {
  if (!storageOwnerSchema.safeParse(owner).success) throw new StorageError('invalid');
  const hash = digest(`${owner.environmentId}/${owner.serviceId}`).slice(0, 32);
  return { schema: `xjs_${hash}`, role: `xju_${hash}`, migrator: `xjm_${hash}`, lock: BigInt('0x' + hash.slice(0, 15)).toString() };
}

export function migrationPlan(migrations: readonly Migration[]) {
  if (migrations.some((item, index) => item.version !== index + 1 || !item.name || !item.sql.trim())) throw new StorageError('incompatible');
  return migrations.map(item => ({ ...item, checksum: digest(`${item.version}\n${item.name}\n${item.sql}`) }));
}

export async function inspectPostgres(client: pg.Client | pg.PoolClient): Promise<void> {
  const { rows: [row] } = await client.query(`SELECT current_setting('server_version_num') AS version,
    current_setting('server_encoding') AS encoding, current_setting('TimeZone') AS timezone,
    datcollate, datctype, datlocprovider FROM pg_database WHERE datname=current_database()`);
  const extensions = (await client.query('SELECT extname FROM pg_extension ORDER BY extname')).rows.map(row => row.extname);
  if (!row || row.version !== '180006' || row.encoding !== 'UTF8' || row.timezone !== 'UTC'
    || row.datcollate !== 'C' || row.datctype !== 'C' || row.datlocprovider !== 'c'
    || extensions.join(',') !== 'plpgsql') throw new StorageError('incompatible');
}

export const coreSchema = `
  CREATE TABLE IF NOT EXISTS _storage_identity (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    environment_id uuid NOT NULL, service_id uuid NOT NULL, core_version integer NOT NULL,
    generation bigint NOT NULL DEFAULT 1, writes_open boolean NOT NULL DEFAULT true,
    dispatch_open boolean NOT NULL DEFAULT true
  );
  CREATE TABLE IF NOT EXISTS _storage_migrations (
    version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );
  CREATE TABLE IF NOT EXISTS _storage_requests (
    request_id text PRIMARY KEY, fingerprint text NOT NULL, result jsonb,
    committed_at timestamptz
  );
  CREATE TABLE IF NOT EXISTS _storage_outbox (
    intent_id text PRIMARY KEY, request_id text NOT NULL REFERENCES _storage_requests,
    payload jsonb NOT NULL, completed_at timestamptz
  );
  CREATE TABLE IF NOT EXISTS _storage_resources (
    resource_id uuid PRIMARY KEY, reference jsonb NOT NULL, state text NOT NULL
      CHECK(state IN ('uploading','ready','failed','deleting','deleted')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), error_code text
  );
  CREATE TABLE IF NOT EXISTS _storage_references (
    reference_id text PRIMARY KEY, resource_id uuid NOT NULL REFERENCES _storage_resources
  );
  CREATE TABLE IF NOT EXISTS _storage_backups (
    backup_id text PRIMARY KEY, manifest jsonb NOT NULL
  );
  CREATE TABLE IF NOT EXISTS _storage_pins (
    backup_id text NOT NULL REFERENCES _storage_backups ON DELETE CASCADE,
    resource_id uuid NOT NULL REFERENCES _storage_resources,
    PRIMARY KEY (backup_id,resource_id)
  );
`;

/** Administrator-only assembly. Modules never receive this credential or a pool using it. */
export async function provisionStorage(options: {
  admin: DatabaseConnection; owner: StorageOwner; password: string; migrations: readonly Migration[];
}): Promise<StorageBinding> {
  const parsed = storageOwnerSchema.safeParse(options.owner);
  if (!parsed.success) throw new StorageError('invalid');
  const owner = parsed.data;
  const names = storageNames(owner);
  const plan = migrationPlan(options.migrations);
  if (options.password.length < 16) throw new StorageError('invalid');
  const client = new pg.Client({ ...options.admin, connectionTimeoutMillis: 5000, application_name: 'xunjie-storage-migration' });
  client.on('error', () => {});
  let locked = false;
  try {
    await client.connect();
    await inspectPostgres(client);
    locked = (await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [names.lock])).rows[0].locked;
    if (!locked) throw new StorageError('migration-busy');
    await client.query('BEGIN');
    // Roles and schemas share the transaction with the migration journal.
    for (const [role, login] of [[names.role, true], [names.migrator, false]] as const) {
      const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount;
      if (!exists) {
        const { rows: [statement] } = await client.query(login
          ? "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD %L', $1::text,$2::text) AS sql"
          : "SELECT format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION', $1::text) AS sql", login ? [role, options.password] : [role]);
        await client.query(statement.sql);
      }
    }
    const schema = identifier(names.schema), migrator = identifier(names.migrator), role = identifier(names.role);
    const existingSchema = (await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [names.schema])).rowCount;
    if (!existingSchema) await client.query(`CREATE SCHEMA ${schema} AUTHORIZATION ${migrator}`);
    const { rows: [authority] } = await client.query(`SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1`, [names.schema]);
    if (authority.owner !== names.migrator) throw new StorageError('incompatible');
    await client.query(`SET LOCAL ROLE ${migrator}`);
    await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    await client.query(coreSchema);
    await client.query(`INSERT INTO _storage_identity(singleton,environment_id,service_id,core_version)
      VALUES(true,$1,$2,1) ON CONFLICT DO NOTHING`, [owner.environmentId, owner.serviceId]);
    const { rows: [state] } = await client.query('SELECT * FROM _storage_identity FOR UPDATE');
    if (state.environment_id !== owner.environmentId || state.service_id !== owner.serviceId || state.core_version !== 1) throw new StorageError('incompatible');
    const recorded = (await client.query('SELECT version,name,checksum FROM _storage_migrations ORDER BY version')).rows;
    if (recorded.some((row, i) => row.version !== plan[i]?.version || row.checksum !== plan[i]?.checksum || row.name !== plan[i]?.name)) throw new StorageError('incompatible');
    const upgrading = Boolean(existingSchema) && recorded.length < plan.length;
    if (upgrading && (state.writes_open || state.dispatch_open)) throw new StorageError('maintenance');
    if (upgrading && (await client.query("SELECT 1 FROM _storage_resources WHERE state IN ('uploading','deleting') LIMIT 1")).rowCount) throw new StorageError('resource-busy');
    for (const item of plan.slice(recorded.length)) {
      await client.query(item.sql);
      await client.query('INSERT INTO _storage_migrations(version,name,checksum) VALUES($1,$2,$3)', [item.version,item.name,item.checksum]);
    }
    if (upgrading) {
      // Fence even an old-code handle opened *after* maintenance closed but
      // before the new schema was applied.
      await client.query('UPDATE _storage_identity SET generation=generation+1');
    }
    await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
    await client.query('COMMIT');
    return { owner, schema: names.schema, connection: { ...options.admin, user: names.role, password: options.password } };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw storageFailure(error);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1::bigint)', [names.lock]).catch(() => {});
    await client.end().catch(() => {});
  }
}

export async function verifyBinding(client: pg.PoolClient, binding: StorageBinding, migrations: readonly Migration[]) {
  const names = storageNames(binding.owner);
  if (binding.schema !== names.schema || binding.connection.user !== names.role) throw new StorageError('forbidden');
  await inspectPostgres(client);
  const { rows: [role] } = await client.query(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
    has_schema_privilege(current_user,'public','CREATE') AS public_create,
    has_schema_privilege(current_user,$1,'CREATE') AS owner_create,
    EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS memberships
    FROM pg_roles WHERE rolname=current_user`, [names.schema]);
  if (!role || Object.values(role).some(Boolean)) throw new StorageError('forbidden');
  await client.query(`SET search_path TO ${identifier(names.schema)}, pg_catalog`);
  const { rows: [state] } = await client.query('SELECT * FROM _storage_identity');
  if (!state || state.environment_id !== binding.owner.environmentId || state.service_id !== binding.owner.serviceId || state.core_version !== 1) throw new StorageError('incompatible');
  const expected = migrationPlan(migrations);
  const actual = (await client.query('SELECT version,name,checksum FROM _storage_migrations ORDER BY version')).rows;
  if (actual.length !== expected.length || actual.some((row, i) => row.version !== expected[i]?.version || row.name !== expected[i]?.name || row.checksum !== expected[i]?.checksum)) throw new StorageError('incompatible');
  return state.generation as string;
}
