import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication,
  createNativeChannelWorker, nativeChannelNode, resolveCredential, restoreProductRecovery, openRecoveredStorage } from '@xunjie/product-runtime';
import { StorageError, createFileBackend } from '@xunjie/storage';
import { createSpaces, createNativeChannel, learningMigrations, spaceCourseMigrations } from '@xunjie/learning-space';
import { canonicalValue, courseExecutionPlanBasis } from '@xunjie/contracts/execution';
import { accumulatorPackage } from '../../../components/state-accumulator/package.mjs';

const exec = promisify(execFile);
const hash = value => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
async function until(check, timeout = 25000) {
  const end = Date.now() + timeout;
  while (!await check()) { assert.ok(Date.now() < end, 'condition did not become true'); await delay(40); }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

// All setup and school observations use the installed product HTTP boundary. Only transport is
// faulted: the executor, PostgreSQL, sandbox, and process termination remain real.
async function schoolFixture({ publishPlan = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'xj-channel-maintenance-'));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
    postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6',
    webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) };
  const runtime = openProductRuntime({ root, resources });
  let host, worker, terminal, terminalReply, hostStopped = false;
  const claims = [];
  const stopHost = async () => { if (!hostStopped) { await host.stop(); hostStopped = true; } };
  let blockTerminal = true, offline = false, loseTerminalReply = false;
  try {
    await runtime.install({ profile: 'school' });
    host = await createProductRuntimeHost({ root, createApplication: createProductLearningApplication });
    const api = async (path, body, headers = {}) => {
      const response = await fetch(new URL('/api/learning/' + path, host.endpoint), {
        method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    const ok = async (...args) => { const result = await api(...args); assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value; };
    const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
    const password = randomUUID();
    const identity = await ok('manage/members', { requestId: randomUUID(), loginName: 'maintenance-student', password }, admin);
    const login = await api('login', { loginName: 'maintenance-student', password });
    assert.equal(login.status, 200);
    const student = { cookie: login.cookie };
    const connectionId = randomUUID(), verifier = randomBytes(48).toString('base64url');
    await ok('connections/start', { requestId: connectionId, clientId: randomUUID(),
      challenge: createHash('sha256').update(verifier).digest('base64url') });
    await ok('connections/approve', { requestId: connectionId }, student);
    const grant = await ok('connections/exchange', { requestId: connectionId, verifier });
    const auth = { authorization: `Bearer ${grant.token}` };
    const native = { nodePath: process.execPath, sessionRoot: join(root, 'device-sessions') };
    const node = await nativeChannelNode({ ...native, connectionId, installationId: randomUUID() });
    assert.ok(node.adapters.some(item => item.adapterId === 'four-state-accumulator'), 'real native isolation is required');
    const call = async (operation, input) => {
      const terminalReport = operation === 'cleanup';
      if (terminalReport) {
        terminal = structuredClone(input);
        if (blockTerminal) throw new StorageError('unavailable');
      }
      if (offline) throw new StorageError('unavailable');
      const response = await api('native-channel/' + operation, input, auth);
      if (response.status !== 200) throw new StorageError(response.status === 403 ? 'forbidden' : 'unavailable');
      if (operation === 'claim' && response.value.command) {
        claims.push(response.value.command);
      }
      if (terminalReport) {
        terminalReply = response;
        if (loseTerminalReply) { loseTerminalReply = false; throw new StorageError('unavailable'); }
      }
      return response.value;
    };
    worker = createNativeChannelWorker({ root: join(root, 'device'), node, native, call });
    await worker.tick();
    const published = await accumulatorPackage({ version: 1 }), { manifest } = published, declared = manifest.session;
    const definition = await ok('manage/component-import', { requestId: randomUUID(), ...published }, admin);
    const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
    const configuration = { title: '四态累加' };
    const plan = { planId: 'maintenance-local-native', planVersion: 1, planDigest: '0'.repeat(64),
      components: [{ key: 'accumulator', definitionDigest: definition.digest, configurationDigest: hash(configuration), operations: ['advance'] }],
      capabilities: ['native-session'], resources: { browser: null,
        native: { memoryMiB: 64, operationTimeoutMs: 5000, maxMs: 3600000 } }, locations: ['native'], remote: null };
    plan.planDigest = hash(courseExecutionPlanBasis(plan));
    await ok('manage/course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '维护排空' },
      task: { taskId, title: '本机会话', summary: '' }, release: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },  releaseId, objectives: ['确认退出'], requirements: '观察',
        starterWorks: [], capabilities: [], components: [{ key: 'accumulator', definition,
          configuration, materialIds: [] }], materials: [], ...(publishPlan ? { executionPlan: plan } : {}) }, resources: [] }, admin);
    await ok('manage/course-access', { requestId: randomUUID(), courseId, principalId: identity.principalId, active: true }, admin);
    const activity = await ok('course-activities', { requestId: randomUUID(), releaseId }, student);
    const path = `executions/${activity.activityId}`;
    const action = requestId => ({ protocolVersion: 2, kind: 'execution', requestId,
      scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId: activity.activityId },
      receiver: { receiverId: 'native-execution', location: 'local', kind: 'execution' }, execution: {
        instance: { instanceId: `${activity.activityId}:accumulator`, key: 'accumulator', componentId: manifest.componentId,
          componentVersion: manifest.version, definitionDigest: definition.digest, hostApiVersion: 1, stateVersion: 1 },
        operation: { operationId: 'advance', effect: 'input' }, parameters: {},
        basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] },
        limits: { timeMs: 5000, memoryPages: 1, inputBytes: 1024, outputBytes: 65536, concurrentJobs: 2, queuedJobs: 0 },
        plan: { planId: 'native-session', planVersion: 1, location: 'native', kind: 'session',
          planDigest: hash({ planId: 'native-session', planVersion: 1, componentId: manifest.componentId, componentVersion: manifest.version, operationId: 'advance' }) },
        session: { adapterId: declared.adapterId, adapterVersion: 1, limits: { operationTimeoutMs: 5000,
          idleMs: 600000, maxMs: 3600000, memoryMiB: 64, concurrentSessions: 2, queuedSessions: 0 } },
        initiator: { kind: 'student', principalId: identity.principalId } } });
    const requestId = randomUUID();
    await ok(path, { action: action(requestId) }, student);
    await worker.tick();
    const running = await ok(`${path}/${requestId}`, undefined, student);
    assert.equal(running.state, 'running');
    // OS process identity, independent of executor cleanup reports.
    const { stdout } = await exec('ps', ['eww', '-axo', 'pid=,command='], { maxBuffer: 16 * 1024 * 1024 });
    const line = stdout.split('\n').find(line => line.includes(`XJ_SESSION_INSTANCE=${running.session.executorInstanceId}`));
    assert.ok(line, 'the accepted native instance must be a real OS process');
    const pid = Number(line.trim().split(/\s+/)[0]);
    assert.equal(alive(pid), true);
    return { root, resources, runtime, host, worker, api, ok, auth, student, node, running, pid, path, requestId, action, plan, claims,
      stopHost,
      async control(value) {
        const controlId = randomUUID();
        await ok(`${path}/${requestId}/control`, { controlId, operationId: 'advance', effect: 'input', expectedSeq: 0, parameters: { value } }, student);
        await worker.tick();
        return ok(`${path}/${requestId}`, undefined, student);
      },
      async revoke(axis) {
        if (axis === 'connection') await ok('manage/connection', { connectionId }, admin);
        else if (axis === 'member') await ok('manage/membership', { requestId: randomUUID(), principalId: identity.principalId, active: false }, admin);
        else await ok('manage/course-access', { requestId: randomUUID(), courseId, principalId: identity.principalId, active: false }, admin);
      },
      async restoreCourse() { await ok('manage/course-access', { requestId: randomUUID(), courseId, principalId: identity.principalId, active: true }, admin); },
      get terminal() { return terminal; }, get terminalReply() { return terminalReply; },
      allowTerminal() { blockTerminal = false; }, disconnect() { offline = true; }, reconnect() { offline = false; },
      loseTerminalReply() { loseTerminalReply = true; },
      async close() {
        blockTerminal = false; offline = false;
        await worker.stop();
        await stopHost();
        await rm(root, { recursive: true, force: true });
      } };
  } catch (error) {
    await worker?.stop(); await host?.stop(); await rm(root, { recursive: true, force: true }); throw error;
  }
}

test('school maintenance waits for the original native process exit and authenticated terminal acknowledgement', { timeout: 120000 }, async () => {
  const f = await schoolFixture();
  let entering;
  try {
    const pendingId = randomUUID();
    const pending = await f.ok(f.path, { action: f.action(pendingId) }, f.student);
    const cancelledId = randomUUID();
    await f.ok(f.path, { action: f.action(cancelledId) }, f.student);
    assert.equal((await f.ok(`${f.path}/${cancelledId}/stop`, { stopId: randomUUID(), reason: '' }, f.student)).state, 'cancelled');
    entering = f.host.maintenance.enter('native-channel-test');
    // Attach rejection immediately: red must report the assertion, never an unhandled rejection.
    entering.catch(() => {});
    await until(() => f.host.maintenance.status().phase !== 'open');
    await delay(150);
    assert.equal(f.host.maintenance.status().safeToStop, false, 'an active native process cannot be declared drained');
    assert.equal((await f.api('context')).status, 503);
    assert.equal((await f.api(`${f.path}/${f.requestId}/control`, { controlId: randomUUID(), operationId: 'advance',
      effect: 'input', expectedSeq: 0, parameters: { value: 1 } }, f.student)).status, 503);
    for (const operation of ['register', 'claim', 'report']) assert.equal((await f.api('native-channel/' + operation, f.node, f.auth)).status, 503);
    assert.equal((await f.api('native-channel/heartbeat', f.node, f.auth)).status, 503, 'bare heartbeats cannot renew a closing lease');
    assert.equal((await f.api('native-channel/heartbeat', { node: f.node, queries: [f.running] }, f.auth)).status, 503);
    f.worker.start();
    await until(() => !alive(f.pid));
    await until(() => !!f.terminal);
    assert.equal(f.host.maintenance.status().safeToStop, false, 'OS exit alone is not school acknowledgement');
    const wrong = structuredClone(f.terminal);
    wrong.query.session.executorInstanceId = randomUUID();
    assert.equal((await f.api('native-channel/cleanup', wrong)).status, 409);
    const neverClaimed = { ...pending, state: 'cancelled', statusKnowledge: 'confirmed', confirmedSeq: pending.confirmedSeq + 1 };
    assert.equal((await f.api('native-channel/cleanup', { ...f.terminal, commandId: pendingId, query: neverClaimed })).status, 403);
    for (const changed of [{ claimId: randomUUID() }, { generation: randomUUID() },
      { owner: { ...f.terminal.owner, serviceId: randomUUID() } },
      { node: { ...f.node, installationId: randomUUID() } }, { node: { ...f.node, supervisorEpoch: randomUUID() } }]) {
      assert.equal((await f.api('native-channel/cleanup', { ...f.terminal, ...changed })).status, 403);
    }
    assert.equal((await f.api('native-channel/cleanup', { ...f.terminal, query: { ...f.terminal.query, statusKnowledge: 'unknown' } })).status, 400);
    assert.equal((await f.api('native-channel/cleanup/extra', f.terminal)).status, 503);
    f.loseTerminalReply(); f.allowTerminal();
    await entering;
    assert.equal(f.terminalReply.status, 200);
    assert.equal(f.host.maintenance.status().safeToStop, true);
    assert.equal(alive(f.pid), false);
    assert.equal((await f.api('native-channel/heartbeat', f.terminal, f.auth)).status, 503);
    assert.equal((await f.api('native-channel/cleanup', f.terminal)).status, 200, 'the exact lost acknowledgement is readable after writes close');
    assert.equal((await f.api('native-channel/cleanup', { ...f.terminal,
      query: { ...f.terminal.query, confirmedSeq: f.terminal.query.confirmedSeq + 1 } })).status, 409);
    await f.host.maintenance.resume();
    await f.worker.tick();
    const stopped = await f.ok(`${f.path}/${f.requestId}`, undefined, f.student);
    assert.equal(stopped.state, 'running'); assert.equal(stopped.statusKnowledge, 'unknown');
    assert.equal(stopped.confirmedSeq, f.running.confirmedSeq);
    assert.deepEqual(stopped.session.observation, f.running.session.observation);
    assert.equal(stopped.session.executorInstanceId, f.running.session.executorInstanceId);
    const oldPending = await f.ok(`${f.path}/${pendingId}`, undefined, f.student);
    assert.equal(oldPending.statusKnowledge, 'unknown', 'never-claimed old targets must not replay after resume');
    assert.equal((await f.ok(`${f.path}/${cancelledId}`, undefined, f.student)).state, 'cancelled');
    assert.equal(alive(f.pid), false);
    const freshId = randomUUID();
    await f.ok(f.path, { action: f.action(freshId) }, f.student);
    await f.worker.tick();
    const fresh = await f.ok(`${f.path}/${freshId}`, undefined, f.student);
    assert.equal(fresh.state, 'running', 'lost terminal replies must not block new-generation work');
    assert.notEqual(fresh.executionRef, f.running.executionRef);
    assert.notEqual(fresh.session.executorInstanceId, f.running.session.executorInstanceId);
  } finally { f.allowTerminal(); await entering?.catch(() => {}); await f.close(); }
});

test('HTTP outage makes school maintenance fail despite real lease-expiry cleanup, then confirmation can retry', { timeout: 120000 }, async () => {
  const f = await schoolFixture();
  let entering;
  try {
    f.disconnect();
    f.worker.start();
    entering = f.host.maintenance.enter('unreachable-native-channel');
    const rejected = assert.rejects(entering, /unavailable/);
    await until(() => !alive(f.pid));
    await until(() => !!f.terminal);
    assert.equal(f.host.maintenance.status().safeToStop, false, 'expired lease and OS exit cannot replace a remote acknowledgement');
    await rejected;
    assert.equal(f.host.maintenance.status().phase, 'failed');
    assert.equal(f.host.maintenance.status().safeToStop, false);
    assert.equal(f.terminalReply, undefined);
    assert.equal((await f.api(`${f.path}/${f.requestId}`, undefined, f.student)).status, 503);
    f.reconnect(); f.allowTerminal();
    await f.host.maintenance.enter('retry-native-confirmation');
    assert.equal(f.terminalReply.status, 200);
    assert.equal(f.host.maintenance.status().safeToStop, true);
    await f.host.maintenance.resume();
    const stopped = await f.ok(`${f.path}/${f.requestId}`, undefined, f.student);
    assert.equal(stopped.state, 'running'); assert.equal(stopped.statusKnowledge, 'unknown');
    assert.equal(stopped.session.executorInstanceId, f.running.session.executorInstanceId);
    assert.equal(alive(f.pid), false);
  } finally { f.reconnect(); f.allowTerminal(); await entering?.catch(() => {}); await f.close(); }
});

for (const axis of ['course', 'member', 'connection']) test(`original cleanup capability survives ${axis} revocation without restoring execution eligibility`, { timeout: 120000 }, async () => {
  const f = await schoolFixture();
  try {
    await f.revoke(axis);
    await f.worker.stop();
    assert.equal(alive(f.pid), false, 'revocation cleanup must terminate the real original process');
    assert.ok(f.terminal);
    assert.equal((await f.api('native-channel/heartbeat', { node: f.node, queries: [f.running] }, f.auth)).status, 403);
    assert.equal((await f.api('native-channel/claim', f.node, f.auth)).status, 403);
    const result = await f.api('native-channel/cleanup', f.terminal);
    assert.equal(result.status, 200, 'the original claim may confirm exit even after current eligibility is revoked');
    assert.deepEqual(result.value, { commandId: f.requestId, state: 'cleaned' });
    assert.equal((await f.api('native-channel/claim', f.node, f.auth)).status, 403, 'cleanup must not grant execution eligibility');
    const boundary = await f.host.maintenance.enter('revoked-native-cleanup');
    assert.equal(boundary.safeToStop, true);
    assert.deepEqual(await f.api('native-channel/cleanup', f.terminal), { status: 200,
      value: { commandId: f.requestId, state: 'cleaned' }, cookie: undefined }, 'closed writes still allow the exact acknowledged cleanup retry');
  } finally {
    if (axis === 'course' && f.host.maintenance.status().phase === 'open') await f.restoreCourse();
    f.allowTerminal(); await f.close();
  }
});

test('product backup and isolated restore preserve course plan, original actions, claimed targets and cleanup proofs without replay', { timeout: 180000 }, async () => {
  const f = await schoolFixture({ publishPlan: true });
  const directory = await mkdtemp(join(tmpdir(), 'xj-channel-maintenance-recovery-'));
  const targetRoot = join(directory, 'restored');
  const targetRuntime = openProductRuntime({ root: targetRoot, resources: f.resources });
  let targetHost;
  let owners = [];
  const handles = [];
  const openOwner = async (root, unit, migrations) => {
    const descriptor = f.host.environment.services.find(service => service.unit === unit);
    const storage = await openRecoveredStorage({ root, serviceId: descriptor.serviceId, migrations,
      backend: createFileBackend({ id: unit, root: join(root, 'learning-resources', unit) }) });
    handles.push(storage);
    return storage;
  };
  const closeHandles = async () => { for (const storage of handles.splice(0)) await storage.close(); };
  const closeOwners = async () => { for (const owner of owners.splice(0)) await owner.close?.(); };
  const facts = async storage => ({
    commands: (await storage.read(`SELECT command_id,command_text,claim_id,claim_node,claim_generation,target_node,target_generation,
      result,observed_result,observed_seq FROM native_channel_commands ORDER BY position`)).rows,
    actions: (await storage.read('SELECT request_id,action_text,activity,execution FROM channel_executions ORDER BY request_id')).rows,
    cleanups: (await storage.read(`SELECT command_id,claim_id,node,owner,generation,execution_identity,proof_digest
      FROM native_channel_cleanups ORDER BY command_id`)).rows,
  });
  try {
    const controlled = await f.control(1);
    assert.equal(controlled.session.appliedSeq, 1);
    assert.deepEqual(controlled.session.observation, { value: 1, total: 1, applied: 1 });
    f.allowTerminal();
    await f.worker.stop();
    assert.equal(alive(f.pid), false);
    assert.equal(f.terminalReply.status, 200);
    assert.equal((await f.host.maintenance.enter('confirmed-cleanup-before-backup')).safeToStop, true);
    await f.host.maintenance.resume();
    const sourceData = await openOwner(f.root, 'learning-data', learningMigrations);
    const before = await facts(sourceData), submit = f.claims.find(command => command.operation === 'submit');
    assert.equal(before.commands.length, 2);
    assert.equal(before.actions[0].action_text, JSON.stringify(submit.payload.action));
    assert.deepEqual(before.actions[0].activity.course.executionPlan, f.plan);
    assert.equal(before.cleanups[0].proof_digest, hash(f.terminal));
    assert.equal(before.cleanups[0].claim_id, submit.claimId);
    for (const command of before.commands) {
      assert.deepEqual(command.claim_node, f.node); assert.deepEqual(command.target_node, f.node);
      assert.equal(command.target_generation, submit.generation);
    }
    await closeHandles();
    const key = randomBytes(32), backups = join(directory, 'backups');
    const backup = await f.host.recovery.backup({ directory: backups, key, leaveClosed: true });
    assert.equal(backup.services.length, 3);
    assert.equal(f.host.maintenance.status().safeToStop, true);
    await f.stopHost(); // Free the source PG before creating the independent restore PG.
    const restored = await restoreProductRecovery({ root: targetRoot, resources: f.resources, installation: { profile: 'school' },
      backupDirectory: join(backups, backup.backupId), key });
    owners = [...restored.owners];
    for (const owner of owners) await owner.participant.validate();
    const recoveredData = await openOwner(targetRoot, 'learning-data', learningMigrations);
    assert.deepEqual(await facts(recoveredData), before, 'restore preserves fixed bytes and facts in all channel tables');
    await assert.rejects(recoveredData.pendingIntents(), { code: 'maintenance' });
    await assert.rejects(recoveredData.request({ requestId: randomUUID(), fingerprint: 'isolated-owner' }, async () => null), { code: 'maintenance' });
    const recoveredSpace = await openOwner(targetRoot, 'space-course', spaceCourseMigrations);
    const environment = (await targetRuntime.status()).environment;
    assert.notEqual(environment.installationId, f.host.environment.installationId);
    const spaces = createSpaces(recoveredSpace, { credentialNamespace: environment.installationId });
    const token = f.auth.authorization.slice(7);
    await assert.rejects(spaces.authenticateConnection(token, f.node.connectionId), { code: 'forbidden' });
    const channel = createNativeChannel(recoveredData, { authenticate: spaces.authenticateConnection,
      authorizeConnection: spaces.authorizeConnection, async authorize() { throw new StorageError('forbidden'); } });
    await assert.rejects(channel.register(token, f.node), { code: 'forbidden' });
    await assert.rejects(channel.report(token, { node: f.node, commandId: submit.commandId, claimId: submit.claimId,
      result: controlled }), { code: 'forbidden' });
    assert.deepEqual(await channel.cleanup(f.terminal), { commandId: f.requestId, state: 'cleaned' });
    await channel.drain();
    await closeHandles(); await closeOwners();
    targetHost = await createProductRuntimeHost({ root: targetRoot, createApplication: createProductLearningApplication });
    assert.equal((await targetHost.status()).state, 'maintenance');
    const call = async (operation, body) => fetch(new URL('/api/learning/native-channel/' + operation, targetHost.endpoint), {
      method: 'POST', headers: { 'content-type': 'application/json', ...f.auth }, body: JSON.stringify(body) });
    for (const operation of ['register', 'claim', 'heartbeat', 'report']) assert.equal((await call(operation, f.node)).status, 503);
    assert.equal((await call('cleanup', f.terminal)).status, 200);
    await assert.rejects(targetHost.maintenance.resume(), /target-isolated/);
    assert.equal(alive(f.pid), false);
    assert.equal(f.claims.length, 2, 'restoring never requests another submit or control from the original worker');
  } finally {
    await closeHandles(); await closeOwners();
    await targetHost?.stop();
    await targetRuntime.stop();
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
