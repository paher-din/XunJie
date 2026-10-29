import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { atomicJson, exists, readJson } from './io.js';

const exec = promisify(execFile);
export interface RuntimeResources {
  nodePath: string;
  nodeVersion: string;
  postgresBin?: string;
  postgresVersion?: string;
  windowsPrerequisitePath?: string;
  webRoot: string;
}
export type DatabaseConfiguration = { mode: 'managed' } | { mode: 'none' } | {
  mode: 'external'; host: string; port: number; database: string; user: string; credentialRef: string;
  ssl?: { ca: string };
};
export interface DatabaseBinding {
  host: string; port: number; database: string; user: string; credentialRef: string;
  ssl?: { ca: string };
}
interface ManagedDatabase { binding: DatabaseBinding; systemIdentifier?: string; version: string }
interface DatabasePreparation { database: ManagedDatabase; directory: string; initialized: boolean }

export const pgTool = (resources: RuntimeResources, name: string): string => {
  if (!resources.postgresBin) throw new Error('This deployment needs the bundled PostgreSQL resource.');
  return join(resources.postgresBin, name + (process.platform === 'win32' ? '.exe' : ''));
};
export async function runPg(resources: RuntimeResources, tool: string, args: string[]): Promise<string> {
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C', PGCONNECT_TIMEOUT: '5' };
  if (process.platform === 'win32' && tool === 'pg_ctl' && args[0] === 'start') {
    // On Windows the started server can retain pg_ctl's output pipe handles.
    // pg_ctl -w's exit is the startup result; waiting for pipe close would wait
    // for the server to stop. Keep its diagnostics, then release our pipe ends.
    const child = spawn(pgTool(resources, tool), args, { windowsHide: true, shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-64 * 1024); });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-64 * 1024); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60_000);
    try {
      const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
      if (code !== 0 || timedOut) throw Object.assign(new Error(stderr.trim() || stdout.trim() || 'PostgreSQL startup failed.'), {
        code: timedOut ? 'ETIMEDOUT' : code, signal,
      });
      return stdout;
    } finally {
      clearTimeout(timer);
      child.stdout.destroy(); child.stderr.destroy();
    }
  }
  const { stdout } = await exec(pgTool(resources, tool), args, {
    windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    env,
  });
  return stdout;
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}

export async function resolveCredential(root: string, ref: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(ref)) throw new Error('Invalid credential reference.');
  return readFile(join(root, 'credentials', ref), 'utf8');
}

export async function storeCredential(root: string, ref: string, value: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(ref) || !value) throw new Error('Invalid credential.');
  await mkdir(join(root, 'credentials'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'credentials', ref), value, { mode: 0o600, flag: 'wx' });
}

export async function prepareDatabase(root: string, resources: RuntimeResources): Promise<void> {
  if (!resources.postgresVersion || !/^\d+\.\d+$/.test(resources.postgresVersion)) throw new Error('A pinned PostgreSQL version is required.');
  for (const tool of ['postgres', 'initdb', 'pg_ctl', 'pg_controldata', 'psql', 'pg_dump', 'pg_dumpall', 'pg_restore', 'pg_upgrade']) {
    const version = await runPg(resources, tool, ['--version']);
    if (/\(PostgreSQL\) (\d+\.\d+)(?:\s|$)/.exec(version)?.[1] !== resources.postgresVersion) throw new Error(`Unexpected ${tool} version.`);
  }
  if (await exists(join(root, 'database.json'))) return;
  const journal = join(root, 'preparing-database.json');
  let preparation: DatabasePreparation;
  if (await exists(journal)) preparation = await readJson<DatabasePreparation>(journal);
  else {
    if (await exists(join(root, 'pgdata'))) throw new Error('Unregistered database directory; existing data is preserved.');
    const credentialRef = `postgres-${randomUUID()}`;
    await storeCredential(root, credentialRef, randomBytes(32).toString('base64url'));
    preparation = { directory: `initializing-${randomUUID()}`, initialized: false,
      database: { binding: { host: '127.0.0.1', port: await freePort(), database: 'postgres', user: 'xunjie', credentialRef },
        version: resources.postgresVersion } };
    await atomicJson(journal, preparation);
  }
  if (!/^initializing-[0-9a-f-]{36}$/.test(preparation.directory) || preparation.database.version !== resources.postgresVersion) {
    throw new Error('Unsupported database preparation journal; existing data is preserved.');
  }
  const temporary = join(root, preparation.directory);
  const passwordFile = join(root, 'initdb-password');
  try {
    if (!preparation.initialized) {
      if (await exists(join(root, 'pgdata'))) throw new Error('Unexpected database directory; existing data is preserved.');
      // Only an unpublished initdb staging directory can be discarded. Product
      // processes never accept connections against this directory.
      await rm(temporary, { recursive: true, force: true });
      await rm(passwordFile, { force: true });
      await writeFile(passwordFile, await resolveCredential(root, preparation.database.binding.credentialRef), { mode: 0o600, flag: 'wx' });
      await runPg(resources, 'initdb', ['-D', temporary, '-U', 'xunjie', '--auth=scram-sha-256',
        '--encoding=UTF8', '--locale=C', '--locale-provider=libc', `--pwfile=${passwordFile}`]);
      const control = await runPg(resources, 'pg_controldata', ['-D', temporary]);
      const systemIdentifier = /Database system identifier:\s+(\d+)/.exec(control)?.[1];
      if (!systemIdentifier) throw new Error('Cannot identify the initialized PostgreSQL cluster.');
      preparation = { ...preparation, initialized: true, database: { ...preparation.database, systemIdentifier } };
      await atomicJson(journal, preparation);
    }
    if (!await exists(join(root, 'pgdata'))) await rename(temporary, join(root, 'pgdata'));
    const control = await runPg(resources, 'pg_controldata', ['-D', join(root, 'pgdata')]);
    if (!control.includes(` ${preparation.database.systemIdentifier}`)) throw new Error('Prepared database identity mismatch.');
    await atomicJson(join(root, 'database.json'), preparation.database);
    await rm(journal, { force: true });
  } finally {
    await rm(passwordFile, { force: true });
  }
}

export async function databaseBinding(root: string, config: DatabaseConfiguration): Promise<DatabaseBinding | null> {
  if (config.mode === 'none') return null;
  if (config.mode === 'external') { const { mode: _, ...binding } = config; return binding; }
  return (await readJson<ManagedDatabase>(join(root, 'database.json'))).binding;
}

export async function inspectDatabase(root: string, config: DatabaseConfiguration, verifyConfiguration = true, bindExternal = false): Promise<{ version: string; systemIdentifier: string }> {
  const binding = await databaseBinding(root, config);
  if (!binding) throw new Error('No database configured.');
  const { credentialRef, ...options } = binding;
  const client = new pg.Client({ ...options, password: await resolveCredential(root, credentialRef),
    connectionTimeoutMillis: 2500, query_timeout: 2500, application_name: 'xunjie-product-runtime' });
  try {
    await client.connect();
    const identity = ", (SELECT system_identifier::text FROM pg_control_system()) AS identifier"
      + (config.mode === 'managed' ? ", current_setting('data_directory') AS directory" : '');
    const { rows: [row] } = await client.query(`SELECT current_setting('server_version') AS version,
      current_setting('server_encoding') AS encoding, current_setting('TimeZone') AS timezone,
      datcollate AS collate, oid::text AS database_oid ${identity} FROM pg_database WHERE datname = current_database()`);
    if (!row || (verifyConfiguration && (Number.parseInt(row.version) !== 18 || row.encoding !== 'UTF8' || row.timezone !== 'UTC' || row.collate !== 'C'))) {
      throw new Error('PostgreSQL requires major 18, UTF8, UTC and C collation.');
    }
    if (config.mode === 'managed') {
      const metadata = await readJson<ManagedDatabase>(join(root, 'database.json'));
      if (await realpath(row.directory) !== await realpath(join(root, 'pgdata')) || (metadata.systemIdentifier && metadata.systemIdentifier !== row.identifier)) {
        throw new Error('Database identity mismatch; refusing to manage this process.');
      }
      if (!metadata.systemIdentifier) await atomicJson(join(root, 'database.json'), { ...metadata, systemIdentifier: row.identifier });
    } else {
      const path = join(root, 'external-database.json');
      const actual = { systemIdentifier: row.identifier as string, databaseOid: row.database_oid as string };
      if (await exists(path)) {
        const expected = await readJson<typeof actual>(path);
        if (expected.systemIdentifier !== actual.systemIdentifier || expected.databaseOid !== actual.databaseOid) {
          throw new Error('External database identity mismatch; refusing to switch data owner.');
        }
      } else if (bindExternal) await atomicJson(path, actual);
      else throw new Error('External database identity must be bound during installation.');
    }
    return { version: row.version as string, systemIdentifier: row.identifier as string };
  } finally { await client.end().catch(() => {}); }
}

export async function startDatabase(root: string, resources: RuntimeResources, config: DatabaseConfiguration): Promise<void> {
  if (config.mode === 'none') return;
  if (config.mode === 'external') { await inspectDatabase(root, config); return; }
  const data = join(root, 'pgdata');
  const major = (await readFile(join(data, 'PG_VERSION'), 'utf8')).trim();
  if (major !== resources.postgresVersion?.split('.')[0]) throw new Error('PostgreSQL major upgrade requires the recovery workflow; data is preserved.');
  let running = false;
  try { await runPg(resources, 'pg_ctl', ['status', '-D', data]); running = true; }
  catch (error) { if ((error as { code?: number }).code !== 3) throw error; }
  if (!running) {
    const { binding } = await readJson<ManagedDatabase>(join(root, 'database.json'));
    await runPg(resources, 'pg_ctl', ['start', '-D', data, '-l', join(root, 'postgres.log'), '-w', '-t', '30',
      '-o', `-h 127.0.0.1 -p ${binding.port} -c timezone=UTC -c unix_socket_directories=${process.platform === 'win32' ? '' : "''"}`]);
  }
  await inspectDatabase(root, config);
}

export async function stopDatabase(root: string, resources: RuntimeResources, config: DatabaseConfiguration): Promise<void> {
  if (config.mode !== 'managed') return;
  try { await runPg(resources, 'pg_ctl', ['status', '-D', join(root, 'pgdata')]); }
  catch (error) { if ((error as { code?: number }).code === 3) return; throw error; }
  await inspectDatabase(root, config, false);
  await runPg(resources, 'pg_ctl', ['stop', '-D', join(root, 'pgdata'), '-m', 'fast', '-w', '-t', '30']);
}
