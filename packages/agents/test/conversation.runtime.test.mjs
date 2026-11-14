import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { createModelGateway, modelMigrations } from '@xunjie/model-gateway';
import { createAgentRuntime, agentRuntimeMigrations } from '../../agent-runtime/dist/index.js';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createConversationPipeline } from '../src/conversation/index.ts';
import { createUserQuestions } from '../src/capabilities/user-questions/index.ts';

test('a home conversation uses the shared kernel and real model gateway without a workspace', async t => {
  const postgres = await nativeFixture();
  const payloads = [], storages = [];
  let models, runtime, askNext = false;
  const upstream = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    payloads.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const asking = askNext; askNext = false;
    response.write('data: ' + JSON.stringify({ id: 'home-answer', choices: [{ index: 0,
      delta: { role: 'assistant', content: asking ? '' : '递归通过更小的同类问题求解。', ...(asking ? { tool_calls: [{ index: 0,
        id: 'explicit-confirmation', type: 'function', function: { name: 'student_ask', arguments: JSON.stringify({
          question: '需要创建一个递归练习工作区吗？', source: '学生表达了练习目标', options: [{ id: 'yes', label: '创建' }],
          allowText: true, skippable: true }) } }] } : {}) }, finish_reason: null }] }) + '\n\n');
    response.write('data: ' + JSON.stringify({ id: 'home-answer', choices: [{ index: 0, delta: {}, finish_reason: asking ? 'tool_calls' : 'stop' }] }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const environmentId = randomUUID();
    const identity = { kind: 'personal', name: '学生', environmentId, spaceId: randomUUID(), principalId: randomUUID() };
    const open = async (name, migrations) => {
      const binding = await provisionStorage({ admin: postgres.admin, owner: { environmentId, serviceId: randomUUID() },
        password: randomUUID(), migrations });
      const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: name, root: join(postgres.root, name) }) });
      storages.push(storage); return storage;
    };
    models = await createModelGateway(await open('models', modelMigrations), { authorize: async () => {}, holder: 'device',
      authorizePermit: (who, permit) => runtime.assertDispatch(who, permit) });
    const connectionId = randomUUID(), grantId = randomUUID();
    await models.save(identity, { requestId: randomUUID(), connectionId, expectedVersion: 0, name: '原生会话测试',
      protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions',
      modelId: 'fixture-home', dialect: 'standard', parameterMode: 'plain', enabled: true, contextWindow: 262144,
      maxOutputTokens: 2048, credential: { action: 'replace', value: 'synthetic-home-model-key' } });
    await models.selection.createGrant(identity, identity, { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
    await models.selection.save(identity, { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, grantId } });
    const pipeline = createConversationPipeline({ models, scenario: { id: 'student-assistant', version: 1,
      async context() { return { system: '回答学生当前的问题，区分事实和未知。', facts: {}, sources: [] }; } }, tools: [] });
    const agentStorage = await open('agent', agentRuntimeMigrations);
    runtime = createAgentRuntime(agentStorage, { authorize: async () => {}, pipeline });
    const sessionId = randomUUID();
    await runtime.initialize({ sessionId, identity, scenario: 'student-assistant', restartPolicy: 'explicit', createdAt: new Date().toISOString() });
    const received = await runtime.accept(identity, { requestId: randomUUID(), sessionId, text: '什么是递归？' });
    await runtime.advance(received.runId);
    const completed = await runtime.run(identity, sessionId, received.runId);
    assert.equal(completed.state, 'completed', JSON.stringify({ completed, events: await runtime.events(identity, sessionId) }));
    assert.equal(payloads.length, 1);
    assert.match(JSON.stringify(payloads[0]), /什么是递归/);
    const events = await runtime.events(identity, sessionId);
    assert.equal(events.find(event => event.kind === 'assistant').body.text, '递归通过更小的同类问题求解。');
    assert.equal('activityId' in received, false);
    await t.test('an installed question capability closes native tool pairs and waits for an explicit response', async () => {
      await runtime.close();
      const asking = createConversationPipeline({ models, scenario: { id: 'student-assistant', version: 1,
        async context() { return { system: '回答问题，必要时明确提问。', facts: {}, sources: [] }; } }, tools: [createUserQuestions()] });
      runtime = createAgentRuntime(agentStorage, { authorize: async () => {}, pipeline: asking });
      const questionSession = randomUUID();
      await runtime.initialize({ sessionId: questionSession, identity, scenario: 'student-assistant', restartPolicy: 'explicit', createdAt: new Date().toISOString() });
      askNext = true;
      const input = await runtime.accept(identity, { requestId: randomUUID(), sessionId: questionSession, text: '我想练习递归' });
      await runtime.advance(input.runId);
      const snapshot = await runtime.snapshot(identity, questionSession, input.runId);
      assert.equal(snapshot.run.state, 'waiting');
      assert.equal(snapshot.waits.length, 1);
      assert.equal(snapshot.waits[0].presentation.question, '需要创建一个递归练习工作区吗？');
      assert.equal(payloads.length, 2);
      await runtime.advance(input.runId);
      assert.equal(payloads.length, 2, 'waiting for an answer never initiates another model call');
      const response = { requestId: randomUUID(), waitId: snapshot.waits[0].waitId, expectedVersion: 1, answer: { kind: 'choice', optionId: 'yes' } };
      const receipt = await runtime.respond(identity, questionSession, response);
      assert.deepEqual(await runtime.respond(identity, questionSession, response), receipt);
      await runtime.advance(input.runId);
      assert.equal((await runtime.run(identity, questionSession, input.runId)).state, 'completed');
      assert.equal(payloads.length, 3);
      assert.match(JSON.stringify(payloads[2]), /explicit-confirmation/);
      assert.match(JSON.stringify(payloads[2]), /yes/);
    });
    await t.test('a capability that rejects preparation retains the model result and pairs an unexecuted tool', async () => {
      await runtime.close();
      const capability = { ...createUserQuestions(), id: 'revoked-question-source',
        async prepare() { throw new StorageError('forbidden'); } };
      const guarded = createConversationPipeline({ models, scenario: { id: 'student-assistant', version: 1,
        async context() { return { system: '按获准能力回答。', facts: {}, sources: [] }; } }, tools: [capability] });
      runtime = createAgentRuntime(agentStorage, { authorize: async () => {}, pipeline: guarded });
      const revokedSession = randomUUID();
      await runtime.initialize({ sessionId: revokedSession, identity, scenario: 'student-assistant', restartPolicy: 'explicit', createdAt: new Date().toISOString() });
      askNext = true;
      const input = await runtime.accept(identity, { requestId: randomUUID(), sessionId: revokedSession, text: '查看先前来源' });
      await runtime.advance(input.runId);
      assert.equal((await runtime.run(identity, revokedSession, input.runId)).state, 'completed');
      const snapshot = await runtime.snapshot(identity, revokedSession, input.runId);
      assert.deepEqual(snapshot.waits, []);
      const events = await runtime.events(identity, revokedSession);
      const tool = events.find(event => event.kind === 'tool-result');
      assert.equal(tool.body.outcome.state, 'not-dispatched');
      assert.equal(tool.body.outcome.feedback.outcome, 'not-executed');
      assert.equal(payloads.length, 5);
      assert.match(JSON.stringify(payloads[4]), /forbidden/);
    });
  } finally {
    await runtime?.close();
    models?.closeWrites(); await models?.checks.drain();
    for (const storage of storages.reverse()) await storage.close();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await postgres.close();
  }
});
