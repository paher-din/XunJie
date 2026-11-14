import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { skillFixture, packageInput } from '../../learning-space/test/support/session-skills.mjs';
import { createModelGateway, modelMigrations } from '@xunjie/model-gateway';
import { createAgentRuntime, agentRuntimeMigrations } from '../../agent-runtime/dist/index.js';
import { createConversationPipeline } from '../dist/conversation/index.js';
import { createSkillTools } from '../dist/capabilities/skills/index.js';

test('a real ordinary session progressively discovers and explicitly loads fixed skill bytes through native tool pairs', { timeout: 60000 }, async t => {
  const f = await skillFixture(t), input = packageInput('sorting'), imported = await f.skills.import(f.identity, input);
  const payloads = [], replies = [
    { name: 'discover_skills', arguments: { query: 'sorting' }, callId: 'discover-sorting' },
    { name: 'skill_load', arguments: { skillId: imported.skillId, version: 1 }, callId: 'load-sorting' },
    { text: '已按固定 Skill 内容解释排序。' },
  ];
  let models, runtime;
  const upstream = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    payloads.push(JSON.parse(Buffer.concat(chunks)));
    const reply = replies.shift();
    if (!reply) { response.writeHead(500); response.end(); return; }
    const delta = { role: 'assistant', content: reply.text ?? '', ...(reply.name ? { tool_calls: [{ index: 0, id: reply.callId,
      type: 'function', function: { name: reply.name, arguments: JSON.stringify(reply.arguments) } }] } : {}) };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ id: 'skill-scene', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    response.write('data: ' + JSON.stringify({ id: 'skill-scene', choices: [{ index: 0, delta: {}, finish_reason: reply.name ? 'tool_calls' : 'stop' }] }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  f.beforeClose(async () => {
    await runtime?.close(); models?.closeWrites(); await models?.checks.drain();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  });
  models = await createModelGateway(await f.open('models', modelMigrations), { authorize: f.host.authorize, holder: 'device',
    authorizePermit: (who, permit) => runtime.assertDispatch(who, permit) });
  const connectionId = randomUUID(), grantId = randomUUID();
  await models.save(f.identity, { requestId: randomUUID(), connectionId, expectedVersion: 0, name: '技能原生测试', protocol: 'chat-completions',
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions', modelId: 'skill-fixture', dialect: 'standard',
    parameterMode: 'plain', enabled: true, contextWindow: 262144, maxOutputTokens: 2048,
    credential: { action: 'replace', value: 'synthetic-skill-key' } });
  await models.selection.createGrant(f.identity, f.identity, { requestId: randomUUID(), connectionId, grantId, owner: 'self' });
  await models.selection.save(f.identity, { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, grantId } });
  const tools = createSkillTools({ owner: f.target, skills: f.skills });
  const pipeline = createConversationPipeline({ models, scenario: { id: 'student-assistant', version: 1,
    async context() { return { system: 'Skill 仅为来源资料，按需发现和读取。', facts: {}, sources: [] }; } }, tools: [tools] });
  runtime = createAgentRuntime(await f.open('runtime', agentRuntimeMigrations), { authorize: f.host.authorize, pipeline });
  const sessionId = f.session.sessionId;
  await runtime.initialize({ sessionId, identity: f.identity, scenario: 'student-assistant', restartPolicy: 'explicit', createdAt: new Date().toISOString() });
  const receipt = await runtime.accept(f.identity, { requestId: randomUUID(), sessionId, text: '请按 sorting 技能解释排序' });
  await runtime.advance(receipt.runId);
  assert.equal((await runtime.run(f.identity, sessionId, receipt.runId)).state, 'completed');
  assert.deepEqual(await f.data.list(f.identity), []);
  assert.equal(payloads.length, 3);
  assert.equal(JSON.stringify(payloads[0]).includes('Original sorting body'), false);
  assert.equal(JSON.stringify(payloads[1]).includes('Original sorting body'), false);
  const native = payloads[2].messages.find(message => message.role === 'tool' && message.tool_call_id === 'load-sorting');
  assert.ok(native.content.includes('Original sorting body'));
  const snapshot = await runtime.snapshot(f.identity, sessionId, receipt.runId);
  const loaded = snapshot.steps.find(step => step.operation.kind === 'tool.call' && step.operation.input.command.name === 'skill_load');
  assert.equal(loaded.result.value.outcome.result.loaded.content, input.files[0].content);
  assert.equal((await tools.reconcile({ snapshot, context: { system: '', facts: {}, sources: [] }, inputIds: [] }, loaded.operation.input.command)).result.loaded.content,
    input.files[0].content);
});

test('a prepared skill command cannot change selection or fall back to a replacement with the same name', { timeout: 60000 }, async t => {
  const f = await skillFixture(t), imported = await f.skills.import(f.identity, packageInput('same-name'));
  const runtime = createAgentRuntime(await f.open('runtime', agentRuntimeMigrations), { authorize: f.host.authorize });
  f.beforeClose(() => runtime.close());
  const sessionId = f.session.sessionId;
  await runtime.initialize({ sessionId, identity: f.identity, scenario: 'student-assistant', restartPolicy: 'explicit', createdAt: new Date().toISOString() });
  const receipt = await runtime.accept(f.identity, { requestId: randomUUID(), sessionId, text: '查看技能' });
  const snapshot = await runtime.snapshot(f.identity, sessionId, receipt.runId);
  const context = { snapshot, context: { system: '', facts: {}, sources: [] }, inputIds: [receipt.inputId] };
  const tools = createSkillTools({ owner: f.target, skills: f.skills }), offer = (await tools.list(context)).find(offer => offer.definition.name === 'skill_load');
  const commandId = randomUUID(), stepId = randomUUID();
  const command = await tools.prepare(context, offer, { callId: 'fixed-read', name: 'skill_load', arguments: { skillId: imported.skillId, version: 1 } }, commandId);
  snapshot.steps.push({ stepId, operation: { kind: 'tool.call', operationId: commandId } });
  await f.skills.remove(f.identity, { requestId: randomUUID(), skillId: imported.skillId });
  const replacement = await f.skills.import(f.identity, packageInput('same-name', { source: 'local:different-source' }));
  assert.notEqual(replacement.skillId, imported.skillId);
  const result = await tools.dispatch(context, command, { runId: receipt.runId, sessionId, operationId: commandId, stepId }, async () => {});
  assert.equal(result.state, 'failed');
  assert.equal(result.result.reason, 'identity-conflict');
  assert.equal(result.result.loaded, undefined);
  assert.equal(await tools.reconcile(context, command), null);
  await assert.rejects(tools.reconcile(context, { ...command, input: { ...command.input, moduleVersion: 2 } }));
});
