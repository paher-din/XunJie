import './model-cleanup-source-loader.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { provisionStorage, openStorage, createFileBackend, StorageError, prepareStorageRestore, finalizeStorageRestore } from '@xunjie/storage';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
const { createModelGateway, modelMigrations } = await import('../../../packages/learning-space/dist/model-connections/index.js');

test('origin ownership survives owner reopen and independent backup restore without pinning a dispatch lease', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture(), target = await nativeFixture(); let storage, restored;
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations: modelMigrations });
    const backend = createFileBackend({ id: 'files', root: fixture.root + '/objects' });
    storage = await openStorage({ binding, backend, migrations: modelMigrations });
    let allowed = true;
    let models = await createModelGateway(storage, { authorize: async () => { if (!allowed) throw new StorageError('forbidden'); } });
    const identity = { ...owner, spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '学校' }; delete identity.serviceId;
    const attemptId = randomUUID(), runId = randomUUID(), activityId = randomUUID();
    const origin = { formatVersion: 2, service: { environmentId: randomUUID(), serviceId: randomUUID() }, installationId: randomUUID(), grantId: randomUUID(),
      identity, recoveryGeneration: randomUUID(), attemptId, authority: { runId, activityId, driverId: 'old', generation: 1 } };
    await models.origins.bind(identity, attemptId, origin);
    await storage.close(); storage = await openStorage({ binding, backend, migrations: modelMigrations });
    models = await createModelGateway(storage, { authorize: async () => { if (!allowed) throw new StorageError('forbidden'); } });
    const next = { ...origin, authority: { ...origin.authority, driverId: 'new', generation: 2 } };
    await models.origins.bind(identity, attemptId, next);
    allowed = false;
    await models.origins.assert(identity, attemptId, next);
    await assert.rejects(models.origins.assert(identity, attemptId, { ...next, authority: { ...next.authority, runId: randomUUID() } }), { code: 'identity-conflict' });
    await assert.rejects(models.origins.assert({ ...identity, principalId: randomUUID() }, attemptId, next), { code: 'missing' });
    await models.validate();
    // Snapshot the actual schema/resources into an independent PostgreSQL instance.
    models.closeWrites(); await models.checks.drain();
    await storage.participant().closeWrites(); await storage.participant().closeDispatch();
    const targetBackend = createFileBackend({ id: 'files', root: target.root + '/objects' });
    const dump = fixture.root + '/model.dump'; let manifest;
    const pgTool = async (host, name, args) => {
      try {
        await promisify(execFile)(host.tool(name), ['-h', host.admin.host, '-p', String(host.admin.port), '-U', host.admin.user,
          '-d', host.admin.database, ...args], { env: { ...process.env, PGPASSWORD: host.admin.password }, timeout: 30000 });
      } catch { throw new Error(name + ' failed'); }
    };
    await storage.snapshot('origin-backup', async snapshot => {
      manifest = snapshot.manifest; assert.equal(manifest.schemaVersion, modelMigrations.at(-1).version);
      await pgTool(fixture, 'pg_dump', ['-Fc', '-n', binding.schema, '--snapshot', snapshot.databaseSnapshot, '-f', dump]);
      for (const item of manifest.resources) await targetBackend.put(item.locator.key, await storage.readResourceObject(item.resourceId));
    });
    const destination = await prepareStorageRestore({ admin: target.admin, owner, password: randomUUID() });
    await pgTool(target, 'pg_restore', ['--exit-on-error', '--role', destination.migratorRole, '--no-owner', '--no-acl', dump]);
    restored = await finalizeStorageRestore({ admin: target.admin, binding: destination, migrations: modelMigrations, manifest, backend: targetBackend });
    const recovered = await createModelGateway(restored, { authorize: async () => { throw new StorageError('forbidden'); } });
    await recovered.origins.assert(identity, attemptId, next);
    await assert.rejects(recovered.origins.assert(identity, attemptId, { ...next, installationId: randomUUID() }), { code: 'identity-conflict' });
    await recovered.validate();
  } finally { await restored?.close(); await storage?.close(); await fixture.close(); await target.close(); }
});

for (const revoked of ['agentGrant', 'deviceConnection', 'activityAccess', 'lateVerdict', 'fastCompletion', 'trustedCleanup']) test(`a sent SDK request is durably cancelled when ${revoked} is revoked, even with cached admission`, { timeout: 60000 }, async () => {
  const fixture = await nativeFixture(); let storage; let models;
  const started = Promise.withResolvers(), disconnected = Promise.withResolvers(); let sends = 0;
  const checkEntered = Promise.withResolvers(), releaseCheck = Promise.withResolvers(); let finishSdk;
  const upstream = createServer(async (request, response) => {
    for await (const _ of request) { /* actual SDK request */ }
    sends++; response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"index":0,"delta":{"content":"尚未结束"},"finish_reason":null}]}\n\n');
    response.on('close', () => disconnected.resolve());
    finishSdk = () => response.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    started.resolve();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations: modelMigrations });
    storage = await openStorage({ binding, migrations: modelMigrations, backend: createFileBackend({ id: 'files', root: fixture.root + '/objects' }) });
    const identity = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '学校' };
    const scope = { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId };
    const rights = { agentGrant: true, deviceConnection: true, activityAccess: true }; let denyPublic = false; let freshChecks = 0;
    models = await createModelGateway(storage, { holder: 'device', authorizeDispatch: async () => {}, authorize: async () => { if (denyPublic) throw new StorageError('forbidden'); },
      authorizeActive: async (actor, attemptId) => {
        assert.equal(actor.principalId, identity.principalId); assert.equal(attemptId, id); freshChecks++;
        if (revoked === 'lateVerdict') { checkEntered.resolve(); await releaseCheck.promise; }
        if (!rights.agentGrant || !rights.deviceConnection || !rights.activityAccess) throw new StorageError('forbidden');
      }, authorizationPollMs: revoked === 'fastCompletion' ? 60000 : 20 });
    const connectionId = randomUUID(), segmentId = randomUUID(), id = randomUUID();
    await models.save(identity, { requestId: randomUUID(), connectionId, expectedVersion: 0, name: '受限调用', protocol: 'chat-completions',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions', modelId: 'fixture', dialect: 'standard', parameterMode: 'plain', enabled: true,
      credential: { action: 'replace', value: 'synthetic-key' } });
    await models.segments.create(identity, { requestId: randomUUID(), segmentId, purpose: 'learning', source: { connectionId, version: 1 }, prefix: { system: '', tools: [] }, portable: [] });
    await models.checks.receive(identity, { attemptId: id, segmentId, purpose: 'learning', expectedSequence: 0,
      input: { text: '不能失权后继续', images: [], toolResults: [] }, limits: { maxOutputTokens: 128, timeoutMs: 30000 } });
    await models.checks.dispatch(identity, id); await started.promise;
    await assert.rejects(models.checks.cleanup.cancel({ ...scope, principalId: randomUUID() }, id), { code: 'missing' });
    if (revoked === 'lateVerdict') {
      await checkEntered.promise; rights.agentGrant = false; finishSdk();
      // Let the SDK finish while its original, fresh permit is still unresolved.
      await new Promise(resolve => setTimeout(resolve, 50)); releaseCheck.resolve();
    } else if (revoked === 'fastCompletion') {
      rights.agentGrant = false; finishSdk();
    } else if (revoked === 'trustedCleanup') {
      denyPublic = true;
      const stopping = await models.checks.cleanup.cancel(scope, id);
      assert.equal(stopping.cancelRequested, true);
    } else rights[revoked] = false;
    const until = Date.now() + 5000; let status;
    do {
      status = await models.checks.cleanup.status(scope, id);
      if (status.cancelRequested && status.physicalRequestEnded) break;
      assert.ok(Date.now() < until, 'revocation must stop the original SDK request');
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (true);
    await disconnected.promise;
    assert.equal(status.state, 'cancelled');
    if (revoked !== 'trustedCleanup') assert.ok(freshChecks > 0);
    assert.equal(sends, 1);
    assert.deepEqual(Object.keys(status).sort(), ['attemptId', 'cancelRequested', 'dispatched', 'physicalRequestEnded', 'state']);
    denyPublic = true;
    await assert.rejects(models.checks.read(identity, id), { code: 'forbidden' });
    assert.deepEqual(await models.checks.cleanup.cancel(scope, id), status);
    assert.deepEqual(await models.checks.cleanup.status(scope, id), status);
    denyPublic = false;
    const archived = await models.checks.read(identity, id);
    assert.equal(archived.attemptId, id); assert.equal(archived.cancelRequested, true); assert.equal(archived.state, 'cancelled'); assert.ok(archived.resultRef);
    await models.validate(); assert.equal(sends, 1);
  } finally {
    releaseCheck.resolve(); models?.closeWrites(); await models?.checks.drain(); await storage?.close();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await fixture.close();
  }
});
