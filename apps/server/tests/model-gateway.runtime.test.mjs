import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential, createProductRuntimeHost, createProductLearningApplication } from '@xunjie/product-runtime';
import { createServer } from 'node:http';
import pg from 'pg';
import { modelCommitRelay } from './model-commit-relay.mjs';

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

test('a saved connection check uses the actual SDK once and persists a rejected credential echo and final usage', { timeout: 180000 }, async () => {
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
    const key = request.headers.authorization.slice(7), split = Math.floor(key.length / 2);
    event({ id: 'chat-real-sdk', choices: [{ index: 0, delta: { content: key.slice(0, split) }, finish_reason: null }] });
    event({ id: 'chat-real-sdk', choices: [{ index: 0, delta: { content: key.slice(split) }, finish_reason: null }] });
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
        if (result.value.physicalRequestEnded) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(result.value.state, 'failed');
      assert.equal(result.value.reason, 'credential-in-output');
      assert.equal(result.value.text, '连接成功😀[redacted]');
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
      assert.equal(after.value.state, 'failed'); assert.equal(after.value.reason, 'credential-in-output');
      assert.equal(after.value.resultRef, result.value.resultRef);
      assert.equal(after.value.text, result.value.text);
      assert.equal((await api(`checks/${check.attemptId}/dispatch`, {})).value.resultRef, result.value.resultRef);
      assert.equal(received.length, 1);
      const key = randomBytes(32);
      await runtime.setCredential('model-backup-test', key.toString('base64'));
      const backup = await runtime.recovery.backup({ directory: await mkdtemp(join(tmpdir(), 'xj-model-backups-')), recoveryKeyRef: 'model-backup-test' });
      assert.equal(backup.services.length, 4, 'model facts and native resources participate in the product backup');
      assert.equal((await api(`checks/${check.attemptId}`)).value.resultRef, result.value.resultRef);
      // Fault at the real owned resource boundary, not in a mocked repository.
      const environment = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
      const service = environment.services.find(service => service.unit === 'model-connection');
      const resourcePath = join(root, 'learning-resources', 'model-connection', environment.environmentId, service.serviceId, result.value.resultRef);
      const stored = await readFile(resourcePath);
      const native = JSON.parse(stored.subarray(stored.indexOf(10) + 1).toString());
      assert.equal(native.redacted, true); assert.deepEqual(native.chunks, []);
      assert.equal(native.assistant, null); assert.deepEqual(native.choices, []);
      assert.equal(JSON.stringify(native).includes(input.credential.value), false);
      await writeFile(resourcePath, 'damaged-native-resource');
      assert.equal((await api(`checks/${check.attemptId}`)).status, 503, 'a result without its verified native resource is not readable');
      assert.equal((await api('checks')).status, 503, 'the polling list verifies the same resource boundary');
    });
  } finally { await new Promise(resolve => upstream.close(resolve)); }
});

test('malformed upstream usage and shapes are readable failures while a bounded wait ends as unknown', { timeout: 180000 }, async () => {
  let mode = 'negative-usage';
  const upstream = createServer((_request, response) => {
    if (mode === 'unsupported') { response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'private unsupported diagnostic', code: 'unsupported_model' } })); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (mode === 'timeout') { response.write(': waiting\n\n'); return; }
    const value = mode === 'negative-usage'
      ? { choices: [{ index: 0, delta: { content: '已收到' }, finish_reason: 'stop' }], usage: { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 } }
      : { choices: [{ index: 0, delta: { content: 123 }, finish_reason: 'stop' }] };
    response.end('data: ' + JSON.stringify(value) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await product(async ({ api }) => {
      const input = { ...connection(), baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, dialect: 'standard' };
      await api('connections', { requestId: randomUUID(), ...input });
      for (const scenario of ['negative-usage', 'malformed-text', 'timeout', 'unsupported']) {
        mode = scenario;
        const check = { attemptId: randomUUID(), purpose: 'connection-check', source: { connectionId: input.connectionId, version: 1 }, limits: { maxOutputTokens: 32, timeoutMs: 1000 } };
        await api('checks', check); await api(`checks/${check.attemptId}/dispatch`, {});
        let result;
        for (let count = 0; count < 150; count++) {
          result = await api(`checks/${check.attemptId}`);
          assert.equal(result.status, 200);
          if (result.value.physicalRequestEnded) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(result.value.state, scenario === 'timeout' ? 'unknown' : 'failed', scenario);
        assert.equal(result.value.reason, scenario === 'timeout' ? 'timeout' : scenario === 'unsupported' ? 'upstream-unsupported' : 'malformed-response');
        assert.equal(result.value.usage.state, 'unknown');
        assert.ok(result.value.resultRef);
      }
    });
  } finally { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
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

test('a killed production dispatcher preserves unknown usage without replay and reconciles its dead local client slot', { timeout: 180000 }, async () => {
  let calls = 0;
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the real SDK request before the process fault. */ }
    calls++; response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ id: 'interrupted', choices: [{ index: 0, delta: { content: '中断前' }, finish_reason: null }] }) + '\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await product(async ({ api, runtime, root, endpoint }) => {
      const input = { ...connection(), baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, dialect: 'standard' };
      await api('connections', { requestId: randomUUID(), ...input });
      const check = () => ({ attemptId: randomUUID(), purpose: 'connection-check', source: { connectionId: input.connectionId, version: 1 }, limits: { maxOutputTokens: 32, timeoutMs: 30000 } });
      const original = check(); await api('checks', original);
      const concurrent = await Promise.all([api(`checks/${original.attemptId}/dispatch`, {}), api(`checks/${original.attemptId}/dispatch`, {})]);
      assert.equal(concurrent.every(result => result.status === 200), true);
      for (let count = 0; calls === 0 && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(calls, 1);
      const instance = JSON.parse(await readFile(join(root, 'instance.json'), 'utf8'));
      const control = await fetch(instance.endpoint + '/runtime/control/status', { headers: { authorization: 'Bearer ' + await resolveCredential(root, 'control') } });
      assert.equal((await control.json()).environment.environmentId, (await runtime.status()).environment.environmentId);
      assert.ok(instance.pid > 0 && instance.pid !== process.pid);
      process.kill(instance.pid, 'SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 500));
      await runtime.start();
      // Stop must reconcile the dead dispatcher even if no client has queried the attempt yet.
      await runtime.stop();
      await runtime.start();
      const environment = (await runtime.status()).environment;
      const descriptor = environment.services.find(service => service.unit === 'model-connection');
      const binding = JSON.parse(await resolveCredential(root, 'storage-' + descriptor.serviceId));
      const owner = new pg.Client(binding.connection);
      try {
        await owner.connect();
        const { rows: [persisted] } = await owner.query(`SELECT physical_ended,body->>'reason' AS reason
          FROM ${pg.escapeIdentifier(binding.schema)}.model_attempts WHERE id=$1`, [original.attemptId]);
        assert.deepEqual(persisted, { physical_ended: true, reason: 'dispatcher-ended' });
      } finally { await owner.end(); }
      const unknown = await api(`checks/${original.attemptId}`);
      assert.equal(unknown.value.state, 'unknown'); assert.equal(unknown.value.dispatched, true);
      assert.equal(unknown.value.resultRef, null);
      assert.equal(unknown.value.physicalRequestEnded, true);
      assert.equal(unknown.value.reason, 'dispatcher-ended');
      assert.equal(unknown.value.usage.state, 'unknown');
      await api(`checks/${original.attemptId}/dispatch`, {});
      assert.equal(calls, 1);
      const another = check(); await api('checks', another);
      assert.equal((await api(`checks/${another.attemptId}/dispatch`, {})).status, 200);
      for (let count = 0; calls < 2 && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(calls, 2);
      await api(`checks/${another.attemptId}/cancel`, {});
      const cancelled = await api(`checks/${original.attemptId}/cancel`, {});
      assert.equal(cancelled.value.state, 'unknown'); assert.equal(cancelled.value.upstreamStopped, 'unknown');
      assert.equal(calls, 2);
    });
  } finally { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});

test('production maintenance finishes admitted checks before closing their result writes and reopens usable slots', { timeout: 180000 }, async () => {
  let release = () => {}, calls = 0;
  const held = new Promise(resolve => { release = resolve; });
  const upstream = createServer(async (_request, response) => {
    calls++; response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ id: 'maintenance-check', choices: [{ index: 0, delta: { content: '已收到' }, finish_reason: null }] }) + '\n\n');
    await held;
    response.end('data: ' + JSON.stringify({ id: 'maintenance-check', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'xj-model-maintenance-'));
  const runtime = openProductRuntime({ root, resources });
  let host;
  try {
    await runtime.install({ profile: 'local' }); host = await createProductRuntimeHost({ root, createApplication: createProductLearningApplication });
    const api = async (path, body) => {
      const response = await fetch(host.endpoint + '/api/learning/models/' + path, { headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const input = { ...connection(), baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, dialect: 'standard' };
    await api('connections', { requestId: randomUUID(), ...input });
    const check = () => ({ attemptId: randomUUID(), purpose: 'connection-check', source: { connectionId: input.connectionId, version: 1 }, limits: { maxOutputTokens: 32, timeoutMs: 20000 } });
    const first = check(); await api('checks', first); await api(`checks/${first.attemptId}/dispatch`, {});
    for (let count = 0; calls === 0 && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 1);
    const maintenance = host.maintenance.enter('model-check-test');
    while (host.maintenance.status().phase === 'open') await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await api('checks', check())).status, 503);
    release();
    assert.equal((await maintenance).safeToStop, true);
    await host.maintenance.resume();
    const result = await api(`checks/${first.attemptId}`);
    assert.equal(result.value.state, 'completed'); assert.equal(result.value.physicalRequestEnded, true);
    const next = check(); await api('checks', next); await api(`checks/${next.attemptId}/dispatch`, {});
    for (let count = 0; count < 100; count++) {
      if ((await api(`checks/${next.attemptId}`)).value.state === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await api(`checks/${next.attemptId}`)).value.state, 'completed'); assert.equal(calls, 2);
  } finally { release(); await host?.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});

test('a failed native result publication never publishes completion or releases a still running physical request', { timeout: 180000 }, async () => {
  let release = () => {}, calls = 0;
  const held = new Promise(resolve => { release = resolve; });
  const upstream = createServer(async (_request, response) => {
    calls++; response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '部分' }, finish_reason: null }] }) + '\n\n');
    await held;
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await product(async ({ api, root }) => {
      const input = { ...connection(), baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, dialect: 'standard' };
      await api('connections', { requestId: randomUUID(), ...input });
      const check = () => ({ attemptId: randomUUID(), purpose: 'connection-check', source: { connectionId: input.connectionId, version: 1 }, limits: { maxOutputTokens: 32, timeoutMs: 10000 } });
      const first = check(); await api('checks', first); await api(`checks/${first.attemptId}/dispatch`, {});
      for (let count = 0; calls === 0 && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(calls, 1);
      assert.equal((await api(`checks/${first.attemptId}`)).value.physicalRequestEnded, false);
      const second = check(); await api('checks', second);
      assert.equal((await api(`checks/${second.attemptId}/dispatch`, {})).status, 503);
      // Temporarily obstruct only this fixture's owned backend. PostgreSQL remains available.
      const resourceRoot = join(root, 'learning-resources', 'model-connection'), parked = resourceRoot + '-parked';
      await rename(resourceRoot, parked); await writeFile(resourceRoot, 'blocked-resource-backend');
      try {
        release(); let result;
        for (let count = 0; count < 150; count++) {
          result = await api(`checks/${first.attemptId}`);
          if (result.value.physicalRequestEnded) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(result.value.state, 'unknown'); assert.equal(result.value.reason, 'result-unconfirmed');
        assert.equal(result.value.resultRef, null); assert.equal(result.value.usage.state, 'unknown');
      } finally { await unlink(resourceRoot); await rename(parked, resourceRoot); }
      await api(`checks/${first.attemptId}/dispatch`, {}); assert.equal(calls, 1);
      await api(`checks/${second.attemptId}/dispatch`, {});
      for (let count = 0; count < 100; count++) {
        if ((await api(`checks/${second.attemptId}`)).value.state === 'completed') break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal((await api(`checks/${second.attemptId}`)).value.state, 'completed'); assert.equal(calls, 2);
    });
  } finally { release(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});

test('real school subjects isolate connections and checks, and revoked membership or cleared credentials cannot dispatch', { timeout: 180000 }, async () => {
  await product(async ({ api, root, endpoint }) => {
    const token = await resolveCredential(root, 'control');
    const manage = async (path, body) => fetch(endpoint + '/api/learning/manage/' + path, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
    const member = async loginName => {
      const password = randomUUID();
      const response = await manage('members', { requestId: randomUUID(), loginName, password });
      assert.equal(response.status, 200); const identity = await response.json();
      const login = await fetch(endpoint + '/api/learning/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName, password }) });
      return { identity, headers: { 'x-xj-space': 'school', cookie: login.headers.get('set-cookie').split(';')[0] } };
    };
    const alice = await member('model-alice'), bob = await member('model-bob');
    const input = connection();
    assert.equal((await api('connections', { requestId: randomUUID(), ...input }, alice.headers)).status, 200);
    assert.deepEqual((await api('connections', undefined, bob.headers)).value, []);
    const check = () => ({ attemptId: randomUUID(), purpose: 'connection-check', source: { connectionId: input.connectionId, version: 1 }, limits: { maxOutputTokens: 32, timeoutMs: 1000 } });
    const first = check(); assert.equal((await api('checks', first, alice.headers)).status, 200);
    assert.equal((await api(`checks/${first.attemptId}`, undefined, bob.headers)).status, 404);
    assert.equal((await api(`checks/${first.attemptId}/cancel`, {}, bob.headers)).status, 404);
    assert.equal((await api('checks', check(), bob.headers)).status, 404);
    await api('connections', { requestId: randomUUID(), ...input, expectedVersion: 1, credential: { action: 'clear' } }, alice.headers);
    assert.equal((await api(`checks/${first.attemptId}/dispatch`, {}, alice.headers)).status, 403);
    assert.equal((await api(`checks/${first.attemptId}/cancel`, {}, alice.headers)).value.dispatched, false);
    const restored = await api('connections', { requestId: randomUUID(), ...input, expectedVersion: 2 }, alice.headers);
    const second = check(); second.source.version = restored.value.version;
    await api('checks', second, alice.headers);
    assert.equal((await manage('membership', { requestId: randomUUID(), principalId: alice.identity.principalId, active: false })).status, 200);
    assert.equal((await api(`checks/${second.attemptId}/dispatch`, {}, alice.headers)).status, 403);
    assert.equal((await api(`checks/${second.attemptId}`, undefined, alice.headers)).status, 403);
    assert.deepEqual((await api('connections', undefined, bob.headers)).value, []);
  });
});

test('lost real PostgreSQL claim and result COMMIT replies keep truthful physical slots and durable completions', { timeout: 180000 }, async () => {
  let calls = 0;
  const upstream = createServer((_request, response) => {
    calls++; response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '确认完成' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let relay;
  try {
    await product(async ({ api, runtime, root }) => {
      await runtime.stop();
      const environment = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
      const descriptor = environment.services.find(service => service.unit === 'model-connection');
      const ref = 'storage-' + descriptor.serviceId;
      const binding = JSON.parse(await resolveCredential(root, ref));
      relay = await modelCommitRelay(binding.connection.port);
      await writeFile(join(root, 'credentials', ref), JSON.stringify({ ...binding, connection: { ...binding.connection, port: relay.port } }), { mode: 0o600 });
      await runtime.start();
      const input = { ...connection(), baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, dialect: 'standard' };
      await api('connections', { requestId: randomUUID(), ...input });
      const check = () => ({ attemptId: randomUUID(), purpose: 'connection-check', source: { connectionId: input.connectionId, version: 1 }, limits: { maxOutputTokens: 32, timeoutMs: 10000 } });
      const first = check(); await api('checks', first);
      relay.arm('physical_ended=false,dispatcher_id');
      await api(`checks/${first.attemptId}/dispatch`, {});
      const notSent = await api(`checks/${first.attemptId}`);
      assert.equal(relay.cuts(), 1); assert.equal(calls, 0);
      assert.equal(notSent.value.physicalRequestEnded, true, 'this process never started the SDK for its lost-ACK claim');
      assert.equal(notSent.value.dispatched, false); assert.equal(notSent.value.reason, 'dispatch-not-started');
      await api(`checks/${first.attemptId}/dispatch`, {}); assert.equal(calls, 0);
      const second = check(); await api('checks', second);
      relay.arm('state=$3,physical_ended=true WHERE');
      await api(`checks/${second.attemptId}/dispatch`, {});
      let completed;
      for (let count = 0; count < 150; count++) {
        completed = await api(`checks/${second.attemptId}`);
        if (completed.value.physicalRequestEnded) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(relay.cuts(), 2); assert.equal(calls, 1);
      assert.equal(completed.value.state, 'completed'); assert.ok(completed.value.resultRef);
      await runtime.stop(); await runtime.start();
      assert.deepEqual((await api(`checks/${second.attemptId}`)).value, completed.value);
      assert.equal(calls, 1);
    });
  } finally { await relay?.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});
