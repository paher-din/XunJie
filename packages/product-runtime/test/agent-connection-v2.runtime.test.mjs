import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createChunkChannel } from '@xunjie/storage/chunk-channel';
import { agentDependencyAuthorityProjection, createAgentDependencyService } from '@xunjie/agents/transport/session-dependencies';
import { createLearningData, learningMigrations } from '@xunjie/learning-space';
import { createAgentSessions } from '@xunjie/learning-space/learning-data/agent-sessions';
import { createConnectionAuthority } from '../dist/connections.js';
import { createAgentConnection } from '../dist/agent-connections.js';
import { agentTransferEntries } from '../dist/agent-transfer-journal.js';
import { createSchoolClient } from '../dist/school-client.js';
import { routeAgentSessions } from '../dist/learning-http/sessions-http.js';
import { createAgentRuntime, agentRuntimeMigrations } from '@xunjie/agent-runtime';
import { createAgentConversationProjection } from '../dist/agent-conversation.js';
import { createAgentSessionApplication } from '../dist/agent-sessions.js';
import { createSkills } from '@xunjie/learning-space/learning-data/skills';

async function fixture(t, capability, effect, authorize = async () => {}, learningHttp) {
  const pg = await nativeFixture(), root = await mkdtemp(join(tmpdir(), 'agent-connection-v2-'));
  let storage, server;
  t.after(async () => {
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await storage?.close(); await pg.close(); await rm(root, { recursive: true, force: true });
  });
  const migrations = learningMigrations;
  const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID(), migrations });
  storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: 'objects', root: join(pg.root, 'objects') }) });
  let fault = () => false, authority;
  const channel = createChunkChannel(storage).wrap(effect, {
    authority: agentDependencyAuthorityProjection, authorize,
    readOnly: input => input.operation === 'conversation',
  });
  server = createServer((request, response) => {
    void authority.handle(request, response).then(async handled => {
      if (handled) return;
      if (learningHttp && await learningHttp(request, response)) return;
      response.writeHead(404); response.end();
    }).catch(() => response.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const target = { ...binding.owner, unit: 'learning-data', protocolVersion: 1,
    endpoint: `http://127.0.0.1:${server.address().port}`, capabilities: [capability] };
  authority = createConnectionAuthority({ root: join(root, 'receiver'), service: target, handlers: {
    [capability]: async (value, source) => {
      try {
        const result = await channel(value, source);
        if (fault(value)) throw new Error('lost reply');
        return result;
      } catch (error) { if (error instanceof StorageError) return { error: error.code }; throw error; }
    },
  } });
  const origin = { sourceEnvironmentId: randomUUID(), sourceServiceId: randomUUID(), sourceInstallationId: randomUUID() };
  const connection = { connectionId: randomUUID(), sourceEnvironmentId: origin.sourceEnvironmentId, sourceServiceId: origin.sourceServiceId,
    target, requiredCapabilities: [capability], optionalCapabilities: [], credentialRef: 'grant' };
  const grant = await authority.authorize({ ...origin, capabilities: [capability] });
  await mkdir(join(root, 'credentials')); await writeFile(join(root, 'credentials', 'grant'), grant.token);
  await writeFile(join(root, 'installation.json'), JSON.stringify({ connections: [connection] }));
  await writeFile(join(root, 'environment.json'), JSON.stringify({ installationId: origin.sourceInstallationId }));
  return { root, pg, storage, connection, origin, target, client: () => createAgentConnection(root, connection.connectionId, capability), set fault(value) { fault = value; } };
}
const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: 'Student' };

test('v2 connection renews only original permit authority after lost reply, without a second effect', { timeout: 60000 }, async t => {
  const sessionId = randomUUID(), permit = { sessionId, runId: randomUUID(), stepId: randomUUID(), operationId: randomUUID(), generation: 1 };
  let effects = 0, generation = 1;
  const f = await fixture(t, 'agent.dependencies.v2', async input => { effects++; return { text: input.args.args[0].text }; }, async input => {
    if (input.permit?.generation !== generation) throw new StorageError('stale-generation');
  });
  const input = { version: 2, operation: 'workspace.data', identity, sessionId, permit,
    args: { method: 'artifacts.publish', args: [{ text: '中文🙂'.repeat(160000), requestId: permit.operationId }] } };
  f.fault = value => value.operation === 'begin';
  await assert.rejects(f.client()(input), { code: 'unavailable' });
  const [before] = await agentTransferEntries(f.root);
  generation = 2; f.fault = () => false;
  assert.deepEqual(await f.client()({ ...input, permit: { ...permit, generation } }), { text: input.args.args[0].text });
  assert.equal(effects, 1);
  const [after] = await agentTransferEntries(f.root);
  assert.equal(after.transferId, before.transferId);
  assert.equal(after.payload.permit.generation, 1);
  await assert.rejects(f.client()({ ...input, permit: { ...permit, generation }, args: { ...input.args, args: [{ text: 'edited' }] } }), { code: 'identity-conflict' });
  assert.equal(effects, 1);
});

test('school mapping retains historical owners through user HTTP while dependency initialization remains owner-filtered', { timeout: 60000 }, async t => {
  let service, actualTarget, http;
  const f = await fixture(t, 'agent.dependencies.v2', (value, source) => service(value, source), async () => {}, async (request, response) => {
    if (request.url === '/api/learning/access') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ identity, target: actualTarget })); return true;
    }
    if (request.url === '/api/learning/agent-sources') {
      assert.equal(request.headers['x-xj-agent-contract'], '2');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ identity, learningTarget: actualTarget, courseTarget })); return true;
    }
    if (!request.url.startsWith('/api/learning/agent-sessions')) return false;
    assert.equal(request.headers['x-xj-agent-contract'], '2');
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const url = new URL(request.url, 'http://localhost');
    const value = await routeAgentSessions(http, identity, url.pathname.slice('/api/learning/'.length), request.method, body, url.search, '2');
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); return true;
  });
  actualTarget = { ...f.storage.owner, version: 1 };
  const courseTarget = { environmentId: randomUUID(), serviceId: randomUUID(), version: 1 };
  const learning = createLearningData(f.storage, { resolveBinding: async () => actualTarget });
  const agentOwner = { version: 1, connectionId: f.connection.connectionId, installationId: f.origin.sourceInstallationId,
    target: { environmentId: f.origin.sourceEnvironmentId, serviceId: f.origin.sourceServiceId, unit: 'teaching-agent',
      protocolVersion: 1, endpoint: 'http://127.0.0.1:1', capabilities: ['agent.sessions.v2'] } };
  let chosenOwner = agentOwner;
  const directory = createAgentSessions(f.storage, { authorize: async () => {}, openActivity: learning.open, resolveOwner: async () => chosenOwner });
  const agentBinding = await provisionStorage({ admin: f.pg.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID(), migrations: agentRuntimeMigrations });
  const agentStorage = await openStorage({ binding: agentBinding, migrations: agentRuntimeMigrations,
    backend: createFileBackend({ id: 'historical-agent', root: join(f.pg.root, 'historical-agent') }) });
  const runtime = createAgentRuntime(agentStorage, { authorize: async () => {} });
  t.after(async () => { await runtime.close(); await agentStorage.close(); });
  const projection = createAgentConversationProjection(runtime);
  const skills = createSkills(f.storage, { authorize: async () => {}, session: directory.read, activity: learning.open,
    personalOwners: async () => [identity], assertWritable() {} });
  http = { sessions: directory, agent: async () => ({ ...runtime, ...projection }), skills: async () => skills };
  service = createAgentDependencyService({ sessions: directory, learning, courses: {}, authorize: async () => {},
    source: async who => ({ sourceId: 'actual', identity: who, target: actualTarget, learning,
      courses: { owner: courseTarget, listCourses: async () => ({ courses: [] }), readRelease: async () => { throw new StorageError('missing'); } } }),
    resolveOwner: async () => agentOwner, assertDispatch: async () => { throw new StorageError('forbidden'); } });
  const connectionId = randomUUID();
  const savedConnection = { requestId: connectionId,
    schoolEndpoint: f.target.endpoint, verifier: 'fixture', clientId: randomUUID(), clientNamespace: 'remote-v2',
    grant: { token: 'fixture'.repeat(10), identity, target: actualTarget, connectionId, capabilities: ['activity:read', 'activity:write'] },
    agentBinding: { dependencyConnectionId: f.connection.connectionId,
      target: { environmentId: f.origin.sourceEnvironmentId, serviceId: f.origin.sourceServiceId, version: 1 } } };
  await writeFile(join(f.root, 'credentials', 'school-client-' + connectionId), JSON.stringify(savedConnection));
  const school = createSchoolClient(f.root, { clientNamespace: 'remote-v2', services: [] });
  const [source] = await school.learningSources();
  assert.deepEqual(source.learningTarget, actualTarget); assert.deepEqual(source.courseTarget, courseTarget); assert.equal(source.local, false);
  const remote = await school.sessionDirectory(identity);
  const sessionId = randomUUID();
  await remote.create(identity, { requestId: randomUUID(), sessionId, scenario: 'student-assistant', title: 'Remote owner' });
  assert.equal((await directory.read(identity, sessionId)).title, 'Remote owner');
  assert.equal((await remote.read(identity, sessionId)).owner.target.serviceId, agentOwner.target.serviceId);
  const dependencies = await school.dependenciesForSession(identity, sessionId);
  assert.equal(typeof dependencies.models.checks.receive, 'function');
  assert.equal(typeof dependencies.tools, 'function');
  chosenOwner = { ...agentOwner, connectionId: randomUUID(), target: { ...agentOwner.target, ...agentStorage.owner } };
  const historicalId = randomUUID();
  await directory.create(identity, { sessionId: historicalId, requestId: randomUUID(), scenario: 'student-assistant', title: 'Original server owner' });
  await runtime.initialize({ sessionId: historicalId, identity, scenario: 'student-assistant', restartPolicy: 'explicit', createdAt: new Date().toISOString() });
  await directory.markReady(identity, { sessionId: historicalId, requestId: randomUUID() });
  const historicalOwner = chosenOwner;
  chosenOwner = agentOwner;
  assert.equal((await f.client()({ version: 2, operation: 'sessions.list', identity, args: {} })).some(item => item.sessionId === historicalId), false);
  assert.equal((await remote.list(identity)).some(item => item.sessionId === historicalId), true);
  assert.equal((await remote.read(identity, historicalId)).owner.connectionId, historicalOwner.connectionId);
  const proxy = await school.sessionAgent(identity, historicalId);
  const input = { sessionId: historicalId, requestId: randomUUID(), mode: 'steering', text: 'Original server only', context: {} };
  const accepted = await proxy.accept(identity, input);
  assert.deepEqual(await runtime.request(identity, historicalId, input.requestId), { receipt: accepted, input });
  assert.deepEqual(await proxy.request(identity, historicalId, input.requestId), { receipt: accepted, input });
  assert.equal((await proxy.conversation(identity, historicalId)).sessionId, historicalId);
  await assert.rejects(proxy.resolveWait(identity, historicalId, { requestId: randomUUID(), waitId: randomUUID(), expectedVersion: 1, result: {} }), { code: 'forbidden' });
  const schoolSkills = await school.sessionSkills(identity, historicalId);
  const skillState = await schoolSkills.resolveSession(identity, historicalId);
  assert.deepEqual(skillState.catalog, []); assert.match(skillState.selectionDigest, /^[a-f0-9]{64}$/);
  const selectSkills = { requestId: randomUUID(), skills: [] };
  assert.deepEqual(await schoolSkills.selectSession(identity, historicalId, selectSkills), await skills.resolveSession(identity, historicalId));
  assert.deepEqual(await schoolSkills.selectSession(identity, historicalId, selectSkills), await skills.resolveSession(identity, historicalId));
  await assert.rejects(schoolSkills.resolveSession({ ...identity, principalId: randomUUID() }, historicalId), { code: 'forbidden' });
  await assert.rejects(schoolSkills.resolveSession(identity, sessionId), { code: 'identity-conflict' });
  const subject = [identity.environmentId, identity.spaceId, identity.principalId].join('.');
  assert.deepEqual(await school.forward(connectionId, `agent-sessions/${historicalId}/skills`, undefined, subject, '', '2'), await skills.resolveSession(identity, historicalId));
  const serverOnlyRoot = join(f.pg.root, 'server-only-client'), serverOnlyConnection = randomUUID();
  await mkdir(join(serverOnlyRoot, 'credentials'), { recursive: true });
  await writeFile(join(serverOnlyRoot, 'credentials', 'school-client-' + serverOnlyConnection), JSON.stringify({ requestId: serverOnlyConnection,
    schoolEndpoint: f.target.endpoint, verifier: 'fixture', clientId: randomUUID(), clientNamespace: 'server-only',
    grant: { token: 'fixture'.repeat(10), identity, target: actualTarget, connectionId: serverOnlyConnection, capabilities: ['activity:read', 'activity:write'] } }));
  const serverOnly = createSchoolClient(serverOnlyRoot, { clientNamespace: 'server-only', services: [] });
  assert.deepEqual((await serverOnly.learningSources())[0].courseTarget, courseTarget);
  assert.equal((await (await serverOnly.sessionDirectory(identity)).read(identity, historicalId)).owner.connectionId, historicalOwner.connectionId);
  const callerBinding = await provisionStorage({ admin: f.pg.admin,
    owner: { environmentId: f.origin.sourceEnvironmentId, serviceId: f.origin.sourceServiceId }, password: randomUUID(), migrations: agentRuntimeMigrations });
  const callerStorage = await openStorage({ binding: callerBinding, migrations: agentRuntimeMigrations,
    backend: createFileBackend({ id: 'caller-agent', root: join(f.pg.root, 'caller-agent') }) });
  const caller = createAgentRuntime(callerStorage, { authorize: async () => {} });
  t.after(async () => { await caller.close(); await callerStorage.close(); });
  const localApplication = createAgentSessionApplication({ directory, runtime: async () => caller });
  await writeFile(join(f.root, 'credentials', 'school-client-' + connectionId), JSON.stringify({ ...savedConnection,
    localStudy: { version: 1, imported: true } }));
  const schoolWithLocalApplication = createSchoolClient(f.root, { clientNamespace: 'remote-v2', services: [] }, {
    target: actualTarget, studyCopies: { hasIdentity: async () => true },
    sessions: { sessions: localApplication, agent: async () => caller },
  });
  const initialization = await schoolWithLocalApplication.sessionDirectory(identity), pendingId = randomUUID();
  const pending = await initialization.create(identity, { sessionId: pendingId, requestId: randomUUID(), scenario: 'student-assistant' });
  assert.equal(pending.state, 'initializing', 'the school directory must not invoke the local HTTP application to initialize');
  await caller.initialize({ sessionId: pendingId, identity, scenario: pending.scenario, restartPolicy: 'explicit', createdAt: pending.createdAt });
  await writeFile(join(f.root, 'credentials', 'school-client-' + connectionId), JSON.stringify({ ...savedConnection,
    localStudy: { version: 1, imported: true }, agentBinding: { ...savedConnection.agentBinding, dependencyConnectionId: randomUUID() } }));
  const readyInput = { sessionId: pendingId, requestId: randomUUID() };
  const ready = await initialization.markReady(identity, readyInput);
  assert.equal(ready.state, 'ready', 'the original caller connection completes initialization after a binding change');
  assert.deepEqual(await initialization.markReady(identity, readyInput), ready);
  assert.equal((await directory.read(identity, pendingId)).state, 'ready');
  assert.equal((await initialization.list(identity)).some(item => item.sessionId === historicalId), true);
  const updated = await initialization.update(identity, { sessionId: historicalId, requestId: randomUUID(), title: 'Historical owner retained' });
  assert.equal(updated.title, 'Historical owner retained');
  assert.deepEqual(updated.owner, historicalOwner);
});

test('assertDispatch uses current owner checks without a local transfer journal', { timeout: 60000 }, async t => {
  const sessionId = randomUUID(), permit = { sessionId, runId: randomUUID(), stepId: randomUUID(), operationId: randomUUID(), generation: 1 };
  let checks = 0, allowed = true;
  const f = await fixture(t, 'agent.sessions.v2', input => {
    checks++; if (!allowed) throw new StorageError('stale-generation'); return input.args.permit;
  });
  const call = { version: 2, operation: 'assertDispatch', identity, sessionId, args: { permit, attemptId: permit.operationId } };
  assert.deepEqual(await f.client()(call), permit);
  allowed = false;
  await assert.rejects(f.client()(call), { code: 'stale-generation' });
  assert.equal(checks, 2); assert.deepEqual(await agentTransferEntries(f.root), []);
});

test('large conversation queries refresh after consumption and recover unknown pure reads', { timeout: 60000 }, async t => {
  let fail = true, reads = 0;
  const f = await fixture(t, 'agent.sessions.v2', input => {
    reads++; if (fail) throw new Error('original read interrupted');
    return { text: '中文🙂'.repeat(160000), revision: reads };
  });
  const call = { version: 2, operation: 'conversation', identity, sessionId: randomUUID(), args: { after: 0 } };
  await assert.rejects(f.client()(call), { code: 'unavailable' });
  fail = false;
  const recovered = await f.client()(call), refreshed = await f.client()(call);
  assert.equal(recovered.text, '中文🙂'.repeat(160000)); assert.ok(refreshed.revision > recovered.revision);
});
