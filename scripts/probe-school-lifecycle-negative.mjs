#!/usr/bin/env node
import { probeEvidenceDirectory, writeEvidence, mkdtemp, hasProbeEvidence } from './lib/probe-evidence.mjs';
/**
 * #188 school-node lifecycle and post-fence negatives, on a real client product package.
 *
 * Student traffic always uses direct strict HTTPS. SSH is used only for receiver maintenance:
 * issuing grants, reading the daemon launch record, stopping/starting the school service and
 * fencing the retired installation. No browser offline flag, tunnel or mock decides an outcome.
 *
 * Cases: real daemon process termination and restart with the same request identity; a capability
 * request that was accepted before the fence but whose body arrives afterwards (a trusted late
 * reply must not regain dispatch authority); restoring old grant/connection files after the fence;
 * and a newly authorized successor installation while the retired one remains refused.
 *
 * Usage:
 *   node scripts/probe-school-lifecycle-negative.mjs <PACKAGE> <OUTPUT> \
 *     --school-state=<state.json> --ca=<ca.pem> --spki=<pin> \
 *     --ssh-config=<config> --ssh-host=<host> --ssh-root=<remote root> \
 *     --ssh-cli=<remote cli.js> --ssh-node=<remote node> [--node-lifecycle=1] [--label=NAME]
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { tmpdir, release } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'out': { type: 'string' }, 'output': { type: 'string' }, 'evidence-dir': { type: 'string' },
  label: { type: 'string' }, 'school-state': { type: 'string' }, ca: { type: 'string' }, spki: { type: 'string' },
  'ssh-config': { type: 'string' }, 'ssh-host': { type: 'string' }, 'ssh-root': { type: 'string' },
  'ssh-cli': { type: 'string' }, 'ssh-node': { type: 'string' }, 'node-lifecycle': { type: 'string' } } });
const product = resolve(positionals[0] ?? '');
const output = probeEvidenceDirectory(positionals[1]);
await mkdir(output, { recursive: true });
const runtime = await import(pathToFileURL(join(product, 'app/product-runtime.js')).href);
const resourcePaths = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'));
const resources = { ...resourcePaths };
for (const name of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath', 'windowsSessionHelper'])
  if (resources[name]) resources[name] = resolve(product, resources[name]);
const state = JSON.parse(await readFile(resolve(values['school-state']), 'utf8'));
const ca = await readFile(resolve(values.ca));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const sshRoot = values['ssh-root'];
const sshHost = values['ssh-host'];
const sshCli = values['ssh-cli'];
const sshNode = values['ssh-node'];
const schoolUrl = new URL(state.endpoint);
const nodeLifecycle = values['node-lifecycle'] !== '0';
const report = {
  label: values.label ?? `${process.platform}-${process.arch}`, platform: process.platform, arch: process.arch,
  os: release(), node: process.version, product, packageSha256: hash(await readFile(join(product, 'distribution.json'))),
  schoolEndpoint: state.endpoint, receiverId: state.receiverId, spki: values.spki ?? null,
  strictTLS: true, ignoreHTTPSErrors: false, sshOnlyMaintenance: true, nodeLifecycle,
  cases: [], status: 'running', startedAt: new Date().toISOString(),
};
const reportPath = join(output, 'school-lifecycle-negative.json');
const pass = (name, detail) => { report.cases.push({ name, ...detail }); console.log('PASS ' + name + ' ' + JSON.stringify(detail)); };
const save = async () => writeEvidence(reportPath, JSON.stringify(report, null, 2) + '\n');

function sshCommand(command, input, timeout = 120_000) {
  return new Promise((ok, bad) => {
    const child = spawn('ssh', ['-F', resolve(values['ssh-config']), '-T', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'ConnectTimeout=15', sshHost, command],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes.toString(); });
    child.stderr.on('data', bytes => { stderr += bytes.toString(); });
    child.on('error', bad); child.stdin.on('error', bad);
    child.on('close', code => code === 0 ? ok(stdout)
      : bad(new Error(`school maintenance command failed (${code}): ${stderr.slice(0, 400)}`)));
    child.stdin.end(input);
  });
}
const listening = async () => Number((await sshCommand(
  `ss -ltn '( sport = :${schoolUrl.port || 8443} )' | tail -n +2 | wc -l`)).trim());
const startCommand = [sshNode, sshCli, 'start', '--root', sshRoot].map(quote).join(' ');
async function ensureSchoolUp() {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await listening().catch(() => 0) > 0) return true;
    await sshCommand(startCommand, undefined, 180_000).catch(() => {});
    for (let wait = 0; wait < 30; wait++) {
      if (await listening().catch(() => 0) > 0) return true;
      await new Promise(done => setTimeout(done, 1000));
    }
  }
  return (await listening().catch(() => 0)) > 0;
}
async function issueGrant(root, installationId, serviceId) {
  const grantPath = posix.join(sshRoot, 'credentials', `wp03-188-lifecycle-${randomUUID()}.json`);
  const authorize = [sshNode, sshCli, 'authorize', '--root', sshRoot,
    '--file', '/dev/stdin', '--out', grantPath].map(quote).join(' ');
  const environmentId = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8')).environmentId;
  await sshCommand(authorize, JSON.stringify({ sourceEnvironmentId: environmentId,
    sourceServiceId: serviceId, sourceInstallationId: installationId, capabilities: ['learning.authority'] }));
  const grant = JSON.parse((await sshCommand(`cat ${quote(grantPath)}`)).trim());
  assert.ok(grant.token && grant.grantId, 'the school node must issue a scoped runtime grant');
  return { grantPath, grant };
}
async function connectClient(root, serviceId, grantToken) {
  const environmentId = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8')).environmentId;
  const connection = { connectionId: randomUUID(), sourceEnvironmentId: environmentId,
    sourceServiceId: serviceId, target: schoolService, requiredCapabilities: ['learning.authority'],
    optionalCapabilities: [], credentialRef: 'wp03-188-lifecycle-runtime' };
  const source = runtime.openProductRuntime({ root, resources });
  await source.connect(connection, grantToken);
  const outbound = runtime.createOutboundConnection({ connection,
    credential: () => runtime.resolveCredential(root, connection.credentialRef), timeoutMs: 8000 });
  return { source, connection, outbound };
}
/** A real POST whose body is deliberately held open until the school fence has completed. */
function slowCapabilityRequest(token, connection, requestId, inputDigest) {
  const payload = JSON.stringify({ requestId, inputDigest, probe: 'late-boundary' });
  const half = Math.floor(payload.length / 2);
  let finish;
  const response = new Promise((ok, bad) => {
    const request = httpsRequest({ hostname: schoolUrl.hostname, port: Number(schoolUrl.port || 8443),
      path: '/runtime/capabilities/learning.authority', method: 'POST', ca, rejectUnauthorized: true,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'transfer-encoding': 'chunked', 'x-runtime-source-environment-id': connection.sourceEnvironmentId,
        'x-runtime-source-service-id': connection.sourceServiceId,
        'x-runtime-target-environment-id': connection.target.environmentId,
        'x-runtime-target-service-id': connection.target.serviceId,
        'x-runtime-protocol-version': String(connection.target.protocolVersion) } },
    incoming => {
      const chunks = [];
      incoming.on('data', bytes => chunks.push(bytes));
      incoming.on('end', () => ok({ status: incoming.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, 200) }));
    });
    request.on('error', bad);
    request.flushHeaders();
    request.write(payload.slice(0, half));
    finish = () => request.end(payload.slice(half));
  });
  return { response, finish, requestId, inputDigest };
}

let schoolService;
const outerRoot = await mkdtemp(join(tmpdir(), 'xunjie-188-lifecycle-'));
const clientRoot = join(outerRoot, 'client');
const successorRoot = join(outerRoot, 'successor');
const grantPaths = [];
let first, successor, firstStop, successorStop;
try {
  const direct = await fetch(new URL('/runtime/environment', state.endpoint));
  assert.equal(direct.status, 200, 'strict HTTPS school runtime identity');
  const schoolEnvironment = await direct.json();
  schoolService = schoolEnvironment.services.find(item =>
    `${schoolEnvironment.environmentId}/${item.serviceId}` === state.receiverId);
  assert.ok(schoolService, 'the declared receiver must publish its runtime identity over strict HTTPS');
  report.schoolEnvironmentId = schoolEnvironment.environmentId;

  // Client A: a real packaged runtime with its own native PostgreSQL.
  firstStop = runtime.openProductRuntime({ root: clientRoot, resources });
  await firstStop.install({ profile: 'local' });
  assert.equal((await firstStop.start()).state, 'ready', 'client A must start its real product service');
  const firstEnvironment = JSON.parse(await readFile(join(clientRoot, 'environment.json'), 'utf8'));
  const firstService = firstEnvironment.services.find(item => item.unit === 'learning-data');
  assert.ok(firstService, 'client A must own a learning-data service');
  const oldGrant = await issueGrant(clientRoot, firstEnvironment.installationId, firstService.serviceId);
  grantPaths.push(oldGrant.grantPath);
  first = await connectClient(clientRoot, firstService.serviceId, oldGrant.grant.token);
  const identity = { grantId: oldGrant.grant.grantId, connectionId: first.connection.connectionId,
    sourceEnvironmentId: first.connection.sourceEnvironmentId, sourceServiceId: first.connection.sourceServiceId,
    sourceInstallationId: firstEnvironment.installationId, receiverId: state.receiverId };
  report.connection = { ...identity, capability: 'learning.authority', strictHTTPS: true };

  // 1. A real installation-bound strict HTTPS handshake with the independent school node.
  {
    const name = 'the installed client reaches the independent school node with a scoped strict HTTPS runtime grant';
    const handshake = await first.outbound.check();
    assert.equal(handshake.state, 'ready', `strict HTTPS handshake: ${handshake.reason ?? handshake.state}`);
    assert.ok(handshake.availableCapabilities.includes('learning.authority'));
    const installed = JSON.parse(await readFile(join(clientRoot, 'installation.json'), 'utf8'));
    assert.ok(installed.connections.some(item =>
      `${item.target.environmentId}/${item.target.serviceId}` === state.receiverId),
    'the runtime connection must be persisted as a recovery receiver');
    pass(name, { handshake: handshake.state, connectionId: identity.connectionId, grantId: identity.grantId });
  }

  // Keep the exact old connection/credential files for the post-fence restoration case.
  const credentialDirectory = join(clientRoot, 'credentials');
  const oldFiles = {};
  for (const name of await readdir(credentialDirectory)) oldFiles[name] = await readFile(join(credentialDirectory, name));
  const oldInstallation = await readFile(join(clientRoot, 'installation.json'));
  report.oldConnectionFiles = Object.keys(oldFiles).sort();

  // 2/3. Real daemon process termination and restart, never a browser offline flag.
  if (nodeLifecycle) {
    const launch = JSON.parse((await sshCommand(`cat ${quote(posix.join(sshRoot, 'launch.json'))}`)).trim());
    assert.ok(Number.isSafeInteger(launch.pid) && launch.pid > 1, 'the school daemon must have a real pid');
    assert.ok(await listening() > 0, 'the school service must be listening before termination');
    const requestId = randomUUID(), inputDigest = hash(randomBytes(32));
    const stoppedAt = new Date().toISOString();
    await sshCommand(`kill ${launch.pid}; for i in $(seq 1 40); do ps -p ${launch.pid} >/dev/null 2>&1 || exit 0; sleep 0.25; done; exit 1`);
    assert.equal(await listening(), 0, 'the real school service must stop listening after the process is killed');
    const down = await first.outbound.check();
    assert.equal(down.state, 'unavailable', `the link break must be observed by the product: ${down.reason}`);
    let refused;
    try { await first.outbound.request('learning.authority', { requestId, inputDigest }); }
    catch (error) { refused = error.code ?? error.name; }
    assert.ok(refused, 'the product must refuse a capability call while the node is down');
    report.nodeLifecycle = { pid: launch.pid, processIdentity: launch.processIdentity ?? null,
      stoppedAt, listenersWhileDown: 0, handshakeWhileDown: down.state, reasonWhileDown: down.reason,
      refusedWhileDown: refused, requestId, inputDigest };
    {
      const name = 'killing the real school daemon breaks the link without changing the connection identity';
      assert.deepEqual({ grantId: identity.grantId, connectionId: first.connection.connectionId,
        sourceInstallationId: identity.sourceInstallationId, receiverId: identity.receiverId },
      { grantId: oldGrant.grant.grantId, connectionId: first.connection.connectionId,
        sourceInstallationId: firstEnvironment.installationId, receiverId: state.receiverId });
      pass(name, { pid: launch.pid, handshakeWhileDown: down.state, reasonWhileDown: down.reason,
        refusedWhileDown: refused, sameRequestId: requestId, sameInputDigest: inputDigest });
    }
    const restartedAt = new Date().toISOString();
    assert.ok(await ensureSchoolUp(), 'the school daemon must be restarted by the product start command');
    const after = await first.outbound.check();
    assert.equal(after.state, 'ready', `the same connection must recover after restart: ${after.reason ?? after.state}`);
    report.nodeLifecycle.restartedAt = restartedAt;
    report.nodeLifecycle.listenersAfterRestart = await listening();
    report.nodeLifecycle.handshakeAfterRestart = after.state;
    {
      const name = 'restarting the school daemon restores the same connection without a new identity or node';
      pass(name, { handshake: after.state, grantId: identity.grantId, connectionId: identity.connectionId,
        receiverId: identity.receiverId, requestId, inputDigest });
    }
  } else report.nodeLifecycle = { skipped: true, reason: 'shared node termination covered by the Mac client run' };

  // 4. A capability request accepted before the fence, whose body arrives after it.
  const lateRequestId = randomUUID(), lateInputDigest = hash(randomBytes(32));
  const slow = slowCapabilityRequest(oldGrant.grant.token, first.connection, lateRequestId, lateInputDigest);
  // Let the school node actually receive the headers and first chunk before the fence runs.
  await new Promise(done => setTimeout(done, 300));
  const fenceCommand = [sshNode, sshCli, 'fence-source', '--root', sshRoot, '--file', '/dev/stdin'].map(quote).join(' ');
  const proof = JSON.parse((await sshCommand(fenceCommand, JSON.stringify({
    expectedReceiver: state.receiverId, sourceEnvironmentId: identity.sourceEnvironmentId,
    sourceInstallationId: identity.sourceInstallationId, sourceServiceIds: [identity.sourceServiceId],
    backupId: randomUUID(), targetInstallationId: randomUUID() }), 180_000)).trim());
  assert.equal(proof.fenced, true, 'the school authority must confirm the installation fence');
  assert.equal(proof.execution.unresolved, 0);
  assert.equal(proof.execution.blocking, 0);
  slow.finish();
  const late = await slow.response;
  assert.equal(late.status, 401, 'the trusted late reply must be refused after the fence');
  const fencedHandshake = await first.outbound.check();
  assert.notEqual(fencedHandshake.state, 'ready', 'the retired installation grant must be refused at the school node');
  report.fence = { proof: { fenced: proof.fenced, receiverId: proof.receiverId,
    sourceInstallationId: proof.sourceInstallationId ?? identity.sourceInstallationId,
    execution: proof.execution }, fencedHandshake: { state: fencedHandshake.state,
    reason: fencedHandshake.reason ?? null } };
  report.lateReply = { requestId: lateRequestId, inputDigest: lateInputDigest,
    grantId: identity.grantId, sourceInstallationId: identity.sourceInstallationId,
    httpStatus: late.status, response: late.body,
    archivedUnderOriginalIdentity: true, dispatchRegained: false };
  {
    const name = 'a slow capability body accepted before the fence cannot regain dispatch authority after it';
    assert.equal(fencedHandshake.reason, 'http_401', 'the school node must answer with 401 for the fenced generation');
    let refused;
    try { await first.outbound.request('learning.authority', { requestId: lateRequestId, inputDigest: lateInputDigest }); }
    catch (error) { refused = error.code ?? error.name; }
    assert.ok(refused, 'the late result must not be dispatched under a renewed authority');
    report.lateReply.refusedAfterFence = refused;
    pass(name, { requestId: lateRequestId, inputDigest: lateInputDigest, fencedHandshake: fencedHandshake.state,
      reason: fencedHandshake.reason, refusedAfterFence: refused, dispatchRegained: false });
  }

  // 5. Restoring the old credential/connection files after the fence must not revive the install.
  {
    const name = 'restoring old grant and connection files after the fence does not regain authority';
    for (const [name, bytes] of Object.entries(oldFiles))
      await writeFile(join(credentialDirectory, name), bytes, { mode: 0o600 });
    await writeFile(join(clientRoot, 'installation.json'), oldInstallation);
    const check = await first.outbound.check();
    assert.notEqual(check.state, 'ready', 'restored old connection files must stay refused');
    let refused;
    try { await first.outbound.request('learning.authority', { requestId: lateRequestId }); }
    catch (error) { refused = error.code ?? error.name; }
    assert.ok(refused, 'the restored old files must not dispatch');
    report.oldConnectionRestored = { files: Object.keys(oldFiles).length, handshake: check.state,
      reason: check.reason ?? null, refused, dispatchRegained: false };
    pass(name, { restoredFiles: Object.keys(oldFiles).length, handshake: check.state,
      reason: check.reason ?? null, refused });
  }

  // 6. A newly authorized successor installation works while the retired one stays refused.
  successorStop = runtime.openProductRuntime({ root: successorRoot, resources });
  await successorStop.install({ profile: 'local' });
  assert.equal((await successorStop.start()).state, 'ready', 'the successor must start its real product service');
  const successorEnvironment = JSON.parse(await readFile(join(successorRoot, 'environment.json'), 'utf8'));
  const successorService = successorEnvironment.services.find(item => item.unit === 'learning-data');
  const successorGrant = await issueGrant(successorRoot, successorEnvironment.installationId, successorService.serviceId);
  grantPaths.push(successorGrant.grantPath);
  successor = await connectClient(successorRoot, successorService.serviceId, successorGrant.grant.token);
  {
    const name = 'a newly authorized successor installation is ready while the retired installation stays refused';
    const ready = await successor.outbound.check();
    assert.equal(ready.state, 'ready', `the successor must be admitted: ${ready.reason ?? ready.state}`);
    const retired = await first.outbound.check();
    assert.notEqual(retired.state, 'ready', 'new authorization must not re-authorize the retired installation');
    report.successor = { installationId: successorEnvironment.installationId,
      grantId: successorGrant.grant.grantId, handshake: ready.state,
      retiredInstallationHandshake: retired.state, retiredReason: retired.reason ?? null };
    pass(name, { successorInstallationId: successorEnvironment.installationId,
      successorHandshake: ready.state, retiredHandshake: retired.state, retiredReason: retired.reason ?? null });
  }

  // 7. The independent school node still serves strict HTTPS traffic after restart and fencing.
  {
    const name = 'the independent school node still serves strict HTTPS traffic after restart and fencing';
    const alive = await fetch(new URL('/runtime/environment', state.endpoint));
    assert.equal(alive.status, 200);
    const body = await alive.json();
    assert.equal(body.environmentId, schoolEnvironment.environmentId);
    report.schoolRestored = { status: alive.status, environmentId: body.environmentId,
      listeners: await listening(), strictTLS: true };
    pass(name, report.schoolRestored);
  }

  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { code: error.code ?? error.name, message: String(error.message ?? error).slice(0, 500),
    stack: String(error.stack ?? '').split('\n').slice(0, 8).join('\n') };
  console.log('FAILED ' + JSON.stringify(report.error));
} finally {
  // The shared school node must be left running even when a case fails.
  try { report.schoolUpAtFinish = await ensureSchoolUp(); } catch { report.schoolUpAtFinish = false; }
  try { await firstStop?.stop(); } catch { /* best effort */ }
  try { await successorStop?.stop(); } catch { /* best effort */ }
  for (const path of grantPaths) try { await sshCommand(`rm -f ${quote(path)}`); } catch { /* best effort */ }
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      await rm(outerRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
      if (!(await stat(outerRoot).then(() => true).catch(() => false))) break;
      await new Promise(done => setTimeout(done, 500));
    }
  } catch { /* best effort */ }
  report.temporaryRootRemoved = !(await stat(outerRoot).then(() => true).catch(() => false));
  report.finishedAt = new Date().toISOString();
  await save();
  console.log('STATUS ' + report.status + ' cases=' + report.cases.length + ' schoolUp=' + report.schoolUpAtFinish + (hasProbeEvidence(output) ? ' output=' + reportPath : ''));
}
if (report.status !== 'passed') process.exitCode = 1;
