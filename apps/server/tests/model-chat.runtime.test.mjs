import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openProductRuntime } from '@xunjie/product-runtime';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
async function product(upstreamHandler, run) {
  const upstream = createServer(upstreamHandler);
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const runtime = openProductRuntime({ root: await mkdtemp(join(tmpdir(), 'xj-native-chat-')), resources: {
    nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6', postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN,
    webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } });
  let failure;
  try {
    await runtime.install({ profile: 'local' }); const { endpoint } = await runtime.start();
    const api = async (path, body) => {
      const response = await fetch(endpoint + '/api/learning/models/' + path, { headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const connectionId = randomUUID();
    const saved = await api('connections', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'Chat 原生测试',
      protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions', modelId: 'fixture-chat',
      dialect: 'standard', parameterMode: 'plain', enabled: true, credential: { action: 'replace', value: 'synthetic-chat-key' } });
    assert.equal(saved.status, 200);
    const finish = async input => {
      const accepted = await api('calls', input); assert.equal(accepted.status, 200);
      assert.equal((await api(`calls/${input.attemptId}/dispatch`, {})).status, 200);
      for (let count = 0; count < 150; count++) {
        const fact = await api(`calls/${input.attemptId}`); assert.equal(fact.status, 200);
        if (fact.value.physicalRequestEnded) return fact.value;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('The bounded call did not finish');
    };
    await run({ api, runtime, source: { connectionId, version: 1 }, finish });
  } catch (error) { failure = error; }
  finally {
    try { await runtime.stop(); } catch (error) { failure = failure ? new AggregateError([failure, error]) : error; }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
  if (failure) throw failure;
}

test('fixed images and multi-tool reasoning survive persistence and restart into the next actual SDK payload', { timeout: 180000 }, async () => {
  const received = [];
  await product(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = value => response.write('data: ' + JSON.stringify(value) + '\n\n');
    if (received.length === 1) {
      send({ id: 'tools-result', choices: [{ index: 0, delta: { role: 'assistant', content: null, reasoning_content: 'PRIVATE-REASONING-甲' }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: { reasoning_content: '乙', tool_calls: [{ index: 1, id: 'tool-image', type: 'function', function: { name: 'produce_image', arguments: '{' } },
        { index: 0, id: 'tool-marker', type: 'function', function: { name: 'read_marker', arguments: '{"nonce"' } }] }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ' : "A"}' } }, { index: 1, function: { arguments: '}' } }] }, finish_reason: 'tool_calls' }] });
      send({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } });
    } else send({ id: 'final-result', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '', content: 'nonce-X' }, finish_reason: 'stop' }] });
    response.end('data: [DONE]\n\n');
  }, async ({ api, source, finish, runtime }) => {
    const uploaded = await api('images', { requestId: randomUUID(), imageId: randomUUID(), mediaType: 'image/png', dataBase64: png });
    assert.equal(uploaded.status, 200);
    const image = { imageId: uploaded.value.imageId, version: 1 };
    const segmentId = randomUUID();
    const segment = await api('segments', { requestId: randomUUID(), segmentId, source, prefix: { system: '固定系统前缀', tools: [
      { name: 'read_marker', description: '无副作用读取', inputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false } },
      { name: 'produce_image', description: '调用方提供合成图', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    ] }, portable: [] });
    assert.equal(segment.status, 200);
    const first = await finish({ attemptId: randomUUID(), purpose: 'chat-probe', segmentId, expectedSequence: 0,
      input: { text: '读取固定图片并请求两个工具', images: [image], toolResults: [] }, limits: { maxOutputTokens: 512, timeoutMs: 10000 } });
    assert.equal(first.state, 'completed'); assert.equal(first.reason, 'tool_calls'); assert.equal(first.usage.state, 'final');
    assert.deepEqual(first.toolIntents.map(tool => [tool.callId, tool.name, tool.arguments]), [['tool-marker', 'read_marker', { nonce: 'A' }], ['tool-image', 'produce_image', {}]]);
    assert.equal(JSON.stringify(first).includes('PRIVATE-REASONING'), false);
    await runtime.stop(); await runtime.start(); assert.equal(received.length, 1);
    assert.equal((await api(`calls/${first.attemptId}`)).value.resultRef, first.resultRef);
    const second = await finish({ attemptId: randomUUID(), purpose: 'chat-probe', segmentId, expectedSequence: 1,
      input: { text: '继续', images: [], toolResults: [
        { callId: 'tool-marker', outcome: 'success', text: 'nonce-X', images: [] },
        { callId: 'tool-image', outcome: 'success', text: '配对图像结果', images: [image] },
      ] }, limits: { maxOutputTokens: 512, timeoutMs: 10000 } });
    assert.equal(second.state, 'completed'); assert.equal(second.text, 'nonce-X'); assert.equal(received.length, 2);
    const assistant = received[1].messages.find(message => message.role === 'assistant');
    assert.equal(assistant.reasoning_content, 'PRIVATE-REASONING-甲乙'); assert.equal(assistant.content, null);
    assert.deepEqual(assistant.tool_calls, [
      { id: 'tool-marker', type: 'function', function: { name: 'read_marker', arguments: '{"nonce" : "A"}' } },
      { id: 'tool-image', type: 'function', function: { name: 'produce_image', arguments: '{}' } },
    ]);
    const paired = received[1].messages.findIndex(message => message.tool_call_id === 'tool-image');
    assert.equal(received[1].messages[paired + 1].role, 'user');
    assert.equal(received[1].messages[paired + 1].content[0].image_url.url, 'data:image/png;base64,' + png);
    assert.equal(received[0].messages[1].content[1].image_url.url, 'data:image/png;base64,' + png);
    await runtime.stop(); await runtime.start();
    const third = await finish({ attemptId: randomUUID(), purpose: 'chat-probe', segmentId, expectedSequence: 2,
      input: { text: '再次续接', images: [], toolResults: [] }, limits: { maxOutputTokens: 512, timeoutMs: 10000 } });
    assert.equal(third.state, 'completed');
    assert.equal(received[2].messages.filter(message => message.role === 'assistant')[1].reasoning_content, '');
  });
});

test('incomplete or unvalidated native output never publishes executable tool intents', { timeout: 180000 }, async () => {
  const cases = [
    { delta: { role: 'assistant', content: '部分内容', encrypted_reasoning: 'unknown-critical' }, finish: 'stop', state: 'failed' },
    { args: '{"wrong":1}', finish: 'tool_calls', state: 'failed' },
    { args: '{"nonce":', finish: 'tool_calls', state: 'failed' },
    { args: '{"nonce":"A"}', finish: 'length', state: 'incomplete' },
    { args: '{"nonce":"A"}', refusal: '拒绝', finish: 'tool_calls', state: 'failed' },
    { args: '{"nonce":"A"}', finish: null, state: 'incomplete' },
  ];
  let index = 0;
  await product(async (request, response) => {
    for await (const _chunk of request) { /* Consume the actual SDK request. */ }
    const fixture = cases[index++];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: fixture.delta ?? { role: 'assistant', content: null,
      ...(fixture.refusal ? { refusal: fixture.refusal } : {}),
      tool_calls: [{ index: 0, id: 'probe-call', type: 'function', function: { name: 'read_marker', arguments: fixture.args } }] }, finish_reason: fixture.finish }] }) + '\n\n');
    response.end('data: [DONE]\n\n');
  }, async ({ api, source, finish }) => {
    for (const fixture of cases) {
      const segmentId = randomUUID();
      assert.equal((await api('segments', { requestId: randomUUID(), segmentId, source, prefix: { system: '反例', tools: [
        { name: 'read_marker', description: '', inputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false } },
      ] }, portable: [] })).status, 200);
      const result = await finish({ attemptId: randomUUID(), purpose: 'chat-probe', segmentId, expectedSequence: 0,
        input: { text: '无副作用反例', images: [], toolResults: [] }, limits: { maxOutputTokens: 256, timeoutMs: 10000 } });
      assert.equal(result.state, fixture.state); assert.deepEqual(result.toolIntents, []);
      assert.ok(result.resultRef); assert.equal(result.physicalRequestEnded, true);
    }
    assert.equal(index, 6);
  });
});

test('caller settles pending tools before a new segment and portable input never imports old native IDs', { timeout: 180000 }, async () => {
  const received = [];
  await product(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: received.length === 1
      ? { role: 'assistant', reasoning_content: 'old-native-only', tool_calls: [{ index: 0, id: 'old-call', type: 'function', function: { name: 'read_marker', arguments: '{}' } }] }
      : { role: 'assistant', content: '新段完成', reasoning_content: null }, finish_reason: received.length === 1 ? 'tool_calls' : 'stop' }] }) + '\n\n');
    response.end('data: [DONE]\n\n');
  }, async ({ api, source, finish, runtime }) => {
    const segmentId = randomUUID();
    const created = await api('segments', { requestId: randomUUID(), segmentId, source, prefix: { system: '旧前缀', tools: [
      { name: 'read_marker', description: '由调用方处理', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    ] }, portable: [] });
    assert.equal(created.status, 200);
    const first = await finish({ attemptId: randomUUID(), purpose: 'chat-probe', segmentId, expectedSequence: 0,
      input: { text: '请求工具', images: [], toolResults: [] }, limits: { maxOutputTokens: 512, timeoutMs: 10000 } });
    assert.equal(first.state, 'completed');
    const next = { requestId: randomUUID(), segmentId: randomUUID(), source, previousSegmentId: segmentId,
      prefix: { system: '新前缀', tools: [] }, portable: [{ text: '已获准的可移植问题', resultRef: first.resultRef }] };
    assert.equal((await api('segments', next)).status, 409);
    const settlement = { requestId: randomUUID(), expectedSequence: 1,
      results: [{ callId: 'old-call', outcome: 'not-executed', text: '调用方决定不执行', images: [] }] };
    assert.equal((await api(`segments/${segmentId}/tool-results`, { ...settlement, requestId: randomUUID(), results: [{ ...settlement.results[0], callId: 'foreign-call' }] })).status, 400);
    const settled = await api(`segments/${segmentId}/tool-results`, settlement);
    assert.equal(settled.status, 200); assert.deepEqual(settled.value.pendingTools, []);
    await runtime.stop(); await runtime.start();
    assert.deepEqual((await api(`segments/${segmentId}`)).value.pendingTools, []);
    assert.equal((await api('segments', next)).status, 200);
    const input = { attemptId: randomUUID(), purpose: 'chat-probe', segmentId: next.segmentId, expectedSequence: 0,
      input: { text: '继续新段', images: [], toolResults: settlement.results }, limits: { maxOutputTokens: 512, timeoutMs: 10000 } };
    assert.equal((await api('calls', input)).status, 400);
    const observationId = randomUUID();
    const final = await finish({ ...input, attemptId: randomUUID(), input: { ...input.input, toolResults: [],
      observations: [{ observationId, version: 2, source: 'caller', text: '当前作品第二版观察' }] } });
    assert.equal(final.state, 'completed'); assert.equal(received.length, 2);
    assert.equal(received[1].messages[0].content, '新前缀');
    assert.ok(JSON.stringify(received[1].messages).includes(observationId));
    assert.equal(JSON.stringify(received[1]).includes('old-native-only'), false);
    assert.equal(JSON.stringify(received[1]).includes('old-call'), false);
    assert.equal((await api(`calls/${first.attemptId}`)).value.toolIntents[0].callId, 'old-call');
  });
});
