import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileBackend, provisionStorage, openStorage, StorageError } from '@xunjie/storage';
import { createAgentRuntime, agentRuntimeMigrations } from '@xunjie/agent-runtime';
import { createAgentSessions, agentSessionMigration } from '@xunjie/learning-space/learning-data/agent-sessions';
import { createLearningData, learningMigrations } from '@xunjie/learning-space';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createAgentSessionApplication } from '../dist/agent-sessions.js';
import { createAgentConversationProjection } from '../dist/agent-conversation.js';
import { routeAgentSessions } from '../dist/learning-http/sessions-http.js';

test('session initialization resumes at its fixed owner after a lost reply without making a workspace', async t => {
  const pg = await nativeFixture(), handles = [], runtimes = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    for (const storage of handles.reverse()) await storage.close();
    await pg.close();
  });
  const environmentId = randomUUID();
  async function storage(name, migrations) {
    const owner = { environmentId, serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations });
    const opened = await openStorage({ binding, migrations, backend: createFileBackend({ id: name, root: join(pg.root, name) }) });
    handles.push(opened); return opened;
  }
  const data = await storage('data', [...learningMigrations.filter(migration => migration.version < 31), agentSessionMigration]);
  const actor = { environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
  const target = { ...data.owner, version: 1 };
  const learning = createLearningData(data, { resolveBinding: async () => target });
  const agentStorage = await storage('agent', agentRuntimeMigrations);
  const runtime = createAgentRuntime(agentStorage, { authorize: async () => {} }); runtimes.push(runtime);
  const original = { version: 1, connectionId: randomUUID(), installationId: randomUUID(),
    target: { ...agentStorage.owner, unit: 'teaching-agent', protocolVersion: 1, endpoint: 'http://127.0.0.1:3444', capabilities: ['agent.sessions.v2'] } };
  let binding = original, loseReply = true;
  const directory = createAgentSessions(data, { authorize: async () => {}, openActivity: learning.open, resolveOwner: async () => binding });
  const application = createAgentSessionApplication({ directory,
    async runtime(session) {
      assert.equal(session.owner.target.serviceId, original.target.serviceId);
      return { ...runtime, async initialize(input) {
        const saved = await runtime.initialize(input);
        if (loseReply) { loseReply = false; throw new StorageError('unavailable'); }
        return saved;
      } };
    } });
  const input = { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant', title: '普通问答' };
  const projection = createAgentConversationProjection(runtime);
  const http = { sessions: application, agent: async () => ({ ...runtime, ...projection }) };
  await assert.rejects(routeAgentSessions(http, actor, 'agent-sessions', 'POST', input, '', '1'), { code: 'incompatible' });
  assert.deepEqual(await learning.list(actor), []);
  assert.deepEqual(await directory.list(actor), []);
  await assert.rejects(application.create(actor, input), { code: 'unavailable' });
  assert.equal((await directory.read(actor, input.sessionId)).state, 'initializing');
  binding = { ...original, target: { ...original.target, serviceId: randomUUID() } };
  const ready = await application.create(actor, input);
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.owner, original);
  const accepted = await application.accept(actor, { requestId: randomUUID(), sessionId: ready.sessionId, text: '什么是递归？' });
  assert.equal(accepted.sessionId, ready.sessionId);
  assert.equal((await application.run(actor, ready.sessionId, accepted.runId)).state, 'received');
  const conversation = await projection.conversation(actor, ready.sessionId);
  assert.equal(conversation.messages.length, 1);
  assert.equal(conversation.messages[0].text, '什么是递归？');
  assert.equal(conversation.messages[0].inputId, accepted.inputId);
  assert.deepEqual(conversation.runs.map(run => run.runId), [accepted.runId]);
  assert.deepEqual(await routeAgentSessions(http, actor, `agent-sessions/${ready.sessionId}/conversation`, 'GET', undefined, '', '2'), conversation);
  assert.equal((await application.list(actor)).length, 1);
  assert.deepEqual(await learning.list(actor), []);
  await assert.rejects(application.read({ ...actor, principalId: randomUUID() }, ready.sessionId), { code: 'forbidden' });
});
