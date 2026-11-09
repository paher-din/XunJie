import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { StorageError, provisionStorage, openStorage, createFileBackend } from '@xunjie/storage';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { aggregationPackage } from '../../../components/table-aggregation/package.mjs';

const isolated = process.env.XUNJIE_RECORD_DEPENDENCY_TEST_MODULES;
const load = (name, fallback) => import(isolated ? pathToFileURL(join(isolated, name + '.mjs')).href : fallback);
const { createLearningData, learningMigrations } = await load('data', '../../../packages/learning-space/dist/learning-data/index.js');
const { createActivityAgentRoutes } = await load('routes', '../../../packages/learning-space/dist/learning-data/agent-routes.js');
const { createTeachingDataService, createTeachingDataClient } = await load('data-deps', '../../../packages/learning-space/dist/teaching-agent/data-dependencies.js');
const { createTeachingDependencyService } = await load('deps', '../../../packages/learning-space/dist/teaching-agent/dependencies.js');
const { isTeachingDependencyRead } = await load('semantics', '../../../packages/learning-space/dist/teaching-agent/dependency-semantics.js');
const { createAgentConnection } = await load('agent-connection', '../../../packages/product-runtime/dist/agent-connections.js');
const { createConnectionAuthority } = await load('connections', '../../../packages/product-runtime/dist/connections.js');
const { createChunkChannel } = await load('chunks', '../../../packages/learning-space/dist/teaching-agent/chunk-channel.js');
const { anyExecutionActionSchema } = await load('execution', '../../../packages/contracts/dist/execution.js');
const { teachingDependencyCallSchema } = await load('wire', '../../../packages/contracts/dist/teaching-agent.js');
const sha = text => createHash('sha256').update(text).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => sha(JSON.stringify(canonical(value)));
const owner = () => ({ environmentId: randomUUID(), serviceId: randomUUID() });

test('school data execution uploads use the independent approved execution transport', { timeout: 90000 }, async t => {
  const pg = await nativeFixture(); t.after(() => pg.close());
  const root = await mkdtemp(join(tmpdir(), 'xj-record-dependencies-')); t.after(() => rm(root, { recursive: true, force: true }));
  const school = owner(), device = owner(), installationId = randomUUID(), agent = { ...device, serviceId: randomUUID() };
  const binding = await provisionStorage({ admin: pg.admin, owner: school, password: randomUUID(), migrations: learningMigrations });
  const backend = createFileBackend({ id: 'data', root: join(root, 'data') });
  let storage = await openStorage({ binding, migrations: learningMigrations, backend }); t.after(() => storage.close());
  const identity = { environmentId: school.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: 'Recorded execution student' };
  let memberActive = true, courseActive = true, writable = true, sourceReads = 0, assembled;
  const authorize = async actor => {
    if (!memberActive || ['environmentId', 'spaceId', 'principalId'].some(key => actor[key] !== identity[key])) throw new StorageError('forbidden');
  };
  const authority = { resolveBinding: async actor => { await authorize(actor); return { ...school, version: 1 }; } };
  const courses = { async authorize(actor) {
    await authorize(actor);
    if (!courseActive) throw new StorageError('forbidden');
  } };
  let learning = createLearningData(storage, authority, courses);
  const activity = await learning.create(identity, { requestId: randomUUID(), goal: 'Record source execution', question: '', references: [] });
  const { manifest } = await aggregationPackage();
  activity.course = { associationId: randomUUID(), courseId: randomUUID(), courseName: 'Source evidence', taskId: randomUUID(), taskTitle: 'Aggregate',
    releaseId: randomUUID(), contentDigest: 'a'.repeat(64), objectives: ['Cite original output'], requirements: 'Use original evidence',
    materials: [], starterWorks: [], capabilities: [], components: [{ key: 'table', definition: { manifest, digest: hash(manifest) },
      configuration: { title: 'Original table' }, materialIds: [] }], helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } };
  await storage.request({ requestId: randomUUID(), fingerprint: 'fixed-course' }, async tx => {
    await tx.query('UPDATE activities SET body=$2 WHERE id=$1', [activity.activityId, JSON.stringify(activity)]); return null;
  });
  const context = new AsyncLocalStorage();
  let approved;
  function assemble() {
    const dataRequest = createTeachingDataService({ learning, courses: {}, async assertWritable() {
      if (!writable) throw new StorageError('maintenance');
    }, async executionSource() { sourceReads++; return { source: context.getStore(), binding: approved }; } });
    assembled = createTeachingDependencyService({ authorize, activity: learning.open, dataRequest,
      tools: new Proxy({}, { get() { return () => { throw new Error('Uploads must never invoke execution tools'); }; } }) });
  }
  assemble();
  const chunks = () => createChunkChannel(storage).wrap(async (payload, source) => {
    try { return await context.run(source, () => assembled(payload)); }
    catch (error) { return { error: error instanceof StorageError ? error.code : 'invalid' }; }
  }, { readOnly: input => isTeachingDependencyRead(teachingDependencyCallSchema.parse(input)),
    authorize: async (input, source) => { await source.assertAuthorized(); await authorize(teachingDependencyCallSchema.parse(input).identity); } });
  const tasks = new Set(); let authorityHost;
  const server = createServer((request, response) => {
    const task = authorityHost.handle(request, response).then(handled => { if (!handled) { response.writeHead(404); response.end(); } });
    tasks.add(task); void task.finally(() => tasks.delete(task));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); await Promise.allSettled(tasks); });
  const service = { ...school, unit: 'learning-data', endpoint: `http://127.0.0.1:${server.address().port}`, protocolVersion: 1,
    capabilities: ['teaching.dependencies'] };
  authorityHost = createConnectionAuthority({ root: join(root, 'school'), service, handlers: { 'teaching.dependencies': async (input, source) => {
    try { return await chunks()(input, source); }
    catch (error) { return { error: error instanceof StorageError ? error.code : 'invalid' }; }
  } } });
  const grant = await authorityHost.authorize({ sourceEnvironmentId: device.environmentId, sourceServiceId: device.serviceId,
    sourceInstallationId: installationId, capabilities: ['teaching.dependencies'] });
  const agentGrant = await authorityHost.authorize({ sourceEnvironmentId: agent.environmentId, sourceServiceId: agent.serviceId,
    sourceInstallationId: installationId, capabilities: ['teaching.dependencies'] });
  const module = (who, unit) => ({ ...who, unit, endpoint: 'http://127.0.0.1:1', protocolVersion: 1, capabilities: [] });
  approved = { version: 1, connectionId: randomUUID(), target: module(agent, 'teaching-agent'), installationId,
    delivery: 'client', grantId: agentGrant.grantId, executionGrantId: grant.grantId,
    deviceModules: [module(agent, 'teaching-agent'), module(device, 'tool-execution')] };
  const originalBinding = structuredClone(approved);
  async function client(source, token, suffix) {
    const directory = join(root, suffix); await mkdir(join(directory, 'credentials'), { recursive: true });
    const connection = { connectionId: randomUUID(), sourceEnvironmentId: source.environmentId, sourceServiceId: source.serviceId,
      target: service, credentialRef: 'upload', requiredCapabilities: ['teaching.dependencies'], optionalCapabilities: [] };
    await writeFile(join(directory, 'credentials/upload'), token, { mode: 0o600 });
    await writeFile(join(directory, 'installation.json'), JSON.stringify({ connections: [connection] }), { mode: 0o600 });
    await writeFile(join(directory, 'environment.json'), JSON.stringify({ installationId }), { mode: 0o600 });
    const invoke = createAgentConnection(directory, connection.connectionId, 'teaching.dependencies');
    return { ...createTeachingDataClient(invoke), invoke };
  }
  const execution = await client(device, grant.token, 'execution');
  const impersonator = await client(agent, agentGrant.token, 'agent');
  function event() {
    const requestId = randomUUID(), executionRef = randomUUID(), definition = activity.course.components[0].definition;
    const action = anyExecutionActionSchema.parse({ protocolVersion: 2, kind: 'execution', requestId,
      scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId: activity.activityId },
      receiver: { receiverId: 'browser-execution', location: 'local', kind: 'execution' }, execution: {
        instance: { instanceId: activity.activityId+':table', key: 'table', componentId: manifest.componentId, componentVersion: manifest.version,
          definitionDigest: definition.digest, hostApiVersion: 1, stateVersion: manifest.stateVersion },
        operation: { operationId: 'aggregate', effect: 'execute' }, parameters: { aggregate: 'mean', groupColumn: '小组', valueColumn: '得分' },
        basis: { works: [], state: null, expected: { stateContentId: null }, resources: [{ kind: 'entry', ...manifest.entry }, { kind: 'algorithm', ...manifest.algorithm.resource }] },
        limits: { timeMs: 5000, memoryPages: 256, inputBytes: 1048576, outputBytes: 65536, concurrentJobs: 1, queuedJobs: 4 },
        plan: { planId: 'browser-job', planVersion: 1, planDigest: hash({ planId: 'browser-job', planVersion: 1,
          componentId: manifest.componentId, componentVersion: manifest.version, operationId: 'aggregate' }), location: 'browser', kind: 'job' },
        initiator: { kind: 'student', principalId: identity.principalId } } });
    const actionText = JSON.stringify(action), inputDigest = sha(actionText);
    return { version: 1, kind: 'command', sourceOwner: device, installationId, requestId, inputDigest, executionRef, actionText,
      reception: { kind: 'browser', acceptance: { receipt: { requestId, inputDigest, receiver: action.receiver, state: 'accepted', receiptId: requestId, detail: '' },
        execution: { executionRef, acceptedSeq: 1 } } }, query: { requestId, inputDigest, executionRef, scope: action.scope,
        state: 'queued', statusKnowledge: 'confirmed', confirmedSeq: 1, stopRequested: false, reason: null, output: null }, createdAt: new Date().toISOString() };
  }
  const upload = e => execution.recordExecution(identity, activity.activityId, e);
  const common = e => Object.fromEntries(['version', 'sourceOwner', 'installationId', 'requestId', 'inputDigest', 'executionRef'].map(key => [key, e[key]]));

  await t.test('real effect transport separates successive statuses for one request and recovers duplicate uploads', async () => {
    assert.equal(learningMigrations.at(-1).version, 28);
    const command = event(); await upload(command);
    for (const [state, confirmedSeq] of [['running', 2], ['paused', 3], ['running', 4], ['succeeded', 5]]) {
      const status = { ...common(command), kind: 'status', query: { ...command.query, state, confirmedSeq } };
      const first = await upload(status); assert.equal(first.query.state, state); assert.equal(first.query.confirmedSeq, confirmedSeq);
      assert.deepEqual(await upload(status), first);
    }
    const copy = await learning.executionRecords.read(identity, activity.activityId, command.requestId);
    assert.equal(copy.query.state, 'succeeded'); assert.deepEqual(copy.sourceOwner, device);
    await storage.close(); storage = await openStorage({ binding, migrations: learningMigrations, backend });
    learning = createLearningData(storage, authority, courses); assemble();
    assert.equal((await learning.executionRecords.history(identity, activity.activityId)).entries[0].query.state, 'succeeded');
    await learning.validate();
  });

  await t.test('withdrawn course access blocks normal routes but preserves cleanup only for the original scope', async () => {
    let routes = createActivityAgentRoutes(storage, learning.open);
    const pinned = await routes.resolve(identity, activity.activityId, async () => structuredClone(originalBinding));
    assert.deepEqual(await routes.read(identity, activity.activityId), pinned);
    // Recreate the reader so cleanup must recover the persisted route, not an in-memory binding.
    routes = createActivityAgentRoutes(storage, learning.open);
    courseActive = false;
    try {
      await assert.rejects(routes.read(identity, activity.activityId), { code: 'forbidden' });
      assert.deepEqual(await routes.readForCleanup(identity, activity.activityId), pinned);
      for (const field of ['environmentId', 'spaceId', 'principalId']) {
        await assert.rejects(routes.readForCleanup({ ...identity, [field]: randomUUID() }, activity.activityId),
          { code: 'forbidden' }, field);
      }
    } finally {
      courseActive = true;
    }
    assert.deepEqual(await routes.read(identity, activity.activityId), pinned);
  });

  await t.test('Agent grant, wrong owner/installation/unit and unapproved execution grants cannot upload', async () => {
    await assert.rejects(impersonator.recordExecution(identity, activity.activityId, event()), { code: 'forbidden' });
    for (const change of [{ installationId: randomUUID() }, { sourceOwner: { ...device, serviceId: randomUUID() } }])
      await assert.rejects(upload({ ...event(), ...change }), { code: 'forbidden' });
    for (const change of [b => { b.executionGrantId = randomUUID(); }, b => { b.deviceModules[1].unit = 'model-connection'; },
      b => { b.installationId = randomUUID(); }, b => { b.deviceModules.push(b.deviceModules[1]); },
      b => { b.delivery = 'service'; }, b => { b.deviceModules[1].environmentId = randomUUID(); }]) {
      approved = structuredClone(originalBinding); change(approved);
      await assert.rejects(upload(event()), { code: 'forbidden' });
    }
    approved = structuredClone(originalBinding);
  });

  await t.test('fixed event digest and live actor/write gates are checked before persistence', async () => {
    const command = event();
    await assert.rejects(execution.invoke({ version: 1, operation: 'execution.record', identity, activityId: activity.activityId,
      args: [command, '0'.repeat(64)] }), { code: 'identity-conflict' });
    writable = false; await assert.rejects(upload(event()), { code: 'maintenance' }); writable = true;
    memberActive = false; await assert.rejects(upload(event()), { code: 'forbidden' }); memberActive = true;
    await assert.rejects(execution.recordExecution(identity, randomUUID(), event()), { code: 'missing' });
    await assert.rejects(execution.recordExecution({ ...identity, principalId: randomUUID() }, activity.activityId, event()), { code: 'forbidden' });
  });

  await t.test('revoked execution transport cannot reuse an acknowledged result, while school history stays readable offline', async () => {
    const command = event(); await upload(command); const reads = sourceReads;
    await authorityHost.revoke(grant.grantId);
    await assert.rejects(upload(command), { code: 'forbidden' });
    assert.ok(await learning.executionRecords.read(identity, activity.activityId, command.requestId));
    assert.equal(sourceReads, reads);
  });
});

test('execution service operations authorize before dispatch and use the requested read/effect classification', async () => {
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: 'Student' };
  const input = { version: 1, operation: 'execution', identity, activityId: randomUUID(), args: ['read', randomUUID()] };
  let authorized = false, active = true, calls = 0;
  const options = { async authorize() { if (!active) throw new StorageError('forbidden'); authorized = true; },
    async identityFor() { return identity; }, async activity() {}, tools: {}, async executionRequest(value) {
      assert.equal(authorized, true); calls++; return value.args[0];
    } };
  const service = createTeachingDependencyService(options);
  assert.equal(await service(input), 'read'); assert.equal(calls, 1);
  active = false; await assert.rejects(service(input), { code: 'forbidden' }); assert.equal(calls, 1);
  await assert.rejects(createTeachingDependencyService({ ...options, async authorize() {}, executionRequest: undefined })(input), { code: 'unavailable' });
  for (const method of ['read', 'artifact', 'controlReceipt', 'agent.read', 'agent.original', 'agent.status', 'agent.cleanupStatus'])
    assert.equal(isTeachingDependencyRead({ ...input, args: [method] }), true, method);
  for (const method of ['accept', 'control', 'stop', 'agent.dispatch', 'agent.cleanup', 'unknown'])
    assert.equal(isTeachingDependencyRead({ ...input, args: [method] }), false, method);
  assert.equal(isTeachingDependencyRead({ ...input, operation: 'execution.record' }), false);
  assert.equal(teachingDependencyCallSchema.safeParse({ ...input, operation: 'execution.record', args: [{}] }).success, false);
});
