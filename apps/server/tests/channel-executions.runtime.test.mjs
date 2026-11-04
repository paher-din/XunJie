import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { createNativeChannel, createSpaces, learningMigrations, spaceMigrations, SupervisedSession } from '@xunjie/learning-space';
import { createNativeChannelWorker, nativeChannelNode } from '@xunjie/product-runtime';
import { createNativeChannelClients } from '../../../packages/product-runtime/dist/native-channel-clients.js';
import { canonicalValue, courseExecutionPlanBasis, executionActionSchema, executionQuerySchema } from '@xunjie/contracts/execution';
import { activitySchema } from '@xunjie/contracts/learning-data';
import { createExecutions } from '../../../packages/learning-space/dist/learning-data/executions.js';
import { validateChannelExecutions } from '../../../packages/learning-space/dist/learning-data/channel-executions.js';
import { createWorks } from '../../../packages/learning-space/dist/learning-data/works.js';
import { accumulatorPackage } from '../../../components/state-accumulator/package.mjs';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonicalDigest = value => digest(canonicalValue(value));

// 学校与本机没有共享数据库；默认 worker 真实启动产品登记适配器，学校只反映认证通道的事实。
test('school facade runs approved local processes, stops with an empty reason and cleans up after membership revocation', { timeout: 120000 },
  t => approvedLocalProcess(t));

test('worker stop rejects an unconfirmed process exit and retries the same live instance', { timeout: 120000 },
  t => approvedLocalProcess(t, 'worker-stop'));

test('maintenance pause rejects unconfirmed local cleanup and retains the instance for a retry', { timeout: 120000 },
  t => approvedLocalProcess(t, 'maintenance-pause'));

test('an unconfirmed ordinary stop reports a valid unknown execution and eventually reclaims its real process', { timeout: 120000 },
  t => approvedLocalProcess(t, 'ordinary-stop'));

test('approved channel checkpoints survive a lost report and restore real state in a distinct executor', { timeout: 120000 },
  t => approvedLocalProcess(t, 'checkpoint'));

async function approvedLocalProcess(t, cleanupBoundary = 'revocation') {
  const fixture = await nativeFixture(), opened = [], children = [];
  let worker, clients;
  try {
    async function owner(migrations) {
      const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
      const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomBytes(32).toString('base64url'), migrations });
      const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: owner.serviceId, root: join(fixture.root, owner.serviceId) }) });
      opened.push(storage);
      return storage;
    }
    const school = await owner(spaceMigrations), data = await owner(learningMigrations), spaces = createSpaces(school);
    const identity = await spaces.createMember({ requestId: randomUUID(), loginName: 'facade-student', password: 'synthetic-facade-password' });
    const login = await spaces.login('facade-student', 'synthetic-facade-password');
    const connectionId = randomUUID(), verifier = randomBytes(48).toString('base64url');
    await spaces.beginConnection({ requestId: connectionId, clientId: randomUUID(), challenge: createHash('sha256').update(verifier).digest('base64url') });
    await spaces.approveConnection(login.token, connectionId);
    const grant = await spaces.exchangeConnection(connectionId, verifier);
    const native = { nodePath: process.execPath, sessionRoot: join(fixture.root, 'sessions'),
      ...(process.env.XUNJIE_NATIVE_SESSION_HELPER ? { windowsHelper: process.env.XUNJIE_NATIVE_SESSION_HELPER } : {}) };
    const installationId = randomUUID();
    const node = await nativeChannelNode({ ...native, connectionId, installationId, supervisorEpoch: randomUUID() });
    assert.ok(node.adapters.some(adapter => adapter.adapterId === 'four-state-accumulator'), '当前测试宿主必须具备产品适配器所需的真实隔离环境。');
    const originalCreate = SupervisedSession.create;
    t.mock.method(SupervisedSession, 'create', async function (...args) {
      const child = await originalCreate.apply(this, args);
      children.push(child);
      return child;
    });
    const activityId = randomUUID();
    const authorize = async (who, id) => {
      await spaces.authorize(who);
      if (id !== activityId || who.principalId !== identity.principalId) throw new StorageError('forbidden');
    };
    const channel = createNativeChannel(data, { authenticate: spaces.authenticateConnection,
      authorizeConnection: spaces.authorizeConnection, authorize });
    await channel.register(grant.token, node);
    let droppedCheckpoint = false;
    worker = createNativeChannelWorker({ root: join(fixture.root, 'device'), node, native,
      call: async (operation, input) => {
        const reply = await (operation === 'cleanup' ? channel.cleanup(input) : channel[operation](grant.token, input));
        if (cleanupBoundary === 'checkpoint' && operation === 'report' && input.result?.checkpoint && !droppedCheckpoint) {
          droppedCheckpoint = true; throw new Error('checkpoint report accepted; reply lost');
        }
        return reply;
      } });
    const { manifest } = await accumulatorPackage({ version: cleanupBoundary === 'checkpoint' ? 2 : 1 }), declared = manifest.session, definitionDigest = 'a'.repeat(64);
    const configuration = { title: '学校网页获准本机会话' };
    const plan = { planId: 'local-accumulator', planVersion: 1, planDigest: '0'.repeat(64),
      components: [{ key: 'accumulator', definitionDigest, configurationDigest: canonicalDigest(configuration), operations: ['advance'] }],
      capabilities: ['native-session'], resources: { browser: null, native: { memoryMiB: declared.budgets.memoryMiB,
        operationTimeoutMs: declared.budgets.operationTimeoutMs, maxMs: declared.budgets.maxMs } }, locations: ['native'], remote: null };
    plan.planDigest = canonicalDigest(courseExecutionPlanBasis(plan));
    const activity = activitySchema.parse({ activityId, identity,
      target: { ...data.owner, version: 1 }, goal: '连续输入并观察真实子进程状态', question: '', references: [], status: 'open', createdAt: new Date().toISOString(),
      course: { associationId: randomUUID(), courseId: randomUUID(), courseName: '本机执行课程', taskId: randomUUID(), taskTitle: '四态累加',
        releaseId: randomUUID(), contentDigest: 'b'.repeat(64), objectives: ['真实本机会话'], requirements: '依次输入 1、2、2，观察 1、3、1。',
        materials: [], starterWorks: [], capabilities: [], executionPlan: plan, components: [{ key: 'accumulator',
          definition: { digest: definitionDigest, manifest }, configuration, materialIds: [] }] } });
    await data.request({ requestId: 'facade-activity', fingerprint: activityId }, async tx => {
      await tx.query('INSERT INTO activities(id,space_environment_id,space_id,principal_id,body) VALUES($1,$2,$3,$4,$5)',
        [activityId, identity.environmentId, identity.spaceId, identity.principalId, JSON.stringify(activity)]);
      return null;
    });
    const executionOwner = createExecutions(data, { channel, works: createWorks(data, authorize), activity: async (who, id) => {
      await authorize(who, id); return activity;
    } });
    const actionOf = () => executionActionSchema.parse({ protocolVersion: 2, kind: 'execution', requestId: randomUUID(),
      scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId },
      receiver: { receiverId: 'approved-local', location: 'local', kind: 'execution' },
      execution: { instance: { instanceId: `${activityId}:accumulator`, key: 'accumulator', componentId: manifest.componentId,
        componentVersion: manifest.version, definitionDigest, hostApiVersion: 1, stateVersion: 1 },
        operation: { operationId: 'advance', effect: 'input' }, parameters: {},
        basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] },
        limits: { timeMs: declared.budgets.operationTimeoutMs, memoryPages: 1, inputBytes: declared.budgets.inputBytes,
          outputBytes: declared.budgets.outputBytes, concurrentJobs: declared.budgets.concurrentSessions, queuedJobs: declared.budgets.queuedSessions },
        plan: { planId: 'native-session', planVersion: 1, location: 'native', kind: 'session', planDigest: canonicalDigest({
          planId: 'native-session', planVersion: 1, componentId: manifest.componentId, componentVersion: manifest.version, operationId: 'advance' }) },
        session: { adapterId: declared.adapterId, adapterVersion: declared.adapterVersion,
          limits: Object.fromEntries(['operationTimeoutMs', 'idleMs', 'maxMs', 'memoryMiB', 'concurrentSessions', 'queuedSessions']
            .map(key => [key, declared.budgets[key]])) },
        initiator: { kind: 'student', principalId: identity.principalId } } });
    await worker.tick();
    const action = actionOf(), requestId = action.requestId;
    const accepted = await executionOwner.accept(identity, activityId, { action });
    assert.equal(accepted.state, 'queued');
    assert.equal(accepted.inputDigest, digest(action));
    assert.equal(accepted.session.nodeId, node.nodeId);
    assert.equal(accepted.session.installGeneration, node.installationId);
    assert.equal(accepted.session.supervisorEpoch, node.supervisorEpoch);
    assert.deepEqual(await executionOwner.accept(identity, activityId, { action }), accepted);
    await worker.tick();
    assert.equal(children.length, 1);
    assert.ok(children[0].pid > 0);
    const running = await executionOwner.read(identity, activityId, requestId);
    assert.equal(running.state, 'running', JSON.stringify(running));
    assert.deepEqual(running.session.observation, { value: 0, total: 0, applied: 0 });
    assert.equal(running.confirmedSeq, 2);
    const fixed = query => [query.executionRef, query.inputDigest, query.session.nodeId, query.session.installGeneration,
      query.session.supervisorEpoch, query.session.executorInstanceId];
    assert.deepEqual(fixed(running), fixed(accepted));
    const { rows: [submitted] } = await data.read('SELECT command FROM native_channel_commands WHERE command_id=$1', [requestId]);
    assert.deepEqual(submitted.command.payload, { action, activity, execution: accepted });
    let last = running;
    for (const [index, value] of (cleanupBoundary === 'checkpoint' ? [1, 2] : [1, 2, 2]).entries()) {
      const control = { controlId: randomUUID(), operationId: 'advance', effect: 'input', expectedSeq: index, parameters: { value } };
      await executionOwner.control(identity, activityId, requestId, control);
      await worker.tick();
      last = await executionOwner.read(identity, activityId, requestId);
      assert.equal(last.session.observation.value, [1, 3, 1][index]);
      assert.equal(last.session.appliedSeq, index + 1);
      assert.equal(last.confirmedSeq, index + 3);
      assert.equal(last.session.lastControlId, control.controlId);
      assert.deepEqual(fixed(last), fixed(accepted));
      assert.deepEqual(await executionOwner.control(identity, activityId, requestId, control), last);
      await worker.tick();
      assert.deepEqual(await executionOwner.read(identity, activityId, requestId), last);
    }
    if (cleanupBoundary === 'checkpoint') {
      const apply = async (query, effect, parameters = {}) => {
        const input = { controlId: randomUUID(), operationId: effect === 'input' ? 'advance' : effect,
          effect, expectedSeq: query.session.appliedSeq, parameters };
        await executionOwner.control(identity, activityId, query.requestId, input);
        if (effect === 'checkpoint' && !droppedCheckpoint) await assert.rejects(worker.tick(), /reply lost/);
        await worker.tick();
        const updated = await executionOwner.read(identity, activityId, query.requestId);
        const receipt = await executionOwner.controlReceipt(identity, activityId, query.requestId, input.controlId);
        assert.equal(receipt.status, 'applied');
        assert.equal(receipt.inputDigest, canonicalDigest(input));
        assert.deepEqual(await executionOwner.control(identity, activityId, query.requestId, input), updated);
        await worker.tick();
        return updated;
      };
      last = await apply(last, 'pause');
      assert.equal(last.state, 'paused');
      const saved = await apply(last, 'checkpoint');
      const checkpoint = saved.session.checkpoints[0];
      assert.ok(checkpoint?.sha256);
      assert.equal(checkpoint.sessionRef, accepted.executionRef);
      assert.equal(checkpoint.appliedSeq, 4);
      assert.equal(children.length, 1);
      assert.equal((await executionOwner.checkpoints(identity, activityId)).items[0].checkpointId, checkpoint.checkpointId);
      const wrongCheckpoint = actionOf();
      wrongCheckpoint.execution.resumeFromCheckpoint = { checkpointId: checkpoint.checkpointId,
        sessionRef: checkpoint.sessionRef, sha256: '0'.repeat(64) };
      await assert.rejects(executionOwner.accept(identity, activityId, { action: wrongCheckpoint }),
        error => error.code === 'identity-conflict');
      assert.equal(children.length, 1, 'invalid checkpoint input must not create an executor');
      const baseline = await apply(saved, 'step', { value: 2 });
      assert.deepEqual(baseline.session.observation, { value: 1, total: 5, applied: 3 });
      await executionOwner.stop(identity, activityId, requestId, { stopId: randomUUID(), reason: 'restore boundary' });
      await worker.tick();
      const terminal = await executionOwner.read(identity, activityId, requestId);
      assert.equal(terminal.state, 'cancelled');
      const restoredAction = actionOf();
      restoredAction.execution.resumeFromCheckpoint = { checkpointId: checkpoint.checkpointId,
        sessionRef: checkpoint.sessionRef, sha256: checkpoint.sha256 };
      const availableNodes = channel.nodes;
      t.mock.method(channel, 'nodes', async who => [
        { ...node, connectionId: randomUUID(), runtime: { ...node.runtime, arch: 'incompatible-architecture' } },
        ...await availableNodes(who),
      ]);
      const begun = await executionOwner.accept(identity, activityId, { action: restoredAction });
      assert.equal(begun.session.nodeId, node.nodeId, 'restore must select a compatible available device');
      channel.nodes.mock.restore();
      await worker.tick();
      const restored = await executionOwner.read(identity, activityId, restoredAction.requestId);
      assert.equal(restored.state, 'paused');
      assert.deepEqual(restored.session.observation, { value: 3, total: 3, applied: 2 });
      assert.notEqual(restored.executionRef, saved.executionRef);
      assert.notEqual(restored.session.executorInstanceId, saved.session.executorInstanceId);
      assert.equal(restored.session.restoredFrom.checkpointId, checkpoint.checkpointId);
      const next = await apply(restored, 'step', { value: 2 });
      assert.deepEqual(next.session.observation, baseline.session.observation);
      assert.equal(children.length, 2);
      assert.notEqual(children[0].pid, children[1].pid);
      assert.equal((await executionOwner.read(identity, activityId, requestId)).state, terminal.state);
      await executionOwner.stop(identity, activityId, restoredAction.requestId, { stopId: randomUUID(), reason: '' });
      await worker.tick();
      await validateChannelExecutions(data);
      const resourceRead = t.mock.method(data, 'readResource', async () => { throw new StorageError('corrupt'); });
      assert.equal((await executionOwner.read(identity, activityId, requestId)).state, 'cancelled',
        'a damaged historical checkpoint must not block ordinary execution facts');
      assert.equal((await executionOwner.stop(identity, activityId, requestId,
        { stopId: randomUUID(), reason: 'historical checkpoint unavailable' })).state, 'cancelled');
      await assert.rejects(executionOwner.accept(identity, activityId, {
        action: { ...restoredAction, requestId: randomUUID() },
      }), { code: 'corrupt' });
      assert.equal(children.length, 2, 'damaged checkpoint bytes must still refuse a new restored executor');
      resourceRead.mock.restore();
      return;
    }
    assert.deepEqual(last.session.observation, { value: 1, total: 5, applied: 3 });
    assert.equal(children.length, 1);
    const stop = { stopId: randomUUID(), reason: '' };
    if (cleanupBoundary === 'ordinary-stop') {
      const child = children[0], originalStop = child.stop;
      let unconfirmed = true;
      t.mock.method(child, 'stop', async function (...args) {
        if (unconfirmed) { unconfirmed = false; return false; }
        return originalStop.apply(this, args);
      });
      await executionOwner.stop(identity, activityId, requestId, stop);
      await worker.tick();
      const report = (await channel.query(identity, stop.stopId)).result;
      assert.equal(executionQuerySchema.safeParse(report).success, true, 'an unconfirmed stop must report the original execution, not an unstructured dispatch failure');
      assert.equal(report.statusKnowledge, 'unknown');
      assert.equal(report.stopRequested, true);
      assert.equal(report.reason.code, 'resource-unavailable');
      assert.deepEqual(fixed(report), fixed(accepted));
      assert.equal(child.exitFact, null);
      await worker.stop();
      assert.equal(child.exitFact?.confirmed, true);
      return;
    }
    assert.equal((await executionOwner.stop(identity, activityId, requestId, stop)).stopRequested, true);
    await worker.tick();
    const cancelled = await executionOwner.read(identity, activityId, requestId);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.statusKnowledge, 'confirmed');
    assert.equal(cancelled.stopRequested, true);
    assert.equal(cancelled.confirmedSeq, 6);
    assert.deepEqual(fixed(cancelled), fixed(accepted));
    assert.equal(children[0].exitFact.confirmed, true);
    assert.deepEqual(await executionOwner.stop(identity, activityId, requestId, stop), cancelled);
    await validateChannelExecutions(data);

    if (cleanupBoundary === 'maintenance-pause') {
      await worker.stop();
      const resources = { nodePath: process.execPath, ...(native.windowsHelper ? {
        windowsSessionHelper: native.windowsHelper,
        windowsSessionHelperSha256: createHash('sha256').update(await readFile(native.windowsHelper)).digest('hex'),
      } : {}) };
      clients = await createNativeChannelClients({ root: join(fixture.root, 'managed-device'),
        environment: { installationId }, resources, client: {
          async list() { return [{ key: `school:${connectionId}` }]; },
          nativeChannelCall(id, operation, input) {
            assert.equal(id, connectionId);
            return operation === 'cleanup' ? channel.cleanup(input) : channel[operation](grant.token, input);
          },
        } });
      const waitFor = async (read, matches) => {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const value = await read();
          if (matches(value)) return value;
          await delay(25);
        }
        assert.fail('获准本机执行实例未在限定时间内就绪。');
      };
      await clients.resume();
      await waitFor(() => channel.nodes(identity), nodes => nodes.some(item => item.supervisorEpoch !== node.supervisorEpoch));
      const nextAction = actionOf();
      await executionOwner.accept(identity, activityId, { action: nextAction });
      await waitFor(() => executionOwner.read(identity, activityId, nextAction.requestId), query => query?.state === 'running');
      const child = children.at(-1), originalStop = child.stop, count = children.length;
      assert.ok(child.pid > 0);
      assert.equal(child.exitFact, null);
      let unconfirmed = true;
      t.mock.method(child, 'stop', async function (...args) {
        if (unconfirmed) { unconfirmed = false; return false; }
        return originalStop.apply(this, args);
      });
      await assert.rejects(clients.pause(), AggregateError);
      assert.equal(child.exitFact, null, '维护暂停不能在进程仍活着时报告清理成功。');
      await clients.pause();
      assert.equal(child.exitFact?.confirmed, true, '暂停重试必须保留并回收原执行实例。');
      assert.equal(children.length, count, '维护重试不得创建替代进程。');
      return;
    }

    const secondAction = actionOf(), second = await executionOwner.accept(identity, activityId, { action: secondAction });
    await worker.tick();
    assert.equal((await executionOwner.read(identity, activityId, secondAction.requestId)).state, 'running');
    assert.equal(children.length, 2);
    assert.equal(children[1].exitFact, null);
    if (cleanupBoundary === 'worker-stop') {
      const child = children[1], originalStop = child.stop;
      let unconfirmed = true;
      t.mock.method(child, 'stop', async function (...args) {
        if (unconfirmed) { unconfirmed = false; return false; }
        return originalStop.apply(this, args);
      });
      await assert.rejects(worker.stop(), AggregateError);
      assert.equal(child.exitFact, null, '未确认退出时真实进程仍活着，不能把清理报告为成功。');
      await worker.stop();
      assert.equal(child.exitFact?.confirmed, true, '重试必须回收原进程，不能丢失执行实例。');
      assert.equal(children.length, 2, '清理重试不得创建替代进程。');
      return;
    }
    await spaces.setMembership({ requestId: randomUUID(), principalId: identity.principalId, active: false });
    await assert.rejects(executionOwner.accept(identity, activityId, { action: actionOf() }), { code: 'forbidden' });
    await assert.rejects(executionOwner.read(identity, activityId, secondAction.requestId), { code: 'forbidden' });
    await assert.rejects(executionOwner.control(identity, activityId, secondAction.requestId, {
      controlId: randomUUID(), operationId: 'advance', effect: 'input', expectedSeq: 0, parameters: { value: 1 } }), { code: 'forbidden' });
    await assert.rejects(executionOwner.stop(identity, activityId, secondAction.requestId, { stopId: randomUUID(), reason: '已撤销资格。' }), { code: 'forbidden' });
    await assert.rejects(worker.tick(), { code: 'forbidden' });
    assert.equal(children[1].exitFact.confirmed, true, '撤销资格后，本机维护清理仍须确认回收真实进程。');
    await worker.stop();
    const { rows: [ledger] } = await data.read('SELECT execution FROM channel_executions WHERE request_id=$1', [secondAction.requestId]);
    assert.equal(ledger.execution.executionRef, second.executionRef);
    assert.equal(ledger.execution.session.executorInstanceId, second.session.executorInstanceId);
    assert.equal(ledger.execution.state, 'running', '学校不能把未收到的本机清理结果伪造为已停止。');
    await validateChannelExecutions(data);
  } finally {
    await clients?.close();
    await worker?.stop();
    for (const child of children) await child.dispose();
    for (const storage of opened.reverse()) await storage.close();
    await fixture.close();
  }
}

// 保留协议事实夹具，单独检查不可信报告与资格撤销；这些报告不作为真实进程执行证据。
test('school facade dispatches a local ready device without a remote plan and preserves nonempty controls', { timeout: 120000 }, async () => {
  const fixture = await nativeFixture(), opened = [];
  try {
    async function owner(migrations) {
      const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
      const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomBytes(32).toString('base64url'), migrations });
      const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: owner.serviceId, root: join(fixture.root, owner.serviceId) }) });
      opened.push(storage);
      return storage;
    }
    const school = await owner(spaceMigrations), data = await owner(learningMigrations), spaces = createSpaces(school);
    const identity = await spaces.createMember({ requestId: randomUUID(), loginName: 'facade-student', password: 'synthetic-facade-password' });
    const login = await spaces.login('facade-student', 'synthetic-facade-password');
    const connectionId = randomUUID(), verifier = randomBytes(48).toString('base64url');
    await spaces.beginConnection({ requestId: connectionId, clientId: randomUUID(), challenge: createHash('sha256').update(verifier).digest('base64url') });
    await spaces.approveConnection(login.token, connectionId);
    const grant = await spaces.exchangeConnection(connectionId, verifier);
    const node = { connectionId, nodeId: 'approved-local-mac', installationId: randomUUID(), platform: 'macos-arm64',
      supervisorEpoch: randomUUID(), adapters: [{ adapterId: 'four-state-accumulator', adapterVersion: 1 }] };
    const activityId = randomUUID();
    let eligible = true;
    const authorize = async (who, id) => {
      await spaces.authorize(who);
      if (!eligible || id !== activityId || who.principalId !== identity.principalId) throw new StorageError('forbidden');
    };
    const channel = createNativeChannel(data, { authenticate: spaces.authenticateConnection,
      authorizeConnection: spaces.authorizeConnection, authorize });
    await channel.register(grant.token, node);
    await channel.heartbeat(grant.token, node);
    const { manifest } = await accumulatorPackage({ version: 1 }), declared = manifest.session, definitionDigest = 'a'.repeat(64);
    const plan = { planId: 'local-accumulator', planVersion: 1, planDigest: '0'.repeat(64),
      components: [{ key: 'accumulator', definitionDigest, configurationDigest: canonicalDigest({}), operations: ['advance'] }],
      capabilities: ['native-session'], resources: { browser: null, native: { memoryMiB: declared.budgets.memoryMiB,
        operationTimeoutMs: declared.budgets.operationTimeoutMs, maxMs: declared.budgets.maxMs } }, locations: ['native'], remote: null };
    plan.planDigest = canonicalDigest(courseExecutionPlanBasis(plan));
    const activity = { activityId, identity, course: { executionPlan: plan, components: [{ key: 'accumulator',
      definition: { digest: definitionDigest, manifest }, configuration: {}, materialIds: [] }] } };
    await data.request({ requestId: 'facade-activity', fingerprint: activityId }, async tx => {
      await tx.query('INSERT INTO activities(id,space_environment_id,space_id,principal_id,body) VALUES($1,$2,$3,$4,$5)',
        [activityId, identity.environmentId, identity.spaceId, identity.principalId, JSON.stringify(activity)]);
      return null;
    });
    const executionOwner = createExecutions(data, { channel, works: createWorks(data, authorize), activity: async (who, id) => {
      await authorize(who, id); return activity;
    } });
    const action = executionActionSchema.parse({ protocolVersion: 2, kind: 'execution', requestId: randomUUID(),
      scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId },
      receiver: { receiverId: 'approved-local', location: 'local', kind: 'execution' },
      execution: { instance: { instanceId: `${activityId}:accumulator`, key: 'accumulator', componentId: manifest.componentId,
        componentVersion: manifest.version, definitionDigest, hostApiVersion: 1, stateVersion: 1 },
        operation: { operationId: 'advance', effect: 'input' }, parameters: {},
        basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] },
        limits: { timeMs: declared.budgets.operationTimeoutMs, memoryPages: 1, inputBytes: declared.budgets.inputBytes,
          outputBytes: declared.budgets.outputBytes, concurrentJobs: declared.budgets.concurrentSessions, queuedJobs: declared.budgets.queuedSessions },
        plan: { planId: 'native-session', planVersion: 1, location: 'native', kind: 'session', planDigest: canonicalDigest({
          planId: 'native-session', planVersion: 1, componentId: manifest.componentId, componentVersion: manifest.version, operationId: 'advance' }) },
        session: { adapterId: declared.adapterId, adapterVersion: declared.adapterVersion,
          limits: Object.fromEntries(['operationTimeoutMs', 'idleMs', 'maxMs', 'memoryMiB', 'concurrentSessions', 'queuedSessions']
            .map(key => [key, declared.budgets[key]])) },
        device: { platform: 'macos-arm64', browser: { worker: true, webassembly: true, sandboxedFrame: true },
          native: { supported: true, installed: true, authorized: true, prepared: 'ready' } },
        initiator: { kind: 'student', principalId: identity.principalId } } });
    const accepted = await executionOwner.accept(identity, activityId, { action });
    assert.equal(accepted.state, 'queued');
    assert.equal(accepted.inputDigest, digest(action));
    assert.equal(accepted.session.nodeId, node.nodeId);
    assert.equal(accepted.session.supervisorEpoch, node.supervisorEpoch);
    assert.deepEqual(await executionOwner.accept(identity, activityId, { action }), accepted);
    const queuedControl = { controlId: randomUUID(), operationId: 'advance', effect: 'input', expectedSeq: 0, parameters: { value: 1 } };
    await assert.rejects(executionOwner.control(identity, activityId, action.requestId, queuedControl), { code: 'invalid' });
    const claimed = (await channel.claim(grant.token, node)).command;
    assert.deepEqual(claimed.payload, { action, activity, execution: accepted });
    assert.equal((await channel.claim(grant.token, node)).command, null);
    const running = { ...accepted, state: 'running', confirmedSeq: 2,
      session: { ...accepted.session, observation: { value: 0, total: 0, applied: 0 } } };
    await assert.rejects(channel.report(grant.token, { node: { ...node, nodeId: 'unapproved-node' },
      commandId: claimed.commandId, claimId: claimed.claimId, result: running }), { code: 'forbidden' });
    await channel.report(grant.token, { node, commandId: claimed.commandId, claimId: claimed.claimId, result: running });
    assert.deepEqual(await executionOwner.read(identity, activityId, action.requestId), running);
    const control = { controlId: randomUUID(), operationId: 'advance', effect: 'input', expectedSeq: 0, parameters: { value: 1 } };
    await executionOwner.control(identity, activityId, action.requestId, control);
    const inputClaim = (await channel.claim(grant.token, node)).command;
    assert.deepEqual(inputClaim.payload, { requestId: action.requestId, executionRef: accepted.executionRef, control });
    const progressed = { ...running, confirmedSeq: 3, session: { ...running.session, appliedSeq: 1,
      lastControlId: control.controlId, observation: { value: 1, total: 1, applied: 1 } } };
    await channel.report(grant.token, { node, commandId: inputClaim.commandId, claimId: inputClaim.claimId, result: progressed });
    assert.deepEqual(await executionOwner.read(identity, activityId, action.requestId), progressed);
    await data.request({ requestId: 'expire-facade-node-lease', fingerprint: connectionId }, async tx => {
      await tx.query("UPDATE native_channel_nodes SET lease_until=clock_timestamp()-interval '1 second' WHERE connection_id=$1", [connectionId]);
      return null;
    });
    const expiredControlId = randomUUID();
    await assert.rejects(executionOwner.control(identity, activityId, action.requestId, {
      ...control, controlId: expiredControlId, expectedSeq: 1, parameters: { value: 2 } }), { code: 'invalid' });
    const { rows: expiredIntents } = await data.read('SELECT command_id FROM channel_execution_intents WHERE command_id=$1', [expiredControlId]);
    assert.equal(expiredIntents.length, 0, '新控制必须先刷新租约，未知状态不能写入新命令。');
    const repeatedUnknown = await executionOwner.control(identity, activityId, action.requestId, control);
    assert.equal(repeatedUnknown.statusKnowledge, 'unknown');
    assert.equal(repeatedUnknown.session.appliedSeq, 1);
    const stop = { stopId: randomUUID(), reason: '学生停止。' };
    assert.equal((await executionOwner.stop(identity, activityId, action.requestId, stop)).stopRequested, true);
    const stopClaim = (await channel.claim(grant.token, node)).command;
    assert.deepEqual(stopClaim.payload, { requestId: action.requestId, executionRef: accepted.executionRef, stop });
    const cancelled = { ...progressed, state: 'cancelled', stopRequested: true, confirmedSeq: 4,
      reason: { code: 'worker-terminated', detail: stop.reason } };
    await channel.report(grant.token, { node, commandId: stopClaim.commandId, claimId: stopClaim.claimId, result: cancelled });
    assert.deepEqual(await executionOwner.read(identity, activityId, action.requestId), cancelled);
    assert.deepEqual(await executionOwner.stop(identity, activityId, action.requestId, stop), cancelled);
    await validateChannelExecutions(data);
    const waitingAction = { ...action, requestId: randomUUID() };
    const waiting = await executionOwner.accept(identity, activityId, { action: waitingAction });
    const waitingClaim = (await channel.claim(grant.token, node)).command;
    await channel.report(grant.token, { node, commandId: waitingClaim.commandId, claimId: waitingClaim.claimId,
      result: { statusKnowledge: 'unknown', reason: '执行后结果尚未确认。' } });
    const unknownControlId = randomUUID();
    await assert.rejects(executionOwner.control(identity, activityId, waitingAction.requestId, {
      ...control, controlId: unknownControlId }), { code: 'invalid' });
    const { rows: unknownIntents } = await data.read('SELECT command_id FROM channel_execution_intents WHERE command_id=$1', [unknownControlId]);
    assert.equal(unknownIntents.length, 0, '已报告未知的前序动作不能解除新控制的状态门禁。');
    const unknownStop = await executionOwner.stop(identity, activityId, waitingAction.requestId, { stopId: randomUUID(), reason: '未知状态仍须回收。' });
    assert.equal(unknownStop.stopRequested, true);
    assert.equal(unknownStop.statusKnowledge, 'unknown');
    eligible = false;
    await assert.rejects(executionOwner.accept(identity, activityId, { action: { ...action, requestId: randomUUID() } }), { code: 'forbidden' });
    await assert.rejects(channel.claim(grant.token, node), { code: 'forbidden' });
    await assert.rejects(channel.report(grant.token, { node, commandId: waitingClaim.commandId,
      claimId: waitingClaim.claimId, result: waiting }), { code: 'forbidden' });
    await assert.rejects(executionOwner.control(identity, activityId, action.requestId, { ...control, controlId: randomUUID() }), { code: 'forbidden' });
    await assert.rejects(executionOwner.stop(identity, activityId, action.requestId, { ...stop, stopId: randomUUID() }), { code: 'forbidden' });
  } finally {
    for (const storage of opened.reverse()) await storage.close();
    await fixture.close();
  }
});
