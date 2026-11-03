import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openProductRuntime, restoreProductRecovery } from '@xunjie/product-runtime';

const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN,
  webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
async function product(handler, run, overrides = {}, credential = 'synthetic-messages-key') {
  const upstream = createServer(handler);
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'xj-messages-'));
  const runtime = openProductRuntime({ root, resources });
  try {
    await runtime.install({ profile: 'local' }); let endpoint = (await runtime.start()).endpoint;
    const api = async (path, body) => {
      const response = await fetch(endpoint + '/api/learning/models/' + path, { headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const connectionId = randomUUID();
    const configuration = { connectionId, name: 'Messages fixture', protocol: 'messages',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/anthropic`, path: '/v1/messages', modelId: 'deepseek-flash',
      dialect: 'deepseek', parameterMode: 'thinking', enabled: true, ...overrides };
    const saved = await api('connections', { ...configuration, requestId: randomUUID(), expectedVersion: 0,
      credential: { action: 'replace', value: credential } });
    assert.equal(saved.status, 200);
    const wait = async (attemptId, route = 'calls') => {
      for (let count = 0; count < 200; count++) {
        const fact = await api(route + '/' + attemptId); assert.equal(fact.status, 200);
        if (fact.value.physicalRequestEnded) return fact.value;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Bounded Messages call did not finish');
    };
    const finish = async input => {
      const route = input.purpose === 'connection-check' ? 'checks' : 'calls';
      const accepted = await api(route, input); assert.equal(accepted.status, 200, JSON.stringify(accepted.value));
      assert.equal((await api(`${route}/${input.attemptId}/dispatch`, {})).status, 200);
      return wait(input.attemptId, route);
    };
    await run({ api, runtime, root, configuration, source: { connectionId, version: 1 }, saved: saved.value, finish, wait,
      async restart() { await runtime.stop(); endpoint = (await runtime.start()).endpoint; } });
  } finally {
    await runtime.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
const send = (response, value) => response.write('event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n');
function answer(response, text = 'Messages 检查正常') {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  send(response, { type: 'message_start', message: { id: 'msg-check', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
  send(response, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  send(response, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  send(response, { type: 'content_block_stop', index: 0 });
  send(response, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 7, output_tokens: 4 } });
  send(response, { type: 'message_stop' }); response.end();
}
test('formal Messages check uses the direct SDK at the exact path and retains the original attempt after restart', { timeout: 180000 }, async () => {
  const received = [];
  await product(async (request, response) => {
    const parts = []; for await (const chunk of request) parts.push(chunk);
    received.push({ url: request.url, payload: JSON.parse(Buffer.concat(parts)), version: request.headers['anthropic-version'] });
    answer(response);
  }, async ({ api, source, saved, finish, restart }) => {
    assert.equal(saved.adapterState, 'ready');
    const input = { attemptId: randomUUID(), purpose: 'connection-check', source, limits: { maxOutputTokens: 128, timeoutMs: 10000 } };
    const result = await finish(input);
    assert.equal(result.state, 'completed'); assert.equal(result.text, 'Messages 检查正常'); assert.ok(result.resultRef);
    assert.deepEqual(result.usage, { state: 'final', inputTokens: 7, outputTokens: 4 });
    assert.equal(received[0].url, '/anthropic/v1/messages'); assert.equal(received[0].version, '2023-06-01');
    assert.equal(received[0].payload.model, 'deepseek-flash'); assert.equal(received[0].payload.max_tokens, 128);
    assert.equal(received[0].payload.thinking.type, 'enabled');
    await restart(); assert.equal((await api('checks/' + input.attemptId)).value.resultRef, result.resultRef);
    assert.equal((await api('checks', input)).status, 200);
    assert.equal((await api('checks/' + input.attemptId + '/dispatch', {})).status, 200);
    assert.equal(received.length, 1);
  });
});
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const limits = { maxOutputTokens: 512, timeoutMs: 10000 };
const markerTool = { name: 'read_marker', description: '无副作用工具', inputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false } };
async function segment(api, source, tools = [], options = {}) {
  const segmentId = randomUUID();
  const response = await api('segments', { requestId: randomUUID(), segmentId, source,
    prefix: { system: '固定系统前缀', tools, options }, portable: [] });
  assert.equal(response.status, 200, JSON.stringify(response.value)); return segmentId;
}
const call = (segmentId, expectedSequence = 0) => ({ attemptId: randomUUID(), purpose: 'chat-probe', segmentId, expectedSequence,
  input: { text: '检查', images: [], toolResults: [] }, limits });
function nativeEvents(content, stop = 'tool_use') {
  const events = [{ type: 'message_start', message: { id: 'msg-native', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 } } }];
  content.forEach((block, index) => {
    events.push({ type: 'content_block_start', index, content_block: block.type === 'thinking' ? { ...block, thinking: '', signature: '' }
      : block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '' } });
    if (block.type === 'thinking') {
      events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      for (const signature of [block.signature?.slice(0, 3), block.signature?.slice(3)])
        events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } });
    } else if (block.type === 'tool_use') {
      const text = JSON.stringify(block.input);
      for (const partial_json of [text.slice(0, 9), text.slice(9)]) events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
    } else events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { input_tokens: 11, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, { type: 'message_stop' });
  return events;
}
test('native Messages thinking signatures multi-tools and fixed result images survive restart into exact next wire', { timeout: 180000 }, async () => {
  const received = [];
  const content = [{ type: 'thinking', thinking: 'PRIVATE-中文思考', signature: 'PRIVATE-signature-1' }, { type: 'text', text: '先读取' },
    { type: 'tool_use', id: 'tool-a', name: 'read_marker', input: { nonce: 'A' } },
    { type: 'tool_use', id: 'tool-b', name: 'read_marker', input: { nonce: 'B' } }];
  await product(async (request, response) => {
    const parts = []; for await (const chunk of request) parts.push(chunk); received.push(JSON.parse(Buffer.concat(parts)));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of nativeEvents(received.length === 1 ? content : [{ type: 'thinking', thinking: '', signature: '' }, { type: 'text', text: 'nonce-X' }], received.length === 1 ? 'tool_use' : 'end_turn')) send(response, event);
    response.end();
  }, async ({ api, source, finish, restart }) => {
    const imageId = randomUUID(), image = { imageId, version: 1 };
    assert.equal((await api('images', { requestId: randomUUID(), imageId, mediaType: 'image/png', dataBase64: png })).status, 200);
    const id = await segment(api, source, [markerTool]);
    const firstInput = call(id); firstInput.input.images = [image];
    const first = await finish(firstInput);
    assert.equal(first.state, 'completed');
    assert.deepEqual(first.toolIntents, [{ callId: 'tool-a', name: 'read_marker', arguments: { nonce: 'A' } }, { callId: 'tool-b', name: 'read_marker', arguments: { nonce: 'B' } }]);
    assert.equal(JSON.stringify(first).includes('PRIVATE-'), false);
    await restart(); assert.equal((await api('calls/' + first.attemptId)).value.resultRef, first.resultRef);
    const next = call(id, 1); next.input.toolResults = [
      { callId: 'tool-b', outcome: 'error', text: 'caller failure', images: [] },
      { callId: 'tool-a', outcome: 'success', text: 'nonce-X', images: [image] }];
    const second = await finish(next); assert.equal(second.state, 'completed');
    assert.equal(received[0].system, '固定系统前缀'); assert.deepEqual(received[0].tools[0].input_schema, markerTool.inputSchema);
    assert.deepEqual(received[1].messages[1], { role: 'assistant', content });
    assert.deepEqual(received[1].messages[2].content.slice(0, 2), [
      { type: 'tool_result', tool_use_id: 'tool-a', is_error: false, content: [{ type: 'text', text: 'nonce-X' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] },
      { type: 'tool_result', tool_use_id: 'tool-b', is_error: true, content: [{ type: 'text', text: '{"outcome":"error","text":"caller failure"}' }] }]);
    assert.equal(received[1].messages[0].content[1].source.data, png);
    await restart(); assert.equal((await finish(call(id, 2))).state, 'completed');
    assert.deepEqual(received[2].messages.filter(message => message.role === 'assistant')[1].content[0], { type: 'thinking', thinking: '', signature: '' });
  });
});
test('Messages only a complete understood message with valid tools is consumable', { timeout: 600000 }, async t => {
  const blocks = [{ type: 'text', text: '部分中文' }, { type: 'tool_use', id: 'tool-a', name: 'read_marker', input: { nonce: 'A' } }];
  const normal = nativeEvents(blocks);
  const fixtures = [
    { name: 'one block stopping is not the whole message', events: normal.slice(0, -2), state: 'incomplete' },
    { name: 'message delta without message_stop', events: normal.slice(0, -1), state: 'incomplete' },
    { name: 'length truncation', events: nativeEvents(blocks, 'max_tokens'), state: 'incomplete' },
    { name: 'refusal', events: nativeEvents([{ type: 'text', text: '拒绝' }], 'refusal'), state: 'failed' },
    { name: '200 then error event', events: [...normal.slice(0, -2), { type: 'error', error: { type: 'overloaded_error', message: 'synthetic' } }], state: 'failed' },
    { name: 'unknown signed block', events: [normal[0], { type: 'content_block_start', index: 0, content_block: { type: 'future_signed_block', data: 'retain' } }], state: 'failed' },
    { name: 'partial tool JSON', events: normal.map(event => event.delta?.type === 'input_json_delta' ? { ...event, delta: { type: 'input_json_delta', partial_json: '{' } } : event), state: 'failed' },
    { name: 'wrong schema', events: nativeEvents([{ ...blocks[1], input: { nonce: 3 } }]), state: 'failed' },
    { name: 'negative usage is malformed not an unknown persistence failure', events: normal.map(event => event.type === 'message_delta' ? { ...event, usage: { input_tokens: -1, output_tokens: 2 } } : event), state: 'failed' },
  ];
  for (const fixture of fixtures) await t.test(fixture.name, async () => {
    let requests = 0;
    await product((_request, response) => {
      requests++; response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of fixture.events) send(response, event); response.end();
    }, async ({ api, source, finish }) => {
      const result = await finish(call(await segment(api, source, [markerTool])));
      assert.equal(result.state, fixture.state); assert.deepEqual(result.toolIntents, []); assert.equal(requests, 1);
      if (fixture.name.includes('whole message')) assert.equal(result.text, '部分中文');
    });
  });
});
test('Messages rejects an unsupported target and duplicated v1 base before any network send', { timeout: 180000 }, async t => {
  for (const fixture of [
    { name: 'Command Code catalogue excludes this Messages model', overrides: { baseUrl: 'https://api.commandcode.ai/provider', modelId: 'deepseek/deepseek-v4.1-flash', dialect: 'command-code', parameterMode: 'plain' }, unsupported: true },
    { name: 'Messages base must not already end in v1', overrides: { baseUrl: 'http://127.0.0.1:12345/anthropic/v1' } },
  ]) await t.test(fixture.name, async () => {
    await product((_request, response) => { response.writeHead(500); response.end(); }, async ({ api, saved, source }) => {
      assert.equal(saved.adapterState, 'not-integrated');
      if (fixture.unsupported) { assert.equal(saved.capabilities.text, 'unsupported'); assert.equal(saved.capabilityEvidence.observedAt, '2026-11-03'); }
      const result = await api('checks', { attemptId: randomUUID(), purpose: 'connection-check', source, limits: { maxOutputTokens: 64, timeoutMs: 500 } });
      assert.equal(result.status, 503);
    }, fixture.overrides);
  });
});
test('Messages cumulative final usage replaces initial counters and missing fields stay unknown', { timeout: 180000 }, async () => {
  const samples = [
    { usage: { input_tokens: 11, output_tokens: 5, cache_read_input_tokens: 0 }, expected: { state: 'final', inputTokens: 11, outputTokens: 5, cachedTokens: 0 } },
    { usage: { output_tokens: 4 }, expected: { state: 'partial', outputTokens: 4 } },
    { usage: {}, expected: { state: 'unknown' } },
    { usage: { input_tokens: 0, output_tokens: 0 }, expected: { state: 'final', inputTokens: 0, outputTokens: 0 } },
  ];
  let requests = 0;
  await product((_request, response) => {
    const sample = samples[requests++]; response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of nativeEvents([{ type: 'text', text: 'usage' }], 'end_turn')) send(response,
      event.type === 'message_delta' ? { ...event, usage: sample.usage } : event);
    response.end();
  }, async ({ api, source, finish }) => {
    for (const sample of samples) {
      const result = await finish(call(await segment(api, source)));
      assert.equal(result.state, 'completed'); assert.deepEqual(result.usage, sample.expected);
    }
    assert.equal(requests, 4);
  });
});
