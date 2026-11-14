import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { createAgentRuntime, agentRuntimeMigrations } from '@xunjie/agent-runtime';
import { createAgentSessions } from '@xunjie/learning-space/learning-data/agent-sessions';
import { learningMigrations, createLearningData } from '@xunjie/learning-space';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createAgentSessionApplication } from '../dist/agent-sessions.js';
import { createAgentConversationProjection } from '../dist/agent-conversation.js';
import { createSchoolClient } from '../dist/school-client.js';
import { createConnectionAuthority } from '../dist/connections.js';
import { createSkills } from '@xunjie/learning-space/learning-data/skills';

test('local-study v2 sessions use the local directory and current school identity, recovering a lost accept receipt', { timeout: 60000 }, async t => {
  const pg = await nativeFixture(), handles = [];
  let runtime;
  t.after(async () => { await runtime?.close(); for (const handle of handles.reverse()) await handle.close(); await pg.close(); });
  async function storage(name, migrations) {
    const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID(), migrations });
    const value = await openStorage({ binding, migrations, backend: createFileBackend({ id: name, root: join(pg.root, name) }) });
    handles.push(value); return value;
  }
  const data = await storage('data', learningMigrations), agent = await storage('agent', agentRuntimeMigrations);
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: 'Current school student' };
  const target = { ...data.owner, version: 1 }, schoolTarget = { environmentId: randomUUID(), serviceId: randomUUID(), version: 1 };
  const courseTarget = { ...schoolTarget, serviceId: randomUUID() }, token = 'fixture'.repeat(10);
  let describedIdentity = identity, describedTarget = schoolTarget, sourceReads = 0;
  const server = createServer((request, response) => {
    if (request.url !== '/api/learning/agent-sources') { response.writeHead(404); response.end(); return; }
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.authorization, 'Bearer ' + token);
    assert.equal(request.headers['x-xj-agent-contract'], '2');
    sourceReads++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ identity: describedIdentity, learningTarget: describedTarget, courseTarget }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  runtime = createAgentRuntime(agent, { authorize: async who => { assert.equal(who.principalId, identity.principalId); } });
  const owner = { version: 1, connectionId: randomUUID(), installationId: randomUUID(), target: { ...agent.owner,
    unit: 'teaching-agent', protocolVersion: 1, endpoint: 'http://127.0.0.1:1', capabilities: ['agent.sessions.v2'] } };
  const directory = createAgentSessions(data, { authorize: async () => {}, openActivity: async () => { throw new Error('not a workspace test'); }, resolveOwner: async () => owner });
  const application = createAgentSessionApplication({ directory, runtime: async () => runtime });
  const projection = createAgentConversationProjection(runtime);
  const localSkills = createSkills(data, { authorize: async () => {}, session: directory.read,
    activity: async () => { throw new Error('student-assistant skills do not read a workspace'); },
    personalOwners: async () => [identity], assertWritable() {} });
  let loseReply = true;
  const sessions = { sessions: application, skills: async () => localSkills, agent: async () => ({ ...runtime, ...projection,
    async accept(who, input) {
      const receipt = await runtime.accept(who, input);
      if (loseReply) { loseReply = false; throw new StorageError('unavailable'); }
      return receipt;
    },
  }) };
  const connectionId = randomUUID(), root = join(pg.root, 'client'); await mkdir(join(root, 'credentials'), { recursive: true });
  await writeFile(join(root, 'credentials', 'school-client-' + connectionId), JSON.stringify({
    requestId: connectionId, schoolEndpoint: `http://127.0.0.1:${server.address().port}`, verifier: 'fixture', clientId: randomUUID(), clientNamespace: 'v2',
    grant: { token, connectionId, identity, target: schoolTarget, capabilities: ['activity:read', 'activity:write'],
      account: { accountName: 'student', schoolName: 'School' }, profile: { version: 1, localStudy: true, connectionId, identity, target: schoolTarget,
        account: { accountName: 'student', schoolName: 'School' } } }, localStudy: { version: 1, imported: true },
  }));
  const school = createSchoolClient(root, { clientNamespace: 'v2', services: [] }, { target, courseTarget: target, sessions,
    create: (authority, courses) => createLearningData(data, authority, courses),
    studyCopies: { hasIdentity: async () => true } });
  const subject = [identity.environmentId, identity.spaceId, identity.principalId].join('.');
  const forward = (route, body) => school.forward(connectionId, route, body, subject, '', '2');
  const sessionId = randomUUID(), requestId = randomUUID();
  await forward('agent-sessions', { sessionId, requestId: randomUUID(), scenario: 'student-assistant', title: 'School context' });
  assert.equal((await directory.read(identity, sessionId)).identity.principalId, identity.principalId);
  await assert.rejects(school.forward(connectionId, `agent-sessions/${sessionId}/inputs`, {}, 'different', '', '2'), { code: 'forbidden' });
  const input = { requestId, sessionId, mode: 'steering', text: 'fixed question', context: {} };
  await assert.rejects(forward(`agent-sessions/${sessionId}/inputs`, input), { code: 'unavailable' });
  const original = await forward(`agent-sessions/${sessionId}/requests/${requestId}`);
  assert.deepEqual(original.input, input);
  assert.deepEqual(await forward(`agent-sessions/${sessionId}/inputs`, input), original.receipt);
  await assert.rejects(forward(`agent-sessions/${sessionId}/inputs`, { ...input, text: 'edited' }), { code: 'identity-conflict' });
  assert.equal((await runtime.sessionSnapshot(identity, sessionId)).inputs.length, 1);
  const sources = await school.learningSources();
  assert.deepEqual(sources[0].learningTarget, target);
  assert.deepEqual(sources[0].courseTarget, courseTarget);
  assert.equal(sources[0].local, true);
  const ownerLearning = createLearningData(data, { resolveBinding: async () => target });
  const created = await ownerLearning.create(identity, { requestId: randomUUID(), goal: 'Actual local workspace', question: '', references: [] });
  assert.equal((await school.openActivity(identity, created.activityId)).activityId, created.activityId);
  const dependencies = await school.dependenciesForSession(identity, sessionId);
  assert.equal((await dependencies.learning.open(identity, created.activityId)).activityId, created.activityId);
  const source = await school.querySource(identity);
  assert.equal((await source.learning.list(identity))[0].activityId, created.activityId);
  assert.deepEqual(source.target, target);
  assert.deepEqual(source.courses.owner, courseTarget);
  const readsBeforeSkills = sourceReads;
  const skillPort = await school.sessionSkills(identity, sessionId);
  const selectedSkills = await skillPort.selectSession(identity, sessionId, { requestId: randomUUID(), skills: [] });
  assert.deepEqual(await skillPort.resolveSession(identity, sessionId), selectedSkills);
  assert.equal(sourceReads, readsBeforeSkills, 'local-study skills stay at the local session owner without an RPC');
  assert.deepEqual(await forward('agent-sources'), { identity, learningTarget: schoolTarget, courseTarget });
  assert.ok(sourceReads >= 2, 'both public source APIs query the authenticated school owner');
  describedIdentity = { ...identity, name: 'Updated name' };
  assert.deepEqual((await school.querySource(identity)).courses.owner, courseTarget);
  describedIdentity = { ...identity, principalId: randomUUID() };
  await assert.rejects(school.learningSources(), { code: 'forbidden' });
  await assert.rejects(school.querySource(identity), { code: 'forbidden' });
  describedIdentity = identity; describedTarget = target;
  await assert.rejects(school.learningSources(), { code: 'identity-conflict' });
  await assert.rejects(school.querySource(identity), { code: 'identity-conflict' });
});

test('local bindings retain local activities while resolving the school course owner through authenticated source HTTP', { timeout: 60000 }, async t => {
  const pg = await nativeFixture(), root = join(pg.root, 'client');
  let storage, server;
  t.after(async () => {
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await storage?.close(); await pg.close();
  });
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() }, target = { ...owner, version: 1 };
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: 'Student' };
  const courseTarget = { environmentId: identity.environmentId, serviceId: randomUUID(), version: 1 };
  const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations: learningMigrations });
  storage = await openStorage({ binding, migrations: learningMigrations, backend: createFileBackend({ id: 'data', root: join(pg.root, 'data') }) });
  const token = 'fixture'.repeat(10);
  let authority, sourceReads = 0;
  server = createServer((request, response) => {
    void (async () => {
      if (await authority.handle(request, response)) return;
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.authorization, 'Bearer ' + token);
      let value;
      if (request.url === '/api/learning/access') value = { identity, target };
      else if (request.url === '/api/learning/agent-sources') {
        assert.equal(request.headers['x-xj-agent-contract'], '2'); sourceReads++;
        value = { identity, learningTarget: target, courseTarget };
      } else if (request.url === '/api/learning/courses') {
        assert.equal(request.headers['x-xj-agent-contract'], undefined, 'existing course HTTP keeps its contract');
        value = { courses: [] };
      } else { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
    })().catch(error => { response.destroy(error); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const installationId = randomUUID(), connectionId = randomUUID(), runtimeConnectionId = randomUUID();
  const service = { environmentId: identity.environmentId, serviceId: courseTarget.serviceId, unit: 'space-course', protocolVersion: 1,
    endpoint: `http://127.0.0.1:${server.address().port}`, capabilities: ['learning.authority'] };
  authority = createConnectionAuthority({ root: join(pg.root, 'authority'), service, handlers: {
    'learning.authority': async request => {
      assert.equal(request.operation, 'access'); assert.equal(request.token, token); return { identity, target };
    },
  } });
  const grant = await authority.authorize({ sourceEnvironmentId: owner.environmentId, sourceServiceId: owner.serviceId,
    sourceInstallationId: installationId, capabilities: ['learning.authority'] });
  await mkdir(join(root, 'credentials'), { recursive: true });
  await writeFile(join(root, 'credentials', 'authority'), grant.token);
  await writeFile(join(root, 'installation.json'), JSON.stringify({ connections: [{ connectionId: runtimeConnectionId,
    sourceEnvironmentId: owner.environmentId, sourceServiceId: owner.serviceId, target: service,
    requiredCapabilities: ['learning.authority'], optionalCapabilities: [], credentialRef: 'authority' }] }));
  await writeFile(join(root, 'credentials', 'school-client-' + connectionId), JSON.stringify({ requestId: connectionId,
    schoolEndpoint: service.endpoint, verifier: 'fixture', clientId: randomUUID(), clientNamespace: 'local-binding',
    grant: { token, connectionId, identity, target, capabilities: ['activity:read', 'activity:write'] },
    localBinding: { runtimeConnectionId, target } }));
  const school = createSchoolClient(root, { clientNamespace: 'local-binding', installationId, services: [] }, {
    target, courseTarget: target, create: (spaceAuthority, courses) => createLearningData(storage, spaceAuthority, courses),
  });
  const [source] = await school.learningSources();
  assert.deepEqual(source.learningTarget, target); assert.deepEqual(source.courseTarget, courseTarget);
  const query = await school.querySource(identity);
  assert.deepEqual(query.target, target); assert.deepEqual(query.courses.owner, courseTarget);
  assert.deepEqual(await query.learning.list(identity), []);
  assert.deepEqual(await query.courses.listCourses(identity), { courses: [] });
  assert.equal(sourceReads, 2);
});
