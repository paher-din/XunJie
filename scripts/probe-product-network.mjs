#!/usr/bin/env node
// Issue #143. Disposable consumers of the public CLI and connection API only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const self = fileURLToPath(import.meta.url);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const save = async (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const inside = (root, file) => file.startsWith(root + path.sep);
const secrets = new Set();
function redact(value) {
  let text = String(value);
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
  return text.replace(/\b[0-9a-f-]{36}\.[0-9a-f]{64}\b/gi, '[redacted-grant]');
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, cwd: options.cwd, env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.once('error', reject);
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, options.timeout ?? 180_000);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const result = { code, signal, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code !== 0 && !options.allowFailure) reject(new Error(redact(`${path.basename(command)} exited ${code ?? signal}: ${stderr || stdout}`)));
      else resolve(result);
    });
    child.stdin.end(options.input);
  });
}
function productEnv(base, ca) {
  // A private PATH containing dirname/sh only proves no host Node or PG lookup.
  const env = { HOME: path.join(base, 'home'), PATH: path.join(base, 'tools'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' };
  if (ca) env.NODE_EXTRA_CA_CERTS = ca;
  return env;
}
async function prepareTools(base) {
  await mkdir(path.join(base, 'home'), { recursive: true });
  await mkdir(path.join(base, 'tools'), { recursive: true });
  for (const name of ['dirname', 'sh']) await symlink(name === 'sh' ? '/bin/sh' : '/usr/bin/dirname', path.join(base, 'tools', name));
}
async function cli(base, command, root, extra = [], options = {}) {
  const result = await run(path.join(base, '独立 产品包', 'xunjie'), [command, '--root', root, ...extra],
    { cwd: base, env: productEnv(base, options.ca), allowFailure: options.allowFailure });
  const value = JSON.parse(result.stdout || 'null');
  if (!options.allowFailure) assert.notEqual(value?.state, 'failed', `CLI ${command}: ${JSON.stringify(value)}`);
  return value;
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert(port > 1024);
  return port;
}
function connection(source, target, overrides = {}) {
  return { connectionId: randomUUID(), sourceEnvironmentId: source.environmentId, sourceServiceId: source.services[0].serviceId,
    target, requiredCapabilities: ['runtime.status'], optionalCapabilities: [], credentialRef: `network-${randomUUID()}`, ...overrides };
}
async function consumer(base, file, { ca = path.join(base, 'ca.crt'), checksOnly = false } = {}) {
  const result = await run(path.join(base, '独立 产品包/resources/node/bin/node'),
    [path.join(base, 'probe.mjs'), '--consumer', file, ...(checksOnly ? ['--checks-only'] : [])], { cwd: base, env: productEnv(base, ca) });
  return JSON.parse(result.stdout);
}
async function consume(file, checksOnly) {
  const { createOutboundConnection } = await import('./connection-api.mjs');
  const { connection: descriptor, token } = await json(file);
  secrets.add(token);
  const make = value => createOutboundConnection({ connection: value, credential: async () => token, timeoutMs: 4000 });
  const client = make(descriptor);
  const check = await client.check();
  const result = { check };
  if (check.state === 'ready' && !checksOnly) {
    result.response = await client.request('runtime.status');
    result.wrongIdentity = await make({ ...descriptor, target: { ...descriptor.target, environmentId: randomUUID() } }).check();
    result.wrongProtocol = await make({ ...descriptor, target: { ...descriptor.target, protocolVersion: 2 } }).check();
    result.missingRequired = await make({ ...descriptor, requiredCapabilities: ['runtime.status', 'probe.unimplemented'] }).check();
    result.missingOptional = await make({ ...descriptor, optionalCapabilities: ['probe.unimplemented'] }).check();
    try { await client.request('course.not-authorized'); throw new Error('Unexpected capability dispatch'); }
    catch (error) { assert.equal(error.code, 'capability_not_configured'); result.unconfiguredCapability = error.code; }
    assert.equal(result.wrongIdentity.reason, 'http_409');
    assert.equal(result.wrongProtocol.reason, 'http_409');
    assert.equal(result.missingRequired.state, 'unavailable');
    assert.equal(result.missingOptional.state, 'degraded');
    assert.deepEqual(check.availableCapabilities, ['runtime.status']);
    assert.equal(result.response.environment.environmentId, descriptor.target.environmentId);
  }
  console.log(JSON.stringify(result));
}
async function remoteAction(action, base, publicIp, schoolPort) {
  assert(/^\/tmp\/xunjie-network-[a-zA-Z0-9-]+$/.test(base), 'Unexpected disposable remote directory');
  assert.equal((await readFile(path.join(base, '.owned-probe'), 'utf8')).trim(), path.basename(base));
  assert.notEqual(process.getuid(), 0, 'PostgreSQL must run as a normal user');
  if (action === 'remove') {
    const cleanup = await remoteAction('cleanup', base, publicIp, schoolPort);
    assert.equal(cleanup.safeToRemove, true);
    await rm(base, { recursive: true });
    return { temporaryRemoved: true };
  }
  const school = path.join(base, '学校 环境');
  const peer = path.join(base, '同机 组件');
  const pkg = path.join(base, '独立 产品包');
  const ca = path.join(base, 'ca.crt');
  const schoolCli = (command, extra = [], options = {}) => cli(base, command, school, extra, { ca, ...options });
  const peerCli = (command, extra = [], options = {}) => cli(base, command, peer, extra, { ca, ...options });
  const status = () => schoolCli('status');
  const pg = path.join(pkg, 'resources/postgres/bin');
  const pgStatus = () => run(path.join(pg, 'pg_ctl'), ['status', '-D', path.join(school, 'pgdata')], { env: productEnv(base), allowFailure: true });
  async function sql() {
    const binding = await schoolCli('database');
    const password = await readFile(path.join(school, 'credentials', binding.credentialRef), 'utf8');
    secrets.add(password);
    const value = await run(path.join(pg, 'psql'), ['-X', '-A', '-t', '--set', 'ON_ERROR_STOP=1', '-h', binding.host,
      '-p', String(binding.port), '-U', binding.user, '-d', binding.database, '-c',
      "SELECT json_build_object('version',current_setting('server_version'),'dataDirectory',current_setting('data_directory'),'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),'encoding',current_setting('server_encoding'),'timezone',current_setting('TimeZone'),'userTables',(SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')));"],
    { env: { ...productEnv(base), PGPASSWORD: password, PGCONNECT_TIMEOUT: '5', PGSSLMODE: 'disable' } });
    const result = JSON.parse(value.stdout);
    assert.equal(result.version, '18.6'); assert.equal(result.userTables, 0);
    assert.equal(await realpath(result.dataDirectory), await realpath(path.join(school, 'pgdata')));
    return { ...result, databaseEndpoint: `${binding.host}:${binding.port}` };
  }
  async function stopped() {
    const state = await schoolCli('stop'); assert.equal(state.state, 'stopped');
    const pgResult = await pgStatus(); assert.equal(pgResult.code, 3);
    assert.equal((await status()).state, 'stopped');
    return { state: state.state, pgCtlExit: pgResult.code };
  }
  if (action === 'setup') {
    await prepareTools(base);
    const port = schoolPort === undefined ? await freePort() : Number(schoolPort);
    assert(Number.isInteger(port) && port > 1024 && port <= 65535, 'School port must be an unprivileged TCP port');
    await save(path.join(base, 'school-config.json'), { profile: 'school', database: { mode: 'managed' },
      host: '0.0.0.0', port, publicEndpoint: `https://${publicIp}:${port}`,
      tls: { certificateFile: path.join(base, 'server.crt'), keyFile: path.join(base, 'server.key') } });
    const distribution = await json(path.join(pkg, 'distribution.json'));
    const install = await schoolCli('install', ['--config', path.join(base, 'school-config.json')]);
    const firstStart = await schoolCli('start'); assert.equal(firstStart.state, 'ready');
    const initialSql = await sql();
    const repeated = await schoolCli('start'); assert.deepEqual(repeated.environment, firstStart.environment);
    const stop = await stopped();
    const restart = await schoolCli('start'); assert.equal(restart.state, 'ready');
    assert.deepEqual(restart.environment, firstStart.environment);
    assert.deepEqual(await sql(), initialSql);
    const instance = await json(path.join(school, 'instance.json'));
    const pgPid = Number((await readFile(path.join(school, 'pgdata/postmaster.pid'), 'utf8')).split('\n')[0]);
    for (const [pid, expected] of [[instance.pid, path.join(pkg, 'resources/node/bin/node')], [pgPid, path.join(pg, 'postgres')]]) {
      assert.equal(await realpath(`/proc/${pid}/exe`), await realpath(expected));
    }
    const keyMode = (await stat(path.join(base, 'server.key'))).mode & 0o777; assert.equal(keyMode, 0o600);
    return { host: { uid: process.getuid(), user: os.userInfo().username, osRelease: await readFile('/etc/os-release', 'utf8'),
      platform: process.platform, architecture: process.arch, kernel: os.release(), libc: (await run('/usr/bin/getconf', ['GNU_LIBC_VERSION'])).stdout },
      package: { distributionSha256: await digest(path.join(pkg, 'distribution.json')), createdAt: distribution.createdAt,
        resourceCatalogSha256: distribution.resourceCatalogSha256, resources: distribution.resources.map(({ id, version, archive }) => ({ id, version, archive })),
        versions: { node: (await run(path.join(pkg, 'resources/node/bin/node'), ['--version'])).stdout,
          postgres: (await run(path.join(pg, 'postgres'), ['--version'], { env: productEnv(base) })).stdout },
        nodePath: path.join(pkg, 'resources/node/bin/node'), postgresBin: pg, path: productEnv(base).PATH,
        pathEntries: await readdir(path.join(base, 'tools')), hostNodeOrPostgresOnProductPath: false },
      install, firstStart, repeatedStartSameEnvironment: true, stop, restart, sql: initialSql,
      processOwnership: { daemonPid: instance.pid, postgresPid: pgPid, executablePathsVerified: true }, serverKeyMode: keyMode,
      listener: { host: '0.0.0.0', port, endpoint: firstStart.endpoint } };
  }
  if (action === 'loopback') {
    const peerInstall = await peerCli('install', ['--profile', 'remote']);
    assert.equal(await peerCli('database'), null);
    const source = peerInstall.environment;
    const target = structuredClone((await status()).environment.services[0]);
    target.endpoint = `https://127.0.0.1:${new URL(target.endpoint).port}`;
    const authorization = path.join(base, 'loopback-authorization.json');
    const grantFile = path.join(base, 'loopback-grant.json');
    const connectionFile = path.join(base, 'loopback-connection.json');
    await save(authorization, { sourceEnvironmentId: source.environmentId, sourceServiceId: source.services[0].serviceId, capabilities: ['runtime.status'] });
    await schoolCli('authorize', ['--file', authorization, '--out', grantFile]);
    const grant = await json(grantFile); secrets.add(grant.token);
    await save(connectionFile, { connection: connection(source, target), token: grant.token });
    await peerCli('connect', ['--file', connectionFile]);
    const ready = await consumer(base, connectionFile); assert.equal(ready.check.state, 'ready');
    const peerReady = await peerCli('start'); assert.equal(peerReady.state, 'ready');
    const stop = await stopped();
    const lost = await consumer(base, connectionFile, { checksOnly: true }); assert.equal(lost.check.state, 'unavailable');
    const peerLost = await peerCli('status', [], { allowFailure: true }); assert.equal(peerLost.state, 'failed');
    assert.deepEqual(peerLost.environment, peerReady.environment);
    await schoolCli('start');
    const reconnect = await consumer(base, connectionFile); assert.equal(reconnect.check.state, 'ready');
    const peerReconnect = await peerCli('status'); assert.equal(peerReconnect.state, 'ready');
    await schoolCli('revoke', ['--grant-id', grant.grantId]);
    const revoked = await consumer(base, connectionFile, { checksOnly: true }); assert.equal(revoked.check.reason, 'http_401');
    const peerRevoked = await peerCli('status', [], { allowFailure: true }); assert.equal(peerRevoked.state, 'failed');
    for (const value of [peerReconnect, peerRevoked]) assert.deepEqual(value.environment, peerReady.environment);
    await peerCli('stop');
    return { topology: 'Linux component -> authenticated HTTPS 127.0.0.1 school (same host only)', source, ready, peerReady, stop,
      lost, peerLost, reconnect, revoked, peerRevoked, environmentOwnershipUnchanged: true, peerDatabase: null };
  }
  if (action === 'authorize-mac') {
    const authorization = path.join(base, 'mac-authorization.json');
    return schoolCli('authorize', ['--file', authorization, '--out', path.join(base, 'mac-grant.json')]);
  }
  if (action === 'stop') return stopped();
  if (action === 'start') return schoolCli('start');
  if (action === 'revoke-mac') {
    const grant = await json(path.join(base, 'mac-grant.json'));
    return schoolCli('revoke', ['--grant-id', grant.grantId]);
  }
  if (action === 'cleanup') {
    const owned = [];
    for (const root of [peer, school]) {
      try { const instance = await json(path.join(root, 'instance.json')); owned.push(instance.pid); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await cli(base, 'stop', root, [], { ca }); }
      catch (error) {
        try { await access(path.join(root, 'installation.json')); } catch { continue; }
        throw error;
      }
    }
    const pgResult = await pgStatus();
    // A setup failure before initdb is safe only if no postmaster PID was published.
    let pgDataExists = true;
    try { await access(path.join(school, 'pgdata')); } catch { pgDataExists = false; }
    if (pgDataExists) assert.equal(pgResult.code, 3);
    for (const pid of owned) {
      for (let i = 0; i < 50; i++) {
        try { await access(`/proc/${pid}/exe`); } catch { break; }
        await delay(100);
      }
      try { await access(`/proc/${pid}/exe`); throw new Error(`Owned daemon ${pid} still running`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // Restrict observation to binaries physically inside this disposable directory.
    const remaining = [];
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      try { if (inside(base, await realpath(`/proc/${entry}/exe`))) remaining.push(Number(entry)); } catch { /* Other user/exited process. */ }
    }
    assert.deepEqual(remaining, []);
    return { servicesStopped: true, postgresStopped: !pgDataExists || pgResult.code === 3, pgCtlExit: pgResult.code,
      ownedDaemonPids: owned, remainingOwnedProcesses: remaining, safeToRemove: true };
  }
  throw new Error('Unknown remote action');
}

async function main(values) {
  assert(process.platform === 'darwin' && process.arch === 'arm64', 'Run coordinator on the target Apple Silicon Mac');
  for (const key of ['mac-package', 'linux-package', 'ssh-config', 'out']) assert(values[key], `Missing --${key}`);
  const repository = path.resolve(path.dirname(self), '..');
  const out = path.resolve(values.out);
  const report = { schemaVersion: 1, issue: 'https://github.com/paher-din/XunJie/issues/143', status: 'running',
    startedAt: new Date().toISOString(), stages: [],
    macHost: { platform: process.platform, architecture: process.arch, kernel: os.release(), osVersion: os.version() },
    selectedSchoolCombination: 'Ubuntu 24.04.5 LTS x64 / glibc 2.39 / bundled Node 24.21.0 / bundled PostgreSQL 18.6',
    scope: { capabilities: ['runtime.status'], businessData: 'none; new empty PG cluster only',
      ssh: 'deployment and observation only; no tunnel; runtime has no SSH dependency',
      systemChanges: 'none; no firewall/proxy/service/permission/trust-store changes',
      networkOutage: 'controlled stop of this test school listener and its own PG; no OS network modification' },
    acceptance: { linux: 'running', linuxSameHost: 'not-run', crossMachineDirect: 'not-run', browser: 'not-run',
      teachingEffectiveness: 'not-run', cleanMachine: 'not-run', windows: 'not-run-by-this-probe', signingNotarization: 'excluded-by-user' } };
  const base = await mkdtemp(path.join(os.tmpdir(), 'xunjie-network-'));
  const remote = `/tmp/xunjie-network-${randomUUID()}`;
  const sshConfig = path.resolve(values['ssh-config']);
  const host = values['ssh-host'] ?? 'xunjie-cloud';
  const publicIp = values['public-ip'] ?? '101.201.141.133';
  const schoolPort = values['school-port'];
  if (schoolPort !== undefined) assert(/^\d+$/.test(schoolPort) && Number(schoolPort) > 1024 && Number(schoolPort) <= 65535, 'Invalid --school-port');
  assert(/^\d{1,3}(?:\.\d{1,3}){3}$/.test(publicIp));
  assert(/^[a-zA-Z0-9_-]+$/.test(host));
  let remoteCreated = false, remoteRuntimeAttempted = false, localInstalled = false;
  const localRoot = path.join(base, 'Mac 本机组件');
  const ca = path.join(base, 'ca.crt');
  const macCli = (command, extra = [], options = {}) => cli(base, command, localRoot, extra, { ca, ...options });
  const sshOptions = ['-F', sshConfig, '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=15',
    '-o', 'ControlMaster=auto', '-o', 'ControlPersist=60', '-o', `ControlPath=${path.join(base, 'ssh-control')}`];
  const ssh = (script, options = {}) => run('/usr/bin/ssh', [...sshOptions, host, script], options);
  const remoteRun = async action => {
    const command = [path.join(remote, '独立 产品包/resources/node/bin/node'), path.join(remote, 'probe.mjs'), '--remote', action, '--base', remote, '--public-ip', publicIp];
    if (schoolPort !== undefined) command.push('--school-port', schoolPort);
    return JSON.parse((await ssh(command.map(quote).join(' '))).stdout);
  };
  const transfer = (source, dest, download = false) => run('/usr/bin/scp', ['-q', ...sshOptions,
    ...(download ? [`${host}:${source}`, dest] : [source, `${host}:${dest}`])]);
  const cleanupUnstartedRemote = async () => {
    // A failed upload/extraction may not have installed Node or this probe yet.
    // The selected Ubuntu host's Python performs only this owned-directory cleanup.
    const script = `import json, os, pathlib, re, shutil, sys
base = pathlib.Path(sys.argv[1])
assert re.fullmatch(r'/tmp/xunjie-network-[a-zA-Z0-9-]+', str(base))
assert not base.is_symlink() and base.stat().st_uid == os.getuid()
assert (base / '.owned-probe').read_text().strip() == base.name
for entry in pathlib.Path('/proc').iterdir():
    if not entry.name.isdigit():
        continue
    try:
        executable = str((entry / 'exe').resolve(strict=True))
    except (OSError, RuntimeError):
        continue
    assert not executable.startswith(str(base) + '/'), 'Owned process is still running'
shutil.rmtree(base)
print(json.dumps({'safeToRemove': True, 'productNeverExecuted': True, 'temporaryRemoved': True}))`;
    return JSON.parse((await ssh(`/usr/bin/python3 -c ${quote(script)} ${quote(remote)}`)).stdout);
  };
  async function stage(name, work) {
    const started = performance.now();
    try {
      const result = await work();
      const status = result?.status === 'blocked' ? 'blocked' : 'passed';
      report.stages.push({ name, status, durationMs: Math.round(performance.now() - started), result });
      await save(out, report); console.log(`${name}: ${status}`); return result;
    } catch (error) {
      report.stages.push({ name, status: 'failed', durationMs: Math.round(performance.now() - started), error: redact(error.message) });
      await save(out, report); throw error;
    }
  }
  try {
    await stage('prepare-independent-packages-and-TLS', async () => {
      await prepareTools(base);
      const macSource = await realpath(values['mac-package']);
      const linuxSource = await realpath(values['linux-package']);
      await cp(macSource, path.join(base, '独立 产品包'), { recursive: true, dereference: false, verbatimSymlinks: true });
      const { build } = await import('esbuild');
      // Test consumer is separately built from the PUBLIC product-runtime export.
      // It is never inserted into either product distribution.
      await build({ stdin: { contents: "export { createOutboundConnection } from './packages/product-runtime/src/index.ts';", resolveDir: repository },
        outfile: path.join(base, 'connection-api.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24',
        banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" },
        alias: { '@xunjie/contracts/product-runtime': path.join(repository, 'packages/contracts/src/product-runtime.ts') },
        external: ['pg-native'], logLevel: 'silent' });
      await cp(self, path.join(base, 'probe.mjs'));
      const openssl = (args) => run('/usr/bin/openssl', args, { cwd: base });
      await openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=XunJie disposable probe CA']);
      await openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=XunJie isolated school probe']);
      await writeFile(path.join(base, 'server.ext'), `subjectAltName=IP:${publicIp},IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n`);
      await openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '2', '-extfile', 'server.ext']);
      for (const name of ['ca.key', 'server.key']) await chmod(path.join(base, name), 0o600);
      await ssh(`umask 077; mkdir ${quote(remote)} && printf %s ${quote(path.basename(remote))} > ${quote(remote + '/.owned-probe')} && mkdir ${quote(remote + '/独立 产品包')}`);
      remoteCreated = true;
      const archive = path.join(base, 'linux-package.tar.gz');
      await run('/usr/bin/tar', ['-czf', archive, '-C', linuxSource, '.']);
      await transfer(archive, remote + '/package.tar.gz');
      for (const name of ['probe.mjs', 'connection-api.mjs', 'server.key', 'server.crt', 'ca.crt']) await transfer(path.join(base, name), remote + '/' + name);
      const archiveSha256 = await digest(archive);
      const remoteArchive = await ssh(`sha256sum ${quote(remote + '/package.tar.gz')}`);
      assert.equal(remoteArchive.stdout.split(' ')[0], archiveSha256);
      await ssh(`tar -xzf ${quote(remote + '/package.tar.gz')} -C ${quote(remote + '/独立 产品包')}; chmod 600 ${quote(remote + '/server.key')}`);
      const macDistribution = await json(path.join(macSource, 'distribution.json'));
      const linuxDistribution = await json(path.join(linuxSource, 'distribution.json'));
      return { localTemporary: base, remoteTemporary: remote, macSource, linuxSource, transferredArchiveSha256: archiveSha256,
        probeSha256: await digest(self), publicConsumerSha256: await digest(path.join(base, 'connection-api.mjs')),
        consumerPublicEntry: 'packages/product-runtime/src/index.ts#createOutboundConnection; separately bundled outside either product',
        transferredArchiveBytes: (await stat(archive)).size, macDistributionSha256: await digest(path.join(macSource, 'distribution.json')),
        linuxDistributionSha256: await digest(path.join(linuxSource, 'distribution.json')), macCreatedAt: macDistribution.createdAt,
        linuxCreatedAt: linuxDistribution.createdAt, publicIp, certificateSan: [publicIp, '127.0.0.1'],
        caTrust: 'NODE_EXTRA_CA_CERTS in these test product/consumer subprocesses only; TLS verification enabled',
        remoteContains: 'complete standalone Linux distribution, separate consumer, probe script, temporary TLS certificates/key; no source checkout or SSH credentials' };
    });
    const linux = await stage('linux-native-install-start-status-stop-restart-PGquery', () => {
      remoteRuntimeAttempted = true; return remoteRun('setup');
    });
    report.acceptance.linux = 'passed';
    assert.equal(linux.host.libc, 'glibc 2.39'); assert(linux.host.osRelease.includes('Ubuntu 24.04.5 LTS'));
    await stage('linux-same-host-HTTPS-identity-capabilities-loss-reconnect-revocation', () => remoteRun('loopback'));
    report.acceptance.linuxSameHost = 'passed';
    const local = await stage('mac-component-install-and-authorized-CLI-connect', async () => {
      const installed = await macCli('install', ['--profile', 'remote']); localInstalled = true;
      assert.equal(await macCli('database'), null);
      const authorization = path.join(base, 'mac-authorization.json');
      await save(authorization, { sourceEnvironmentId: installed.environment.environmentId,
        sourceServiceId: installed.environment.services[0].serviceId, capabilities: ['runtime.status'] });
      await transfer(authorization, remote + '/mac-authorization.json');
      await remoteRun('authorize-mac');
      const grantFile = path.join(base, 'mac-grant.json');
      await transfer(remote + '/mac-grant.json', grantFile, true); await chmod(grantFile, 0o600);
      const grant = await json(grantFile); secrets.add(grant.token);
      const file = path.join(base, 'mac-connection.json');
      const descriptor = connection(installed.environment, linux.firstStart.environment.services[0]);
      await save(file, { connection: descriptor, token: grant.token });
      await macCli('connect', ['--file', file]);
      return { installed, connection: descriptor, database: null, grantFileMode: (await stat(grantFile)).mode & 0o777 };
    });
    const connectionFile = path.join(base, 'mac-connection.json');
    const first = await stage('real-public-IP-HTTPS-product-connection', async () => {
      const result = await consumer(base, connectionFile);
      const current = await macCli('start', [], { allowFailure: true });
      assert.deepEqual(current.environment, local.installed.environment);
      if (result.check.state !== 'ready') {
        assert.equal(current.state, 'failed');
        const diagnostic = await run('/usr/bin/curl', ['--noproxy', '*', '--cacert', ca, '--connect-timeout', '5', '--max-time', '8',
          '--silent', '--show-error', '--output', '/dev/null', '--write-out', '%{http_code}', `${linux.listener.endpoint}/runtime/status`], { allowFailure: true });
        return { status: 'blocked', product: result, macStatus: current, directCurl: diagnostic,
          topology: `Mac -> ${linux.listener.endpoint} directly; no SSH tunnel`,
          reason: 'Public endpoint unreachable from this Mac; cause may be cloud network policy or path filtering; no policy was changed' };
      }
      assert.equal(current.state, 'ready');
      // Reachable transport must also refuse this private CA when not explicitly trusted.
      const untrusted = await consumer(base, connectionFile, { ca: null, checksOnly: true });
      assert.equal(untrusted.check.state, 'unavailable');
      return { status: 'passed', product: result, macStatus: current, untrusted,
        topology: `Mac -> authenticated HTTPS ${linux.listener.endpoint} directly; school never contacts Mac listener` };
    });
    if (first.status === 'blocked') {
      report.acceptance.crossMachineDirect = 'blocked';
      report.status = 'partial-network-blocked';
      await stage('blocked-link-revocation-and-ownership-preservation', async () => {
        await remoteRun('revoke-mac');
        const revoked = await consumer(base, connectionFile, { checksOnly: true });
        const current = await macCli('status', [], { allowFailure: true });
        assert.equal(current.state, 'failed'); assert.deepEqual(current.environment, local.installed.environment);
        return { revoked, macStatus: current, ownershipUnchanged: true, revocationOverPublicLink: 'not-observable-while-transport-blocked' };
      });
    } else {
      await stage('real-cross-machine-loss-reconnect-revocation', async () => {
        const stop = await remoteRun('stop');
        const lost = await consumer(base, connectionFile, { checksOnly: true }); assert.equal(lost.check.state, 'unavailable');
        const unavailable = await macCli('status', [], { allowFailure: true }); assert.equal(unavailable.state, 'failed');
        const restarted = await remoteRun('start'); assert.deepEqual(restarted.environment, linux.firstStart.environment);
        const reconnect = await consumer(base, connectionFile); assert.equal(reconnect.check.state, 'ready');
        const ready = await macCli('status'); assert.equal(ready.state, 'ready');
        await remoteRun('revoke-mac');
        const revoked = await consumer(base, connectionFile, { checksOnly: true }); assert.equal(revoked.check.reason, 'http_401');
        const denied = await macCli('status', [], { allowFailure: true }); assert.equal(denied.state, 'failed');
        for (const state of [unavailable, ready, denied]) assert.deepEqual(state.environment, local.installed.environment);
        return { stop, lost, unavailable, reconnect, ready, revoked, denied, environmentOwnershipUnchanged: true };
      });
      report.acceptance.crossMachineDirect = 'passed'; report.status = 'passed';
    }
  } catch (error) {
    report.status = 'failed'; report.error = redact(error.message);
  } finally {
    report.cleanup = { local: 'pending', remote: remoteCreated ? 'pending' : 'not-created' };
    if (localInstalled) {
      try {
        let daemonPid;
        try { daemonPid = (await json(path.join(localRoot, 'instance.json'))).pid; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const stopped = await macCli('stop'); assert.equal(stopped.state, 'stopped');
        assert.equal((await macCli('status')).state, 'stopped');
        if (daemonPid) {
          let running = true;
          for (let i = 0; i < 50 && running; i++) {
            try { process.kill(daemonPid, 0); await delay(100); }
            catch (error) { if (error.code !== 'ESRCH') throw error; running = false; }
          }
          assert.equal(running, false, 'Owned Mac daemon has not exited; preserve its root');
        }
        report.cleanup.local = { servicesStopped: true, database: 'none', status: stopped.state,
          ownedDaemonPid: daemonPid ?? null, daemonExitVerified: true };
      } catch (error) { report.cleanup.local = { error: redact(error.message), temporaryRetained: base }; report.status = 'failed'; }
    } else report.cleanup.local = { servicesStopped: true, installed: false };
    if (remoteCreated) {
      try {
        if (remoteRuntimeAttempted) {
          report.cleanup.remote = await remoteRun('cleanup');
          assert.equal(report.cleanup.remote.safeToRemove, true);
          report.cleanup.remote.temporaryRemoved = (await remoteRun('remove')).temporaryRemoved;
        } else report.cleanup.remote = await cleanupUnstartedRemote();
      } catch (error) { report.cleanup.remote = { error: redact(error.message), temporaryRetained: remote }; report.status = 'failed'; }
    }
    // Secrets are removed even if a runtime stop needs diagnosis; never remove live roots.
    const closedControl = await run('/usr/bin/ssh', [...sshOptions, '-O', 'exit', host], { allowFailure: true, timeout: 10_000 });
    report.cleanup.sshControlClosed = closedControl.code === 0 || closedControl.stderr.includes('No such file or directory');
    for (const name of ['ca.key', 'server.key', 'server.csr', 'ca.srl', 'mac-grant.json', 'mac-connection.json']) await rm(path.join(base, name), { force: true });
    report.cleanup.localSecretsRemoved = true;
    if (report.cleanup.local.servicesStopped) {
      await rm(base, { recursive: true, force: true }); report.cleanup.local.temporaryRemoved = true;
    }
    report.finishedAt = new Date().toISOString();
    const encoded = JSON.stringify(report, null, 2);
    assert(!encoded.includes('PRIVATE KEY'));
    for (const secret of secrets) assert(!encoded.includes(secret), 'Secret in evidence');
    await writeFile(out, redact(encoded) + '\n');
    console.log(JSON.stringify({ status: report.status, evidence: out, acceptance: report.acceptance, cleanup: report.cleanup }, null, 2));
  }
  if (report.status === 'failed') process.exitCode = 1;
}

const { values } = parseArgs({ options: { help: { type: 'boolean' }, consumer: { type: 'string' }, 'checks-only': { type: 'boolean' },
  remote: { type: 'string' }, base: { type: 'string' }, 'mac-package': { type: 'string' }, 'linux-package': { type: 'string' },
  'ssh-config': { type: 'string' }, 'ssh-host': { type: 'string' }, 'public-ip': { type: 'string' }, 'school-port': { type: 'string' }, out: { type: 'string' } } });
if (values.help) console.log(`Usage: <Node24> scripts/probe-product-network.mjs --mac-package DIR --linux-package DIR --ssh-config FILE --out FILE [--ssh-host xunjie-cloud] [--public-ip 101.201.141.133] [--school-port 38195]
Uses prebuilt COMPLETE packages. No shared build/dist mutation, installation, system trust, firewall, proxy or service changes.
SSH deploys/observes a fresh /tmp directory as a non-root user; no tunnels. Product HTTPS is a direct public-IP test.
The selected Ubuntu test host needs Python 3 for cleanup when package transfer/extraction fails before Node is available.
--school-port selects a dedicated ingress port already allowed by the deployment's network policy; this probe does not change that policy.
Always attempts to stop owned daemons/PG before removing its own directories and temporary secrets.
Blocked public transport is recorded as partial-network-blocked, never as cross-machine acceptance.
Separate consumer calls only the public createOutboundConnection API for runtime.status; no course or Agent claims.`);
else if (values.consumer) consume(values.consumer, values['checks-only']).catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
else if (values.remote) remoteAction(values.remote, values.base, values['public-ip'], values['school-port']).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
else main(values).catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
