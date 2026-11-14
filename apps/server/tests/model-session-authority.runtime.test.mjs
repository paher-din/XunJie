import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { createModelGateway, modelMigrations } from '@xunjie/model-gateway';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';

const permit = sessionId => ({ sessionId, runId: randomUUID(), stepId: randomUUID(), operationId: randomUUID(), generation: 1 });
async function harness(run, protocol = 'chat-completions') {
  const fixture = await nativeFixture(); let storage, gateway, calls = 0;
  const upstream = createServer(async (request, response) => {
    for await (const _ of request) { /* installed SDK sends the retained native request */ }
    calls++; response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (protocol === 'responses') response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'response-session', object: 'response', status: 'completed',
      output: [{ id: 'message-session', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'session result', annotations: [] }] }],
      usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 } } }) + '\n\n');
    else if (protocol === 'messages') {
      for (const event of [
        { type: 'message_start', message: { id: 'message-session', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'session result' } },
        { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }, { type: 'message_stop' },
      ]) response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
      response.end();
    } else response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'session result' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations: modelMigrations });
    const backend = createFileBackend({ id: 'files', root: fixture.root + '/objects' });
    storage = await openStorage({ binding, migrations: modelMigrations, backend });
    const identity = { kind: 'personal', environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), name: 'Home' };
    let stopped = false; const checked = [];
    const options = { holder: 'device', authorize: async () => {}, authorizePermit: async (actor, value, context) => {
      assert.deepEqual(actor, identity); checked.push({ value, context });
      if (stopped) throw new StorageError('forbidden');
    } };
    gateway = await createModelGateway(storage, options);
    const connectionId = randomUUID();
    await gateway.save(identity, { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'Session model', protocol,
      baseUrl: `http://127.0.0.1:${upstream.address().port}/${protocol === 'messages' ? 'anthropic' : 'v1'}`, path: protocol === 'messages' ? '/v1/messages' : protocol === 'responses' ? '/responses' : '/chat/completions', modelId: 'fixture', dialect: 'standard', parameterMode: 'plain',
      enabled: true, credential: { action: 'replace', value: 'synthetic-session-key' } });
    const segment = sessionId => ({ requestId: randomUUID(), segmentId: randomUUID(), purpose: 'learning', sessionId,
      source: { connectionId, version: 1 }, prefix: { system: 'Home conversation', tools: [] }, portable: [] });
    const input = (segmentId, value) => ({ attemptId: randomUUID(), purpose: 'learning', segmentId, expectedSequence: 0,
      authority: { formatVersion: 1, permit: value }, input: { text: 'Hello', images: [], toolResults: [] }, limits: { maxOutputTokens: 32, timeoutMs: 5000 } });
    await run({ get gateway() { return gateway; }, identity, segment, input, checked, stop: () => { stopped = true; }, resume: () => { stopped = false; },
      calls: () => calls, owner, get storage() { return storage; }, options, reopen: async () => {
        gateway.closeWrites(); await gateway.checks.drain(); await storage.close();
        storage = await openStorage({ binding, migrations: modelMigrations, backend }); gateway = await createModelGateway(storage, options);
      } });
  } finally {
    gateway?.closeWrites(); await gateway?.checks.drain(); await storage?.close();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await fixture.close();
  }
}
async function finished(gateway, identity, attemptId) {
  for (let n = 0; n < 500; n++) {
    const fact = await gateway.checks.read(identity, attemptId);
    if (fact.state !== 'accepted' && fact.physicalRequestEnded) return fact;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('Session model attempt did not finish');
}

for (const protocol of ['chat-completions', 'responses', 'messages']) test(protocol + ': home session owns its native segment and retryable operation without an activity or worker lease', { timeout: 60000 }, async () => {
  await harness(async h => {
    const sessionId = randomUUID(), dispatchPermit = permit(sessionId), segment = h.segment(sessionId);
    assert.equal((await h.gateway.segments.create(h.identity, segment)).sessionId, sessionId);
    const input = h.input(segment.segmentId, dispatchPermit);
    const accepted = await h.gateway.checks.receive(h.identity, input);
    assert.deepEqual(accepted.authority, input.authority);
    assert.deepEqual(await h.gateway.checks.receive(h.identity, input), accepted);
    await assert.rejects(h.gateway.checks.receive(h.identity, { ...input, authority: { formatVersion: 1, permit: permit(randomUUID()) } }));
    await assert.rejects(h.gateway.checks.receive(h.identity, h.input(segment.segmentId, permit(randomUUID()))), { code: 'identity-conflict' });
    h.stop();
    await assert.rejects(h.gateway.checks.dispatch(h.identity, input.attemptId), { code: 'forbidden' });
    assert.equal(h.calls(), 0);
    h.resume(); await h.reopen();
    assert.deepEqual(await h.gateway.checks.receive(h.identity, input), accepted);
    await h.gateway.checks.dispatch(h.identity, input.attemptId);
    const result = await finished(h.gateway, h.identity, input.attemptId);
    assert.equal(result.state, 'completed'); assert.equal(result.text, 'session result');
    await h.gateway.checks.dispatch(h.identity, input.attemptId);
    assert.equal(h.calls(), 1);
    assert.ok(h.checked.some(check => check.context.phase === 'dispatch' && check.value.operationId === dispatchPermit.operationId));
    assert.equal((await h.gateway.readCredential(h.identity, segment.source.connectionId, 1)).value, 'synthetic-session-key');
    await h.gateway.validate();
  }, protocol);
});

test('a model effect operation cannot be reassigned to another session or attempt after owner reopen', { timeout: 60000 }, async () => {
  await harness(async h => {
    const firstSession = randomUUID(), otherSession = randomUUID(), dispatchPermit = permit(firstSession);
    const segment = h.segment(firstSession); await h.gateway.segments.create(h.identity, segment);
    const first = h.input(segment.segmentId, dispatchPermit); await h.gateway.checks.receive(h.identity, first);
    await h.reopen();
    for (const sessionId of [firstSession, otherSession]) {
      const another = h.segment(sessionId); await h.gateway.segments.create(h.identity, another);
      await assert.rejects(h.gateway.checks.receive(h.identity, h.input(another.segmentId, { ...dispatchPermit, sessionId })), { code: 'identity-conflict' });
    }
    assert.equal(h.calls(), 0);
  });
});

test('session origin pins its session/effect and recovery evidence grants only original-result access', { timeout: 60000 }, async () => {
  await harness(async h => {
    const sessionId = randomUUID(), dispatchPermit = permit(sessionId), attemptId = randomUUID();
    const origin = { formatVersion: 3, sessionId, attemptId, authority: dispatchPermit, service: h.owner,
      installationId: randomUUID(), grantId: randomUUID(), identity: h.identity, recoveryGeneration: randomUUID() };
    await h.gateway.origins.bind(h.identity, attemptId, origin);
    assert.equal((await h.gateway.origins.read(h.identity, attemptId)).sessionId, sessionId);
    await h.gateway.origins.bind(h.identity, attemptId, { ...origin, authority: { ...dispatchPermit, generation: 2 } });
    await assert.rejects(h.gateway.origins.bind(h.identity, attemptId, { ...origin, sessionId: randomUUID() }), { code: 'identity-conflict' });
    await assert.rejects(h.gateway.origins.bind(h.identity, attemptId, { ...origin, authority: { ...dispatchPermit, operationId: randomUUID() } }), { code: 'identity-conflict' });
    const successor = { ...origin, installationId: randomUUID(), grantId: randomUUID() };
    await h.gateway.origins.bind(h.identity, attemptId, successor, { operation: 'checks.read', successions: [{ formatVersion: 1, backupId: randomUUID(),
      sourceEnvironmentId: origin.service.environmentId, sourceServiceId: origin.service.serviceId,
      sourceInstallationId: origin.installationId, targetInstallationId: successor.installationId }] });
    h.stop();
    await h.gateway.origins.assert(h.identity, attemptId, successor, 'checks.read');
    await h.gateway.origins.assert(h.identity, attemptId, successor, 'checks.cancel');
    await assert.rejects(h.gateway.origins.assert(h.identity, attemptId, successor, 'checks.dispatch'), { code: 'identity-conflict' });
    await h.reopen();
    await h.gateway.origins.assert(h.identity, attemptId, successor, 'checks.read');
    assert.equal((await h.gateway.origins.read(h.identity, attemptId)).installationId, origin.installationId);
    await h.gateway.validate();
  });
});

import { createPairedLearningModels } from '@xunjie/model-gateway/paired-learning';

test('V3 paired tasks retain the session permit, isolate route access and recheck the original host authority', { timeout: 60000 }, async () => {
  await harness(async h => {
    h.identity.kind = 'school';
    let stopped = false;
    const paired = createPairedLearningModels(h.storage, h.gateway, {
      authorize: async () => {}, authorizeBinding: async () => {}, assertWritable() {}, timeoutMs: 20, pollIntervalMs: 2,
      authorizeOrigin: async (_actor, source, request) => {
        assert.equal(source.formatVersion, 3);
        assert.equal(source.authority?.sessionId ?? source.sessionId, source.sessionId);
        if (stopped && ['checks.receive', 'checks.dispatch'].includes(request.operation)) throw new StorageError('forbidden');
      },
    });
    const sessionId = randomUUID(), dispatchPermit = permit(sessionId);
    const origin = { formatVersion: 3, sessionId, operationId: randomUUID(), authority: dispatchPermit,
      service: h.owner, installationId: randomUUID(), grantId: randomUUID() };
    const segment = h.segment(sessionId);
    const create = { operation: 'segments.create', identity: h.identity, args: [segment] };
    const created = await paired.request(create, origin);
    assert.equal(created.ok, true); assert.equal(created.value.sessionId, sessionId);
    assert.deepEqual(await paired.request(create, origin), created);
    await assert.rejects(paired.request({ operation: 'segments.read', identity: h.identity, args: [segment.segmentId] },
      { ...origin, sessionId: randomUUID(), authority: undefined, operationId: randomUUID() }), { code: 'identity-conflict' });
    const request = { operation: 'checks.receive', identity: h.identity, args: [h.input(segment.segmentId, dispatchPermit)] };
    const receiveOrigin = { ...origin, operationId: randomUUID() };
    const accepted = await paired.request(request, receiveOrigin); assert.equal(accepted.ok, true);
    stopped = true;
    await assert.rejects(paired.request({ operation: 'checks.dispatch', identity: h.identity, args: [accepted.value.attemptId] },
      { ...origin, operationId: randomUUID() }), { code: 'forbidden' });
    assert.equal(h.calls(), 0);
    const device = { owner: { environmentId: randomUUID(), serviceId: randomUUID() }, installationId: randomUUID(), grantId: randomUUID(), connectionId: randomUUID() };
    await paired.bind(h.identity, { requestId: randomUUID(), expectedVersion: 0, ...device });
    const pollOrigin = { ...origin, operationId: randomUUID() };
    const pollRequest = { operation: 'selection.read', identity: h.identity, args: [] };
    await assert.rejects(paired.request(pollRequest, pollOrigin), { code: 'unavailable' });
    const taskBinding = { grantId: device.grantId, installationId: device.installationId };
    const tasks = await h.gateway.deviceTasks.pending(h.identity, taskBinding);
    assert.equal(tasks.length, 1); assert.equal(tasks[0].formatVersion, 3);
    assert.equal(tasks[0].origin.sessionId, sessionId); assert.deepEqual(tasks[0].origin.authority, dispatchPermit);
    assert.deepEqual(await paired.authorizeTask(h.identity, taskBinding, tasks[0].taskId), { authorized: true });
    await assert.rejects(h.gateway.deviceTasks.enqueue(h.identity, taskBinding, { ...tasks[0],
      origin: { ...tasks[0].origin, sessionId: randomUUID() } }));
    await assert.rejects(paired.request(pollRequest, { ...pollOrigin, sessionId: randomUUID(), authority: undefined }), { code: 'identity-conflict' });
    await paired.validate(); await h.gateway.validate();
  });
});

test('session learning refuses a missing permit verifier and rechecks host stop at the actual SDK fetch', { timeout: 60000 }, async () => {
  await harness(async h => {
    const sessionId = randomUUID(), segment = h.segment(sessionId); await h.gateway.segments.create(h.identity, segment);
    const input = h.input(segment.segmentId, permit(sessionId));
    const verify = h.options.authorizePermit; h.options.authorizePermit = undefined;
    await assert.rejects(h.gateway.checks.receive(h.identity, input), { code: 'forbidden' });
    h.options.authorizePermit = verify;
    await h.gateway.checks.receive(h.identity, input);
    // This existing host callback runs after durable acceptance/claim, immediately before SDK setup.
    h.options.authorizeDispatch = async () => h.stop();
    await h.gateway.checks.dispatch(h.identity, input.attemptId);
    const result = await finished(h.gateway, h.identity, input.attemptId);
    assert.notEqual(result.state, 'completed'); assert.equal(result.dispatched, false); assert.equal(h.calls(), 0);
    assert.ok(h.checked.filter(check => check.context.phase === 'dispatch').length >= 2);
    assert.equal((await h.gateway.checks.read(h.identity, input.attemptId)).attemptId, input.attemptId);
  });
});

test('additive session migrations preserve an existing owner and its encrypted model credentials', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture(); let storage, gateway;
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() }, password = randomUUID();
    const legacy = modelMigrations.filter(item => item.version <= 22);
    const binding = await provisionStorage({ admin: fixture.admin, owner, password, migrations: legacy });
    const backend = createFileBackend({ id: 'files', root: fixture.root + '/objects' });
    storage = await openStorage({ binding, migrations: legacy, backend });
    const identity = { kind: 'personal', environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID() };
    gateway = await createModelGateway(storage, { holder: 'device', authorize: async () => {} });
    const connectionId = randomUUID();
    const saved = await gateway.save(identity, { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'Existing owner', protocol: 'chat-completions',
      baseUrl: 'http://127.0.0.1:12345/v1', path: '/chat/completions', modelId: 'fixture', dialect: 'standard', parameterMode: 'plain', enabled: true,
      credential: { action: 'replace', value: 'synthetic-existing-secret' } });
    gateway.closeWrites(); await gateway.checks.drain(); await storage.participant().closeWrites(); await storage.participant().closeDispatch();
    await storage.close(); storage = undefined;
    const upgraded = await provisionStorage({ admin: fixture.admin, owner, password, migrations: modelMigrations });
    assert.equal(upgraded.schema, binding.schema);
    storage = await openStorage({ binding: upgraded, migrations: modelMigrations, backend });
    await storage.participant().resume();
    gateway = await createModelGateway(storage, { holder: 'device', authorize: async () => {} });
    assert.deepEqual(await gateway.list(identity), [saved]);
    assert.deepEqual(await gateway.readCredential(identity, connectionId, 1), { connectionId, version: 1, value: 'synthetic-existing-secret' });
    await gateway.validate();
  } finally { gateway?.closeWrites(); if (storage) { await gateway?.checks.drain(); await storage.close(); } await fixture.close(); }
});

for (const refresh of ['receive', 'dispatch']) test(`restart renews only the original attempt permit via ${refresh} and never repeats its physical request`, { timeout: 60000 }, async () => {
  await harness(async h => {
    let generation = 1;
    const verify = h.options.authorizePermit;
    h.options.authorizePermit = async (identity, current, context) => {
      if (current.generation !== generation) throw new StorageError('stale-generation');
      return verify(identity, current, context);
    };
    const sessionId = randomUUID(), segment = h.segment(sessionId), originalPermit = permit(sessionId);
    await h.gateway.segments.create(h.identity, segment);
    const input = h.input(segment.segmentId, originalPermit);
    const accepted = await h.gateway.checks.receive(h.identity, input);
    const payload = await h.gateway.checks.requestPayload(h.identity, input.attemptId);
    await h.reopen(); generation = 2;
    const authority = { formatVersion: 1, permit: { ...originalPermit, generation } };
    if (refresh === 'receive') {
      const renewed = await h.gateway.checks.receive(h.identity, { ...input, authority });
      assert.equal(renewed.authority.permit.generation, generation);
      assert.equal(renewed.requestRef, accepted.requestRef);
      await assert.rejects(h.gateway.checks.receive(h.identity, { ...input, authority, input: { ...input.input, text: 'Changed payload' } }), { code: 'identity-conflict' });
      await h.gateway.checks.dispatch(h.identity, input.attemptId);
    } else await h.gateway.checks.dispatch(h.identity, input.attemptId, authority);
    const result = await finished(h.gateway, h.identity, input.attemptId);
    assert.equal(result.state, 'completed'); assert.equal(result.authority.permit.generation, 2);
    assert.equal(result.requestRef, accepted.requestRef); assert.equal(h.calls(), 1);
    assert.deepEqual(await h.gateway.checks.requestPayload(h.identity, input.attemptId), payload);
    await h.reopen(); generation = 3;
    assert.deepEqual(await h.gateway.checks.read(h.identity, input.attemptId), result);
    // Restoring the same fixed result does not require its former generation to remain active.
    assert.deepEqual(await h.gateway.checks.receive(h.identity, input), result);
    assert.deepEqual(await h.gateway.checks.receive(h.identity, { ...input, authority: { formatVersion: 1, permit: { ...originalPermit, generation } } }), result);
    await h.gateway.checks.dispatch(h.identity, input.attemptId);
    assert.equal(h.calls(), 1); assert.equal((await h.gateway.segments.read(h.identity, segment.segmentId)).sequence, 1);
    await assert.rejects(h.gateway.checks.dispatch(h.identity, input.attemptId, { ...authority, permit: { ...authority.permit, sessionId: randomUUID() } }), { code: 'identity-conflict' });
    await h.gateway.validate();
  });
});

test('the paired request keeps its wire operation and payload when its host issues a later generation', { timeout: 60000 }, async () => {
  await harness(async h => {
    h.identity.kind = 'school'; let generation = 1;
    const verify = h.options.authorizePermit;
    h.options.authorizePermit = async (identity, current, context) => {
      if (current.generation !== generation) throw new StorageError('stale-generation');
      return verify(identity, current, context);
    };
    const options = { authorize: async () => {}, authorizeBinding: async () => {}, assertWritable() {},
      authorizeOrigin: async (_identity, origin) => { if (origin.authority && origin.authority.generation !== generation) throw new StorageError('stale-generation'); } };
    let paired = createPairedLearningModels(h.storage, h.gateway, options);
    const sessionId = randomUUID(), current = permit(sessionId), segment = h.segment(sessionId);
    const source = { formatVersion: 3, sessionId, operationId: randomUUID(), authority: current, service: h.owner, installationId: randomUUID(), grantId: randomUUID() };
    assert.equal((await paired.request({ operation: 'segments.create', identity: h.identity, args: [segment] }, source)).ok, true);
    const input = h.input(segment.segmentId, current), origin = { ...source, operationId: randomUUID() };
    const request = { operation: 'checks.receive', identity: h.identity, args: [input] };
    assert.equal((await paired.request(request, origin)).ok, true);
    await h.reopen(); generation = 2; paired = createPairedLearningModels(h.storage, h.gateway, options);
    const authority = { formatVersion: 1, permit: { ...current, generation } };
    const renewedRequest = { ...request, args: [{ ...input, authority }] }, renewedOrigin = { ...origin, authority: authority.permit };
    const reply = await paired.request(renewedRequest, renewedOrigin);
    assert.equal(reply.ok, true); assert.equal(reply.value.authority.permit.generation, generation);
    await assert.rejects(paired.request({ ...renewedRequest, args: [{ ...input, authority, input: { ...input.input, text: 'Replacement' } }] }, renewedOrigin), { code: 'identity-conflict' });
    const dispatch = { operation: 'checks.dispatch', identity: h.identity, args: [input.attemptId] }, dispatchOrigin = { ...renewedOrigin, operationId: randomUUID() };
    assert.equal((await paired.request(dispatch, dispatchOrigin)).ok, true);
    await finished(h.gateway, h.identity, input.attemptId); assert.equal(h.calls(), 1);
    await h.reopen(); generation = 3; paired = createPairedLearningModels(h.storage, h.gateway, options);
    assert.equal((await paired.request(dispatch, { ...dispatchOrigin, authority: { ...current, generation } })).value.state, 'completed');
    assert.equal(h.calls(), 1);
    await paired.validate(); await h.gateway.validate();
  });
});

import { createLearningModelService } from '@xunjie/model-gateway/service';

test('a V3 model task renews a completed receipt for the same effect without replaying the SDK after restart', { timeout: 60000 }, async () => {
  await harness(async h => {
    h.identity.kind = 'school'; let generation = 1;
    const verify = h.options.authorizePermit;
    h.options.authorizePermit = async (identity, current, context) => {
      if (current.generation !== generation) throw new StorageError('stale-generation');
      return verify(identity, current, context);
    };
    const sessionId = randomUUID(), segment = h.segment(sessionId), originalPermit = permit(sessionId);
    await h.gateway.segments.create(h.identity, segment);
    const input = h.input(segment.segmentId, originalPermit), binding = { grantId: randomUUID(), installationId: randomUUID() };
    const task = { taskId: randomUUID(), attemptId: input.attemptId, operation: 'learning', formatVersion: 3,
      origin: { service: h.owner, installationId: randomUUID(), grantId: randomUUID(), identity: h.identity,
        recoveryGeneration: binding.installationId, sessionId, authority: originalPermit },
      request: { operation: 'checks.receive', identity: h.identity, args: [input] } };
    await h.gateway.deviceTasks.enqueue(h.identity, binding, task);
    const original = await createLearningModelService(h.gateway, async () => {})(task.request);
    assert.equal(original.ok, true);
    await h.gateway.deviceTasks.complete(h.identity, binding, task.taskId, original);
    await h.reopen(); generation = 2;
    const renewed = { ...task, origin: { ...task.origin, authority: { ...originalPermit, generation } },
      request: { ...task.request, args: [{ ...input, authority: { formatVersion: 1, permit: { ...originalPermit, generation } } }] } };
    await h.gateway.deviceTasks.enqueue(h.identity, binding, renewed);
    assert.equal((await h.gateway.deviceTasks.pending(h.identity, binding))[0].origin.authority.generation, 2);
    await assert.rejects(h.gateway.deviceTasks.complete(h.identity, binding, task.taskId, original), { code: 'stale-generation' });
    const accepted = await createLearningModelService(h.gateway, async () => {})(renewed.request);
    assert.equal(accepted.ok, true); assert.equal(accepted.value.authority.permit.generation, 2);
    await h.gateway.deviceTasks.complete(h.identity, binding, task.taskId, accepted);
    const stored = await h.gateway.deviceTasks.read(h.identity, binding, task.taskId);
    assert.equal(stored.receipt.value.requestRef, original.value.requestRef);
    const dispatched = await createLearningModelService(h.gateway, async () => {})({ operation: 'checks.dispatch', identity: h.identity,
      args: [input.attemptId, { formatVersion: 1, permit: { ...originalPermit, generation } }] });
    assert.equal(dispatched.ok, true);
    const result = await finished(h.gateway, h.identity, input.attemptId); assert.equal(result.state, 'completed'); assert.equal(h.calls(), 1);
    await h.reopen(); generation = 3;
    const recovery = { ...task, origin: { ...task.origin, authority: { ...originalPermit, generation } },
      request: { ...task.request, args: [{ ...input, authority: { formatVersion: 1, permit: { ...originalPermit, generation } } }] } };
    await h.gateway.deviceTasks.enqueue(h.identity, binding, recovery);
    const restored = await createLearningModelService(h.gateway, async () => {})(recovery.request);
    assert.equal(restored.ok, true); assert.equal(restored.value.resultRef, result.resultRef);
    await h.gateway.deviceTasks.complete(h.identity, binding, task.taskId, restored);
    await h.gateway.checks.dispatch(h.identity, input.attemptId);
    assert.equal(h.calls(), 1);
    await assert.rejects(h.gateway.deviceTasks.enqueue(h.identity, binding, { ...recovery, request: { ...recovery.request,
      args: [{ ...recovery.request.args[0], input: { ...input.input, text: 'Different payload' } }] } }));
    await h.gateway.validate();
  });
});


test('model task admission rejects retired Agent protocols before creating any origin or queued work', { timeout: 60000 }, async () => {
  await harness(async h => {
    h.identity.kind = 'school';
    const binding = { grantId: randomUUID(), installationId: randomUUID() };
    const attemptId = randomUUID(), activityId = randomUUID();
    const origin = { service: h.owner, installationId: randomUUID(), grantId: randomUUID(), identity: h.identity,
      recoveryGeneration: binding.installationId, activityId };
    const authority = { driverId: 'retired-driver', runId: randomUUID(), activityId, generation: 1 };
    const request = { operation: 'checks.dispatch', identity: h.identity, args: [attemptId] };
    await assert.rejects(h.gateway.deviceTasks.enqueue(h.identity, binding, { taskId: randomUUID(), attemptId,
      operation: 'learning', formatVersion: 2, origin: { ...origin, authority }, request }));
    assert.deepEqual(await h.gateway.deviceTasks.pending(h.identity, binding), []);
    for (const formatVersion of [1, 2]) {
      const { activityId: _activity, ...source } = origin;
      await assert.rejects(h.gateway.deviceTasks.enqueue(h.identity, binding, { taskId: randomUUID(), attemptId,
        operation: 'learning', formatVersion, origin: formatVersion === 1 ? { service: h.owner, identity: h.identity,
          recoveryGeneration: binding.installationId, runId: authority.runId, attemptId } : { ...source, authority }, request }));
      await assert.rejects(h.gateway.origins.bind(h.identity, attemptId, { ...origin, formatVersion, attemptId }));
    }
    await assert.rejects(h.gateway.origins.read(h.identity, attemptId), { code: 'missing' });
    assert.equal(h.calls(), 0);
  });
});
