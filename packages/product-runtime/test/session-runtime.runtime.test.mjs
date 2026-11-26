import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { agentRuntimeMigrations } from '@xunjie/agent-runtime';
import { createAgentSessions, agentSessionMigration } from '@xunjie/learning-space/learning-data/agent-sessions';
import { createLearningData, learningMigrations } from '@xunjie/learning-space';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createSessionRuntimeHost } from '../dist/session-runtime.js';
import { createProductAgent } from '../dist/product-agent.js';
import { routeAgentSessions } from '../dist/learning-http/sessions-http.js';

const connection = { routeId: randomUUID(), version: 1, maxOutputTokens: 4096, contextWindow: 1_000_000,
  protocol: 'openai-chat', parameterMode: 'plain', capabilities: {}, hasCredential: true, adapterState: 'ready' };

test('course-bound teacher text chat uses v3, a separate budget and current grants', { timeout: 60000 }, async t => {
  const pg = await nativeFixture(), storages = [];
  let host, releaseModel;
  t.after(async () => { releaseModel?.(); await host?.close(); for (const storage of storages.reverse()) await storage.close(); await pg.close(); });
  const environmentId = randomUUID();
  async function open(id, migrations) {
    const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId, serviceId: randomUUID() },
      password: randomUUID(), migrations });
    const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id, root: join(pg.root, id) }) });
    storages.push(storage);
    return storage;
  }
  const data = await open('teacher-data', [...learningMigrations.filter(migration => migration.version < 31), agentSessionMigration]);
  const agent = await open('teacher-agent', agentRuntimeMigrations);
  const teacher = { environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '教师' };
  const other = { ...teacher, principalId: randomUUID() };
  const courseId = randomUUID(), sessionId = randomUUID();
  const owner = { version: 1, connectionId: agent.owner.serviceId, installationId: randomUUID(), target: {
    ...agent.owner, unit: 'teaching-agent', protocolVersion: 1, endpoint: 'http://127.0.0.1:3444', capabilities: ['agent.sessions.v3'] } };
  let granted = true, generated = 0, restrictedBudget = false;
  const directory = createAgentSessions(data, { authorize: async () => {},
    openActivity: async () => { throw new Error('teacher chat must not open a workspace'); },
    resolveOwner: async () => owner,
    async authorizeTeacherCourse(identity, course) {
      if (!granted || identity.principalId !== teacher.principalId || course !== courseId) throw new StorageError('forbidden');
    },
  });
  let showProgress;
  const progressed = new Promise(resolve => { showProgress = resolve; });
  const model = mockGateway(async (identity, attemptId) => {
    generated++;
    if (generated !== 3) return;
    await host.runtime.recordProgress(identity, sessionId, attemptId, { revision: 1, text: '正在生成' });
    const held = new Promise(resolve => { releaseModel = resolve; });
    showProgress();
    await held;
  });
  model.checks.requestPayload = async () => ({ messages: [{ role: 'user', content: '教师对话的实际请求正文' }] });
  host = createProductAgent({ storage: agent, directory, models: model, authorize: async () => {},
    scene: async () => { throw new Error('teacher chat must not assemble student tools'); },
    budgetForSession: async session => session.scenario === 'teacher-assistant'
      ? { maxSteps: 4, ...(restrictedBudget ? { maxInputTokens: 1 } : {}) } : undefined,
  });
  const call = (path, method = 'GET', body, who = teacher, search = '') =>
    routeAgentSessions(host, who, 'agent-sessions' + path, method, body, search, '3');
  const create = { requestId: randomUUID(), sessionId, scenario: 'teacher-assistant', courseId };
  await assert.rejects(call('', 'POST', create, other), { code: 'forbidden' });
  assert.equal((await call('', 'POST', create)).courseId, courseId);
  assert.deepEqual((await call('')).items, []);
  assert.equal((await call('', 'GET', undefined, teacher, '?courseId=' + courseId)).items[0].sessionId, sessionId);
  const first = { requestId: randomUUID(), sessionId, text: '怎么解释进位？', context: {} };
  const receipt = await call('/' + sessionId + '/inputs', 'POST', first);
  await host.drain();
  await assert.rejects(call('/' + sessionId + '/inputs/' + receipt.inputId + '/control', 'POST', {
    requestId: randomUUID(), expectedVersion: 1, operation: 'edit', text: '错误的 Skill 引用',
    context: { teacherSkill: { version: 0 } },
  }), { code: 'invalid' });
  const duplicate = await call('/' + sessionId + '/inputs', 'POST', first);
  assert.equal(duplicate.inputId, receipt.inputId);
  assert.equal(duplicate.turnId, receipt.turnId);
  assert.equal(duplicate.inputDigest, receipt.inputDigest);
  const second = { ...first, requestId: randomUUID(), text: '举个例子。' };
  await call('/' + sessionId + '/inputs', 'POST', second);
  await host.drain();
  const conversation = await call('/' + sessionId + '/conversation');
  assert.deepEqual(conversation.messages.map(message => message.text), [first.text, '回答', second.text, '回答']);
  assert.equal(generated, 2);
  const { rows } = await agent.read('SELECT budget FROM agent_turns WHERE turn_id=$1', [receipt.turnId]);
  assert.equal(rows[0].budget.maxSteps, 4);
  assert.deepEqual(conversation.tools, []);
  const third = { ...first, requestId: randomUUID(), text: '请补充。' };
  const running = await call('/' + sessionId + '/inputs', 'POST', third);
  await progressed;
  const live = await call('/' + sessionId + '/conversation');
  assert.ok(live.messages.some(message => message.text === '正在生成' && message.state === 'streaming'));
  const stopped = await call('/' + sessionId + '/runs/' + running.turnId + '/stop', 'POST', { requestId: randomUUID() });
  assert.equal(stopped.state, 'stopped');
  releaseModel();
  await host.drain();
  const afterStop = await call('/' + sessionId + '/conversation');
  assert.equal(afterStop.messages.filter(message => message.text === '回答').length, 2);
  restrictedBudget = true;
  const limited = await call('/' + sessionId + '/inputs', 'POST', { ...first, requestId: randomUUID() });
  await host.drain();
  const failed = await call('/' + sessionId + '/runs/' + limited.turnId);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.reason, 'context-capacity-preflight');
  assert.equal(generated, 3);
  await assert.rejects(call('/' + sessionId + '/conversation', 'GET', undefined, other), { code: 'forbidden' });
  granted = false;
  await assert.rejects(call('/' + sessionId + '/conversation'), { code: 'forbidden' });
  await assert.rejects(call('/' + sessionId + '/inputs', 'POST', { ...second, requestId: randomUUID() }), { code: 'forbidden' });
});

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
  assert.equal(view.assembly, null);
  assert.equal(view.result, null);
  assert.equal(view.request, null);
  assert.equal(view.redaction.request, 'mixed-session-history');
  assert.equal(view.redaction.assembly, 'mixed-session-history');
  assert.equal(view.redaction.tools, 'mixed-session-history');
  assert.equal(view.redaction.citations, 'mixed-session-history');
  assert.deepEqual(view.tools, []);
  assert.deepEqual(view.citations, []);
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

test('attempt inspection keeps Step and Attempt tool receipts inside the selected Attempt', async t => {
  const pg = await nativeFixture();
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations: agentRuntimeMigrations });
  const storage = await openStorage({ binding, migrations: agentRuntimeMigrations,
    backend: createFileBackend({ id: 'inspection-attempt-scope', root: join(pg.root, 'inspection-attempt-scope') }) });
  const student = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
  const inspector = { ...student, principalId: randomUUID(), kind: 'school', name: '排查者' };
  const sessionId = randomUUID(), createdAt = new Date().toISOString();
  const session = { sessionId, identity: student, scenario: 'student-assistant', state: 'ready',
    owner: { target: owner }, createdAt };
  const turnId = randomUUID(), priorStepId = randomUUID(), targetStepId = randomUUID();
  const priorAttemptId = randomUUID(), otherAttemptId = randomUUID(), targetAttemptId = randomUUID();
  const priorCallId = randomUUID(), otherCallId = randomUUID(), targetCallId = randomUUID();
  const activityA = randomUUID(), activityB = randomUUID();
  const now = new Date().toISOString();
  const material = (activityId, text) => ({ materialId: 'M-' + activityId, sourceId: 'source-' + activityId,
    kind: 'system-observation', author: 'system', label: text, version: 'v1', range: null, digest: 'a'.repeat(64),
    content: text, readState: 'included', source: { kind: 'experiment-reference', activityId, executionRef: activityId } });
  const toolResult = (activityId, text) => ({ kind: 'completed', outcome: 'success', summary: text,
    data: { source: { kind: 'experiment-reference', activityId, executionRef: activityId } } });
  const gateway = mockGateway(() => {});
  const host = createProductAgent({ storage, models: gateway, authorize: async () => {},
    inspectSession: async id => id === sessionId ? session : Promise.reject(Object.assign(new Error('missing'), { code: 'missing' })),
    authorizeInspection: async (actor, target) => {
      assert.equal(actor.principalId, inspector.principalId);
      assert.deepEqual(target.activityIds, [activityA]);
    },
    directory: { read: async () => session, readForInspection: async () => session },
    scene: async () => ({ tools: async () => [] }),
  });
  t.after(async () => { await host.close(); await storage.close(); await pg.close(); });
  await host.local.initialize({ sessionId, identity: student, scenario: session.scenario, createdAt });
  await storage.request({ requestId: randomUUID(), fingerprint: 'inspection-attempt-scope-fixture' }, async tx => {
    await tx.query(`INSERT INTO agent_turns(turn_id,session_id,request_id,trigger,origin_notification_id,state,reason,owner_instance_id,budget,usage,created_at,updated_at)
      VALUES($1,$2,$3,'user',NULL,'completed','', 'fixture', $4, $5, $6, $6)`,
      [turnId, sessionId, randomUUID(), JSON.stringify({ maxSteps: 8, maxToolCalls: 8, maxInputTokens: 10000, maxOutputTokens: 1000, maxCallMs: 10000, deadline: null }), JSON.stringify({ inputTokens: 0, outputTokens: 0, inputReserved: 0, outputReserved: 0 }), now]);
    const snapshot = { attemptContexts: {
      [priorAttemptId]: { materials: [material(activityA, 'prior-step-A')], historySources: [] },
      [otherAttemptId]: { materials: [material(activityB, 'other-attempt-B')], historySources: [] },
      [targetAttemptId]: { materials: [material(activityA, 'target-A')], historySources: [] },
    } };
    await tx.query(`INSERT INTO agent_steps(step_id,turn_id,step_no,state,snapshot,created_at,updated_at,completed_at)
      VALUES($1,$2,1,'completed',$3,$4,$4,$4),($5,$2,2,'completed',$3,$4,$4,$4)`,
      [priorStepId, turnId, JSON.stringify(snapshot), now,
        targetStepId]);
    await tx.query(`INSERT INTO agent_attempts(attempt_id,step_id,attempt_no,state,request_ref,response_ref,usage,reserved,error,created_at,updated_at)
      VALUES($1,$2,1,'completed',NULL,NULL,'{"state":"final"}','{"inputTokens":1,"outputTokens":1}',NULL,$3,$3),
             ($4,$5,1,'completed',NULL,NULL,'{"state":"final"}','{"inputTokens":1,"outputTokens":1}',NULL,$3,$3),
             ($6,$5,2,'completed',NULL,NULL,'{"state":"final"}','{"inputTokens":1,"outputTokens":1}',NULL,$3,$3)`,
      [priorAttemptId, priorStepId, now, otherAttemptId, targetStepId, targetAttemptId]);
    await tx.query(`INSERT INTO agent_tool_calls(tool_call_id,step_id,attempt_id,call_index,native_call_id,name,input,execution_mode,state,result,task_id,created_at,updated_at)
      VALUES($1,$2,$3,0,'prior-call','read_work','{}','foreground','closed',$4,NULL,$7,$7),
             ($5,$6,$8,0,'other-call','read_work','{}','foreground','closed',$9,NULL,$7,$7),
             ($10,$6,$11,1,'target-call','read_work','{}','foreground','closed',$12,NULL,$7,$7)`,
      [priorCallId, priorStepId, priorAttemptId, JSON.stringify(toolResult(activityA, 'prior-A')), otherCallId, targetStepId, now,
        otherAttemptId, JSON.stringify(toolResult(activityB, 'other-B')), targetCallId, targetAttemptId, JSON.stringify(toolResult(activityA, 'target-A'))]);
    return null;
  });
  const view = await host.inspect(inspector, sessionId, { attemptId: targetAttemptId });
  assert.equal(view.attemptId, targetAttemptId);
  assert.equal(view.assembly.materials[0].label, 'target-A');
  assert.deepEqual(view.tools.map(tool => tool.toolCallId), [targetCallId]);
  assert.equal(JSON.stringify(view).includes('other-B'), false);
  assert.equal(JSON.stringify(view).includes(activityB), false);
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
