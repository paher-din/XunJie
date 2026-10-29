import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { coreSchema, identifier, migrationPlan } from './database.js';
import type { Migration, StorageBinding } from './types.js';
import { StorageError } from './errors.js';

async function shape(client: pg.Client, schema: string): Promise<string> {
  await client.query(`SET LOCAL search_path TO ${identifier(schema)}, pg_catalog`);
  const relations = (await client.query(`SELECT c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,
    pg_get_expr(c.relpartbound,c.oid) AS partition,
    CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,true) END AS view,
    (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,
      pg_get_expr(d.adbin,d.adrelid),co.collname) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      LEFT JOIN pg_collation co ON co.oid=a.attcollation
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
    (SELECT jsonb_agg(jsonb_build_array(k.conname,pg_get_constraintdef(k.oid,true),k.convalidated) ORDER BY k.conname)
      FROM pg_constraint k WHERE k.conrelid=c.oid) AS constraints,
    (SELECT jsonb_agg(jsonb_build_array(i.relname,pg_get_indexdef(i.oid),x.indisvalid,x.indisready) ORDER BY i.relname)
      FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=c.oid) AS indexes,
    (SELECT jsonb_agg(pg_get_triggerdef(t.oid,true) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS triggers,
    (SELECT jsonb_agg(jsonb_build_array(p.polname,p.polcmd,p.polpermissive,p.polroles::text,pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname)
      FROM pg_policy p WHERE p.polrelid=c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind NOT IN ('i','I','t') ORDER BY c.relname`, [schema])).rows;
  const sequences = (await client.query(`SELECT c.relname,s.seqtypid::regtype::text,s.seqstart::text,s.seqincrement::text,s.seqmax::text,s.seqmin::text,s.seqcache::text,s.seqcycle,
    t.relname AS owned_table,a.attname AS owned_column
    FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype IN ('a','i')
    LEFT JOIN pg_class t ON t.oid=d.refobjid LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
    WHERE n.nspname=$1 ORDER BY c.relname`, [schema])).rows;
  const functions = (await client.query(`SELECT p.proname,pg_get_functiondef(p.oid) AS definition FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.prokind<>'a' ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)`, [schema])).rows;
  const enums = (await client.query(`SELECT t.typname,e.enumlabel FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    JOIN pg_enum e ON e.enumtypid=t.oid WHERE n.nspname=$1 ORDER BY t.typname,e.enumsortorder`, [schema])).rows;
  return JSON.stringify({ relations, sequences, functions, enums }).replaceAll(schema, '__owner__');
}

/** Rebuild the registered DDL in a disposable transaction and compare actual catalogs. */
export async function validateRestoredSchema(client: pg.Client, binding: StorageBinding, migrations: readonly Migration[]): Promise<void> {
  const scratch = 'xj_restore_check_' + randomUUID().replaceAll('-', '');
  let expected: string;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${identifier(scratch)} AUTHORIZATION ${identifier(binding.migratorRole)}`);
    await client.query(`SET LOCAL ROLE ${identifier(binding.migratorRole)}`);
    await client.query(`SET LOCAL search_path TO ${identifier(scratch)}, pg_catalog`);
    await client.query(coreSchema);
    for (const migration of migrationPlan(migrations)) await client.query(migration.sql);
    expected = await shape(client, scratch);
  } catch { throw new StorageError('incompatible'); }
  finally { await client.query('ROLLBACK'); }

  try {
    await client.query('BEGIN');
    if (await shape(client, binding.schema) !== expected) throw new StorageError('incompatible');
    const foreign = await client.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND pg_get_userbyid(c.relowner)<>$2 LIMIT 1`, [binding.schema, binding.migratorRole]);
    if (foreign.rowCount) throw new StorageError('incompatible');
    // A valid catalog flag does not prove that rows loaded with disabled
    // triggers obey the constraint. Revalidate duplicate checks/FKs in rollback.
    const constraints = (await client.query(`SELECT c.relname,pg_get_constraintdef(k.oid,true) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND k.contype IN ('f','c') ORDER BY c.relname,k.conname`, [binding.schema])).rows;
    for (const constraint of constraints) {
      try {
        await client.query(`ALTER TABLE ${identifier(constraint.relname)} ADD CONSTRAINT ${identifier('xj_check_' + randomUUID().replaceAll('-',''))} ${constraint.definition}`);
      } catch (error) {
        if (['23503','23514'].includes((error as { code: string }).code)) throw new StorageError('corrupt');
        throw error;
      }
    }
    // Use the real login's grants. Never call nextval: sequence advancement is
    // not rolled back by PostgreSQL. The probe must leave no business effects.
    await client.query(`SET LOCAL ROLE ${identifier(binding.connection.user)}`);
    await client.query(`SET LOCAL search_path TO ${identifier(binding.schema)}, pg_catalog`);
    const tables = (await client.query(`SELECT c.relname,array_agg(a.attname::text ORDER BY a.attnum) FILTER(WHERE a.attgenerated='') AS columns,
      array_agg(a.attname::text ORDER BY a.attnum) FILTER(WHERE a.attgenerated='' AND a.attidentity<>'a') AS updatable
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE n.nspname=$1 AND c.relkind IN ('r','p') GROUP BY c.relname ORDER BY c.relname`, [binding.schema])).rows;
    for (const table of tables) {
      const relation = identifier(table.relname);
      const columns: string[] = (table.columns ?? []).map(identifier);
      const updatable: string[] = (table.updatable ?? []).map(identifier);
      await client.query(`SELECT * FROM ${relation} LIMIT 1`);
      if (columns.length) {
        await client.query(`UPDATE ${relation} SET ${updatable.length ? updatable.map(column => `${column}=${column}`).join(',') : `${columns[0]}=DEFAULT`} WHERE false`);
        await client.query(`INSERT INTO ${relation} (${columns.join(',')}) OVERRIDING SYSTEM VALUE SELECT ${columns.join(',')} FROM ${relation} WHERE false`);
      }
      await client.query(`DELETE FROM ${relation} WHERE false`);
    }
    const probe = await client.query('UPDATE _storage_identity SET core_version=core_version RETURNING core_version');
    if (probe.rowCount !== 1 || probe.rows[0].core_version !== 1) throw new StorageError('incompatible');
    const sequences = (await client.query(`SELECT c.relname,s.seqincrement::text,t.relname AS table_name,a.attname AS column_name
      FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype IN ('a','i')
      LEFT JOIN pg_class t ON t.oid=d.refobjid LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
      WHERE n.nspname=$1`, [binding.schema])).rows;
    for (const sequence of sequences) {
      const { rows: [state] } = await client.query(`SELECT last_value::text,is_called FROM ${identifier(sequence.relname)}`);
      const { rows: [privilege] } = await client.query("SELECT has_sequence_privilege(current_user,$1,'USAGE') AS allowed", [`${identifier(binding.schema)}.${identifier(sequence.relname)}`]);
      if (!privilege.allowed) throw new StorageError('forbidden');
      if (sequence.table_name) {
        const increment = BigInt(sequence.seqincrement);
        const next = BigInt(state.last_value) + (state.is_called ? increment : 0n);
        const { rows: [edge] } = await client.query(`SELECT ${increment > 0n ? 'max' : 'min'}(${identifier(sequence.column_name)})::text AS value FROM ${identifier(sequence.table_name)}`);
        if (edge.value !== null && (increment > 0n ? next <= BigInt(edge.value) : next >= BigInt(edge.value))) throw new StorageError('corrupt');
      }
    }
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  } finally { await client.query('ROLLBACK'); }
}
