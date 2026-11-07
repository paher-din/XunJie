import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { provisionStorage, openStorage, createFileBackend, StorageError, prepareStorageRestore, finalizeStorageRestore } from '@xunjie/storage';
import { createModelGateway, modelMigrations } from '../../../packages/learning-space/dist/model-connections/index.js';
import { openProductRuntime } from '../../../packages/product-runtime/dist/runtime.js';
import { createProductRuntimeHost } from '../../../packages/product-runtime/dist/host.js';
import { createSchoolClient } from '../../../packages/product-runtime/dist/school-client.js';
import { createConnectionAuthority } from '../../../packages/product-runtime/dist/connections.js';
import { withModelOriginRecovery, createModelRecipientRecovery } from '../../../packages/product-runtime/dist/model-origin-authority.js';
import { retireInstallation } from '../../../packages/product-runtime/dist/retired-installations.js';
import { recordRecoverySuccession, isRecoverySuccessor, recoveryPredecessors } from '../../../packages/product-runtime/dist/recovery-successions.js';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { createModelDeviceTasks } from '../../../packages/learning-space/dist/model-connections/device-tasks.js';
import { createRecoveryManager, restoreRecoverySet } from '../../../packages/product-runtime/dist/recovery.js';
import { createMaintenanceCoordinator } from '../../../packages/product-runtime/dist/maintenance.js';
import { createStorageRecoveryOwner, createStorageRecoveryTarget } from '../../../packages/product-runtime/dist/storage-recovery.js';
import { createPairedLearningModels } from '../../../packages/learning-space/dist/model-connections/paired-learning.js';
import { createSpaces, spaceMigrations } from '../../../packages/learning-space/dist/spaces/index.js';
import { createLearningAuthority } from '../../../packages/learning-space/dist/learning-entry/authority.js';

async function until(read, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(message);
}

test('R10 host-verified successors query and cancel accepted, in-flight and completed original attempts without another SDK call', { timeout: 120000 }, async () => {
  const fixture = await nativeFixture();
  let storage, models, authority, originAuthority, schoolAccess;
  let sends = 0; const responses = [];
  const upstream = createServer(async (request, response) => {
    for await (const _ of request) { /* real SDK */ }
    sends++; responses.push(response);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"index":0,"delta":{"content":"original"},"finish_reason":null}]}\n\n');
  });
  const school = createServer(async (request, response) => {
    if (request.url === '/api/learning/access') {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(schoolAccess));
    } else if (!await authority.handle(request, response)) { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => school.listen(0, '127.0.0.1', resolve));
  const schoolRoot = join(fixture.root, 'school'), deviceRoot = join(fixture.root, 'device');
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations: modelMigrations });
    const backend = createFileBackend({ id: 'files', root: fixture.root + '/objects' });
    storage = await openStorage({ binding, backend, migrations: modelMigrations });
    const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: 'School' };
    const deviceInstallationId = randomUUID(), connectionId = randomUUID(), runtimeConnectionId = randomUUID();
    const modelTarget = { ...owner, version: 1 }, learningTarget = { environmentId: identity.environmentId, serviceId: randomUUID(), version: 1 };
    schoolAccess = { identity, target: learningTarget };
    const endpoint = `http://127.0.0.1:${school.address().port}`;
    const service = { environmentId: identity.environmentId, serviceId: learningTarget.serviceId, endpoint, protocolVersion: 1,
      capabilities: ['learning.authority', 'teaching.dependencies'] };
    const agentService = { environmentId: randomUUID(), serviceId: randomUUID() }, first = randomUUID(), middle = randomUUID(), last = randomUUID();
    const agentSource = installationId => ({ sourceEnvironmentId: agentService.environmentId,
      sourceServiceId: agentService.serviceId, sourceInstallationId: installationId });
    let permitAllowed = true;
    authority = createConnectionAuthority({ root: schoolRoot, service, handlers: {
      'teaching.dependencies': async (_payload, source) => {
        await source.assertAuthorized?.();
        return { authorized: true };
      },
      'learning.authority': async (payload, source) => {
        const device = { grantId: source.grantId, installationId: source.sourceInstallationId };
        assert.equal(payload.connectionId, connectionId);
        if (payload.operation === 'modelAccess') return { identity, target: modelTarget };
        if (payload.operation === 'modelTaskPermit') {
          try { return await originAuthority.authorizeTask(identity, device, payload.input.taskId); }
          catch (error) { return { error: error instanceof StorageError ? error.code : 'forbidden' }; }
        }
        if (payload.operation === 'pollModelTasks') return models.deviceTasks.pending(identity, device);
        if (payload.operation === 'completeModelTask') return models.deviceTasks.complete(identity, device, payload.input.taskId, payload.input.receipt);
        if (payload.operation === 'modelChoices') return { published: true };
        throw new Error('Unexpected authority operation');
      },
    } });
    const originalGrant = await authority.authorize({ ...agentSource(first), capabilities: ['teaching.dependencies'] });
    const deviceGrant = await authority.authorize({ sourceEnvironmentId: owner.environmentId, sourceServiceId: owner.serviceId,
      sourceInstallationId: deviceInstallationId, capabilities: ['learning.authority'] });
    const pair = { grantId: deviceGrant.grantId, installationId: deviceInstallationId };
    await mkdir(join(deviceRoot, 'credentials'), { recursive: true });
    await writeFile(join(deviceRoot, 'credentials', 'transport'), deviceGrant.token);
    await writeFile(join(deviceRoot, 'credentials', 'school-client-' + connectionId), JSON.stringify({ requestId: connectionId, schoolEndpoint: endpoint,
      verifier: 'fixture', clientId: randomUUID(), clientNamespace: 'fixture', grant: { token: 'x'.repeat(80), identity, target: learningTarget,
        connectionId, capabilities: ['activity:read', 'activity:write'] }, modelBinding: { runtimeConnectionId, target: modelTarget } }));
    await writeFile(join(deviceRoot, 'installation.json'), JSON.stringify({ connections: [{ connectionId: runtimeConnectionId,
      sourceEnvironmentId: owner.environmentId, sourceServiceId: owner.serviceId, target: service,
      requiredCapabilities: ['learning.authority'], optionalCapabilities: [], credentialRef: 'transport' }] }));
    const local = { target: learningTarget, modelTarget };
    const client = createSchoolClient(deviceRoot, { formatVersion: 1, environmentId: owner.environmentId, installationId: deviceInstallationId,
      clientNamespace: 'fixture', profile: 'model', services: [] }, local);
    models = await createModelGateway(storage, { holder: 'device', authorize: client.authorizeModel,
      authorizeDispatch: client.authorizeModelDispatch, authorizationPollMs: 60000 });
    local.models = models;
    // The fixture's school task authority exercises real WP01 grants, retirement files and route
    // succession. The production adapter supplies only that host's evidence to the actual poller.
    originAuthority = withModelOriginRecovery(schoolRoot, { async authorizeTask(actor, device, taskId) {
      if (!permitAllowed) throw new StorageError('forbidden');
      const { task } = await models.deviceTasks.read(actor, device, taskId);
      const origin = task.origin;
      await authority.assertSourceAuthorized({ sourceEnvironmentId: origin.service.environmentId, sourceServiceId: origin.service.serviceId,
        sourceInstallationId: origin.installationId, grantId: origin.grantId }, 'teaching.dependencies');
      if (!await isRecoverySuccessor(schoolRoot, agentSource(first), origin.installationId)) throw new StorageError('forbidden');
      return { authorized: true };
    } }, models);
    const connection = randomUUID();
    await models.save(identity, { requestId: randomUUID(), connectionId: connection, expectedVersion: 0, name: 'R10 model', protocol: 'chat-completions',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions', modelId: 'fixture', dialect: 'standard', parameterMode: 'plain', enabled: true,
      credential: { action: 'replace', value: 'synthetic-r10-key' } });
    const attempts = [];
    async function task(operation, args, origin, authorityFields) {
      const taskId = randomUUID(), attemptId = operation.startsWith('checks.') ? operation === 'checks.receive' ? args[0].attemptId : args[0] : undefined;
      await models.deviceTasks.enqueue(identity, pair, { taskId, ...(attemptId ? { attemptId } : {}), operation: 'learning', formatVersion: 2,
        origin: { ...origin, ...(authorityFields ? { authority: authorityFields } : {}) }, request: { identity, operation, args } });
      await client.pollModelTasks(() => true);
      const record = await models.deviceTasks.read(identity, pair, taskId);
      assert.ok(record.receipt, 'task completed through real school-client poller'); return record.receipt;
    }
    for (const state of ['completed', 'in-flight', 'accepted']) {
      const attemptId = randomUUID(), segmentId = randomUUID(), activityId = randomUUID(), runId = randomUUID();
      const origin = { service: agentService, installationId: first, grantId: originalGrant.grantId, identity,
        recoveryGeneration: deviceInstallationId, activityId };
      const lease = { driverId: 'original-driver', generation: 1, activityId, runId };
      const created = await task('segments.create', [{ requestId: randomUUID(), segmentId, purpose: 'learning', source: { connectionId: connection, version: 1 },
        prefix: { system: '', tools: [] }, portable: [] }], origin);
      assert.equal(created.ok, true, JSON.stringify(created));
      const accepted = await task('checks.receive', [{ attemptId, segmentId, purpose: 'learning', expectedSequence: 0,
        input: { text: state, images: [], toolResults: [] }, limits: { maxOutputTokens: 128, timeoutMs: 90000 } }], origin, lease);
      assert.equal(accepted.value?.state, 'accepted', JSON.stringify(accepted));
      if (state !== 'accepted') {
        const expected = sends + 1;
        assert.equal((await task('checks.dispatch', [attemptId], origin, lease)).ok, true);
        await until(() => sends === expected, 'SDK request started');
        if (state === 'completed') {
          responses.at(-1).end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
          await until(async () => (await models.checks.read(identity, attemptId)).state === 'completed', 'original completion persisted');
        }
      }
      attempts.push({ state, attemptId, origin, lease });
    }
    assert.equal(sends, 2);
    // An independently granted installation is not a successor.
    const stranger = randomUUID(), strangerGrant = await authority.authorize({ ...agentSource(stranger), capabilities: ['teaching.dependencies'] });
    assert.deepEqual(await task('checks.read', [attempts[0].attemptId], { ...attempts[0].origin, installationId: stranger, grantId: strangerGrant.grantId }),
      { ok: false, code: 'forbidden' });
    // Actual receiver fencing is required before maintenance can record each succession hop.
    const one = { formatVersion: 1, backupId: randomUUID(), ...agentSource(first), targetInstallationId: middle };
    await assert.rejects(recordRecoverySuccession(schoolRoot, one), /retired source/);
    await authority.fenceSource(agentSource(first)); await recordRecoverySuccession(schoolRoot, one);
    const two = { formatVersion: 1, backupId: randomUUID(), ...agentSource(middle), targetInstallationId: last };
    await authority.fenceSource(agentSource(middle)); await recordRecoverySuccession(schoolRoot, two);
    const successorGrant = await authority.authorize({ ...agentSource(last), capabilities: ['teaching.dependencies'] });
    for (const record of attempts) {
      const successor = { ...record.origin, installationId: last, grantId: successorGrant.grantId };
      const original = await models.origins.read(identity, record.attemptId);
      assert.deepEqual(await task('checks.read', [record.attemptId], record.origin), { ok: false, code: 'forbidden' });
      const result = await task('checks.read', [record.attemptId], successor);
      assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.value.attemptId, record.attemptId);
      assert.equal(result.value.state, record.state === 'in-flight' ? 'dispatched' : record.state);
      assert.deepEqual(await models.origins.read(identity, record.attemptId), original, 'original provenance is immutable');
      assert.deepEqual(await task('checks.dispatch', [record.attemptId], successor, record.lease), { ok: false, code: 'identity-conflict' });
      const cancelled = await task('checks.cancel', [record.attemptId], successor);
      assert.equal(cancelled.ok, true, JSON.stringify(cancelled)); assert.equal(cancelled.value.attemptId, record.attemptId);
      const again = await task('checks.read', [record.attemptId], successor);
      assert.equal(again.ok, true); assert.equal(again.value.attemptId, record.attemptId);
      const evidence = await storage.read('SELECT installation_id,succession FROM model_origin_authorizations WHERE association_id=$1 AND grant_id=$2',
        [record.attemptId, successorGrant.grantId]);
      assert.equal(evidence.rows[0].installation_id, last); assert.deepEqual(evidence.rows[0].succession, [one, two]);
    }
    assert.equal(sends, 2, 'recovery reads/cancels never start another SDK request');
    const record = attempts[0], successor = { ...record.origin, installationId: last, grantId: successorGrant.grantId };
    permitAllowed = false;
    assert.deepEqual(await task('checks.read', [record.attemptId], successor), { ok: false, code: 'forbidden' }, 'saved proof never bypasses current permit');
    permitAllowed = true;
    const fixed = { ...successor, formatVersion: 2, attemptId: record.attemptId, runId: record.lease.runId };
    await assert.rejects(models.origins.assert(identity, record.attemptId, fixed), { code: 'identity-conflict' }, 'recovery authorization is not dispatch authority');
    for (const changed of [{ ...fixed, grantId: randomUUID() }, { ...fixed, recoveryGeneration: randomUUID() },
      { ...fixed, service: { ...agentService, serviceId: randomUUID() } }, { ...fixed, activityId: randomUUID() }, { ...fixed, runId: randomUUID() }])
      await assert.rejects(models.origins.assert(identity, record.attemptId, changed, 'checks.read'), { code: 'identity-conflict' });
    await models.validate();
    assert.equal(sends, 2);
  } finally {
    models?.closeWrites(); await models?.checks.drain().catch(error => { assert.equal(error.code, 'resource-busy'); }); await storage?.close();
    upstream.closeAllConnections(); school.closeAllConnections();
    await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => school.close(resolve))]);
    await fixture.close();
  }
});


test('R10 original model-owner maintenance and isolated backup restore retain successor proof without restoring dispatch authority', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture(), target = await nativeFixture(); let storage, restored;
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations: modelMigrations });
    const backend = createFileBackend({ id: 'files', root: fixture.root + '/objects' });
    storage = await openStorage({ binding, backend, migrations: modelMigrations });
    const models = await createModelGateway(storage, { authorize: async () => {} });
    const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: 'School' };
    const first = randomUUID(), middle = randomUUID(), last = randomUUID(), stranger = randomUUID();
    const service = { environmentId: randomUUID(), serviceId: randomUUID() };
    const record = { attemptId: randomUUID() };
    const original = { formatVersion: 2, service, identity, attemptId: record.attemptId, installationId: first, grantId: randomUUID(),
      runId: randomUUID(), activityId: randomUUID(), recoveryGeneration: randomUUID() };
    await models.origins.bind(identity, record.attemptId, original);
    const one = { formatVersion: 1, backupId: randomUUID(), sourceEnvironmentId: service.environmentId, sourceServiceId: service.serviceId,
      sourceInstallationId: first, targetInstallationId: middle };
    const two = { ...one, backupId: randomUUID(), sourceInstallationId: middle, targetInstallationId: last };
    await retireInstallation(fixture.root, first); await recordRecoverySuccession(fixture.root, one);
    await retireInstallation(fixture.root, middle); await recordRecoverySuccession(fixture.root, two);
    const fixed = { ...original, installationId: last, grantId: randomUUID() };
    await models.origins.bind(identity, record.attemptId, fixed, { operation: 'checks.read',
      successions: await recoveryPredecessors(fixture.root, service, last) });
    models.closeWrites(); await models.checks.drain();
    await assert.rejects(models.origins.bind(identity, record.attemptId, fixed, { operation: 'checks.read', successions: [one, two] }), { code: 'maintenance' });
    await storage.participant().closeWrites(); await storage.participant().closeDispatch();
    const targetBackend = createFileBackend({ id: 'files', root: target.root + '/objects' });
    const dump = join(fixture.root, 'model.dump'); let manifest;
    const pgTool = async (host, name, args) => {
      try { await promisify(execFile)(host.tool(name), ['-h', host.admin.host, '-p', String(host.admin.port), '-U', host.admin.user,
        '-d', host.admin.database, ...args], { env: { ...process.env, PGPASSWORD: host.admin.password }, timeout: 30000 }); }
      catch { throw new Error(name + ' failed'); }
    };
    await storage.snapshot('r10-model-backup', async snapshot => {
      manifest = snapshot.manifest;
      assert.equal(manifest.schemaVersion, modelMigrations.at(-1).version);
      await pgTool(fixture, 'pg_dump', ['-Fc', '-n', binding.schema, '--snapshot', snapshot.databaseSnapshot, '-f', dump]);
      for (const item of manifest.resources) await targetBackend.put(item.locator.key, await storage.readResourceObject(item.resourceId));
    });
    const destination = await prepareStorageRestore({ admin: target.admin, owner, password: randomUUID() });
    await pgTool(target, 'pg_restore', ['--exit-on-error', '--role', destination.migratorRole, '--no-owner', '--no-acl', dump]);
    restored = await finalizeStorageRestore({ admin: target.admin, binding: destination, migrations: modelMigrations, manifest, backend: targetBackend });
    const recovered = await createModelGateway(restored, { authorize: async () => { throw new StorageError('forbidden'); } });
    recovered.closeWrites();
    await recovered.origins.assert(identity, record.attemptId, fixed, 'checks.read');
    await recovered.origins.assert(identity, record.attemptId, fixed, 'checks.cancel');
    await assert.rejects(recovered.origins.assert(identity, record.attemptId, { ...fixed, installationId: stranger }, 'checks.read'), { code: 'identity-conflict' });
    await recovered.validate();
    await storage.close(); storage = undefined;
    storage = await openStorage({ binding, backend, migrations: modelMigrations });
    const reopened = await createModelGateway(storage, { authorize: async () => { throw new StorageError('forbidden'); } });
    await reopened.origins.assert(identity, record.attemptId, fixed, 'checks.read'); await reopened.validate();
    // Keep the restored owner's isolation gate closed. Inject corruption through the fixture's
    // administrator, not through the application's maintenance-blocked write API.
    await assert.rejects(restored.request({ requestId: randomUUID(), fingerprint: 'still-isolated' }, async () => null), { code: 'maintenance' });
    const admin = new pg.Client(target.admin);
    try {
      await admin.connect();
      await admin.query(`UPDATE "${destination.schema.replaceAll('"', '""')}".model_origin_authorizations SET succession=$1 WHERE grant_id=$2`,
        [JSON.stringify([two]), fixed.grantId]);
    } finally { await admin.end(); }
    await assert.rejects(recovered.validate(), { code: 'corrupt' }, 'isolated validation rejects a broken predecessor chain');
  } finally { await restored?.close(); await storage?.close(); await fixture.close(); await target.close(); }
});

test('R10 migration upgrades populated same-installation authorizations without changing provenance', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture(); let storage;
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() }, oldMigrations = modelMigrations.filter(item => item.version <= 17);
    const password = randomUUID();
    const binding = await provisionStorage({ admin: fixture.admin, owner, password, migrations: oldMigrations });
    const backend = createFileBackend({ id: 'files', root: fixture.root + '/objects' });
    storage = await openStorage({ binding, backend, migrations: oldMigrations });
    const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: 'School' };
    const attemptId = randomUUID(), original = { formatVersion: 2, service: owner, identity, installationId: randomUUID(),
      grantId: randomUUID(), recoveryGeneration: randomUUID(), attemptId, activityId: randomUUID(), runId: randomUUID() };
    const renewed = { ...original, grantId: randomUUID() }, scope = [identity.environmentId, identity.spaceId, identity.principalId].join('.');
    await storage.request({ requestId: randomUUID(), fingerprint: 'v17-authorizations' }, async tx => {
      await tx.query('INSERT INTO model_origin_journals VALUES($1,$2,$3)', [scope, attemptId, original]);
      for (const origin of [original, renewed]) await tx.query('INSERT INTO model_origin_authorizations VALUES($1,$2,$3)', [scope, attemptId, origin.grantId]);
      return null;
    });
    await storage.participant().closeWrites(); await storage.participant().closeDispatch();
    await storage.close(); storage = undefined;
    await provisionStorage({ admin: fixture.admin, owner, password, migrations: modelMigrations });
    storage = await openStorage({ binding, backend, migrations: modelMigrations });
    await storage.participant().resume();
    const models = await createModelGateway(storage, { authorize: async () => {} });
    await models.origins.assert(identity, attemptId, original); await models.origins.assert(identity, attemptId, renewed);
    assert.deepEqual(await models.origins.read(identity, attemptId), original);
    await assert.rejects(models.origins.assert(identity, attemptId, { ...renewed, installationId: randomUUID() }, 'checks.read'), { code: 'identity-conflict' });
    await models.validate();
  } finally { await storage?.close(); await fixture.close(); }
});

for (const rootRoute of [false, true]) test(rootRoute
  ? 'R10 formal Root transfers only original attempt recovery access to a fenced successor through the real device poller'
  : 'R10 restored model recipients admit original reads only after formal takeover and retain ancestor provenance', { timeout: 120000 }, async () => {
  const sourcePg = await nativeFixture(), targetPg = await nativeFixture(), laterPg = await nativeFixture();
  const storages = [], gateways = []; let authority, tasks, schoolAccess, sends = 0, permitAllowed = true, spaces, paired, rootModels, login, formalAuthority, rootRuntime, rootHost, rootEnvironment, rootOwnedStorage;
  const upstream = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    sends++;
    if (rootRoute && body.includes('unknown-attempt')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[{"index":0,"delta":{"content":"retained result"},"finish_reason":"stop"}]}\n\n'
      + 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\ndata: [DONE]\n\n');
  });
  const school = createServer(async (request, response) => {
    if (request.url === '/api/learning/access') {
      let value = schoolAccess;
      if (rootRoute) {
        const identity = await spaces.authenticate(String(request.headers.authorization).slice(7), 'connection');
        value = { identity, target: await spaces.resolveBinding(identity) };
      }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value));
    } else if (!await authority.handle(request, response)) { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => school.listen(0, '127.0.0.1', resolve));
  try {
    const schoolRoot = join(sourcePg.root, 'school');
    const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6',
      webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) };
    if (rootRoute) {
      rootRuntime = openProductRuntime({ root: schoolRoot, resources });
      rootEnvironment = (await rootRuntime.install({ profile: 'remote' })).environment;
    }
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() }, modelTarget = { ...owner, version: 1 };
    let identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: 'School' };
    if (rootRoute) identity.environmentId = rootEnvironment.environmentId;
    const learningTarget = { environmentId: identity.environmentId, serviceId: rootRoute ? rootEnvironment.services[0].serviceId : randomUUID(), version: 1 };
    schoolAccess = { identity, target: learningTarget };
    const endpoint = rootRoute ? rootEnvironment.services[0].endpoint : `http://127.0.0.1:${school.address().port}`;
    const service = { ...learningTarget, endpoint, protocolVersion: 1, capabilities: ['learning.authority', 'teaching.dependencies'] };
    const modelService = { ...owner, unit: 'model-connection', endpoint: 'http://127.0.0.1:1', protocolVersion: 1, capabilities: [] };
    const agentService = { environmentId: randomUUID(), serviceId: randomUUID() }, agentInstallation = randomUUID();
    const connectionId = randomUUID(), runtimeConnectionId = randomUUID();
    const taskBinding = await provisionStorage({ admin: sourcePg.admin,
      owner: { environmentId: identity.environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations: modelMigrations });
    const taskStorage = await openStorage({ binding: taskBinding, migrations: modelMigrations,
      backend: createFileBackend({ id: 'tasks', root: join(sourcePg.root, 'task-resources') }) });
    storages.push(taskStorage); tasks = createModelDeviceTasks(taskStorage, async () => {}, () => {});
    if (rootRoute) {
      const spaceBinding = await provisionStorage({ admin: sourcePg.admin, owner: { environmentId: identity.environmentId, serviceId: randomUUID() },
        password: randomUUID(), migrations: spaceMigrations });
      const spaceStorage = await openStorage({ binding: spaceBinding, migrations: spaceMigrations,
        backend: createFileBackend({ id: 'spaces', root: join(sourcePg.root, 'space-resources') }) });
      storages.push(spaceStorage); spaces = createSpaces(spaceStorage);
      const password = randomUUID();
      identity = await spaces.createMember({ requestId: randomUUID(), loginName: 'recipient-root', password });
      await spaces.bindMember(identity, learningTarget);
      login = await spaces.login('recipient-root', password);
      rootModels = await createModelGateway(taskStorage, { authorize: spaces.authorize }); gateways.push(rootModels);
      tasks = rootModels.deviceTasks;
    }
    authority = createConnectionAuthority({ root: schoolRoot, service, handlers: {
      'teaching.dependencies': async () => ({ authorized: true }),
      'learning.authority': async (payload, source) => {
        if (rootRoute) return formalAuthority(payload, source);
        const device = { grantId: source.grantId, installationId: source.sourceInstallationId };
        if (payload.operation === 'modelAccess') return { identity, target: modelTarget };
        if (payload.operation === 'modelChoices') return { published: true };
        if (payload.operation === 'pollModelTasks') return tasks.pending(identity, device);
        if (payload.operation === 'completeModelTask') return tasks.complete(identity, device, payload.input.taskId, payload.input.receipt);
        if (payload.operation === 'modelTaskPermit') {
          if (!permitAllowed) return { error: 'forbidden' };
          const { task } = await tasks.read(identity, device, payload.input.taskId);
          await authority.assertSourceAuthorized({ sourceEnvironmentId: task.origin.service.environmentId,
            sourceServiceId: task.origin.service.serviceId, sourceInstallationId: task.origin.installationId,
            grantId: task.origin.grantId }, 'teaching.dependencies');
          return { authorized: true, successions: [] };
        }
        throw new Error('Unexpected authority operation');
      },
    } });
    if (rootRoute) {
      paired = createPairedLearningModels(taskStorage, rootModels, { authorize: spaces.authorize,
        async authorizeBinding(actor, binding) {
          await spaces.authorizeConnection(actor, binding.connectionId);
          try { await authority.assertSourceAuthorized({ sourceEnvironmentId: binding.owner.environmentId, sourceServiceId: binding.owner.serviceId,
            sourceInstallationId: binding.installationId, grantId: binding.grantId }, 'learning.authority'); }
          catch { throw new StorageError('forbidden'); }
        },
        recipientSuccessions: createModelRecipientRecovery(schoolRoot, service, spaces.authorizeConnection),
        async authorizeOrigin(actor, origin) {
          await spaces.authorize(actor);
          if (!permitAllowed) throw new StorageError('forbidden');
          await authority.assertSourceAuthorized({ sourceEnvironmentId: origin.service.environmentId, sourceServiceId: origin.service.serviceId,
            sourceInstallationId: origin.installationId, grantId: origin.grantId }, 'teaching.dependencies');
        }, assertWritable() {}, timeoutMs: 1000, pollIntervalMs: 5 });
      formalAuthority = createLearningAuthority(spaces, undefined, tasks, withModelOriginRecovery(schoolRoot, paired, rootModels));
      const rootOwner = createStorageRecoveryOwner({ storage: taskStorage, binding: taskBinding, migrations: modelMigrations, resources,
        installationId: rootEnvironment.installationId, validateService: () => rootModels.validate() });
      rootOwnedStorage = taskStorage;
      rootHost = await createProductRuntimeHost({ root: schoolRoot, createApplication: async () => ({ owners: [rootOwner],
        capabilities: { 'learning.authority': formalAuthority, 'teaching.dependencies': async () => ({ authorized: true }) },
        async handle(request, response) {
          if (request.url !== '/api/learning/access') return false;
          const identity = await spaces.authenticate(String(request.headers.authorization).slice(7), 'connection');
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ identity, target: await spaces.resolveBinding(identity) })); return true;
        } }) });
    }
    const agentGrant = await authority.authorize({ sourceEnvironmentId: agentService.environmentId, sourceServiceId: agentService.serviceId,
      sourceInstallationId: agentInstallation, capabilities: ['teaching.dependencies'] });
    async function clientFor(pg, installationId = randomUUID()) {
      const root = join(pg.root, 'recipient');
      const environment = { formatVersion: 1, environmentId: owner.environmentId, installationId,
        clientNamespace: 'recipient-' + installationId, profile: 'model', services: [modelService] };
      const local = { target: learningTarget, modelTarget };
      return { pg, root, environment, local, client: createSchoolClient(root, environment, local) };
    }
    async function connect(device) {
      const grant = await authority.authorize({ sourceEnvironmentId: owner.environmentId, sourceServiceId: owner.serviceId,
        sourceInstallationId: device.environment.installationId, capabilities: ['learning.authority'] });
      device.pair = { grantId: grant.grantId, installationId: device.environment.installationId };
      const memberConnectionId = rootRoute ? randomUUID() : connectionId;
      let memberGrant = { token: 'x'.repeat(80), identity, target: learningTarget, connectionId: memberConnectionId, capabilities: ['activity:read', 'activity:write'] };
      if (rootRoute) {
        const verifier = randomBytes(48).toString('base64url');
        await spaces.beginConnection({ requestId: memberConnectionId, clientId: randomUUID(), challenge: createHash('sha256').update(verifier).digest('base64url') });
        await spaces.approveConnection(login.token, memberConnectionId);
        memberGrant = { ...await spaces.exchangeConnection(memberConnectionId, verifier), target: learningTarget };
        device.rootBinding = await paired.bind(identity, { requestId: randomUUID(), expectedVersion: (await paired.readBinding(identity))?.version ?? 0,
          owner, installationId: device.environment.installationId, grantId: grant.grantId, connectionId: memberConnectionId });
      }
      await mkdir(join(device.root, 'credentials'), { recursive: true });
      await writeFile(join(device.root, 'credentials', 'transport'), grant.token);
      await writeFile(join(device.root, 'credentials', 'school-client-' + memberConnectionId), JSON.stringify({ requestId: memberConnectionId,
        schoolEndpoint: endpoint, verifier: 'fixture', clientId: randomUUID(), clientNamespace: device.environment.clientNamespace,
        grant: memberGrant,
        modelBinding: { runtimeConnectionId, target: modelTarget } }));
      await writeFile(join(device.root, 'installation.json'), JSON.stringify({ connections: [{ connectionId: runtimeConnectionId,
        sourceEnvironmentId: owner.environmentId, sourceServiceId: owner.serviceId, target: service,
        requiredCapabilities: ['learning.authority'], optionalCapabilities: [], credentialRef: 'transport' }] }));
    }
    async function openModels(device, storage) {
      device.storage = storage; storages.push(storage);
      device.models = await createModelGateway(storage, { holder: 'device', authorize: device.client.authorizeModel,
        authorizeDispatch: device.client.authorizeModelDispatch });
      device.local.models = device.models; gateways.push(device.models);
    }
    async function task(device, operation, record, args, authorityFields, taskId = randomUUID()) {
      const origin = { service: agentService, installationId: agentInstallation, grantId: agentGrant.grantId,
        identity, recoveryGeneration: device.environment.installationId, activityId: record.activityId,
        ...(authorityFields ? { authority: authorityFields } : {}) };
      if (rootRoute) {
        let settled = false, reply;
        const { identity: _identity, recoveryGeneration: _generation, ...context } = origin;
        const pending = paired.request({ identity, operation, args }, { ...context, operationId: taskId })
          .then(value => { reply = value; }, error => { reply = { ok: false, code: error.code }; }).finally(() => { settled = true; });
        while (!settled) {
          await device.client.pollModelTasks(() => true);
          if (!settled) await new Promise(resolve => setTimeout(resolve, 5));
        }
        await pending; return reply;
      }
      await tasks.enqueue(identity, device.pair, { taskId, ...(operation.startsWith('checks.') ? { attemptId: record.attemptId } : {}),
        operation: 'learning', formatVersion: 2, origin, request: { identity, operation, args } });
      await device.client.pollModelTasks(() => true);
      const result = await tasks.read(identity, device.pair, taskId);
      assert.ok(result.receipt, 'real school-client returns the original task receipt'); return result.receipt;
    }
    function manager(device, recoveryOwners) {
      const maintenance = createMaintenanceCoordinator({ requiredServiceIds: [owner.serviceId], record: async () => {} });
      for (const value of recoveryOwners) maintenance.register(value.participant);
      return createRecoveryManager({ root: device.root, environment: device.environment, maintenance,
        owners: recoveryOwners, requiredServiceIds: [owner.serviceId], ...(rootRoute ? { receiverIds: [rootEnvironment.environmentId + '/' + rootEnvironment.services[0].serviceId] } : {}) });
    }
    const source = await clientFor(sourcePg); await connect(source);
    source.binding = await provisionStorage({ admin: sourcePg.admin, owner, password: randomUUID(), migrations: modelMigrations });
    await openModels(source, await openStorage({ binding: source.binding, migrations: modelMigrations,
      backend: createFileBackend({ id: 'files', root: join(sourcePg.root, 'model-resources') }) }));
    const modelConnection = randomUUID();
    await source.models.save(identity, { requestId: randomUUID(), connectionId: modelConnection, expectedVersion: 0, name: 'Recipient recovery',
      protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions', modelId: 'fixture',
      dialect: 'standard', parameterMode: 'plain', enabled: true, credential: { action: 'replace', value: 'synthetic-recipient-key' } });
    if (rootRoute) {
      const modelGrantId = randomUUID();
      await source.models.selection.createGrant(identity, identity, { requestId: randomUUID(), grantId: modelGrantId, connectionId: modelConnection, owner: 'self' });
      await source.models.selection.save(identity, { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId: modelConnection, grantId: modelGrantId } });
      await source.client.pollModelTasks(() => true);
      await rootModels.selection.save(identity, { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId: modelConnection, grantId: modelGrantId } });
    }
    const records = [];
    for (const state of rootRoute ? ['accepted', 'completed', 'unknown'] : ['accepted', 'completed']) {
      const record = { state, attemptId: randomUUID(), segmentId: randomUUID(), activityId: randomUUID(), runId: randomUUID() };
      record.lease = { driverId: 'original-driver', generation: 1, runId: record.runId, activityId: record.activityId };
      assert.equal((await task(source, 'segments.create', record, [{ requestId: randomUUID(), segmentId: record.segmentId, purpose: 'learning',
        source: rootRoute ? { selected: true, selectionVersion: 1 } : { connectionId: modelConnection, version: 1 }, prefix: { system: '', tools: [] }, portable: [] }])).ok, true);
      record.input = { attemptId: record.attemptId, segmentId: record.segmentId, purpose: 'learning', expectedSequence: 0,
        input: { text: state === 'unknown' ? 'unknown-attempt' : state, images: [], toolResults: [] }, limits: { maxOutputTokens: 128, timeoutMs: state === 'unknown' ? 1000 : 30000 } };
      assert.equal((await task(source, 'checks.receive', record, [record.input], record.lease)).ok, true);
      if (state !== 'accepted') {
        assert.equal((await task(source, 'checks.dispatch', record, [record.attemptId], record.lease)).ok, true);
        await until(async () => (await source.models.checks.read(identity, record.attemptId)).state === state, 'SDK settles before backup');
      }
      record.original = await source.models.origins.read(identity, record.attemptId); records.push(record);
    }
    assert.equal(sends, rootRoute ? 2 : 1);
    let pendingReadId, originalPending, originalRoutes;
    if (rootRoute) {
      for (const item of records) assert.equal((await task(source, 'checks.read', item, [item.attemptId])).ok, true);
      pendingReadId = randomUUID();
      const item = records[0];
      await assert.rejects(paired.request({ identity, operation: 'checks.read', args: [item.attemptId] }, {
        operationId: pendingReadId, service: agentService, installationId: agentInstallation, grantId: agentGrant.grantId,
        activityId: item.activityId }), { code: 'unavailable' });
      originalPending = (await taskStorage.read('SELECT body FROM model_paired_requests WHERE id=$1', [pendingReadId])).rows[0].body;
      originalRoutes = (await taskStorage.read('SELECT scope,kind,id,body FROM model_paired_routes ORDER BY kind,id')).rows;
      assert.equal((await tasks.read(identity, source.pair, pendingReadId)).receipt, null);
    }
    const sourceOwner = createStorageRecoveryOwner({ storage: source.storage, binding: source.binding, migrations: modelMigrations, resources,
      installationId: source.environment.installationId, validateService: () => source.models.validate() });
    source.manager = manager(source, [sourceOwner]);
    async function restore(current, pg) {
      current.models.closeWrites(); await current.models.checks.drain();
      const key = randomBytes(32), directory = join(current.pg.root, 'backups');
      const manifest = await current.manager.backup({ directory, key, leaveClosed: true });
      const next = await clientFor(pg);
      const restored = await restoreRecoverySet({ backupDirectory: join(directory, manifest.backupId), targetRoot: next.root, key,
        targets: [createStorageRecoveryTarget({ owner, admin: async () => pg.admin, resources, migrations: modelMigrations,
          backend: createFileBackend({ id: 'files', root: join(pg.root, 'model-resources') }), installationId: next.environment.installationId,
          onRestored: async (storage, binding) => { next.binding = binding; await openModels(next, storage); },
          validateService: () => next.models.validate() })] });
      next.manager = manager(next, restored.owners);
      await authority.fenceSource({ sourceEnvironmentId: owner.environmentId, sourceServiceId: owner.serviceId,
        sourceInstallationId: current.environment.installationId });
      await connect(next);
      return next;
    }
    async function takeover(current, next) {
      const id = rootRoute ? rootEnvironment.environmentId + '/' + rootEnvironment.services[0].serviceId : '';
      const receivers = rootRoute ? [{ id, async fence(source, sourceServiceIds, binding) {
        const proof = await rootRuntime.recovery.fenceSource({ sourceEnvironmentId: source.environmentId,
          sourceServiceId: sourceServiceIds[0], sourceInstallationId: source.installationId, sourceServiceIds, ...binding });
        return { fenced: true, ...binding, receiverId: id, sourceEnvironmentId: source.environmentId,
          sourceInstallationId: source.installationId, sourceServiceIds, execution: proof.execution };
      } }] : [];
      await next.manager.takeover({ source: current.manager, receivers });
    }
    const target = await restore(source, targetPg);
    const stateFile = join(target.root, 'recovery-state.json');
    const isolated = JSON.parse(await readFile(stateFile, 'utf8'));
    let unrelatedBinding;
    if (rootRoute) {
      const unrelatedOwner = { environmentId: randomUUID(), serviceId: randomUUID() }, installationId = randomUUID();
      const grant = await authority.authorize({ sourceEnvironmentId: unrelatedOwner.environmentId, sourceServiceId: unrelatedOwner.serviceId,
        sourceInstallationId: installationId, capabilities: ['learning.authority'] });
      unrelatedBinding = await paired.bind(identity, { requestId: randomUUID(), expectedVersion: (await paired.readBinding(identity)).version,
        owner: unrelatedOwner, installationId, grantId: grant.grantId, connectionId: target.rootBinding.connectionId });
    }
    const record = records[0];
    // A real restored snapshot and a fresh WP01 grant still cannot bypass incomplete takeover.
    for (const phase of ['isolated', 'activating', 'active']) {
      await writeFile(stateFile, JSON.stringify({ ...isolated, phase }));
      assert.deepEqual(await task(target, 'checks.read', record, [record.attemptId]), { ok: false, code: rootRoute ? 'forbidden' : 'identity-conflict' });
    }
    await writeFile(stateFile, JSON.stringify(isolated));
    await takeover(source, target);
    const active = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(active.phase, 'active'); assert.equal(active.proof.targetInstallationId, target.environment.installationId);
    const malformed = [
      { ...active, phase: 'activating' },
      { ...active, proof: { ...active.proof, backupId: randomUUID() } },
      { ...active, proof: { ...active.proof, sourceInstallationId: randomUUID() } },
      { ...active, proof: { ...active.proof, targetInstallationId: randomUUID() } },
      { ...active, manifest: { ...active.manifest, source: { ...active.manifest.source, environmentId: randomUUID() } } },
      { ...active, manifest: { ...active.manifest, source: { ...active.manifest.source, services: [] } } },
      { ...active, manifest: { ...active.manifest, services: [] } },
    ];
    for (const value of malformed) {
      await writeFile(stateFile, JSON.stringify(value));
      assert.deepEqual(await task(target, 'checks.read', record, [record.attemptId]), { ok: false, code: 'identity-conflict' });
    }
    await rm(stateFile);
    assert.deepEqual(await task(target, 'checks.read', record, [record.attemptId]), { ok: false, code: 'identity-conflict' }, 'ordinary new installation has no recovery authority');
    await writeFile(stateFile, JSON.stringify(active));
    if (rootRoute) {
      assert.equal((await task(target, 'checks.read', record, [record.attemptId], undefined, pendingReadId)).ok, true);
      assert.deepEqual((await taskStorage.read('SELECT body FROM model_paired_requests WHERE id=$1', [pendingReadId])).rows[0].body, originalPending);
      assert.equal((await tasks.read(identity, source.pair, pendingReadId)).receipt, null, 'uncertain old task is not replayed or rewritten');
      const recoveries = (await taskStorage.read("SELECT body FROM model_paired_requests WHERE body->'recipientRecovery'->>'requestId'=$1", [pendingReadId])).rows;
      assert.equal(recoveries.length, 1);
      assert.deepEqual(recoveries[0].body.destination, originalPending.destination);
      assert.equal(recoveries[0].body.recipientRecovery.binding.installationId, target.environment.installationId);
      assert.equal(recoveries[0].body.recipientRecovery.successions.length, 1);
      assert.deepEqual(await tasks.pending(identity, { grantId: unrelatedBinding.grantId, installationId: unrelatedBinding.installationId }), [],
        'a different current logical model owner never receives the old attempt');
    }
    for (const item of records) {
      if (rootRoute) for (const operation of ['checks.progress', 'checks.summary', 'checks.requestPayload'])
        assert.equal((await task(target, operation, item, [item.attemptId])).ok, true, operation);
      const result = await task(target, 'checks.read', item, [item.attemptId]);
      assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.value.state, item.state);
      assert.deepEqual(await target.models.origins.read(identity, item.attemptId), item.original);
      for (const [operation, args] of [['checks.receive', [item.input]], ['checks.dispatch', [item.attemptId]]])
        assert.deepEqual(await task(target, operation, item, args, item.lease), { ok: false, code: rootRoute ? 'forbidden' : 'identity-conflict' });
      const { rows } = await target.storage.read('SELECT recipient_generation,recipient_proof FROM model_origin_authorizations WHERE association_id=$1 AND recipient_generation=$2',
        [item.attemptId, target.environment.installationId]);
      assert.equal(rows.length, 1); assert.deepEqual(rows[0].recipient_proof, { formatVersion: 1, backupId: active.manifest.backupId,
        modelOwner: owner, sourceInstallationId: source.environment.installationId, targetInstallationId: target.environment.installationId });
    }
    permitAllowed = false;
    assert.deepEqual(await task(target, 'checks.read', record, [record.attemptId]), { ok: false, code: 'forbidden' });
    permitAllowed = true;
    await target.models.validate();
    // Second real snapshot/takeover includes ancestor journals whose original generation is
    // older than this snapshot's source installation. Never rewrite that historical generation.
    const later = await restore(target, laterPg);
    await takeover(target, later);
    for (const item of records) {
      const result = await task(later, 'checks.read', item, [item.attemptId]);
      assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.value.state, item.state);
      assert.deepEqual(await later.models.origins.read(identity, item.attemptId), item.original);
      assert.equal((await task(later, 'checks.cancel', item, [item.attemptId])).ok, true);
    }
    assert.equal(sends, rootRoute ? 2 : 1, 'recipient restore never dispatches another SDK request');
    await later.models.validate();
    if (rootRoute) {
      assert.deepEqual((await taskStorage.read('SELECT scope,kind,id,body FROM model_paired_routes ORDER BY kind,id')).rows, originalRoutes);
      await rootModels.validate();
      // Revoking the replacement's member connection removes recovery access immediately.
      await spaces.revokeConnection(identity, later.rootBinding.connectionId);
      assert.deepEqual(await task(later, 'checks.read', record, [record.attemptId]), { ok: false, code: 'forbidden' });
    }
    await later.storage.request({ requestId: randomUUID(), fingerprint: 'corrupt-recipient-proof' }, async tx => {
      await tx.query('UPDATE model_origin_authorizations SET recipient_proof=$1 WHERE association_id=$2 AND recipient_generation=$3',
        [JSON.stringify({ formatVersion: 1, backupId: randomUUID(), modelOwner: { ...owner, serviceId: randomUUID() },
          sourceInstallationId: target.environment.installationId, targetInstallationId: later.environment.installationId }), record.attemptId, later.environment.installationId]);
      return null;
    });
    await assert.rejects(later.models.validate(), { code: 'corrupt' }, 'owner validation rejects recipient evidence for another model owner');
  } finally {
    for (const models of gateways) { models.closeWrites(); await models.checks.drain().catch(() => {}); }
    await rootHost?.stop();
    for (const storage of storages.reverse()) {
      if (rootHost && storage === rootOwnedStorage) continue;
      await storage.close();
    }
    upstream.closeAllConnections(); school.closeAllConnections();
    await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => school.close(resolve))]);
    await sourcePg.close(); await targetPg.close(); await laterPg.close();
  }
});
