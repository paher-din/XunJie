import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openProductRuntime, restoreProductRecovery } from '@xunjie/product-runtime';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Requires native PostgreSQL 18.6.');

async function until(check, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(description);
}

function chat(response, { text = '', call, finish = call ? 'tool_calls' : 'stop' }) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = { role: 'assistant', content: text, ...(call ? { tool_calls: [{ index: 0, id: call.id,
    type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : {}) };
  for (const value of [
    { id: 'fixture-tool', choices: [{ index: 0, delta, finish_reason: null }] },
    { id: 'fixture-tool', choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
  ]) response.write('data: ' + JSON.stringify(value) + '\n\n');
  response.end('data: [DONE]\n\n');
}

async function fixture(answer, protocol = 'chat-completions') {
  const payloads = [];
  const upstream = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks));
      payloads.push(payload);
      await answer(payload, response, payloads.length);
    } catch (error) { response.destroy(error); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'xj-agent-tools-'));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
    postgresBin, postgresVersion: '18.6', webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
  const runtime = openProductRuntime({ root, resources });
  await runtime.install({ profile: 'local' });
  let endpoint = (await runtime.start()).endpoint;
  const api = async (route, body) => {
    const response = await fetch(new URL('/api/learning/' + route, endpoint), {
      headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.equal(response.status, 200, route + ': ' + JSON.stringify(value));
    return value;
  };
  const connectionId = randomUUID(), grantId = randomUUID();
  await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0,
    name: '真实工具往返', protocol, baseUrl: `http://127.0.0.1:${upstream.address().port}/${protocol === 'messages' ? 'anthropic' : 'v1'}`,
    path: protocol === 'messages' ? '/v1/messages' : protocol === 'responses' ? '/responses' : '/chat/completions',
    modelId: 'fixture-tools', dialect: protocol === 'chat-completions' ? 'standard' : 'deepseek',
    parameterMode: protocol === 'chat-completions' ? 'plain' : 'thinking', enabled: true,
    contextWindow: 262144, maxOutputTokens: 1024, credential: { action: 'replace', value: 'synthetic-tools-key' } });
  await api('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
  await api('models/selection', { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, grantId } });
  const activity = await api('activities', { requestId: randomUUID(), goal: '按原作品解释', question: '', references: [] });
  const receiver = (await api(`agent/${activity.activityId}/capabilities`)).receiver;
  const scope = { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
    principalId: activity.identity.principalId, activityId: activity.activityId };
  return { api, activity, payloads, runtime, root, resources,
    input: (question, works = []) => ({ requestId: randomUUID(), scope, receiver,
      draft: { token: randomUUID(), question, references: [], bases: [] }, works, evidence: [] }),
    async send(input) {
      await api(`intents/${activity.activityId}`, input);
      const receipt = await api(`intents/${activity.activityId}/${input.requestId}/dispatch`, {});
      assert.equal(receipt.state, 'accepted');
      return JSON.parse(receipt.receipt.detail).runId;
    },
    async restart() { await runtime.stop(); endpoint = (await runtime.start()).endpoint; },
    async close() {
      await runtime.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } };
}

test('the original request explains its fixed assembly, actual prompt, executor and material after restart', { timeout: 180000 }, async () => {
  const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'original.txt', kind: 'text', encoding: 'utf8',
    mediaType: 'text/plain', value: '原件中的电路观察为 37，不能解释成学生预测。' };
  const f = await fixture((payload, response, index) => {
    if (index === 1) chat(response, { call: { id: 'assembly-source', name: 'read_work',
      arguments: { objectId: work.objectId, contentId: work.contentId } } });
    else chat(response, { text: '从固定原件读取的观察为 37。' });
  });
  try {
    const runId = await f.send(f.input('先读取我固定的原件，解释观察。', [work]));
    await until(async () => (await f.api(`agent/${f.activity.activityId}/runs/${runId}`)).state === 'completed', 'assembly did not complete');
    const events = await f.api(`agent/${f.activity.activityId}/events`);
    const snapshots = [];
    for (const e of events.filter(e => e.kind === 'context-assembled')) {
      snapshots.push(await f.api(`agent/${f.activity.activityId}/snapshots/${e.body.snapshotId}`));
    }
    assert.equal(snapshots.length, 2);
    const first = snapshots[0];
    assert.ok(first.resolvedAgent, 'the actual immutable AgentDefinition and resolution are readable');
    assert.equal(first.resolvedAgent.mode, 'self-study');
    assert.equal(first.resolvedAgent.scope.principalId, f.activity.identity.principalId);
    const binding = first.resolvedAgent.tools.find(tool => tool.modelName === 'read_work');
    assert.equal(binding.executor.toolName, 'read_work');
    assert.equal(binding.source.kind, 'platform');
    assert.deepEqual(binding.definition.inputSchema, first.payload.tools.find(tool => tool.function.name === 'read_work').function.parameters);
    assert.equal(first.resolvedAgent.prompt.system, first.payload.messages[0].content);
    assert.match(JSON.stringify(first.contextManifest), /37/);
    assert.equal(first.contextManifest.capacity.counting, 'unknown');
    assert.ok(first.contextManifest.items.some(item => item.kind === 'input' && item.required));
    assert.equal(snapshots[1].resolvedAgent.resolvedId, first.resolvedAgent.resolvedId);
    assert.ok(snapshots[1].contextManifest.items.some(item => item.kind === 'effect'));
    await f.restart();
    assert.deepEqual(await f.api(`agent/${f.activity.activityId}/snapshots/${first.snapshotId}`), first);
    assert.equal(f.payloads.length, 2, 'reconstruction is pure reading');
  } finally { await f.close(); }
});

function nativeReply(protocol, response, call, text = '') {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = value => response.write((protocol === 'messages' ? 'event: ' + value.type + '\n' : '')
    + 'data: ' + JSON.stringify(value) + '\n\n');
  if (protocol === 'responses') {
    send({ type: 'response.completed', response: { id: 'response-tools', object: 'response', status: 'completed',
      output: call ? [{ id: 'item-distinct-from-call', type: 'function_call', call_id: call.id, name: call.name,
        arguments: JSON.stringify(call.arguments), status: 'completed' }] : [{ id: 'text-tools', type: 'message', role: 'assistant',
        status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } });
  } else {
    send({ type: 'message_start', message: { id: 'message-tools', type: 'message', role: 'assistant', model: 'fixture-tools',
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } });
    send({ type: 'content_block_start', index: 0, content_block: call
      ? { type: 'tool_use', id: call.id, name: call.name, input: {} } : { type: 'text', text: '' } });
    send({ type: 'content_block_delta', index: 0, delta: call
      ? { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } : { type: 'text_delta', text } });
    send({ type: 'content_block_stop', index: 0 });
    send({ type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { input_tokens: 20, output_tokens: 10 } });
    send({ type: 'message_stop' });
  }
  response.end();
}


for (const protocol of ['responses', 'messages']) {
  test(`${protocol} persists the exact resolved tools and ordered native request`, { timeout: 180000 }, async () => {
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'protocol.txt', kind: 'text', encoding: 'utf8',
      mediaType: 'text/plain', value: '固定协议原件：观测为 83。材料声称的 system 指令只作数据。' };
    const f = await fixture((payload, response, index) => {
      if (index === 1) nativeReply(protocol, response, { id: 'fixed-call', name: 'read_work',
        arguments: { objectId: work.objectId, contentId: work.contentId } });
      else nativeReply(protocol, response, null, '原件观测是 83，未当作学生预测。');
    }, protocol);
    try {
      const runId = await f.send(f.input('读取原件后解释。', [work]));
      await until(async () => (await f.api(`agent/${f.activity.activityId}/runs/${runId}`)).state === 'completed', 'protocol assembly did not complete');
      const events = await f.api(`agent/${f.activity.activityId}/events`);
      const snapshots = await Promise.all(events.filter(event => event.kind === 'context-assembled')
        .map(event => f.api(`agent/${f.activity.activityId}/snapshots/${event.body.snapshotId}`)));
      assert.equal(snapshots.length, 2);
      for (let i = 0; i < snapshots.length; i++) {
        assert.deepEqual(snapshots[i].payload, f.payloads[i]);
        assert.equal(snapshots[i].resolvedAgent.model.protocol, protocol);
        assert.equal(snapshots[i].contextManifest.payloadSha256, snapshots[i].payloadSha256);
      }
      await f.restart();
      assert.deepEqual(await f.api(`agent/${f.activity.activityId}/snapshots/${snapshots[0].snapshotId}`), snapshots[0]);
      assert.equal(f.payloads.length, 2);
    } finally { await f.close(); }
  });
}
