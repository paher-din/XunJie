import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { createModelGateway, modelMigrations } from '@xunjie/model-gateway';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createConnectionAuthority } from '../dist/connections.js';
import { createSchoolClient } from '../dist/school-client.js';

test('paired V3 poll retains its source and checks the exact task permit freshly before Gateway receive and dispatch', { timeout: 60000 }, async t => {
  const pg = await nativeFixture(), root = join(pg.root, 'client'); let gateway, storage, school;
  const phases = []; let networkCalls = 0, permitChecks = 0, revoked = false, task;
  const upstream = createServer(async (request, response) => {
    for await (const _ of request) {} networkCalls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'paired reply' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let authority;
  const ownerHttp = createServer((request, response) => {
    void authority.handle(request, response).then(handled => { if (!handled) { response.writeHead(404); response.end(); } }).catch(() => response.destroy());
  });
  await new Promise(resolve => ownerHttp.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    gateway?.closeWrites(); await gateway?.checks.drain();
    for (const server of [upstream, ownerHttp]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await storage?.close(); await pg.close();
  });
  const localOwner = { environmentId: randomUUID(), serviceId: randomUUID() }, target = { ...localOwner, version: 1 };
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: 'Paired student' };
  const binding = await provisionStorage({ admin: pg.admin, owner: localOwner, password: randomUUID(), migrations: modelMigrations });
  storage = await openStorage({ binding, migrations: modelMigrations, backend: createFileBackend({ id: 'model', root: join(pg.root, 'models') }) });
  gateway = await createModelGateway(storage, { holder: 'device', authorize: async () => {},
    async authorizePermit(who, permit, context) {
      phases.push(context.phase);
      assert.equal(await school.authorizePermit(who, permit, context.attemptId, context.phase), true);
      await assert.rejects(school.authorizePermit(who, permit, randomUUID(), context.phase), { code: 'identity-conflict' });
    },
  });
  const modelConnectionId = randomUUID();
  await gateway.save(identity, { requestId: randomUUID(), connectionId: modelConnectionId, expectedVersion: 0, name: 'Paired fixture', protocol: 'chat-completions',
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions', modelId: 'fixture', dialect: 'standard', parameterMode: 'plain', enabled: true,
    credential: { action: 'replace', value: 'synthetic-paired-key' } });
  const sessionId = randomUUID(), attemptId = randomUUID(), segmentId = randomUUID(), installationId = randomUUID();
  const permit = { sessionId, runId: randomUUID(), stepId: randomUUID(), operationId: attemptId, generation: 3 };
  await gateway.segments.create(identity, { requestId: randomUUID(), segmentId, sessionId, purpose: 'learning', source: { connectionId: modelConnectionId, version: 1 },
    prefix: { system: 'paired', tools: [] }, portable: [] });
  const source = { environmentId: randomUUID(), serviceId: randomUUID() }, sourceInstallationId = randomUUID();
  const origin = { service: source, installationId: sourceInstallationId, grantId: randomUUID(), identity, recoveryGeneration: installationId, sessionId, authority: permit };
  const input = { attemptId, purpose: 'learning', segmentId, expectedSequence: 0, authority: { formatVersion: 1, permit },
    input: { text: 'paired question', images: [], toolResults: [] }, limits: { maxOutputTokens: 32, timeoutMs: 5000 } };
  task = { taskId: randomUUID(), attemptId, operation: 'learning', formatVersion: 3, origin,
    request: { identity, operation: 'checks.receive', args: [input] } };
  const receipts = [];
  const service = { environmentId: identity.environmentId, serviceId: randomUUID(), unit: 'space-course', protocolVersion: 1,
    endpoint: `http://127.0.0.1:${ownerHttp.address().port}`, capabilities: ['learning.authority'] };
  authority = createConnectionAuthority({ root: join(pg.root, 'authority'), service, handlers: { 'learning.authority': async value => {
    if (value.operation === 'modelAccess') return { identity, target };
    if (value.operation === 'pollModelTasks') return [task];
    if (value.operation === 'modelTaskPermit') {
      permitChecks++; if (revoked) return { error: 'forbidden' }; return { authorized: true };
    }
    if (value.operation === 'completeModelTask') { receipts.push(value.input.receipt); return { completed: true }; }
    throw new StorageError('invalid');
  } } });
  const granted = await authority.authorize({ sourceEnvironmentId: localOwner.environmentId, sourceServiceId: localOwner.serviceId,
    sourceInstallationId: installationId, capabilities: ['learning.authority'] });
  const connectionId = randomUUID(), runtimeConnectionId = randomUUID(); await mkdir(join(root, 'credentials'), { recursive: true });
  await writeFile(join(root, 'credentials', 'authority'), granted.token);
  await writeFile(join(root, 'installation.json'), JSON.stringify({ connections: [{ connectionId: runtimeConnectionId,
    sourceEnvironmentId: localOwner.environmentId, sourceServiceId: localOwner.serviceId, target: service,
    requiredCapabilities: ['learning.authority'], optionalCapabilities: [], credentialRef: 'authority' }] }));
  await writeFile(join(root, 'credentials', 'school-client-' + connectionId), JSON.stringify({ requestId: connectionId,
    schoolEndpoint: service.endpoint, verifier: 'fixture', clientId: randomUUID(), clientNamespace: 'v3', modelBinding: { runtimeConnectionId, target },
    grant: { token: 'fixture'.repeat(10), connectionId, identity, target, capabilities: ['activity:read', 'activity:write'] } }));
  school = createSchoolClient(root, { clientNamespace: 'v3', installationId, services: [] }, { target, models: gateway });
  await school.pollModelTasks(() => true);
  assert.equal(receipts[0]?.ok, true, JSON.stringify(receipts[0]));
  assert.ok(phases.includes('receive'));
  const retained = await gateway.origins.read(identity, attemptId);
  assert.equal(retained.formatVersion, 3); assert.deepEqual(retained.service, source); assert.equal(retained.installationId, sourceInstallationId);
  assert.equal(await school.authorizePermit(identity, permit, attemptId, 'dispatch'), false, 'outside task context root must use its directory');
  task = { ...task, taskId: randomUUID(), request: { identity, operation: 'checks.dispatch', args: [attemptId, { formatVersion: 1, permit }] } };
  const before = permitChecks;
  await school.pollModelTasks(() => true);
  assert.equal(receipts[1]?.ok, true, JSON.stringify(receipts[1]));
  const deadline = Date.now() + 5000;
  while ((await gateway.checks.read(identity, attemptId)).state === 'dispatched' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(networkCalls, 1); assert.ok(phases.includes('dispatch')); assert.ok(permitChecks > before);
  revoked = true;
  await school.pollModelTasks(() => true);
  assert.equal(receipts.at(-1)?.ok, false); assert.equal(networkCalls, 1);
  revoked = false;
  const originalRead = { ...origin }; delete originalRead.authority;
  task = { ...task, taskId: randomUUID(), origin: originalRead, request: { identity, operation: 'checks.read', args: [attemptId] } };
  await school.pollModelTasks(() => true);
  assert.equal(receipts.at(-1)?.ok, true, JSON.stringify(receipts.at(-1)));
  assert.equal(receipts.at(-1).value.attemptId, attemptId);
  assert.equal(networkCalls, 1, 'reading the original result needs no active dispatch permit and never sends again');
});
