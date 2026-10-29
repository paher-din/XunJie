import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export async function nativeFixture() {
  const bin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
  if (!bin) throw new Error('XUNJIE_PRODUCT_POSTGRES_BIN must point to the pinned PostgreSQL 18.6 distribution.');
  const root = await mkdtemp(join(tmpdir(), '循阶 storage '));
  const tool = name => join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
  const env = { ...process.env, LANG: 'C', LC_ALL: 'C' };
  const run = async (name, args) => {
    if (process.platform !== 'win32' || name !== 'pg_ctl' || args[0] !== 'start') {
      return exec(tool(name), args, { env, timeout: 60_000 });
    }
    // The Windows postmaster inherits pg_ctl's pipe handles. Startup completes
    // on pg_ctl -w's exit; waiting for pipe close would wait for PG shutdown.
    const child = spawn(tool(name), args, { env, shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60_000);
    try {
      const [code] = await once(child,'exit');
      if (code !== 0 || timedOut) throw new Error(stderr.trim() || stdout.trim() || 'PostgreSQL startup failed.');
      return { stdout, stderr };
    } finally { clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy(); }
  };
  const { stdout } = await run('postgres', ['--version']);
  if (!stdout.includes(' 18.6')) throw new Error('Storage acceptance requires PostgreSQL 18.6.');
  const password = randomBytes(32).toString('base64url');
  const passwordFile = join(root, 'password');
  await writeFile(passwordFile, password, { mode: 0o600 });
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  const data = join(root, 'pgdata');
  try {
    await run('initdb', ['-D', data, '-U', 'storage_admin', '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C', '--locale-provider=libc', `--pwfile=${passwordFile}`]);
    await rm(passwordFile);
    await run('pg_ctl', ['start', '-D', data, '-l', join(root, 'pg.log'), '-w', '-o', `-h 127.0.0.1 -p ${port} -c timezone=UTC -c unix_socket_directories=${process.platform === 'win32' ? '' : "''"}`]);
  } catch (error) {
    await run('pg_ctl', ['stop', '-D', data, '-m', 'fast', '-w']).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }
  return {
    root, tool, run,
    admin: { host: '127.0.0.1', port, database: 'postgres', user: 'storage_admin', password },
    async close() {
      await run('pg_ctl', ['stop', '-D', data, '-m', 'fast', '-w']);
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
