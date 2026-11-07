import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { createNativeChannel, createSpaces, learningMigrations, spaceMigrations, SupervisedSession, validateNativeChannel } from '@xunjie/learning-space';
import { createNativeChannelWorker, nativeChannelNode } from '@xunjie/product-runtime';
import { canonicalValue, courseExecutionPlanBasis, executionActionSchema } from '@xunjie/contracts/execution';
import { activitySchema } from '@xunjie/contracts/learning-data';
import { createExecutions } from '../../../packages/learning-space/dist/learning-data/executions.js';
import { createWorks } from '../../../packages/learning-space/dist/learning-data/works.js';
import { accumulatorPackage } from '../../../components/state-accumulator/package.mjs';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';

test('stopping an unclaimed native submit cancels it durably without dispatching a process', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  let storage;
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations: learningMigrations });
    const backend = createFileBackend({ id: 'cancelled-channel', root: join(fixture.root, 'resources') });
    storage = await openStorage({ binding, migrations: learningMigrations, backend });
    const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '学校' };
    const options = { async authenticate() { return identity; }, async authorize() {}, async authorizeConnection() {} };
    let channel = createNativeChannel(storage, options);
    const node = { connectionId: randomUUID(), nodeId: 'cancel-before-claim', installationId: randomUUID(), platform: 'macos-arm64',
      supervisorEpoch: randomUUID(), adapters: [{ adapterId: 'four-state-accumulator', adapterVersion: 1 }] };
    await channel.register('approved', node);
    const activityId = randomUUID(), requestId = randomUUID(), sessionId = randomUUID();
    const execution = { requestId, inputDigest: 'a'.repeat(64), executionRef: sessionId,
      scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId },
      state: 'queued', statusKnowledge: 'confirmed', stopRequested: false, confirmedSeq: 1, reason: null, output: null,
      session: { adapterId: 'four-state-accumulator', adapterVersion: 1, instanceId: `${activityId}:accumulator`, instanceKey: 'accumulator',
        nodeId: node.nodeId, installGeneration: node.installationId, supervisorEpoch: node.supervisorEpoch,
        executorInstanceId: randomUUID(), appliedSeq: 0, lastControlId: null, observation: null, observations: [] } };
    const submit = { commandId: requestId, activityId, sessionId, operation: 'submit', payload: { execution } };
    const stopId = randomUUID();
    const stop = { commandId: stopId, activityId, sessionId, operation: 'stop',
      payload: { requestId, executionRef: sessionId, stop: { stopId, reason: '' } } };
    await channel.enqueue(identity, node.connectionId, submit);
    await channel.enqueue(identity, node.connectionId, stop);
    assert.equal((await channel.claim('approved', node)).command, null, 'a queued cancellation must never start the original process');
    const cancelled = await channel.query(identity, requestId);
    assert.equal(cancelled.result.state, 'cancelled');
    assert.equal(cancelled.result.statusKnowledge, 'confirmed');
    assert.equal(cancelled.result.stopRequested, true);
    assert.equal(cancelled.result.confirmedSeq, 2);
    assert.equal(cancelled.result.executionRef, sessionId);
    assert.equal(cancelled.result.session.executorInstanceId, execution.session.executorInstanceId);
    assert.deepEqual((await channel.query(identity, stopId)).result, cancelled.result);
    await channel.enqueue(identity, node.connectionId, submit);
    await channel.enqueue(identity, node.connectionId, stop);
    await storage.close();
    storage = await openStorage({ binding, migrations: learningMigrations, backend });
    channel = createNativeChannel(storage, options);
    assert.equal((await channel.claim('approved', node)).command, null);
    assert.deepEqual(await channel.query(identity, requestId), cancelled);
    // Once a claim could have dispatched, a stop must reach that original worker instead
    // of inventing a confirmed cancellation in the school ledger.
    const claimedRequest = randomUUID(), claimedSession = randomUUID(), claimedStopId = randomUUID();
    await channel.enqueue(identity, node.connectionId, { ...submit, commandId: claimedRequest, sessionId: claimedSession,
      payload: { execution: { ...execution, requestId: claimedRequest, executionRef: claimedSession } } });
    assert.equal((await channel.claim('approved', node)).command.commandId, claimedRequest);
    await channel.enqueue(identity, node.connectionId, { ...stop, commandId: claimedStopId, sessionId: claimedSession,
      payload: { requestId: claimedRequest, executionRef: claimedSession, stop: { stopId: claimedStopId, reason: '' } } });
    assert.equal((await channel.query(identity, claimedRequest)).statusKnowledge, 'unknown');
    assert.equal((await channel.claim('approved', node)).command.commandId, claimedStopId);
    await validateNativeChannel(storage);
  } finally { await storage?.close(); await fixture.close(); }
});

test('cancelling an unclaimed Agent input preserves an independent student process on the same node and delivers the original stop',
  { timeout: 120000 }, async t => {
    const fixture = await nativeFixture(), opened = [], children = [];
    let worker;
    try {
      async function owner(migrations) {
        const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
        const binding = await provisionStorage({ admin: fixture.admin, owner,
          password: randomBytes(32).toString('base64url'), migrations });
        const storage = await openStorage({ binding, migrations,
          backend: createFileBackend({ id: owner.serviceId, root: join(fixture.root, owner.serviceId) }) });
        opened.push(storage);
        return storage;
      }
      const school = await owner(spaceMigrations), data = await owner(learningMigrations), spaces = createSpaces(school);
      const identity = await spaces.createMember({ requestId: randomUUID(), loginName: 'cancel-input-student',
        password: 'synthetic-cancel-input-password' });
      const login = await spaces.login('cancel-input-student', 'synthetic-cancel-input-password');
      const connectionId = randomUUID(), verifier = randomBytes(48).toString('base64url');
      await spaces.beginConnection({ requestId: connectionId, clientId: randomUUID(),
        challenge: createHash('sha256').update(verifier).digest('base64url') });
      await spaces.approveConnection(login.token, connectionId);
      const grant = await spaces.exchangeConnection(connectionId, verifier);
      const native = { nodePath: process.execPath, sessionRoot: join(fixture.root, 'sessions'),
        ...(process.env.XUNJIE_NATIVE_SESSION_HELPER ? { windowsHelper: process.env.XUNJIE_NATIVE_SESSION_HELPER } : {}) };
      const node = await nativeChannelNode({ ...native, connectionId, installationId: randomUUID(), supervisorEpoch: randomUUID() });
      assert.ok(node.adapters.some(adapter => adapter.adapterId === 'four-state-accumulator'));
      const originalCreate = SupervisedSession.create;
      t.mock.method(SupervisedSession, 'create', async function (...args) {
        const child = await originalCreate.apply(this, args);
        children.push(child);
        return child;
      });
      const activityId = randomUUID(), runId = randomUUID(), contexts = new Map();
      const authorize = async (who, id) => {
        await spaces.authorize(who);
        if (id !== activityId || who.principalId !== identity.principalId) throw new StorageError('forbidden');
      };
      const contextFor = commandId => {
        if (!contexts.has(commandId)) contexts.set(commandId, { runId, commandId, stepId: randomUUID(),
          snapshotId: randomUUID(), assertDispatch: () => authorize(identity, activityId) });
        return contexts.get(commandId);
      };
      const channel = createNativeChannel(data, { authenticate: spaces.authenticateConnection,
        authorizeConnection: spaces.authorizeConnection, authorize,
        assertAgentDispatch: async (who, id, association) => {
          await authorize(who, id);
          const original = contexts.get(association.commandId);
          if (!original || original.runId !== association.runId || original.stepId !== association.stepId
            || original.snapshotId !== association.snapshotId) throw new StorageError('forbidden');
          await original.assertDispatch();
        } });
      worker = createNativeChannelWorker({ root: join(fixture.root, 'device'), node, native,
        call: (operation, input) => operation === 'cleanup' ? channel.cleanup(input) : channel[operation](grant.token, input) });
      const canonicalDigest = value => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
      const { manifest } = await accumulatorPackage({ version: 1 }), declared = manifest.session;
      const definitionDigest = 'a'.repeat(64), configuration = { title: '取消隔离验证' };
      const plan = { planId: 'local-accumulator', planVersion: 1, planDigest: '0'.repeat(64),
        components: [{ key: 'accumulator', definitionDigest, configurationDigest: canonicalDigest(configuration), operations: ['advance'] }],
        capabilities: ['native-session'], resources: { browser: null, native: { memoryMiB: declared.budgets.memoryMiB,
          operationTimeoutMs: declared.budgets.operationTimeoutMs, maxMs: declared.budgets.maxMs } }, locations: ['native'], remote: null };
      plan.planDigest = canonicalDigest(courseExecutionPlanBasis(plan));
      const activity = activitySchema.parse({ activityId, identity, target: { ...data.owner, version: 1 },
        goal: '取消 Agent 输入不能停止独立学生会话', question: '', references: [], status: 'open', createdAt: new Date().toISOString(),
        course: { associationId: randomUUID(), courseId: randomUUID(), courseName: '本机执行课程', taskId: randomUUID(), taskTitle: '四态累加',
          releaseId: randomUUID(), contentDigest: 'b'.repeat(64), objectives: ['独立会话隔离'], requirements: '取消 Agent 输入后学生仍可累加。',
          helpPolicy: { version: 1, questions: 'allowed', scope: 'course' }, materials: [], starterWorks: [], capabilities: [],
          executionPlan: plan, components: [{ key: 'accumulator', definition: { digest: definitionDigest, manifest },
            configuration, materialIds: [] }] } });
      await data.request({ requestId: 'cancel-input-activity', fingerprint: activityId }, async tx => {
        await tx.query('INSERT INTO activities(id,space_environment_id,space_id,principal_id,body) VALUES($1,$2,$3,$4,$5)',
          [activityId, identity.environmentId, identity.spaceId, identity.principalId, JSON.stringify(activity)]);
        return null;
      });
      const executions = createExecutions(data, { channel, works: createWorks(data, authorize),
        activity: async (who, id) => { await authorize(who, id); return activity; } });
      const actionOf = kind => executionActionSchema.parse({ protocolVersion: 2, kind: 'execution', requestId: randomUUID(),
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
              .map(key => [key, declared.budgets[key]])) }, initiator: { kind, principalId: identity.principalId } } });
      await worker.tick();
      const student = actionOf('student'), agent = actionOf('agent');
      const acceptedStudent = await executions.accept(identity, activityId, { action: student });
      await worker.tick();
      const acceptedAgent = await executions.agent.dispatch(identity, activityId, contextFor(agent.requestId), agent);
      await worker.tick();
      const studentBefore = await executions.read(identity, activityId, student.requestId);
      const agentBefore = await executions.read(identity, activityId, agent.requestId);
      assert.equal(studentBefore.state, 'running');
      assert.equal(agentBefore.state, 'running');
      assert.equal(studentBefore.session.nodeId, agentBefore.session.nodeId);
      assert.notEqual(studentBefore.executionRef, agentBefore.executionRef);
      assert.equal(children.length, 2);
      assert.ok(children.every(child => child.pid > 0));
      assert.notEqual(children[0].pid, children[1].pid);
      const input = { controlId: randomUUID(), operationId: 'advance', effect: 'input', expectedSeq: 0, parameters: { value: 2 } };
      await executions.agent.control(identity, activityId, contextFor(input.controlId), agent.requestId, input);
      assert.equal((await channel.query(identity, input.controlId)).state, 'pending');
      const stop = { stopId: randomUUID(), reason: 'original Agent Run stopped before input claim' };
      await executions.agent.stop(identity, activityId, contextFor(agent.requestId), agent.requestId, stop);
      assert.equal((await channel.query(identity, stop.stopId)).state, 'pending');
      await assert.doesNotReject(() => worker.tick(), 'one cancelled Agent input must not signal connection revocation');
      const cancelled = await channel.query(identity, input.controlId);
      assert.equal(cancelled.state, 'cancelled');
      assert.equal(cancelled.statusKnowledge, 'confirmed');
      assert.deepEqual(cancelled.result, { statusKnowledge: 'confirmed', reason: 'agent-command-cancelled-before-dispatch' });
      const receipt = await executions.controlReceipt(identity, activityId, agent.requestId, input.controlId);
      assert.equal(receipt.status, 'rejected', 'an input cancelled before claim has a final rejection, not a pending or applied receipt');
      assert.equal(receipt.query.session.appliedSeq, 0);
      assert.equal(receipt.query.session.lastControlId, null);
      assert.equal((await executions.read(identity, activityId, agent.requestId)).state, 'running',
        'refusing an input cannot invent process termination');
      assert.equal((await channel.query(identity, stop.stopId)).state, 'pending');
      await worker.tick();
      const stoppedAgent = await executions.read(identity, activityId, agent.requestId);
      assert.equal((await channel.query(identity, stop.stopId)).state, 'reported');
      assert.equal(stoppedAgent.state, 'cancelled');
      assert.equal(stoppedAgent.statusKnowledge, 'confirmed');
      assert.equal(stoppedAgent.session.appliedSeq, 0);
      assert.equal(stoppedAgent.session.lastControlId, null);
      assert.deepEqual(stoppedAgent.session.observation, { value: 0, total: 0, applied: 0 });
      const studentInput = { controlId: randomUUID(), operationId: 'advance', effect: 'input', expectedSeq: 0, parameters: { value: 3 } };
      await executions.control(identity, activityId, student.requestId, studentInput);
      await worker.tick();
      const studentAfter = await executions.read(identity, activityId, student.requestId);
      assert.equal(studentAfter.state, 'running');
      assert.equal(studentAfter.statusKnowledge, 'confirmed');
      assert.equal(studentAfter.session.appliedSeq, 1);
      assert.equal(studentAfter.session.lastControlId, studentInput.controlId);
      assert.deepEqual(studentAfter.session.observation, { value: 3, total: 3, applied: 1 });
      for (const [before, after] of [[acceptedStudent, studentAfter], [acceptedAgent, stoppedAgent]]) {
        assert.equal(after.executionRef, before.executionRef);
        for (const key of ['nodeId', 'installGeneration', 'supervisorEpoch', 'executorInstanceId'])
          assert.equal(after.session[key], before.session[key]);
      }
      assert.equal(children.length, 2, 'neither cancellation nor the next student input may replay or replace a process');
      await validateNativeChannel(data);
    } finally {
      await worker?.stop();
      await Promise.all(children.map(child => child.stop()));
      for (const storage of opened.reverse()) await storage.close();
      await fixture.close();
    }
  });
