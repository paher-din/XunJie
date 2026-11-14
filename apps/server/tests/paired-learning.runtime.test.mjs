import './model-cleanup-source-loader.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { createModelGateway, modelMigrations } from '../../../packages/model-gateway/dist/index.js';
import { createPairedLearningModels } from '../../../packages/model-gateway/dist/paired-learning.js';

test('model-device binding is independent, verified against the actual poll source, and preparation enqueues without invented run IDs', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture(); let storage;
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations: modelMigrations });
    storage = await openStorage({ binding, migrations: modelMigrations, backend: createFileBackend({ id: 'files', root: fixture.root + '/objects' }) });
    let models = await createModelGateway(storage, { authorizePermit: async () => {}, authorize: async () => {} });
    const identity = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '成员' };
    const device = { owner: { environmentId: randomUUID(), serviceId: randomUUID() }, installationId: randomUUID(), grantId: randomUUID(), connectionId: randomUUID() };
    let agentGrantActive = true; const authorizations = [];
    const options = { authorize: async () => {}, authorizeBinding: async () => {}, authorizeOrigin: async (_identity, source) => { authorizations.push(source); if (!agentGrantActive) throw new StorageError('forbidden'); }, assertWritable() {}, timeoutMs: 40, pollIntervalMs: 5 };
    let paired = createPairedLearningModels(storage, models, options);
    assert.equal(await paired.readBinding(identity), null);
    const saved = await paired.bind(identity, { requestId: randomUUID(), expectedVersion: 0, ...device });
    assert.equal(saved.version, 1);
    const source = { sourceEnvironmentId: device.owner.environmentId, sourceServiceId: device.owner.serviceId, sourceInstallationId: device.installationId, grantId: device.grantId, connectionId: device.connectionId };
    assert.deepEqual(await paired.authorizePoll(identity, source), { grantId: device.grantId, installationId: device.installationId });
    await assert.rejects(paired.authorizePoll(identity, { ...source, sourceServiceId: randomUUID() }), { code: 'forbidden' });
    const origin = { operationId: randomUUID(), service: { environmentId: randomUUID(), serviceId: randomUUID() }, installationId: randomUUID(), grantId: randomUUID() };
    const request = { operation: 'selection.read', identity, args: [] };
    await assert.rejects(paired.request(request, origin), { code: 'unavailable' });
    const originalAgentGrant = origin.grantId;
    agentGrantActive = false;
    await assert.rejects(paired.authorizeTask(identity, { grantId: device.grantId, installationId: device.installationId }, origin.operationId), { code: 'forbidden' });
    assert.equal(authorizations.at(-1).grantId, originalAgentGrant);
    assert.equal(authorizations.at(-1).sessionId, undefined);
    agentGrantActive = true;
    assert.deepEqual(await paired.authorizeTask(identity, { grantId: device.grantId, installationId: device.installationId }, origin.operationId), { authorized: true });
    await assert.rejects(paired.authorizeTask(identity, { grantId: randomUUID(), installationId: device.installationId }, origin.operationId), { code: 'forbidden' });
    await assert.rejects(paired.request({ operation: 'checks.dispatch', identity, args: [randomUUID()] }, { ...origin, operationId: randomUUID() }), { code: 'incompatible' });
    await storage.close();
    storage = await openStorage({ binding, migrations: modelMigrations, backend: createFileBackend({ id: 'files', root: fixture.root + '/objects' }) });
    models = await createModelGateway(storage, { authorizePermit: async () => {}, authorize: async () => {} });
    paired = createPairedLearningModels(storage, models, options);
    const replacement = { owner: { environmentId: randomUUID(), serviceId: randomUUID() }, installationId: randomUUID(), grantId: randomUUID(), connectionId: randomUUID() };
    await paired.bind(identity, { requestId: randomUUID(), expectedVersion: 1, ...replacement });
    const tasks = await models.deviceTasks.pending(identity, { grantId: device.grantId, installationId: device.installationId });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].taskId, origin.operationId);
    assert.equal(tasks[0].formatVersion, 2);
    assert.equal(tasks[0].attemptId, undefined);
    assert.equal(tasks[0].origin.authority, undefined);
    assert.equal(tasks[0].origin.installationId, origin.installationId);
    assert.equal(tasks[0].origin.sessionId, undefined);
    await models.deviceTasks.complete(identity, { grantId: device.grantId, installationId: device.installationId }, origin.operationId, { ok: true, value: { version: 0, selected: null, options: [] } });
    assert.equal((await paired.request(request, origin)).ok, true);
    assert.deepEqual(await paired.authorizeTask(identity, { grantId: device.grantId, installationId: device.installationId }, origin.operationId), { authorized: true });
    await assert.rejects(paired.request({ ...request, operation: 'selection.snapshot', args: [0] }, origin), { code: 'incompatible' });
    await assert.rejects(paired.request({ ...request, identity: { ...identity, principalId: randomUUID() } }, origin), { code: 'identity-conflict' });
    await assert.rejects(paired.request(request, { ...origin, operationId: randomUUID(),
      authority: { driverId: 'driver', runId: randomUUID(), activityId: randomUUID(), generation: 1 } }));
    await paired.validate(); await models.validate();
  } finally { await storage?.close(); await fixture.close(); }
});

import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createLearningModelClient, createLearningModelService } from '../../../packages/model-gateway/dist/service.js';

test('Agent API queues to the independently bound personal model; selection changes and replacement devices cannot redirect original segments or results', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture(); let hubStorage; let deviceStorage; let hub; let device; let running = true; let worker; let workerError; let paired; let binding; let resume;
  const sent = [];
  const upstream = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    sent.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '真实SDK结果' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    async function open(name) {
      const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
      const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations: modelMigrations });
      return openStorage({ binding, migrations: modelMigrations, backend: createFileBackend({ id: 'files', root: fixture.root + '/' + name }) });
    }
    hubStorage = await open('hub'); deviceStorage = await open('device');
    hub = await createModelGateway(hubStorage, { authorizePermit: async () => {}, holder: 'school', authorize: async () => {} });
    const identity = { environmentId: hubStorage.owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '成员' };
    const personal = { ...identity, kind: 'personal', environmentId: deviceStorage.owner.environmentId, spaceId: randomUUID() };
    const taskContext = new AsyncLocalStorage();
    const agent = { formatVersion: 3, sessionId: randomUUID(), service: { environmentId: randomUUID(), serviceId: randomUUID() }, installationId: randomUUID(), grantId: randomUUID() };
    const authority = { sessionId: agent.sessionId, runId: randomUUID(), stepId: randomUUID(), operationId: randomUUID(), generation: 1 };
    let permits = true; let agentGrantActive = true; let paused = false; let queued;
    const authorizeOrigin = async (actor, origin, request) => {
      assert.equal(actor.principalId, identity.principalId);
      if (!agentGrantActive) throw new StorageError('forbidden');
      assert.deepEqual(origin.service, agent.service); assert.equal(origin.installationId, agent.installationId); assert.equal(origin.grantId, agent.grantId);
      if (request.operation === 'checks.receive' || request.operation === 'checks.dispatch') {
        assert.ok(permits);
        assert.equal(origin.authority.runId, authority.runId); assert.equal(origin.authority.sessionId, authority.sessionId);
        if (origin.authority.generation !== authority.generation) throw new StorageError('stale-generation');
      }
    };
    device = await createModelGateway(deviceStorage, { authorizePermit: async () => {}, holder: 'device', authorize: async () => {
      const task = taskContext.getStore();
      if (task) await paired.authorizeTask(task.request.identity, { grantId: binding.grantId, installationId: binding.installationId }, task.taskId);
    }, schoolDefault: async () => (await hub.selection.schoolSnapshot(identity)).choice });
    const base = { expectedVersion: 0, name: '独立模型', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions',
      dialect: 'standard', parameterMode: 'plain', enabled: true, credential: { action: 'replace', value: 'private-fixture-key' } };
    const schoolId = randomUUID(), personalId = randomUUID(), grantId = randomUUID();
    await hub.school.save(identity.spaceId, { ...base, requestId: randomUUID(), connectionId: schoolId, modelId: 'school-fixture',
      policy: { checksAllowed: true, maxChecksPerHour: 6, maxOutputTokens: 2048, timeoutMs: 30000 } });
    await device.save(personal, { ...base, requestId: randomUUID(), connectionId: personalId, modelId: 'personal-fixture' });
    await device.selection.createGrant(identity, personal, { requestId: randomUUID(), grantId, connectionId: personalId, owner: 'device' });
    await device.selection.save(identity, { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId: personalId, grantId } });
    paired = createPairedLearningModels(hubStorage, hub, { authorize: async () => {}, authorizeBinding: async () => {}, authorizeOrigin, assertWritable() {}, timeoutMs: 5000, pollIntervalMs: 5 });
    binding = { owner: deviceStorage.owner, installationId: randomUUID(), grantId: randomUUID(), connectionId: randomUUID() };
    await paired.bind(identity, { requestId: randomUUID(), expectedVersion: 0, ...binding });
    const pollSource = { sourceEnvironmentId: binding.owner.environmentId, sourceServiceId: binding.owner.serviceId, sourceInstallationId: binding.installationId, grantId: binding.grantId, connectionId: binding.connectionId };
    worker = (async () => {
      while (running) {
        const pair = await paired.authorizePoll(identity, pollSource);
        for (const task of await hub.deviceTasks.pending(identity, pair)) {
          assert.equal(task.formatVersion, 3);
          if (paused) { queued(); await new Promise(resolve => { resume = resolve; }); }
          const service = createLearningModelService(device, async actor => { await paired.authorizeTask(actor, pair, task.taskId); });
          const reply = await taskContext.run(task, () => service(task.request));
          await hub.deviceTasks.complete(identity, pair, task.taskId, reply);
        }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    })().catch(error => { workerError = error; running = false; });
    let segmentContext;
    const client = createLearningModelClient(request => { request = sessionRequest(request, authority); return paired.request(request, { ...agent, operationId: randomUUID(),
      ...(request.operation === 'checks.receive' || request.operation === 'checks.dispatch' ? { authority: { ...authority } } : {}), ...(segmentContext ? { segmentId: segmentContext } : {}) }); });
    // A binding advertises an owner; it cannot replace Root's explicit school choice.
    await hub.selection.save(identity, { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'school', connectionId: schoolId } });
    const rootChoice = await client.selection.read(identity);
    assert.equal(rootChoice.version, 1);
    assert.equal(rootChoice.selected.connection.connectionId, schoolId);
    assert.ok(rootChoice.options.some(choice => choice.connection.connectionId === personalId));
    await hub.selection.save(identity, { requestId: randomUUID(), expectedVersion: 1, source: { kind: 'personal', connectionId: personalId, grantId } });
    assert.equal((await client.selection.snapshot(identity, 2)).choice.kind, 'personal');
    const segmentId = randomUUID(), attemptId = randomUUID(); segmentContext = segmentId;
    await client.segments.create(identity, { requestId: randomUUID(), segmentId, sessionId: authority.sessionId, purpose: 'learning', source: { selected: true, selectionVersion: 2 }, prefix: { system: '原请求', tools: [] }, portable: [] });
    const accepted = await client.checks.receive(identity, { attemptId, segmentId, purpose: 'learning', expectedSequence: 0,
      input: { text: '解释原输入', images: [], toolResults: [] }, limits: { maxOutputTokens: 256, timeoutMs: 30000 } });
    assert.equal(accepted.state, 'accepted'); assert.equal(sent.length, 0);
    const oldLease = structuredClone(authority), oldDispatchId = randomUUID();
    paused = true;
    const oldTaskQueued = new Promise(resolve => { queued = resolve; });
    const oldDispatch = paired.request({ operation: 'checks.dispatch', identity, args: [attemptId] },
      { ...agent, operationId: oldDispatchId, authority: oldLease, segmentId });
    await oldTaskQueued;
    Object.assign(authority, { generation: authority.generation + 1 });
    paused = false; resume();
    assert.deepEqual(await oldDispatch, { ok: false, code: 'stale-generation' });
    const originalTask = await hub.deviceTasks.read(identity, { grantId: binding.grantId, installationId: binding.installationId }, oldDispatchId);
    assert.deepEqual(originalTask.task.origin.authority, oldLease, 'each task retains its complete original lease');
    await assert.rejects(hub.deviceTasks.enqueue(identity, { grantId: binding.grantId, installationId: binding.installationId },
      { ...originalTask.task, origin: { ...originalTask.task.origin, authority: { ...authority, stepId: randomUUID() } } }));
    await assert.rejects(paired.request({ operation: 'checks.dispatch', identity, args: [attemptId] },
      { ...agent, operationId: oldDispatchId, authority: { ...authority, stepId: randomUUID() }, segmentId }), { code: 'identity-conflict' });
    await assert.rejects(paired.authorizeTask(identity, { grantId: binding.grantId, installationId: binding.installationId }, oldDispatchId), { code: 'stale-generation' });
    const stillAccepted = await client.checks.read(identity, attemptId);
    assert.equal(stillAccepted.attemptId, attemptId); assert.equal(stillAccepted.state, 'accepted'); assert.equal(sent.length, 0);
    const claimed = await client.checks.dispatch(identity, attemptId);
    assert.equal(claimed.attemptId, accepted.attemptId); assert.equal(claimed.connection.connectionId, personalId);
    let completed;
    for (let n = 0; n < 50; n++) {
      completed = await client.checks.read(identity, attemptId);
      if (completed.state === 'completed') break;
    }
    assert.equal(completed.state, 'completed'); assert.equal(completed.text, '真实SDK结果'); assert.equal(sent.length, 1);
    assert.equal(sent[0].model, 'personal-fixture');
    await assert.rejects(paired.authorizeTask(identity, { grantId: binding.grantId, installationId: binding.installationId }, oldDispatchId), { code: 'stale-generation' });
    assert.equal(sent.length, 1);
    // Revoke the original Agent grant after durable enqueue, before the device accepts it.
    paused = true;
    const taskQueued = new Promise(resolve => { queued = resolve; });
    const refusedId = randomUUID();
    const refused = client.checks.receive(identity, { attemptId: refusedId, segmentId, purpose: 'learning', expectedSequence: 1,
      input: { text: '撤权后不应调用', images: [], toolResults: [] }, limits: { maxOutputTokens: 256, timeoutMs: 30000 } });
    const refusedCheck = assert.rejects(refused, { code: 'forbidden' });
    await taskQueued; agentGrantActive = false; paused = false; resume();
    await refusedCheck;
    assert.equal(sent.length, 1);
    await assert.rejects(device.checks.read(identity, refusedId), { code: 'missing' });
    agentGrantActive = true;
    // Only Root's explicit choice changes the next segment's owner.
    await hub.selection.save(identity, { requestId: randomUUID(), expectedVersion: 2, source: { kind: 'school', connectionId: schoolId } });
    const schoolSegment = randomUUID(); segmentContext = schoolSegment;
    assert.equal((await client.selection.snapshot(identity, 3)).choice.kind, 'school');
    await client.segments.create(identity, { requestId: randomUUID(), segmentId: schoolSegment, sessionId: authority.sessionId, purpose: 'learning', source: { selected: true, selectionVersion: 3 }, prefix: { system: '', tools: [] }, portable: [] });
    assert.equal((await hub.segments.read(identity, schoolSegment)).connection.connectionId, schoolId);
    assert.equal((await client.checks.read(identity, attemptId)).connection.connectionId, personalId);
    // A replacement device becomes the current binding. Old routes still use the old authenticated poller.
    await paired.bind(identity, { requestId: randomUUID(), expectedVersion: 1, owner: { environmentId: randomUUID(), serviceId: randomUUID() }, installationId: randomUUID(), grantId: randomUUID(), connectionId: randomUUID() });
    const imageId = randomUUID(); segmentContext = segmentId;
    await client.images.upload(identity, { requestId: randomUUID(), imageId, mediaType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=' });
    assert.equal((await device.images.read(identity, { imageId, version: 1 })).imageId, imageId);
    assert.equal((await client.images.read(identity, { imageId, version: 1 })).imageId, imageId);
    await client.results.retain(identity, { requestId: randomUUID(), resultRef: completed.resultRef, consumer: 'run', consumerId: authority.runId });
    assert.equal((await client.checks.requestPayload(identity, attemptId)).model, 'personal-fixture');
    assert.equal((await client.segments.close(identity, segmentId, { requestId: randomUUID(), expectedSequence: 1 })).closed, true);
    await paired.validate(); assert.equal(workerError, undefined);
  } finally {
    running = false; resume?.(); await worker;
    hub?.closeWrites(); device?.closeWrites(); await hub?.checks.drain(); await device?.checks.drain();
    await hubStorage?.close(); await deviceStorage?.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await fixture.close();
  }
});

test('Root choice unifies school, Root self and device grants without redirecting accepted work', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture(); const stores = []; const gateways = []; let worker; let running = true; let workerError; let deviceOnline = true;
  const sent = [];
  const upstream = createServer(async (request, response) => {
    const parts = []; for await (const part of request) parts.push(part);
    sent.push(JSON.parse(Buffer.concat(parts)).model);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[{"index":0,"delta":{"content":"原owner结果"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const open = async name => {
      const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
      const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations: modelMigrations });
      const backend = createFileBackend({ id: 'files', root: fixture.root + '/' + name });
      const storage = await openStorage({ binding, migrations: modelMigrations, backend });
      stores.push(storage);
      const gateway = await createModelGateway(storage, { authorizePermit: async () => {}, holder: 'device', authorize: async () => {} });
      gateways.push(gateway); return [storage, gateway, binding, backend];
    };
    const [storage, root, rootBinding, rootBackend] = await open('root'), [deviceStorage, device] = await open('device');
    const actor = { environmentId: storage.owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '学校成员' };
    const personal = { ...actor, environmentId: deviceStorage.owner.environmentId, spaceId: randomUUID(), kind: 'personal' };
    const base = { expectedVersion: 0, name: '显式选择', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions',
      dialect: 'standard', parameterMode: 'plain', enabled: true, credential: { action: 'replace', value: 'synthetic-key' } };
    const schoolId = randomUUID(), selfId = randomUUID(), deviceId = randomUUID(), selfGrant = randomUUID(), deviceGrant = randomUUID();
    await root.school.save(actor.spaceId, { ...base, requestId: randomUUID(), connectionId: schoolId, modelId: 'school', policy: { checksAllowed: true, maxChecksPerHour: 6, maxOutputTokens: 2048, timeoutMs: 30000 } });
    await root.save(actor, { ...base, requestId: randomUUID(), connectionId: selfId, modelId: 'root-self' });
    await root.selection.createGrant(actor, actor, { requestId: randomUUID(), grantId: selfGrant, connectionId: selfId, owner: 'self' });
    await root.selection.save(actor, { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId: selfId, grantId: selfGrant } });
    await device.save(personal, { ...base, requestId: randomUUID(), connectionId: deviceId, modelId: 'device' });
    await device.selection.createGrant(actor, personal, { requestId: randomUUID(), grantId: deviceGrant, connectionId: deviceId, owner: 'device' });
    const origin = { formatVersion: 3, sessionId: randomUUID(), service: { environmentId: randomUUID(), serviceId: randomUUID() }, installationId: randomUUID(), grantId: randomUUID() };
    const authority = { sessionId: origin.sessionId, runId: randomUUID(), stepId: randomUUID(), operationId: randomUUID(), generation: 1 };
    const paired = createPairedLearningModels(storage, root, { authorize: async () => {}, authorizeBinding: async () => {}, authorizeOrigin: async () => {}, assertWritable() {}, pollIntervalMs: 5, timeoutMs: 500 });
    const binding = await paired.bind(actor, { requestId: randomUUID(), expectedVersion: 0, owner: deviceStorage.owner, installationId: randomUUID(), grantId: randomUUID(), connectionId: randomUUID() });
    const pollBinding = { grantId: binding.grantId, installationId: binding.installationId };
    worker = (async () => {
      while (running) {
        if (!deviceOnline) { await new Promise(resolve => setTimeout(resolve, 5)); continue; }
        for (const task of await root.deviceTasks.pending(actor, pollBinding)) {
          await paired.authorizeTask(actor, pollBinding, task.taskId);
          const reply = await createLearningModelService(device, async () => {})(task.request);
          await root.deviceTasks.complete(actor, pollBinding, task.taskId, reply);
        }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    })().catch(error => { workerError = error; running = false; });
    const client = createLearningModelClient(request => { request = sessionRequest(request, authority); return paired.request(request, { ...origin, operationId: randomUUID(),
      ...(request.operation === 'checks.receive' || request.operation === 'checks.dispatch' ? { authority: { ...authority } } : {}) }); });
    const choices = await client.selection.read(actor);
    assert.equal(choices.version, 1); assert.equal(choices.selected.connection.connectionId, selfId);
    assert.deepEqual(new Set(choices.options.map(choice => choice.connection.connectionId)), new Set([schoolId, selfId, deviceId]));
    assert.deepEqual(await root.selection.read(actor), choices, 'Root HTTP reads the same pointer and options as the Agent');
    const make = async (version, connectionId, owner) => {
      const segmentId = randomUUID(), attemptId = randomUUID();
      await client.segments.create(actor, { requestId: randomUUID(), segmentId, sessionId: authority.sessionId, purpose: 'learning', source: { selected: true, selectionVersion: version }, prefix: { system: '', tools: [] }, portable: [] });
      const received = await client.checks.receive(actor, { attemptId, segmentId, purpose: 'learning', expectedSequence: 0,
        input: { text: '固定owner', images: [], toolResults: [] }, limits: { maxOutputTokens: 32, timeoutMs: 30000 } });
      assert.equal(received.connection.connectionId, connectionId);
      assert.equal((await owner.checks.read(actor, attemptId)).attemptId, attemptId);
      return { attemptId, segmentId, source: received.source };
    };
    const selfAttempt = await make(1, selfId, root);
    await root.selection.save(actor, { requestId: randomUUID(), expectedVersion: 1, source: { kind: 'school', connectionId: schoolId } });
    const schoolAttempt = await make(2, schoolId, root);
    await root.selection.save(actor, { requestId: randomUUID(), expectedVersion: 2, source: { kind: 'personal', connectionId: deviceId, grantId: deviceGrant } });
    // Device has never selected this connection. Root's grant pointer alone selects it.
    assert.equal((await device.selection.read(actor)).version, 0);
    assert.equal((await client.selection.snapshot(actor, 3)).choice.connection.connectionId, deviceId);
    const deviceAttempt = await make(3, deviceId, device);
    assert.equal(selfAttempt.source.ownerScope, [actor.environmentId, actor.spaceId, actor.principalId].join('.'));
    assert.equal(schoolAttempt.source.feeSource, 'school:' + actor.environmentId + ':' + actor.spaceId);
    assert.equal(deviceAttempt.source.ownerScope, [personal.environmentId, personal.spaceId, personal.principalId].join('.'));
    const reopened = await openStorage({ binding: rootBinding, migrations: modelMigrations, backend: rootBackend });
    try {
      const recovered = await createModelGateway(reopened, { authorize: async () => {} });
      assert.equal((await recovered.selection.read(actor)).selected.connection.connectionId, deviceId);
      await recovered.validate();
    } finally { await reopened.close(); }
    deviceOnline = false;
    await assert.rejects(client.selection.snapshot(actor, 3), { code: 'unavailable' });
    assert.equal((await root.selection.read(actor)).selected.connection.connectionId, deviceId, 'offline never falls back to school or Root self');
    deviceOnline = true;
    await root.selection.save(actor, { requestId: randomUUID(), expectedVersion: 3, source: { kind: 'school', connectionId: schoolId } });
    // Changing the current binding cannot send old attempts to the replacement device.
    await paired.bind(actor, { requestId: randomUUID(), expectedVersion: 1, owner: { environmentId: randomUUID(), serviceId: randomUUID() }, installationId: randomUUID(), grantId: randomUUID(), connectionId: randomUUID() });
    for (const [record, expected] of [[selfAttempt, 'root-self'], [schoolAttempt, 'school'], [deviceAttempt, 'device']]) {
      await client.checks.dispatch(actor, record.attemptId);
      let fact; const until = Date.now() + 5000;
      do {
        fact = await client.checks.read(actor, record.attemptId);
        if (fact.physicalRequestEnded) break;
        assert.ok(Date.now() < until); await new Promise(resolve => setTimeout(resolve, 10));
      } while (true);
      assert.equal(fact.state, 'completed'); assert.deepEqual(fact.source, record.source);
      assert.equal((await client.checks.requestPayload(actor, record.attemptId)).model, expected);
      await client.results.retain(actor, { requestId: randomUUID(), resultRef: fact.resultRef, consumer: 'run', consumerId: authority.runId });
    }
    assert.deepEqual(sent, ['root-self', 'school', 'device']);
    assert.equal((await root.selection.read(actor)).selected.connection.connectionId, schoolId);
    assert.equal((await client.selection.read(actor)).selected.connection.connectionId, schoolId, 'an offline unselected device cannot disable Root school');
    await paired.validate(); await root.validate(); await device.validate(); assert.equal(workerError, undefined);
  } finally {
    running = false; await worker;
    for (const gateway of gateways) { gateway.closeWrites(); await gateway.checks.drain(); }
    for (const storage of stores.reverse()) await storage.close();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await fixture.close();
  }
});

test('late device option receipts cannot roll back newer metadata or Root choice', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture(); let storage;
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations: modelMigrations });
    storage = await openStorage({ binding, migrations: modelMigrations, backend: createFileBackend({ id: 'files', root: fixture.root + '/objects' }) });
    const models = await createModelGateway(storage, { authorizePermit: async () => {}, authorize: async () => {} });
    const identity = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: 'Root成员' };
    const schoolId = randomUUID();
    const school = await models.school.save(identity.spaceId, { requestId: randomUUID(), connectionId: schoolId, expectedVersion: 0,
      name: 'Root学校', protocol: 'chat-completions', baseUrl: 'https://example.com', path: '/chat/completions', modelId: 'fixture', dialect: 'standard', parameterMode: 'plain', enabled: true,
      credential: { action: 'replace', value: 'synthetic-key' }, policy: { checksAllowed: true, maxChecksPerHour: 6, maxOutputTokens: 2048, timeoutMs: 30000 } });
    await models.selection.save(identity, { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'school', connectionId: schoolId } });
    const paired = createPairedLearningModels(storage, models, { authorize: async () => {}, authorizeBinding: async () => {}, authorizeOrigin: async () => {}, assertWritable() {}, timeoutMs: 20, pollIntervalMs: 5 });
    const device = await paired.bind(identity, { requestId: randomUUID(), expectedVersion: 0, owner: { environmentId: randomUUID(), serviceId: randomUUID() }, installationId: randomUUID(), grantId: randomUUID(), connectionId: randomUUID() });
    const context = { service: { environmentId: randomUUID(), serviceId: randomUUID() }, installationId: randomUUID(), grantId: randomUUID() };
    const old = { ...context, operationId: randomUUID() }, next = { ...context, operationId: randomUUID() };
    const request = { operation: 'selection.read', identity, args: [] };
    assert.equal((await paired.request(request, old)).value.selected.connection.connectionId, schoolId);
    assert.equal((await paired.request(request, next)).value.selected.connection.connectionId, schoolId);
    const pair = { grantId: device.grantId, installationId: device.installationId };
    const choice = { kind: 'personal', connection: { ...school.connection, connectionId: randomUUID(), name: '最新设备选项' }, policy: school.policy, origin: 'grant', grantId: randomUUID() };
    await models.deviceTasks.complete(identity, pair, next.operationId, { ok: true, value: { version: 0, selected: null, options: [choice] } });
    assert.equal((await paired.request(request, next)).value.options.some(item => item.connection.connectionId === choice.connection.connectionId), true);
    await models.deviceTasks.complete(identity, pair, old.operationId, { ok: true, value: { version: 0, selected: null, options: [] } });
    const result = await paired.request(request, old);
    assert.equal(result.value.version, 1); assert.equal(result.value.selected.connection.connectionId, schoolId);
    assert.equal(result.value.options.some(item => item.connection.connectionId === choice.connection.connectionId), true);
    const refused = { ...context, operationId: randomUUID() };
    await paired.request(request, refused);
    await models.deviceTasks.complete(identity, pair, refused.operationId, { ok: false, code: 'forbidden' });
    assert.equal((await paired.request(request, refused)).value.selected.connection.connectionId, schoolId,
      'an unselected device refusal cannot disable Root school after fresh origin authorization');
    await models.validate();
  } finally { await storage?.close(); await fixture.close(); }
});

function sessionRequest(request, permit) {
  if (!['checks.receive', 'checks.dispatch'].includes(request.operation)) return request;
  const attemptId = request.operation === 'checks.receive' ? request.args[0].attemptId : request.args[0];
  permit.operationId = attemptId;
  const authority = { formatVersion: 1, permit: { ...permit } };
  return { ...request, args: request.operation === 'checks.receive' ? [{ ...request.args[0], authority }] : [attemptId, authority] };
}
