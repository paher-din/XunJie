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

test('the product host selects the saved scene and wakes the direct runner without creating a home workspace', async t => {
  const pg = await nativeFixture(), storages = [];
  let host;
  let signalProgress, finishModel;
  const progressed = new Promise(resolve => { signalProgress = resolve; });
  const modelReply = new Promise(resolve => { finishModel = resolve; });
  t.after(async () => { finishModel(); await host?.close(); for (const storage of storages.reverse()) await storage.close(); await pg.close(); });
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
    ...agent.owner, unit: 'teaching-agent', protocolVersion: 1, endpoint: 'http://127.0.0.1:3444', capabilities: ['agent.sessions.v2'] } };
  const directory = createAgentSessions(data, { authorize: async () => {}, openActivity: learning.open, resolveOwner: async () => owner });
  const scenes = [], dispatches = [], workspaceRequests = new Map();
  host = createSessionRuntimeHost({ storage: agent, directory, authorize: async () => {},
    workspaceRequest: async (_identity, activityId) => workspaceRequests.get(activityId),
    async pipeline(session) {
      scenes.push({ sessionId: session.sessionId, scenario: session.scenario, workspace: session.workspace });
      return {
        async plan(snapshot, ids) { return snapshot.steps.length ? { kind: 'complete' }
          : { kind: 'operation', operation: { operationId: ids.operationId, kind: 'model.call', bindingId: 'fixture-model-v1', input: {} }, snapshot: {} }; },
        async dispatch(snapshot, step, permit, assertDispatch) {
          await assertDispatch(); dispatches.push(snapshot.session.sessionId);
          if (snapshot.session.scenario === 'student-assistant') {
            await host.runtime.recordProgress(snapshot.session.identity, permit, { revision: 1, text: '正在形成的回答' });
            signalProgress(); await modelReply;
          }
          return { state: 'completed', value: { text: '回答' } };
        }, async reconcile() { return null; },
        async apply(snapshot, step, result) { return { state: {}, complete: true, events: [{ kind: 'assistant',
          body: { attemptId: step.operation.operationId, text: result.value.text } }] }; },
      };
    } });
  const home = await host.sessions.create(identity, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' });
  const receipt = await host.sessions.accept(identity, { requestId: randomUUID(), sessionId: home.sessionId, text: '什么是递归？' });
  await progressed;
  const streaming = await (await host.agent(identity, home.sessionId)).conversation(identity, home.sessionId);
  assert.deepEqual(streaming.messages.filter(item => item.role === 'assistant').map(item => [item.text, item.state]), [['正在形成的回答', 'streaming']]);
  finishModel();
  await host.drain();
  const port = await host.agent(identity, home.sessionId);
  assert.equal((await port.run(identity, home.sessionId, receipt.runId)).state, 'completed');
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
  await host.sessions.accept(identity, { requestId: randomUUID(), sessionId: workspace.sessionId, text: '检查我的作品' });
  await host.drain();
  assert.equal(scenes[1].scenario, 'workspace-assistant');
  assert.equal(scenes[1].workspace.activityId, activity.activityId);
  assert.deepEqual(dispatches, [home.sessionId, workspace.sessionId]);
  await host.sessions.update(identity, { requestId: randomUUID(), sessionId: home.sessionId, archived: true });
  await assert.rejects(port.accept(identity, { requestId: randomUUID(), sessionId: home.sessionId, text: '新问题' }), { code: 'conflict' });
  assert.equal((await port.conversation(identity, home.sessionId)).messages.filter(item => item.role === 'assistant').length, 1);
});
