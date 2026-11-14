import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Exercise current adapter sources and the installed SDK, without changing shared dist.
const directory = await mkdtemp(join(tmpdir(), 'xj-protocol-review-'));
after(() => rm(directory, { recursive: true, force: true }));
await build({
  entryPoints: ['chat', 'responses'].map(name => fileURLToPath(new URL(`../../../packages/model-gateway/src/${name}.ts`, import.meta.url))),
  outdir: directory, bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' },
  plugins: [{ name: 'installed-dependencies', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => isAbsolute(args.path) ? undefined
      : ({ path: args.path.startsWith('node:') ? args.path : import.meta.resolve(args.path), external: true }));
  } }],
});
const { runChat } = await import(pathToFileURL(join(directory, 'chat.mjs')));
const { runResponses } = await import(pathToFileURL(join(directory, 'responses.mjs')));
const tools = [{ name: 'read_marker', description: '', inputSchema: { type: 'object',
  properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false } }];
const counts = { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 };
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const toolDelta = argumentsText => ({ tool_calls: [{ index: 0, id: 'call-1', type: 'function',
  function: { name: 'read_marker', arguments: argumentsText } }] });
const event = value => 'data: ' + JSON.stringify(value) + '\n\n';
const terminal = (output, status = 'completed') => ({ type: 'response.' + status, response: {
  id: 'resp-1', object: 'response', status, output,
  usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 },
} });

async function fixture(protocol, handler, options = {}) {
  let requests = 0, injectedRequests = 0;
  const server = createServer(async (request, response) => {
    for await (const ignored of request) {}
    requests++;
    response.writeHead(options.status ?? 200, options.headers ?? { 'content-type': 'text/event-stream' });
    handler(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const controller = options.controller ?? new AbortController();
    const configuration = { protocol, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      modelId: 'fixture', dialect: 'standard', parameterMode: 'plain' };
    const payload = protocol === 'responses' ? { model: 'fixture', stream: true, input: 'fixture', ...options.payload }
      : { model: 'fixture', stream: true, messages: [{ role: 'user', content: 'fixture' }], ...options.payload };
    const result = await (protocol === 'responses' ? runResponses : runChat)(configuration,
      options.key ?? 'synthetic-review-key', payload, controller.signal, options.timeoutMs ?? 2000, tools, undefined,
      async (input, init) => { injectedRequests++; return fetch(input, init); });
    assert.equal(requests, 1, 'generation is never retried');
    if (options.checkFetch) assert.equal(injectedRequests, 1, 'owner fetch must carry the request');
    return result;
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}

for (const kind of ['stop', 'tool_calls']) for (const ending of ['reset', 'abort']) {
  test(`Chat ${kind} terminal survives later ${ending}`, async () => {
    const controller = new AbortController();
    const result = await fixture('chat-completions', response => {
      response.write(event(chunk(kind === 'stop' ? { content: 'OK' } : toolDelta('{"nonce":"A"}'))));
      response.write(event(chunk({}, kind)));
      response.write(event({ choices: [], usage: counts }));
      setTimeout(() => ending === 'reset' ? response.destroy() : controller.abort(), 30);
    }, { controller, checkFetch: true });
    assert.equal(result.state, 'completed'); assert.equal(result.reason, kind);
    assert.equal(result.usage.state, 'final');
    assert.equal(result.toolIntents.length, kind === 'tool_calls' ? 1 : 0);
  });
}

for (const [name, tail] of [
  ['malformed JSON', 'data: {bad\n\n'],
  ['explicit error', event({ error: { message: 'fixture error' } })],
  ['named error', 'event: error\ndata: {"message":"fixture error"}\n\n'],
  ['contradictory terminal', event(chunk({}, 'length'))],
  ['late content', event(chunk({ content: 'late' }))],
]) test(`Chat terminal does not mask ${name}`, async () => {
  const result = await fixture('chat-completions', response => response.end(event(chunk({ content: 'OK' }, 'stop')) + tail));
  assert.equal(result.state, 'failed'); assert.deepEqual(result.toolIntents, []);
});

test('Chat reset without terminal and terminal with half tool JSON remain non-consumable', async () => {
  const partial = await fixture('chat-completions', response => {
    response.write(event(chunk({ content: 'partial' }))); setTimeout(() => response.destroy(), 30);
  });
  assert.equal(partial.state, 'incomplete');
  const invalid = await fixture('chat-completions', response => {
    response.write(event(chunk(toolDelta('{"nonce":"part'), 'tool_calls'))); setTimeout(() => response.destroy(), 30);
  });
  assert.equal(invalid.state, 'failed'); assert.deepEqual(invalid.toolIntents, []);
});

for (const [finish, usage, expected] of [
  ['length', counts, 'final'], ['content_filter', counts, 'final'],
  ['length', { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, 'final'],
  ['length', { prompt_tokens: 7 }, 'partial'], ['length', undefined, 'unknown'],
  [null, counts, 'partial'],
]) test(`Chat usage finality is independent: ${finish}/${expected}/${JSON.stringify(usage)}`, async () => {
  const result = await fixture('chat-completions', response => response.end(event(chunk({ content: 'partial' }, finish))
    + (usage ? event({ choices: [], usage }) : '') + 'data: [DONE]\n\n'));
  assert.equal(result.state, 'incomplete'); assert.equal(result.usage.state, expected);
  if (usage?.total_tokens === 0) assert.equal(result.usage.totalTokens, 0);
});

test('Chat provisional usage before terminal is not promoted by a finish marker', async () => {
  const result = await fixture('chat-completions', response => response.end(event({ choices: [], usage: counts })
    + event(chunk({ content: 'OK' }, 'stop')) + 'data: [DONE]\n\n'));
  assert.equal(result.state, 'completed'); assert.equal(result.usage.state, 'partial');
});

for (const protocol of ['chat-completions', 'responses']) {
  for (const [name, key, kind] of [
    ['ordinary echo', 'synthetic-review-key', 'text'],
    ['split text', 'synthetic-review-key', 'split'],
    ['split text without terminal', 'synthetic-review-key', 'partial-text'],
    ['unicode arguments', 'synthetic-review-key', 'unicode'],
    ['escaped arguments', 'synthetic-"escaped\\key', 'arguments'],
    ['split incomplete arguments', 'synthetic-review-key', 'partial-arguments'],
    ['ordinary JSON text is not reinterpreted', 'synthetic-review-key', 'json-text'],
  ]) test(`${protocol} credential boundary: ${name}`, async () => {
    const unicode = [...key].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    const args = kind === 'unicode' ? '{"nonce":"' + unicode + '"}' : JSON.stringify({ nonce: key });
    const text = kind === 'json-text' ? '{"nonce":"' + unicode + '"}' : key;
    const result = await fixture(protocol, response => {
      if (protocol === 'chat-completions') {
        if (kind === 'partial-arguments') {
          response.write(event(chunk(toolDelta(args.slice(0, 12)))));
          response.end(event(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(12) } }] })));
        } else if (kind === 'unicode' || kind === 'arguments') response.end(event(chunk(toolDelta(args), 'tool_calls')));
        else if (kind === 'text') response.end(event(chunk({ content: text }, 'stop')));
        else {
          response.write(event(chunk({ content: text.slice(0, 9) })));
          response.end(event(chunk({ content: text.slice(9) }, kind === 'partial-text' ? null : 'stop')));
        }
      } else if (kind === 'partial-arguments') {
        response.write(event({ type: 'response.output_item.added', output_index: 0,
          item: { id: 'fc-1', type: 'function_call', call_id: 'call-1', name: 'read_marker', arguments: '' } }));
        for (const delta of [args.slice(0, 12), args.slice(12)]) response.write(event({
          type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc-1', delta }));
        response.end();
      } else {
        if (kind === 'split' || kind === 'partial-text') {
          response.write(event({ type: 'response.output_item.added', output_index: 0,
            item: { id: 'msg-1', type: 'message', role: 'assistant', content: [] } }));
          for (const delta of [text.slice(0, 9), text.slice(9)]) response.write(event({ type: 'response.output_text.delta',
            output_index: 0, item_id: 'msg-1', content_index: 0, delta }));
          if (kind === 'partial-text') { response.end(); return; }
        }
        response.end(event(terminal(kind === 'unicode' || kind === 'arguments'
        ? [{ id: 'fc-1', type: 'function_call', call_id: 'call-1', name: 'read_marker', arguments: args }]
        : [{ id: 'msg-1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }])));
      }
    }, { key });
    if (kind === 'json-text') {
      assert.equal(result.state, 'completed'); assert.equal(result.text, text); return;
    }
    assert.notEqual(result.state, 'completed'); assert.match(result.reason, /^credential-in-/);
    assert.deepEqual(result.toolIntents, []); assert.equal(result.native.redacted, true);
    assert.equal(JSON.stringify(result).includes(key), false);
    assert.deepEqual(protocol === 'responses' ? result.native.events : result.native.chunks, []);
    if (protocol === 'responses') assert.equal(result.native.response, null);
    else { assert.equal(result.native.assistant, null); assert.deepEqual(result.native.choices, []); }
  });

  for (const [status, headers, expected] of [
    [429, { 'x-request-id': 'fixture-request', 'retry-after': '17' }, { httpStatus: 429, requestId: 'fixture-request', retryAfterSeconds: 17, message: 'fixture' }],
    [503, { 'request-id': 'fixture-date', 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' }, { httpStatus: 503, requestId: 'fixture-date', retryAt: '2015-10-21T07:28:00.000Z', message: 'fixture' }],
    [503, {}, { httpStatus: 503, message: 'fixture' }],
    [429, { 'x-request-id': 'synthetic-review-key', 'retry-after': '-1' }, { httpStatus: 429, message: 'fixture' }],
    [503, { 'x-request-id': 'invalid id', 'retry-after': 'Infinity' }, { httpStatus: 503, message: 'fixture' }],
    [503, { 'x-request-id': 'x'.repeat(201), 'retry-after': '31536001' }, { httpStatus: 503, message: 'fixture' }],
    [429, { 'retry-after-ms': '1500' }, { httpStatus: 429, retryAfterSeconds: 1.5, message: 'fixture' }],
  ]) test(`${protocol} preserves bounded HTTP facts: ${status}/${JSON.stringify(headers)}`, async () => {
    const result = await fixture(protocol, response => response.end('{"error":{"message":"fixture"}}'),
      { status, headers: { 'content-type': 'application/json', ...headers }, checkFetch: true });
    assert.equal(result.state, 'failed'); assert.deepEqual(result.upstream, expected); assert.deepEqual(result.native.upstream, expected);
  });

  for (const kind of ['comment', 'unfinished', 'small-events']) test(`${protocol} raw byte cap includes ${kind}`, async () => {
    const padding = kind === 'comment' ? ':' + 'x'.repeat(2_100_000) + '\n\n'
      : kind === 'unfinished' ? 'data: ' + 'x'.repeat(2_100_000) : ': padding\n\n'.repeat(210_001);
    // The byte-limit verdict must not depend on parsing 210,001 comments within two seconds.
    const result = await fixture(protocol, response => response.end(padding), { timeoutMs: 10_000 });
    assert.equal(result.state, 'incomplete'); assert.equal(result.reason, 'response-limit'); assert.deepEqual(result.toolIntents, []);
  });
}

test('Chat accepts an exactly 2 MB raw response', async () => {
  const data = event(chunk({ content: 'OK' }, 'stop')) + 'data: [DONE]\n\n';
  const result = await fixture('chat-completions', response => response.end(':' + 'x'.repeat(2_000_000 - Buffer.byteLength(data) - 3) + '\n\n' + data));
  assert.equal(result.state, 'completed'); assert.equal(result.text, 'OK');
});

test('Chat byte limit still wins after a valid terminal', async () => {
  const result = await fixture('chat-completions', response => response.end(event(chunk({ content: 'OK' }, 'stop'))
    + ':' + 'x'.repeat(2_100_000) + '\n\n'));
  assert.equal(result.reason, 'response-limit'); assert.equal(result.state, 'incomplete');
});

for (const protocol of ['chat-completions', 'responses']) test(`${protocol} rejects credentials in invalid late tool data`, async () => {
  const key = 'synthetic-review-key';
  const args = '{"nonce":"' + [...key].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"}';
  const result = await fixture(protocol, response => {
    if (protocol === 'chat-completions') response.end(event(chunk({ content: 'OK' }, 'stop')) + event(chunk(toolDelta(args))));
    else response.end(event(terminal([])) + event({ type: 'response.output_item.added', output_index: 0,
      item: { id: 'late', type: 'function_call', call_id: 'late', name: 'read_marker', arguments: args } }));
  }, { key });
  assert.equal(result.state, 'failed'); assert.equal(result.native.redacted, true);
  assert.deepEqual(protocol === 'responses' ? result.native.events : result.native.chunks, []);
});

test('Chat never retains sensitive finish metadata', async () => {
  const result = await fixture('chat-completions', response => response.end(event(chunk({}, 'synthetic-review-key'))));
  assert.equal(JSON.stringify(result).includes('synthetic-review-key'), false);
  assert.notEqual(result.state, 'completed');
});

for (const protocol of ['chat-completions', 'responses']) test(`${protocol} checks explicitly parsed structured output`, async () => {
  const key = 'synthetic-review-key';
  const text = '{"nonce":"' + [...key].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"}';
  const result = await fixture(protocol, response => response.end(protocol === 'chat-completions'
    ? event(chunk({ content: text }, 'stop'))
    : event(terminal([{ id: 'msg-1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }]))),
  { key, payload: protocol === 'chat-completions' ? { response_format: { type: 'json_object' } } : { text: { format: { type: 'json_object' } } } });
  assert.equal(result.state, 'failed'); assert.equal(result.reason, 'credential-in-output');
  assert.equal(result.text, ''); assert.equal(result.native.redacted, true);
});

for (const protocol of ['chat-completions', 'responses']) for (const suffix of ['', '"', '\\u']) {
  test(`${protocol} withholds an escaped credential in truncated tool JSON: ${JSON.stringify(suffix)}`, async () => {
    const key = 'synthetic-review-key';
    const args = '{"nonce":"' + [...key].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('') + suffix;
    const result = await fixture(protocol, response => {
      if (protocol === 'chat-completions') response.end(event(chunk(toolDelta(args), 'length')));
      else {
        response.write(event({ type: 'response.output_item.added', output_index: 0,
          item: { id: 'fc-1', type: 'function_call', call_id: 'call-1', name: 'read_marker', arguments: '' } }));
        response.write(event({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc-1', delta: args }));
        response.end(event(terminal([{ id: 'fc-1', type: 'function_call', call_id: 'call-1', name: 'read_marker', arguments: args }], 'incomplete')));
      }
    }, { key });
    assert.equal(result.state, 'incomplete'); assert.match(result.reason, /^credential-in-/);
    assert.equal(result.native.redacted, true); assert.deepEqual(result.toolIntents, []);
    assert.deepEqual(protocol === 'responses' ? result.native.events : result.native.chunks, []);
  });
}
