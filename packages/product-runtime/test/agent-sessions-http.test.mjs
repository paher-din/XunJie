import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createLearningEntry } from '../dist/learning-http/index.js';
import { routeAgentSessions } from '../dist/learning-http/sessions-http.js';
import { teacherChatGateway } from '../dist/teacher-chat.js';
import { createTeacherAssistant } from '@xunjie/agents/teacher-assistant/index';
import { createTeacherCourseTools } from '@xunjie/agents/teacher-assistant/course-tools';
import { createAgentSessionSchema } from '@xunjie/contracts/agent-sessions';
import { StorageError } from '@xunjie/storage';

test('teacher chat requires a course and exposes no student or business tools', async () => {
  const input = { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'teacher-assistant' };
  assert.equal(createAgentSessionSchema.safeParse(input).success, false);
  assert.equal(createAgentSessionSchema.safeParse({ ...input, courseId: randomUUID() }).success, true);
  assert.equal(createAgentSessionSchema.safeParse({ ...input, scenario: 'student-assistant', courseId: randomUUID() }).success, false);
  const teacher = createTeacherAssistant();
  assert.deepEqual(await teacher.tools({}), []);
  assert.match((await teacher.context({})).system, /任课教师助手/);
});

test('teacher course tools keep versions and ranges fixed, withhold private material and report ambiguity', async () => {
  const target = { taskId: randomUUID(), releaseId: randomUUID() }, materialId = randomUUID(), courseId = randomUUID();
  const material = { materialId, title: 'ALU 讲义', mediaType: 'text/plain', byteLength: 6, sha256: 'a'.repeat(64) };
  const release = { ...target, courseId, taskTitle: 'ALU', contentDigest: 'b'.repeat(64),
    objectives: ['理解进位'], requirements: '先预测再仿真。', helpPolicy: {}, materials: [material] };
  let revoked = false, materialReads = 0;
  const tools = createTeacherCourseTools({
    find: async () => [target, { ...target, releaseId: randomUUID() }],
    async release(id) {
      if (revoked || id !== target.releaseId) throw new StorageError('forbidden');
      return release;
    },
    async material() { materialReads++; return { ...material, contentBase64: Buffer.from('甲𠮷乙').toString('base64') }; },
  }, target);
  assert.doesNotMatch(JSON.stringify(tools.map(tool => tool.definition.inputSchema)), /"format":"uuid"/);
  const call = (name, input) => tools.find(tool => tool.definition.name === name)
    .execute({ input }, { assertActive: async () => {} });
  assert.equal((await call('read_course_task', { query: 'ALU' })).data.status, 'ambiguous');
  assert.equal((await call('read_course_task', {})).data.source.releaseId, target.releaseId);
  assert.equal((await call('read_course_task', { ...target, taskId: randomUUID() })).data.reason, 'invalid');
  assert.equal((await call('read_course_task', { ...target, releaseId: randomUUID() })).data.reason, 'forbidden');
  assert.equal((await call('list_design_materials', {})).data.materials[0].materialId, materialId);
  assert.equal((await call('read_design_material', { materialId, offset: 1, length: 1 })).data.text, '𠮷');
  assert.equal((await call('read_design_material', { materialId: randomUUID() })).data.reason, 'missing');
  assert.equal(materialReads, 1);
  revoked = true;
  assert.equal((await call('read_design_material', { materialId })).data.reason, 'forbidden');
});

test('long teacher task replies retain all three independent continuation paths', async () => {
  const target = { taskId: randomUUID(), releaseId: randomUUID() };
  const release = { ...target, courseId: randomUUID(), taskTitle: '任务'.repeat(150), contentDigest: 'c'.repeat(64),
    objectives: ['目'.repeat(500), '第二个目标'], requirements: '字'.repeat(1600),
    helpPolicy: { version: 1, questions: 'allowed', scope: 'course', note: '规'.repeat(2000) }, materials: [] };
  const [tool] = createTeacherCourseTools({ release: async () => release }, target);
  async function read(args) {
    const result = await tool.execute({ input: args }, { assertActive: async () => {} });
    return JSON.parse(result.summary);
  }
  const first = await read({});
  assert.ok(first.requirements.nextOffset > 0);
  assert.ok(first.helpNote.nextOffset > 0);
  const next = await read({ offset: first.requirements.nextOffset, helpNoteOffset: first.helpNote.nextOffset, objectiveOffset: first.nextObjectiveOffset });
  assert.equal(next.requirements.offset, first.requirements.length);
  assert.equal(next.helpNote.offset, first.helpNote.length);
  assert.deepEqual(next.objectives, ['第二个目标']);
});

test('messages steer Skill facts, tools and history without rewriting the Turn rules', async () => {
  const teacherSkill = { skillId: randomUUID(), version: 1 }, firstId = randomUUID();
  const scene = createTeacherAssistant({ course: {}, skills: {
    owner: { environmentId: randomUUID(), serviceId: randomUUID(), version: 1 },
    scope: () => ({ resolveSession: async () => ({ catalog: [{
      ...teacherSkill, name: '项目式备课', description: '', selected: true,
    }] }) }),
  } });
  const first = { turnId: randomUUID(), originInput: { inputId: firstId, context: { teacherSkill } } };
  const next = { ...first, originInput: { inputId: randomUUID(), context: {} } };
  const again = { ...next, originInput: { ...next.originInput, context: { teacherSkill } } };
  assert.equal((await scene.context(first)).system, (await scene.context(next)).system);
  assert.equal((await scene.context(first)).facts.teacherSkill.status, 'selected');
  assert.equal((await scene.context(next)).facts.teacherSkill, undefined);
  assert.equal((await scene.context(again)).facts.teacherSkill.status, 'selected');
  assert.ok((await scene.tools(first)).some(tool => tool.definition.name === 'skill_load'));
  assert.ok(!(await scene.tools(next)).some(tool => tool.definition.name === 'skill_load'));
  const entry = { id: randomUUID(), turnId: first.turnId, toolName: 'skill_load', sources: [{ source:
    { kind: 'tool-call', toolName: 'skill_load', source: { kind: 'teacher-skill', inputId: firstId, ...teacherSkill } },
  }] };
  assert.deepEqual(await scene.authorizeHistory(first, [entry]), [entry]);
  assert.deepEqual(await scene.authorizeHistory(next, [entry]), []);
  assert.deepEqual(await scene.authorizeHistory(again, [entry]), []);
});

test('teacher gateway reads and pins the independent selection without touching student selection', async () => {
  const identity = { kind: 'school' }, connectionId = randomUUID(), pinId = randomUUID();
  const choice = { connection: { connectionId } };
  const base = { selection: {
    read: async () => { throw new Error('student selection must not be read'); },
    pin: async () => { throw new Error('student selection must not be pinned'); },
  } };
  const selection = {
    read: async () => ({ version: 1, selected: choice, options: [] }),
    async pin(who, id, version) {
      assert.equal(who, identity); assert.equal(id, pinId); assert.equal(version, 1);
      return { choice };
    },
  };
  const gateway = teacherChatGateway(base, selection);
  assert.deepEqual(await gateway.selection.read(identity), { version: 1, selected: choice, options: [] });
  assert.deepEqual(await gateway.selection.pin(identity, pinId, 1), { choice });
  const unavailable = teacherChatGateway(base, { ...selection, read: async () => ({ version: 1, selected: null, options: [] }) });
  await assert.rejects(unavailable.selection.read(identity), { code: 'teacher-model-unavailable' });
});

test('the product HTTP boundary rejects old Agent contracts and authenticates a connected subject before session routing', async t => {
  let entry, forwarded = 0, selected = 0;
  const server = createServer((request, response) => void entry(request, response));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const endpoint = `http://127.0.0.1:${server.address().port}`, connectionId = randomUUID();
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '当前学校学生' };
  const environment = { environmentId: randomUUID(), installationId: randomUUID(), clientNamespace: randomUUID(), profile: 'local',
    services: [{ endpoint }] };
  const client = { async list() { return [{ key: 'school:' + connectionId, identity }]; }, async account() { return null; },
    async start() {}, async complete() {}, async forward() { forwarded++; return { wrongOwner: true }; } };
  const headers = { 'x-xj-space': 'school:' + connectionId, 'x-xj-expected-subject': [identity.environmentId, identity.spaceId, identity.principalId].join('.') };
  entry = createLearningEntry({ environment, administratorToken: 'synthetic-control', client });
  const old = await fetch(endpoint + '/api/learning/agent-sessions', { headers: { ...headers, 'x-xj-agent-contract': '1' } });
  assert.deepEqual(await old.json(), { error: 'incompatible' });
  assert.equal(forwarded, 0);
  entry = createLearningEntry({ environment, administratorToken: 'synthetic-control', client, async agentSessions(who) {
    assert.deepEqual(who, identity); selected++;
    return { sessions: { async list() { return []; } } };
  } });
  const wrong = await fetch(endpoint + '/api/learning/agent-sessions', { headers: { ...headers,
    'x-xj-agent-contract': '3', 'x-xj-expected-subject': randomUUID() } });
  assert.equal(wrong.status, 403);
  assert.equal(selected, 0);
  const current = await fetch(endpoint + '/api/learning/agent-sessions', { headers: { ...headers, 'x-xj-agent-contract': '3' } });
  assert.equal(current.status, 200);
  assert.deepEqual(await current.json(), { items: [] });
  assert.equal(selected, 1);
  assert.equal(forwarded, 0);
});

test('the browser session snapshot projects away kernel assembly, source tracing and metering', async () => {
  const environmentId = randomUUID(), serviceId = randomUUID();
  const identity = { environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
  const sessionId = randomUUID(), turnId = randomUUID(), stepId = randomUUID(), attemptId = randomUUID(), toolCallId = randomUUID();
  const now = new Date().toISOString();
  const session = { sessionId, requestId: randomUUID(), identity, scenario: 'student-assistant',
    owner: { version: 1, connectionId: randomUUID(), installationId: randomUUID(),
      target: { environmentId, serviceId, unit: 'teaching-agent', endpoint: 'http://127.0.0.1:1', protocolVersion: 1,
        capabilities: ['agent.sessions.v3'] } },
    title: null, pinned: false, archived: false, deleted: false, state: 'ready', createdAt: now, updatedAt: now, readyAt: now };
  const snapshot = {
    session: { sessionId, identity, scenario: 'student-assistant', createdAt: now }, automaticWakeBlocked: 'maintenance-secret',
    turns: [{ turnId, sessionId, requestId: randomUUID(), trigger: 'user', originNotificationId: null, state: 'completed',
      reason: '', ownerInstanceId: 'secret-owner', createdAt: now, updatedAt: now, completedAt: now }],
    inputs: [],
    steps: [{ stepId, turnId, stepNo: 1, state: 'completed', createdAt: now, updatedAt: now, completedAt: now,
      snapshot: { systemDigest: 'secret-system', attemptContexts: { [attemptId]: { materials: [{ owner: 'secret-owner' }] } } } }],
    attempts: [{ attemptId, stepId, attemptNo: 1, state: 'completed', requestRef: randomUUID(), responseRef: randomUUID(),
      usage: { state: 'final', inputTokens: 99, outputTokens: 10 }, reserved: { inputTokens: 111, outputTokens: 22 },
      error: 'secret-error', createdAt: now, updatedAt: now }],
    toolCalls: [{ toolCallId, stepId, callIndex: 0, nativeCallId: 'call-secret', name: 'read_result',
      input: { requestId: randomUUID(), owner: 'secret-owner' }, executionMode: 'foreground', state: 'closed',
      result: { kind: 'completed', outcome: 'success', summary: '公开摘要', data: { secret: 'secret-result' }, resultRef: randomUUID() },
      taskId: null, createdAt: now, updatedAt: now }],
    questions: [],
    notifications: [{ notificationId: randomUUID(), sessionId, originTurnId: turnId, taskId: 'task-1', taskVersion: 'v1',
      terminalStatus: 'success', summary: '完成', resultRef: 'secret-notification', state: 'adopted', consumedByStepId: stepId, createdAt: now }],
  };
  const projected = await routeAgentSessions({
    sessions: { list: async () => [], create: async () => { throw new Error('unused'); },
      read: async () => session, update: async () => { throw new Error('unused'); }, workspace: async () => { throw new Error('unused'); } },
    async agent() { return { sessionSnapshot: async () => snapshot }; },
  }, identity, `agent-sessions/${sessionId}/snapshots/${turnId}`, 'GET', undefined, '', '3');
  assert.deepEqual(projected.steps[0].snapshot, {});
  assert.equal(projected.automaticWakeBlocked, null);
  assert.equal(projected.attempts[0].requestRef, null);
  assert.equal(projected.attempts[0].usage.state, 'unknown');
  assert.equal(projected.toolCalls[0].input && Object.keys(projected.toolCalls[0].input).length, 0);
  assert.equal(projected.toolCalls[0].result.data, undefined);
  assert.equal(projected.notifications[0].resultRef, null);
  assert.doesNotMatch(JSON.stringify(projected), /secret-/);
});
