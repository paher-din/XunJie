import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const { runMessages, validateMessagesNative } = await import(process.env.XUNJIE_MESSAGES_REVIEW_MODULE
  ? pathToFileURL(process.env.XUNJIE_MESSAGES_REVIEW_MODULE).href
  : new URL('../../../packages/learning-space/dist/model-connections/messages.js', import.meta.url).href);
const tool = { name: 'read_marker', description: '', inputSchema: { type: 'object',
  properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false } };
const start = (usage = { input_tokens: 0, output_tokens: 0 }) => ({ type: 'message_start', message: {
  id: 'msg-review', type: 'message', role: 'assistant', model: 'fixture', content: [],
  stop_reason: null, stop_sequence: null, usage } });
const finish = (reason = 'end_turn', usage = { input_tokens: 7, output_tokens: 4 }) => [
  { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage }, { type: 'message_stop' },
];
const block = (type, fragments = []) => [
  { type: 'content_block_start', index: 0, content_block: type === 'tool_use'
    ? { type, id: 'call-review', name: tool.name, input: {} }
    : type === 'thinking' ? { type, thinking: '', signature: '' } : { type, text: '' } },
  ...fragments.map(fragment => ({ type: 'content_block_delta', index: 0, delta: type === 'tool_use'
    ? { type: 'input_json_delta', partial_json: fragment }
    : type === 'thinking' ? { type: 'thinking_delta', thinking: fragment } : { type: 'text_delta', text: fragment } })),
  { type: 'content_block_stop', index: 0 },
];
async function run(events, { dialect = 'deepseek', termination = 'end', apiKey = 'synthetic-review-key',
  headers = {}, status = 200, injectedFetch = false, payload: extra = {} } = {}) {
  let requests = 0, fetches = 0;
  const server = createServer(async (request, response) => {
    for await (const ignored of request) { /* Consume the real SDK request. */ }
    requests++;
    response.writeHead(status, { 'content-type': status === 200 ? 'text/event-stream' : 'application/json', ...headers });
    if (status !== 200) { response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'fixture' } })); return; }
    for (const event of events) response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
    if (termination === 'reset') setTimeout(() => response.destroy(), 30);
    else response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const configuration = { protocol: 'messages', baseUrl: `http://127.0.0.1:${server.address().port}`,
      path: '/v1/messages', modelId: 'fixture', dialect, parameterMode: 'plain' };
    const payload = { model: 'fixture', stream: true, max_tokens: 16,
      messages: [{ role: 'user', content: 'read' }], tools: [{ name: tool.name, description: '', input_schema: tool.inputSchema }], ...extra };
    const requestFetch = async (input, init) => { fetches++; return fetch(input, init); };
    const result = await runMessages(configuration, apiKey, payload, new AbortController().signal, 2000, [tool], undefined,
      ...(injectedFetch ? [requestFetch] : []));
    assert.equal(requests, 1, 'No implicit generation retry');
    if (injectedFetch) assert.equal(fetches, 1, 'The authenticated fetch must carry the SDK request');
    return result;
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('SPC-06: truncated tool JSON preserves the terminal, counters and raw evidence', async t => {
  for (const termination of ['end', 'reset']) for (const [name, counters, usage] of [
    ['final', { input_tokens: 7, output_tokens: 4 }, { state: 'final', inputTokens: 7, outputTokens: 4 }],
    ['zero', { input_tokens: 0, output_tokens: 0 }, { state: 'final', inputTokens: 0, outputTokens: 0 }],
    ['partial', { output_tokens: 4 }, { state: 'partial', outputTokens: 4 }],
    ['unknown', {}, { state: 'unknown' }],
  ]) await t.test(`${termination}/${name}`, async () => {
    const events = [start(), ...block('tool_use', ['{"nonce":"part']), ...finish('max_tokens', counters)];
    const result = await run(events, { termination });
    assert.equal(result.state, 'incomplete'); assert.equal(result.reason, 'max_tokens');
    assert.deepEqual(result.usage, usage); assert.deepEqual(result.toolIntents, []);
    assert.equal(result.native.message.stop_reason, 'max_tokens');
    assert.deepEqual(result.native.events, events);
    assert.throws(() => validateMessagesNative(result.native, [tool]));
  });
});

test('SPC-06: tool publication still requires complete valid parameters', async t => {
  for (const [name, fragments, reason, state] of [
    ['valid', ['{"nonce":', '"A"}'], 'tool_use', 'completed'],
    ['complete but capped', ['{"nonce":"A"}'], 'max_tokens', 'incomplete'],
    ['truncated', ['{"nonce":"part'], 'tool_use', 'failed'],
    ['malformed', ['{broken}'], 'tool_use', 'failed'],
    ['wrong shape', ['["A"]'], 'tool_use', 'failed'],
    ['wrong schema', ['{"nonce":4}'], 'tool_use', 'failed'],
    ['wrong terminal', ['{"nonce":"A"}'], 'end_turn', 'failed'],
  ]) await t.test(name, async () => {
    const events = [start(), ...block('tool_use', fragments), ...finish(reason)];
    const result = await run(events);
    assert.equal(result.state, state); assert.deepEqual(result.usage, { state: 'final', inputTokens: 7, outputTokens: 4 });
    if (result.state === 'failed') { assert.equal(result.native.message, null); assert.deepEqual(result.native.events, []); }
    else { assert.equal(result.native.message.stop_reason, reason); assert.deepEqual(result.native.events, events); }
    if (state === 'completed') {
      assert.deepEqual(result.toolIntents, [{ callId: 'call-review', name: tool.name, arguments: { nonce: 'A' } }]);
      assert.deepEqual(validateMessagesNative(result.native, [tool]).intents, result.toolIntents);
    } else assert.deepEqual(result.toolIntents, []);
  });
});

test('SPC-10: empty end_turn and empty text blocks retain truthful usage and replay', async t => {
  for (const [name, counters, usage] of [
    ['final', { input_tokens: 7, output_tokens: 4 }, { state: 'final', inputTokens: 7, outputTokens: 4 }],
    ['zero', { input_tokens: 0, output_tokens: 0 }, { state: 'final', inputTokens: 0, outputTokens: 0 }],
    ['partial', { output_tokens: 4 }, { state: 'partial', outputTokens: 4 }],
    ['unknown', {}, { state: 'unknown' }],
  ]) for (const content of [[], block('text')]) await t.test(`${name}/${content.length ? 'text block' : 'no blocks'}`, async () => {
    const result = await run([start(), ...content, ...finish('end_turn', counters)]);
    assert.equal(result.state, 'completed'); assert.equal(result.reason, 'end_turn'); assert.equal(result.text, '');
    assert.deepEqual(result.usage, usage); assert.deepEqual(result.toolIntents, []);
    assert.equal(validateMessagesNative(result.native, []).text, '');
  });
});

test('Messages rejects unclosed blocks, invalid order and unknown events', async t => {
  const fullBlock = block('text', ['ok']);
  for (const [name, events] of [
    ['delta before start', finish()], ['stop before delta', [start(), { type: 'message_stop' }]],
    ['unclosed block', [start(), ...fullBlock.slice(0, -1), ...finish()]],
    ['duplicate start', [start(), start(), ...finish()]],
    ['duplicate block stop', [start(), ...fullBlock, fullBlock.at(-1), ...finish()]],
    ['content after terminal delta', [start(), ...fullBlock, finish()[0], ...block('text'), finish()[1]]],
    ['event after message stop', [start(), ...fullBlock, ...finish(), { type: 'message_stop' }]],
    ['empty tool terminal', [start(), ...finish('tool_use')]],
    ['unknown event', [start(), { type: 'unknown' }, ...finish()]],
  ]) await t.test(name, async () => {
    const result = await run(events);
    assert.equal(result.state, 'failed'); assert.deepEqual(result.toolIntents, []);
  });
});

test('Messages without message_stop cannot publish a tool or claim final usage', async () => {
  const result = await run([start(), ...block('tool_use', ['{"nonce":"part']), finish('max_tokens')[0]]);
  assert.equal(result.state, 'incomplete'); assert.deepEqual(result.toolIntents, []);
  assert.deepEqual(result.usage, { state: 'partial', inputTokens: 7, outputTokens: 4 });
});

test('Messages uses the owner-injected fetch and keeps safe HTTP facts', async () => {
  const result = await run([], { injectedFetch: true, status: 429,
    headers: { 'request-id': 'req-messages-review', 'retry-after': '17' } });
  assert.equal(result.state, 'failed'); assert.equal(result.reason, 'rate-limited');
  assert.deepEqual(result.upstream, { httpStatus: 429, requestId: 'req-messages-review', retryAfterSeconds: 17 });
});

test('Messages sensitive-output gate covers parsed escapes, split fields and signed content', async t => {
  for (const secret of ['synthetic-review-key', 'synthetic-"key\\private']) {
    const encoded = '{"nonce":"' + [...secret].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"}';
    const midpoint = Math.floor(secret.length / 2);
    for (const [name, content, reason] of [
      ['escaped tool arguments', block('tool_use', [encoded.slice(0, 25), encoded.slice(25)]), 'tool_use'],
      ['split text', block('text', [secret.slice(0, midpoint), secret.slice(midpoint)]), 'end_turn'],
      ['split thinking', block('thinking', [secret.slice(0, midpoint), secret.slice(midpoint)]), 'end_turn'],
      ['signature', [
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        ...[secret.slice(0, midpoint), secret.slice(midpoint)].map(signature => ({ type: 'content_block_delta', index: 0,
          delta: { type: 'signature_delta', signature } })), { type: 'content_block_stop', index: 0 },
      ], 'end_turn'],
    ]) await t.test(`${name}/${secret.includes('"') ? 'quoted' : 'plain'}`, async () => {
      const result = await run([start(), ...content, ...finish(reason)], { apiKey: secret });
      assert.equal(result.state, 'failed'); assert.equal(result.reason, 'credential-in-output');
      assert.deepEqual(result.toolIntents, []); assert.equal(result.native.redacted, true);
      assert.equal(result.native.message, null); assert.deepEqual(result.native.events, []);
      assert.equal(JSON.stringify(result).includes(secret), false);
    });
  }
});

test('Messages inspects unclosed tool fragments before publishing partial native evidence', async () => {
  const secret = 'synthetic-review-key';
  const content = block('tool_use', ['{"nonce":"synthetic-', 'review-key']);
  const result = await run([start(), ...content.slice(0, -1)], { apiKey: secret });
  assert.equal(result.state, 'incomplete'); assert.equal(result.reason, 'credential-in-output');
  assert.deepEqual(result.toolIntents, []); assert.equal(result.native.redacted, true);
  assert.equal(result.native.message, null); assert.deepEqual(result.native.events, []);
});

test('Messages checks decoded structured output instead of publishing escaped credentials', async () => {
  const secret = 'synthetic-review-key';
  const text = '{"nonce":"' + [...secret].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"}';
  const result = await run([start(), ...block('text', [text]), ...finish()], { apiKey: secret,
    payload: { output_config: { format: { type: 'json_schema', schema: tool.inputSchema } } } });
  assert.equal(result.state, 'failed'); assert.equal(result.reason, 'credential-in-output');
  assert.equal(result.text, ''); assert.equal(result.native.redacted, true);
  assert.equal(result.native.message, null); assert.deepEqual(result.native.events, []);
});

test('Messages removes escaped credentials even when the tool JSON is truncated', async t => {
  const secret = 'synthetic-"review\\key';
  const encoded = [...secret].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  for (const suffix of ['', '"', '\\u']) await t.test(`trailing ${JSON.stringify(suffix)}`, async () => {
    const result = await run([start(), ...block('tool_use', ['{"nonce":"' + encoded + suffix]), ...finish('max_tokens')], { apiKey: secret });
    assert.equal(result.state, 'incomplete'); assert.equal(result.reason, 'credential-in-output');
    assert.deepEqual(result.toolIntents, []); assert.equal(result.native.redacted, true);
    assert.equal(result.native.message, null); assert.deepEqual(result.native.events, []);
  });
});

test('Messages keeps harmless signed thinking and tool JSON replayable', async () => {
  const content = block('thinking', ['safe ', 'thinking']);
  content.splice(content.length - 1, 0,
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature-first-' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'second' } });
  const toolBlock = block('tool_use', ['{"nonce":"A"}']).map(event => ({ ...event, index: 1 }));
  const events = [start(), ...content, ...toolBlock, ...finish('tool_use')];
  const result = await run(events);
  assert.equal(result.state, 'completed'); assert.deepEqual(result.native.events, events);
  assert.equal(result.native.message.content[0].signature, 'signature-first-second');
  assert.equal(result.native.message.content[0].thinking, 'safe thinking');
  assert.deepEqual(validateMessagesNative(result.native, [tool]).intents, result.toolIntents);
});
