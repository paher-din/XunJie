import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { openProductRuntime } from '../dist/index.js';

test('the installed product answers and restores a normal home session without an activity', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xj-session-product-'));
  const payloads = [];
  const tools = [];
  let policyDecision = 'ordinary';
  const upstream = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks)); payloads.push(payload);
    const texts = payload.messages.flatMap(message => typeof message.content === 'string' ? [message.content]
      : Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text) : []);
    const policy = texts.some(text => text.includes('STUDENT_INPUT_POLICY_V'));
    let text = '递归通过更小的同类问题求解。';
    if (policy) {
      const input = texts.map(content => { try { return JSON.parse(content); } catch { return null; } }).find(input => input?.inputDigest);
      assert.ok(input, 'the policy input must preserve exact current user bytes');
      text = JSON.stringify({ inputDigest: input.inputDigest, creationAuthorization: policyDecision });
    }
    const next = policy ? undefined : tools.shift();
    const tool = typeof next === 'function' ? next(payload) : next;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: tool ? { content: '', tool_calls: [{ index: 0,
      id: 'fixture-' + randomUUID(), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { content: text },
      finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 150, completion_tokens: 40, total_tokens: 190 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const product = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0',
    postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6',
    webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } });
  t.after(async () => { await product.stop().catch(() => {}); upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await product.install({ profile: 'local' });
  let state = await product.start();
  async function api(route, body) {
    const response = await fetch(state.endpoint + '/api/learning/' + route, { headers: {
      'content-type': 'application/json', 'x-xj-space': 'personal', 'x-xj-agent-contract': '2' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.status, 200, route + ': ' + JSON.stringify(result)); return result;
  }
  const connectionId = randomUUID(), grantId = randomUUID();
  await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: '会话集成测试',
    protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions',
    modelId: 'session-fixture', dialect: 'standard', parameterMode: 'plain', enabled: true, contextWindow: 262144,
    maxOutputTokens: 1024, credential: { action: 'replace', value: 'synthetic-session-test-key' } });
  await api('models/grants', { requestId: randomUUID(), connectionId, grantId, owner: 'self' });
  await api('models/selection', { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, grantId } });
  const session = await api('agent-sessions', { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' });
  const input = { requestId: randomUUID(), sessionId: session.sessionId, text: '什么是递归？' };
  const receipt = await api(`agent-sessions/${session.sessionId}/inputs`, input);
  assert.deepEqual(await api(`agent-sessions/${session.sessionId}/inputs`, input), receipt);
  let conversation;
  const deadline = Date.now() + 20000;
  do {
    conversation = await api(`agent-sessions/${session.sessionId}/conversation`);
    if (conversation.runs.some(run => ['completed', 'paused', 'failed'].includes(run.state))) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  assert.equal(conversation.runs[0].state, 'completed', JSON.stringify(conversation));
  assert.equal(conversation.messages.filter(message => message.role === 'assistant').at(-1).text, '递归通过更小的同类问题求解。');
  assert.deepEqual(await api('activities'), []);
  assert.deepEqual((await api(`agent-sessions/${session.sessionId}/requests/${input.requestId}`)).receipt, receipt);
  assert.equal(payloads.length, 2, 'one fixed input policy and one answer; duplicate acceptance starts neither again');
  await product.stop();
  try { state = await product.start(); }
  catch (error) { throw new Error(error.message + '\n' + (await readFile(join(root, 'logs/runtime.log'), 'utf8')).slice(-5000), { cause: error }); }
  const restored = await api(`agent-sessions/${session.sessionId}/conversation`);
  assert.deepEqual(restored, conversation);
  assert.equal(payloads.length, 2);
  async function untilRun(runId, expected, sessionId = session.sessionId) {
    const deadline = Date.now() + 20000;
    let current;
    do {
      current = await api(`agent-sessions/${sessionId}/conversation`);
      const run = current.runs.find(run => run.runId === runId);
      if (run && ['completed', 'failed', 'paused', 'stopped', ...expected].includes(run.state)) {
        assert.ok(expected.includes(run.state), JSON.stringify(current)); return current;
      }
      await new Promise(resolve => setTimeout(resolve, 30));
    } while (Date.now() < deadline);
    assert.fail(JSON.stringify(current));
  }
  const question = { name: 'student_ask', arguments: { question: '确认创建一个本机自主学习项目和独立工作区吗？',
    source: '学生表达了练习目标，尚未要求建立项目。', options: [{ id: 'create', label: '创建项目和工作区' }, { id: 'later', label: '暂不创建' }],
    allowText: true, skippable: true } };
  const content = { title: '递归练习', goal: '理解递归的终止条件', stages: [{ title: '观察递归', goal: '指出基例并解释递归步骤' }], materialRefs: [] };
  await t.test('a learning goal waits for confirmation and refusal does not create even when the model asks to', async () => {
    policyDecision = 'request-learning'; tools.push(question, { name: 'create_personal_project', arguments: content });
    const received = await api(`agent-sessions/${session.sessionId}/inputs`, { requestId: randomUUID(), sessionId: session.sessionId, text: '我想练习递归' });
    const asking = await untilRun(received.runId, ['waiting']);
    assert.deepEqual(await api('activities'), []);
    const wait = asking.waits.find(wait => wait.state === 'pending');
    assert.ok(wait);
    policyDecision = 'ordinary';
    await api(`agent-sessions/${session.sessionId}/waits/${wait.waitId}/responses`, {
      requestId: randomUUID(), expectedVersion: wait.version, answer: { kind: 'choice', optionId: 'later' } });
    const declined = await untilRun(received.runId, ['completed']);
    assert.deepEqual(await api('activities'), []);
    assert.deepEqual(declined.workspaces, []);
    assert.ok(declined.tools.some(tool => tool.name === 'create_personal_project' && tool.state === 'not-dispatched'));
  });
  const uploaded = await api(`agent-sessions/${session.sessionId}/materials`, { requestId: randomUUID(), materialId: randomUUID(),
    name: '递归笔记.md', mediaType: 'text/markdown', dataBase64: Buffer.from('递归必须有终止条件。').toString('base64') });
  const dataOwner = state.environment.services.find(service => service.unit === 'learning-data');
  const { name: _name, ...subject } = session.identity;
  content.materialRefs = [{ sourceId: 'local-personal', identity: subject, owner: { environmentId: dataOwner.environmentId, serviceId: dataOwner.serviceId, version: 1 },
    kind: 'personal-material', objectId: uploaded.materialId, version: '1', sha256: uploaded.versions[0].sha256,
    scope: { kind: 'session', sessionId: session.sessionId } }];
  let workspace;
  await t.test('a direct request creates one real project and card, with its own workspace session and retained materials', async () => {
    policyDecision = 'direct-create'; tools.push({ name: 'create_personal_project', arguments: content });
    const input = { requestId: randomUUID(), sessionId: session.sessionId, text: '请现在创建递归练习项目和工作区，并带上我的笔记' };
    const received = await api(`agent-sessions/${session.sessionId}/inputs`, input);
    assert.deepEqual(await api(`agent-sessions/${session.sessionId}/inputs`, input), received);
    const created = await untilRun(received.runId, ['completed']);
    assert.equal(created.workspaces.length, 1);
    workspace = created.workspaces[0].workspace;
    assert.equal((await api('activities')).length, 1);
    assert.notEqual(workspace.sessionId, session.sessionId);
    assert.equal((await api('agent-sessions/workspace', { activityId: workspace.activityId, target: workspace.target })).sessionId, workspace.sessionId);
    const project = await api(`activities/${workspace.activityId}/project`);
    assert.deepEqual(project.content.stages, content.stages);
    assert.equal(project.workspaceSessionId, workspace.sessionId);
    assert.deepEqual((await api(`agent-sessions/${workspace.sessionId}/conversation`)).messages, []);
    await api('agent-sessions/update', { requestId: randomUUID(), sessionId: session.sessionId, deleted: true });
    const retained = await api(`materials/${workspace.activityId}`);
    assert.equal(retained.length, 1);
    assert.equal((await api(`materials/${workspace.activityId}/${retained[0].materialId}/versions/1`)).text, '递归必须有终止条件。');
  });
  await t.test('answering the original creation question creates in personal space and opens an independent working conversation', async () => {
    const home = await api('agent-sessions', { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' });
    policyDecision = 'request-learning'; tools.push(question, { name: 'create_personal_project', arguments: { ...content, materialRefs: [] } });
    const received = await api(`agent-sessions/${home.sessionId}/inputs`, { requestId: randomUUID(), sessionId: home.sessionId, text: '我想练习递归' });
    const asking = await untilRun(received.runId, ['waiting'], home.sessionId), wait = asking.waits.find(wait => wait.state === 'pending');
    assert.ok(wait);
    policyDecision = 'direct-create';
    const answer = { requestId: randomUUID(), expectedVersion: wait.version, answer: { kind: 'choice', optionId: 'create' } };
    const response = await api(`agent-sessions/${home.sessionId}/waits/${wait.waitId}/responses`, answer);
    assert.deepEqual(await api(`agent-sessions/${home.sessionId}/waits/${wait.waitId}/responses`, answer), response);
    const created = await untilRun(received.runId, ['completed'], home.sessionId);
    assert.equal(created.workspaces.length, 1);
    assert.equal((await api('activities')).length, 2);
    const target = created.workspaces[0].workspace, metadata = await api(`agent-sessions/${target.sessionId}`);
    assert.equal(metadata.identity.kind, 'personal');
    assert.equal(metadata.workspace.target.environmentId, dataOwner.environmentId);
    assert.equal(metadata.workspace.target.serviceId, dataOwner.serviceId);
    assert.notEqual(metadata.sessionId, home.sessionId);
    policyDecision = 'ordinary';
    const action = { requestId: randomUUID(), scope: { environmentId: metadata.identity.environmentId, spaceId: metadata.identity.spaceId,
      principalId: metadata.identity.principalId, activityId: target.activityId },
      receiver: { receiverId: 'teaching-agent:' + metadata.owner.target.serviceId, location: 'local', kind: 'question' },
      draft: { token: randomUUID(), question: '结合当前目标解释递归', references: [], bases: [] }, works: [], evidence: [] };
    const workspaceAnswer = await api(`agent-sessions/${target.sessionId}/inputs`, { requestId: randomUUID(), sessionId: target.sessionId,
      text: action.draft.question, context: { action } });
    const independent = await untilRun(workspaceAnswer.runId, ['completed'], target.sessionId);
    assert.equal(independent.messages.filter(message => message.role === 'assistant').at(-1).text, '递归通过更小的同类问题求解。');
    assert.equal((await api(`agent-sessions/${home.sessionId}/conversation`)).runs.length, 1);
    assert.equal(independent.runs.length, 1);
  });
  await t.test('the actual product discovers and loads an optional Skill binding before reading its fixed original', async () => {
    const home = await api('agent-sessions', { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' });
    const content = '---\nname: recursion-notes\ndescription: Read a fixed recursion note\n---\nA recursive call must approach its base case.\n';
    const imported = await api('skills/import', { requestId: randomUUID(), source: 'installed-session-test', packageVersion: '1',
      files: [{ path: 'SKILL.md', encoding: 'utf8', content }] });
    await api(`agent-sessions/${home.sessionId}/skills/select`, { requestId: randomUUID(),
      skills: [{ skillId: imported.skillId, version: 1 }] });
    tools.push(payload => {
      const names = payload.tools.map(tool => tool.function.name);
      assert.ok(names.includes('discover_tools'), 'the installed host must expose the discovery capability');
      assert.ok(!names.includes('skill_load'), 'optional Skill content is not loaded into the initial model vocabulary');
      return { name: 'discover_tools', arguments: { purpose: 'skill_load' } };
    }, payload => {
      const page = JSON.parse(payload.messages.filter(message => message.role === 'tool').at(-1).content);
      assert.equal(page.entries.length, 1);
      return { name: 'load_tools', arguments: { bindingIds: [page.entries[0].bindingId] } };
    }, payload => {
      assert.ok(payload.tools.some(tool => tool.function.name === 'skill_load'));
      return { name: 'skill_load', arguments: { skillId: imported.skillId, version: 1 } };
    });
    policyDecision = 'ordinary';
    const input = await api(`agent-sessions/${home.sessionId}/inputs`, { requestId: randomUUID(), sessionId: home.sessionId, text: '读取已选递归技能的原文' });
    const answer = await untilRun(input.runId, ['completed'], home.sessionId);
    assert.deepEqual(answer.tools.map(tool => tool.name), ['discover_tools', 'load_tools', 'skill_load']);
    const loaded = JSON.parse(answer.tools.at(-1).feedback.text);
    assert.equal(loaded.content, content);
    assert.equal((await api('activities')).length, 2);
  });
});
