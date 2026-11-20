import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { agentRuntimeMigrations } from '@xunjie/agent-runtime';
import { createAgentSessions, agentSessionMigration } from '@xunjie/learning-space/learning-data/agent-sessions';
import { createLearningData, learningMigrations } from '@xunjie/learning-space';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createSessionRuntimeHost } from '../dist/session-runtime.js';
import { createProductAgent } from '../dist/product-agent.js';

const connection = { routeId: randomUUID(), version: 1, maxOutputTokens: 4096, contextWindow: 1_000_000,
  protocol: 'openai-chat', parameterMode: 'plain', capabilities: {}, hasCredential: true, adapterState: 'ready' };

/** A scripted Gateway: dispatch returns a fixed response after the optional streaming hook. */
function mockGateway(onDispatch) {
  const segments = new Map(), attempts = new Map();
  const segment = (segmentId, sequence) => ({ sessionId: undefined, segmentId, formatVersion: 1, sequence,
    connection, prefixDigest: '0'.repeat(64), resultRef: null, pending: false, closed: false, pendingTools: [] });
  return {
    selection: {
      read: async () => ({ selected: true, version: 1 }),
      snapshot: async () => ({ choice: { connection }, source: { kind: 'personal', ownerScope: 's', feeSource: 'f' } }),
      pin: async () => ({ choice: { connection }, source: { kind: 'personal', ownerScope: 's', feeSource: 'f' } }),
      pinSource: async () => ({}), pinned: async () => ({}), resolveChoice: async () => ({}),
    },
    segments: {
      create: async (_identity, input) => { const value = segment(input.segmentId, 0); segments.set(input.segmentId, value); return value; },
      read: async (_identity, segmentId) => segments.get(segmentId),
      settle: async (_identity, segmentId, input) => { const value = segments.get(segmentId); value.sequence = input.expectedSequence + 1; value.pendingTools = []; return value; },
      close: async (_identity, segmentId) => { const value = segments.get(segmentId); value.closed = true;
        return { ...value, boundary: { owner: { environmentId: 'e', serviceId: 's' }, segmentId, sequence: value.sequence, routeId: connection.routeId, resultRef: null } }; },
    },
    checks: {
      receive: async (_identity, input) => { const attempt = { attemptId: input.attemptId, state: 'accepted', physicalRequestEnded: false,
        dispatched: false, cancelRequested: false, text: '', usage: { state: 'unknown' }, requestRef: randomUUID(), resultRef: null,
        reason: '', upstreamStopped: 'unknown', createdAt: new Date().toISOString(), purpose: 'learning', connection, limits: input.limits };
        attempts.set(input.attemptId, attempt); return attempt; },
      dispatch: async (identity, attemptId) => { const attempt = attempts.get(attemptId);
        await onDispatch?.(identity, attemptId);
        Object.assign(attempt, { state: 'completed', physicalRequestEnded: true, dispatched: true, text: '回答', toolIntents: [],
          usage: { state: 'final', inputTokens: 10, outputTokens: 5 }, resultRef: randomUUID(),
          segment: { segmentId: [...segments.keys()][0], sequence: 0 } });
        return attempt; },
      read: async (_identity, attemptId) => attempts.get(attemptId),
      readRecorded: async (_identity, attemptId) => attempts.get(attemptId),
      progress: async () => null, summary: async () => null, requestPayload: async () => ({}),
      cancel: async (_identity, attemptId) => attempts.get(attemptId),
    },
    results: { retain: async () => null },
    images: { upload: async () => ({}), read: async () => ({}) },
  };
}

test('attempt inspection limits a mixed personal session to the approved course Turn and reauthorizes its sources', async t => {
  const pg = await nativeFixture();
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations: agentRuntimeMigrations });
  const storage = await openStorage({ binding, migrations: agentRuntimeMigrations,
    backend: createFileBackend({ id: 'inspection', root: join(pg.root, 'inspection') }) });
  const student = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(),
    kind: 'personal', name: '学生' };
  const inspector = { ...student, principalId: randomUUID(), kind: 'school', name: '学校排查者' };
  const session = { sessionId: randomUUID(), identity: student, scenario: 'student-assistant', state: 'ready',
    owner: { target: owner }, createdAt: new Date().toISOString() };
  const courseActivityId = randomUUID(), forgedActivityId = randomUUID();
  let revoked = false, dispatches = 0, recordedReads = 0, inspections = 0;
  const gateway = mockGateway(() => { dispatches++; });
  const recorded = gateway.checks.readRecorded;
  gateway.checks.readRecorded = async (...args) => { recordedReads++; return recorded(...args); };
  const host = createProductAgent({ storage, models: gateway, authorize: async () => {},
    async authorizeInspection(actor, target) {
      // The host hook receives the full target metadata, not only an id. The exact Turn/Attempt
      // must carry the course activity; a different Turn in the same Session cannot reuse it.
      if (actor.kind !== 'school' || actor.principalId !== inspector.principalId
        || target.session.identity.principalId !== student.principalId
        || !target.session.sessionId || !target.attempt?.attemptId || !target.attempt.stepId
        || !target.attempt.turnId || !target.activityIds.includes(courseActivityId))
        throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
      inspections++;
    },
    inspectSession: async id => id === session.sessionId ? session : Promise.reject(Object.assign(new Error('missing'), { code: 'missing' })),
    directory: { read: async (actor, id) => {
      if (id !== session.sessionId || actor.principalId !== student.principalId || actor.kind !== 'personal')
        throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
      return session;
    }, readForInspection: async () => session },
    scene: async () => ({
      student: { localPersonalIdentity: student, localLearningTarget: { ...owner, version: 1 },
        historySource: async () => !revoked },
      tools: async () => [],
      experimentMaterials: async input => {
        const references = (input.inputs ?? []).flatMap(entry =>
          Array.isArray(entry.context.experimentReferences) ? entry.context.experimentReferences : []);
        if (!references.length) return [];
        const accepted = references.some(reference => reference && typeof reference === 'object'
          && reference.activityId === courseActivityId);
        return [{ materialId: 'M-inspection', sourceId: 'fixed-evidence',
          kind: 'system-observation', author: 'system', label: '固定结果', version: 'v1', range: null,
          digest: accepted ? 'evidence-digest' : 'failed-digest',
          content: accepted ? 'fixed proof' : null, readState: accepted ? 'included' : 'failed',
          readReason: accepted ? undefined : '原实验当前不可访问或无法核实。', citationAllowed: accepted,
          source: { kind: 'experiment-reference', activityId: accepted ? courseActivityId : forgedActivityId,
            executionRef: randomUUID() } }];
      },
    }),
  });
  t.after(async () => { await host.close(); await storage.close(); await pg.close(); });
  await host.local.initialize({ sessionId: session.sessionId, identity: student, scenario: session.scenario, createdAt: session.createdAt });
  const privateReceipt = await host.local.submit(student, { sessionId: session.sessionId, requestId: randomUUID(),
    text: '与课程无关的私人问题', context: { experimentReferences: [{ activityId: forgedActivityId }] } });
  await host.drain();
  await assert.rejects(host.inspect(inspector, session.sessionId, { turnId: privateReceipt.turnId }), { code: 'forbidden' });
  const receipt = await host.local.submit(student, { sessionId: session.sessionId, requestId: randomUUID(),
    text: '核对实验', context: { experimentReferences: [{ activityId: courseActivityId }] } });
  await host.drain();
  const view = await host.inspect(inspector, session.sessionId, { turnId: receipt.turnId });
  assert.equal(view.turnId, receipt.turnId);
  assert.equal(view.assembly.materials[0].sourceId, 'fixed-evidence');
  assert.equal(view.result, null);
  assert.equal(view.request, null);
  assert.equal(view.redaction.request, 'mixed-session-history');
  assert.equal(JSON.stringify(view).includes('与课程无关的私人问题'), false);
  assert.equal(view.capacity.dispatchable, true);
  assert.equal(view.attemptId, view.attempt.attemptId);
  assert.ok(Array.isArray(view.tools));
  assert.ok(Array.isArray(view.citations));
  // A normal student, a non-managing school member and any other subject are forbidden; the
  // injected hook above intentionally encodes only this allowed inspector.
  await assert.rejects(host.inspect(student, session.sessionId, { attemptId: view.attemptId }), { code: 'forbidden' });
  await assert.rejects(host.inspect({ ...inspector, principalId: randomUUID() }, session.sessionId, { attemptId: view.attemptId }),
    { code: 'forbidden' });
  revoked = true;
  await assert.rejects(host.inspect(inspector, session.sessionId, { attemptId: view.attemptId }), { code: 'forbidden' });
  // The revoked source passes the host inspection gate but is rejected by history reauthorization.
  assert.equal(inspections, 2);
  assert.equal(dispatches, 2);
  assert.equal(recordedReads, 0);
});

test('the product host selects the saved scene and wakes the direct runner without creating a home workspace', async t => {
  const pg = await nativeFixture(), storages = [];
  let host, releaseModel, activeSessionId = '';
  let progress;
  const progressed = new Promise(resolve => { progress = resolve; });
  t.after(async () => { releaseModel?.(); await host?.close(); for (const storage of storages.reverse()) await storage.close(); await pg.close(); });
  const environmentId = randomUUID();
  async function open(name, migrations) {
    const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations });
    const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: name, root: join(pg.root, name) }) });
    storages.push(storage); return storage;
  }
  const data = await open('data', [...learningMigrations.filter(m => m.version < 31), agentSessionMigration]);
  const agent = await open('agent', agentRuntimeMigrations);
  const identity = { environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
  const target = { ...data.owner, version: 1 };
  const learning = createLearningData(data, { resolveBinding: async () => target });
  const owner = { version: 1, connectionId: agent.owner.serviceId, installationId: randomUUID(), target: {
    ...agent.owner, unit: 'teaching-agent', protocolVersion: 1, endpoint: 'http://127.0.0.1:3444', capabilities: ['agent.sessions.v3'] } };
  const directory = createAgentSessions(data, { authorize: async () => {}, openActivity: learning.open, resolveOwner: async () => owner });
  const scenes = [], workspaceRequests = new Map();
  const gateway = mockGateway(async (who, attemptId) => {
    const session = await directory.read(who, activeSessionId);
    if (session.scenario !== 'student-assistant') return;
    await host.runtime.recordProgress(who, activeSessionId, attemptId, { revision: 1, text: '正在形成的回答' });
    progress();
    await new Promise(resolve => { releaseModel = resolve; });
  });
  host = createSessionRuntimeHost({ storage: agent, directory, authorize: async () => {},
    workspaceRequest: async (_identity, activityId) => workspaceRequests.get(activityId),
    gateway,
    scenario: {
      id: 'session-runtime-test', version: 1,
      async context(input) {
        const session = await directory.read(identity, input.sessionId);
        scenes.push({ sessionId: input.sessionId, scenario: session.scenario, workspace: session.workspace });
        return { system: '测试助手', facts: {}, sources: [] };
      },
      async tools() { return []; },
    } });
  const home = await host.sessions.create(identity, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' });
  activeSessionId = home.sessionId;
  const receipt = await host.sessions.submit(identity, { requestId: randomUUID(), sessionId: home.sessionId, text: '什么是递归？' });
  await progressed;
  const streaming = await (await host.agent(identity, home.sessionId)).conversation(identity, home.sessionId);
  assert.deepEqual(streaming.messages.filter(item => item.role === 'assistant').map(item => [item.text, item.state]), [['正在形成的回答', 'streaming']]);
  releaseModel();
  await host.drain();
  const port = await host.agent(identity, home.sessionId);
  assert.equal((await port.turn(identity, home.sessionId, receipt.turnId)).state, 'completed');
  assert.deepEqual(await learning.list(identity), []);
  assert.equal(scenes[0].scenario, 'student-assistant');
  assert.equal(scenes[0].workspace, undefined);
  const activity = await learning.create(identity, { requestId: randomUUID(), goal: '递归练习', question: '', references: [] });
  const preparedWorkspace = { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'workspace-assistant',
    workspace: { activityId: activity.activityId, target }, title: '已创建项目的原定工作区' };
  workspaceRequests.set(activity.activityId, preparedWorkspace);
  const workspace = await host.sessions.workspace(identity, activity.activityId, target);
  assert.equal(workspace.sessionId, preparedWorkspace.sessionId);
  assert.deepEqual(await host.sessions.create(identity, preparedWorkspace), workspace, 'a resumed project operation uses the same initialization after the user opened its workspace first');
  assert.notEqual(workspace.sessionId, home.sessionId);
  activeSessionId = workspace.sessionId;
  await host.sessions.submit(identity, { requestId: randomUUID(), sessionId: workspace.sessionId, text: '检查我的作品' });
  await host.drain();
  assert.equal(scenes[1].scenario, 'workspace-assistant');
  assert.equal(scenes[1].workspace.activityId, activity.activityId);
  await host.sessions.update(identity, { requestId: randomUUID(), sessionId: home.sessionId, archived: true });
  await assert.rejects(port.submit(identity, { requestId: randomUUID(), sessionId: home.sessionId, text: '新问题' }), { code: 'conflict' });
  assert.equal((await port.conversation(identity, home.sessionId)).messages.filter(item => item.role === 'assistant').length, 1);
});
