import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, connect as tcpConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import pg from 'pg';
import { createProductRuntimeHost, openProductRuntime, resolveCredential } from '@xunjie/product-runtime';

const exec = promisify(execFile);
const bin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!bin) throw new Error('Set XUNJIE_PRODUCT_POSTGRES_BIN to the pinned complete PostgreSQL 18.6 distribution.');
const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin: bin, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) };
const tool = name => join(bin, name + (process.platform === 'win32' ? '.exe' : ''));

async function client(root, runtime) {
  const { credentialRef, ...binding } = await runtime.database();
  const connection = new pg.Client({ ...binding, password: await resolveCredential(root, credentialRef) });
  connection.on('error', () => {});
  await connection.connect();
  return connection;
}

test('native PostgreSQL preserves committed data and discards an interrupted transaction after SIGKILL', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), '循阶 PG 运行 '));
  const rootA = join(directory, '环境 A');
  const rootB = join(directory, '环境 B');
  const a = openProductRuntime({ root: rootA, resources });
  const b = openProductRuntime({ root: rootB, resources });
  let first; let pending; let restored; let peer;
  try {
    const installed = await a.install({ profile: 'local' });
    await b.install({ profile: 'local' });
    const started = await a.start();
    assert.equal(started.state, 'ready', JSON.stringify(started));
    assert.equal((await b.start()).state, 'ready');
    first = await client(rootA, a);
    peer = await client(rootB, b);
    assert.notEqual((await first.query('SELECT system_identifier FROM pg_control_system()')).rows[0].system_identifier,
      (await peer.query('SELECT system_identifier FROM pg_control_system()')).rows[0].system_identifier);
    await first.query('CREATE TABLE runtime_probe (id integer PRIMARY KEY, value text NOT NULL)');
    await first.query('INSERT INTO runtime_probe VALUES (1, $1)', ['已确认保存 / committed']);
    pending = await client(rootA, a);
    await pending.query('BEGIN');
    await pending.query('INSERT INTO runtime_probe VALUES (2, $1)', ['未提交 / must disappear']);
    const { stdout } = await exec(tool('pg_ctl'), ['status', '-D', join(rootA, 'pgdata')]);
    const pid = Number(/PID: (\d+)/.exec(stdout)?.[1]);
    assert.ok(pid > 0, 'pg_ctl must identify the postmaster owned by this test environment');
    process.kill(pid, 'SIGKILL');
    await first.end().catch(() => {}); first = undefined;
    await pending.end().catch(() => {}); pending = undefined;
    await a.stop();
    assert.equal((await b.status()).state, 'ready');
    assert.equal((await a.start()).state, 'ready');
    restored = await client(rootA, a);
    assert.deepEqual((await restored.query('SELECT * FROM runtime_probe ORDER BY id')).rows,
      [{ id: 1, value: '已确认保存 / committed' }]);
    assert.equal((await a.status()).environment.environmentId, installed.environment.environmentId);

    const dump = join(directory, '实际备份.dump');
    const { credentialRef, ...binding } = await a.database();
    const env = { ...process.env, PGPASSWORD: await resolveCredential(rootA, credentialRef), PGCONNECT_TIMEOUT: '5' };
    const connectionArgs = ['-h', binding.host, '-p', String(binding.port), '-U', binding.user];
    await exec(tool('pg_dump'), [...connectionArgs, '-d', binding.database, '-Fc', '-f', dump], { env });
    await restored.query('CREATE DATABASE restored_probe TEMPLATE template0');
    await exec(tool('pg_restore'), [...connectionArgs, '-d', 'restored_probe', '--exit-on-error', dump], { env });
    const recovered = new pg.Client({ ...binding, database: 'restored_probe', password: env.PGPASSWORD });
    await recovered.connect();
    try { assert.deepEqual((await recovered.query('SELECT * FROM runtime_probe ORDER BY id')).rows,
      [{ id: 1, value: '已确认保存 / committed' }]); } finally { await recovered.end(); }
    await restored.end(); restored = undefined;
    await peer.end(); peer = undefined;
    await a.uninstall();
    await a.install({ profile: 'local' });
    assert.equal((await a.start()).state, 'ready');
    restored = await client(rootA, a);
    assert.equal((await restored.query('SELECT value FROM runtime_probe WHERE id=1')).rows[0].value, '已确认保存 / committed');
  } finally {
    await Promise.allSettled([first?.end(), pending?.end(), restored?.end(), peer?.end()]);
    const stopped = await Promise.allSettled([a.stop(), b.stop()]);
    if (stopped.every(result => result.status === 'fulfilled')) await rm(directory, { recursive: true, force: true });
  }
});

test('a database port conflict reports failure and leaves the unrelated listener alive', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), '循阶 PG 冲突 '));
  const runtime = openProductRuntime({ root: directory, resources });
  const foreign = createServer(socket => socket.destroy());
  try {
    await runtime.install({ profile: 'local' });
    const { port } = await runtime.database();
    await new Promise((done, reject) => { foreign.once('error', reject); foreign.listen(port, '127.0.0.1', done); });
    assert.equal((await runtime.start()).state, 'failed');
    assert.equal(foreign.listening, true);
    await runtime.stop();
    assert.equal(foreign.listening, true);
  } finally {
    await new Promise(done => foreign.close(done));
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a school host uses an existing PostgreSQL without owning its process lifecycle', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), '循阶 existing PG '));
  const root = join(directory, 'owner');
  const owner = openProductRuntime({ root, resources });
  const school = openProductRuntime({ root: join(directory, 'school'), resources });
  let connection;
  try {
    await owner.install({ profile: 'local' });
    assert.equal((await owner.start()).state, 'ready');
    const { credentialRef, ...binding } = await owner.database();
    await school.setCredential('existing-postgres', await resolveCredential(root, credentialRef));
    await school.install({ profile: 'school', database: { mode: 'external', ...binding, credentialRef: 'existing-postgres' } });
    assert.equal((await school.start()).state, 'ready');
    await school.stop();
    assert.equal((await owner.status()).state, 'ready');
    connection = await client(root, owner);
    assert.equal((await connection.query('SELECT 42 AS answer')).rows[0].answer, 42);
    await school.uninstall();
    assert.equal((await owner.status()).state, 'ready');
  } finally {
    await connection?.end();
    const results = await Promise.allSettled([owner.stop(), school.stop()]);
    if (results.every(result => result.status === 'fulfilled')) await rm(directory, { recursive: true, force: true });
  }
});

test('a failed PostgreSQL stop can be retried using the already drained maintenance boundary', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), '循阶 stop retry '));
  const runtime = openProductRuntime({ root, resources });
  let host; let connection;
  const password = async value => {
    const { rows } = await connection.query("SELECT format('ALTER ROLE xunjie PASSWORD %L', $1::text) AS statement", [value]);
    await connection.query(rows[0].statement);
  };
  try {
    await runtime.install({ profile: 'local' });
    host = await createProductRuntimeHost({ root });
    connection = await client(root, runtime);
    const original = await resolveCredential(root, (await runtime.database()).credentialRef);
    await password(randomUUID());
    await assert.rejects(host.stop(), /password authentication failed/i);
    assert.equal(host.maintenance.status().safeToStop, true);
    await password(original);
    await connection.end(); connection = undefined;
    await host.stop(); host = undefined;
    assert.equal((await runtime.status()).state, 'stopped');
  } finally {
    await connection?.end();
    await host?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('a compatible database behind the same address cannot silently replace the bound external owner', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), '循阶 database identity '));
  const rootA = join(directory, 'a'); const rootB = join(directory, 'b');
  const a = openProductRuntime({ root: rootA, resources });
  const b = openProductRuntime({ root: rootB, resources });
  const school = openProductRuntime({ root: join(directory, 'school'), resources });
  let destinationPort; let admin;
  const sockets = new Set();
  const proxy = createServer(socket => {
    const upstream = tcpConnect(destinationPort, '127.0.0.1');
    for (const stream of [socket, upstream]) {
      sockets.add(stream); stream.on('error', () => {}); stream.once('close', () => sockets.delete(stream));
    }
    socket.pipe(upstream).pipe(socket);
    socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy());
  });
  try {
    await a.install({ profile: 'local' }); await b.install({ profile: 'local' });
    await a.start(); await b.start();
    const { credentialRef: refA, ...bindingA } = await a.database();
    const secretA = await resolveCredential(rootA, refA);
    admin = await client(rootB, b);
    const { rows } = await admin.query("SELECT format('ALTER ROLE xunjie PASSWORD %L', $1::text) AS statement", [secretA]);
    await admin.query(rows[0].statement);
    destinationPort = bindingA.port;
    await new Promise(done => proxy.listen(0, '127.0.0.1', done));
    await school.setCredential('external', secretA);
    await school.install({ profile: 'school', database: { mode: 'external', ...bindingA,
      port: proxy.address().port, credentialRef: 'external' } });
    assert.equal((await school.start()).state, 'ready');
    destinationPort = (await b.database()).port;
    const changed = await school.status();
    assert.equal(changed.state, 'failed');
    assert.match(changed.dependencies[0].detail, /identity mismatch/i);
    const secretB = await resolveCredential(rootB, (await b.database()).credentialRef);
    const restore = await admin.query("SELECT format('ALTER ROLE xunjie PASSWORD %L', $1::text) AS statement", [secretB]);
    await admin.query(restore.rows[0].statement);
  } finally {
    await admin?.end();
    await school.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise(done => proxy.close(done));
    const stopped = await Promise.allSettled([a.stop(), b.stop()]);
    if (stopped.every(value => value.status === 'fulfilled')) await rm(directory, { recursive: true, force: true });
  }
});
