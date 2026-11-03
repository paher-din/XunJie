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
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    events.push({ type: 'content_block_start', index, content_block: block.type === 'thinking' ? { ...block, thinking: '', signature: block.signature ? null : block.signature }
      : block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '' } });
    if (block.type === 'thinking') {
      events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      if (block.signature !== null) for (const signature of [block.signature.slice(0, 3), block.signature.slice(3)])
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
    let events = nativeEvents(received.length === 1 ? content : [{ type: 'thinking', thinking: '', signature: received.length === 3 ? null : '' }, { type: 'text', text: 'nonce-X' }], received.length === 1 ? 'tool_use' : 'end_turn');
    if (received.length === 1) {
      const eventsOf = index => events.filter(event => event.index === index);
      const a = eventsOf(2), b = eventsOf(3);
      events = [...events.filter(event => event.index === undefined && event.type === 'message_start' || event.index < 2),
        a[0], b[0], b[1], a[1], b[2], b[3], a[2], a[3], ...events.slice(-2)];
    }
    const bytes = Buffer.from(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''));
    const split = Math.max(1, bytes.indexOf(Buffer.from('中文')) + 1);
    response.write(bytes.subarray(0, split)); await new Promise(done => setTimeout(done, 5)); response.end(bytes.subarray(split));
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
    await restart(); assert.equal((await finish(call(id, 3))).state, 'completed');
    assert.deepEqual(received[3].messages.filter(message => message.role === 'assistant')[2].content[0], { type: 'thinking', thinking: '', signature: null });
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
    { name: 'multiple trailing slashes must not hide an existing v1', overrides: { baseUrl: 'http://127.0.0.1:12345/anthropic/v1///' } },
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
test('Messages cancellation timeout and transport loss keep terminal and partial facts without retries', { timeout: 180000 }, async () => {
  let requests = 0, sawRequest;
  let reached = new Promise(resolve => { sawRequest = resolve; });
  await product(async (request, response) => {
    requests++; const parts = []; for await (const chunk of request) parts.push(chunk);
    const payload = JSON.parse(Buffer.concat(parts));
    if (payload.system === 'HTTP failure') { response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"type":"error","error":{"type":"overloaded_error","message":"synthetic"}}'); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = nativeEvents([{ type: 'text', text: '保留部分中文' }], 'end_turn');
    if (payload.system === 'completed reset') { for (const event of events) send(response, event); setTimeout(() => response.destroy(), 30); return; }
    for (const event of events.slice(0, 3)) send(response, event);
    sawRequest();
  }, async ({ api, source, wait }) => {
    async function start(system, timeoutMs = 10000) {
      const segmentId = randomUUID();
      assert.equal((await api('segments', { requestId: randomUUID(), segmentId, source, prefix: { system, tools: [] }, portable: [] })).status, 200);
      const input = call(segmentId); input.limits = { maxOutputTokens: 512, timeoutMs };
      assert.equal((await api('calls', input)).status, 200); assert.equal((await api(`calls/${input.attemptId}/dispatch`, {})).status, 200); return input;
    }
    const cancel = await start('wait'); await reached;
    assert.equal((await api('calls/' + cancel.attemptId + '/cancel', {})).status, 200);
    const cancelled = await wait(cancel.attemptId);
    assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.cancelRequested, true);
    assert.equal(cancelled.text, '保留部分中文'); assert.equal(cancelled.usage.state, 'partial'); assert.deepEqual(cancelled.toolIntents, []);
    const timeout = await wait((await start('timeout', 500)).attemptId);
    assert.equal(timeout.physicalRequestEnded, true); assert.notEqual(timeout.state, 'completed'); assert.equal(timeout.text, '保留部分中文');
    const complete = await wait((await start('completed reset')).attemptId);
    assert.equal(complete.state, 'completed'); assert.equal(complete.text, '保留部分中文');
    const failedInput = await start('HTTP failure'), failed = await wait(failedInput.attemptId);
    assert.equal(failed.state, 'failed'); assert.equal(failed.reason, 'upstream-http');
    assert.equal((await api('calls/' + failed.attemptId + '/dispatch', {})).status, 200);
    assert.equal(requests, 4);
  });
});
test('Messages application validation and explicit output constraints do not become native strict claims', { timeout: 180000 }, async () => {
  let requests = 0;
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  await product(async (request, response) => {
    const parts = []; for await (const chunk of request) parts.push(chunk); const payload = JSON.parse(Buffer.concat(parts)); requests++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const text = payload.system === 'invalid' ? 'not-json' : '{"ok":true}';
    for (const event of nativeEvents([{ type: 'text', text }], 'end_turn')) send(response, event); response.end();
  }, async ({ api, source, finish }) => {
    const good = await finish(call(await segment(api, source, [], { applicationSchema: schema })));
    assert.equal(good.state, 'completed');
    const segmentId = randomUUID();
    assert.equal((await api('segments', { requestId: randomUUID(), segmentId, source, prefix: { system: 'invalid', tools: [], options: { applicationSchema: schema } }, portable: [] })).status, 200);
    const bad = await finish(call(segmentId)); assert.equal(bad.state, 'failed'); assert.equal(bad.reason, 'invalid-structured-output');
    for (const [options, capability, status] of [
      [{ responseFormat: { kind: 'json-schema', name: 'strict', schema, strict: true } }, 'nativeStrict', 'unknown'],
      [{ responseFormat: { kind: 'json-schema', name: 'not-an-implicit-local-fallback', schema, strict: false } }, 'nativeStrict', 'unknown'],
      [{ responseFormat: { kind: 'json-object' }, capabilityProbe: true }, 'jsonMode', 'unsupported'],
    ]) {
      const rejected = await api('segments', { requestId: randomUUID(), segmentId: randomUUID(), source, prefix: { system: '', tools: [], options }, portable: [] });
      assert.equal(rejected.status, 422); assert.equal(rejected.value.error, 'capability-unavailable');
      assert.deepEqual(rejected.value.decision.missing.map(item => [item.capability, item.status]), [[capability, status]]);
    }
    assert.equal(requests, 2);
  });
});
test('Messages native blocks pending tools and fixed images survive real backup restore and strict takeover', { timeout: 180000 }, async () => {
  const received = [], content = [{ type: 'thinking', thinking: 'PRIVATE-restored-thinking', signature: 'PRIVATE-restored-signature' },
    { type: 'tool_use', id: 'restore-tool', name: 'read_marker', input: { nonce: 'A' } }];
  await product(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); received.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of nativeEvents(received.length === 1 ? content : [{ type: 'text', text: '恢复完成' }], received.length === 1 ? 'tool_use' : 'end_turn')) send(response, event);
    response.end();
  }, async ({ api, runtime, root, source, finish }) => {
    const imageId = randomUUID(), image = { imageId, version: 1 };
    assert.equal((await api('images', { requestId: randomUUID(), imageId, mediaType: 'image/png', dataBase64: png })).status, 200);
    const id = await segment(api, source, [markerTool]), input = call(id); input.input.images = [image];
    const first = await finish(input); assert.equal(first.state, 'completed'); assert.equal(first.toolIntents[0].callId, 'restore-tool');
    const directory = await mkdtemp(join(tmpdir(), 'xj-messages-recovery-')), key = randomBytes(32);
    let targetRuntime;
    try {
      await runtime.setCredential('messages-recovery', key.toString('base64'));
      const backup = await runtime.recovery.backup({ directory, recoveryKeyRef: 'messages-recovery', leaveClosed: true });
      const targetRoot = join(directory, 'target');
      const restored = await restoreProductRecovery({ root: targetRoot, resources, backupDirectory: join(directory, backup.backupId), key });
      try { assert.ok(restored.owners.length); } finally { for (const owner of restored.owners) await owner.close?.(); }
      targetRuntime = openProductRuntime({ root: targetRoot, resources }); const state = await targetRuntime.start(); assert.equal(state.state, 'maintenance');
      const targetApi = async (path, body) => {
        const response = await fetch(state.endpoint + '/api/learning/models/' + path, { headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
          ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }); return { status: response.status, value: await response.json() };
      };
      const next = call(id, 1); next.input.toolResults = [{ callId: 'restore-tool', outcome: 'not-executed', text: '调用方明确未执行', images: [image] }];
      assert.equal((await targetApi('calls', next)).status, 503); assert.equal(received.length, 1);
      assert.equal((await targetRuntime.recovery.takeover({ sourceRoot: root, receivers: [] })).phase, 'active');
      assert.equal((await targetApi('calls/' + first.attemptId)).value.resultRef, first.resultRef);
      assert.equal((await targetApi('segments/' + id)).value.pendingTools[0].callId, 'restore-tool');
      assert.equal((await targetApi('calls', next)).status, 200); assert.equal((await targetApi('calls/' + next.attemptId + '/dispatch', {})).status, 200);
      let final;
      for (let count = 0; count < 200; count++) { final = await targetApi('calls/' + next.attemptId); if (final.value.physicalRequestEnded) break; await new Promise(done => setTimeout(done, 20)); }
      assert.equal(final.value.state, 'completed'); assert.deepEqual(received[1].messages[1], { role: 'assistant', content });
      assert.equal(received[1].messages[0].content[1].source.data, png); assert.equal(received[1].messages[2].content[0].content[1].source.data, png);
      assert.equal(received[1].messages[2].content[0].is_error, true); assert.equal(JSON.stringify(final.value).includes('PRIVATE-'), false);
      await runtime.stop(); await assert.rejects(runtime.start(), error => error.code === 'source-retired'); assert.equal(received.length, 2);
    } finally { if (targetRuntime) await targetRuntime.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
});
test('Messages crosses Chat and Responses only at settled boundaries using visible portable facts', { timeout: 180000 }, async t => {
  for (const protocol of ['chat-completions', 'responses']) await t.test(protocol, async () => {
    const received = []; let messageCalls = 0;
    await product(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks)); received.push(payload);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (request.url.endsWith('/v1/messages')) {
        messageCalls++;
        for (const event of nativeEvents(messageCalls === 1 ? [
          { type: 'thinking', thinking: 'PRIVATE-source-thinking', signature: 'PRIVATE-source-signature' },
          { type: 'tool_use', id: 'message-private-tool', name: 'read_marker', input: { nonce: 'A' } },
        ] : [{ type: 'text', text: '新段完成' }], messageCalls === 1 ? 'tool_use' : 'end_turn')) send(response, event);
      } else if (protocol === 'chat-completions') response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'PRIVATE-chat-reason',
        tool_calls: [{ index: 0, id: 'foreign-private-tool', type: 'function', function: { name: 'read_marker', arguments: '{"nonce":"A"}' } }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
      else response.write('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'foreign-private-response', object: 'response', status: 'completed',
        output: [{ type: 'function_call', id: 'foreign-private-item', call_id: 'foreign-private-tool', name: 'read_marker', arguments: '{"nonce":"A"}', status: 'completed' }] } }) + '\n\n');
      response.end();
    }, async ({ api, source, finish, configuration }) => {
      const original = await segment(api, source, [markerTool]); const first = await finish(call(original)); assert.equal(first.state, 'completed');
      const otherId = randomUUID(), saved = await api('connections', { ...configuration, requestId: randomUUID(), connectionId: otherId, expectedVersion: 0, name: 'other route', protocol,
        path: protocol === 'responses' ? '/responses' : '/chat/completions', credential: { action: 'replace', value: 'synthetic-other-key' } }); assert.equal(saved.status, 200);
      const bridge = (previousSegmentId, nextSource, resultRef) => ({ requestId: randomUUID(), segmentId: randomUUID(), source: nextSource,
        previousSegmentId, prefix: { system: '新段系统', tools: [markerTool] }, portable: [{ text: '获准移植问题和可见结果', resultRef }] });
      const nextSource = { connectionId: otherId, version: 1 };
      assert.equal((await api('segments', bridge(original, nextSource, first.resultRef))).status, 409);
      assert.equal((await api('segments/' + original + '/tool-results', { requestId: randomUUID(), expectedSequence: 1,
        results: [{ callId: 'message-private-tool', outcome: 'not-executed', text: '调用方明确未执行', images: [] }] })).status, 200);
      const other = await api('segments', bridge(original, nextSource, first.resultRef)); assert.equal(other.status, 200);
      const second = await finish(call(other.value.segmentId)); assert.equal(second.state, 'completed');
      assert.equal(JSON.stringify(received[1]).includes('PRIVATE-source'), false); assert.equal(JSON.stringify(received[1]).includes('message-private-tool'), false);
      assert.equal((await api('segments', bridge(other.value.segmentId, source, second.resultRef))).status, 409);
      assert.equal((await api('segments/' + other.value.segmentId + '/tool-results', { requestId: randomUUID(), expectedSequence: 1,
        results: [{ callId: 'foreign-private-tool', outcome: 'error', text: '调用方错误', images: [] }] })).status, 200);
      const next = await api('segments', bridge(other.value.segmentId, source, second.resultRef)); assert.equal(next.status, 200);
      const third = await finish(call(next.value.segmentId)); assert.equal(third.state, 'completed');
      assert.equal(JSON.stringify(received[2]).includes('foreign-private'), false); assert.equal(JSON.stringify(received[2]).includes('PRIVATE-chat'), false);
      assert.equal(JSON.stringify(received[2]).includes('获准移植问题和可见结果'), true);
      assert.equal((await api('calls', call(original, 1))).status, 409); assert.equal(received.length, 3);
    });
  });
});
test('Messages image limits count native image blocks rather than ordinary tool argument metadata', { timeout: 180000 }, async () => {
  let requests = 0;
  const metadata = Array.from({ length: 9 }, () => ({ type: 'image', description: 'ordinary tool data' }));
  const tool = { name: 'read_metadata', description: '', inputSchema: { type: 'object', properties: { metadata: { type: 'array', items: { type: 'object' } } }, required: ['metadata'] } };
  await product((_request, response) => {
    requests++; response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of nativeEvents(requests === 1 ? [{ type: 'tool_use', id: 'metadata-tool', name: tool.name, input: { metadata } }] : [{ type: 'text', text: 'done' }], requests === 1 ? 'tool_use' : 'end_turn')) send(response, event);
    response.end();
  }, async ({ api, source, finish }) => {
    const id = await segment(api, source, [tool]); assert.equal((await finish(call(id))).state, 'completed');
    const next = call(id, 1); next.input.toolResults = [{ callId: 'metadata-tool', outcome: 'success', text: 'metadata read', images: [] }];
    assert.equal((await finish(next)).state, 'completed'); assert.equal(requests, 2);
  });
});
test('Messages still rejects a history beyond eight actual fixed images before send', { timeout: 180000 }, async () => {
  let requests = 0;
  await product((_request, response) => { requests++; answer(response); }, async ({ api, source, finish }) => {
    const imageId = randomUUID(), image = { imageId, version: 1 };
    assert.equal((await api('images', { requestId: randomUUID(), imageId, mediaType: 'image/png', dataBase64: png })).status, 200);
    const id = await segment(api, source);
    for (let sequence = 0; sequence < 4; sequence++) { const input = call(id, sequence); input.input.images = [image, image]; assert.equal((await finish(input)).state, 'completed'); }
    const excessive = call(id, 4); excessive.input.images = [image, image]; assert.equal((await api('calls', excessive)).status, 400); assert.equal(requests, 4);
  });
});
test('Messages credentials echoed as split escaped arguments or text never become consumable', { timeout: 180000 }, async () => {
  const secret = 'synthetic-messages-credential-private'; let requests = 0;
  await product((_request, response) => {
    requests++; response.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = nativeEvents(requests === 1 ? [{ type: 'tool_use', id: 'sensitive-tool', name: 'read_marker', input: { nonce: secret } }]
      : [{ type: 'text', text: secret }], requests === 1 ? 'tool_use' : 'end_turn');
    if (requests === 1) {
      const encoded = '{"nonce":"' + [...secret].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"}';
      let part = 0; for (const event of events) if (event.delta?.type === 'input_json_delta') event.delta.partial_json = part++ === 0 ? encoded.slice(0, 25) : encoded.slice(25);
    }
    for (const event of events) send(response, event); response.end();
  }, async ({ api, source, finish }) => {
    for (let index = 0; index < 2; index++) {
      const id = await segment(api, source, [markerTool]), result = await finish(call(id));
      assert.equal(result.state, 'failed'); assert.deepEqual(result.toolIntents, []); assert.equal(JSON.stringify(result).includes(secret), false);
      assert.equal((await api('calls', call(id, 1))).status, 409);
    }
    assert.equal(requests, 2);
  }, {}, secret);
});
test('Messages capability evidence belongs to the exact route mode SDK and real endpoint', { timeout: 180000 }, async () => {
  await product((_request, response) => { response.writeHead(500); response.end(); }, async ({ api, configuration }) => {
    let version = 1;
    const save = async change => {
      const result = await api('connections', { ...configuration, name: 'Arbitrary display name', baseUrl: 'https://api.deepseek.com/anthropic', ...change,
        requestId: randomUUID(), expectedVersion: version, credential: { action: 'replace', value: 'synthetic-capability-only' } });
      assert.equal(result.status, 200); version = result.value.version; return result.value;
    };
    const thinking = await save({});
    assert.equal(thinking.capabilities.nativeReplay, 'verified'); assert.equal(thinking.capabilities.images, 'verified');
    assert.equal(thinking.capabilityEvidence.sdk, '@anthropic-ai/sdk@1.1.0'); assert.equal(thinking.capabilityEvidence.toolImageStrategy, 'native-tool-result-image');
    const plain = await save({ parameterMode: 'plain' });
    assert.equal(plain.capabilities.images, 'unknown'); assert.equal(plain.capabilities.strictSchema, 'unsupported'); assert.equal(plain.capabilities.strictTools, 'unsupported');
    const unknown = await save({ baseUrl: 'https://synthetic.invalid/anthropic' }); assert.equal(unknown.capabilities.nativeReplay, 'unknown');
    assert.equal(unknown.capabilityEvidence, undefined);
    const rejected = await api('segments', { requestId: randomUUID(), segmentId: randomUUID(), source: { connectionId: configuration.connectionId, version },
      prefix: { system: '', tools: [], options: { requiredCapabilities: ['nativeReplay'] } }, portable: [] });
    assert.equal(rejected.status, 422); assert.equal(rejected.value.error, 'capability-unavailable');
    assert.deepEqual(rejected.value.decision.missing.map(item => [item.capability, item.status]), [['nativeReplay', 'unknown']]);
  });
});
test('Messages errors retain safe upstream status request identity and retry timing after restart', { timeout: 180000 }, async () => {
  let requests = 0;
  await product((_request, response) => {
    requests++;
    response.writeHead(requests === 1 ? 429 : 503, { 'content-type': 'application/json',
      'request-id': requests === 1 ? 'req-messages-rate-limit' : 'synthetic-messages-key',
      'retry-after': requests === 1 ? '7' : 'Wed, 04 Nov 2026 00:00:00 GMT',
      'set-cookie': 'private-header-must-not-be-projected', 'x-internal-secret': 'private-error-header' });
    response.end('{"type":"error","error":{"type":"rate_limit_error","message":"synthetic private upstream body"}}');
  }, async ({ api, source, finish, restart }) => {
    const first = await finish(call(await segment(api, source)));
    assert.equal(first.state, 'failed'); assert.equal(first.reason, 'rate-limited');
    assert.deepEqual(first.upstream, { httpStatus: 429, requestId: 'req-messages-rate-limit', retryAfterSeconds: 7 });
    assert.equal(JSON.stringify(first).includes('private-'), false);
    await restart(); const after = (await api('calls/' + first.attemptId)).value;
    assert.deepEqual(after.upstream, first.upstream); assert.equal(after.resultRef, first.resultRef);
    assert.equal((await api('calls/' + first.attemptId + '/dispatch', {})).status, 200); assert.equal(requests, 1);
    const second = await finish(call(await segment(api, source)));
    assert.equal(second.state, 'failed'); assert.equal(second.reason, 'upstream-http');
    assert.deepEqual(second.upstream, { httpStatus: 503, retryAt: '2026-11-04T00:00:00.000Z' });
    assert.equal(JSON.stringify(second).includes('synthetic-messages-key'), false); assert.equal(requests, 2);
  });
});
test('Messages transport loss before response headers remains unknown and cannot implicitly resend', { timeout: 180000 }, async () => {
  let requests = 0;
  await product((request, _response) => { requests++; request.socket.destroy(); }, async ({ api, source, finish, restart }) => {
    const first = await finish(call(await segment(api, source)));
    assert.equal(first.state, 'unknown'); assert.equal(first.reason, 'upstream-stream'); assert.equal(first.upstream, undefined);
    assert.equal(first.usage.state, 'unknown'); assert.deepEqual(first.toolIntents, []);
    await restart(); assert.equal((await api('calls/' + first.attemptId)).value.resultRef, first.resultRef);
    assert.equal((await api('calls/' + first.attemptId + '/dispatch', {})).status, 200); assert.equal(requests, 1);
  });
});
