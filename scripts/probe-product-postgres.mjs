#!/usr/bin/env node
// Standalone consumer evidence for issue #143. Never import from product code.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(os.homedir(), '.cache/xunjie-product-runtime');
const target = 'aarch64-apple-darwin';
const releaseBase = 'https://github.com/theseus-rs/postgresql-binaries/releases';
const versions = { old: '17.10', minor: '17.11', new: '18.6' };
// Fixed upstream release asset digests; checked again before executing any PG tool.
const upstream = {
  '17.10.1': { archive: '6a4d10bb443043a5f2759727eb8f281e1ae88563c03a38df8066944d5409fbdb', manifest: 'bc8e5e02a7726f3c7c4749287509f7010f59a6404bdf3f77c7b61d068700c326' },
  '17.11.1': { archive: 'f4b2ff0587d80b6f22bf09ec2d133a3c2949b6423318d3fed0f4ddddddf2f004', manifest: 'c6432ccc963ce3a5ebcdb48a044f27bc872b83c615645482439a16718a9ff694' },
  '18.6.1': { archive: '89e91cc80650a43d22c018b95ca356a0c9e15838a1182fed2880bfb5d7d9c9a6', manifest: '7126c2932b039398d34f3cd8aa44e4765dd9281fe4bd8655ef48c36f6e553102' },
};
const tools = ['postgres', 'initdb', 'pg_ctl', 'psql', 'pg_dump', 'pg_dumpall', 'pg_restore', 'pg_upgrade'];
const usage = `Standalone native PostgreSQL tool probe for XunJie issue #143.

Usage: node scripts/probe-product-postgres.mjs [options]
  --old-bin DIR    PostgreSQL 17.10 tools (release 17.10.1)
  --minor-bin DIR  PostgreSQL 17.11 tools (release 17.11.1)
  --new-bin DIR    PostgreSQL 18.6 tools (release 18.6.1)
  --out FILE       Evidence JSON (default: docs/student-agent-implementation/evidence/wp01-postgres-upgrade.json)
  --help          Print help only; no download, filesystem writes or tool execution

Default bin directories: ~/.cache/xunjie-product-runtime/postgresql-<release>-aarch64-apple-darwin/bin
Only darwin/arm64 is verified by this probe. PostgreSQL is never selected from PATH.
Prepare the upstream .tar.gz and .tar.gz.manifest.json beside each extracted release.
The script does not download; it checks pinned upstream SHA256 and extracted file hashes.
Runs 17.10 -> 17.11 in-place minor, then 17.11 -> 18.6 logical major in new PGDATA.
All clusters, passwords, dumps and logs are temporary and removed after normal shutdown.
This is a tool availability probe, not the WP145 backup/recovery product.
`;

function argumentsFor(argv) {
  const options = {
    'old-bin': path.join(cache, `postgresql-17.10.1-${target}/bin`),
    'minor-bin': path.join(cache, `postgresql-17.11.1-${target}/bin`),
    'new-bin': path.join(cache, `postgresql-18.6.1-${target}/bin`),
    out: path.join(repository, 'docs/student-agent-implementation/evidence/wp01-postgres-upgrade.json'),
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !Object.hasOwn(options, key) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error(`Invalid option: ${argv[i]}. Use --help.`);
    }
    options[key] = path.resolve(argv[++i]);
  }
  return options;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

// Independent expectations, shared by all three engines; never copied from a dump/source query.
const expectedRows = [
  { id: 1, label: '循阶 中文 空格', amount: '1234567890123456.7890', utc: '2026-10-29T00:01:02.123456Z', payload: { 中文: '循阶', list: [1, true, null], nested: { ok: false } }, bytes: '00ff10e4b8ad' },
  { id: 2, label: '第二行 🚀', amount: '-0.0001', utc: '2000-01-01T00:00:00.000001Z', payload: { empty: '', count: 0 }, bytes: 'deadbeef0001' },
];
const fixture = `
CREATE ROLE probe_owner NOLOGIN;
CREATE ROLE probe_reader NOLOGIN;
GRANT probe_reader TO probe_owner;
CREATE SCHEMA "升级 样本" AUTHORIZATION probe_owner;
SET ROLE probe_owner;
CREATE TABLE "升级 样本".records (
  id bigserial CONSTRAINT records_pk PRIMARY KEY,
  label text NOT NULL CONSTRAINT records_label_unique UNIQUE,
  amount numeric(20,4) NOT NULL CONSTRAINT records_amount_check CHECK (amount > -100),
  happened_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  bytes bytea NOT NULL
);
INSERT INTO "升级 样本".records (label, amount, happened_at, payload, bytes) VALUES
('循阶 中文 空格', 1234567890123456.7890, '2026-10-29T00:01:02.123456Z', '{"中文":"循阶","list":[1,true,null],"nested":{"ok":false}}', decode('00ff10e4b8ad','hex')),
('第二行 🚀', -0.0001, '2000-01-01T00:00:00.000001Z', '{"empty":"","count":0}', decode('deadbeef0001','hex'));
GRANT USAGE ON SCHEMA "升级 样本" TO probe_reader;
GRANT SELECT ON "升级 样本".records TO probe_reader;
RESET ROLE;
`;
const rowsQuery = `SELECT jsonb_agg(jsonb_build_object(
  'id',id,'label',label,'amount',amount::text,
  'utc',to_char(happened_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'payload',payload,'bytes',encode(bytes,'hex')) ORDER BY id) FROM "升级 样本".records`;
const structureQuery = `SELECT jsonb_build_object(
  'roles',(SELECT jsonb_agg(jsonb_build_object('name',rolname,'login',rolcanlogin,'superuser',rolsuper) ORDER BY rolname) FROM pg_roles WHERE rolname IN ('probe_owner','probe_reader')),
  'membership',pg_has_role('probe_owner','probe_reader','MEMBER'),
  'owner',(SELECT tableowner FROM pg_tables WHERE schemaname='升级 样本' AND tablename='records'),
  'reader_select',has_table_privilege('probe_reader','"升级 样本".records','SELECT'),
  'reader_insert',has_table_privilege('probe_reader','"升级 样本".records','INSERT'),
  'sequence',(SELECT jsonb_build_object('last_value',last_value,'is_called',is_called) FROM "升级 样本".records_id_seq),
  'constraints',(SELECT jsonb_agg(jsonb_build_object('name',conname,'type',contype::text,'validated',convalidated) ORDER BY conname) FROM pg_constraint WHERE conrelid='"升级 样本".records'::regclass AND contype IN ('p','u','c')),
  'not_null',(SELECT attnotnull FROM pg_attribute WHERE attrelid='"升级 样本".records'::regclass AND attname='label'))`;
const expectedStructure = {
  roles: [{ name: 'probe_owner', login: false, superuser: false }, { name: 'probe_reader', login: false, superuser: false }],
  membership: true, owner: 'probe_owner', reader_select: true, reader_insert: false,
  sequence: { last_value: 2, is_called: true },
  constraints: [
    { name: 'records_amount_check', type: 'c', validated: true },
    { name: 'records_label_unique', type: 'u', validated: true },
    { name: 'records_pk', type: 'p', validated: true },
  ],
  not_null: true,
};

async function main(options) {
  const begin = performance.now();
  const report = {
    schemaVersion: 1, issue: 'https://github.com/paher-din/XunJie/issues/143',
    kind: 'standalone-native-postgresql-tool-availability', status: 'running',
    startedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, osRelease: os.release(), osVersion: os.version(), machine: os.machine(), node: process.version },
    path: { minor: '17.10 -> 17.11, same PGDATA after normal stop', major: '17.11 -> 18.6, logical custom dump + globals -> new PGDATA' },
    artifacts: {}, toolVersions: {}, stages: [],
    limitations: [
      'Tool availability and fixture compatibility on this macOS arm64 host only; not full WP145 backup/recovery product acceptance.',
      'No pg_upgrade migration (version availability only); selected major route is logical migration.',
      'No Windows, clean-machine installation, offline installer, signing, notarization or Gatekeeper acceptance.',
      'No crash, ENOSPC, interrupted restore, large database performance, arbitrary extensions, tablespaces, replication or cross-OS migration coverage.',
      'Globals use --no-role-passwords; probe roles are NOLOGIN. Login password migration is not covered.',
      'Only throwaway probe data is deleted after validation; no product cluster or external database is opened.',
      'Checksums use upstream HTTPS release digests and manifests; no independent release-signature verification.',
    ],
  };
  const abort = new AbortController();
  const signalHandlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => abort.abort(new Error(signal))]));
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG') && !key.startsWith('DYLD_') && key !== 'LD_LIBRARY_PATH'));
  Object.assign(env, { LC_ALL: 'C', LANG: 'C', TZ: 'UTC', PGCLIENTENCODING: 'UTF8', PGCONNECT_TIMEOUT: '10', PGSSLMODE: 'disable', PGTZ: 'UTC' });
  let temporary;
  let secret;
  const clusters = [];
  const cleanError = error => String(error.message).replaceAll(secret || '\0', '[redacted]').slice(0, 6000);
  async function command(bin, tool, args, { cleanup = false } = {}) {
    const result = await execute(path.join(bin, tool), args, {
      shell: false, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
      ...(cleanup ? {} : { signal: abort.signal }),
    });
    return result.stdout.trim();
  }
  async function stage(name, action) {
    const start = performance.now();
    const entry = { name, status: 'running', startedAt: new Date().toISOString() };
    report.stages.push(entry);
    try {
      entry.result = await action();
      entry.status = 'passed';
      return entry.result;
    } catch (error) {
      entry.status = 'failed';
      entry.error = cleanError(error);
      throw error;
    } finally {
      entry.durationMs = Math.round(performance.now() - start);
      console.log(`${name}: ${entry.status} (${entry.durationMs}ms)`);
    }
  }
  const connect = cluster => ['--host', '127.0.0.1', '--port', String(cluster.port), '--username', 'probe_admin', '--no-password'];
  async function sql(cluster, query, json = false) {
    const output = await command(cluster.bin, 'psql', ['-X', '-A', '-t', '--set', 'ON_ERROR_STOP=1', ...connect(cluster), '--dbname', 'postgres', '--command', query]);
    return json ? JSON.parse(output) : output;
  }
  async function start(cluster, bin) {
    cluster.bin = bin;
    // Register before start: pg_ctl timeout/failure can still leave a live owned server.
    cluster.mayBeRunning = true;
    await command(bin, 'pg_ctl', ['--pgdata', cluster.data, '--log', cluster.log, '--wait', '--timeout', '30', 'start']);
  }
  async function stop(cluster, cleanup = false) {
    await command(cluster.bin, 'pg_ctl', ['--pgdata', cluster.data, '--wait', '--timeout', '30', '--mode', 'fast', 'stop'], { cleanup });
    await assert.rejects(access(path.join(cluster.data, 'postmaster.pid')), { code: 'ENOENT' });
    cluster.mayBeRunning = false;
    return { normalShutdown: true, mode: 'fast', postmasterPidRemoved: true };
  }
  async function initialize(cluster, bin) {
    await command(bin, 'initdb', ['--pgdata', cluster.data, '--username', 'probe_admin', '--pwfile', path.join(temporary, 'init-password'), '--encoding', 'UTF8', '--locale-provider', 'libc', '--locale', 'C', '--data-checksums', '--auth-local', 'scram-sha-256', '--auth-host', 'scram-sha-256']);
    await writeFile(path.join(cluster.data, 'postgresql.auto.conf'), [
      "listen_addresses = '127.0.0.1'", `port = ${cluster.port}`, "unix_socket_directories = ''",
      "timezone = 'UTC'", "log_timezone = 'UTC'", "password_encryption = 'scram-sha-256'", '',
    ].join('\n'), { mode: 0o600 });
    const hba = await readFile(path.join(cluster.data, 'pg_hba.conf'), 'utf8');
    assert(!hba.split('\n').some(line => !line.trim().startsWith('#') && /\b(trust|md5)\b/.test(line)));
  }
  async function verify(cluster, version) {
    const settings = await sql(cluster, `SELECT jsonb_build_object(
      'version',current_setting('server_version'),'version_num',current_setting('server_version_num')::int,
      'encoding',current_setting('server_encoding'),
      'collate',(SELECT datcollate FROM pg_database WHERE datname=current_database()),
      'ctype',(SELECT datctype FROM pg_database WHERE datname=current_database()),'timezone',current_setting('TimeZone'),
      'checksums',current_setting('data_checksums'),'password_encryption',current_setting('password_encryption'),
      'listen',current_setting('listen_addresses'),'port',current_setting('port')::int,
      'locale_provider',(SELECT datlocprovider::text FROM pg_database WHERE datname=current_database()),
      'scram_verifier',(SELECT rolpassword LIKE 'SCRAM-SHA-256$%' FROM pg_authid WHERE rolname='probe_admin'))`, true);
    assert.equal(settings.version.split(' ')[0], version);
    const [major, minor] = version.split('.').map(Number);
    assert.equal(settings.version_num, major * 10000 + minor);
    assert.deepEqual({ ...settings, version: undefined, version_num: undefined }, {
      version: undefined, version_num: undefined, encoding: 'UTF8', collate: 'C', ctype: 'C', timezone: 'UTC',
      checksums: 'on', password_encryption: 'scram-sha-256', listen: '127.0.0.1', port: cluster.port,
      locale_provider: 'c', scram_verifier: true,
    });
    const rows = await sql(cluster, rowsQuery, true);
    const structure = await sql(cluster, structureQuery, true);
    assert.deepEqual(rows, expectedRows);
    assert.deepEqual(structure, expectedStructure);
    // Each exception block rolls back its attempted write. Test actual enforcement, not just catalog labels.
    await sql(cluster, `DO $probe$
    BEGIN
      BEGIN UPDATE "升级 样本".records SET id=1 WHERE id=2; RAISE EXCEPTION 'primary key accepted duplicate'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN UPDATE "升级 样本".records SET label='循阶 中文 空格' WHERE id=2; RAISE EXCEPTION 'unique accepted duplicate'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN UPDATE "升级 样本".records SET amount=-100 WHERE id=2; RAISE EXCEPTION 'check accepted invalid amount'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "升级 样本".records SET label=NULL WHERE id=2; RAISE EXCEPTION 'not null accepted null'; EXCEPTION WHEN not_null_violation THEN NULL; END;
    END $probe$`);
    assert.deepEqual(await sql(cluster, rowsQuery, true), expectedRows);
    return { settings, rows, structure, constraintEnforcement: ['primary-key', 'unique', 'check', 'not-null'], matchesIndependentExpectations: true };
  }
  try {
    await stage('artifact-and-tool-preflight', async () => {
      assert.equal(process.platform, 'darwin', 'This pinned probe targets macOS arm64');
      assert.equal(process.arch, 'arm64', 'This pinned probe targets macOS arm64');
      report.host.macOSVersion = await command('/usr/bin', 'sw_vers', ['-productVersion']);
      for (const [key, version] of Object.entries(versions)) {
        const bin = await realpath(options[`${key}-bin`]);
        options[`${key}-bin`] = bin;
        const release = `${version}.1`;
        const root = path.dirname(bin);
        assert.equal(path.basename(root), `postgresql-${release}-${target}`);
        const archive = `${root}.tar.gz`;
        const manifestFile = `${archive}.manifest.json`;
        const pins = upstream[release];
        assert(pins, `Missing upstream checksum pins for ${release}`);
        assert.equal(await sha256(archive), pins.archive, `${release} archive checksum`);
        assert.equal(await sha256(manifestFile), pins.manifest, `${release} manifest checksum`);
        const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
        assert.equal(manifest.sha256, pins.archive);
        let verifiedFiles = 0;
        // Bind the executed tools and their bundled libraries/data to the release manifest.
        for (const [relative, item] of Object.entries(manifest.files)) {
          const file = path.resolve(path.dirname(root), relative);
          assert(file.startsWith(`${root}${path.sep}`), 'Manifest path escapes selected release');
          const info = await lstat(file);
          if (item.sha256) {
            assert(info.isFile(), `Expected regular file: ${relative}`);
            assert.equal(await sha256(file), item.sha256, `Extracted checksum: ${relative}`);
            assert.equal(info.size, item.size, `Extracted size: ${relative}`);
            verifiedFiles++;
          } else if (item.symlink) {
            assert(info.isSymbolicLink(), `Expected symlink: ${relative}`);
            assert.equal(await readlink(file), item.symlink, `Extracted symlink: ${relative}`);
            assert((await realpath(file)).startsWith(`${root}${path.sep}`), 'Symlink escapes release');
          } else {
            throw new Error(`Unknown manifest entry: ${relative}`);
          }
        }
        report.artifacts[key] = {
          release, engineVersion: version, target, bin,
          source: `${releaseBase}/tag/${release}`,
          archiveUrl: `${releaseBase}/download/${release}/${path.basename(archive)}`,
          checksumSource: `https://api.github.com/repos/theseus-rs/postgresql-binaries/releases/tags/${release} (asset digest)`,
          sha256: pins.archive, sha256Verified: true,
          manifestSha256: pins.manifest, extractedFilesVerified: verifiedFiles,
        };
        report.toolVersions[key] = {};
        for (const tool of tools) {
          const output = await command(bin, tool, ['--version']);
          assert(output.includes(`(PostgreSQL) ${version}`), `${key}/${tool}: unexpected version`);
          report.toolVersions[key][tool] = output;
        }
      }
      return { noPathLookup: true, toolCount: tools.length * 3, pgUpgrade: 'version checked only; logical major selected' };
    });
    temporary = await mkdtemp(path.join(os.tmpdir(), '循阶 PG 升级 探针 '));
    await chmod(temporary, 0o700);
    secret = randomBytes(32).toString('hex');
    await writeFile(path.join(temporary, 'init-password'), `${secret}\n`, { mode: 0o600 });
    env.PGPASSFILE = path.join(temporary, 'pgpass');
    const oldPort = await unusedPort();
    let newPort = await unusedPort();
    while (newPort === oldPort) newPort = await unusedPort();
    await writeFile(env.PGPASSFILE, `127.0.0.1:${oldPort}:*:probe_admin:${secret}\n127.0.0.1:${newPort}:*:probe_admin:${secret}\n`, { mode: 0o600 });
    for (const name of ['init-password', 'pgpass']) assert.equal((await lstat(path.join(temporary, name))).mode & 0o777, 0o600);
    const source = { name: 'source', data: path.join(temporary, '源 数据 17'), log: path.join(temporary, '源 日志.log'), port: oldPort, bin: options['old-bin'] };
    const destination = { name: 'destination', data: path.join(temporary, '目标 数据 18'), log: path.join(temporary, '目标 日志.log'), port: newPort, bin: options['new-bin'] };
    clusters.push(source, destination);
    report.isolation = { temporaryPathContainsChineseAndSpaces: true, dataDirectoriesDistinct: source.data !== destination.data, sourcePort: oldPort, destinationPort: newPort, listener: '127.0.0.1', passwordFileMode: '0600', temporaryDirectoryMode: '0700' };
    await stage('17.10-initdb-start-fixture', async () => {
      await initialize(source, source.bin);
      await start(source, source.bin);
      await sql(source, fixture);
      return verify(source, '17.10');
    });
    await stage('17.10-normal-stop', () => stop(source));
    await stage('17.11-in-place-minor-start-and-verify', async () => {
      assert.equal((await readFile(path.join(source.data, 'PG_VERSION'), 'utf8')).trim(), '17');
      await start(source, options['minor-bin']);
      return { samePgdata: true, ...await verify(source, '17.11') };
    });
    await stage('17.11-normal-stop-before-major', () => stop(source));
    await stage('17.11-restart-for-logical-export', async () => {
      await start(source, options['minor-bin']);
      return verify(source, '17.11');
    });
    const dump = path.join(temporary, '逻辑 迁移.dump');
    const globals = path.join(temporary, '全局 角色.sql');
    await stage('18.6-tools-dump-17.11-custom-and-globals', async () => {
      await command(destination.bin, 'pg_dump', [...connect(source), '--dbname', 'postgres', '--format', 'custom', '--file', dump]);
      await command(destination.bin, 'pg_dumpall', [...connect(source), '--database', 'postgres', '--globals-only', '--no-role-passwords', '--file', globals]);
      await chmod(dump, 0o600);
      await chmod(globals, 0o600);
      const globalsSql = await readFile(globals, 'utf8');
      assert(globalsSql.includes('CREATE ROLE probe_owner;') && globalsSql.includes('CREATE ROLE probe_reader;'));
      assert(!/PASSWORD\s+'/i.test(globalsSql), 'Globals unexpectedly contain a role password');
      assert.equal((await readFile(dump)).subarray(0, 5).toString(), 'PGDMP');
      const listing = await command(destination.bin, 'pg_restore', ['--list', dump]);
      assert(listing.includes('TABLE') && listing.includes('SEQUENCE'));
      return { dumpFormat: 'custom', dumpBytes: (await lstat(dump)).size, dumpSha256: await sha256(dump), globalsBytes: (await lstat(globals)).size, globalsRolePasswords: 'excluded', globalsRolesPresent: ['probe_admin', 'probe_owner', 'probe_reader'], restoreListReadable: true };
    });
    await stage('18.6-new-cluster-initdb-and-start', async () => {
      await initialize(destination, destination.bin);
      await start(destination, destination.bin);
      assert.equal((await readFile(path.join(source.data, 'PG_VERSION'), 'utf8')).trim(), '17');
      assert.equal((await readFile(path.join(destination.data, 'PG_VERSION'), 'utf8')).trim(), '18');
      return { separatePgdata: true, sourcePgVersion: '17', destinationPgVersion: '18' };
    });
    await stage('18.6-restore-globals-and-custom-dump', async () => {
      // initdb already created probe_admin. Remove exactly its CREATE, preserving ALTER and all fixture roles/grants.
      const text = await readFile(globals, 'utf8');
      assert.equal(text.split('CREATE ROLE probe_admin;').length, 2);
      const restoreGlobals = path.join(temporary, '可恢复 全局.sql');
      await writeFile(restoreGlobals, text.replace(/^CREATE ROLE probe_admin;\r?\n/m, ''), { mode: 0o600 });
      await command(destination.bin, 'psql', ['-X', '--set', 'ON_ERROR_STOP=1', ...connect(destination), '--dbname', 'postgres', '--file', restoreGlobals]);
      await command(destination.bin, 'pg_restore', [...connect(destination), '--dbname', 'postgres', '--exit-on-error', '--single-transaction', dump]);
      return { globalsRestored: true, bootstrapRoleCreateOmitted: 'probe_admin only; ALTER retained', customRestored: true, ownershipAndAclRestored: true };
    });
    await stage('18.6-independent-data-role-sequence-constraint-verification', () => verify(destination, '18.6'));
    await stage('18.6-next-sequence-value', async () => {
      const next = await sql(destination, `SELECT to_jsonb(nextval('"升级 样本".records_id_seq'))`, true);
      assert.equal(next, 3);
      return { expected: 3, actual: next };
    });
    await stage('17.11-source-retained-and-unchanged', async () => ({
      sourceDataNotOverwritten: true, ...await verify(source, '17.11'),
    }));
    await stage('18.6-normal-stop', () => stop(destination));
    await stage('17.11-final-normal-stop', () => stop(source));
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = cleanError(error);
  } finally {
    const cleanupErrors = [];
    await stage('cleanup', async () => {
      for (const cluster of [...clusters].reverse()) {
        if (!cluster.mayBeRunning) continue;
        try {
          // A failed start can leave no server at all. Never kill by a discovered PID.
          try {
            await command(cluster.bin, 'pg_ctl', ['--pgdata', cluster.data, 'status'], { cleanup: true });
          } catch (error) {
            if (error.code === 3) { cluster.mayBeRunning = false; continue; }
            throw error;
          }
          await stop(cluster, true);
        } catch (error) { cleanupErrors.push({ cluster: cluster.name, error: cleanError(error) }); }
      }
      if (temporary && cleanupErrors.length === 0) await rm(temporary, { recursive: true, force: true });
      if (cleanupErrors.length) {
        // Preserve potentially live PGDATA; remove plaintext credentials even when shutdown fails.
        await Promise.all(['init-password', 'pgpass'].map(name => rm(path.join(temporary, name), { force: true })));
        throw new Error(`Normal shutdown failed: ${JSON.stringify(cleanupErrors)}`);
      }
      if (temporary) await assert.rejects(access(temporary), { code: 'ENOENT' });
      return { allOwnedInstancesStopped: true, temporaryDirectoryRemoved: true, passwordsDumpsAndLogsRemoved: true };
    }).catch(error => { report.status = 'failed'; report.cleanupError = cleanError(error); });
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    report.finishedAt = new Date().toISOString();
    report.durationMs = Math.round(performance.now() - begin);
    await mkdir(path.dirname(options.out), { recursive: true });
    // Deliberately persist only selected facts, never raw commands, credentials, dumps or server logs.
    await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
  }
  console.log(`PostgreSQL upgrade probe: ${report.status}; evidence: ${options.out}`);
  if (report.status !== 'passed') process.exitCode = 1;
}

// Guard allows static inspection/import without running the probe; product modules must not import it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log(usage);
  else {
    try { await main(argumentsFor(process.argv.slice(2))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
