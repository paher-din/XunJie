import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ensureCertificateAuthority, ensureEnvironmentCertificate } from '../src/certificates.mjs';
import { resolveContext } from '../src/commands.mjs';
import { CONNECTION_SCHEMA, loadConnection } from '../src/connection.mjs';
import { modeStatus, selectionFile, useMode } from '../src/modes.mjs';
import { environmentId, environmentPaths } from '../src/paths.mjs';
import { allocatePorts } from '../src/ports.mjs';
import { componentRunning, spawnComponent, stopComponent } from '../src/processes.mjs';
import { saveState, writeJsonAtomic } from '../src/state.mjs';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, '');
const cli = join(repository, 'tools/xj-dev/xj-dev.mjs');
const gatewayScript = join(repository, 'tools/xj-dev/src/gateway.mjs');
const tlsError = code => /CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code ?? '');

function https(url, caFile, { method = 'GET', body, cookie } = {}) {
  return new Promise((done, reject) => {
    const req = request(url, { ca: readFileSync(caFile), rejectUnauthorized: true, agent: false, method,
      headers: { origin: new URL(url).origin, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    }, res => {
      const fingerprint = res.socket.getPeerCertificate().fingerprint256;
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => done({ status: res.statusCode, fingerprint, cookie: res.headers['set-cookie']?.[0]?.split(';')[0], text }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('test HTTPS timeout')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function waitForInvalidGateway(url, caFile) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await https(url, caFile); } catch (error) {
      if (tlsError(error.code)) return;
      if (error.code !== 'ECONNREFUSED') throw error;
    }
    await delay(50);
  }
  assert.fail('owned real gateway must serve the deliberately wrong-root leaf');
}

async function installRunningWrongLeaf(paths, wrongLeaf, id) {
  await stopComponent(paths, 'gateway');
  copyFileSync(wrongLeaf.keyFile, join(paths.tls, 'key.pem'));
  copyFileSync(wrongLeaf.certFile, join(paths.tls, 'cert.pem'));
  return spawnComponent(paths, 'gateway', process.execPath, gatewayScript, ['--config', join(paths.root, 'gateway-config.json')], { envId: id });
}

test('real CLI repairs and reloads only its gateway; stale in-memory TLS can never report successful up', { timeout: 180_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'xj-gateway-lifecycle-'));
  const home = join(root, 'home'), instance = `tls-${process.pid}`;
  const paths = environmentPaths(home, environmentId(repository, instance));
  const run = async (command, expected = true) => {
    let output;
    try { output = await execute(process.execPath, [cli, command, '--json', '--worktree', repository, '--instance', instance], {
      env: { ...process.env, XJ_DEV_HOME: home }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    }); } catch (error) { if (expected) throw error; output = error; }
    const body = JSON.parse(output.stdout);
    assert.equal(body.ok, expected, body.failure?.code);
    return body;
  };
  t.after(async () => {
    await run('down');
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const initial = await run('up');
  const caFile = join(home, 'ca/ca-cert.pem'), rootBytes = readFileSync(caFile);
  const credentials = readFileSync(paths.baselineCredentials);
  const student = JSON.parse(credentials).find(account => account.role === 'student');
  const session = await https(initial.page.url + '/api/sessions', caFile, { method: 'POST', body: { loginName: student.loginName, password: student.password } });
  assert.equal(session.status, 200);
  writeFileSync(join(paths.browserProfile, 'retained-draft.txt'), 'owned browser draft');
  const wrongCa = ensureCertificateAuthority(join(root, 'wrong'));
  const wrongLeaf = ensureEnvironmentCertificate(environmentPaths(join(root, 'wrong'), 'leaf'), wrongCa);

  await t.test('up loads repaired disk leaf into a new owned gateway while keeping upstreams/session/origin', async () => {
    const oldGateway = await installRunningWrongLeaf(paths, wrongLeaf, initial.environment.id);
    await waitForInvalidGateway(initial.page.url, caFile);
    const repaired = await run('up');
    assert.notEqual(repaired.processes.gateway.pid, oldGateway.pid);
    assert.equal(repaired.processes.backend.pid, initial.processes.backend.pid);
    assert.equal(repaired.processes.vite.pid, initial.processes.vite.pid);
    assert.equal(repaired.page.url, initial.page.url);
    const ready = await https(repaired.page.url + '/health/ready', caFile);
    assert.equal(ready.status, 200);
    assert.equal(ready.fingerprint, new X509Certificate(readFileSync(join(paths.tls, 'cert.pem'))).fingerprint256);
    assert.equal((await https(repaired.page.url + '/api/session', caFile, { cookie: session.cookie })).status, 200);
    assert.ok(readFileSync(caFile).equals(rootBytes));
    assert.ok(readFileSync(paths.baselineCredentials).equals(credentials));
    assert.equal(readFileSync(join(paths.browserProfile, 'retained-draft.txt'), 'utf8'), 'owned browser draft');
  });
  await t.test('interruption after disk repair fails closed with down/up recovery, then retains login', async () => {
    await installRunningWrongLeaf(paths, wrongLeaf, initial.environment.id);
    await waitForInvalidGateway(initial.page.url, caFile);
    ensureEnvironmentCertificate(paths, ensureCertificateAuthority(home));
    const failure = await run('up', false);
    assert.equal(failure.failure.code, 'GATEWAY_TLS_INVALID');
    assert.match(failure.failure.recovery, /down.*up/);
    const status = await run('status', false);
    assert.equal(status.capabilities.frontend.available, false);
    assert.equal(status.capabilities.api.available, false);
    await run('down');
    const recovered = await run('up');
    assert.equal(recovered.page.url, initial.page.url);
    assert.equal((await https(recovered.page.url + '/api/session', caFile, { cookie: session.cookie })).status, 200);
    assert.ok(readFileSync(caFile).equals(rootBytes));
    assert.ok(readFileSync(paths.baselineCredentials).equals(credentials));
  });
});

// Exercise production prepareRemote/useMode and real gateway/Vite processes with
// an owned ongoing-connection fixture and a controlled local HTTPS upstream.
// This is not evidence of an external SSH/member enrollment or cloud browser run.
for (const mode of ['cloud', 'cloud-api']) {
  test(`${mode} up reloads a repaired leaf without restarting the selected connection`, { timeout: 90_000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'xj-remote-tls-'));
    const context = resolveContext({ worktree: repository, instance: `${mode}-${process.pid}` });
    context.home = join(root, 'home'); context.env = environmentPaths(context.home, context.id);
    const ca = ensureCertificateAuthority(context.home);
    const cloudCa = ensureCertificateAuthority(join(root, 'cloud'));
    const cloudLeaf = ensureEnvironmentCertificate(environmentPaths(join(root, 'cloud'), 'leaf'), cloudCa);
    const cloud = createServer({ key: readFileSync(cloudLeaf.keyFile), cert: readFileSync(cloudLeaf.certFile) }, (_req, res) => res.end('ready'));
    cloud.listen(0, '127.0.0.1'); await once(cloud, 'listening');
    const connectionFile = join(root, 'connection.json');
    writeFileSync(join(root, 'identity'), 'invalid-test-private-key-placeholder');
    writeFileSync(join(root, 'known_hosts'), 'controlled.test ssh-ed25519 AAAA\n');
    writeJsonAtomic(connectionFile, { schema: CONNECTION_SCHEMA, host: 'controlled.test', port: 22, browserUser: 'browser',
      identityFile: 'identity', knownHostsFile: 'known_hosts', caFile: cloudCa.certFile,
      browserOrigin: 'https://localhost:3445', applicationPort: cloud.address().port });
    const c = loadConnection(connectionFile);
    const id = createHash('sha256').update(`${context.id}:${mode}:${c.id}`).digest('hex').slice(0, 12);
    const paths = environmentPaths(context.home, id);
    t.after(async () => {
      for (const name of ['gateway', 'vite', 'connection']) await stopComponent(paths, name);
      cloud.closeAllConnections(); await new Promise(done => cloud.close(done));
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const ports = await allocatePorts(id);
    ports.backend = cloud.address().port;
    mkdirSync(paths.root, { recursive: true });
    saveState(paths, { version: 1, mode, envId: id, ports, worktree: repository });
    const marker = join(paths.root, 'controlled-connection.mjs');
    writeFileSync(marker, 'setInterval(() => {}, 1000);');
    const connection = spawnComponent(paths, 'connection', process.execPath, marker, [], { envId: id });
    const statusFile = join(paths.root, 'page-connection-status.json');
    writeJsonAtomic(statusFile, { state: 'ready', checkedAt: new Date().toISOString(), business: { backendVersion: 'invalid-test-placeholder' } });
    const leaf = ensureEnvironmentCertificate(paths, ca);
    writeJsonAtomic(join(paths.root, 'gateway-config.json'), { mode, ...{ port: ports.gateway, backendPort: ports.backend, vitePort: ports.vite },
      keyFile: leaf.keyFile, certFile: leaf.certFile, cloud: { browserOrigin: c.browserOrigin, caFile: c.caFile }, connectionStatusFile: statusFile });
    const wrongCa = ensureCertificateAuthority(join(root, 'wrong'));
    const wrongLeaf = ensureEnvironmentCertificate(environmentPaths(join(root, 'wrong'), 'leaf'), wrongCa);
    const oldGateway = await installRunningWrongLeaf(paths, wrongLeaf, id);
    const url = `https://127.0.0.1:${ports.gateway}`;
    await waitForInvalidGateway(url, ca.certFile);
    const ready = await useMode(context, mode, { connection: connectionFile });
    assert.equal(ready.ok, true);
    assert.equal(ready.capabilities.frontend.available, true);
    assert.equal(ready.capabilities.api.available, true);
    assert.equal(ready.page.url, url);
    assert.equal(componentRunning(paths, 'connection').record.pid, connection.pid);
    assert.notEqual(componentRunning(paths, 'gateway').record.pid, oldGateway.pid);
    assert.equal((await https(url + '/health/ready', ca.certFile)).status, 200);
    assert.equal((await https(url + '/', ca.certFile)).status, 200);
    assert.equal((await https(url + '/health/ready', ca.certFile)).fingerprint,
      new X509Certificate(readFileSync(join(paths.tls, 'cert.pem'))).fingerprint256);
    await installRunningWrongLeaf(paths, wrongLeaf, id);
    await waitForInvalidGateway(url, ca.certFile);
    ensureEnvironmentCertificate(paths, ca);
    const stateBytes = readFileSync(paths.stateFile), selectionBytes = readFileSync(selectionFile(context));
    const leafBytes = readFileSync(join(paths.tls, 'cert.pem'));
    const gatewayPid = componentRunning(paths, 'gateway').record.pid;
    const invalidStatus = await modeStatus(context);
    assert.equal(invalidStatus.connection.state, 'ready', 'upstream readiness does not prove gateway TLS');
    assert.equal(invalidStatus.ok, false);
    assert.equal(invalidStatus.page.serving, false);
    assert.equal(invalidStatus.page.apiReady, false);
    assert.equal(invalidStatus.capabilities.frontend.available, false);
    assert.equal(invalidStatus.capabilities.frontend.hmr, false);
    assert.equal(invalidStatus.capabilities.api.available, false);
    assert.equal(invalidStatus.page.url, url);
    assert.equal(invalidStatus.environment.id, id);
    assert.equal(invalidStatus.environment.root, paths.root);
    assert.equal(componentRunning(paths, 'gateway').record.pid, gatewayPid, 'status never restarts gateway');
    assert.equal(componentRunning(paths, 'connection').record.pid, connection.pid, 'status never changes connection');
    assert.ok(readFileSync(paths.stateFile).equals(stateBytes), 'status preserves environment');
    assert.ok(readFileSync(selectionFile(context)).equals(selectionBytes), 'status preserves selected data target');
    assert.ok(readFileSync(join(paths.tls, 'cert.pem')).equals(leafBytes), 'status never repairs the disk leaf');
    await assert.rejects(useMode(context, mode, { connection: connectionFile }), error =>
      error.code === 'GATEWAY_TLS_INVALID' && /down.*up/.test(error.recovery));
    assert.equal(componentRunning(paths, 'connection').record.pid, connection.pid, 'TLS failure preserves the existing connection');
  });
}
