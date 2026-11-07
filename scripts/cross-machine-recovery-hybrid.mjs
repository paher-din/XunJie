import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname, release, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// #212 cross-machine recovery: Windows hybrid (paired local) device side. The device owns the
// learning-data; the Mac school is the authority and the SSH fence receiver. Student traffic stays
// on direct LAN HTTPS through the device's school-space forwarding; only the model transport is controlled.
const run = promisify(execFile);
const args = Object.fromEntries(process.argv.slice(2).map(item => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
for (const required of ['phase', 'config', 'out']) assert.ok(args[required], `missing --${required}`);
const config = JSON.parse(await readFile(resolve(args.config), 'utf8'));
const state = args.state ? await readFile(resolve(args.state), 'utf8').then(content => JSON.parse(content), () => ({})) : {};
const product = resolve(config.product), root = resolve(config.root), targetRoot = resolve(config.targetRoot);
const node = join(product, 'resources/node/node.exe'), cli = join(product, 'app/cli.js');
const { resolveCredential } = await import(pathToFileURL(join(product, 'app/product-runtime.js')).href);
process.env.NODE_EXTRA_CA_CERTS = resolve(config.caFile);
let sequence = 0;
async function cliCommand(operation, { input, root: selectedRoot = root, out, serviceId, config: isConfig } = {}) {
  const argv = [cli, operation, '--root', selectedRoot, '--json'];
  if (input !== undefined) {
    const file = join(resolve(config.work), `hybrid-input-${sequence++}.json`);
    await writeFile(file, JSON.stringify(input), { mode: 0o600 });
    argv.push(isConfig ? '--config' : '--file', file);
  }
  if (out !== undefined) argv.push('--out', resolve(out));
  if (serviceId !== undefined) argv.push('--service-id', serviceId);
  try {
    const result = await run(node, argv, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(result.stdout);
  } catch (error) {
    if (error.stdout) { try { return JSON.parse(error.stdout); } catch { /* fall through */ } }
    throw error;
  }
}
const report = { kind: 'cross-machine-recovery-hybrid', phase: args.phase, measuredAt: new Date().toISOString(),
  host: { hostname: hostname(), platform: platform(), arch: arch(), os: release(), node: process.version },
  checks: [], facts: {}, status: 'running' };
const pass = (name, detail) => { report.checks.push({ name, detail }); console.log('PASS ' + name); };
let endpoint = config.sourceEndpoint, space = state.space ?? '', namespace = '', cookie = '';
async function request(route, body, extra = {}) {
  const response = await fetch(new URL('/api/learning/' + route, endpoint), {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', ...(space ? { 'x-xj-space': space } : {}),
      ...(cookie ? { cookie } : {}), ...(namespace ? { 'x-xj-namespace': namespace } : {}), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let value; try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  return { status: response.status, value, headers: response.headers };
}
async function api(route, body, extra) {
  const result = await request(route, body, extra);
  assert.equal(result.status, 200, route + ': ' + result.status + ':' + JSON.stringify(result.value).slice(0, 300));
  return result.value;
}
async function deviceNamespace(target) {
  const response = await fetch(new URL('/api/learning/context', target), { redirect: 'error', headers: { 'content-type': 'application/json' } });
  assert.equal(response.status, 200, 'context: ' + response.status);
  return (await response.json()).clientNamespace;
}
const until = async (check, description, timeout = 90000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(done => setTimeout(done, 150)); }
  throw new Error(description);
};
async function prepareLearningAction(question, works) {
  const requestId = randomUUID();
  const intent = { requestId, scope: { environmentId: state.identity.environmentId, spaceId: state.identity.spaceId,
    principalId: state.identity.principalId, activityId: state.activityId },
    receiver: { receiverId: 'future-agent', location: 'remote', kind: 'question' },
    draft: { token: randomUUID(), question, references: [], bases: [] }, works, evidence: [] };
  await api(`intents/${state.activityId}`, intent);
  const settled = await until(async () => { const value = await api(`intents/${state.activityId}/${requestId}`);
    return value.state === 'prepared' ? value : null; }, 'The paired learning action is not durable.');
  return { intent, settled };
}
const learningDescriptor = environment => environment.services.find(service => service.unit === 'learning-data');
try {
  if (args.phase === 'setup') {
    await cliCommand('install', { config: true, input: { profile: 'local', host: '127.0.0.1', port: config.sourcePort,
      publicEndpoint: config.sourceEndpoint, tls: { certificateFile: resolve(config.tlsCert), keyFile: resolve(config.tlsKey) } } });
    const started = await cliCommand('start'); assert.equal(started.state, 'ready', started.state);
    const learning = learningDescriptor(started.environment);
    const deviceTarget = { environmentId: learning.environmentId, serviceId: learning.serviceId, version: 1 };
    report.facts = { endpoint: started.endpoint, environmentId: started.environment.environmentId,
      installationId: started.environment.installationId, profile: started.environment.profile, deviceTarget,
      services: started.environment.services.map(s => ({ unit: s.unit, serviceId: s.serviceId })) };
    await writeFile(resolve(config.deviceTargetOut), JSON.stringify(deviceTarget, null, 2) + '\n');
    Object.assign(state, { deviceTarget, deviceEnvironmentId: started.environment.environmentId,
      deviceServiceId: learning.serviceId, sourceInstallationId: started.environment.installationId });
    pass('the Windows hybrid device installed and started a local learning-data owner over LAN HTTPS', report.facts);
  } else if (args.phase === 'pair-start') {
    const requestId = config.requestId;
    const view = await api('client/start', { requestId, schoolEndpoint: config.schoolEndpoint }, { 'x-xj-space': '' });
    Object.assign(state, { requestId, pairingView: view });
    report.facts = { requestId, authorizationUrl: view.authorizationUrl };
    pass('the device began the WP01 pairing handshake toward the Mac school over HTTPS', report.facts);
  } else if (args.phase === 'pair-complete') {
    const requestId = config.requestId;
    const view = await api('client/complete', { requestId }, { 'x-xj-space': '' });
    const grant = JSON.parse(await readFile(resolve(config.authorityTokenFile), 'utf8'));
    const runtimeConnectionId = config.runtimeConnectionId;
    await cliCommand('connect', { input: { token: grant.token, connection: { connectionId: runtimeConnectionId,
      sourceEnvironmentId: state.deviceEnvironmentId, sourceServiceId: state.deviceServiceId, target: config.schoolClientService,
      requiredCapabilities: ['learning.authority'], optionalCapabilities: [], credentialRef: 'hybrid-school-runtime' } } });
    const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
    await api('manage/local-binding', { connectionId: requestId, runtimeConnectionId, target: state.deviceTarget }, { ...admin, 'x-xj-space': '' });
    space = 'school:' + requestId;
    Object.assign(state, { space, requestId, runtimeConnectionId, identity: view.identity });
    report.facts = { requestId, runtimeConnectionId, identity: view.identity, space };
    pass('the device completed the WP01 pairing and bound the school authority over cross-machine HTTPS', report.facts);
  } else if (args.phase === 'model') {
    const connectionId = config.modelConnectionId, grantId = randomUUID();
    await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: '跨机混合对话',
      protocol: 'chat-completions', baseUrl: `http://${config.modelHost}:${config.modelPort}/v1`, path: '/chat/completions',
      modelId: 'fixture-cross-machine-recovery', dialect: 'standard', parameterMode: 'plain', enabled: true,
      credential: { action: 'replace', value: 'synthetic-hybrid-device-key' } }, { 'x-xj-space': 'personal' });
    await api('models/grants', { requestId: randomUUID(), connectionId, grantId, owner: 'device' });
    await api('models/selection', { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, grantId } });
    Object.assign(state, { modelConnectionId: connectionId, modelGrantId: grantId });
    report.facts = { connectionId, grantId, modelPort: config.modelPort };
    pass('the device selected its own model owner for the paired school space', report.facts);
  } else if (args.phase === 'activity') {
    const activity = await api('course-activities', { requestId: randomUUID(), releaseId: config.releaseId });
    Object.assign(state, { activityId: activity.activityId, identity: activity.identity });
    report.facts = { activityId: activity.activityId, identity: activity.identity, target: activity.target };
    pass('the paired device created a course activity bound to its local learning-data owner', report.facts);
  } else if (args.phase === 'before') {
    namespace = await deviceNamespace(endpoint);
    const workHead = await api(`workspaces/${state.activityId}`);
    let file = workHead.files?.[0];
    if (!file) {
      file = { objectId: randomUUID(), contentId: randomUUID(), name: '跨机混合原文.txt', kind: 'text',
        encoding: 'utf8', mediaType: 'text/plain', value: '学校身份与混合本机作品\n' };
      await api(`workspaces/${state.activityId}`, { requestId: randomUUID(), baseRevision: workHead.revision ?? 0, files: [file] });
    }
    const draftHead = await api(`drafts/${state.activityId}`);
    const question = '请先提问，并保留这次跨机混合依据。';
    if (draftHead.question !== question) await api(`drafts/${state.activityId}`, { requestId: randomUUID(),
      draftId: draftHead.draftId, baseRevision: draftHead.revision ?? 0, question, bases: [], references: [] });
    const intents = await api(`intents/${state.activityId}`);
    const existing = intents.find(intent => intent.input.draft.question === question);
    const action = existing ? { intent: existing.input, settled: existing } : await prepareLearningAction(question, [file]);
    Object.assign(state, { file, draftQuestion: question, draftId: draftHead.draftId, intentRequestId: action.intent.requestId,
      intentInput: action.intent, sourceNamespace: namespace });
    report.facts = { intentRequestId: action.intent.requestId, intentState: action.settled.state,
      fileObjectId: file.objectId, draftId: draftHead.draftId, sourceNamespace: namespace };
    pass('the original learning question, work and prepared action are durable on the device before backup', report.facts);
  } else if (args.phase === 'backup-restore') {
    const backup = await cliCommand('backup', { input: { directory: resolve(config.backupDirectory), keyFile: resolve(config.keyFile), leaveClosed: true } });
    report.facts.backup = { backupId: backup.backupId, boundaryAt: backup.boundaryAt, receiverIds: backup.receiverIds };
    assert.deepEqual(backup.receiverIds, [`${config.schoolClientService.environmentId}/${config.schoolClientService.serviceId}`]);
    pass('the device produced a held formal backup naming the Mac school client as fence receiver', report.facts.backup);
    const restored = await cliCommand('restore', { root: targetRoot, input: { backupDirectory: join(resolve(config.backupDirectory), backup.backupId),
      keyFile: resolve(config.keyFile), installation: { profile: 'local', host: '127.0.0.1', port: config.targetPort,
        publicEndpoint: config.targetEndpoint, tls: { certificateFile: resolve(config.tlsCert), keyFile: resolve(config.tlsKey) } } } });
    assert.equal(restored.phase, 'isolated');
    const isolated = await cliCommand('start', { root: targetRoot }); assert.equal(isolated.state, 'maintenance');
    report.facts.target = { root: targetRoot, endpoint: isolated.endpoint, state: isolated.state,
      installationId: isolated.environment.installationId, clientNamespace: isolated.environment.clientNamespace };
    Object.assign(state, { targetInstallationId: isolated.environment.installationId, targetNamespace: isolated.environment.clientNamespace });
    pass('the isolated device target restores read-only on a separate HTTPS port', report.facts.target);
  } else if (args.phase === 'readonly') {
    endpoint = config.targetEndpoint;
    const readOnly = await request('course-activities', { requestId: randomUUID(), releaseId: config.releaseId });
    assert.ok(readOnly.status >= 400, 'isolated device must refuse business: ' + readOnly.status);
    report.facts = { isolatedWriteStatus: readOnly.status, state: 'maintenance' };
    pass('the isolated device target refuses paired business over HTTPS while read-only', report.facts);
  } else if (args.phase === 'takeover') {
    const receivers = [{ id: `${config.schoolClientService.environmentId}/${config.schoolClientService.serviceId}`, ssh: {
      configFile: resolve(config.ssh.configFile), host: config.ssh.host, nodePath: config.ssh.nodePath, cliPath: config.ssh.cliPath, root: config.ssh.root } }];
    const taken = await cliCommand('takeover', { root: targetRoot, input: { sourceRoot: root, receivers } });
    assert.equal(taken.phase, 'active');
    report.facts.takeover = taken;
    pass('the device target completed formal takeover with the remote Mac school SSH fence', taken);
    const stopped = await cliCommand('stop', { root }).catch(error => ({ error: error.message }));
    report.facts.sourceStop = stopped.state ?? stopped.error;
    const retired = await cliCommand('start', { root }).then(() => 'unexpected-start', error => error.message);
    report.facts.sourceRetired = retired;
    pass('the retired device source can no longer start', retired);
  } else if (args.phase === 'rebind-start') {
    endpoint = config.targetEndpoint;
    const reconnect = config.reconnectRequestId;
    const view = await api('client/start', { requestId: reconnect, schoolEndpoint: config.schoolEndpoint }, { 'x-xj-space': '' });
    Object.assign(state, { reconnectRequestId: reconnect });
    report.facts = { reconnectRequestId: reconnect, authorizationUrl: view.authorizationUrl };
    pass('the successor device began a fresh WP01 pairing toward the Mac school', report.facts);
  } else if (args.phase === 'rebind-complete') {
    endpoint = config.targetEndpoint;
    const reconnect = config.reconnectRequestId, restoredRuntimeConnectionId = config.restoredRuntimeConnectionId;
    const credentialFile = join(targetRoot, 'credentials', `school-client-${reconnect}`);
    const stored = await readFile(credentialFile, 'utf8').then(JSON.parse, () => null);
    if (!stored?.grant) await api('client/complete', { requestId: reconnect }, { 'x-xj-space': '' });
    const grant = JSON.parse(await readFile(resolve(config.renewedTokenFile), 'utf8'));
    const installation = JSON.parse(await readFile(join(targetRoot, 'installation.json'), 'utf8'));
    if (!installation.connections?.some(item => item.connectionId === restoredRuntimeConnectionId))
      await cliCommand('connect', { root: targetRoot, input: { token: grant.token, connection: { connectionId: restoredRuntimeConnectionId,
      sourceEnvironmentId: state.deviceEnvironmentId, sourceServiceId: state.deviceServiceId, target: config.schoolClientService,
      requiredCapabilities: ['learning.authority'], optionalCapabilities: [], credentialRef: 'hybrid-school-runtime-restored' } } });
    const admin = { authorization: `Bearer ${await resolveCredential(targetRoot, 'control')}` };
    await api('manage/local-binding', { connectionId: reconnect, runtimeConnectionId: restoredRuntimeConnectionId, target: state.deviceTarget }, { ...admin, 'x-xj-space': '' });
    space = 'school:' + reconnect;
    namespace = await deviceNamespace(endpoint);
    Object.assign(state, { space, reconnectRequestId: reconnect, restoredRuntimeConnectionId });
    report.facts = { reconnectRequestId: reconnect, restoredRuntimeConnectionId, space, namespace };
    pass('the successor device re-paired and re-bound the rotated school authority over cross-machine HTTPS', report.facts);
  } else if (args.phase === 'after') {
    endpoint = config.targetEndpoint; space = state.space; namespace = state.targetNamespace;
    const activity = await api(`activities/${state.activityId}`);
    assert.equal(activity.activityId, state.activityId);
    const rejected = await request(`drafts/${state.activityId}`, { requestId: randomUUID(), draftId: state.draftId,
      baseRevision: 0, question: '旧命名空间不应推进。', bases: [], references: [] }, { 'x-xj-namespace': state.sourceNamespace });
    assert.equal(rejected.status, 403, 'old device namespace must be rejected: ' + rejected.status);
    pass('the retired source device namespace is rejected over cross-machine HTTPS', { status: rejected.status });
    const preservedIntent = await api(`intents/${state.activityId}/${state.intentRequestId}`);
    assert.deepEqual(preservedIntent.input, state.intentInput);
    const preservedWork = await api(`workspaces/${state.activityId}`);
    assert.equal(preservedWork.files[0].value, state.file.value);
    const preservedDraft = await api(`drafts/${state.activityId}`);
    assert.equal(preservedDraft.question, state.draftQuestion);
    pass('the original learning action, work and draft survive the hybrid cross-machine takeover', {
      intentRequestId: state.intentRequestId, fileObjectId: state.file.objectId, draftId: state.draftId });
    const next = await prepareLearningAction('接管后继续按原学习依据解释。', [state.file]);
    report.facts = { preserved: true, oldNamespaceStatus: rejected.status, preservedIntentState: preservedIntent.state,
      newIntentRequestId: next.intent.requestId, newIntentState: next.settled.state, newNamespace: namespace };
    pass('a new learning action is prepared through the restored hybrid device', report.facts);
    Object.assign(state, { newIntentRequestId: next.intent.requestId });
  } else throw new Error('unknown phase ' + args.phase);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.message; process.exitCode = 1; }
await writeFile(resolve(args.out), JSON.stringify(report, null, 2) + '\n');
if (args.state) await writeFile(resolve(args.state), JSON.stringify(state, null, 2) + '\n');
console.log(JSON.stringify({ phase: args.phase, status: report.status }));