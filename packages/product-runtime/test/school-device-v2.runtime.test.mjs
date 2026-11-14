import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { createSpaces, createCourses, createLearningData, createMemberAgentBindings, learningMigrations, spaceCourseMigrations } from '@xunjie/learning-space';
import { createAgentSessions } from '@xunjie/learning-space/learning-data/agent-sessions';
import { createAgentDependencyChannel, createAgentDependencyClient } from '@xunjie/agents/transport/session-dependencies';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createConnectionAuthority, createOutboundConnection } from '../dist/connections.js';
import { createSchoolDeviceSetup, authorizeSchoolDeviceGrant } from '../dist/school-device-setup.js';

test('native v2 pairing issues fixed grants to the actual dependency service and refuses a legacy binding without replacing its owner', { timeout: 60000 }, async t => {
  const pg = await nativeFixture(), handles = []; let server;
  t.after(async () => {
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const storage of handles.reverse()) await storage.close(); await pg.close();
  });
  const environmentId = randomUUID(), root = join(pg.root, 'school');
  await mkdir(join(root, 'credentials'), { recursive: true });
  async function owner(name, migrations) {
    const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations });
    const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: name, root: join(pg.root, name) }) });
    handles.push(storage); return storage;
  }
  const space = await owner('space', spaceCourseMigrations), data = await owner('data', learningMigrations);
  const spaces = createSpaces(space), courses = createCourses(space, spaces), bindings = createMemberAgentBindings(space, spaces.authorize);
  const password = randomUUID(), loginName = 'pair-' + randomUUID();
  const identity = await spaces.createMember({ requestId: randomUUID(), loginName, password });
  const target = { ...data.owner, version: 1 }; await spaces.bindMember(identity, target);
  const login = await spaces.login(loginName, password), connectionId = randomUUID(), verifier = randomUUID() + randomUUID();
  await spaces.beginConnection({ requestId: connectionId, clientId: randomUUID(), challenge: createHash('sha256').update(verifier).digest('base64url') });
  await spaces.approveConnection(login.token, connectionId);
  await spaces.exchangeConnection(connectionId, verifier);
  let authority;
  server = createServer((request, response) => {
    void authority.handle(request, response).then(handled => { if (!handled) { response.writeHead(404); response.end(); } }).catch(() => response.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const service = { ...data.owner, unit: 'learning-data', protocolVersion: 1,
    endpoint: `http://127.0.0.1:${server.address().port}`, capabilities: ['agent.dependencies.v2'] };
  const learning = createLearningData(data, spaces);
  const sessions = createAgentSessions(data, { authorize: spaces.authorize, openActivity: learning.open,
    async resolveOwner(who) { const binding = await bindings.read(who); if (!binding) throw new StorageError('missing'); return binding; } });
  const channel = createAgentDependencyChannel(data, { sessions, learning, courses,
    async authorize(who, source) { await spaces.authorize(who); await authorizeSchoolDeviceGrant(root, spaces, who, source.grantId);
      await bindings.authorizeSource(who, source); },
    async resolveOwner(who) { const binding = await bindings.read(who); if (!binding) throw new StorageError('missing'); return binding; },
    source: async who => ({ sourceId: 'school', identity: who, target, learning,
      courses: { owner: { ...space.owner, version: 1 }, listCourses: courses.listCourses, readRelease: courses.readRelease } }),
    assertDispatch: async () => { throw new StorageError('forbidden'); },
  });
  authority = createConnectionAuthority({ root, service, handlers: { 'agent.dependencies.v2': async (value, source) => {
    try { return await channel.handle(value, source); } catch (error) { if (error instanceof StorageError) return { error: error.code }; throw error; }
  } } });
  const deviceEnvironment = randomUUID();
  const module = (unit, capabilities = []) => ({ environmentId: deviceEnvironment, serviceId: randomUUID(), unit,
    endpoint: 'http://127.0.0.1:1', protocolVersion: 1, capabilities });
  const deviceModules = [module('space-course'), module('teaching-agent', ['agent.sessions.v2']), module('model-connection'), module('tool-execution')];
  const input = { version: 2, connectionId, installationId: randomUUID(), deviceModules };
  const setup = createSchoolDeviceSetup({ root, target: service, spaces, bindings, authority, assertWritable: async () => {} });
  const result = await setup(identity, input);
  assert.equal(result.version, 2); assert.deepEqual(result.target.capabilities, ['agent.dependencies.v2']);
  assert.deepEqual(await setup({ ...identity, name: 'Changed display name' }, input), result);
  const original = await bindings.read(identity);
  assert.deepEqual(original.target.capabilities, ['agent.sessions.v2']);
  const agent = deviceModules.find(item => item.unit === 'teaching-agent');
  const transport = createOutboundConnection({ connection: { connectionId: randomUUID(), sourceEnvironmentId: agent.environmentId,
    sourceServiceId: agent.serviceId, target: service, requiredCapabilities: ['agent.dependencies.v2'], optionalCapabilities: [], credentialRef: 'fixture' },
    credential: async () => result.agent.token, allowInsecureLoopback: true });
  const client = createAgentDependencyClient(call => transport.request('agent.dependencies.v2', call));
  assert.deepEqual((await client.source.describe(identity)).courseTarget, { ...space.owner, version: 1 });
  const activity = await learning.create(identity, { requestId: randomUUID(), goal: 'paired workspace', question: '', references: [] });
  const sessionId = randomUUID();
  await client.sessions.create(identity, { sessionId, requestId: randomUUID(), scenario: 'workspace-assistant', workspace: { activityId: activity.activityId, target } });
  assert.equal((await client.forSession(identity, sessionId).workspace()).activityId, activity.activityId);
  await assert.rejects(bindings.bind({ requestId: randomUUID(), identity, connectionId, installationId: input.installationId,
    target: { ...agent, capabilities: ['teaching.agent'] } }), { code: 'incompatible' });
  assert.deepEqual(await bindings.read(identity), original);
  await spaces.revokeConnection(identity, connectionId);
  await assert.rejects(client.sessions.read(identity, sessionId), { code: 'forbidden' });
});
