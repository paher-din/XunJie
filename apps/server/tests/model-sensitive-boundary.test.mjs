import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'xj-sensitive-boundary-'));
after(() => rm(directory, { recursive: true, force: true }));
await build({ entryPoints: ['chat', 'responses', 'messages'].map(name => fileURLToPath(new URL(`../../../packages/model-gateway/src/${name}.ts`, import.meta.url))),
  outdir: directory, bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' },
  plugins: [{ name: 'installed-dependencies', setup(builder) { builder.onResolve({ filter: /^[^./]/ }, args => isAbsolute(args.path) ? undefined : ({
    path: args.path.startsWith('node:') ? args.path : import.meta.resolve(args.path), external: true,
  })); } }] });
const adapters = { 'chat-completions': (await import(pathToFileURL(join(directory, 'chat.mjs')))).runChat,
  responses: (await import(pathToFileURL(join(directory, 'responses.mjs')))).runResponses,
  messages: (await import(pathToFileURL(join(directory, 'messages.mjs')))).runMessages };
const key = 'synthetic-"boundary\\-key';
const escaped = [...key].map(character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')).join('');
const json = '{"nonce":"' + escaped + '"}';
const schema = { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false };
const messageStart = { type: 'message_start', message: { id: 'message-1', type: 'message', role: 'assistant', model: 'fixture', content: [],
  stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } };
const messagesEnd = reason => [{ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { input_tokens: 7, output_tokens: 4 } }, { type: 'message_stop' }];
const responseTerminal = (text, status) => ({ type: 'response.' + status, response: { id: 'response-1', object: 'response', status,
  output: [{ id: 'message-1', type: 'message', role: 'assistant', status: status === 'completed' ? 'completed' : 'incomplete',
    content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 } } });
function textEvents(protocol, text, incomplete) {
  if (protocol === 'chat-completions') return [{ choices: [{ index: 0, delta: { content: text }, finish_reason: incomplete ? 'length' : 'stop' }] }];
  if (protocol === 'responses') return [responseTerminal(text, incomplete ? 'incomplete' : 'completed')];
  return [messageStart, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index: 0 },
    ...messagesEnd(incomplete ? 'max_tokens' : 'end_turn')];
}
async function run(protocol, events, structured = false, application = false) {
  let requests = 0;
  const payload = protocol === 'responses' ? { model: 'fixture', stream: true, input: 'fixture',
    ...(structured ? { text: { format: { type: 'json_schema', name: 'answer', schema, strict: true } } } : {}) }
    : { model: 'fixture', stream: true, max_tokens: 64, messages: [{ role: 'user', content: 'fixture' }],
      ...(structured ? protocol === 'messages' ? { output_config: { format: { type: 'json_schema', schema } } }
        : { response_format: { type: 'json_object' } } : {}) };
  const configuration = { protocol, modelId: 'fixture', dialect: 'standard', parameterMode: 'plain', baseUrl: 'https://fixture.invalid' };
  const result = await adapters[protocol](configuration, key, payload, new AbortController().signal, 2000, [], application ? schema : undefined,
    async () => { requests++; return new Response(events.map(value => (protocol === 'messages' ? `event: ${value.type}\n` : '')
      + 'data: ' + JSON.stringify(value) + '\n\n').join('') + (protocol === 'chat-completions' ? 'data: [DONE]\n\n' : ''),
    { headers: { 'content-type': 'text/event-stream' } }); });
  assert.equal(requests, 1); return result;
}
for (const protocol of Object.keys(adapters)) for (const boundary of ['native-format', 'application-schema'])
  for (const ending of ['completed', 'incomplete', 'malformed-json']) test(`${protocol} inspects ${boundary} credentials after ${ending}`, async () => {
    const result = await run(protocol, textEvents(protocol, ending === 'malformed-json' ? json.slice(0, -1) : json, ending === 'incomplete'),
      boundary === 'native-format', boundary === 'application-schema');
    assert.notEqual(result.state, 'completed'); assert.equal(result.reason, 'credential-in-output');
    assert.equal(result.text, ''); assert.deepEqual(result.toolIntents, []); assert.equal(result.native.redacted, true);
    assert.deepEqual(protocol === 'chat-completions' ? result.native.chunks : result.native.events, []);
  });

for (const kind of ['late', 'invalid-index']) test(`Messages scans rejected ${kind} tool JSON event before retaining native evidence`, async () => {
  const delta = { type: 'content_block_delta', index: kind === 'late' ? 0 : 99, delta: { type: 'input_json_delta', partial_json: json } };
  const events = kind === 'late' ? [...textEvents('messages', 'OK', false), delta] : [messageStart, delta];
  const result = await run('messages', events);
  assert.equal(result.state, 'failed'); assert.deepEqual(result.toolIntents, []);
  assert.equal(result.native.redacted, true); assert.deepEqual(result.native.events, []);
});
for (const kind of ['late', 'invalid-sequence']) test(`Responses scans rejected ${kind} tool JSON delta before retaining native evidence`, async () => {
  const delta = { type: 'response.function_call_arguments.delta', item_id: 'call-item', output_index: 0, delta: json,
    ...(kind === 'invalid-sequence' ? { sequence_number: 42 } : {}) };
  const events = kind === 'late' ? [responseTerminal('OK', 'completed'), delta]
    : [{ type: 'response.created', sequence_number: 0, response: { id: 'response-1', object: 'response', status: 'in_progress', output: [] } }, delta];
  const result = await run('responses', events);
  assert.equal(result.state, 'failed'); assert.deepEqual(result.toolIntents, []);
  assert.equal(result.native.redacted, true); assert.deepEqual(result.native.events, []);
});
for (const protocol of Object.keys(adapters)) test(`${protocol} leaves ordinary text outside JSON boundaries uninterpreted`, async () => {
  const result = await run(protocol, textEvents(protocol, json, false));
  assert.equal(result.state, 'completed'); assert.equal(result.text, json); assert.notEqual(result.native.redacted, true);
});
for (const protocol of Object.keys(adapters)) test(`${protocol} checks structured text in the final rejected event`, async () => {
  const tail = protocol === 'chat-completions' ? { choices: [{ index: 0, delta: { content: json }, finish_reason: null }] }
    : protocol === 'messages' ? { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: json } }
      : { type: 'response.output_text.delta', item_id: 'message-1', output_index: 0, content_index: 0, delta: json };
  const result = await run(protocol, [...textEvents(protocol, 'OK', false), tail], true);
  assert.equal(result.state, 'failed'); assert.deepEqual(result.toolIntents, []); assert.equal(result.native.redacted, true);
  assert.deepEqual(protocol === 'chat-completions' ? result.native.chunks : result.native.events, []);
});
test('Messages aggregates a signature across an initial block and its rejected final delta', async () => {
  const events = [messageStart, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: key.slice(0, 12) } },
    { type: 'content_block_stop', index: 0 }, ...messagesEnd('end_turn'),
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: key.slice(12) } }];
  const result = await run('messages', events);
  assert.equal(result.state, 'failed'); assert.equal(result.native.redacted, true); assert.deepEqual(result.native.events, []);
});
for (const initial of ['part', 'item']) test(`Responses scans reasoning ${initial} initial text with a rejected delta`, async () => {
  const start = initial === 'part' ? { type: 'response.reasoning_summary_part.added', sequence_number: 0, output_index: 0,
    item_id: 'reason-1', summary_index: 0, part: { type: 'summary_text', text: key.slice(0, 12) } }
    : { type: 'response.output_item.added', sequence_number: 0, output_index: 0,
      item: { id: 'reason-1', type: 'reasoning', summary: [{ type: 'summary_text', text: key.slice(0, 12) }] } };
  const result = await run('responses', [start, { type: 'response.reasoning_summary_text.delta', sequence_number: 2,
    output_index: 0, item_id: 'reason-1', summary_index: 0, delta: key.slice(12) }]);
  assert.equal(result.state, 'failed'); assert.equal(result.native.redacted, true); assert.deepEqual(result.native.events, []);
});
test('Responses checks the visible text projected from every part of a rejected snapshot', async () => {
  const snapshot = responseTerminal('', 'completed'); snapshot.sequence_number = 2;
  snapshot.response.output[0].content = [{ type: 'output_text', text: json.slice(0, 18), annotations: [] },
    { type: 'output_text', text: json.slice(18), annotations: [] }];
  const result = await run('responses', [{ type: 'response.created', sequence_number: 0,
    response: { id: 'response-1', object: 'response', status: 'in_progress', output: [] } }, snapshot], true);
  assert.equal(result.state, 'failed'); assert.equal(result.native.redacted, true); assert.deepEqual(result.native.events, []);
});
test('Messages scans the visible projection of a rejected nonempty initial content snapshot', async () => {
  const result = await run('messages', [{ ...messageStart, message: { ...messageStart.message,
    content: [{ type: 'text', text: json.slice(0, 18) }, { type: 'text', text: json.slice(18) }] } }], true);
  assert.equal(result.state, 'failed'); assert.equal(result.native.redacted, true); assert.deepEqual(result.native.events, []);
});
test('Messages checks structured text spanning an accepted block and rejected new block', async () => {
  const result = await run('messages', [messageStart,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: json.slice(0, 18) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: json.slice(18) } }], true);
  assert.equal(result.state, 'failed'); assert.equal(result.native.redacted, true); assert.deepEqual(result.native.events, []);
});
test('Responses checks structured text spanning parts even when the final delta has bad sequence', async () => {
  const result = await run('responses', [
    { type: 'response.output_text.delta', sequence_number: 0, output_index: 0, item_id: 'message-1', content_index: 0, delta: json.slice(0, 18) },
    { type: 'response.output_text.delta', sequence_number: 2, output_index: 0, item_id: 'message-1', content_index: 1, delta: json.slice(18) }], true);
  assert.equal(result.state, 'failed'); assert.equal(result.native.redacted, true); assert.deepEqual(result.native.events, []);
});
for (const protocol of ['messages', 'responses']) test(`${protocol} withholds malformed interleaving whose text only reconstructs by logical index`, async () => {
  const x = json.slice(0, 18), y = json.slice(18, 38), z = json.slice(38);
  const events = protocol === 'messages' ? [messageStart,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: x } },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: z } }, { type: 'content_block_stop', index: 0 },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: y } }]
    : [[0, 0, x], [1, 1, z], [3, 0, y]].map(([sequence_number, content_index, delta]) => ({
      type: 'response.output_text.delta', sequence_number, output_index: 0, item_id: 'message-1', content_index, delta }));
  const result = await run(protocol, events, true);
  assert.equal(result.state, 'failed'); assert.equal(result.native.redacted, true); assert.deepEqual(result.native.events, []);
});
test('Responses does not retain rejected duplicated snapshots mixed with argument deltas', async () => {
  const prefix = '{"nonce":"' + escaped.slice(0, 30), item = { id: 'f', type: 'function_call', call_id: 'call-f', name: 'read_marker', arguments: prefix };
  const result = await run('responses', [{ type: 'response.created', sequence_number: 0,
    response: { id: 'response-1', object: 'response', status: 'in_progress', output: [item] } },
  { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item },
  { type: 'response.function_call_arguments.delta', sequence_number: 3, output_index: 0, item_id: 'f', delta: escaped.slice(30) + '"}' }]);
  assert.equal(result.state, 'failed'); assert.equal(result.native.redacted, true); assert.deepEqual(result.native.events, []);
});
for (const [name, event] of [
  ['mcp_call', { type: 'response.output_item.added', output_index: 0, item: { type: 'mcp_call', id: 'mcp-1', name: 'fixture', server_label: 'fixture', arguments: json } }],
  ['mcp_approval_request', { type: 'response.output_item.added', output_index: 0, item: { type: 'mcp_approval_request', id: 'mcp-1', name: 'fixture', server_label: 'fixture', arguments: json } }],
  ['mcp_arguments_delta', { type: 'response.mcp_call_arguments.delta', output_index: 0, item_id: 'mcp-1', delta: json }],
  ['mcp_arguments_done', { type: 'response.mcp_call_arguments.done', output_index: 0, item_id: 'mcp-1', arguments: json }],
  ['shell_output', { type: 'response.output_item.added', output_index: 0, item: { type: 'local_shell_call_output', id: 'shell-1', output: json } }],
]) test(`Responses withholds unsupported ${name} JSON instead of preserving uninterpreted bytes`, async () => {
  const result = await run('responses', [event]);
  assert.equal(result.state, 'failed'); assert.equal(result.native.redacted, true); assert.deepEqual(result.native.events, []);
});
for (const entrance of ['delta', 'done', 'part', 'item', 'terminal', 'split-deltas']) test(`Responses checks ordered primary logprob tokens from ${entrance}`, async () => {
  const logprobs = [key.slice(0, 12), key.slice(12)].map(token => ({ token, logprob: -1, top_logprobs: [] }));
  const part = { type: 'output_text', text: 'OK', annotations: [], logprobs };
  let events;
  if (entrance === 'terminal') { const terminal = responseTerminal('OK', 'completed'); terminal.response.output[0].content[0] = part; events = [terminal]; }
  else if (entrance === 'item') events = [{ type: 'response.output_item.added', output_index: 0, item: { id: 'message-1', type: 'message', role: 'assistant', status: 'in_progress', content: [part] } }];
  else if (entrance === 'part') events = [{ type: 'response.content_part.added', item_id: 'message-1', output_index: 0, content_index: 0, part }];
  else if (entrance === 'split-deltas') events = logprobs.map((value, sequence_number) => ({ type: 'response.output_text.delta', sequence_number,
    item_id: 'message-1', output_index: 0, content_index: 0, delta: 'OK', logprobs: [value] }));
  else events = [{ type: 'response.output_text.' + entrance, item_id: 'message-1', output_index: 0, content_index: 0,
    ...(entrance === 'delta' ? { delta: 'OK' } : { text: 'OK' }), logprobs }];
  const result = await run('responses', events);
  assert.notEqual(result.state, 'completed'); assert.equal(result.native.redacted, true); assert.deepEqual(result.native.events, []);
});
