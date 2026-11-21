import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createLearningEntry } from '../dist/learning-http/index.js';
import { routeAgentSessions } from '../dist/learning-http/sessions-http.js';

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
