import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime } from '@xunjie/product-runtime';
import { createServer } from 'node:http';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Requires native PostgreSQL 18.6.');
const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
async function product(run) {
  const root = await mkdtemp(join(tmpdir(), 'xj-model-gateway-'));
  const runtime = openProductRuntime({ root, resources });
  try {
    await runtime.install({ profile: 'local' });
    const { endpoint } = await runtime.start();
    const api = async (path, body, headers = {}) => {
      const response = await fetch(endpoint + '/api/learning/models/' + path, {
        headers: { 'content-type': 'application/json', 'x-xj-space': 'personal', ...headers },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    await run({ api, runtime, endpoint, root });
  } finally { await runtime.stop(); }
}
const connection = () => ({ connectionId: randomUUID(), expectedVersion: 0, name: '本人测试连接',
  protocol: 'chat-completions', baseUrl: 'https://api.deepseek.com/v1', path: '/chat/completions',
  modelId: 'deepseek-flash', dialect: 'deepseek', parameterMode: 'plain', enabled: true,
  credential: { action: 'replace', value: 'private-synthetic-key-should-never-be-projected' } });

test('the formal owner commits versioned personal connections and never projects credentials', { timeout: 180000 }, async () => {
  await product(async ({ api, runtime }) => {
    const input = connection();
    const saved = await api('connections', { requestId: randomUUID(), ...input });
    assert.equal(saved.status, 200);
    assert.equal(saved.value.version, 1);
    assert.equal(saved.value.hasCredential, true);
    assert.equal(JSON.stringify(saved.value).includes(input.credential.value), false);
    assert.equal(saved.value.adapterState, 'ready');
    assert.equal(saved.value.capabilities.images, 'unknown');
    const listed = await api('connections');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.value, [saved.value]);
    assert.equal((await api('connections', { requestId: randomUUID(), ...input, name: '过期写入' })).status, 409);
    const updated = await api('connections', { requestId: randomUUID(), ...input, expectedVersion: 1,
      name: '保留密钥', credential: { action: 'keep' } });
    assert.equal(updated.value.version, 2); assert.equal(updated.value.hasCredential, true);
    const moved = await api('connections', { requestId: randomUUID(), ...input, expectedVersion: 2,
      baseUrl: 'https://another.example/v1', credential: { action: 'keep' } });
    assert.equal(moved.status, 409, 'a changed authentication target must not silently receive the original key');
    const cleared = await api('connections', { requestId: randomUUID(), ...input, expectedVersion: 2, credential: { action: 'clear' } });
    assert.equal(cleared.value.version, 3); assert.equal(cleared.value.hasCredential, false);
    await runtime.stop(); await runtime.start();
    assert.equal((await api('connections')).value[0].version, 3);
    assert.equal((await api('connections', undefined, { 'x-xj-expected-subject': 'foreign.subject' })).status, 403);
  });
});

test('a saved connection check uses the actual SDK once and persists its original completion and usage', { timeout: 180000 }, async () => {
  const received = [];
  const upstream = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks)), authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = value => response.write('data: ' + JSON.stringify(value) + '\n\n');
    event({ id: 'chat-real-sdk', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'private native reasoning' }, finish_reason: null }] });
    const message = Buffer.from('data: ' + JSON.stringify({ id: 'chat-real-sdk', choices: [{ index: 0, delta: { content: '连接成功😀' }, finish_reason: null }] }) + '\n\n');
    const position = message.indexOf(Buffer.from('😀')) + 2;
    response.write(message.subarray(0, position)); response.write(message.subarray(position));
    event({ id: 'chat-real-sdk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    event({ id: 'chat-real-sdk', choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } } });
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  try {
    await product(async ({ api, runtime, root }) => {
      const input = { ...connection(), baseUrl, dialect: 'standard', modelId: 'fixture-model' };
      assert.equal((await api('connections', { requestId: randomUUID(), ...input })).status, 200);
      const check = { attemptId: randomUUID(), purpose: 'connection-check', source: { connectionId: input.connectionId, version: 1 },
        limits: { maxOutputTokens: 64, timeoutMs: 10000 } };
      const accepted = await api('checks', check);
      assert.equal(accepted.status, 200);
      assert.equal(accepted.value.state, 'accepted');
      assert.equal((await api('checks', check)).value.attemptId, check.attemptId);
      assert.equal((await api(`checks/${check.attemptId}/dispatch`, {})).status, 200);
      let result;
      for (let count = 0; count < 100; count++) {
        result = await api(`checks/${check.attemptId}`);
        if (result.value.state === 'completed') break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(result.value.state, 'completed');
      assert.equal(result.value.text, '连接成功😀');
      assert.equal(result.value.usage.state, 'final');
      assert.equal(result.value.usage.inputTokens, 7);
      assert.equal(result.value.usage.cachedTokens, 0);
      assert.ok(result.value.resultRef);
      assert.equal(JSON.stringify(result).includes('private native reasoning'), false);
      assert.equal(JSON.stringify(result).includes(input.credential.value), false);
      assert.equal(received.length, 1);
      assert.equal(received[0].url, '/v1/chat/completions');
      assert.equal(received[0].body.max_tokens, 64);
      assert.equal(received[0].body.stream, true);
      assert.equal(received[0].authorization, 'Bearer ' + input.credential.value);
      assert.equal((await api('checks', { ...check, limits: { ...check.limits, maxOutputTokens: 63 } })).status, 409);
      await runtime.stop(); await runtime.start();
      const after = await api(`checks/${check.attemptId}`);
      assert.equal(after.value.resultRef, result.value.resultRef);
      assert.equal(after.value.text, result.value.text);
      assert.equal((await api(`checks/${check.attemptId}/dispatch`, {})).value.resultRef, result.value.resultRef);
      assert.equal(received.length, 1);
      // Fault at the real owned resource boundary, not in a mocked repository.
      const environment = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
      const service = environment.services.find(service => service.unit === 'model-connection');
      const resourcePath = join(root, 'learning-resources', 'model-connection', environment.environmentId, service.serviceId, result.value.resultRef);
      await writeFile(resourcePath, 'damaged-native-resource');
      assert.equal((await api(`checks/${check.attemptId}`)).status, 503, 'a result without its verified native resource is not readable');
    });
  } finally { await new Promise(resolve => upstream.close(resolve)); }
});

test('unsaved checks preserve their snapshot, cancel before dispatch, and never change saved configuration', { timeout: 180000 }, async () => {
  let calls = 0;
  const upstream = createServer(async (_request, response) => {
    calls++; response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ id: 'held', choices: [{ index: 0, delta: { content: '先收到的部分' }, finish_reason: null }] }) + '\n\n');
    response.on('close', () => response.destroy());
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await product(async ({ api }) => {
      const input = connection();
      await api('connections', { requestId: randomUUID(), ...input });
      const draft = { ...input, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, modelId: 'unsaved-model' };
      delete draft.expectedVersion; delete draft.credential;
      const check = () => ({ attemptId: randomUUID(), purpose: 'connection-check', source: { draft,
        credential: { action: 'replace', value: 'temporary-key' } }, limits: { maxOutputTokens: 32, timeoutMs: 10000 } });
      const first = check();
      assert.equal((await api('checks', first)).status, 200);
      assert.equal((await api(`checks/${first.attemptId}/cancel`, {})).value.reason, 'not-started');
      await api(`checks/${first.attemptId}/dispatch`, {});
      assert.equal(calls, 0);
      assert.equal((await api('connections')).value[0].baseUrl, input.baseUrl);
      const second = check();
      await api('checks', second);
      await api(`checks/${second.attemptId}/dispatch`, {});
      for (let count = 0; calls === 0 && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(calls, 1);
      await api(`checks/${second.attemptId}/cancel`, {});
      let cancelled;
      for (let count = 0; count < 100; count++) {
        cancelled = (await api(`checks/${second.attemptId}`)).value;
        if (cancelled.physicalRequestEnded) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(cancelled.state, 'cancelled');
      assert.equal(cancelled.upstreamStopped, 'unknown');
      assert.equal(cancelled.usage.state, 'unknown');
      assert.equal(cancelled.connection.modelId, 'unsaved-model');
      const wrongTarget = check();
      wrongTarget.source.credential = { action: 'keep' };
      wrongTarget.source.savedCredential = { connectionId: input.connectionId, version: 1 };
      assert.equal((await api('checks', wrongTarget)).status, 409);
    });
  } finally { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});

test('HTTP and stream failures, missing terminals, truncation, unknown usage and real zero remain distinct', { timeout: 180000 }, async () => {
  let mode = 'http', calls = 0;
  const upstream = createServer((_request, response) => {
    calls++;
    if (mode === 'http') { response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'raw-secret-error-body', type: 'authentication_error' } })); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = value => response.write('data: ' + JSON.stringify(value) + '\n\n');
    send({ id: 'edge', choices: [{ index: 0, delta: { content: '实际部分' }, finish_reason: null }] });
    if (mode === 'stream-error') send({ error: { message: 'raw-secret-error-body', type: 'server_error' } });
    if (mode === 'truncated') send({ id: 'edge', choices: [{ index: 0, delta: {}, finish_reason: 'length' }] });
    if (mode === 'unknown-usage' || mode === 'zero') send({ id: 'edge', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    if (mode === 'zero') { send({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } });
      send({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }); }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await product(async ({ api }) => {
      const input = { ...connection(), baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, dialect: 'standard' };
      await api('connections', { requestId: randomUUID(), ...input });
      for (const scenario of ['http', 'stream-error', 'missing-terminal', 'truncated', 'unknown-usage', 'zero']) {
        mode = scenario;
        const check = { attemptId: randomUUID(), purpose: 'connection-check', source: { connectionId: input.connectionId, version: 1 }, limits: { maxOutputTokens: 32, timeoutMs: 5000 } };
        await api('checks', check); await api(`checks/${check.attemptId}/dispatch`, {});
        let fact;
        for (let count = 0; count < 100; count++) {
          fact = (await api(`checks/${check.attemptId}`)).value;
          if (fact.physicalRequestEnded) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(fact.state, ['http', 'stream-error'].includes(scenario) ? 'failed' : ['unknown-usage', 'zero'].includes(scenario) ? 'completed' : 'incomplete', scenario);
        assert.equal(JSON.stringify(fact).includes('raw-secret-error-body'), false);
        assert.equal(fact.usage.state, scenario === 'zero' ? 'final' : 'unknown');
        if (scenario === 'zero') { assert.equal(fact.usage.totalTokens, 0); assert.equal(fact.usage.outputTokens, 0); }
      }
      assert.equal(calls, 6, 'SDK failures must not create automatic retries');
      const limited = await api('checks', { attemptId: randomUUID(), purpose: 'connection-check', source: { connectionId: input.connectionId, version: 1 }, limits: { maxOutputTokens: 32, timeoutMs: 5000 } });
      assert.equal(limited.status, 503, 'failed/unknown checks still count toward the durable frequency limit');
    });
  } finally { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});
