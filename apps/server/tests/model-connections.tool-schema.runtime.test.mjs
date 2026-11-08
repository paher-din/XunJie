import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openProductRuntime } from '@xunjie/product-runtime';

const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN,
  webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
const send = (response, value) => response.write('data: ' + JSON.stringify(value) + '\n\n');
function toolReply(response, protocol, args) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if (protocol === 'chat-completions') {
    send(response, { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'schema-call', type: 'function',
      function: { name: 'inspect', arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
    response.end('data: [DONE]\n\n');
  } else if (protocol === 'responses') {
    send(response, { type: 'response.completed', response: { id: 'schema-response', object: 'response', status: 'completed',
      output: [{ id: 'schema-item', type: 'function_call', call_id: 'schema-call', name: 'inspect', arguments: JSON.stringify(args), status: 'completed' }],
      usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 } } });
    response.end();
  } else {
    for (const event of [
      { type: 'message_start', message: { id: 'schema-message', type: 'message', role: 'assistant', model: 'schema-fixture', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'schema-call', name: 'inspect', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 7, output_tokens: 4 } },
      { type: 'message_stop' },
    ]) response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
    response.end();
  }
}
async function product(protocol, run) {
  const received = [];
  let args = {};
  const upstream = createServer(async (request, response) => {
    const parts = []; for await (const part of request) parts.push(part);
    received.push(JSON.parse(Buffer.concat(parts)));
    toolReply(response, protocol, args);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'xj-216-tool-schema-'));
  const runtime = openProductRuntime({ root, resources });
  try {
    await runtime.install({ profile: 'local' });
    let endpoint = (await runtime.start()).endpoint;
    const api = async (path, body) => {
      const response = await fetch(endpoint + '/api/learning/models/' + path, { headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const connectionId = randomUUID();
    assert.equal((await api('connections', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'Schema fixture', protocol,
      baseUrl: `http://127.0.0.1:${upstream.address().port}/${protocol === 'messages' ? 'anthropic' : 'v1'}`,
      path: protocol === 'messages' ? '/v1/messages' : protocol === 'responses' ? '/responses' : '/chat/completions',
      modelId: 'schema-fixture', dialect: 'standard', parameterMode: 'plain', enabled: true,
      credential: { action: 'replace', value: 'synthetic-schema-key' } })).status, 200);
    const source = { connectionId, version: 1 };
    const segment = (schema, extra = {}, options = {}) => api('segments', { requestId: randomUUID(), segmentId: randomUUID(), source,
      prefix: { system: 'Read the permitted object', tools: [{ name: 'inspect', description: 'Inspect', inputSchema: schema, ...extra }], options }, portable: [] });
    const finish = async (segmentId, argumentsValue) => {
      args = argumentsValue;
      const attemptId = randomUUID();
      const accepted = await api('calls', { attemptId, purpose: 'chat-probe', segmentId, expectedSequence: 0,
        input: { text: 'Inspect', images: [], toolResults: [] }, limits: { maxOutputTokens: 512, timeoutMs: 10000 } });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.value));
      assert.equal((await api(`calls/${attemptId}/dispatch`, {})).status, 200);
      for (let count = 0; count < 200; count++) {
        const result = await api(`calls/${attemptId}`);
        assert.equal(result.status, 200, JSON.stringify(result.value));
        if (result.value.physicalRequestEnded) return result.value;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Bounded schema call did not finish');
    };
    await run({ api, source, segment, finish, received, async restart() { await runtime.stop(); endpoint = (await runtime.start()).endpoint; } });
  } finally {
    await runtime.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

for (const protocol of ['chat-completions', 'responses', 'messages']) {
  test(`${protocol}: full local schema survives projection and rejects invalid tool arguments`, { timeout: 180000 }, async () => {
    await product(protocol, async ({ api, segment, finish, received, restart }) => {
      const schema = { type: 'object', $id: 'urn:xunjie:inspect', definitions: { code: { type: 'string', pattern: '^ALU-[0-9]{2}$' } },
        properties: { pattern: { $ref: '#/definitions/code' }, count: { type: 'integer', minimum: 1, maximum: 4 },
          mode: { enum: ['read', 'compare'] } }, required: ['pattern', 'count', 'mode'],
        patternProperties: { '^pin_[0-9]+$': { type: 'boolean' } }, additionalProperties: false,
        if: { properties: { mode: { const: 'compare' } } }, then: { properties: { count: { minimum: 2 } } } };
      const valid = { pattern: 'ALU-02', count: 2, mode: 'compare', pin_1: true };
      const created = await segment(schema);
      assert.equal(created.status, 200, 'legal local references/regex must not be categorically rejected: ' + JSON.stringify(created.value));
      const first = await finish(created.value.segmentId, valid);
      assert.equal(first.state, 'completed');
      assert.deepEqual(first.toolIntents, [{ callId: 'schema-call', name: 'inspect', arguments: valid }]);
      const projected = received[0].tools[0];
      assert.deepEqual(protocol === 'messages' ? projected.input_schema : protocol === 'responses' ? projected.parameters : projected.function.parameters, schema);
      assert.notEqual(protocol === 'chat-completions' ? projected.function.strict : projected.strict, true);
      await restart();
      assert.deepEqual((await api(`calls/${first.attemptId}`)).value.toolIntents, first.toolIntents);
      for (const invalid of [
        { ...valid, pattern: 'ALU-XX' }, { ...valid, count: 1 }, { ...valid, mode: 'write' },
        { ...valid, pin_1: 'true' }, { ...valid, extra: true },
      ]) {
        const next = await segment(schema); assert.equal(next.status, 200);
        const rejected = await finish(next.value.segmentId, invalid);
        assert.equal(rejected.state, 'failed', JSON.stringify(invalid)); assert.deepEqual(rejected.toolIntents, []);
      }
    });
  });

  test(`${protocol}: schema dialect constraints are validated instead of dropped`, { timeout: 180000 }, async () => {
    await product(protocol, async ({ segment, finish }) => {
      for (const [schema, valid, invalid] of [
        [{ $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'object',
          properties: { mode: { type: ['string', 'null'] }, count: { type: 'integer' } },
          dependentRequired: { mode: ['count'] }, unevaluatedProperties: false }, { mode: null, count: 1 }, { mode: null }],
        [{ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
          properties: { pins: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }], items: false } },
          required: ['pins'], unevaluatedProperties: false }, { pins: ['A', 1] }, { pins: [1, 'A'] }],
      ]) {
        const created = await segment(schema);
        assert.equal(created.status, 200, JSON.stringify(created.value));
        const accepted = await finish(created.value.segmentId, valid);
        assert.equal(accepted.state, 'completed'); assert.deepEqual(accepted.toolIntents[0].arguments, valid);
        const next = await segment(schema); assert.equal(next.status, 200);
        const rejected = await finish(next.value.segmentId, invalid);
        assert.equal(rejected.state, 'failed'); assert.deepEqual(rejected.toolIntents, []);
      }
    });
  });

  test(`${protocol}: unsupported schema and unverified native strict refuse before sending`, { timeout: 180000 }, async () => {
    await product(protocol, async ({ api, source, segment, received }) => {
      for (const schema of [
        { type: 'object', $async: true },
        { type: 'object', properties: { value: { $ref: 'https://unavailable.invalid/schema' } } },
        { type: 'object', unknownRequiredConstraint: true },
      ]) assert.equal((await segment(schema)).status, 400);
      const inputSchema = { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false };
      const prefix = { system: '', tools: [{ name: 'inspect', description: '', inputSchema, strict: true }] };
      const decision = await api('capabilities', { source, prefix });
      assert.equal(decision.status, 200); assert.equal(decision.value.available, false);
      assert.ok(decision.value.missing.some(item => item.capability === 'strictTools' && item.status === 'unknown'));
      const strict = await segment(inputSchema, { strict: true });
      assert.equal(strict.status, 422); assert.equal(strict.value.error, 'capability-unavailable');
      assert.equal(received.length, 0);
    });
  });
}
