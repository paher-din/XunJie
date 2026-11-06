import './model-cleanup-source-loader.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
const { createModelGateway, modelMigrations } = await import('../../../packages/learning-space/dist/model-connections/index.js');
const { createPairedLearningModels } = await import('../../../packages/learning-space/dist/model-connections/paired-learning.js');
const { createLearningModelClient, createLearningModelService } = await import('../../../packages/learning-space/dist/model-connections/service.js');
const { routeModels } = await import('../../../packages/learning-space/dist/model-connections/wire.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function setup() {
  const pg = await nativeFixture(), stores = [], gateways = [], received = [], pendingAcks = new Map();
  const started = Promise.withResolvers(), ended = Promise.withResolvers(); let holdSdk = false, holdRevoke = false, holdAck = false, running = true, workerError, paired;
  const context = new AsyncLocalStorage();
  const upstream = createServer(async (request, response) => {
    for await (const _ of request) {} received.push(request.url);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"index":0,"delta":{"content":"原owner"},"finish_reason":null}]}\n\n');
    if (holdSdk) { response.once('close', () => ended.resolve()); started.resolve(); }
    else response.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const open = async name => {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations: modelMigrations });
    const storage = await openStorage({ binding, migrations: modelMigrations, backend: createFileBackend({ id: 'files', root: pg.root + '/' + name }) });
    stores.push(storage); return storage;
  };
  const rootStorage = await open('root'), deviceStorage = await open('device');
  const identity = { environmentId: rootStorage.owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '原主体' };
  const personal = { ...identity, environmentId: deviceStorage.owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal' };
  const root = await createModelGateway(rootStorage, { holder: 'device', authorize: async () => {} }); gateways.push(root);
  let binding;
  const device = await createModelGateway(deviceStorage, { holder: 'device', authorize: async () => {}, authorizationPollMs: 20,
    authorizeActive: async () => { const task = context.getStore(); if (task?.operation === 'learning') await paired.authorizeTask(identity, pair, task.taskId); } }); gateways.push(device);
  const base = { expectedVersion: 0, name: '原设备连接', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions',
    modelId: 'fixture', dialect: 'standard', parameterMode: 'plain', enabled: true, credential: { action: 'replace', value: 'synthetic-key' } };
  const schoolId = randomUUID(), selfId = randomUUID(), personalId = randomUUID();
  await root.school.save(identity.spaceId, { ...base, requestId: randomUUID(), connectionId: schoolId, policy: { checksAllowed: true, maxChecksPerHour: 6, maxOutputTokens: 2048, timeoutMs: 30000 } });
  await device.save(identity, { ...base, requestId: randomUUID(), connectionId: selfId });
  await device.save(personal, { ...base, requestId: randomUUID(), connectionId: personalId });
  paired = createPairedLearningModels(rootStorage, root, { authorize: async () => {}, authorizeBinding: async () => {}, authorizeOrigin: async () => {}, assertWritable() {}, timeoutMs: 180, pollIntervalMs: 5 });
  binding = await paired.bind(identity, { requestId: randomUUID(), expectedVersion: 0, owner: deviceStorage.owner, installationId: randomUUID(), grantId: randomUUID(), connectionId: randomUUID() });
  const pair = { grantId: binding.grantId, installationId: binding.installationId };
  const source = { sourceEnvironmentId: binding.owner.environmentId, sourceServiceId: binding.owner.serviceId, sourceInstallationId: binding.installationId, grantId: binding.grantId, connectionId: binding.connectionId };
  const publish = async () => paired.publishChoices(identity, source, { requestId: randomUUID(), projection: await device.selection.read(identity, personal) });
  const origin = { operationId: randomUUID(), service: { environmentId: randomUUID(), serviceId: randomUUID() }, installationId: randomUUID(), grantId: randomUUID(), activityId: randomUUID() };
  const authority = { driverId: 'original-driver', runId: randomUUID(), activityId: origin.activityId, generation: 1 };
  const client = createLearningModelClient(request => paired.request(request, { ...origin, operationId: randomUUID(),
    ...(request.operation === 'checks.receive' || request.operation === 'checks.dispatch' ? { authority } : {}) }));
  const worker = (async () => {
    while (running) {
      await paired.enqueueGrantChanges(identity, pair);
      for (const task of await root.deviceTasks.pending(identity, pair)) {
        if (pendingAcks.has(task.taskId) || task.operation === 'grant-revoke' && holdRevoke) continue;
        let receipt;
        if (task.operation === 'grant-create' || task.operation === 'grant-revoke') {
          await paired.authorizeGrantTask(identity, pair, task.taskId);
          let fact;
          if (task.operation === 'grant-create') {
            await device.selection.createGrant(identity, task.ownerKind === 'device' ? personal : identity, task.input);
            fact = await device.selection.readGrant(identity, task.input.grantId);
          } else {
            fact = await device.selection.readGrant(identity, task.modelGrantId);
            if (fact.active) fact = await device.selection.revoke(identity, task.modelGrantId, task.input);
          }
          receipt = { ok: true, value: fact };
        } else receipt = await context.run(task, () => createLearningModelService(device, async () => paired.authorizeTask(identity, pair, task.taskId))(task.request));
        if (holdAck && task.operation.startsWith('grant-')) pendingAcks.set(task.taskId, receipt);
        else await root.deviceTasks.complete(identity, pair, task.taskId, receipt);
      }
      await delay(5);
    }
  })().catch(error => { workerError = error; running = false; });
  return { root, device, identity, personal, selfId, personalId, schoolId, pair, binding, source, client, paired, publish, started, ended, received,
    setHoldSdk(value) { holdSdk = value; }, setHoldRevoke(value) { holdRevoke = value; }, setHoldAck(value) { holdAck = value; },
    async ack() { holdAck = false; for (const [id, receipt] of pendingAcks) await root.deviceTasks.complete(identity, pair, id, receipt); pendingAcks.clear(); },
    async grant(connectionId) { return routeModels(root, identity, 'models/grants', { requestId: randomUUID(), grantId: randomUUID(), connectionId, owner: 'device' }); },
    async close() {
      running = false; await worker;
      for (const gateway of gateways) { gateway.closeWrites(); await gateway.checks.drain(); }
      for (const storage of stores.reverse()) await storage.close();
      upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await pg.close(); assert.equal(workerError, undefined);
    } };
}

test('Root settings discovers raw local-self and personal-device choices without an Agent, grants at the real owner, and selects immediately', { timeout: 60000 }, async () => {
  const f = await setup();
  try {
    await assert.rejects(f.paired.publishChoices(f.identity, { ...f.source, sourceServiceId: randomUUID() }, { requestId: randomUUID(), projection: await f.device.selection.read(f.identity, f.personal) }), { code: 'forbidden' });
    await f.publish();
    const view = await routeModels(f.root, f.identity, 'models/selection');
    for (const id of [f.selfId, f.personalId]) assert.ok(view.options.some(choice => choice.connection.connectionId === id && choice.origin === 'device' && !choice.grantId));
    assert.equal((await f.root.deviceTasks.pending(f.identity, f.pair)).length, 0, 'publication is metadata, not an Agent task');
    let version = view.version;
    for (const [id, owner] of [[f.selfId, f.identity], [f.personalId, f.personal]]) {
      const grant = await f.grant(id);
      assert.deepEqual(grant.owner, owner); assert.deepEqual(await f.device.selection.readGrant(f.identity, grant.grantId), grant);
      const selected = await routeModels(f.root, f.identity, 'models/selection', { requestId: randomUUID(), expectedVersion: version++, source: { kind: 'personal', connectionId: id, grantId: grant.grantId } });
      assert.equal(selected.selected.connection.connectionId, id);
      assert.deepEqual((await f.root.selection.destination(f.identity)).binding, f.binding);
    }
    assert.equal((await f.root.list(f.identity)).length, 0, 'same identity on the device is not a Root-owned connection');
    assert.equal((await f.device.selection.read(f.identity)).version, 0); assert.equal((await f.device.selection.read(f.personal)).version, 0);
    await f.root.validate(); await f.device.validate();
  } finally { await f.close(); }
});

test('Root revoke denies existing segments and stops the in-flight SDK before an unknown ACK, then confirms the actual owner grant', { timeout: 60000 }, async () => {
  const f = await setup();
  try {
    await f.publish(); const grant = await f.grant(f.selfId);
    await f.root.selection.save(f.identity, { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId: f.selfId, grantId: grant.grantId } });
    const segmentId = randomUUID(), attemptId = randomUUID();
    await f.client.segments.create(f.identity, { requestId: randomUUID(), segmentId, purpose: 'learning', source: { selected: true, selectionVersion: 1 }, prefix: { system: '', tools: [] }, portable: [] });
    await f.client.checks.receive(f.identity, { attemptId, segmentId, purpose: 'learning', expectedSequence: 0, input: { text: '原SDK', images: [], toolResults: [] }, limits: { maxOutputTokens: 32, timeoutMs: 30000 } });
    await f.root.selection.save(f.identity, { requestId: randomUUID(), expectedVersion: 1, source: { kind: 'school', connectionId: f.schoolId } });
    f.setHoldSdk(true); await f.client.checks.dispatch(f.identity, attemptId); await f.started.promise;
    assert.equal(f.received.length, 1, 'pointer change alone must not revoke old work');
    f.setHoldRevoke(true);
    const input = { requestId: randomUUID(), expectedVersion: 1 };
    await assert.rejects(routeModels(f.root, f.identity, 'models/grants/' + grant.grantId + '/revoke', input), { code: 'unavailable' });
    const until = Date.now() + 5000; let fact;
    do { fact = await f.device.checks.read(f.identity, attemptId); if (fact.physicalRequestEnded) break; assert.ok(Date.now() < until); await delay(10); } while (true);
    await f.ended.promise;
    assert.equal(fact.cancelRequested, true); assert.equal(fact.state, 'cancelled');
    assert.equal((await f.device.selection.readGrant(f.identity, grant.grantId)).active, true, 'unknown ACK is never advertised as owner confirmation');
    await assert.rejects(f.client.checks.dispatch(f.identity, attemptId), { code: 'forbidden' });
    await assert.rejects(f.client.checks.receive(f.identity, { attemptId: randomUUID(), segmentId, purpose: 'learning', expectedSequence: 1, input: { text: '禁止复用旧段', images: [], toolResults: [] }, limits: { maxOutputTokens: 32 } }), { code: 'forbidden' });
    f.setHoldAck(true); f.setHoldRevoke(false);
    const ownerUntil = Date.now() + 5000;
    while ((await f.device.selection.readGrant(f.identity, grant.grantId)).active) { assert.ok(Date.now() < ownerUntil); await delay(10); }
    await assert.rejects(routeModels(f.root, f.identity, 'models/grants/' + grant.grantId + '/revoke', input), { code: 'unavailable' });
    await f.ack();
    const confirmed = await routeModels(f.root, f.identity, 'models/grants/' + grant.grantId + '/revoke', input);
    assert.equal(confirmed.active, false); assert.equal(confirmed.version, 2);
    assert.deepEqual(confirmed, await f.device.selection.readGrant(f.identity, grant.grantId));
    assert.equal((await f.client.checks.read(f.identity, attemptId)).attemptId, attemptId);
    assert.ok((await f.client.checks.read(f.identity, attemptId)).resultRef); assert.equal(f.received.length, 1);
    await f.publish();
    await assert.rejects(f.root.selection.save(f.identity, { requestId: randomUUID(), expectedVersion: 2, source: { kind: 'personal', connectionId: f.selfId, grantId: grant.grantId } }), { code: 'forbidden' });
    assert.equal((await f.root.selection.read(f.identity)).selected.connection.connectionId, f.schoolId);
    await f.root.validate(); await f.device.validate();
  } finally { await f.close(); }
});
