import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Public transport with the installed, real vendor SDKs; do not replace the assemblers.
const directory = await mkdtemp(join(tmpdir(), 'xj-tool-progress-'));
after(() => rm(directory, { recursive: true, force: true }));
await build({ entryPoints: ['transport', 'json-tool-progress'].map(name => fileURLToPath(new URL(`../../../packages/learning-space/src/model-connections/${name}.ts`, import.meta.url))),
  outdir: directory, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm',
  plugins: [{ name: 'installed-dependencies', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => isAbsolute(args.path) ? undefined
      : ({ path: args.path.startsWith('node:') ? args.path : import.meta.resolve(args.path), external: true }));
  } }],
});
const { runModel } = await import(pathToFileURL(join(directory, 'transport.mjs')));
const protocols = ['chat-completions', 'responses', 'messages'];
const key = 'synthetic-tool-preview-credential';
const tool = { name: 'artifact_create', description: '', progress: { kind: 'json-string', property: 'html' },
  inputSchema: { type: 'object', properties: { html: { type: 'string' }, css: { type: 'string' }, js: { type: 'string' }, nested: { type: 'object' } },
    required: ['html'], additionalProperties: false } };
const html = '<p>示意内容' + '甲'.repeat(180) + '</p>';
const wireTool = protocol => protocol === 'messages' ? { name: tool.name, description: '', input_schema: tool.inputSchema }
  : protocol === 'responses' ? { type: 'function', name: tool.name, description: '', parameters: tool.inputSchema, strict: false }
  : { type: 'function', function: { name: tool.name, description: '', parameters: tool.inputSchema } };
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
function events(protocol, args, { truncated = false, count = 1, fragmentSize = 17 } = {}) {
  const parts = [];
  const prefix = args.slice(0, Math.min(args.length - 1, args.indexOf('甲') + 100));
  const fragments = [prefix, ...args.slice(prefix.length).match(new RegExp('.{1,' + fragmentSize + '}', 'gs')) ?? []];
  if (protocol === 'chat-completions') {
    for (let index = 0; index < count; index++) {
      parts.push(chunk({ tool_calls: [{ index, id: 'call-' + index, type: 'function', function: { name: tool.name, arguments: '' } }] }));
      for (const argumentsText of fragments) parts.push(chunk({ tool_calls: [{ index, function: { arguments: argumentsText } }] }));
    }
    if (!truncated) parts.push(chunk({}, 'tool_calls'));
  } else if (protocol === 'responses') {
    const output = [];
    for (let index = 0; index < count; index++) {
      const item = { id: 'fc-' + index, type: 'function_call', call_id: 'call-' + index, name: tool.name, arguments: '', status: 'in_progress' };
      parts.push({ type: 'response.output_item.added', output_index: index, item });
      for (const delta of fragments) parts.push({ type: 'response.function_call_arguments.delta', output_index: index, item_id: item.id, delta });
      output.push({ ...item, status: 'completed', arguments: args });
      if (!truncated) parts.push({ type: 'response.output_item.done', output_index: index, item: output.at(-1) });
    }
    if (!truncated) parts.push({ type: 'response.completed', response: { id: 'response-1', object: 'response', status: 'completed', output,
      usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 } } });
  } else {
    parts.push({ type: 'message_start', message: { id: 'message-1', type: 'message', role: 'assistant', model: 'fixture', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
    for (let index = 0; index < count; index++) {
      parts.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'call-' + index, name: tool.name, input: {} } });
      for (const partial_json of fragments) parts.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
      if (!truncated) parts.push({ type: 'content_block_stop', index });
    }
    if (!truncated) parts.push({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 4 } }, { type: 'message_stop' });
  }
  return parts;
}
async function run(protocol, args, options = {}) {
  const seen = [], requests = [], parts = events(protocol, args, options);
  options.transform?.(parts);
  let streamEnded = false, observedBeforeEnd = false;
  const nativeTool = wireTool(protocol);
  const payload = protocol === 'messages' ? { model: 'fixture', stream: true, max_tokens: 1000, messages: [{ role: 'user', content: 'create' }], tools: [nativeTool] }
    : protocol === 'responses' ? { model: 'fixture', stream: true, input: 'create', tools: [nativeTool] }
    : { model: 'fixture', stream: true, messages: [{ role: 'user', content: 'create' }], tools: [nativeTool] };
  const result = await runModel({ protocol, baseUrl: 'http://localhost:12345', modelId: 'fixture', dialect: 'standard', parameterMode: 'plain' },
    key, payload, new AbortController().signal, 5000, true, undefined,
    async (_input, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(new ReadableStream({ async pull(controller) {
        if (!parts.length) { streamEnded = true; controller.close(); return; }
        const value = parts.shift();
        controller.enqueue(new TextEncoder().encode((protocol === 'messages' ? 'event: ' + value.type + '\n' : '') + 'data: ' + JSON.stringify(value) + '\n\n'));
        await new Promise(resolve => setTimeout(resolve, 1));
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }, undefined, options.declared === false ? [{ ...tool, progress: undefined }] : [tool], tools => {
      if (!streamEnded) observedBeforeEnd = true;
      seen.push(structuredClone(tools));
    });
  assert.equal(requests.length, 1);
  assert.ok(!JSON.stringify(requests).includes('json-string'), 'application metadata never reaches supplier');
  return { result, seen, observedBeforeEnd };
}
for (const protocol of protocols) {
  test(`${protocol}: decoded HTML progresses before terminal; CSS/JS and nested properties stay private`, async () => {
    const args = JSON.stringify({ nested: { html: 'nested-private' }, css: 'css-private', js: 'js-private', html });
    const { result, seen, observedBeforeEnd } = await run(protocol, args, { count: 2 });
    assert.equal(result.state, 'completed', result.reason);
    assert.equal(result.toolIntents.length, 2);
    assert.ok(observedBeforeEnd);
    assert.equal(seen.at(-1).length, 2);
    for (const callId of ['call-0', 'call-1']) {
      const values = seen.flatMap(tools => tools.filter(item => item.callId === callId));
      assert.ok(values.length > 1);
      for (let index = 0; index < values.length; index++) {
        assert.equal(values[index].name, tool.name); assert.equal(values[index].property, 'html');
        assert.ok(html.startsWith(values[index].text));
        if (index) assert.ok(values[index].text.startsWith(values[index - 1].text));
      }
    }
    assert.ok(!JSON.stringify(seen).includes('private'));
    assert.deepEqual(result.toolIntents[0].arguments, JSON.parse(args));
  });
  test(`${protocol}: unicode-escaped credential in unfinished JSON never leaks or produces an intent`, async () => {
    const escaped = [...key].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    const args = '{"html":"' + '甲'.repeat(180) + escaped + 'tail';
    const { result, seen } = await run(protocol, args, { truncated: true });
    assert.notEqual(result.state, 'completed'); assert.deepEqual(result.toolIntents, []);
    assert.ok(seen.length > 0);
    for (const item of seen.flat()) assert.match(item.text, /^甲+$/);
    assert.ok(!JSON.stringify({ result, seen }).includes(key));
  });
  test(`${protocol}: undeclared preview and nonstring HTML never project arguments`, async () => {
    assert.deepEqual((await run(protocol, JSON.stringify({ html }), { declared: false })).seen, []);
    assert.deepEqual((await run(protocol, JSON.stringify({ html: { html }, css: 'private' }))).seen, []);
  });
  test(`${protocol}: unfinished benign preview is retained but cannot dispatch`, async () => {
    const { result, seen } = await run(protocol, '{"html":"' + html, { truncated: true });
    assert.notEqual(result.state, 'completed'); assert.deepEqual(result.toolIntents, []); assert.ok(seen.length);
  });
}

for (const protocol of protocols) {
  test(`${protocol}: decoded escapes and surrogate pairs retain the original string prefix`, async () => {
    const text = '甲'.repeat(90) + '"\\/\n😀' + '乙'.repeat(90);
    const args = JSON.stringify({ html: text }).replace('html', '\\u0068tml').replace('😀', '\\ud83d\\ude00');
    const { result, seen } = await run(protocol, args);
    assert.equal(result.state, 'completed', result.reason);
    assert.ok(seen.length);
    for (const item of seen.flat()) {
      assert.ok(text.startsWith(item.text));
      assert.ok(!/[\uD800-\uDBFF]$/.test(item.text));
    }
  });
  test(`${protocol}: oversized previews and excess calls stay bounded without making invalid output dispatchable`, async () => {
    const { result, seen } = await run(protocol, JSON.stringify({ html: '甲'.repeat(201_000) }), { fragmentSize: 8192 });
    assert.equal(result.state, 'completed', result.reason);
    assert.equal(result.toolIntents[0].arguments.html.length, 201_000, 'preview bound never truncates native final arguments');
    assert.ok(seen.at(-1)[0].text.length > 199_000);
    assert.ok(seen.flat().every(item => item.text.length <= 200_000));
    const excessive = await run(protocol, JSON.stringify({ html }), { count: 9 });
    assert.notEqual(excessive.result.state, 'completed'); assert.deepEqual(excessive.result.toolIntents, []);
    assert.ok(excessive.seen.every(items => items.length <= 8));
  });
}
test('Responses duplicate/out-of-order protocol events freeze preview and never become tool intents', async () => {
  for (const sequence of [[0, 1, 1], [0, 1, 3, 2]]) {
    const { result, seen } = await run('responses', JSON.stringify({ html }), { transform(parts) {
      parts.forEach((part, index) => { part.sequence_number = sequence[index] ?? index; });
    } });
    assert.notEqual(result.state, 'completed'); assert.deepEqual(result.toolIntents, []);
    assert.ok(seen.length, 'a valid preview precedes the invalid ordering');
    for (let index = 1; index < seen.length; index++) assert.ok(seen[index][0].text.startsWith(seen[index - 1][0].text));
  }
});

test('cumulative call snapshots ignore repeats and stale prefixes, freeze conflicts, and preserve call identity', async () => {
  const { createJsonToolProgress } = await import(pathToFileURL(join(directory, 'json-tool-progress.mjs')));
  const seen = [], publish = createJsonToolProgress([tool], key, value => seen.push(value));
  const prefix = '{"html":"' + '甲'.repeat(100);
  const field = (callId, args) => ({ callId, name: tool.name, arguments: args });
  publish([field('one', prefix)]);
  const original = structuredClone(seen.at(-1));
  publish([field('one', prefix)]); publish([field('one', prefix.slice(0, -20))]);
  assert.deepEqual(seen.at(-1), original);
  publish([field('one', prefix + '乙'.repeat(100)), field('two', prefix)]);
  assert.equal(seen.at(-1).length, 2);
  const extended = structuredClone(seen.at(-1));
  publish([field('one', '{"html":"' + '丙'.repeat(300))]);
  publish([field('one', prefix + '乙'.repeat(200))]);
  assert.deepEqual(seen.at(-1), extended, 'divergent snapshots cannot replace an original preview');
  publish([field('two', prefix + '丁'.repeat(100))]);
  assert.deepEqual(seen.at(-1).find(item => item.callId === 'one'), extended.find(item => item.callId === 'one'));
  assert.ok(seen.at(-1).find(item => item.callId === 'two').text.length > extended.find(item => item.callId === 'two').text.length);
});
for (const protocol of protocols) test(`${protocol}: a complete escaped credential rejects final native output and never publishes secret bytes`, async () => {
  const encoded = [...key].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const { result, seen } = await run(protocol, '{"html":"' + '甲'.repeat(180) + encoded + '乙'.repeat(180) + '"}');
  assert.notEqual(result.state, 'completed'); assert.deepEqual(result.toolIntents, []);
  assert.ok(seen.length);
  assert.ok(seen.flat().every(item => /^甲+$/.test(item.text)));
  assert.ok(!JSON.stringify({ result, seen }).includes(key));
});
