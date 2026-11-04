import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { createNativeChannel, createSpaces, learningMigrations, spaceMigrations, validateNativeChannel, SupervisedSession } from '@xunjie/learning-space';
import { createNativeChannelWorker, nativeChannelNode } from '@xunjie/product-runtime';
import { accumulatorPackage } from '../../../components/state-accumulator/package.mjs';
import { canonicalValue } from '@xunjie/contracts/execution';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { createExecutions } from '../../../packages/learning-space/dist/learning-data/executions.js';
import { createWorks } from '../../../packages/learning-space/dist/learning-data/works.js';

// 独立的真实所有者保证领取协议不依赖学校和本机共享数据库。
test('authenticated pull channel binds owner, approved connection and installation on every claim', { timeout: 120000 }, async () => {
  const fixture = await nativeFixture(), opened = [];
  const workerRoot = await mkdtemp(join(tmpdir(), 'xj-native-channel-'));
  try {
    async function owner(migrations) {
      const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
      const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomBytes(32).toString('base64url'), migrations });
      const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: owner.serviceId, root: join(fixture.root, owner.serviceId) }) });
      opened.push(storage); return storage;
    }
    const school = await owner(spaceMigrations), data = await owner(learningMigrations);
    const spaces = createSpaces(school);
    const identity = await spaces.createMember({ requestId: randomUUID(), loginName: 'channel-student', password: 'channel-password-123456' });
    const login = await spaces.login('channel-student', 'channel-password-123456');
    async function connection() {
      const connectionId = randomUUID(), verifier = randomBytes(48).toString('base64url');
      await spaces.beginConnection({ requestId: connectionId, clientId: randomUUID(), challenge: createHash('sha256').update(verifier).digest('base64url') });
      await spaces.approveConnection(login.token, connectionId);
      return spaces.exchangeConnection(connectionId, verifier);
    }
    const grant = await connection(), other = await connection();
    const node = { connectionId: grant.connectionId, nodeId: 'approved-mac-node', installationId: randomUUID(), platform: 'macos-arm64', supervisorEpoch: randomUUID(), adapters: [{ adapterId: 'four-state-accumulator', adapterVersion: 1 }] };
    const activityId = randomUUID(), sessionId = randomUUID();
    let eligible = true;
    const channel = createNativeChannel(data, {
      authenticate: spaces.authenticateConnection, authorizeConnection: spaces.authorizeConnection,
      async authorize(member, activity) {
        await spaces.authorize(member);
        if (activity !== activityId || !eligible) throw new StorageError('forbidden');
      },
    });
    await assert.rejects(channel.register(other.token, node), { code: 'forbidden' });
    const registered = await channel.register(grant.token, node);
    assert.deepEqual(registered.owner, data.owner);
    assert.equal(registered.generation, data.generation);
    await assert.rejects(channel.register(grant.token, { ...node, installationId: randomUUID() }), { code: 'identity-conflict' });
    const command = { commandId: randomUUID(), activityId, sessionId, operation: 'submit', payload: { value: 0 } };
    await channel.enqueue(identity, node.connectionId, command);
    await channel.enqueue(identity, node.connectionId, command);
    await assert.rejects(channel.enqueue(identity, node.connectionId, { ...command, payload: { value: 1 } }), { code: 'identity-conflict' });
    const control = { ...command, commandId: randomUUID(), operation: 'control', payload: { value: 1 } };
    await channel.enqueue(identity, node.connectionId, control);
    const first = await channel.claim(grant.token, node);
    assert.equal(first.command.commandId, command.commandId);
    assert.equal((await channel.claim(grant.token, node)).command, null);
    assert.equal((await channel.query(identity, command.commandId)).statusKnowledge, 'unknown');
    const report = { node, commandId: command.commandId, claimId: first.command.claimId, result: { state: 'running', observation: 0 } };
    await channel.report(grant.token, report);
    await channel.report(grant.token, report);
    await assert.rejects(channel.report(grant.token, { ...report, result: { observation: 9 } }), { code: 'identity-conflict' });
    const second = await channel.claim(grant.token, node);
    assert.equal(second.command.commandId, control.commandId);
    await channel.report(grant.token, { node, commandId: control.commandId, claimId: second.command.claimId, result: { state: 'running', observation: 1 } });
    assert.equal((await channel.claim(grant.token, node)).command, null);

    // 客户端执行后报告失联；新 worker 只发送旧结果，不重复执行命令。
    const stop = { ...command, commandId: randomUUID(), operation: 'stop', payload: { reason: 'student' } };
    await channel.enqueue(identity, node.connectionId, stop);
    let executions = 0, cleanups = 0, loseReport = true;
    const workerOptions = { root: workerRoot, node,
      async call(operation, input) {
        if (operation === 'report' && loseReport) throw new StorageError('unavailable');
        return channel[operation](grant.token, input);
      },
      async execute() { executions++; return { state: 'stopped' }; },
      async cleanup() { cleanups++; },
    };
    const worker = createNativeChannelWorker(workerOptions);
    await assert.rejects(worker.tick(), { code: 'unavailable' });
    assert.equal(executions, 1);
    loseReport = false;
    const restarted = createNativeChannelWorker(workerOptions);
    await restarted.tick();
    assert.equal(executions, 1);
    assert.deepEqual((await channel.query(identity, stop.commandId)).result, { state: 'stopped' });
    await worker.stop(); await restarted.stop();
    assert.equal(cleanups, 1);

    const interrupted = { ...command, commandId: randomUUID(), sessionId: randomUUID() };
    await channel.enqueue(identity, node.connectionId, interrupted);
    const oldClaim = (await channel.claim(grant.token, node)).command;
    channel.closeDispatch();
    const participant = data.participant();
    await participant.closeWrites();
    await participant.resume();
    channel.resume();
    await channel.register(grant.token, node);
    assert.equal((await channel.query(identity, interrupted.commandId)).statusKnowledge, 'unknown');
    await assert.rejects(channel.report(grant.token, { node, commandId: interrupted.commandId,
      claimId: oldClaim.claimId, result: { state: 'running' } }), { code: 'forbidden' });
    assert.deepEqual((await channel.query(identity, stop.commandId)).result, { state: 'stopped' });

    await channel.enqueue(identity, node.connectionId, { ...command, commandId: randomUUID(), sessionId: randomUUID() });
    eligible = false;
    await assert.rejects(channel.claim(grant.token, node), { code: 'forbidden' });
    eligible = true;
    await spaces.revokeConnection(identity, grant.connectionId);
    await assert.rejects(channel.claim(grant.token, node), { code: 'forbidden' });
    await assert.rejects(channel.register(grant.token, node), { code: 'forbidden' });
    await assert.rejects(channel.enqueue(identity, node.connectionId, { ...command, commandId: randomUUID(), sessionId: randomUUID() }), { code: 'forbidden' });
    await assert.rejects(channel.query(identity, stop.commandId), { code: 'forbidden' });
    await validateNativeChannel(data);
  } finally {
    for (const storage of opened.reverse()) await storage.close();
    await fixture.close();
    await rm(workerRoot, { recursive: true, force: true });
  }
});

test('database-free default worker executes real native accumulator and reports idle exit without new input', { timeout: 120000 }, async t => {
  const fixture = await nativeFixture(), root = await mkdtemp(join(tmpdir(), 'xj-real-channel-'));
  let storage, worker;
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations: learningMigrations });
    storage = await openStorage({ binding, migrations: learningMigrations, backend: createFileBackend({ id: 'channel', root: join(fixture.root, 'resources') }) });
    const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '学校' };
    const node = await nativeChannelNode({ connectionId: randomUUID(), installationId: randomUUID(), sessionRoot: join(root, 'sessions') });
    assert.ok(node.adapters.some(item => item.adapterId === 'four-state-accumulator'));
    const children = [], originalCreate = SupervisedSession.create;
    t.mock.method(SupervisedSession, 'create', async function (...args) {
      const child = await originalCreate.apply(this, args); children.push(child); return child;
    });
    let idleActivityId;
    const activityId = randomUUID(), requestId = randomUUID(), executionRef = randomUUID();
    const { manifest } = await accumulatorPackage(), declared = manifest.session;
    const hash = value => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
    const definition = { manifest, digest: hash(manifest) };
    const activity = { activityId, identity, target: { ...owner, version: 1 }, goal: '真实会话', question: '', references: [],
      status: 'open', createdAt: new Date().toISOString(), course: { associationId: randomUUID(), courseId: randomUUID(), courseName: '原生',
        taskId: randomUUID(), taskTitle: '四态', releaseId: randomUUID(), contentDigest: hash('course'), objectives: ['观察'], requirements: '输入',
        materials: [], starterWorks: [], capabilities: [], components: [{ key: 'accumulator', definition, configuration: { title: '四态' }, materialIds: [] }] } };
    const action = { protocolVersion: 2, kind: 'execution', requestId, scope: { environmentId: identity.environmentId, spaceId: identity.spaceId,
      principalId: identity.principalId, activityId }, receiver: { receiverId: 'native-execution', location: 'remote', kind: 'execution' },
      execution: { instance: { instanceId: `${activityId}:accumulator`, key: 'accumulator', componentId: manifest.componentId, componentVersion: 1,
        definitionDigest: definition.digest, hostApiVersion: 1, stateVersion: 1 }, operation: { operationId: 'advance', effect: 'input' }, parameters: {},
        basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] }, limits: { timeMs: 5000, memoryPages: 1, inputBytes: 1024,
          outputBytes: 65536, concurrentJobs: 2, queuedJobs: 0 }, plan: { planId: 'native-session', planVersion: 1, location: 'native', kind: 'session',
          planDigest: hash({ planId: 'native-session', planVersion: 1, componentId: manifest.componentId, componentVersion: 1, operationId: 'advance' }) },
        session: { adapterId: declared.adapterId, adapterVersion: 1, limits: { operationTimeoutMs: 5000, idleMs: 600000, maxMs: 3600000, memoryMiB: 64,
          concurrentSessions: 2, queuedSessions: 0 } }, initiator: { kind: 'student', principalId: identity.principalId } } };
    const execution = { requestId, inputDigest: hash(action), scope: action.scope, executionRef, state: 'queued', statusKnowledge: 'confirmed',
      stopRequested: false, confirmedSeq: 1, reason: null, output: null, session: { adapterId: declared.adapterId, adapterVersion: 1,
        instanceId: action.execution.instance.instanceId, instanceKey: 'accumulator', nodeId: node.nodeId, installGeneration: node.installationId,
        supervisorEpoch: node.supervisorEpoch, executorInstanceId: randomUUID(), appliedSeq: 0, lastControlId: null, observation: null, observations: [] } };
    const revokedActivities = new Set();
    const channel = createNativeChannel(storage, { async authenticate(token, id) { assert.equal(token, 'approved'); assert.equal(id, node.connectionId); return identity; },
      async authorizeConnection() {}, async authorize(member, id) {
        assert.deepEqual(member, identity); assert.ok(id === activityId || id === idleActivityId);
        if (revokedActivities.has(id)) throw new StorageError('forbidden');
      } });
    await channel.register('approved', node);
    worker = createNativeChannelWorker({ root, node, native: { nodePath: process.execPath, sessionRoot: join(root, 'sessions') },
      call: (operation, input) => channel[operation]('approved', input) });
    await channel.enqueue(identity, node.connectionId, { commandId: requestId, activityId, sessionId: executionRef, operation: 'submit', payload: { action, activity, execution } });
    await worker.tick();
    assert.equal((await channel.query(identity, requestId)).result.state, 'running');
    for (const [seq, value, expected] of [[0, 1, 1], [1, 2, 3], [2, 2, 1]]) {
      const controlId = randomUUID();
      await channel.enqueue(identity, node.connectionId, { commandId: controlId, activityId, sessionId: executionRef, operation: 'control',
        payload: { requestId, executionRef, control: { controlId, operationId: 'advance', effect: 'input', expectedSeq: seq, parameters: { value } } } });
      await worker.tick();
      const result = (await channel.query(identity, controlId)).result;
      assert.equal(result.session.observation.value, expected);
      assert.equal(result.session.appliedSeq, seq + 1);
      assert.equal(result.session.executorInstanceId, execution.session.executorInstanceId);
    }
    const stopId = randomUUID();
    await channel.enqueue(identity, node.connectionId, { commandId: stopId, activityId, sessionId: executionRef, operation: 'stop',
      payload: { requestId, executionRef, stop: { stopId, reason: 'student' } } });
    await worker.tick();
    assert.equal((await channel.query(identity, stopId)).result.state, 'cancelled');

    idleActivityId = randomUUID();
    const idleManifest = structuredClone(manifest);
    idleManifest.version = 2; idleManifest.session.budgets.idleMs = 1000;
    const idleActivity = { ...structuredClone(activity), activityId: idleActivityId,
      course: { ...structuredClone(activity.course), associationId: randomUUID(), releaseId: randomUUID(),
        components: [{ ...structuredClone(activity.course.components[0]), definition: { manifest: idleManifest, digest: hash(idleManifest) } }] } };
    const idleAction = structuredClone(action);
    idleAction.requestId = randomUUID(); idleAction.scope.activityId = idleActivityId; idleAction.receiver.location = 'local';
    idleAction.execution.instance.instanceId = `${idleActivityId}:accumulator`;
    idleAction.execution.instance.componentVersion = 2; idleAction.execution.instance.definitionDigest = hash(idleManifest);
    idleAction.execution.session.limits.idleMs = 1000;
    idleAction.execution.plan.planDigest = hash({ planId: 'native-session', planVersion: 1, componentId: manifest.componentId, componentVersion: 2, operationId: 'advance' });
    const authorize = async (who, id) => { assert.deepEqual(who, identity); assert.equal(id, idleActivityId); };
    const schoolExecution = createExecutions(storage, { channel, works: createWorks(storage, authorize), activity: async (who, id) => {
      await authorize(who, id); return idleActivity;
    } });
    const idleAccepted = await schoolExecution.accept(identity, idleActivityId, { action: idleAction });
    await worker.tick();
    const idleRunning = await schoolExecution.read(identity, idleActivityId, idleAction.requestId);
    assert.equal(idleRunning.state, 'running');
    const { rows: [originalReceipt] } = await storage.read('SELECT result FROM native_channel_commands WHERE command_id=$1', [idleAction.requestId]);
    const exit = await children.at(-1).settled(5000);
    assert.equal(exit.expired, 'idle'); assert.equal(exit.confirmed, true);
    await worker.tick();
    const expired = await schoolExecution.read(identity, idleActivityId, idleAction.requestId);
    assert.equal(expired.state, 'failed'); assert.equal(expired.statusKnowledge, 'confirmed');
    assert.equal(expired.reason.code, 'budget-exceeded'); assert.equal(expired.session.appliedSeq, 0);
    assert.equal(expired.executionRef, idleAccepted.executionRef);
    const { rows: idleCommands } = await storage.read('SELECT operation,result,observed_result FROM native_channel_commands WHERE session_id=$1', [expired.executionRef]);
    assert.equal(idleCommands.length, 1); assert.equal(idleCommands[0].operation, 'submit');
    assert.deepEqual(idleCommands[0].result, originalReceipt.result);
    assert.equal(idleCommands[0].observed_result.state, 'failed');
    await channel.heartbeat('approved', { node, queries: [idleRunning] });
    assert.equal((await schoolExecution.read(identity, idleActivityId, idleAction.requestId)).state, 'failed');
    await assert.rejects(channel.heartbeat('approved', { node, queries: [{ ...expired, session: { ...expired.session, executorInstanceId: randomUUID() } }] }), { code: 'identity-conflict' });
    revokedActivities.add(idleActivityId);
    await worker.tick();
    await validateNativeChannel(storage);
  } finally { if (worker) await worker.stop(); if (storage) await storage.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

test('long legal native operation renews its authenticated lease independently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-channel-heartbeat-'));
  const node = { connectionId: randomUUID(), nodeId: 'heartbeat-node', installationId: randomUUID(), platform: 'macos-arm64',
    supervisorEpoch: randomUUID(), adapters: [{ adapterId: 'four-state-accumulator', adapterVersion: 1 }] };
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  let renewals = 0, cleanups = 0;
  const worker = createNativeChannelWorker({ root, node,
    async call(operation, input) {
      if (operation === 'register') return { ...node, owner, generation: '1', leaseMs: 1000 };
      if (operation === 'heartbeat') { renewals++; return { leaseMs: 1000 }; }
      if (operation === 'claim') return { command: { commandId: randomUUID(), activityId: randomUUID(), sessionId: randomUUID(),
        operation: 'submit', payload: {}, claimId: randomUUID(), node, owner, generation: '1' }, leaseMs: 1000 };
      return { commandId: input.commandId, state: 'reported' };
    },
    async execute() { await new Promise(resolve => setTimeout(resolve, 1300)); return { state: 'running' }; },
    async cleanup() { cleanups++; },
  });
  try { await worker.tick(); assert.ok(renewals >= 2); assert.equal(cleanups, 0); }
  finally { await worker.stop(); await rm(root, { recursive: true, force: true }); }
});

test('successful registration cannot extend execution lease when claim eligibility is unavailable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xj-channel-lease-'));
  const node = { connectionId: randomUUID(), nodeId: 'lease-node', installationId: randomUUID(), platform: 'macos-arm64', supervisorEpoch: randomUUID(), adapters: [{ adapterId: 'four-state-accumulator', adapterVersion: 1 }] };
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const command = { commandId: randomUUID(), activityId: randomUUID(), sessionId: randomUUID(), operation: 'submit',
    payload: {}, claimId: randomUUID(), node, owner, generation: '1' };
  let now = 1000, failing = false, cleaned = 0;
  t.mock.method(Date, 'now', () => now);
  const worker = createNativeChannelWorker({ root, node,
    async call(operation, input) {
      if (operation === 'register') return { ...node, owner, generation: '1', leaseMs: 1000 };
      if (operation === 'heartbeat') { if (failing) throw new StorageError('unavailable'); return { leaseMs: 1000 }; }
      if (operation === 'claim') {
        if (failing) throw new StorageError('unavailable');
        return { command, leaseMs: 1000 };
      }
      return { commandId: input.commandId, state: 'reported' };
    },
    async execute() { return { state: 'running' }; },
    async cleanup() { cleaned++; },
  });
  try {
    await worker.tick();
    now = 2001; failing = true;
    await assert.rejects(worker.tick(), { code: 'unavailable' });
    assert.equal(cleaned, 1);
  } finally { await worker.stop(); await rm(root, { recursive: true, force: true }); }
});
