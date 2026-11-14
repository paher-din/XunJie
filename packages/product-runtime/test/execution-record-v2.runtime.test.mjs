import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { createSpaces, createCourses, createLearningData, createMemberAgentBindings, learningMigrations, spaceCourseMigrations } from '@xunjie/learning-space';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { aggregationPackage } from '../../../components/table-aggregation/package.mjs';
import { canonicalDigest } from '@xunjie/storage/identity';
import { anyExecutionActionSchema } from '@xunjie/contracts/execution';
import { createChunkClient } from '@xunjie/storage/chunk-channel';

// Read these edited modules directly; no shared build, emitted JS or substituted owner implementation.
const root = new URL('../../../', import.meta.url);
const edited = new Map(['packages/contracts/src/agent-dependencies.ts', 'packages/agents/src/transport/session-dependencies.ts',
  'packages/product-runtime/src/school-device-setup.ts', 'packages/product-runtime/src/school-client.ts',
  'packages/product-runtime/src/agent-connections.ts', 'packages/product-runtime/src/agent-transfer-journal.ts'].map(file => [
  new URL(file.replace('/src/', '/dist/').replace(/\.ts$/, '.js'), root).href, new URL(file, root).href]));
registerHooks({ resolve(specifier, context, next) {
  const candidate = specifier.startsWith('.') ? new URL(specifier, context.parentURL).href : specifier;
  if (edited.has(candidate)) return { url: edited.get(candidate), format: 'module-typescript', shortCircuit: true };
  if (candidate.startsWith(root.href) && candidate.includes('/src/') && candidate.endsWith('.js')) {
    const built = candidate.replace('/src/', '/dist/');
    return { url: edited.get(built) ?? built, ...(edited.has(built) ? { format: 'module-typescript' } : {}), shortCircuit: true };
  }
  const resolved = next(specifier, context);
  return edited.has(resolved.url) ? { ...resolved, url: edited.get(resolved.url), format: 'module-typescript' } : resolved;
} });
const { createAgentDependencyChannel } = await import('../../agents/src/transport/session-dependencies.ts');

const sha = value => createHash('sha256').update(value).digest('hex');
const common = event => Object.fromEntries(['version', 'sourceOwner', 'installationId', 'requestId', 'inputDigest', 'executionRef'].map(key => [key, event[key]]));

async function fixture(t) {
  const pg = await nativeFixture(), handles = [], cleanups = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); for (const storage of handles.reverse()) await storage.close(); await pg.close(); });
  async function open(name, migrations) {
    const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID(), migrations });
    const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: name, root: join(pg.root, name) }) });
    handles.push(storage); return storage;
  }
  const space = await open('spaces', spaceCourseMigrations), data = await open('data', learningMigrations);
  const spaces = createSpaces(space), courses = createCourses(space, spaces);
  const password = randomUUID();
  const identity = await spaces.createMember({ requestId: randomUUID(), loginName: 'execution-record', password });
  await spaces.bindMember(identity, { ...data.owner, version: 1 });
  const learning = createLearningData(data, spaces, courses);
  const definition = await courses.components.register({ requestId: randomUUID(), ...await aggregationPackage() });
  const manifest = definition.manifest, courseId = randomUUID(), releaseId = randomUUID();
  await courses.registerRelease({ formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '真实原执行记录' },
    task: { taskId: randomUUID(), title: '原计算', summary: '' }, release: { releaseId, objectives: ['保留原事实'], requirements: '真实原命令',
      starterWorks: [], capabilities: [], materials: [], components: [{ key: 'table', definition, configuration: { title: '原计算' }, materialIds: [] }],
      helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } }, resources: [] });
  await courses.setAccess({ requestId: randomUUID(), courseId, principalId: identity.principalId, active: true });
  const activity = await learning.createCourse(identity, { requestId: randomUUID(), releaseId });
  const device = { environmentId: randomUUID(), serviceId: randomUUID() }, installationId = randomUUID();
  const source = { grantId: randomUUID(), sourceEnvironmentId: device.environmentId, sourceServiceId: device.serviceId,
    sourceInstallationId: installationId, async assertAuthorized() {} };
  function command() {
    const requestId = randomUUID(), executionRef = randomUUID();
    const action = anyExecutionActionSchema.parse({ protocolVersion: 2, kind: 'execution', requestId,
      scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId: activity.activityId },
      receiver: { receiverId: 'browser-execution', location: 'local', kind: 'execution' }, execution: {
        instance: { instanceId: activity.activityId + ':table', key: 'table', componentId: manifest.componentId, componentVersion: manifest.version,
          definitionDigest: definition.digest, hostApiVersion: 1, stateVersion: manifest.stateVersion },
        operation: { operationId: 'aggregate', effect: 'execute' }, parameters: { aggregate: 'mean', groupColumn: '小组', valueColumn: '得分' },
        basis: { works: [], state: null, expected: { stateContentId: null }, resources: [{ kind: 'entry', ...manifest.entry }, { kind: 'algorithm', ...manifest.algorithm.resource }] },
        limits: { timeMs: 5000, memoryPages: 256, inputBytes: 1048576, outputBytes: 65536, concurrentJobs: 1, queuedJobs: 4 },
        plan: { planId: 'browser-job', planVersion: 1, planDigest: canonicalDigest({ planId: 'browser-job', planVersion: 1,
          componentId: manifest.componentId, componentVersion: manifest.version, operationId: 'aggregate' }), location: 'browser', kind: 'job' },
        initiator: { kind: 'student', principalId: identity.principalId } } });
    const actionText = JSON.stringify(action), inputDigest = sha(actionText);
    return { version: 1, kind: 'command', sourceOwner: device, installationId, requestId, inputDigest, executionRef, actionText,
      reception: { kind: 'browser', acceptance: { receipt: { requestId, inputDigest, receiver: action.receiver, state: 'accepted', receiptId: requestId, detail: '' },
        execution: { executionRef, acceptedSeq: 1 } } }, query: { requestId, inputDigest, executionRef, scope: action.scope,
        state: 'queued', statusKnowledge: 'confirmed', confirmedSeq: 1, stopRequested: false, reason: null, output: null }, createdAt: new Date().toISOString() };
  }
  return { pg, space, data, spaces, courses, identity, activity, learning, device, installationId, source, command, password, open, beforeClose: cleanup => cleanups.push(cleanup) };
}

test('v2 execution publication retains original facts after lost replies and never dispatches a receiving command', { timeout: 60000 }, async t => {
  const f = await fixture(t); let allowed = true, loseReply = true;
  const trusted = { sourceOwner: f.device, installationId: f.installationId, role: 'tool-execution' };
  const channel = createAgentDependencyChannel(f.data, { learning: f.learning, courses: f.courses,
    sessions: { async read() { assert.fail('Execution facts must not require an Agent session.'); } },
    async authorize(who, source) { await source.assertAuthorized(); await f.spaces.authorize(who); },
    async assertDispatch() { assert.fail('Settled original facts must not require a live Agent permit.'); },
    async executionRecordSource(who, id, event, source) {
      assert.equal(id, f.activity.activityId); assert.deepEqual(who, f.identity);
      if (!allowed || source.sourceServiceId !== f.device.serviceId || event.installationId !== f.installationId) throw new StorageError('forbidden');
      return trusted;
    },
  });
  const send = createChunkClient(async value => {
    const result = await channel.handle(value, f.source);
    if (value.operation === 'invoke' && loseReply) { loseReply = false; throw new StorageError('unavailable'); }
    return result;
  });
  const original = f.command(), call = event => ({ version: 2, operation: 'execution.record', identity: f.identity,
    args: { activityId: f.activity.activityId, event } });
  const transferId = randomUUID();
  await assert.rejects(send(call(original), { transferId, durable: true }), { code: 'unavailable' });
  assert.equal(await send(call(original), { transferId, durable: true }), null);
  const terminal = { ...common(original), kind: 'status', query: { ...original.query, state: 'succeeded', confirmedSeq: 2 } };
  assert.equal(await send(call(terminal), { durable: true }), null);
  assert.equal(await send(call(terminal), { durable: true }), null);
  const record = await f.learning.executionRecords.read(f.identity, f.activity.activityId, original.requestId);
  assert.equal(record.executionRef, original.executionRef); assert.equal(record.query.state, 'succeeded');
  assert.deepEqual(record.sourceOwner, f.device);
  assert.equal((await f.learning.executions.history(f.identity, f.activity.activityId)).entries.length, 0,
    'Received facts never become commands in the data owner.');
  allowed = false;
  await assert.rejects(send(call(original), { transferId, durable: true }), { code: 'forbidden' });
  allowed = true;
  const spoofed = f.command(); spoofed.sourceOwner.serviceId = randomUUID();
  await assert.rejects(send(call(spoofed), { durable: true }), { code: 'forbidden' });
  await assert.rejects(send({ ...call(f.command()), version: 1 }, { durable: true }), { code: 'incompatible' });
  await f.learning.validate();
});


test('school record authority keeps the original executor and requires proved installation succession', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const { createSchoolExecutionRecordSource } = await import('../src/school-device-setup.ts');
  const { retireInstallation } = await import('../dist/retired-installations.js');
  const { recordRecoverySuccession } = await import('../dist/recovery-successions.js');
  const login = await f.spaces.login('execution-record', f.password), connectionId = randomUUID(), verifier = randomUUID() + randomUUID();
  await f.spaces.beginConnection({ requestId: connectionId, clientId: randomUUID(),
    challenge: createHash('sha256').update(verifier).digest('base64url') });
  await f.spaces.approveConnection(login.token, connectionId); await f.spaces.exchangeConnection(connectionId, verifier);
  const bindings = createMemberAgentBindings(f.space, f.spaces.authorize);
  const module = (unit, serviceId) => ({ environmentId: f.device.environmentId, serviceId, unit,
    endpoint: 'http://127.0.0.1:1', protocolVersion: 1, capabilities: unit === 'teaching-agent' ? ['agent.sessions.v2'] : [] });
  const binding = { requestId: randomUUID(), identity: f.identity, connectionId,
    target: module('teaching-agent', randomUUID()), installationId: f.installationId, delivery: 'client',
    executionGrantId: f.source.grantId, deviceModules: [module('tool-execution', f.device.serviceId)] };
  await bindings.bind(binding);
  const authority = createSchoolExecutionRecordSource({ root: f.pg.root, spaces: f.spaces, bindings });
  const event = f.command();
  const original = await authority(f.identity, f.activity.activityId, event, f.source);
  assert.deepEqual(original.sourceOwner, f.device); assert.equal(original.installationId, f.installationId);
  for (const source of [{ ...f.source, sourceServiceId: binding.target.serviceId }, { ...f.source, grantId: randomUUID() },
    { ...f.source, sourceInstallationId: randomUUID() }])
    await assert.rejects(authority(f.identity, f.activity.activityId, event, source), { code: 'forbidden' });
  await assert.rejects(authority(f.identity, f.activity.activityId, { ...event, installationId: randomUUID() }, f.source), { code: 'forbidden' });
  const nextInstallationId = randomUUID(), recovered = { ...f.source, grantId: randomUUID(), sourceInstallationId: nextInstallationId };
  await retireInstallation(f.pg.root, f.installationId);
  await recordRecoverySuccession(f.pg.root, { formatVersion: 1, backupId: randomUUID(), sourceEnvironmentId: f.device.environmentId,
    sourceServiceId: f.device.serviceId, sourceInstallationId: f.installationId, targetInstallationId: nextInstallationId });
  const retained = await authority(f.identity, f.activity.activityId, event, recovered);
  assert.equal(retained.installationId, f.installationId, 'A restored sender never rewrites an original event to its new installation.');
  const fresh = await authority(f.identity, f.activity.activityId, { ...event, installationId: nextInstallationId }, recovered);
  assert.equal(fresh.installationId, nextInstallationId);
  await assert.rejects(authority(f.identity, f.activity.activityId, { ...event, installationId: nextInstallationId }, f.source), { code: 'forbidden' });
  // An already constructed trusted source must recheck the current approved binding, too.
  await bindings.bind({ ...binding, requestId: randomUUID(), deviceModules: [] });
  await assert.rejects(retained.assertAuthorized(), { code: 'forbidden' });
});


test('SchoolClient publishes through its fixed executor connection with the current user subject', { timeout: 60000 }, async t => {
  const f = await fixture(t), clientRoot = join(f.pg.root, 'client'); let authority, checked = 0, wrongSubject = false;
  const { createSchoolClient } = await import('../src/school-client.ts');
  const { createConnectionAuthority } = await import('../dist/connections.js');
  const server = createServer((request, response) => {
    if (request.url === '/api/learning/access') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ identity: { ...f.identity, ...(wrongSubject ? { principalId: randomUUID() } : { name: '当前名字' }) },
        target: { ...f.data.owner, version: 1 } })); return;
    }
    void authority.handle(request, response).then(handled => { if (!handled) { response.writeHead(404); response.end(); } }).catch(() => response.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const target = { ...f.data.owner, unit: 'learning-data', endpoint: `http://127.0.0.1:${server.address().port}`,
    protocolVersion: 1, capabilities: ['agent.dependencies.v2'] };
  const channel = createAgentDependencyChannel(f.data, { learning: f.learning, courses: f.courses,
    sessions: {}, async authorize(who, source) { await source.assertAuthorized(); await f.spaces.authorize(who); },
    async assertDispatch() { assert.fail('No live Agent permit is needed to publish an original record.'); },
    async executionRecordSource(_who, _id, _event, source) {
      checked++; assert.equal(source.sourceServiceId, f.device.serviceId);
      return { sourceOwner: f.device, installationId: f.installationId, role: 'tool-execution' };
    } });
  authority = createConnectionAuthority({ root: join(f.pg.root, 'authority'), service: target,
    handlers: { 'agent.dependencies.v2': (payload, source) => channel.handle(payload, source) } });
  const grant = await authority.authorize({ sourceEnvironmentId: f.device.environmentId, sourceServiceId: f.device.serviceId,
    sourceInstallationId: f.installationId, capabilities: ['agent.dependencies.v2'] });
  const executionConnectionId = randomUUID(), schoolConnectionId = randomUUID();
  const descriptor = { connectionId: executionConnectionId, sourceEnvironmentId: f.device.environmentId, sourceServiceId: f.device.serviceId,
    target, requiredCapabilities: ['agent.dependencies.v2'], optionalCapabilities: [], credentialRef: 'execution-grant' };
  await mkdir(join(clientRoot, 'credentials'), { recursive: true });
  await writeFile(join(clientRoot, 'credentials/execution-grant'), grant.token, { mode: 0o600 });
  await writeFile(join(clientRoot, 'installation.json'), JSON.stringify({ connections: [descriptor] }));
  await writeFile(join(clientRoot, 'environment.json'), JSON.stringify({ installationId: f.installationId }));
  await writeFile(join(clientRoot, 'credentials/school-client-' + schoolConnectionId), JSON.stringify({ requestId: schoolConnectionId,
    schoolEndpoint: target.endpoint, verifier: 'fixture', clientId: randomUUID(), clientNamespace: 'record-v2',
    grant: { token: 'synthetic-user-token'.repeat(3), connectionId: schoolConnectionId, identity: f.identity,
      target: { ...f.data.owner, version: 1 }, capabilities: ['activity:read', 'activity:write'] },
    agentBinding: { dependencyConnectionId: randomUUID(), executionConnectionId, target: { ...f.data.owner, version: 1 } } }));
  const school = createSchoolClient(clientRoot, { clientNamespace: 'record-v2', installationId: f.installationId, services: [{ ...f.device, unit: 'tool-execution' }] });
  const original = f.command();
  await school.publishExecutionRecord(f.identity, f.activity.activityId, original);
  assert.equal((await f.learning.executionRecords.read(f.identity, f.activity.activityId, original.requestId)).executionRef, original.executionRef);
  assert.ok(checked > 0);
  const before = checked; wrongSubject = true;
  await assert.rejects(school.publishExecutionRecord(f.identity, f.activity.activityId, f.command()), { code: 'forbidden' });
  assert.equal(checked, before, 'A changed caller is rejected before a publication transfer.'); wrongSubject = false;
  await writeFile(join(clientRoot, 'installation.json'), JSON.stringify({ connections: [{ ...descriptor,
    sourceServiceId: randomUUID() }] }));
  await assert.rejects(school.publishExecutionRecord(f.identity, f.activity.activityId, f.command()), { code: 'identity-conflict' });
  assert.equal(checked, before, 'The Agent connection cannot stand in for the original executor.');
});


test('remote home query reads original records and owner conversation facts with fresh v2 authorization', { timeout: 60000 }, async t => {
  const f = await fixture(t), clientRoot = join(f.pg.root, 'home-client'); let authority, revoked = false;
  const { createSchoolClient } = await import('../src/school-client.ts');
  const { createConnectionAuthority } = await import('../dist/connections.js');
  const { createAgentRuntime, agentRuntimeMigrations } = await import('@xunjie/agent-runtime');
  const { createLearningQuery, learningObjectVersion } = await import('@xunjie/learning-space/learning-data/learning-query');
  const agentStorage = await f.open('conversation-agent', agentRuntimeMigrations);
  const runtime = createAgentRuntime(agentStorage, { authorize: f.spaces.authorize }); f.beforeClose(() => runtime.close());
  const sessionId = randomUUID();
  await runtime.initialize({ sessionId, identity: f.identity, scenario: 'student-assistant', restartPolicy: 'explicit', createdAt: new Date().toISOString() });
  await runtime.accept(f.identity, { sessionId, requestId: randomUUID(), text: '原会话中的实验记录说明', mode: 'steering', context: {} });
  const conversationOwner = { ...agentStorage.owner, version: 1 };
  async function conversation(who, id) {
    const snapshot = await runtime.sessionSnapshot(who, id);
    return { objectId: id, version: learningObjectVersion(snapshot), owner: conversationOwner, title: '原会话',
      text: snapshot.inputs.map(input => input.input.text).join('\n') };
  }
  const ownerConversationRead = { owner: conversationOwner,
    async list(who) { return { entries: [await conversation(who, sessionId)], nextCursor: null }; },
    async read(who, id, version) { const entry = await conversation(who, id); if (entry.version !== version) throw new StorageError('conflict'); return entry; } };
  const original = f.command();
  await f.learning.executionRecords.sync(f.identity, f.activity.activityId, original, {
    sourceOwner: f.device, installationId: f.installationId, role: 'tool-execution' });
  const server = createServer(async (request, response) => {
    const json = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.url === '/api/learning/access') return json({ identity: { ...f.identity, name: '当前名字', ...(revoked ? { principalId: randomUUID() } : {}) }, target: { ...f.data.owner, version: 1 } });
    if (request.url === '/api/learning/agent-sources') {
      assert.equal(request.headers['x-xj-agent-contract'], '2');
      return json({ identity: f.identity, learningTarget: { ...f.data.owner, version: 1 }, courseTarget: { ...f.space.owner, version: 1 } });
    }
    if (request.url === '/api/learning/activities') return json(await f.learning.list(f.identity));
    if (request.url === '/api/learning/activities/' + f.activity.activityId) return json(await f.learning.open(f.identity, f.activity.activityId));
    if (!await authority.handle(request, response)) { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.beforeClose(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const target = { ...f.data.owner, unit: 'learning-data', endpoint: `http://127.0.0.1:${server.address().port}`,
    protocolVersion: 1, capabilities: ['agent.dependencies.v2'] };
  const channel = createAgentDependencyChannel(f.data, { learning: f.learning, courses: f.courses, sessions: {},
    async authorize(who, source) { await source.assertAuthorized(); await f.spaces.authorize(who); },
    async source(who) { await f.spaces.authorize(who); return { sourceId: 'actual-data-owner', identity: who,
      target: { ...f.data.owner, version: 1 }, learning: f.learning, ownerConversationRead,
      courses: { owner: { ...f.space.owner, version: 1 }, listCourses: f.courses.listCourses, readRelease: f.courses.readRelease } }; },
    async assertDispatch() { assert.fail('Owner query must never require an Agent dispatch permit.'); } });
  authority = createConnectionAuthority({ root: join(f.pg.root, 'home-authority'), service: target,
    handlers: { 'agent.dependencies.v2': async (payload, source) => {
      // Match the product host boundary: owner errors are wire results, not transport failures.
      try { return await channel.handle(payload, source); }
      catch (error) { return { error: error instanceof StorageError ? error.code : 'invalid' }; }
    } } });
  const agentOwner = { environmentId: randomUUID(), serviceId: randomUUID() }, installationId = randomUUID();
  const grant = await authority.authorize({ sourceEnvironmentId: agentOwner.environmentId, sourceServiceId: agentOwner.serviceId,
    sourceInstallationId: installationId, capabilities: ['agent.dependencies.v2'] });
  const dependencyConnectionId = randomUUID(), schoolConnectionId = randomUUID();
  const descriptor = { connectionId: dependencyConnectionId, sourceEnvironmentId: agentOwner.environmentId, sourceServiceId: agentOwner.serviceId,
    target, requiredCapabilities: ['agent.dependencies.v2'], optionalCapabilities: [], credentialRef: 'home-grant' };
  await mkdir(join(clientRoot, 'credentials'), { recursive: true });
  await writeFile(join(clientRoot, 'credentials/home-grant'), grant.token, { mode: 0o600 });
  await writeFile(join(clientRoot, 'installation.json'), JSON.stringify({ connections: [descriptor] }));
  await writeFile(join(clientRoot, 'environment.json'), JSON.stringify({ installationId }));
  await writeFile(join(clientRoot, 'credentials/school-client-' + schoolConnectionId), JSON.stringify({ requestId: schoolConnectionId,
    schoolEndpoint: target.endpoint, verifier: 'fixture', clientId: randomUUID(), clientNamespace: 'home-query-v2',
    grant: { token: 'synthetic-home-token'.repeat(3), connectionId: schoolConnectionId, identity: f.identity,
      target: { ...f.data.owner, version: 1 }, capabilities: ['activity:read', 'activity:write'] },
    agentBinding: { dependencyConnectionId, target: { ...agentOwner, version: 1 } } }));
  const school = createSchoolClient(clientRoot, { clientNamespace: 'home-query-v2', installationId, services: [] });
  const source = await school.querySource(f.identity);
  const query = createLearningQuery({ sources: async () => [source] });
  const page = await query.searchLearning({ query: '原', kinds: ['record', 'conversation'] });
  assert.deepEqual(page.unavailable, []);
  const record = page.items.find(item => item.reference.kind === 'record'), savedConversation = page.items.find(item => item.reference.kind === 'conversation');
  assert.ok(record); assert.ok(savedConversation);
  assert.deepEqual(record.reference.owner, { ...f.data.owner, version: 1 });
  assert.deepEqual(savedConversation.reference.owner, conversationOwner);
  assert.equal(savedConversation.reference.identity.principalId, f.identity.principalId);
  assert.ok((await query.readLearning({ reference: record.reference })).text.includes(original.executionRef));
  assert.ok((await query.readLearning({ reference: savedConversation.reference })).text.includes('原会话中的实验记录说明'));
  await assert.rejects(query.readLearning({ reference: { ...savedConversation.reference, version: 'another-version' } }), { code: 'conflict' });
  await assert.rejects(query.readLearning({ reference: { ...savedConversation.reference, owner: { ...conversationOwner, serviceId: randomUUID() } } }), { code: 'forbidden' });
  revoked = true;
  await assert.rejects(query.readLearning({ reference: savedConversation.reference }), { code: 'forbidden' }); revoked = false;
  await authority.revoke(grant.grantId);
  await assert.rejects(query.readLearning({ reference: record.reference }), { code: 'forbidden' });
});
