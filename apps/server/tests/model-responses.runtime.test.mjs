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
async function product(handler, run, overrides = {}, credential = 'synthetic-responses-key') {
  const upstream = createServer(handler);
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'xj-responses-'));
  const runtime = openProductRuntime({ root, resources });
  try {
    await runtime.install({ profile: 'local' }); let endpoint = (await runtime.start()).endpoint;
    const api = async (path, body) => {
      const response = await fetch(endpoint + '/api/learning/models/' + path, { headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const connectionId = randomUUID();
    const configuration = { connectionId, name: 'Responses fixture', protocol: 'responses',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/responses', modelId: 'fixture-responses',
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
      throw new Error('Bounded Responses call did not finish');
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
const send = (response, value) => response.write('data: ' + JSON.stringify(value) + '\n\n');
const message = text => ({ id: 'msg-native', type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }] });
const terminal = (output, status = 'completed') => ({ type: 'response.' + status,
  response: { id: 'resp-native', object: 'response', status, output,
    usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 } } });
const limits = { maxOutputTokens: 512, timeoutMs: 10000 };
const markerTool = { name: 'read_marker', description: '', inputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false } };
async function segment(api, source, tools = [], options = {}) {
  const segmentId = randomUUID();
  const response = await api('segments', { requestId: randomUUID(), segmentId, source,
    prefix: { system: '固定 instructions', tools, options }, portable: [] });
  assert.equal(response.status, 200, JSON.stringify(response.value)); return segmentId;
}
const call = (segmentId, expectedSequence = 0, text = '检查') => ({ attemptId: randomUUID(), purpose: 'chat-probe', segmentId, expectedSequence,
  input: { text, images: [], toolResults: [] }, limits });

test('formal Responses connection check uses the actual SDK path, model and bounded parameters', { timeout: 180000 }, async () => {
  const received = [];
  await product(async (request, response) => {
    const parts = []; for await (const chunk of request) parts.push(chunk);
    received.push({ url: request.url, payload: JSON.parse(Buffer.concat(parts)) });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    send(response, terminal([message('检查正常')])); response.end();
  }, async ({ api, source, finish, saved, restart }) => {
    assert.equal(saved.adapterState, 'ready');
    const input = { attemptId: randomUUID(), purpose: 'connection-check', source, limits: { ...limits, maxOutputTokens: 128 } };
    const result = await finish(input);
    assert.equal(result.state, 'completed'); assert.equal(result.text, '检查正常');
    assert.equal(result.usage.state, 'final'); assert.ok(result.resultRef);
    assert.equal(received[0].url, '/v1/responses');
    assert.equal(received[0].payload.model, 'fixture-responses');
    assert.equal(received[0].payload.max_output_tokens, 128);
    assert.equal(received[0].payload.max_tokens, undefined);
    assert.equal(received[0].payload.store, false);
    await restart();
    assert.equal((await api('checks/' + input.attemptId)).value.resultRef, result.resultRef);
    assert.equal((await api('checks', input)).status, 200);
    assert.equal((await api('checks/' + input.attemptId + '/dispatch', {})).status, 200);
    assert.equal(received.length, 1);
  });
});

test('only complete understood terminal responses publish schema-validated tool intents', { timeout: 180000 }, async t => {
  const tool = { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'read_marker', arguments: '{"nonce":"A"}', status: 'completed' };
  const fixtures = [
    { name: 'arguments done without a response terminal', state: 'incomplete', events: [
      { type: 'response.output_item.added', output_index: 0, item: { ...tool, status: 'in_progress', arguments: '' } },
      { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'item-1', arguments: tool.arguments }] },
    { name: 'incomplete even with parseable tools', state: 'incomplete', events: [terminal([tool], 'incomplete')] },
    { name: 'failed terminal', state: 'failed', events: [terminal([tool], 'failed')] },
    { name: 'stream error after parseable tools', state: 'failed', events: [
      { type: 'response.output_item.done', output_index: 0, item: tool }, { type: 'error', code: 'upstream-failure', message: 'synthetic' }] },
    { name: 'unknown critical output', state: 'failed', events: [terminal([{ type: 'unknown_signed_block', id: 'unknown-1', content: 'do not guess' }])] },
    { name: 'unknown critical event', state: 'failed', events: [{ type: 'response.unknown.delta', delta: 'x' }, terminal([tool])] },
    { name: 'invalid tool arguments', state: 'failed', events: [terminal([{ ...tool, arguments: '{"nonce":3}' }])] },
    { name: 'unknown tool', state: 'failed', events: [terminal([{ ...tool, name: 'side_effect' }])] },
    { name: 'reused call identity', state: 'failed', events: [terminal([tool, { ...tool, id: 'item-2' }])] },
    { name: 'delta differs from full response', state: 'failed', events: [
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'item-1', delta: '{"nonce":"B"}' }, terminal([tool])] },
    { name: 'events after a completed terminal', state: 'failed', events: [terminal([tool]), { type: 'error', code: 'late-error', message: 'synthetic' }] },
  ];
  for (const fixture of fixtures) await t.test(fixture.name, async () => {
    let requests = 0;
    await product((_request, response) => {
      requests++; response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of fixture.events) send(response, event); response.end();
    }, async ({ api, source, finish }) => {
      const id = await segment(api, source, [markerTool]);
      const result = await finish(call(id));
      assert.equal(result.state, fixture.state); assert.deepEqual(result.toolIntents, []); assert.equal(requests, 1);
    });
  });
});

test('summary dialect, interleaved tools and empty reasoning replay exactly', { timeout: 180000 }, async () => {
  const received = [];
  const output = [
    { id: 'summary-1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'PRIVATE-SUMMARY' }], encrypted_content: null },
    { id: 'item-a', type: 'function_call', call_id: 'call-a', name: 'read_marker', arguments: '{"nonce":"A"}', status: 'completed' },
    { id: 'item-b', type: 'function_call', call_id: 'call-b', name: 'read_marker', arguments: '{"nonce":"B"}', status: 'completed' },
  ];
  await product(async (request, response) => {
    const parts = []; for await (const chunk of request) parts.push(chunk); received.push(JSON.parse(Buffer.concat(parts)));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (received.length === 1) {
      send(response, { type: 'response.output_item.added', output_index: 0, item: { ...output[0], summary: [] } });
      send(response, { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'summary-1', summary_index: 0, delta: 'PRIVATE-SUMMARY' });
      for (const index of [2, 1]) {
        const { arguments: _args, ...added } = output[index];
        send(response, { type: 'response.output_item.added', output_index: index, item: { ...added, status: 'in_progress' } });
        send(response, { type: 'response.function_call_arguments.delta', output_index: index, item_id: added.id, delta: output[index].arguments });
      }
      send(response, terminal(output));
    } else send(response, terminal([message('完成')]));
    response.end();
  }, async ({ api, source, finish, restart }) => {
    const id = await segment(api, source, [markerTool]); const first = await finish(call(id));
    assert.equal(first.state, 'completed'); assert.deepEqual(first.toolIntents.map(item => item.callId), ['call-a', 'call-b']);
    await restart();
    const second = call(id, 1); second.input.toolResults = [
      { callId: 'call-b', outcome: 'not-executed', text: '未执行', images: [] },
      { callId: 'call-a', outcome: 'error', text: '合成错误', images: [] },
    ];
    assert.equal((await finish(second)).state, 'completed');
    assert.deepEqual(received[1].input.slice(1, 4), output);
    assert.deepEqual(received[1].input.slice(4, 6).map(item => [item.call_id, JSON.parse(item.output).outcome]), [['call-a', 'error'], ['call-b', 'not-executed']]);
  }, { dialect: 'command-code', parameterMode: 'plain' });
});

test('reasoning items, distinct call IDs and fixed tool images survive restart into the next native input', { timeout: 180000 }, async () => {
  const received = [];
  const output = [
    { id: 'reason-native', type: 'reasoning', content: [{ type: 'reasoning_text', text: 'PRIVATE-REASONING-甲乙' }], summary: [] },
    { id: 'item-function', type: 'function_call', call_id: 'call-distinct', name: 'read_marker', arguments: '{"nonce" : "A"}', status: 'completed' },
  ];
  await product(async (request, response) => {
    const parts = []; for await (const chunk of request) parts.push(chunk); received.push(JSON.parse(Buffer.concat(parts)));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (received.length === 1) {
      send(response, { type: 'response.output_item.added', output_index: 0, item: { ...output[0], content: [] } });
      send(response, { type: 'response.content_part.added', output_index: 0, item_id: 'reason-native', content_index: 0, part: { type: 'reasoning_text', text: '' } });
      send(response, { type: 'response.reasoning_text.delta', output_index: 0, item_id: 'reason-native', content_index: 0, delta: 'PRIVATE-REASONING-甲' });
      send(response, { type: 'response.reasoning_text.delta', output_index: 0, item_id: 'reason-native', content_index: 0, delta: '乙' });
      send(response, { type: 'response.reasoning_text.done', output_index: 0, item_id: 'reason-native', content_index: 0, text: 'PRIVATE-REASONING-甲乙' });
      send(response, { type: 'response.output_item.done', output_index: 0, item: output[0] });
      const { arguments: _arguments, ...added } = output[1];
      send(response, { type: 'response.output_item.added', output_index: 1, item: { ...added, status: 'in_progress' } });
      send(response, { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'item-function', delta: '{"nonce"' });
      send(response, { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'item-function', delta: ' : "A"}' });
      send(response, { type: 'response.function_call_arguments.done', output_index: 1, item_id: 'item-function', arguments: output[1].arguments });
      send(response, { type: 'response.output_item.done', output_index: 1, item: output[1] });
      send(response, terminal(output));
    } else send(response, terminal([{ id: 'empty-reason', type: 'reasoning', content: [], summary: [] }, message('nonce-X')]));
    response.end();
  }, async ({ api, source, finish, restart }) => {
    const imageId = randomUUID(), png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
    assert.equal((await api('images', { requestId: randomUUID(), imageId, mediaType: 'image/png', dataBase64: png })).status, 200);
    const image = { imageId, version: 1 }, segmentId = randomUUID();
    assert.equal((await api('segments', { requestId: randomUUID(), segmentId, source, prefix: { system: '固定 instructions', tools: [
      { name: 'read_marker', description: '无副作用工具', inputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false } },
    ] }, portable: [] })).status, 200);
    const first = await finish({ attemptId: randomUUID(), purpose: 'chat-probe', segmentId, expectedSequence: 0,
      input: { text: '先读图再请求工具', images: [image], toolResults: [] }, limits });
    assert.equal(first.state, 'completed');
    assert.deepEqual(first.toolIntents, [{ callId: 'call-distinct', name: 'read_marker', arguments: { nonce: 'A' } }]);
    assert.equal(JSON.stringify(first).includes('PRIVATE-REASONING'), false);
    await restart(); assert.equal((await api('calls/' + first.attemptId)).value.resultRef, first.resultRef);
    const second = await finish({ attemptId: randomUUID(), purpose: 'chat-probe', segmentId, expectedSequence: 1,
      input: { text: '继续', images: [], toolResults: [{ callId: 'call-distinct', outcome: 'success', text: 'nonce-X', images: [image] }] }, limits });
    assert.equal(second.state, 'completed'); assert.equal(second.text, 'nonce-X');
    assert.equal(received[0].instructions, '固定 instructions');
    assert.equal(received[0].reasoning.effort, 'high');
    assert.deepEqual(received[1].input.slice(1, 3), output);
    const result = received[1].input.find(item => item.type === 'function_call_output');
    assert.equal(result.call_id, 'call-distinct');
    assert.deepEqual(result.output, [{ type: 'input_text', text: 'nonce-X' }, { type: 'input_image', image_url: 'data:image/png;base64,' + png, detail: 'auto' }]);
    assert.equal(received[1].input[0].content[1].image_url, 'data:image/png;base64,' + png);
    assert.equal(received[1].previous_response_id, undefined); assert.equal(received[1].conversation, undefined);
    await restart();
    await finish({ attemptId: randomUUID(), purpose: 'chat-probe', segmentId, expectedSequence: 2,
      input: { text: '再次继续', images: [], toolResults: [] }, limits });
    assert.deepEqual(received[2].input[5], { id: 'empty-reason', type: 'reasoning', content: [], summary: [] });
  });
});


test('Responses schema format and application validation fail closed while explicit strict probes reach the SDK', { timeout: 180000 }, async t => {
  const received = [];
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  await product(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    send(response, { type: 'response.created', response: { id: 'resp-native', object: 'response', status: 'in_progress', output: [] } });
    send(response, terminal([message(['not-json', '{"ok":"wrong"}', '{"ok":true}', '{"ok":3}', '{"ok":true}'][received.length - 1])])); response.end();
  }, async ({ api, source, finish }) => {
    for (const [index, options] of [
      { responseFormat: { kind: 'json-schema', name: 'result', schema, strict: false } },
      { responseFormat: { kind: 'json-schema', name: 'result', schema: { type: 'object' }, strict: false }, applicationSchema: schema },
      { responseFormat: { kind: 'json-schema', name: 'result', schema, strict: true }, applicationSchema: schema, capabilityProbe: true },
      { responseFormat: { kind: 'json-schema', name: 'result', schema, strict: false } },
    ].entries()) await t.test(['invalid JSON', 'invalid application output', 'valid native schema with real created lifecycle', 'native schema mismatch without application schema'][index], async () => {
      const id = await segment(api, source, [], options), result = await finish(call(id));
      assert.equal(result.state, index === 2 ? 'completed' : 'failed', JSON.stringify(result));
      assert.deepEqual(result.toolIntents, []);
      if (index !== 2) assert.equal(result.reason, 'invalid-structured-output');
      assert.deepEqual(received[index].text.format, { type: 'json_schema', name: 'result', schema: index === 1 ? { type: 'object' } : schema, strict: index === 2 });
      assert.equal('applicationSchema' in received[index], false);
    });
    await t.test('unknown required route capability refuses before send', async () => {
      for (const capability of ['nativeStrict', 'strictTools']) {
        const rejected = await api('segments', { requestId: randomUUID(), segmentId: randomUUID(), source,
          prefix: { system: '', tools: [], options: { requiredCapabilities: [capability] } }, portable: [] });
        assert.equal(rejected.status, 503);
      }
      assert.equal(received.length, 4);
    });
    await t.test('strict tool flag survives an explicit capability probe', async () => {
      const id = await segment(api, source, [{ ...markerTool, strict: true }], { capabilityProbe: true, requiredCapabilities: ['strictTools'] });
      assert.equal((await finish(call(id))).state, 'completed');
      assert.equal(received[4].tools[0].strict, true); assert.equal(received.length, 5);
    });
  });
});

test('Responses cancellation physically closes the SDK stream and deadlines retain partial visible text', { timeout: 180000 }, async t => {
  let requests = 0, closed = 0;
  await product(async (request, response) => {
    for await (const _chunk of request) { /* Real SDK boundary. */ }
    requests++; response.on('close', () => { closed++; });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    send(response, { type: 'response.created', response: { id: 'resp-native', object: 'response', status: 'in_progress', output: [] } });
    send(response, { type: 'response.output_text.delta', output_index: 0, item_id: 'msg-native', content_index: 0, delta: '保留部分文字' });
    if (requests === 3) response.end();
    if (requests === 4) send(response, terminal([message('保留部分文字')]));
  }, async ({ api, source, wait, finish }) => {
    await t.test('not-started cancellation sends nothing', async () => {
      const input = call(await segment(api, source));
      assert.equal((await api('calls', input)).status, 200);
      const cancelled = await api(`calls/${input.attemptId}/cancel`, {});
      assert.equal(cancelled.status, 200); assert.equal(cancelled.value.state, 'cancelled');
      assert.equal(cancelled.value.reason, 'not-started'); assert.equal(cancelled.value.dispatched, false);
      assert.equal(cancelled.value.physicalRequestEnded, true); assert.equal(requests, 0);
      assert.equal((await api(`calls/${input.attemptId}/dispatch`, {})).status, 200);
      assert.equal(requests, 0);
    });
    await t.test('physical cancellation retains text and never creates tools', async () => {
      const input = call(await segment(api, source));
      assert.equal((await api('calls', input)).status, 200);
      assert.equal((await api(`calls/${input.attemptId}/dispatch`, {})).status, 200);
      for (let index = 0; index < 100 && requests === 0; index++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(requests, 1);
      // Let the SDK consume the flushed text before asking the public Gateway to cancel.
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal((await api(`calls/${input.attemptId}/cancel`, {})).status, 200);
      const result = await wait(input.attemptId);
      assert.equal(result.state, 'cancelled'); assert.equal(result.text, '保留部分文字');
      assert.deepEqual(result.toolIntents, []); assert.equal(result.upstreamStopped, 'unknown');
      for (let index = 0; index < 100 && closed === 0; index++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(closed, 1, 'SDK abort must close the upstream HTTP response');
    });
    for (const [name, reason] of [['timeout', 'timeout'], ['EOF without terminal', 'missing-terminal']]) await t.test(name, async () => {
      const input = call(await segment(api, source)); input.limits = { ...limits, timeoutMs: 500 };
      const result = await finish(input);
      assert.equal(result.state, name === 'timeout' ? 'unknown' : 'incomplete'); assert.equal(result.reason, reason);
      assert.equal(result.text, '保留部分文字'); assert.deepEqual(result.toolIntents, []);
      assert.equal(result.physicalRequestEnded, true); assert.deepEqual(result.usage, { state: 'unknown' });
    });
    await t.test('a completed terminal wins a late abort before physical EOF', async () => {
      const input = call(await segment(api, source));
      assert.equal((await api('calls', input)).status, 200);
      assert.equal((await api(`calls/${input.attemptId}/dispatch`, {})).status, 200);
      for (let index = 0; index < 100 && requests < 4; index++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(requests, 4);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal((await api(`calls/${input.attemptId}/cancel`, {})).status, 200);
      const result = await wait(input.attemptId);
      assert.equal(result.state, 'completed'); assert.equal(result.text, '保留部分文字');
      assert.equal(result.reason, 'completed'); assert.equal(result.usage.state, 'final');
      assert.deepEqual(result.toolIntents, []); assert.ok(result.resultRef);
    });
    assert.equal(requests, 4);
  });
});

test('Responses HTTP failures never retry and usage snapshots replace cumulative counters without inventing missing usage', { timeout: 180000 }, async t => {
  const received = [];
  await product(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); received.push(JSON.parse(Buffer.concat(chunks)));
    const index = received.length - 1;
    if (index < 3) { response.writeHead([401, 429, 503][index], { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'synthetic HTTP failure', type: 'server_error' } })); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const usage = index === 3 ? { input_tokens: 0, output_tokens: 0, total_tokens: 0 } : index === 4 ? undefined
      : { input_tokens: 7, output_tokens: 4, total_tokens: 11, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } };
    send(response, { type: 'response.created', response: { id: 'resp-native', object: 'response', status: 'in_progress', output: [],
      ...(index === 5 ? { usage: { input_tokens: 7, output_tokens: 1, total_tokens: 8 } } : {}) } });
    const event = terminal([message('完成')]); event.response.usage = usage;
    send(response, event); response.end();
  }, async ({ api, source, finish }) => {
    for (const [index, reason] of ['authentication', 'rate-limited', 'upstream-http'].entries()) await t.test('HTTP ' + [401, 429, 503][index], async () => {
      const result = await finish(call(await segment(api, source)));
      assert.equal(result.state, 'failed'); assert.equal(result.reason, reason);
      assert.deepEqual(result.toolIntents, []); assert.equal(received.length, index + 1, 'SDK must not retry');
    });
    for (const [index, expected] of [
      { state: 'final', inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      { state: 'unknown' },
      { state: 'final', inputTokens: 7, outputTokens: 4, totalTokens: 11, cachedTokens: 2, reasoningTokens: 3 },
    ].entries()) await t.test(['zero usage is final', 'absent usage stays unknown', 'cumulative usage replaces earlier snapshot'][index], async () => {
      const result = await finish(call(await segment(api, source)));
      assert.equal(result.state, 'completed'); assert.deepEqual(result.usage, expected);
    });
    assert.equal(received.length, 6);
  });
});

test('Responses real backup isolated restore and strict takeover retain pending tools fixed images and native replay', { timeout: 180000 }, async () => {
  const received = [], png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
  const output = [
    { id: 'restore-reason', type: 'reasoning', content: [{ type: 'reasoning_text', text: 'PRIVATE-RESTORED-原文' }], summary: [], encrypted_content: null },
    { id: 'restore-item', type: 'function_call', call_id: 'restore-call', name: 'read_marker', arguments: '{"nonce" : "A"}', status: 'completed' },
  ];
  await product(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); received.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    send(response, { type: 'response.created', response: { id: 'resp-native', object: 'response', status: 'in_progress', output: [] } });
    send(response, terminal(received.length === 1 ? output : [message('恢复完成')])); response.end();
  }, async ({ api, runtime, root, source, finish }) => {
    const imageId = randomUUID(), image = { imageId, version: 1 };
    assert.equal((await api('images', { requestId: randomUUID(), imageId, mediaType: 'image/png', dataBase64: png })).status, 200);
    const id = await segment(api, source, [markerTool]);
    const input = call(id); input.input.images = [image];
    const first = await finish(input); assert.equal(first.state, 'completed');
    assert.deepEqual(first.toolIntents, [{ callId: 'restore-call', name: 'read_marker', arguments: { nonce: 'A' } }]);
    const directory = await mkdtemp(join(tmpdir(), 'xj-responses-recovery-')), key = randomBytes(32);
    let target;
    try {
      await runtime.setCredential('responses-recovery', key.toString('base64'));
      const backup = await runtime.recovery.backup({ directory, recoveryKeyRef: 'responses-recovery', leaveClosed: true });
      const targetRoot = join(directory, 'target');
      const restored = await restoreProductRecovery({ root: targetRoot, resources, backupDirectory: join(directory, backup.backupId), key });
      try { assert.ok(restored.owners.length > 0); } finally { for (const owner of restored.owners) await owner.close?.(); }
      target = openProductRuntime({ root: targetRoot, resources });
      const state = await target.start(); assert.equal(state.state, 'maintenance');
      const targetApi = async (path, body) => {
        const response = await fetch(state.endpoint + '/api/learning/models/' + path, { headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
          ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
        return { status: response.status, value: await response.json() };
      };
      const next = call(id, 1); next.input.toolResults = [{ callId: 'restore-call', outcome: 'success', text: '恢复工具结果', images: [image] }];
      assert.equal((await targetApi('calls', next)).status, 503, 'isolated restore must not dispatch');
      assert.equal(received.length, 1);
      assert.equal((await target.recovery.takeover({ sourceRoot: root, receivers: [] })).phase, 'active');
      assert.equal((await targetApi('calls/' + first.attemptId)).value.resultRef, first.resultRef);
      assert.equal((await targetApi('segments/' + id)).value.pendingTools[0].callId, 'restore-call');
      assert.equal((await targetApi('calls', next)).status, 200);
      assert.equal((await targetApi(`calls/${next.attemptId}/dispatch`, {})).status, 200);
      let final;
      for (let index = 0; index < 150; index++) {
        final = await targetApi('calls/' + next.attemptId); if (final.value.physicalRequestEnded) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(final.status, 200); assert.equal(final.value.state, 'completed'); assert.equal(received.length, 2);
      assert.deepEqual(received[1].input.slice(1, 3), output);
      assert.equal(received[1].input[0].content[1].image_url, 'data:image/png;base64,' + png);
      assert.deepEqual(received[1].input[3], { type: 'function_call_output', call_id: 'restore-call', output: [
        { type: 'input_text', text: '恢复工具结果' }, { type: 'input_image', image_url: 'data:image/png;base64,' + png, detail: 'auto' },
      ] });
      assert.equal(JSON.stringify(final.value).includes('PRIVATE-RESTORED'), false);
      assert.equal((await api('calls', call(id, 1))).status, 503, 'retired source remains in maintenance');
      await runtime.stop();
      await assert.rejects(runtime.start(), error => error.code === 'source-retired', 'retired installation cannot reopen dispatch');
      assert.equal(received.length, 2);
    } finally { if (target) await target.stop(); await rm(directory, { recursive: true, force: true }); }
  });
});

test('Chat to Responses to Chat requires settled tools and crosses only approved visible portable text', { timeout: 180000 }, async t => {
  const received = [];
  await product(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks)) });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (request.url.endsWith('/chat/completions')) {
      send(response, { id: 'chat-native-id', choices: [{ index: 0, delta: received.length === 1
        ? { role: 'assistant', content: '获准 Chat 可见文字', reasoning_content: 'PRIVATE-CHAT-REASON', tool_calls: [
          { index: 0, id: 'chat-native-call', type: 'function', function: { name: 'read_marker', arguments: '{"nonce":"A"}' } },
        ] } : { role: 'assistant', content: '最终 Chat 可见文字' }, finish_reason: received.length === 1 ? 'tool_calls' : 'stop' }] });
      response.end('data: [DONE]\n\n');
    } else {
      send(response, { type: 'response.created', response: { id: 'resp-native', object: 'response', status: 'in_progress', output: [] } });
      send(response, terminal([
        { id: 'responses-native-reason', type: 'reasoning', content: [{ type: 'reasoning_text', text: 'PRIVATE-RESPONSES-REASON' }], summary: [], encrypted_content: 'PRIVATE-SIGNATURE' },
        message('获准 Responses 可见文字'),
        { id: 'responses-native-item', type: 'function_call', call_id: 'responses-native-call', name: 'read_marker', arguments: '{"nonce":"A"}', status: 'completed' },
      ])); response.end();
    }
  }, async ({ api, source, configuration, finish }) => {
    const chatId = randomUUID();
    assert.equal((await api('connections', { ...configuration, connectionId: chatId, protocol: 'chat-completions', path: '/chat/completions',
      requestId: randomUUID(), expectedVersion: 0, credential: { action: 'replace', value: 'synthetic-chat-key' } })).status, 200);
    const chatSource = { connectionId: chatId, version: 1 };
    const firstId = await segment(api, chatSource, [markerTool]);
    const first = await finish(call(firstId)); assert.equal(first.state, 'completed');
    const toResponses = { requestId: randomUUID(), segmentId: randomUUID(), source, previousSegmentId: firstId,
      prefix: { system: 'Responses 新前缀', tools: [markerTool] }, portable: [{ text: first.text, resultRef: first.resultRef }] };
    await t.test('pending Chat tool refuses Responses switch', async () => {
      assert.equal((await api('segments', toResponses)).status, 409); assert.equal(received.length, 1);
      assert.equal((await api(`segments/${firstId}/tool-results`, { requestId: randomUUID(), expectedSequence: 1,
        results: [{ callId: 'chat-native-call', outcome: 'not-executed', text: '不携带旧工具结果', images: [] }] })).status, 200);
    });
    await t.test('new Responses route rechecks unknown required capability', async () => {
      const rejected = await api('segments', { ...toResponses, requestId: randomUUID(), segmentId: randomUUID(),
        prefix: { ...toResponses.prefix, options: { requiredCapabilities: ['nativeStrict'] } } });
      assert.equal(rejected.status, 503); assert.equal(received.length, 1);
    });
    assert.equal((await api('segments', toResponses)).status, 200);
    const second = await finish(call(toResponses.segmentId)); assert.equal(second.state, 'completed');
    const nativeResponses = JSON.stringify(received[1].body);
    assert.ok(nativeResponses.includes('获准 Chat 可见文字'));
    for (const forbidden of ['chat-native-id', 'chat-native-call', 'PRIVATE-CHAT-REASON', '不携带旧工具结果', 'tool_call_id', 'reasoning_content'])
      assert.equal(nativeResponses.includes(forbidden), false, forbidden);
    const toChat = { requestId: randomUUID(), segmentId: randomUUID(), source: chatSource, previousSegmentId: toResponses.segmentId,
      prefix: { system: 'Chat 新前缀', tools: [] }, portable: [{ text: second.text, resultRef: second.resultRef }] };
    await t.test('pending Responses tool refuses Chat switch', async () => {
      assert.equal((await api('segments', toChat)).status, 409); assert.equal(received.length, 2);
      assert.equal((await api(`segments/${toResponses.segmentId}/tool-results`, { requestId: randomUUID(), expectedSequence: 1,
        results: [{ callId: 'responses-native-call', outcome: 'success', text: '不携带 Responses 工具结果', images: [] }] })).status, 200);
    });
    await t.test('new Chat route rechecks unknown required capability', async () => {
      assert.equal((await api('segments', { ...toChat, requestId: randomUUID(), segmentId: randomUUID(),
        prefix: { ...toChat.prefix, options: { requiredCapabilities: ['nativeStrict'] } } })).status, 503);
      assert.equal(received.length, 2);
    });
    assert.equal((await api('segments', toChat)).status, 200);
    assert.equal((await finish(call(toChat.segmentId))).state, 'completed');
    const nativeChat = JSON.stringify(received[2].body);
    assert.ok(nativeChat.includes('获准 Responses 可见文字'));
    for (const forbidden of ['responses-native-reason', 'responses-native-item', 'responses-native-call', 'resp-native', 'msg-native',
      'PRIVATE-RESPONSES-REASON', 'PRIVATE-SIGNATURE', '不携带 Responses 工具结果', '获准 Chat 可见文字'])
      assert.equal(nativeChat.includes(forbidden), false, forbidden);
    assert.equal(received.length, 3);
  });
});

test('Responses incomplete and failed terminal bodies retain visible text without text deltas', { timeout: 180000 }, async t => {
  let requests = 0;
  await product((_request, response) => {
    requests++; response.writeHead(200, { 'content-type': 'text/event-stream' });
    send(response, terminal([message('partial')], requests === 1 ? 'incomplete' : 'failed')); response.end();
  }, async ({ api, source, finish }) => {
    for (const state of ['incomplete', 'failed']) await t.test(state, async () => {
      const result = await finish(call(await segment(api, source)));
      assert.equal(result.state, state); assert.deepEqual(result.toolIntents, []);
      assert.equal(result.text, 'partial', 'full terminal visible text is available even without delta events');
    });
    assert.equal(requests, 2);
  });
});

test('credential echoes in tool arguments never become public or consumable intentions', { timeout: 180000 }, async t => {
  for (const secret of ['synthetic-responses-key', 'synthetic-"escaped\\key']) await t.test(secret.includes('escaped') ? 'JSON-escaped credential' : 'ordinary credential', async () => {
    await product((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    send(response, terminal([{ id: 'secret-item', type: 'function_call', call_id: 'secret-call', name: 'read_marker',
      arguments: JSON.stringify({ nonce: secret }), status: 'completed' }])); response.end();
  }, async ({ api, source, finish, restart }) => {
    const result = await finish(call(await segment(api, source, [markerTool])));
    assert.equal(result.state, 'failed'); assert.equal(result.reason, 'credential-in-tool-output');
    assert.deepEqual(result.toolIntents, []); assert.equal(JSON.stringify(result).includes(JSON.stringify(secret).slice(1, -1)), false);
    await restart();
    const reread = (await api('calls/' + result.attemptId)).value;
    assert.equal(JSON.stringify(reread).includes(JSON.stringify(secret).slice(1, -1)), false); assert.deepEqual(reread.toolIntents, []);
    }, {}, secret);
  });
});

test('incomplete output_item.done retains the response terminal, partial text and actual usage', { timeout: 180000 }, async () => {
  await product((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const item = { ...message('partial at limit'), status: 'incomplete' };
    send(response, { type: 'response.output_item.done', output_index: 0, item });
    send(response, { ...terminal([item], 'incomplete'), response: { ...terminal([item], 'incomplete').response,
      incomplete_details: { reason: 'max_output_tokens' } } }); response.end();
  }, async ({ api, source, finish }) => {
    const result = await finish(call(await segment(api, source)));
    assert.equal(result.state, 'incomplete'); assert.equal(result.reason, 'incomplete'); assert.equal(result.text, 'partial at limit');
    assert.deepEqual(result.usage, { state: 'final', inputTokens: 7, outputTokens: 4, totalTokens: 11 });
    assert.deepEqual(result.toolIntents, []);
  });
});

test('transport resets preserve a received completed terminal and leave an unterminated stream incomplete', { timeout: 180000 }, async () => {
  let requests = 0;
  await product((_request, response) => {
    requests++; response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests === 1) send(response, terminal([message('完整完成')]));
    else send(response, { type: 'response.output_text.delta', output_index: 0, item_id: 'msg-native', content_index: 0, delta: '部分' });
    setTimeout(() => response.destroy(), 100);
  }, async ({ api, source, finish, restart }) => {
    const id = await segment(api, source), first = await finish(call(id));
    assert.equal(first.state, 'completed'); assert.equal(first.text, '完整完成'); assert.equal(first.usage.state, 'final');
    await restart(); assert.equal((await api('calls/' + first.attemptId)).value.resultRef, first.resultRef);
    const second = await finish(call(id, 1));
    assert.equal(second.state, 'incomplete'); assert.equal(second.text, '部分'); assert.deepEqual(second.toolIntents, []);
    assert.equal(requests, 2);
  });
});

test('credentials split across deltas cannot create an inconsistent completed native record', { timeout: 180000 }, async () => {
  await product((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const delta of ['synthetic-', 'responses-key']) send(response, { type: 'response.output_text.delta',
      output_index: 0, item_id: 'msg-native', content_index: 0, delta });
    send(response, terminal([message('synthetic-responses-key')])); response.end();
  }, async ({ api, source, finish, restart }) => {
    const result = await finish(call(await segment(api, source)));
    assert.equal(result.state, 'failed'); assert.equal(result.reason, 'credential-in-output');
    assert.equal(result.text, '[redacted]'); assert.deepEqual(result.toolIntents, []);
    await restart(); assert.equal((await api('calls/' + result.attemptId)).value.state, 'failed');
  });
});

test('incomplete and failed terminal text survives a later transport reset without deltas', { timeout: 180000 }, async () => {
  let requests = 0;
  await product((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    send(response, terminal([message('终态部分正文')], ++requests === 1 ? 'incomplete' : 'failed'));
    setTimeout(() => response.destroy(), 100);
  }, async ({ api, source, finish }) => {
    for (const state of ['incomplete', 'failed']) {
      const result = await finish(call(await segment(api, source)));
      assert.equal(result.state, state); assert.equal(result.text, '终态部分正文'); assert.equal(result.usage.state, 'final');
      assert.deepEqual(result.toolIntents, []);
    }
  });
});
