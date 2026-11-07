import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createLearningModelService, createLearningModelClient } from '../../../packages/learning-space/dist/model-connections/service.js';
import { StorageError } from '@xunjie/storage';
const identity = { kind: 'personal', name: '学习', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };

test('the explicit learning boundary rejects unknown operations, extra arguments and normalizes errors', async () => {
  const service = createLearningModelService({ selection: { read: async () => { throw new Error('private connection string'); } } }, async () => {});
  assert.deepEqual(await service({ operation: 'save', identity, args: [] }), { ok: false, code: 'invalid' });
  assert.deepEqual(await service({ operation: 'selection.read', identity, args: ['extra'] }), { ok: false, code: 'invalid' });
  assert.deepEqual(await service({ operation: 'selection.read', identity, args: [] }), { ok: false, code: 'unavailable' });
  const client = createLearningModelClient(service);
  await assert.rejects(client.selection.read(identity), { code: 'unavailable' });
  const denied = createLearningModelService({}, async () => { throw new StorageError('stale-generation'); });
  assert.deepEqual(await denied({ operation: 'selection.read', identity, args: [] }), { ok: false, code: 'stale-generation' });
});

import { provisionStorage, openStorage, createFileBackend } from '@xunjie/storage';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { createModelGateway, modelMigrations } from '../../../packages/learning-space/dist/model-connections/index.js';
import { createModelDeviceTasks } from '../../../packages/learning-space/dist/model-connections/device-tasks.js';
import { defaultLearningAdmissionPolicy } from '../../../packages/learning-space/dist/model-connections/learning-admission.js';

test('versioned learning tasks survive reopen and reject replacing original owner or recovery generation', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture(); let storage;
  try {
    const binding = await provisionStorage({ admin: fixture.admin, owner: { environmentId: identity.environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations: modelMigrations });
    const backend = createFileBackend({ id: 'files', root: fixture.root + '/objects' });
    storage = await openStorage({ binding, migrations: modelMigrations, backend });
    const actor = { ...identity, kind: 'school' };
    const pair = { grantId: randomUUID(), installationId: randomUUID() };
    const attemptId = randomUUID();
    const task = { taskId: randomUUID(), attemptId, operation: 'learning', formatVersion: 1,
      origin: { service: { environmentId: actor.environmentId, serviceId: randomUUID() }, identity: actor,
        runId: randomUUID(), attemptId, recoveryGeneration: pair.installationId },
      request: { operation: 'checks.requestPayload', identity: actor, args: [attemptId] } };
    let tasks = createModelDeviceTasks(storage, async () => {}, () => {});
    assert.deepEqual(await tasks.enqueue(actor, pair, task), task);
    await assert.rejects(tasks.enqueue(actor, pair, { ...task, origin: { ...task.origin, recoveryGeneration: randomUUID() } }), { code: 'stale-generation' });
    await assert.rejects(tasks.enqueue(actor, pair, { ...task, origin: { ...task.origin, service: { ...task.origin.service, serviceId: randomUUID() } } }), { code: 'identity-conflict' });
    await tasks.complete(actor, pair, task.taskId, { ok: true, value: { model: 'fixture', stream: true, stream_options: { include_usage: true }, max_tokens: 10, messages: [{ role: 'user', content: '大结果'.repeat(400000) }] } });
    await storage.close(); storage = await openStorage({ binding, migrations: modelMigrations, backend });
    tasks = createModelDeviceTasks(storage, async () => {}, () => {});
    assert.equal((await tasks.read(actor, pair, task.taskId)).receipt.value.messages[0].content.length, 1200000);
    assert.deepEqual(await tasks.pending(actor, pair), []);
    await tasks.validate();
    await assert.rejects(tasks.read(actor, { ...pair, grantId: randomUUID() }, task.taskId), { code: 'missing' });
    await assert.rejects(tasks.enqueue(actor, pair, { ...task, taskId: randomUUID(), request: { ...task.request, identity: { ...actor, principalId: randomUUID() } } }));
  } finally { await storage?.close(); await fixture.close(); }
});

import { createServer } from 'node:http';

test('real PG and SDK dispatch returns durable acceptance while reads and cancellation remain live; authorization is rechecked before send', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture(); let storage; let gateway; let sends = 0; let started; let finish = false;
  const start = new Promise(resolve => { started = resolve; });
  const upstream = createServer(async (request, response) => {
    for await (const _ of request) { /* consume the actual SDK body */ }
    sends++; response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"index":0,"delta":{"content":"等待结果"},"finish_reason":null}]}\n\n');
    started();
    if (finish) response.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    // Intentionally hold the upstream open until cancellation.
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const binding = await provisionStorage({ admin: fixture.admin, owner: { environmentId: identity.environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations: modelMigrations });
    storage = await openStorage({ binding, migrations: modelMigrations, backend: createFileBackend({ id: 'files', root: fixture.root + '/objects' }) });
    let allowed = true;
    const authorize = async () => { if (!allowed) throw new StorageError('forbidden'); };
    // This fixture deliberately starts one more request after an unconfirmed
    // cancellation; its unknown upstream reservation must continue occupying slot 1.
    gateway = await createModelGateway(storage, { holder: 'device', authorize,
      learningAdmissionPolicy: { ...defaultLearningAdmissionPolicy, version: 'service-cancel-fixture-v1', maxPrincipalPhysical: 2 } });
    const connectionId = randomUUID();
    await gateway.save(identity, { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'SDK测试', protocol: 'chat-completions',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions', modelId: 'fixture', dialect: 'standard',
      parameterMode: 'plain', enabled: true, credential: { action: 'replace', value: 'synthetic-private-key' } });
    const seen = []; let rejectDispatch = false;
    const client = createLearningModelClient(async request => {
      // Exercise a JSON round trip, matching the host's reassembled transport.
      const reply = await service(JSON.parse(JSON.stringify(request)));
      assert.equal(JSON.stringify(reply).includes('synthetic-private-key'), false);
      return JSON.parse(JSON.stringify(reply));
    });
    const service = createLearningModelService(gateway, async (actor, operation, args) => {
      seen.push({ actor, operation, args });
      if (rejectDispatch && operation === 'checks.dispatch') throw new StorageError('forbidden');
      await authorize();
    });
    const segmentId = randomUUID();
    await client.segments.create(identity, { requestId: randomUUID(), segmentId, purpose: 'learning', source: { connectionId, version: 1 }, prefix: { system: '帮助学习', tools: [] }, portable: [] });
    const input = { attemptId: randomUUID(), purpose: 'learning', segmentId, expectedSequence: 0,
      input: { text: '解释代码', images: [], toolResults: [] }, limits: { maxOutputTokens: 256, timeoutMs: 15000 } };
    assert.equal((await client.checks.receive(identity, input)).state, 'accepted');
    const fact = await client.checks.dispatch(identity, input.attemptId);
    assert.notEqual(fact.state, 'accepted');
    assert.equal(fact.attemptId, input.attemptId);
    assert.equal(fact.physicalRequestEnded, false);
    await Promise.race([start, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('SDK did not start')), 10000); t.unref(); })]);
    assert.equal((await client.checks.read(identity, input.attemptId)).dispatched, true);
    assert.ok(await client.checks.requestPayload(identity, input.attemptId));
    const cancelled = await client.checks.cancel(identity, input.attemptId);
    assert.equal(cancelled.cancelRequested, true);
    for (let n = 0; n < 200 && !(await client.checks.read(identity, input.attemptId)).physicalRequestEnded; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await client.checks.read(identity, input.attemptId)).physicalRequestEnded, true);
    const { rows: [unknown] } = await storage.read('SELECT * FROM model_learning_admissions WHERE attempt_id=$1', [input.attemptId]);
    assert.equal(unknown.physical_held, true); assert.equal(unknown.upstream_ended, false);
    assert.equal(unknown.settled_units, null); assert.equal(unknown.settlement, 'unknown');
    assert.equal(sends, 1);
    assert.ok(seen.filter(item => item.operation === 'checks.dispatch').length >= 2);
    assert.deepEqual(seen.find(item => item.operation === 'checks.receive').args[0].attemptId, input.attemptId);
    // A newly accepted operation revoked between acknowledgement and scheduled dispatch sends nothing.
    const nextSegment = randomUUID();
    await client.segments.create(identity, { requestId: randomUUID(), segmentId: nextSegment, purpose: 'learning', source: { connectionId, version: 1 }, prefix: { system: '', tools: [] }, portable: [] });
    const next = { ...input, segmentId: nextSegment, attemptId: randomUUID() };
    await client.checks.receive(identity, next);
    rejectDispatch = true;
    await assert.rejects(client.checks.dispatch(identity, next.attemptId), { code: 'forbidden' }); allowed = false;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(sends, 1);
    await assert.rejects(client.checks.read(identity, next.attemptId), { code: 'forbidden' });
    allowed = true; rejectDispatch = false;
    assert.equal((await client.checks.read(identity, next.attemptId)).state, 'accepted');
    finish = true;
    await client.checks.dispatch(identity, next.attemptId);
    let completed;
    for (let n = 0; n < 200; n++) {
      completed = await client.checks.read(identity, next.attemptId);
      if (completed.state === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(completed.state, 'completed');
    assert.equal(completed.text, '等待结果');
    const { rows: [retained] } = await storage.read('SELECT * FROM model_learning_admissions WHERE attempt_id=$1', [input.attemptId]);
    assert.equal(retained.physical_held, true); assert.equal(retained.settled_units, null);
    for (const malformed of [
      { ...completed, upstream: { httpStatus: '200' } },
      { ...completed, createdAt: 'not-a-date' },
      { ...completed, toolIntents: [{ callId: 'tool', name: 'read', arguments: [] }] },
      { ...completed, connection: { ...completed.connection, credentialRef: 'private' } },
    ]) {
      const untrusted = createLearningModelClient(async () => ({ ok: true, value: malformed }));
      await assert.rejects(untrusted.checks.read(identity, next.attemptId), { code: 'invalid' });
    }
    assert.equal(await client.checks.summary(identity, next.attemptId), null);
    await client.checks.progress(identity, next.attemptId);
    assert.equal((await client.segments.read(identity, nextSegment)).sequence, 1);
    assert.equal(await client.results.retain(identity, { requestId: randomUUID(), resultRef: completed.resultRef, consumer: 'run', consumerId: randomUUID() }), undefined);
    assert.equal((await client.segments.close(identity, nextSegment, { requestId: randomUUID(), expectedSequence: 1 })).closed, true);
    assert.equal((await client.selection.read(identity)).options.length, 1);
    const grantId = randomUUID();
    await gateway.selection.createGrant(identity, identity, { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
    await gateway.selection.save(identity, { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, grantId } });
    assert.equal((await client.selection.snapshot(identity, 1)).choice.connection.connectionId, connectionId);
    const imageId = randomUUID();
    const image = await client.images.upload(identity, { requestId: randomUUID(), imageId, mediaType: 'image/png',
      dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=' });
    assert.deepEqual(await client.images.read(identity, { imageId, version: 1 }), image);
    // Legacy diagnostic facts stay outside the trusted learning capability.
    const probeSegment = randomUUID();
    await gateway.segments.create(identity, { requestId: randomUUID(), segmentId: probeSegment, source: { connectionId, version: 1 }, prefix: { system: '', tools: [] }, portable: [] });
    const probe = { ...input, attemptId: randomUUID(), purpose: 'chat-probe', segmentId: probeSegment };
    const probeFact = await gateway.checks.receive(identity, probe);
    const actor = { ...identity, kind: 'school' }, pair = { grantId: randomUUID(), installationId: randomUUID() };
    const legacy = { taskId: randomUUID(), operation: 'read', attemptId: probe.attemptId };
    await gateway.deviceTasks.enqueue(actor, pair, legacy);
    await gateway.deviceTasks.complete(actor, pair, legacy.taskId, { ok: true, value: probeFact });
    assert.deepEqual((await gateway.deviceTasks.read(actor, pair, legacy.taskId)).receipt.value, probeFact);
    const learning = { taskId: randomUUID(), attemptId: probe.attemptId, operation: 'learning', formatVersion: 1,
      origin: { service: storage.owner, identity: actor, runId: randomUUID(), attemptId: probe.attemptId, recoveryGeneration: pair.installationId },
      request: { operation: 'checks.read', identity: actor, args: [probe.attemptId] } };
    await gateway.deviceTasks.enqueue(actor, pair, learning);
    await assert.rejects(gateway.deviceTasks.complete(actor, pair, learning.taskId, { ok: true, value: probeFact }), { code: 'conflict' });
    const errorReceipt = { ok: false, code: 'stale-generation' };
    assert.deepEqual(await gateway.deviceTasks.complete(actor, pair, learning.taskId, errorReceipt), errorReceipt);
    assert.deepEqual(await gateway.deviceTasks.complete(actor, pair, learning.taskId, errorReceipt), errorReceipt);
    await assert.rejects(gateway.deviceTasks.complete(actor, pair, learning.taskId, { ok: false, code: 'forbidden' }), { code: 'identity-conflict' });
    await gateway.deviceTasks.validate();
    await assert.rejects(client.checks.dispatch(identity, probe.attemptId), { code: 'missing' });
  } finally {
    gateway?.closeWrites(); await gateway?.checks.drain(); await storage?.close();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await fixture.close();
  }
});

test('selection.read accepts the trimmed empty tuple; clients reject malformed operation-specific network results', async () => {
  const selection = { version: 0, selected: null, options: [] };
  const seen = [];
  const client = createLearningModelClient(async request => { seen.push(request); return { ok: true, value: selection }; });
  assert.deepEqual(await client.selection.read(identity), selection);
  assert.deepEqual(seen[0].args, []);
  const service = createLearningModelService({ selection: { read: async () => selection } }, async () => {});
  assert.deepEqual(await service({ operation: 'selection.read', identity, args: [] }), { ok: true, value: selection });
  for (const [group, method, args, value] of [
    ['selection', 'read', [], { ...selection, options: [{}] }],
    ['selection', 'snapshot', [0], { choice: {}, source: {} }],
    ['segments', 'read', [randomUUID()], { segmentId: randomUUID(), pendingTools: [{ arguments: [] }] }],
    ['checks', 'read', [randomUUID()], { state: 'completed', upstream: { httpStatus: '200' } }],
    ['checks', 'requestPayload', [randomUUID()], { model: 'x', max_tokens: 10, stream_options: { include_usage: true }, messages: [{ role: 'assistant', content: 42 }], stream: true }],
    ['checks', 'progress', [randomUUID()], { text: 'x', revision: -1 }],
    ['checks', 'summary', [randomUUID()], { source: 'native', text: 'x', truncated: false }],
    ['images', 'read', [{ imageId: randomUUID(), version: 1 }], { imageId: randomUUID(), version: 1, sha256: 'broken' }],
    ['results', 'retain', [{ requestId: randomUUID(), resultRef: randomUUID(), consumer: 'run', consumerId: randomUUID() }], { credential: 'private' }],
  ]) {
    const remote = createLearningModelClient(async () => ({ ok: true, value }));
    await assert.rejects(remote[group][method](identity, ...args), { code: 'invalid' }, `${group}.${method}`);
  }
});

test('native replay metadata is checked without dropping valid Responses citations or Messages thinking', async () => {
  const citation = { type: 'url_citation', start_index: 0, end_index: 1, title: '来源', url: 'https://example.com' };
  const responses = { model: 'fixture', stream: true, store: false, max_output_tokens: 128, input: [
    { type: 'reasoning', id: 'r1', encrypted_content: 'opaque' },
    { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '参考', annotations: [citation] }] },
    { role: 'user', content: [{ type: 'input_text', text: '继续' }] },
  ] };
  const messages = { model: 'fixture', stream: true, max_tokens: 128, messages: [
    { role: 'assistant', content: [{ type: 'thinking', thinking: null, signature: null }, { type: 'text', text: '答复', citations: null }] },
    { role: 'user', content: '继续' },
  ] };
  for (const value of [responses, messages]) {
    const client = createLearningModelClient(async () => ({ ok: true, value }));
    assert.deepEqual(await client.checks.requestPayload(identity, randomUUID()), value);
  }
  for (const value of [
    { ...responses, input: [{ ...responses.input[1], content: [{ type: 'output_text', text: '参考', annotations: [{ ...citation, start_index: '0' }] }] }] },
    { ...messages, messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: [], signature: null }] }] },
  ]) {
    const client = createLearningModelClient(async () => ({ ok: true, value }));
    await assert.rejects(client.checks.requestPayload(identity, randomUUID()), { code: 'invalid' });
  }
});

test('network selection cannot nominate another owner; trusted local school/device selection still works', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture(); let storage;
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations: modelMigrations });
    storage = await openStorage({ binding, migrations: modelMigrations, backend: createFileBackend({ id: 'files', root: fixture.root + '/objects' }) });
    const a = { ...identity, environmentId: owner.environmentId, principalId: randomUUID(), kind: 'school' };
    const b = { ...a, principalId: randomUUID(), name: 'B' };
    const personal = { ...a, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal' };
    const gateway = await createModelGateway(storage, { holder: 'device', authorize: async () => {} });
    for (const actor of [b, personal]) await gateway.save(actor, { requestId: randomUUID(), connectionId: randomUUID(), expectedVersion: 0,
      name: actor.kind === 'personal' ? '本人设备' : 'B的私人连接', protocol: 'chat-completions', baseUrl: 'https://example.com', path: '/chat/completions',
      modelId: 'fixture', dialect: 'standard', parameterMode: 'plain', enabled: true, credential: { action: 'replace', value: 'synthetic-key' } });
    const service = createLearningModelService(gateway, async () => {});
    assert.deepEqual(await service({ operation: 'selection.read', identity: a, args: [b] }), { ok: false, code: 'forbidden' });
    assert.deepEqual(await service({ operation: 'selection.read', identity: a, args: [personal] }), { ok: false, code: 'forbidden' });
    assert.equal((await service({ operation: 'selection.read', identity: a, args: [] })).ok, true);
    assert.equal((await service({ operation: 'selection.read', identity: a, args: [a] })).ok, true);
    assert.equal((await gateway.selection.read(a, personal)).options[0].connection.name, '本人设备');
  } finally { await storage?.close(); await fixture.close(); }
});
