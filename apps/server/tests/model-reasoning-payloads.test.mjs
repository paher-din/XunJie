import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';

// Compile the real modules in isolation; tests neither overwrite dist nor need
// a live provider, stored credentials, a product install or a catalog download.
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'xj-reasoning-payloads-'));
after(() => rm(temporary, { recursive: true, force: true }));
await symlink(join(repository, 'node_modules'), join(temporary, 'node_modules'), 'junction');
await build({ stdin: { contents: `
  export * from './packages/learning-space/src/model-connections/transport.ts';
  export * from './packages/learning-space/src/model-connections/capabilities.ts';
  export * from './packages/learning-space/src/model-connections/service.ts';
  export { createChatWork } from './packages/learning-space/src/model-connections/chat-work.ts';
`, resolveDir: repository }, outfile: join(temporary, 'source.mjs'), bundle: true, platform: 'node',
  format: 'esm', packages: 'external', alias: { '@xunjie/contracts': join(repository, 'packages/contracts/src') } });
const { adapterReady, connectionCheckPayload, limitPayload, runModel, measuredCapabilities, decideModelCapabilities,
  parseLearningModelResult, createLearningModelService, createLearningModelClient, createChatWork } = await import(pathToFileURL(join(temporary, 'source.mjs')));
const identity = { kind: 'personal', name: 'Reasoning fixture', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
function configuration(protocol, modelId, changes = {}) {
  const host = /^(?:deepseek\/)?deepseek-/.test(modelId) ? 'api.deepseek.com' : 'relay.example';
  return { connectionId: randomUUID(), name: 'Reasoning fixture', protocol, modelId,
    baseUrl: `https://${host}${protocol === 'messages' ? '/anthropic' : '/v1'}`,
    path: { 'chat-completions': '/chat/completions', responses: '/responses', messages: '/v1/messages' }[protocol],
    dialect: 'standard', parameterMode: 'thinking', enabled: true, ...changes };
}
const snap = payload => parseLearningModelResult('checks.requestPayload', JSON.parse(JSON.stringify(payload)));
const reasoningFields = payload => Object.fromEntries(Object.entries(payload).filter(([key]) =>
  ['thinking', 'enable_thinking', 'reasoning_effort', 'reasoning', 'output_config'].includes(key)));
const cases = [
  ['chat-completions', 'openai/gpt-5.2', 'xhigh', {}, { reasoning_effort: 'xhigh' }],
  ['chat-completions', 'gpt-5', 'minimal', {}, { reasoning_effort: 'minimal' }],
  ['chat-completions', 'deepseek/deepseek-v4.1-flash', 'max', { dialect: 'deepseek' }, { thinking: { type: 'enabled' }, reasoning_effort: 'max' }],
  ['chat-completions', 'qwen3-32b', 'none', {}, { enable_thinking: false }],
  ['chat-completions', 'glm-5.3', 'low', {}, { thinking: { type: 'enabled' }, reasoning_effort: 'low' }],
  ['chat-completions', 'gateway-alias', 'high', { reasoningLevels: ['high'], reasoningSource: 'manual' }, { reasoning_effort: 'high' }],
  ['responses', 'gpt-5.2', 'medium', {}, { reasoning: { effort: 'medium' } }],
  ['responses', 'deepseek-flash', 'max', { dialect: 'deepseek' }, { reasoning: { effort: 'max' } }],
  ['responses', 'future-model', 'max', { reasoningLevels: ['max'], reasoningSource: 'catalogue' }, { reasoning: { effort: 'max' } }],
  ['messages', 'claude-opus-4-6', 'high', {}, { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }],
  ['messages', 'claude-opus-4-5', 'medium', {}, { thinking: { type: 'enabled', budget_tokens: 1024 }, output_config: { effort: 'medium' } }],
  ['messages', 'deepseek-flash', 'max', { dialect: 'deepseek' }, { thinking: { type: 'enabled', budget_tokens: 1024 }, output_config: { effort: 'max' } }],
  ['messages', 'message-alias', 'high', { reasoningLevels: ['high'], reasoningSource: 'manual' }, { output_config: { effort: 'high' } }],
  ['chat-completions', 'deepseek/deepseek-v4.1-flash', 'high', { baseUrl: 'https://openrouter.ai/api/v1', reasoningLevels: ['high'] }, { reasoning: { effort: 'high' } }],
  ['responses', 'deepseek/deepseek-v4.1-flash', 'high', { baseUrl: 'https://openrouter.ai/api/v1', reasoningLevels: ['high'] }, { reasoning: { effort: 'high' } }],
  ['chat-completions', 'deepseek/deepseek-v4.1-flash', 'max', { baseUrl: 'https://relay.example/v1', reasoningLevels: ['max'] }, { reasoning_effort: 'max' }],
];

test('native checks and strict JSON snapshots retain actual multi-provider reasoning parameters', () => {
  for (const [protocol, modelId, reasoningEffort, changes, expected] of cases) {
    const fixed = configuration(protocol, modelId, { reasoningEffort, ...changes });
    assert.equal(adapterReady(fixed), true, modelId);
    const payload = connectionCheckPayload(fixed, 4096);
    assert.deepEqual(reasoningFields(payload), expected, modelId);
    assert.equal(payload.model, modelId);
    assert.deepEqual(snap(payload), payload, modelId);
    if (protocol === 'chat-completions' && (modelId.startsWith('gpt-') || modelId === 'openai/gpt-5.2')) {
      assert.equal(payload.max_completion_tokens, 4096);
      assert.equal(payload.max_tokens, undefined);
    }
  }
});

test('legacy missing effort keeps the original three-protocol wire and snapshot grammar', () => {
  for (const protocol of ['chat-completions', 'responses', 'messages']) {
    for (const parameterMode of ['plain', 'thinking']) {
      const fixed = configuration(protocol, 'fixture', { dialect: 'deepseek', parameterMode });
      const payload = connectionCheckPayload(fixed, 128);
      const expected = protocol === 'responses' ? { reasoning: { effort: parameterMode === 'thinking' ? 'high' : 'none' } }
        : { thinking: parameterMode === 'plain' ? { type: 'disabled' }
          : { type: 'enabled', ...(protocol === 'messages' ? { budget_tokens: 1024 } : {}) } };
      assert.deepEqual(reasoningFields(payload), expected);
      assert.deepEqual(snap(payload), payload);
      assert.deepEqual(reasoningFields(limitPayload(fixed, payload, 64)), expected);
    }
    assert.deepEqual(reasoningFields(connectionCheckPayload(configuration(protocol, 'fixture'), 128)), {});
  }
  const oldOpenai = connectionCheckPayload(configuration('chat-completions', 'gpt-5.2'), 128);
  assert.equal(oldOpenai.max_tokens, 128);
  assert.equal(oldOpenai.max_completion_tokens, undefined);
});

test('invalid effort and unknown Messages off switches fail before SDK dispatch', () => {
  for (const fixed of [
    configuration('chat-completions', 'gpt-5', { reasoningEffort: 'none' }),
    configuration('messages', 'gpt-5.2', { reasoningEffort: 'high' }),
    configuration('responses', 'unknown', { reasoningEffort: 'high' }),
    configuration('messages', 'message-alias', { reasoningEffort: 'none', reasoningLevels: ['none'], reasoningSource: 'manual' }),
    configuration('messages', 'message-alias', { reasoningEffort: 'minimal', reasoningLevels: ['minimal'] }),
  ]) {
    assert.equal(adapterReady(fixed), false, fixed.modelId);
    assert.throws(() => connectionCheckPayload(fixed, 4096), { code: 'invalid' }, fixed.modelId);
  }
  for (const protocol of ['chat-completions', 'responses', 'messages']) {
    const fixed = configuration(protocol, 'new-model', { reasoningEffort: 'auto', reasoningLevels: [] });
    assert.equal(adapterReady(fixed), true);
    assert.deepEqual(reasoningFields(connectionCheckPayload(fixed, 128)), {});
  }
});

test('final policy limit preserves the output field and rejects insufficient manual budgets', () => {
  const openai = configuration('chat-completions', 'gpt-5.2', { reasoningEffort: 'high' });
  const payload = connectionCheckPayload(openai, 4096);
  const limited = limitPayload(openai, payload, 64);
  assert.equal(limited.max_completion_tokens, 64);
  assert.equal(limited.max_tokens, undefined);
  assert.equal(limited.reasoning_effort, 'high');
  assert.deepEqual(snap(limited), limited);
  assert.equal(payload.max_completion_tokens, 4096);
  const claude = configuration('messages', 'claude-opus-4-5', { reasoningEffort: 'high' });
  const manual = connectionCheckPayload(claude, 4096);
  for (const tokens of [128, 1024]) assert.throws(() => limitPayload(claude, manual, tokens), { code: 'invalid' });
  assert.deepEqual(reasoningFields(limitPayload(claude, manual, 1025)), reasoningFields(manual));
  const adaptive = configuration('messages', 'claude-opus-4-6', { reasoningEffort: 'high' });
  assert.equal(limitPayload(adaptive, connectionCheckPayload(adaptive, 4096), 128).max_tokens, 128);
});

test('Messages learning payload preserves effort alongside structured output in the final snapshot', async () => {
  const fixed = configuration('messages', 'claude-opus-4-6', { reasoningEffort: 'high' });
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const segmentId = randomUUID();
  const segment = { segmentId, sequence: 0, pendingAttemptId: null, headAttemptId: null, closed: false, portable: [],
    prefix: { system: 'fixed', tools: [], options: { responseFormat: { kind: 'json-schema', name: 'result', schema, strict: true } } },
    snapshot: { connection: fixed, credentialRef: 'synthetic-reference', source: {} } };
  const work = createChatWork({ read: async () => ({ rows: [{ body: segment }] }) },
    { materialize: async () => ({ content: [], retain: async () => {} }) }, { authorize: async () => {}, assertDispatch: async () => {} });
  const prepared = await work.prepare(identity, { attemptId: randomUUID(), purpose: 'chat-probe', segmentId, expectedSequence: 0,
    input: { text: 'Return an object', images: [], observations: [], toolResults: [] }, limits: { maxOutputTokens: 4096, timeoutMs: 1000 } });
  const payload = limitPayload(fixed, prepared.payload, 128);
  assert.deepEqual(payload.output_config, { format: { type: 'json_schema', schema }, effort: 'high' });
  assert.deepEqual(payload.thinking, { type: 'adaptive' });
  assert.deepEqual(snap(payload), payload);
  const service = createLearningModelService({ checks: { read: async () => ({ purpose: 'learning' }), requestPayload: async () => payload } }, async () => {});
  const client = createLearningModelClient(async request => JSON.parse(JSON.stringify(await service(request))));
  assert.deepEqual(await client.checks.requestPayload(identity, randomUUID()), payload);
});

test('strict snapshot grammar accepts all wire efforts and rejects auto, private extras and malformed thinking', () => {
  const chat = connectionCheckPayload(configuration('chat-completions', 'custom'), 128);
  const responses = connectionCheckPayload(configuration('responses', 'custom'), 128);
  const messages = connectionCheckPayload(configuration('messages', 'custom'), 128);
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(snap({ ...chat, reasoning_effort: effort }).reasoning_effort, effort);
    assert.equal(snap({ ...responses, reasoning: { effort } }).reasoning.effort, effort);
  }
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'])
    assert.equal(snap({ ...messages, thinking: { type: 'adaptive' }, output_config: { effort } }).output_config.effort, effort);
  for (const payload of [
    { ...chat, reasoning_effort: 'auto' }, { ...chat, max_completion_tokens: 128 }, { ...chat, enable_thinking: 'true' },
    { ...chat, thinking: { type: 'adaptive' } }, { ...chat, private_reasoning: true },
    { ...responses, reasoning: { effort: 'auto' } }, { ...responses, reasoning: { effort: 'low', private: true } },
    { ...messages, output_config: { effort: 'none' } }, { ...messages, output_config: { effort: 'high', private: true } },
    { ...messages, thinking: { type: 'enabled', budget_tokens: 1023 } },
    { ...messages, thinking: { type: 'adaptive', budget_tokens: 1024 } },
    { ...messages, thinking: { type: 'disabled', budget_tokens: 1024 } },
  ]) assert.throws(() => snap(payload));
});

test('an explicit effort cannot reuse legacy fixed-route evidence as verified', () => {
  for (const protocol of ['chat-completions', 'responses', 'messages']) {
    const legacy = configuration(protocol, 'deepseek-flash', { dialect: 'deepseek',
      baseUrl: protocol === 'messages' ? 'https://api.deepseek.com/anthropic' : 'https://api.deepseek.com/v1' });
    const measured = measuredCapabilities(legacy);
    assert.equal(measured.capabilities.images, 'verified');
    for (const metadata of [{ reasoningEffort: 'max' }, { reasoningEffort: 'auto' },
      { reasoningEffort: 'high', reasoningLevels: ['high'], reasoningSource: 'catalogue' },
      { reasoningEffort: 'auto', reasoningLevels: [], reasoningSource: 'manual' }]) {
      const changed = { ...legacy, ...metadata };
      const current = measuredCapabilities(changed);
      assert.equal(current.capabilities.text, 'unknown');
      assert.equal(current.capabilities.images, 'unknown');
      assert.equal(current.capabilityEvidence, undefined);
      const decision = decideModelCapabilities({ ...changed, ...measured, version: 1, routeId: randomUUID(),
        hasCredential: true, adapterState: 'ready' }, { system: '', tools: [], options: { requiredCapabilities: ['images', 'tools', 'nativeReplay'] } });
      assert.equal(decision.available, false);
      assert.equal(decision.evidence, undefined);
      for (const capability of ['images', 'tools', 'nativeReplay', 'forcedTool'])
        assert.equal(decision.items.find(item => item.capability === capability).status, 'unknown');
      assert.equal(decision.items.find(item => item.capability === 'applicationSchema').status, 'available');
    }
  }
});

test('legacy requests retain fixed evidence and learning tools when only levels/source metadata are materialized', () => {
  for (const protocol of ['chat-completions', 'responses', 'messages']) {
    const legacy = configuration(protocol, 'deepseek-flash', { dialect: 'deepseek',
      baseUrl: protocol === 'messages' ? 'https://api.deepseek.com/anthropic' : 'https://api.deepseek.com/v1' });
    const original = measuredCapabilities(legacy);
    for (const metadata of [
      { reasoningLevels: ['none', 'low', 'high', 'max'], reasoningSource: 'catalogue' },
      { reasoningLevels: ['high'], reasoningSource: 'profile' },
      { reasoningLevels: [], reasoningSource: 'manual' },
    ]) {
      const fixed = { ...legacy, ...metadata };
      assert.deepEqual(connectionCheckPayload(fixed, 128), connectionCheckPayload(legacy, 128));
      assert.deepEqual(measuredCapabilities(fixed), original);
      const decision = decideModelCapabilities({ ...fixed, ...measuredCapabilities(fixed), version: 1, routeId: randomUUID(),
        hasCredential: true, adapterState: 'ready' }, { system: '', tools: [], options: { requiredCapabilities: ['text', 'images', 'tools', 'nativeReplay'] } });
      assert.equal(decision.available, true);
      assert.deepEqual(decision.missing, []);
      assert.equal(decision.evidence.adapter, original.capabilityEvidence.adapter);
      assert.equal(decision.items.find(item => item.capability === 'tools').evidence.source, 'measured-route');
    }
    const unknown = configuration(protocol, 'new-model', { reasoningLevels: ['high'], reasoningSource: 'catalogue' });
    assert.equal(measuredCapabilities(unknown).capabilities.tools, 'unknown');
  }
});

test('actual SDK HTTP bodies retain the selected effort and match strict request snapshots', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    // The fixture refuses after capturing the request; it asserts wire encoding,
    // without pretending to verify a real provider or its model capabilities.
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Fixture captured request.' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const [protocol, modelId, reasoningEffort, changes] of cases) {
      const fixed = configuration(protocol, modelId, { ...changes, reasoningEffort });
      const payload = connectionCheckPayload(fixed, 4096);
      // Retain the actual route identity for dialect resolution; redirect the
      // SDK's injected transport to the local recorder without provider traffic.
      const requestFetch = (url, init) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url instanceof Request ? url.url : String(url)).pathname}`, init);
      const result = await runModel(fixed, 'synthetic-reasoning-fixture-key', payload, new AbortController().signal, 3000, false,
        undefined, requestFetch);
      assert.equal(result.state, 'failed');
      assert.equal(result.upstream.httpStatus, 400);
      const actual = requests.at(-1);
      assert.equal(actual.path, new URL(fixed.baseUrl).pathname + fixed.path);
      assert.deepEqual(actual.body, payload, modelId);
      assert.deepEqual(snap(actual.body), payload, modelId);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
