import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';

// Exercise current source without overwriting dist or requiring PostgreSQL.
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'xj-capability-images-'));
after(() => rm(temporary, { recursive: true, force: true }));
await symlink(join(repository, 'node_modules'), join(temporary, 'node_modules'), 'junction');
await build({ stdin: { contents: `
  export * as capabilities from './packages/model-gateway/src/capabilities.ts';
  export * as contracts from './packages/contracts/src/model-connections.ts';
  export { createChatWork } from './packages/model-gateway/src/chat-work.ts';
  export { routeModels } from './packages/model-gateway/src/wire.ts';
  export { learningFailure } from './packages/product-runtime/src/learning-http/index.ts';
  export { runChat } from './packages/model-gateway/src/chat.ts';
  export { imageRoute } from './packages/agents/src/capabilities/documents/tools-images.ts';
`, resolveDir: repository }, outfile: join(temporary, 'source.mjs'), bundle: true, platform: 'node',
  format: 'esm', packages: 'external', alias: { '@xunjie/contracts': join(repository, 'packages/contracts/src'), '@xunjie/model-gateway': join(repository, 'packages/model-gateway/src') } });
const { capabilities, contracts, createChatWork, routeModels, learningFailure, runChat, imageRoute } = await import(pathToFileURL(join(temporary, 'source.mjs')));
const identity = { kind: 'personal', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
const tool = { name: 'read_marker', description: '', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
function connection(overrides = {}) {
  return { connectionId: randomUUID(), name: 'PRIVATE-DISPLAY', protocol: 'chat-completions', baseUrl: 'https://private-route.example/v1',
    path: '/chat/completions', modelId: 'PRIVATE-MODEL', dialect: 'standard', parameterMode: 'plain', enabled: true,
    version: 3, routeId: randomUUID(), hasCredential: true, adapterState: 'ready',
    capabilities: { text: 'verified', images: 'unknown', tools: 'verified', nativeReplay: 'unknown', strictSchema: 'unsupported', strictTools: 'unsupported' }, ...overrides };
}
function fixture(fixed = connection()) {
  const resources = new Map(), segments = new Map(), facts = new Map(), settled = new Map();
  let snapshots = 0, writes = 0, dispatches = 0;
  const snapshot = { connection: fixed, credentialRef: 'PRIVATE-CREDENTIAL', source: { kind: 'personal', ownerScope: 'PRIVATE-SCOPE', feeSource: 'PRIVATE-FEE' } };
  const storage = { receipt: async () => null, readResource: async ref => resources.get(ref),
    async read(sql, args) {
      const body = sql.includes('FROM model_segments') ? segments.get(args[0]) : sql.includes('FROM model_attempts') ? facts.get(args[0])
        : sql.includes('FROM model_tool_results') ? settled.get(args[0]) : undefined;
      return { rows: body ? [{ body }] : [] };
    }, request: async () => { writes++; throw new Error('unexpected write'); } };
  const imageBytes = new Map(), materialized = [], retained = [];
  const images = { async materialize(_identity, references) {
    materialized.push(...references);
    return { content: references.map(ref => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageBytes.get(ref.imageId) } })),
      async retain(_tx, attemptId) { retained.push(...references.map(ref => ({ ...ref, attemptId }))); } };
  } };
  const owner = { authorize: async () => {}, assertWritable() {}, readPortable: async () => {},
    snapshot: async () => { snapshots++; return snapshot; }, assertDispatch: async () => { dispatches++; } };
  return { fixed, snapshot, resources, segments, facts, settled, imageBytes, materialized, retained,
    work: createChatWork(storage, images, owner), counts: () => ({ snapshots, writes, dispatches }) };
}
const prefix = options => ({ system: 'fixed', tools: [tool], options });
test('explicit image permission enables an unmeasured route without upgrading measured evidence', async () => {
  const fixed = connection({ imageInput: true }), before = structuredClone(fixed.capabilities);
  const decision = capabilities.decideModelCapabilities(fixed, prefix({ requiredCapabilities: ['images'] }));
  assert.equal(decision.available, true);
  assert.deepEqual(decision.items.find(item => item.capability === 'images').evidence, { state: 'declared', source: 'user-configuration' });
  assert.deepEqual(fixed.capabilities, before);
  assert.equal((await imageRoute({ identity, segmentId: 'fixed' }, { segments: { read: async () => ({ connection: fixed }) } })).available, true);
  fixed.imageInput = false; fixed.capabilities.images = 'verified';
  assert.equal(capabilities.decideModelCapabilities(fixed, prefix({ requiredCapabilities: ['images'] })).available, false);
  assert.equal((await imageRoute({ identity, segmentId: 'fixed' }, { segments: { read: async () => ({ connection: fixed }) } })).available, false);
  delete fixed.imageInput;
  assert.equal((await imageRoute({ identity, segmentId: 'fixed' }, { segments: { read: async () => ({ connection: fixed }) } })).available, true);
});
for (const protocol of ['chat-completions', 'responses', 'messages']) test(`${protocol}: explicit image disable blocks native image dispatch`, async () => {
  const f = fixture(connection({ protocol, imageInput: false,
    path: { 'chat-completions': '/chat/completions', responses: '/responses', messages: '/v1/messages' }[protocol] }));
  const segmentId = randomUUID(), image = { imageId: randomUUID(), version: 1 };
  f.imageBytes.set(image.imageId, 'aGVsbG8=');
  f.segments.set(segmentId, { segmentId, sequence: 0, snapshot: f.snapshot, prefix: { system: 'fixed', tools: [] }, portable: [],
    headAttemptId: null, pendingAttemptId: null, closed: false });
  const input = { attemptId: randomUUID(), purpose: 'chat-probe', segmentId, expectedSequence: 0,
    input: { text: 'image', images: [image], toolResults: [], observations: [] }, limits: { maxOutputTokens: 128, timeoutMs: 1000 } };
  await assert.rejects(f.work.prepare(identity, input), error => error instanceof capabilities.ModelCapabilityError
    && error.decision.limitations.includes('image-input-disabled'));
  f.fixed.imageInput = true;
  const prepared = await f.work.prepare(identity, input);
  assert.ok(JSON.stringify(prepared.payload).includes('data:image/png;base64,') || JSON.stringify(prepared.payload).includes('"media_type":"image/png"'));
});
test('SPC-03 public preflight and create share every missing capability and a safe fixed-route DTO', async () => {
  const f = fixture();
  const input = { source: { connectionId: f.fixed.connectionId, version: 3 }, prefix: prefix({ requiredCapabilities: ['images', 'nativeReplay'] }) };
  const decision = await routeModels({ segments: f.work }, identity, 'models/capabilities', input);
  assert.equal(decision.available, false);
  assert.equal(decision.routeId, f.fixed.routeId);
  assert.equal(decision.configurationVersion, 3);
  assert.deepEqual(decision.missing.map(item => [item.capability, item.status]), [['images', 'unknown'], ['nativeReplay', 'unknown']]);
  assert.deepEqual(contracts.modelCapabilityDecisionSchema.parse(decision), decision);
  for (const secret of ['PRIVATE-DISPLAY', 'private-route.example', 'PRIVATE-MODEL', 'PRIVATE-CREDENTIAL', 'PRIVATE-SCOPE', 'PRIVATE-FEE'])
    assert.equal(JSON.stringify(decision).includes(secret), false);
  let rejection;
  await assert.rejects(f.work.create(identity, { ...input, requestId: randomUUID(), segmentId: randomUUID(), portable: [] }), error => {
    rejection = error; return error instanceof capabilities.ModelCapabilityError;
  });
  assert.deepEqual(rejection.decision, decision);
  const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = JSON.parse(body); } };
  learningFailure(response, rejection);
  assert.equal(response.status, 422);
  assert.deepEqual(response.body, { error: 'capability-unavailable', decision });
  assert.deepEqual(f.counts(), { snapshots: 2, writes: 0, dispatches: 0 });
});
test('SPC-03 collects strict schema, strict tools and forced-tool limitations together', async () => {
  const fixed = connection({ parameterMode: 'thinking' });
  fixed.capabilityEvidence = { observedAt: '2026-11-03', sdk: 'openai@7.42.0', adapter: 'xunjie-chat-native-v2',
    endpoint: fixed.baseUrl + fixed.path, modelId: fixed.modelId, protocol: fixed.protocol, parameterMode: 'thinking',
    testedToolChoice: 'auto', toolImageStrategy: 'paired-text-adjacent-user-image', limitations: ['thinking-forced-tool-unsupported'] };
  const f = fixture(fixed), input = { source: { connectionId: fixed.connectionId, version: fixed.version },
    prefix: { system: '', tools: [{ ...tool, strict: true }], options: { toolChoice: { name: tool.name },
      responseFormat: { kind: 'json-schema', name: 'result', schema: { type: 'object' }, strict: true }, requiredCapabilities: ['images', 'nativeReplay', 'images'] } } };
  const result = await f.work.decideCapabilities(identity, input);
  assert.deepEqual(new Set(result.missing.map(item => item.capability)), new Set(['images', 'nativeReplay', 'nativeStrict', 'strictTools', 'forcedTool']));
  for (const name of ['nativeStrict', 'strictTools', 'forcedTool']) assert.equal(result.missing.find(item => item.capability === name).status, 'unsupported');
  assert.ok(result.limitations.includes('thinking-forced-tool-unsupported'));
  assert.equal(result.evidence.sdk, 'openai@7.42.0');
  await assert.rejects(f.work.create(identity, { ...input, requestId: randomUUID(), segmentId: randomUUID(), portable: [] }), error => {
    assert.deepEqual(error.decision, result); return error instanceof capabilities.ModelCapabilityError;
  });
  assert.deepEqual(f.counts(), { snapshots: 2, writes: 0, dispatches: 0 });
});
test('SPC-03 probe flag cannot upgrade unknown evidence; declarations stay unknown', async () => {
  const fixed = connection(); fixed.capabilities.images = 'declared';
  const f = fixture(fixed), input = { source: { connectionId: fixed.connectionId, version: fixed.version }, prefix: prefix({ requiredCapabilities: ['images'], capabilityProbe: true }) };
  const decision = await f.work.decideCapabilities(identity, input);
  assert.equal(decision.available, false);
  assert.equal(decision.missing[0].status, 'unknown');
  assert.equal(decision.missing[0].evidence.state, 'declared');
  assert.equal(fixed.capabilities.images, 'declared');
  assert.deepEqual(f.counts(), { snapshots: 1, writes: 0, dispatches: 0 });
});
test('SPC-03 preflight rejects drafts and invalid forced tool before taking a snapshot', async () => {
  const f = fixture(), source = { connectionId: f.fixed.connectionId, version: f.fixed.version };
  await assert.rejects(f.work.decideCapabilities(identity, { source: { draft: f.fixed, credential: { action: 'replace', value: 'SECRET' } }, prefix: prefix({}) }));
  await assert.rejects(f.work.decideCapabilities(identity, { source, prefix: prefix({ toolChoice: { name: 'missing' } }) }));
  assert.equal(f.counts().snapshots, 0);
});
test('SPC-03 application validation is explicitly available without inventing native support', async () => {
  const f = fixture(), result = await f.work.decideCapabilities(identity, { source: { connectionId: f.fixed.connectionId, version: 3 },
    prefix: prefix({ applicationSchema: { type: 'object' }, requiredCapabilities: ['applicationSchema'] }) });
  assert.equal(result.available, true);
  const item = result.items.find(item => item.capability === 'applicationSchema');
  assert.equal(item.status, 'available');
  assert.equal(item.evidence.source, 'application-validator');
  assert.equal(result.items.find(item => item.capability === 'nativeStrict').status, 'unsupported');
});
test('SPC-03 Messages JSON-object has no assembly even for a diagnostic probe, with every missing item preserved', async () => {
  const f = fixture(connection({ protocol: 'messages', path: '/v1/messages' }));
  const input = { source: { connectionId: f.fixed.connectionId, version: 3 }, prefix: prefix({
    requiredCapabilities: ['images', 'nativeReplay'], responseFormat: { kind: 'json-object' }, capabilityProbe: true }) };
  const decision = await f.work.decideCapabilities(identity, input);
  assert.deepEqual(decision.missing.map(item => [item.capability, item.status]), [['images', 'unknown'], ['nativeReplay', 'unknown'], ['jsonMode', 'unsupported']]);
  assert.ok(decision.limitations.includes('messages-json-object-not-supported'));
  await assert.rejects(f.work.create(identity, { ...input, requestId: randomUUID(), segmentId: randomUUID(), portable: [] }), error => {
    assert.deepEqual(error.decision, decision); return error instanceof capabilities.ModelCapabilityError;
  });
  assert.deepEqual(f.counts(), { snapshots: 2, writes: 0, dispatches: 0 });
});
test('SPC-03 reviewed protocol profiles expose their actual image assembly, not another protocol', async () => {
  for (const [protocol, path, strategy] of [
    ['chat-completions', '/chat/completions', 'paired-text-adjacent-user-image'],
    ['responses', '/responses', 'native-function-output-image'],
    ['messages', '/v1/messages', 'native-tool-result-image'],
  ]) {
    const fixed = connection({ protocol, path, baseUrl: protocol === 'messages' ? 'https://api.deepseek.com/anthropic' : 'https://api.deepseek.com/v1',
      modelId: 'deepseek-flash', dialect: 'deepseek', parameterMode: 'thinking' });
    Object.assign(fixed, capabilities.measuredCapabilities(fixed));
    const decision = await fixture(fixed).work.decideCapabilities(identity, { source: { connectionId: fixed.connectionId, version: 3 },
      prefix: prefix({ requiredCapabilities: ['text', 'images', 'tools', 'nativeReplay'] }) });
    assert.equal(decision.available, true);
    assert.deepEqual(decision.missing, []);
    assert.equal(decision.assembly.toolImages, strategy);
    assert.equal(decision.evidence.adapter, fixed.capabilityEvidence.adapter);
    assert.equal(decision.items.find(item => item.capability === 'images').evidence.source, 'measured-route');
  }
});

for (const bothImages of [false, true]) for (const reverse of [false, true]) {
  test(`SPC-07 actual Chat wire completes all tools before labelled images (both=${bothImages}, reverse=${reverse})`, async () => {
    let wire;
    const server = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk); wire = JSON.parse(Buffer.concat(chunks));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'ack' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const f = fixture(connection({ baseUrl: `http://127.0.0.1:${server.address().port}/v1` }));
      const segmentId = randomUUID(), priorId = randomUUID(), resultRef = randomUUID(), requestRef = randomUUID();
      f.segments.set(segmentId, { segmentId, sequence: 1, snapshot: f.snapshot, prefix: { system: 'fixed', tools: [tool] }, portable: [], headAttemptId: priorId, pendingAttemptId: null, closed: false });
      f.facts.set(priorId, { attemptId: priorId, purpose: 'chat-probe', connection: f.fixed, limits: { maxOutputTokens: 128, timeoutMs: 1000 },
        state: 'completed', reason: 'tool_calls', dispatched: true, cancelRequested: false, physicalRequestEnded: true, upstreamStopped: 'unknown', text: '', usage: { state: 'unknown' },
        requestRef, resultRef, createdAt: new Date().toISOString(), toolIntents: ['call-a', 'call-b'].map(callId => ({ callId, name: tool.name, arguments: {} })) });
      f.resources.set(requestRef, Buffer.from(JSON.stringify({ model: 'fixture', stream: true, messages: [{ role: 'system', content: 'fixed' }, { role: 'user', content: 'start' }] })));
      f.resources.set(resultRef, Buffer.from(JSON.stringify({ assistant: { role: 'assistant', content: null, tool_calls: ['call-a', 'call-b'].map(id => ({ id, type: 'function', function: { name: tool.name, arguments: '{}' } })) } })));
      const results = ['call-a', 'call-b'].map((callId, index) => {
        const image = { imageId: randomUUID(), version: 1 };
        f.imageBytes.set(image.imageId, Buffer.from(`bytes-${callId}`).toString('base64'));
        return { callId, outcome: 'success', text: callId, images: index === 0 || bothImages ? [image] : [] };
      });
      const input = { attemptId: randomUUID(), purpose: 'chat-probe', segmentId, expectedSequence: 1,
        input: { text: 'continue', images: [], observations: [], toolResults: reverse ? [...results].reverse() : results }, limits: { maxOutputTokens: 128, timeoutMs: 1000 } };
      const prepared = await f.work.prepare(identity, input);
      await runChat(f.fixed, 'synthetic-key', prepared.payload, new AbortController().signal, 1000, [tool]);
      assert.deepEqual(wire.messages.slice(2, 5).map(message => [message.role, message.tool_call_id]), [['assistant', undefined], ['tool', 'call-a'], ['tool', 'call-b']]);
      const pictureMessages = wire.messages.slice(5, -1);
      assert.equal(pictureMessages.length, bothImages ? 2 : 1);
      for (const [index, message] of pictureMessages.entries()) {
        const result = results[index];
        assert.equal(message.role, 'user');
        assert.deepEqual(JSON.parse(message.content[0].text), { kind: 'tool-result-image', callId: result.callId, source: result.images[0] });
        assert.equal(message.content[1].image_url.url, 'data:image/png;base64,' + f.imageBytes.get(result.images[0].imageId));
      }
      // Saved settlement and caller-supplied results must replay identically.
      f.settled.set(priorId, results);
      const replay = await f.work.prepare(identity, { ...input, input: { ...input.input, toolResults: [] } });
      assert.deepEqual(replay.payload, prepared.payload);
      assert.deepEqual(f.materialized.slice(0, bothImages ? 2 : 1), results.flatMap(result => result.images));
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
}
