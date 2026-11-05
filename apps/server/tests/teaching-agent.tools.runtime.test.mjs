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
      await rm(root, { recursive: true, force: true });
    } };
}

test('Agent reads the granted immutable work through a real tool and continues the native call pair', { timeout: 180000 }, async () => {
  const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'reason.txt', kind: 'text', encoding: 'utf8',
    mediaType: 'text/plain', value: '固定作品：总数为 37，先解释其来源。' };
  const f = await fixture((payload, response, index) => {
    if (index === 1) chat(response, { call: { id: 'read-original-work', name: 'read_work',
      arguments: { objectId: work.objectId, contentId: work.contentId } } });
    else {
      const result = payload.messages.find(message => message.role === 'tool');
      assert.equal(result?.tool_call_id, 'read-original-work');
      assert.match(result.content, /37/);
      assert.doesNotMatch(result.content, /999/);
      chat(response, { text: '依据固定作品中的 37 解释；后续编辑属于另一个版本。' });
    }
  });
  try {
    const runId = await f.send(f.input('请读取原作品，再解释数字。', [work]));
    await f.api(`workspaces/${f.activity.activityId}`, { requestId: randomUUID(), baseRevision: 0,
      files: [{ ...work, contentId: randomUUID(), value: '后续编辑：总数为 999。' }] });
    const conversation = await until(async () => {
      const value = await f.api(`agent/${f.activity.activityId}/conversation`);
      const run = value.runs.find(run => run.runId === runId);
      if (run && ['failed', 'paused', 'stopped'].includes(run.state)) throw new Error('Run did not complete: ' + JSON.stringify(value)
        + '\n' + await readFile(join(f.root, 'logs', 'runtime.log'), 'utf8'));
      return value.runs.find(run => run.runId === runId)?.state === 'completed' ? value : null;
    }, 'The Agent did not finish a real read and native tool continuation.');
    assert.equal(f.payloads.length, 2);
    assert.ok(f.payloads[0].tools.some(tool => tool.function.name === 'read_work'));
    assert.equal(conversation.tools.length, 1);
    assert.equal(conversation.tools[0].outcome, 'completed');
    assert.deepEqual(conversation.runs.find(run => run.runId === runId).usage,
      { state: 'final', inputTokens: 40, outputTokens: 20, totalTokens: 60 });
    assert.match(JSON.stringify(conversation.tools[0].result), /37/);
    const events = await f.api(`agent/${f.activity.activityId}/events`);
    assert.equal(events.filter(event => event.kind === 'tool-intent').length, 1);
    assert.equal(events.filter(event => event.kind === 'tools-paired').length, 1);
    const snapshotEvents = events.filter(event => event.kind === 'context-assembled');
    assert.equal(snapshotEvents.length, 2);
    for (const event of snapshotEvents) {
      const snapshot = await f.api(`agent/${f.activity.activityId}/snapshots/${event.body.snapshotId}`);
      assert.ok(snapshot.payload.tools.some(tool => tool.function.name === 'read_work'));
    }
    await f.restart();
    const reloaded = await f.api(`agent/${f.activity.activityId}/conversation`);
    assert.deepEqual(reloaded.tools, conversation.tools);
    assert.equal(f.payloads.length, 2, 'history and restart do not repeat the model or tool');
    const directory = await mkdtemp(join(tmpdir(), 'xj-tool-recovery-'));
    let target;
    try {
      const key = randomBytes(32);
      await f.runtime.setCredential('tool-recovery', key.toString('base64'));
      const backup = await f.runtime.recovery.backup({ directory, recoveryKeyRef: 'tool-recovery', leaveClosed: true });
      const targetRoot = join(directory, 'target');
      const restored = await restoreProductRecovery({ root: targetRoot, resources: f.resources,
        backupDirectory: join(directory, backup.backupId), key });
      for (const owner of restored.owners) await owner.close?.();
      target = openProductRuntime({ root: targetRoot, resources: f.resources });
      const state = await target.start();
      assert.equal(state.state, 'maintenance');
      assert.equal((await target.recovery.takeover({ sourceRoot: f.root, receivers: [] })).phase, 'active');
      const response = await fetch(new URL(`/api/learning/agent/${f.activity.activityId}/conversation`, state.endpoint),
        { headers: { 'x-xj-space': 'personal' } });
      assert.equal(response.status, 200);
      const recovered = await response.json();
      assert.deepEqual(recovered.tools, reloaded.tools);
      assert.deepEqual(recovered.runs.map(run => run.usage), reloaded.runs.map(run => run.usage));
      assert.equal(f.payloads.length, 2, 'isolated restore and takeover read the original tool resources');
    } finally { await target?.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
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
  test(`${protocol} continues the same native tool pair with the real fixed source`, { timeout: 180000 }, async () => {
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'native.txt', kind: 'text', encoding: 'utf8',
      mediaType: 'text/plain', value: '协议独立的真实资料，观测值为 83。' };
    const f = await fixture((payload, response, index) => {
      if (index === 1) nativeReply(protocol, response, { id: 'native-source-call', name: 'read_work',
        arguments: { objectId: work.objectId, contentId: work.contentId } });
      else {
        const pair = protocol === 'responses' ? payload.input.find(item => item.type === 'function_call_output')
          : payload.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(item => item.type === 'tool_result');
        assert.equal(protocol === 'responses' ? pair.call_id : pair.tool_use_id, 'native-source-call');
        assert.match(JSON.stringify(pair), /83/);
        nativeReply(protocol, response, null, '真实资料中记录的是 83。');
      }
    }, protocol);
    try {
      const runId = await f.send(f.input('用工具读资料，再解释其中的观测值。', [work]));
      const result = await until(async () => {
        const value = await f.api(`agent/${f.activity.activityId}/conversation`);
        const run = value.runs.find(run => run.runId === runId);
        if (['failed', 'paused'].includes(run?.state)) throw new Error(JSON.stringify(value));
        return run?.state === 'completed' ? value : null;
      }, protocol + ' did not complete the real source tool roundtrip');
      assert.equal(result.tools[0].outcome, 'completed');
      assert.equal(result.tools[0].callId, 'native-source-call');
      assert.equal(f.payloads.length, 2);
    } finally { await f.close(); }
  });
}

for (const failure of ['truncated', 'invalid-arguments', 'missing-terminal']) {
  test(`${failure} model output cannot dispatch a tool`, { timeout: 180000 }, async () => {
    const f = await fixture((_payload, response) => {
      const call = { id: 'unconsumable-call', name: 'read_work', arguments: failure === 'invalid-arguments'
        ? { arbitrary: 'not-the-tool-schema' } : { objectId: randomUUID(), contentId: randomUUID() } };
      if (failure !== 'missing-terminal') chat(response, { call, finish: failure === 'truncated' ? 'length' : 'tool_calls' });
      else {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: ' + JSON.stringify({ id: 'no-terminal', choices: [{ index: 0, delta: { role: 'assistant',
          tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] },
          finish_reason: null }] }) + '\n\n');
        response.end('data: [DONE]\n\n');
      }
    });
    try {
      const runId = await f.send(f.input('不能执行不完整结果。'));
      const result = await until(async () => {
        const value = await f.api(`agent/${f.activity.activityId}/conversation`);
        return ['failed', 'paused'].includes(value.runs.find(run => run.runId === runId)?.state) ? value : null;
      }, 'Unconsumable output did not settle');
      assert.equal(result.tools.length, 0);
      assert.equal((await f.api(`agent/${f.activity.activityId}/events`)).filter(event => event.kind === 'tool-permitted').length, 0);
      assert.equal(f.payloads.length, 1);
    } finally { await f.close(); }
  });
}

test('a valid native call cannot read an unapproved work from another activity', { timeout: 180000 }, async () => {
  const foreign = { objectId: randomUUID(), contentId: randomUUID(), name: 'other.txt', kind: 'text', encoding: 'utf8',
    mediaType: 'text/plain', value: 'foreign-activity-private-canary-198' };
  const f = await fixture((payload, response, index) => {
    if (index === 1) chat(response, { call: { id: 'unapproved-source', name: 'read_work',
      arguments: { objectId: foreign.objectId, contentId: foreign.contentId } } });
    else {
      const result = payload.messages.find(message => message.role === 'tool');
      assert.match(result.content, /not-executed|forbidden/);
      assert.doesNotMatch(result.content, /foreign-activity-private-canary/);
      chat(response, { text: '这份来源未获本次授权，请在当前活动中明确引用需要讨论的内容。' });
    }
  });
  try {
    const other = await f.api('activities', { requestId: randomUUID(), goal: '另一个活动的作品', question: '', references: [] });
    await f.api('workspaces/' + other.activityId, { requestId: randomUUID(), baseRevision: 0, files: [foreign] });
    const runId = await f.send(f.input('只能读取本次获准来源。'));
    const result = await until(async () => {
      const value = await f.api(`agent/${f.activity.activityId}/conversation`);
      return value.runs.find(run => run.runId === runId)?.state === 'completed' ? value : null;
    }, 'Unapproved source was not paired as not-executed');
    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0].outcome, 'not-dispatched');
    assert.equal((await f.api(`agent/${f.activity.activityId}/events`)).filter(event => event.kind === 'tool-permitted').length, 0);
    assert.doesNotMatch(JSON.stringify(result.tools), /foreign-activity-private-canary/);
  } finally { await f.close(); }
});

test('an unsupported fixed binary source reports unavailable without an unknown-effect Wait', { timeout: 180000 }, async () => {
  const file = { objectId: randomUUID(), contentId: randomUUID(), name: 'attachment.pdf', kind: 'resource', encoding: 'base64',
    mediaType: 'application/pdf', value: Buffer.from('fixed binary source without a PDF reader').toString('base64') };
  const f = await fixture((payload, response, index) => {
    if (index === 1) chat(response, { call: { id: 'unsupported-source', name: 'read_work',
      arguments: { objectId: file.objectId, contentId: file.contentId } } });
    else {
      assert.match(payload.messages.find(message => message.role === 'tool').content, /unsupported-media-type/);
      chat(response, { text: '当前无法读取这份二进制材料，请引用可读文本。' });
    }
  });
  try {
    const runId = await f.send(f.input('读取这份已固定的资料。', [file]));
    const record = await until(async () => {
      const conversation = await f.api(`agent/${f.activity.activityId}/conversation`);
      return conversation.tools.find(tool => tool.outcome !== null);
    }, 'The source availability result was not recorded');
    assert.equal(record.outcome, 'failed');
    assert.equal(record.result.sourceState, 'unavailable');
    const result = await until(async () => {
      const conversation = await f.api(`agent/${f.activity.activityId}/conversation`);
      return conversation.runs.find(run => run.runId === runId)?.state === 'completed' ? conversation : null;
    }, 'The unavailable source did not close the native call');
    assert.deepEqual(result.waits, []);
    assert.equal(f.payloads.length, 2);
  } finally { await f.close(); }
});
