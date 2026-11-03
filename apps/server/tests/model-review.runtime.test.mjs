import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Requires native PostgreSQL 18.6.');
const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
const key = 'synthetic-review-"key\\-private';
const config = (baseUrl, overrides = {}) => ({ requestId: randomUUID(), connectionId: randomUUID(), expectedVersion: 0,
  name: 'Review regression', protocol: 'chat-completions', baseUrl, path: '/chat/completions', modelId: 'review-fixture',
  dialect: 'standard', parameterMode: 'plain', enabled: true, credential: { action: 'replace', value: key }, ...overrides });
const tool = { name: 'read_marker', description: 'Read marker', inputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false } };
const send = (response, value) => response.write('data: ' + JSON.stringify(value) + '\n\n');
const chat = (delta, reason) => ({ id: 'review-chat', choices: [{ index: 0, delta, finish_reason: reason }] });
const usage = { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 };

async function product(profile, handler, run) {
  let requests = 0;
  const upstream = createServer(async (request, response) => { requests++; const parts = [];
    for await (const part of request) parts.push(part);
    await handler(request, response, JSON.parse(Buffer.concat(parts).toString()), requests);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'xj-pr177-review-'));
  const runtime = openProductRuntime({ root, resources });
  try {
    await runtime.install({ profile });
    let state = await runtime.start();
    const api = async (route, body, headers = profile === 'school' ? {} : { 'x-xj-space': 'personal' }) => {
      const response = await fetch(state.endpoint + '/api/learning/' + route, { headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    const restart = async () => { await runtime.stop(); state = await runtime.start(); };
    const native = async result => {
      const owner = state.environment.services.find(item => item.unit === 'model-connection');
      const bytes = await readFile(join(root, 'learning-resources/model-connection', state.environment.environmentId, owner.serviceId, result.resultRef));
      assert.match(bytes.subarray(0, bytes.indexOf(10)).toString(), /^xunjie-resource\/1 /);
      return JSON.parse(bytes.subarray(bytes.indexOf(10) + 1).toString());
    };
    const finish = async (input, headers) => {
      const accepted = await api('models/calls', input, headers); assert.equal(accepted.status, 200, JSON.stringify(accepted.value));
      const dispatched = await api('models/calls/' + input.attemptId + '/dispatch', {}, headers); assert.equal(dispatched.status, 200);
      for (let i = 0; i < 200; i++) {
        const result = await api('models/calls/' + input.attemptId, undefined, headers);
        assert.equal(result.status, 200);
        if (result.value.physicalRequestEnded) return result.value;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail('native request did not terminate');
    };
    const segment = async (connection, prefix = { system: 'Review fixture', tools: [tool] }, headers) => {
      const segmentId = randomUUID();
      const result = await api('models/segments', { requestId: randomUUID(), segmentId, source: { connectionId: connection.connectionId, version: 1 }, prefix, portable: [] }, headers);
      assert.equal(result.status, 200, JSON.stringify(result.value)); return segmentId;
    };
    await run({ api, runtime, root, restart, native, finish, segment,
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, requests: () => requests });
  } finally {
    await runtime.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
const input = (segmentId, text = 'continue') => ({ attemptId: randomUUID(), purpose: 'chat-probe', segmentId, expectedSequence: 0,
  input: { text, images: [], toolResults: [] }, limits: { maxOutputTokens: 64, timeoutMs: 10000 } });

test('school HTTP identity cannot save or check host-local targets; approved school default can dispatch', { timeout: 180000 }, async () => {
  await product('school', (_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' });
    send(response, chat({ content: 'approved-school-endpoint' }, 'stop')); response.end('data: [DONE]\n\n');
  }, async ({ api, root, baseUrl, requests, restart }) => {
    const admin = { authorization: 'Bearer ' + await resolveCredential(root, 'control') }, password = randomUUID();
    assert.equal((await api('manage/members', { requestId: randomUUID(), loginName: 'review-member', password }, admin)).status, 200);
    const login = await api('login', { loginName: 'review-member', password }), member = { cookie: login.cookie };
    const connection = config(baseUrl);
    for (const target of [baseUrl, 'https://10.0.0.1/v1', 'https://[::1]/v1']) {
      const candidate = { ...connection, requestId: randomUUID(), baseUrl: target };
      assert.equal((await api('models/connections', candidate, member)).status, 403);
      const { requestId, expectedVersion, credential, ...draft } = candidate;
      assert.equal((await api('models/checks', { attemptId: randomUUID(), purpose: 'connection-check', source: { draft, credential },
        limits: { maxOutputTokens: 64, timeoutMs: 10000 } }, member)).status, 403);
    }
    assert.equal(requests(), 0);
    const policy = { checksAllowed: true, maxChecksPerHour: 6, maxOutputTokens: 64, timeoutMs: 10000 };
    const saved = await api('manage/model-default', { ...connection, policy }, admin); assert.equal(saved.status, 200);
    const attemptId = randomUUID();
    assert.equal((await api('models/checks', { attemptId, purpose: 'connection-check', source: { school: { connectionId: connection.connectionId, version: 1 } },
      limits: { maxOutputTokens: 64, timeoutMs: 10000 } }, member)).status, 200);
    assert.equal((await api(`models/checks/${attemptId}/dispatch`, {}, member)).status, 200);
    let result;
    for (let i = 0; i < 100; i++) { result = (await api(`models/checks/${attemptId}`, undefined, member)).value;
      if (result.physicalRequestEnded) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(result.state, 'completed'); assert.equal(requests(), 1);
    await restart(); assert.equal((await api(`models/checks/${attemptId}`, undefined, member)).value.resultRef, result.resultRef);
    const pendingId = randomUUID();
    assert.equal((await api('models/checks', { attemptId: pendingId, purpose: 'connection-check', source: { school: { connectionId: connection.connectionId, version: 1 } },
      limits: { maxOutputTokens: 64, timeoutMs: 10000 } }, member)).status, 200);
    assert.equal((await api('manage/model-default', { ...connection, requestId: randomUUID(), expectedVersion: 1, enabled: false, credential: { action: 'keep' }, policy }, admin)).status, 200);
    assert.equal((await api(`models/checks/${pendingId}/dispatch`, {}, member)).status, 403);
    assert.equal(requests(), 1);
  });
});

test('decoded and fragmented credentials never publish tools or persist reconstructable native bodies', { timeout: 180000 }, async () => {
  await product('local', (_request, response, body) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const mode = body.messages.at(-1).content[0].text;
    if (mode === 'fragmented') {
      send(response, chat({ content: key.slice(0, 10) }, null)); send(response, chat({ content: key.slice(10) }, 'stop'));
    } else {
      const encoded = mode === 'unicode' ? [...key].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('') : JSON.stringify(key).slice(1, -1);
      send(response, chat({ tool_calls: [{ index: 0, id: 'call-sensitive', type: 'function', function: { name: 'read_marker', arguments: '{"nonce":"' + encoded + '"}' } }] }, 'tool_calls'));
    }
    send(response, { choices: [], usage }); response.end('data: [DONE]\n\n');
  }, async ({ api, baseUrl, segment, finish, native, restart, requests }) => {
    const connection = config(baseUrl); assert.equal((await api('models/connections', connection)).status, 200);
    const results = [];
    for (const mode of ['unicode', 'special', 'fragmented']) {
      const result = await finish(input(await segment(connection), mode));
      assert.equal(result.state, 'failed'); assert.equal(result.reason, mode === 'fragmented' ? 'credential-in-output' : 'credential-in-tool-output');
      assert.deepEqual(result.toolIntents, []); assert.equal(result.usage.state, 'final');
      const stored = await native(result);
      assert.equal(stored.redacted, true); assert.deepEqual(stored.chunks, []);
      assert.equal(JSON.stringify([result, stored]).includes(key), false); results.push(result);
    }
    await restart();
    for (const result of results) {
      const read = (await api(`models/calls/${result.attemptId}`)).value;
      assert.equal(read.resultRef, result.resultRef); assert.equal(read.state, 'failed');
      assert.equal((await api(`models/calls/${result.attemptId}/dispatch`, {})).value.resultRef, result.resultRef);
    }
    assert.equal(requests(), 3);
  });
});

test('Chat terminal/reset and truncated final usage remain durable and query never regenerates', { timeout: 180000 }, async () => {
  await product('local', (_request, response, body) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const mode = body.messages.at(-1).content[0].text;
    send(response, chat(mode === 'tool-reset' ? { tool_calls: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'read_marker', arguments: '{"nonce":"A"}' } }] }
      : { content: 'terminal-text' }, mode === 'length' ? 'length' : mode === 'tool-reset' ? 'tool_calls' : 'stop'));
    send(response, { choices: [], usage });
    if (mode === 'length') response.end('data: [DONE]\n\n');
    else setTimeout(() => response.destroy(), 30);
  }, async ({ api, baseUrl, segment, finish, restart, requests }) => {
    const connection = config(baseUrl); assert.equal((await api('models/connections', connection)).status, 200);
    const results = [];
    for (const mode of ['text-reset', 'tool-reset', 'length']) {
      const result = await finish(input(await segment(connection), mode));
      assert.equal(result.state, mode === 'length' ? 'incomplete' : 'completed');
      assert.equal(result.usage.state, 'final'); assert.equal(result.usage.inputTokens, 7);
      if (mode === 'tool-reset') assert.equal(result.toolIntents[0].arguments.nonce, 'A');
      results.push(result);
    }
    await restart();
    for (const result of results) {
      assert.equal((await api(`models/calls/${result.attemptId}`)).value.resultRef, result.resultRef);
      assert.equal((await api(`models/calls/${result.attemptId}/dispatch`, {})).value.resultRef, result.resultRef);
    }
    assert.equal(requests(), 3);
  });
});

test('three protocol HTTP facts survive owner persistence and restart with no retries', { timeout: 180000 }, async () => {
  await product('local', (_request, response) => { response.writeHead(429, { 'content-type': 'application/json', 'x-request-id': 'fixture-429-request', 'retry-after': '17' });
    response.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'synthetic rate limit' } }));
  }, async ({ api, baseUrl, segment, finish, native, restart, requests }) => {
    const results = [];
    for (const protocol of ['chat-completions', 'responses', 'messages']) {
      const connection = config(protocol === 'messages' ? baseUrl.replace(/\/v1$/, '') : baseUrl,
        { protocol, path: protocol === 'responses' ? '/responses' : protocol === 'messages' ? '/v1/messages' : '/chat/completions' });
      assert.equal((await api('models/connections', connection)).status, 200);
      const result = await finish(input(await segment(connection)));
      assert.equal(result.state, 'failed'); assert.equal(result.reason, 'rate-limited');
      assert.deepEqual(result.upstream, { httpStatus: 429, requestId: 'fixture-429-request', retryAfterSeconds: 17 });
      assert.deepEqual((await native(result)).upstream, result.upstream); results.push(result);
    }
    await restart();
    for (const result of results) assert.deepEqual((await api(`models/calls/${result.attemptId}`)).value.upstream, result.upstream);
    assert.equal(requests(), 3);
  });
});

test('Messages truncated JSON and empty end_turn keep final facts through PostgreSQL and restart', { timeout: 180000 }, async () => {
  await product('model', (_request, response, body) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const empty = body.messages.at(-1).content[0].text === 'empty';
    const event = value => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    event({ type: 'message_start', message: { id: 'review-message', type: 'message', role: 'assistant', model: 'review-fixture', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
    if (!empty) {
      event({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'partial-tool', name: 'read_marker', input: {} } });
      event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"nonce":"part' } });
      event({ type: 'content_block_stop', index: 0 });
    }
    event({ type: 'message_delta', delta: { stop_reason: empty ? 'end_turn' : 'max_tokens', stop_sequence: null }, usage: { input_tokens: 7, output_tokens: 4 } });
    event({ type: 'message_stop' }); response.end();
  }, async ({ api, baseUrl, segment, finish, restart, native, requests }) => {
    const connection = config(baseUrl.replace(/\/v1$/, ''), { protocol: 'messages', path: '/v1/messages' });
    assert.equal((await api('models/connections', connection)).status, 200);
    const results = [];
    for (const mode of ['truncated', 'empty']) {
      const result = await finish(input(await segment(connection), mode));
      assert.equal(result.state, mode === 'empty' ? 'completed' : 'incomplete');
      assert.equal(result.reason, mode === 'empty' ? 'end_turn' : 'max_tokens');
      assert.equal(result.usage.state, 'final'); assert.equal(result.usage.inputTokens, 7); assert.equal(result.usage.outputTokens, 4);
      assert.deepEqual(result.toolIntents, []);
      const stored = await native(result); assert.equal(stored.message.stop_reason, result.reason);
      assert.equal(stored.events.length, mode === 'empty' ? 3 : 6); results.push(result);
    }
    await restart();
    for (const result of results) assert.equal((await api(`models/calls/${result.attemptId}`)).value.resultRef, result.resultRef);
    assert.equal(requests(), 2);
  });
});

test('capability preflight and segment rejection expose identical complete gaps without dispatch', { timeout: 180000 }, async () => {
  await product('local', () => assert.fail('capability decision must not send'), async ({ api, baseUrl, requests }) => {
    const connection = config(baseUrl); assert.equal((await api('models/connections', connection)).status, 200);
    const source = { connectionId: connection.connectionId, version: 1 };
    const prefix = { system: 'Review capability', tools: [{ ...tool, strict: true }], options: {
      requiredCapabilities: ['images', 'nativeReplay'], responseFormat: { kind: 'json-schema', name: 'answer', schema: { type: 'object' }, strict: true } } };
    const decision = await api('models/capabilities', { source, prefix });
    assert.equal(decision.status, 200); assert.equal(decision.value.available, false);
    assert.equal(decision.value.configurationVersion, 1);
    assert.deepEqual(new Set(decision.value.missing.map(item => item.capability)), new Set(['images', 'nativeReplay', 'nativeStrict', 'strictTools']));
    const created = await api('models/segments', { requestId: randomUUID(), segmentId: randomUUID(), source, prefix, portable: [] });
    assert.equal(created.status, 422); assert.equal(created.value.error, 'capability-unavailable');
    assert.deepEqual(created.value.decision, decision.value); assert.equal(requests(), 0);
  });
});

test('raw SSE comments are bounded before SDK parsing and their failure stays readable after restart', { timeout: 180000 }, async () => {
  await product('local', (_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(':' + 'x'.repeat(2_100_000) + '\n\n'); send(response, chat({ content: 'too late' }, 'stop')); response.end('data: [DONE]\n\n');
  }, async ({ api, baseUrl, segment, finish, restart, requests }) => {
    const connection = config(baseUrl); assert.equal((await api('models/connections', connection)).status, 200);
    const result = await finish(input(await segment(connection)));
    assert.equal(result.state, 'incomplete'); assert.equal(result.reason, 'response-limit'); assert.deepEqual(result.toolIntents, []);
    await restart(); assert.equal((await api(`models/calls/${result.attemptId}`)).value.resultRef, result.resultRef);
    assert.equal((await api(`models/calls/${result.attemptId}/dispatch`, {})).value.reason, 'response-limit'); assert.equal(requests(), 1);
  });
});
