import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { build } from 'esbuild';
import { provisionStorage, openStorage, createFileBackend } from '@xunjie/storage';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';

// Real durable checks, current contracts and installed SDKs, isolated from shared dist.
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'xj-configuration-check-'));
after(() => rm(temporary, { recursive: true, force: true }));
await symlink(join(repository, 'node_modules'), join(temporary, 'node_modules'), 'junction');
await build({ stdin: { contents: `
  export { createChecks } from './packages/model-gateway/src/checks.ts';
  export { modelMigrations } from './packages/model-gateway/src/index.ts';
  export { errorFacts, responseFacts, networkFailureReason } from './packages/model-gateway/src/upstream-facts.ts';
  export { resolveModelTarget } from './packages/model-gateway/src/network-policy.ts';
  export { resolveModelCapacity } from './packages/contracts/src/model-connections.ts';
  export { testVerdict } from './packages/model-gateway/src/test-payload.ts';
`, resolveDir: repository }, outfile: join(temporary, 'checks.mjs'), bundle: true, platform: 'node',
  format: 'esm', packages: 'external', alias: { '@xunjie/contracts': join(repository, 'packages/contracts/src') } });
const { createChecks, modelMigrations, errorFacts, responseFacts, networkFailureReason, resolveModelTarget, resolveModelCapacity, testVerdict } =
  await import(pathToFileURL(join(temporary, 'checks.mjs')));
let fixture;
before(async () => { fixture = await nativeFixture(); });
after(async () => { await fixture?.close(); });
const protocols = ['chat-completions', 'responses', 'messages'];
const key = 'synthetic-review-key-A9x7B6v5C4n3M2p1Q0r8T7s6';
const event = value => 'data: ' + JSON.stringify(value) + '\n\n';
const response = (protocol, text, complete = true) => {
  if (protocol === 'chat-completions') return new Response(event({ choices: [{ index: 0,
    delta: { role: 'assistant', content: text }, finish_reason: complete ? 'stop' : null }] }) + 'data: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } });
  if (protocol === 'responses') return new Response(event({ type: complete ? 'response.completed' : 'response.incomplete', response: {
    id: 'resp-synthetic', object: 'response', status: complete ? 'completed' : 'incomplete',
    output: [{ id: 'msg-synthetic', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
    usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 } } }), { headers: { 'content-type': 'text/event-stream' } });
  return new Response([
    { type: 'message_start', message: { id: 'msg-synthetic', type: 'message', role: 'assistant', model: 'claude-opus-4-5', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    ...(complete ? [{ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: 'message_stop' }] : []),
  ].map(value => 'event: ' + value.type + '\n' + event(value)).join(''), { headers: { 'content-type': 'text/event-stream' } });
};

async function harness(protocol, options = {}) {
  const identity = { kind: 'personal', name: 'Synthetic model test', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
  const connection = { connectionId: randomUUID(), name: 'Synthetic model', protocol, version: 1, routeId: randomUUID(),
    baseUrl: 'https://relay.example' + (protocol === 'messages' ? '' : '/v1'),
    path: { 'chat-completions': '/chat/completions', responses: '/responses', messages: '/v1/messages' }[protocol],
    modelId: protocol === 'messages' ? 'claude-opus-4-5' : 'gpt-5.2', dialect: 'standard', parameterMode: 'thinking', reasoningEffort: 'high',
    enabled: true, hasCredential: true, adapterState: 'ready', maxOutputTokens: 8192, imageInput: true,
    capabilities: { text: 'verified', images: 'unknown', tools: 'unknown', strictSchema: 'unknown' }, ...options.connection };
  const binding = await provisionStorage({ admin: fixture.admin, owner: { environmentId: identity.environmentId, serviceId: randomUUID() },
    password: randomUUID(), migrations: modelMigrations });
  const storage = await openStorage({ binding, migrations: modelMigrations, backend: createFileBackend({ id: 'files', root: fixture.root + '/' + identity.environmentId }) });
  const requests = [];
  const owner = { authorize: async () => {}, snapshot: async () => ({ connection, credentialRef: randomUUID(), ...options.snapshot }),
    prepareChat: async () => { throw new Error('Configuration test must not prepare chat'); }, publishChat: async () => {},
    credential: async () => key, assertDispatch: async () => {},
    requestFetch: async () => {
      if (options.preflightError) throw options.preflightError;
      return async (input, init) => {
        requests.push({ url: String(input), payload: JSON.parse(init.body), headers: new Headers(init.headers) });
        return options.fetch ? options.fetch(input, init) : response(protocol, options.text ?? '你好，连接正常。', options.complete ?? true);
      };
    } };
  let checks = createChecks(storage, owner);
  const source = { connectionId: connection.connectionId, version: connection.version };
  const input = (item = 'text', limits = {}) => ({ attemptId: randomUUID(), purpose: 'connection-check', source,
    test: { runId: randomUUID(), item }, limits: { maxOutputTokens: 128, timeoutMs: 120000, ...limits } });
  const wait = async attemptId => {
    for (let count = 0; count < 500; count++) {
      const current = await checks.read(identity, attemptId);
      if (current.physicalRequestEnded && current.state !== 'accepted') return current;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Synthetic configuration check did not settle');
  };
  return { connection, storage, requests, identity, input, get checks() { return checks; },
    run: async value => { await checks.receive(identity, value); await checks.dispatch(identity, value.attemptId); return wait(value.attemptId); },
    reopen: async () => { checks.closeAdmission(); checks.closeDispatch(); await checks.drain(); checks = createChecks(storage, owner); await checks.validate(); },
    close: async () => { checks.closeAdmission(); checks.closeDispatch(); try { await checks.drain(); } finally { await storage.close(); } } };
}

test('personal configuration checks have no hourly quota across successes, failures and restart', async () => {
  const ownerScope = randomUUID();
  const h = await harness('chat-completions', { snapshot: {
    source: { kind: 'personal', ownerScope, feeSource: ownerScope },
  } });
  try {
    for (let index = 0; index < 8; index++) {
      if (index === 6) await h.reopen();
      const item = index % 2 === 0 ? 'text' : 'images';
      const result = await h.run(h.input(item));
      assert.equal(result.state, item === 'text' ? 'completed' : 'failed');
      assert.equal(result.physicalRequestEnded, true);
    }
    assert.equal(h.requests.length, 8);
  } finally { await h.close(); }
});

test('school configuration checks retain their configured hourly quota', async () => {
  const ownerScope = randomUUID();
  const h = await harness('chat-completions', { snapshot: {
    source: { kind: 'school', ownerScope, feeSource: ownerScope },
    policy: { checksAllowed: true, maxChecksPerHour: 2, maxOutputTokens: 8192, timeoutMs: 120000 },
  } });
  try {
    await h.run(h.input());
    await h.run(h.input());
    await assert.rejects(h.run(h.input()), { code: 'resource-busy' });
    assert.equal(h.requests.length, 2);
  } finally { await h.close(); }
});

for (const protocol of protocols) test(`${protocol}: durable configuration text test uses actual output/thinking limits and visible completion`, async () => {
  const h = await harness(protocol);
  try {
    const value = h.input(), result = await h.run(value);
    assert.equal(result.state, 'completed'); assert.equal(result.text, '你好，连接正常。'); assert.deepEqual(result.test, value.test);
    assert.equal(result.limits.maxOutputTokens, 8192); assert.equal(result.limits.timeoutMs, 120000);
    const payload = h.requests[0].payload;
    assert.equal(payload.max_completion_tokens ?? payload.max_output_tokens ?? payload.max_tokens, 8192);
    if (protocol === 'messages') { assert.deepEqual(payload.thinking, { type: 'enabled', budget_tokens: 1024 }); assert.equal(payload.output_config.effort, 'high'); }
    else assert.equal(payload.reasoning?.effort ?? payload.reasoning_effort, 'high');
    assert.equal(h.requests[0].url, h.connection.baseUrl + h.connection.path);
    await h.reopen();
    assert.deepEqual((await h.checks.read(h.identity, value.attemptId)).test, value.test);
    assert.equal((await h.checks.receive(h.identity, value)).state, 'completed');
    await h.checks.dispatch(h.identity, value.attemptId); assert.equal(h.requests.length, 1);
  } finally { await h.close(); }
});

for (const protocol of protocols) test(`${protocol}: backend PNG reaches the native image input without an answer hint`, async () => {
  const h = await harness(protocol, { text: protocol === 'responses' ? 'A red square on a white background.' : '红色的正方形。' });
  try {
    const result = await h.run(h.input('images')); assert.equal(result.state, 'completed');
    const payload = h.requests[0].payload;
    const content = protocol === 'responses' ? payload.input[0].content : payload.messages[0].content;
    assert.equal(content.length, 2); assert.match(content[0].text, /color/); assert.doesNotMatch(content[0].text, /red|square|红|方/);
    let encoded;
    if (protocol === 'messages') { assert.equal(content[1].type, 'image'); assert.equal(content[1].source.media_type, 'image/png'); encoded = content[1].source.data; }
    else { assert.equal(content[1].type, protocol === 'responses' ? 'input_image' : 'image_url');
      encoded = (protocol === 'responses' ? content[1].image_url : content[1].image_url.url).split(',')[1]; }
    const png = Buffer.from(encoded, 'base64');
    assert.equal(png.readUInt32BE(16), 64); assert.equal(png.readUInt32BE(20), 64);
    const pixels = inflateSync(png.subarray(41, png.length - 16));
    assert.deepEqual([...pixels.subarray(32 * 193 + 1 + 32 * 3, 32 * 193 + 1 + 32 * 3 + 3)], [255, 0, 0]);
    assert.equal(result.connection.capabilities.images, 'unknown'); assert.equal(result.connection.capabilityEvidence, undefined);
  } finally { await h.close(); }
});

test('incorrect image answers fail this test without changing capability evidence', async () => {
  for (const text of ['blue circle', 'OK', 'It is not a red square.', '无法确认，可能是红色方块']) {
    const h = await harness('chat-completions', { text });
    try {
      const result = await h.run(h.input('images'));
      assert.equal(result.state, 'failed'); assert.equal(result.reason, 'image-understanding-unverified');
      assert.equal(result.diagnostic.message, '图片理解未验证通过'); assert.equal(result.connection.capabilities.images, 'unknown');
    } finally { await h.close(); }
  }
});

test('image permission and school policy rejection persist a diagnostic without dispatch or clamping', async () => {
  for (const [changes, policy, item, code] of [
    [{ imageInput: false, capabilities: { text: 'verified', images: 'verified', tools: 'unknown', strictSchema: 'unknown' } }, undefined, 'images', 'image-input-disabled'],
    [{ imageInput: undefined }, undefined, 'images', 'image-input-disabled'],
    [{}, { maxOutputTokens: 128, timeoutMs: 120000, maxChecksPerHour: 6 }, 'text', 'test-policy-output-limit'],
    [{}, { maxOutputTokens: 8192, timeoutMs: 30000, maxChecksPerHour: 6 }, 'text', 'test-policy-timeout'],
  ]) {
    const h = await harness('messages', { connection: changes, snapshot: { policy } });
    try {
      const value = h.input(item), accepted = await h.checks.receive(h.identity, value);
      assert.equal(accepted.state, 'failed'); assert.equal(accepted.reason, code); assert.equal(accepted.diagnostic.code, code);
      assert.equal(accepted.limits.maxOutputTokens, 8192); assert.equal(accepted.limits.timeoutMs, 120000);
      const result = await h.run(value); assert.equal(result.dispatched, false); assert.equal(h.requests.length, 0);
      await h.reopen(); assert.deepEqual((await h.checks.read(h.identity, value.attemptId)).diagnostic, accepted.diagnostic);
    } finally { await h.close(); }
  }
});

test('Messages rejects a manually declared minimal level locally even when the default is auto', async () => {
  const h = await harness('messages', { connection: { modelId: 'message-alias', reasoningEffort: 'auto',
    reasoningLevels: ['minimal'], reasoningSource: 'manual' } });
  try {
    const value = h.input(), accepted = await h.checks.receive(h.identity, value);
    assert.equal(accepted.state, 'failed'); assert.equal(accepted.reason, 'test-reasoning-configuration');
    assert.equal(accepted.diagnostic.code, 'test-reasoning-configuration');
    assert.equal(accepted.diagnostic.field, 'reasoningEffort'); assert.match(accepted.diagnostic.message, /minimal/);
    assert.equal(accepted.connection.reasoningEffort, 'auto'); assert.deepEqual(accepted.connection.reasoningLevels, ['minimal']);
    assert.equal(accepted.dispatched, false); assert.equal(accepted.physicalRequestEnded, true); assert.equal(accepted.resultRef, null);
    const result = await h.checks.dispatch(h.identity, value.attemptId);
    assert.equal(result.state, 'failed'); assert.equal(result.dispatched, false); assert.equal(h.requests.length, 0);
    await h.reopen();
    const restored = await h.checks.read(h.identity, value.attemptId);
    assert.deepEqual(restored.diagnostic, accepted.diagnostic); assert.deepEqual(restored.test, value.test);
    assert.equal(h.requests.length, 0);
  } finally { await h.close(); }
});

test('default capacity and controlled shorter deadlines still come from the effective snapshot', async () => {
  const h = await harness('messages', { connection: { maxOutputTokens: undefined } });
  try {
    const result = await h.run(h.input('text', { timeoutMs: 250 }));
    assert.equal(result.state, 'completed'); assert.equal(result.limits.timeoutMs, 250);
    assert.equal(h.requests[0].payload.max_tokens, resolveModelCapacity({}).maxOutputTokens);
  } finally { await h.close(); }
});

test('ten-million-token configuration is preserved, while legacy checks retain caller/policy limits', async () => {
  const h = await harness('chat-completions', { connection: { maxOutputTokens: 10_000_000 } });
  try { const result = await h.run(h.input()); assert.equal(result.state, 'completed'); assert.equal(result.limits.maxOutputTokens, 10_000_000);
    assert.equal(h.requests[0].payload.max_completion_tokens, 10_000_000); }
  finally { await h.close(); }
  const legacy = await harness('chat-completions', { snapshot: { policy: { maxOutputTokens: 512, timeoutMs: 10000, maxChecksPerHour: 6 } } });
  try {
    const value = legacy.input('text', { maxOutputTokens: 1024, timeoutMs: 30000 }); delete value.test;
    const result = await legacy.run(value); assert.equal(result.state, 'completed'); assert.equal(result.test, undefined);
    assert.deepEqual(result.limits, { maxOutputTokens: 512, timeoutMs: 10000 }); assert.equal(legacy.requests[0].payload.max_completion_tokens, 512);
  } finally { await legacy.close(); }
});

for (const protocol of protocols) test(`${protocol}: actual deadlines and active cancellation settle without success or replay`, async () => {
  for (const cancel of [false, true]) {
    let started;
    const opening = new Promise(resolve => { started = resolve; });
    const h = await harness(protocol, { fetch: async (_input, init) => {
      started();
      return new Promise((_resolve, reject) => {
        if (init.signal.aborted) reject(init.signal.reason);
        else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    } });
    try {
      const value = h.input('text', { timeoutMs: cancel ? 2000 : 250 });
      const settled = h.run(value); await opening;
      if (cancel) await h.checks.cancel(h.identity, value.attemptId);
      const result = await settled;
      assert.notEqual(result.state, 'completed'); assert.equal(result.physicalRequestEnded, true);
      assert.equal(result.reason, cancel ? 'client-abort' : 'timeout'); assert.ok(result.diagnostic);
      assert.deepEqual(result.test, value.test); await h.checks.dispatch(h.identity, value.attemptId); assert.equal(h.requests.length, 1);
    } finally { await h.close(); }
  }
});

for (const protocol of protocols) test(`${protocol}: no empty, incomplete, unknown or cancelled test can succeed`, async () => {
  for (const options of [{ text: '' }, { text: ' \n\u200b\u200d\u2060' }, { complete: false }, { fetch: async () => { throw new TypeError('fetch failed'); } }]) {
    const h = await harness(protocol, options);
    try { const result = await h.run(h.input()); assert.notEqual(result.state, 'completed'); assert.ok(result.diagnostic); }
    finally { await h.close(); }
  }
  const h = await harness(protocol);
  try {
    const value = h.input(); await h.checks.receive(h.identity, value);
    const result = await h.checks.cancel(h.identity, value.attemptId);
    assert.equal(result.state, 'cancelled'); assert.deepEqual(result.test, value.test);
    await h.checks.dispatch(h.identity, value.attemptId); assert.equal(h.requests.length, 0);
  } finally { await h.close(); }
});

for (const protocol of protocols) test(`${protocol}: provider errors retain safe bounded facts and redact credentials, fragments and auth headers`, async () => {
  const fragment = key.slice(-14), auth = 'reusable-auth-material';
  const h = await harness(protocol, { fetch: async () => new Response(JSON.stringify({ error: {
    code: 'unsupported_parameter', type: 'invalid_request_error', param: 'max_tokens',
    message: `invalid max_tokens ${key} fragment=${fragment}; Authorization: Bearer ${auth}\n` + 'x'.repeat(1400),
    thinking: 'PRIVATE-REASONING', body: 'RAW-ERROR-BODY',
  } }), { status: 400, headers: { 'content-type': 'application/json', 'x-request-id': 'req-demo-1234', 'retry-after': '17' } }) });
  try {
    const result = await h.run(h.input()); assert.equal(result.state, 'failed');
    assert.equal(result.reason, 'upstream-unsupported'); assert.equal(result.upstream.httpStatus, 400);
    assert.equal(result.upstream.errorCode, 'unsupported_parameter'); assert.equal(result.upstream.parameter, 'max_tokens');
    assert.equal(result.upstream.requestId, 'req-demo-1234'); assert.equal(result.upstream.retryAfterSeconds, 17);
    assert.ok(result.upstream.message.length <= 1000);
    const serialized = JSON.stringify(result);
    for (const secret of [key, fragment, auth, 'PRIVATE-REASONING', 'RAW-ERROR-BODY']) assert.equal(serialized.includes(secret), false);
  } finally { await h.close(); }
});

for (const protocol of protocols) test(`${protocol}: durable diagnostics distinguish authentication, permissions, routes, parameters, quota and service errors`, async () => {
  for (const [status, errorCode, parameter, diagnosticCode, field] of [
    [401, 'invalid_api_key', undefined, 'authentication', 'apiKey'],
    [403, 'permission_denied', undefined, 'upstream-permission', undefined],
    [404, 'model_not_found', undefined, 'model-not-found', 'modelId'],
    [404, 'not_found_error', undefined, 'upstream-path-not-found', 'baseUrl'],
    [400, 'unsupported_parameter', 'reasoning.effort', 'invalid-reasoning-parameter', 'reasoningEffort'],
    [422, 'invalid_request_error', 'max_output_tokens', 'invalid-output-limit', 'maxOutputTokens'],
    [400, 'invalid_request_error', 'messages.0.content.1.image_url', 'image-input-rejected', 'imageInput'],
    [429, 'insufficient_quota', undefined, 'upstream-quota', undefined],
    [429, 'rate_limit_exceeded', undefined, 'rate-limited', undefined],
    [503, 'overloaded_error', undefined, 'upstream-service', undefined],
  ]) {
    const h = await harness(protocol, { fetch: async () => new Response(JSON.stringify({ error: {
      code: errorCode, type: errorCode, param: parameter, message: 'Provider detail',
    } }), { status, headers: { 'content-type': 'application/json' } }) });
    try {
      const result = await h.run(h.input());
      assert.equal(result.state, 'failed'); assert.equal(result.diagnostic.code, diagnosticCode, `${protocol} ${status} ${errorCode}`);
      assert.equal(result.diagnostic.field, field); assert.equal(result.upstream.errorCode, errorCode);
      assert.equal(result.upstream.message, 'Provider detail');
    } finally { await h.close(); }
  }
});

test('parameter diagnostics identify configuration fields, while unknown/incomplete do not conclude configuration failure', () => {
  const test = { runId: randomUUID(), item: 'text' };
  for (const [parameter, errorCode, code, field] of [
    ['thinking.budget_tokens', 'invalid_request_error', 'invalid-reasoning-parameter', 'reasoningEffort'],
    ['output_config.effort', 'unsupported_value', 'invalid-reasoning-parameter', 'reasoningEffort'],
    ['model', 'invalid_request_error', 'invalid-model-parameter', 'modelId'],
    [undefined, 'model_not_found', 'invalid-model-parameter', 'modelId'],
    ['max_tokens', 'unsupported_parameter', 'invalid-output-limit', 'maxOutputTokens'],
    ['max_completion_tokens', 'invalid_request_error', 'invalid-output-limit', 'maxOutputTokens'],
    [undefined, 'image_not_supported', 'image-input-rejected', 'imageInput'],
    [undefined, 'context_length_exceeded', 'context-capacity-exceeded', 'contextWindow'],
    [undefined, 'invalid_request_error', 'upstream-request-rejected', undefined],
  ]) {
    const result = testVerdict(test, { state: 'failed', reason: 'upstream-http', text: '', upstream: { httpStatus: 400, parameter, errorCode } });
    assert.equal(result.diagnostic.code, code); assert.equal(result.diagnostic.field, field);
  }
  for (const state of ['unknown', 'incomplete']) {
    const result = testVerdict(test, { state, reason: 'missing-terminal', text: 'partial', upstream: { httpStatus: 200 } });
    assert.equal(result.state, state); assert.equal(result.diagnostic.field, undefined); assert.match(result.diagnostic.message + result.diagnostic.suggestion, /不能判断|不足以判断/);
  }
});

for (const protocol of protocols) test(`${protocol}: SDK cause chains distinguish DNS, TLS and timeout safely`, async () => {
  for (const [code, reason] of [['ENOTFOUND', 'upstream-dns'], ['CERT_HAS_EXPIRED', 'upstream-tls'], ['ETIMEDOUT', 'upstream-timeout']]) {
    const h = await harness(protocol, { fetch: async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error(key), { code }) }); } });
    try {
      const result = await h.run(h.input()); assert.notEqual(result.state, 'completed');
      assert.equal(result.reason, reason); assert.equal(result.upstream.networkCode, code); assert.equal(JSON.stringify(result).includes(key), false);
    } finally { await h.close(); }
  }
});

test('DNS preflight preserves storage error semantics and safe attribution before any SDK request', async () => {
  let failure;
  try { await resolveModelTarget({ baseUrl: 'https://relay.example', path: '/v1/messages' }, 'public', async () => {
    throw Object.assign(new Error('private hostname'), { code: 'ENOTFOUND' });
  }); } catch (error) { failure = error; }
  assert.equal(failure.code, 'unavailable'); assert.deepEqual(failure.cause, { code: 'ENOTFOUND' });
  const h = await harness('messages', { preflightError: failure });
  try { const result = await h.run(h.input()); assert.equal(result.state, 'failed'); assert.equal(result.reason, 'upstream-dns');
    assert.equal(result.dispatched, false); assert.equal(h.requests.length, 0); }
  finally { await h.close(); }
});

test('shared diagnostic projection is bounded and ignores bodies, headers, thinking and unknown network data', () => {
  const error = Object.assign(new Error('safe message'), { error: { code: 'x'.repeat(150), param: 'p'.repeat(150), message: 'm'.repeat(1500),
    headers: { authorization: key }, thinking: key, body: key }, cause: { code: 'EVIL_' + key, cause: { code: 'EAI_AGAIN' } } });
  const facts = errorFacts(error, key);
  assert.equal(facts.errorCode.length, 100); assert.equal(facts.parameter.length, 100); assert.equal(facts.message.length, 1000);
  assert.equal(facts.networkCode, 'EAI_AGAIN'); assert.equal(networkFailureReason(facts), 'upstream-dns');
  assert.equal(JSON.stringify(facts).includes(key), false);
  assert.equal(responseFacts(429, new Headers({ 'x-request-id': key.slice(-14), 'retry-after-ms': '1500' }), key).requestId, undefined);
  assert.equal(errorFacts(Object.assign(new Error('400 RAW-HTTP-BODY'), { status: 400 }), key).message, undefined);
  assert.equal(errorFacts({ error: 'RAW-HTTP-BODY', message: '400 RAW-HTTP-BODY' }, key).message, undefined);
  for (const encoded of [key, encodeURIComponent(key), Buffer.from(key).toString('base64'), key.slice(4, 17), key.slice(-14)])
    assert.equal(JSON.stringify(errorFacts({ error: { code: encoded, param: encoded, message: encoded } }, key)).includes(encoded), false);
  const cycle = { code: 'ETIMEDOUT' }; cycle.cause = cycle;
  assert.equal(errorFacts(cycle, key).networkCode, 'ETIMEDOUT');
});
