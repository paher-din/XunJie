import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RuntimeResources } from './postgres.js';
import { pgTool } from './postgres.js';
import { RecoveryError } from './recovery.js';

export interface RecoveryDatabaseConnection {
  host: string; port: number; database: string; user: string; password: string; ssl?: { ca: string };
}
/** Secrets never enter argv, a manifest, inherited PG config, or a child diagnostic. */
export async function recoveryPg(options: { resources: RuntimeResources; connection: RecoveryDatabaseConnection;
  tool: 'pg_dump' | 'pg_restore'; args: string[]; signal: AbortSignal }) {
  const escape = (value: string) => value.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
  const { connection } = options;
  if (Object.values(connection).some(value => typeof value === 'string' && /[\r\n\0]/.test(value))) throw new RecoveryError('invalid-database-configuration');
  const temporary = await mkdtemp(join(tmpdir(), 'xunjie-pg-recovery-'));
  await chmod(temporary, 0o700);
  try {
    const passfile = join(temporary, 'pgpass');
    await writeFile(passfile, [connection.host, String(connection.port), connection.database, connection.user, connection.password].map(escape).join(':') + '\n', { mode: 0o600 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG/.test(key) && !['NODE_OPTIONS', 'NODE_PATH'].includes(key)));
    Object.assign(env, { PGPASSFILE: passfile, PGCONNECT_TIMEOUT: '5', PGSSLMODE: connection.ssl ? 'verify-full' : 'disable', PGOPTIONS: '-c timezone=UTC' });
    if (connection.ssl) {
      const certificate = join(temporary, 'ca.pem');
      await writeFile(certificate, connection.ssl.ca, { mode: 0o600 }); env.PGSSLROOTCERT = certificate;
    }
    try {
      await promisify(execFile)(pgTool(options.resources, options.tool), ['-h', connection.host, '-p', String(connection.port),
        '-U', connection.user, '-d', connection.database, '--no-password', ...options.args],
      { env, windowsHide: true, signal: options.signal, timeout: 120_000, maxBuffer: 1024 * 1024 });
    } catch (error) {
      // pg tools can quote SQL literals and configuration; retain only a bounded error category.
      const text = String((error as { stderr?: string }).stderr ?? '');
      throw new RecoveryError(/No space left|disk full/i.test(text) ? 'insufficient-space'
        : /unsupported version|server version mismatch/i.test(text) ? 'incompatible-engine' : 'postgres-tool-failed');
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
