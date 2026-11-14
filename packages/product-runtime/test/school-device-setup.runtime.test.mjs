import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { createAgentDependencyClient } from '@xunjie/agents/transport/session-dependencies';
import { StorageError } from '@xunjie/storage';
import { createOutboundConnection } from '@xunjie/product-runtime/connections';

const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6',
  webRoot: process.env.XUNJIE_PRODUCT_WEB_ROOT ?? fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
if (!resources.postgresBin) throw new Error('Requires native PostgreSQL 18.6.');
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('school device setup retries safely and isolates approved member connections', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xj-school-device-setup-'));
  const schoolRoot = join(directory, 'school'), deviceRoot = join(directory, 'device'), secondRoot = join(directory, 'second');
  const school = openProductRuntime({ root: schoolRoot, resources });
  const device = openProductRuntime({ root: deviceRoot, resources });
  const second = openProductRuntime({ root: secondRoot, resources });
  let proxy, dropSetupResponse = true, dropped = false;
  try {
    await school.install({ profile: 'school', deployment: { formatVersion: 1, modules: ['space-course', 'learning-data'], dependencies: {} } });
    const deviceDeployment = { formatVersion: 1, modules: ['space-course', 'teaching-agent', 'model-connection', 'tool-execution'], dependencies: {} };
    await device.install({ profile: 'local', deployment: deviceDeployment });
    await second.install({ profile: 'local', deployment: deviceDeployment });
    const schoolState = await school.start(), deviceState = await device.start(), secondState = await second.start();
    proxy = createServer((req, res) => {
      const upstream = httpRequest(new URL(req.url, schoolState.endpoint), { method: req.method, headers: req.headers }, reply => {
        if (dropSetupResponse && req.url === '/api/learning/connections/device-setup') {
          dropSetupResponse = false; dropped = true;
          reply.resume();
          reply.on('end', () => res.destroy());
          return;
        }
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      });
      upstream.on('error', () => res.destroy());
      req.pipe(upstream);
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyEndpoint = `http://127.0.0.1:${proxy.address().port}`;
    const api = async (endpoint, route, body, headers = {}, status = 200) => {
      const response = await fetch(endpoint + '/api/learning/' + route, { method: 'POST',
        headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      const value = await response.json();
      assert.equal(response.status, status, route);
      return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    const schoolApi = (route, body, headers, status) => api(schoolState.endpoint, route, body, headers, status);
    const deviceApi = (route, body, headers, status) => api(deviceState.endpoint, route, body, headers, status);
    const admin = { authorization: `Bearer ${await resolveCredential(schoolRoot, 'control')}` };
    async function member() {
      const loginName = 'member-' + randomUUID(), password = randomUUID();
      const identity = (await schoolApi('manage/members', { requestId: randomUUID(), loginName, password }, admin)).value;
      const login = await schoolApi('login', { loginName, password });
      return { identity, headers: { cookie: login.cookie, 'x-xj-space': 'school' } };
    }
    const first = await member(), foreign = await member();
    const connectionId = randomUUID();
    await deviceApi('client/start', { requestId: connectionId, schoolEndpoint: proxyEndpoint });
    await schoolApi('connections/approve', { requestId: connectionId }, first.headers);
    await deviceApi('client/complete', { requestId: connectionId }, {}, 503);
    assert.equal(dropped, true, 'the school committed setup before the response was dropped');
    const firstJournal = JSON.parse(await resolveCredential(schoolRoot, 'school-device-setup-' + connectionId));
    const partial = JSON.parse(await resolveCredential(deviceRoot, 'school-client-' + connectionId));
    assert.equal(partial.setupPending, true);
    await deviceApi('client/complete', { requestId: connectionId });
    const client = JSON.parse(await resolveCredential(deviceRoot, 'school-client-' + connectionId));
    assert.equal(client.setupPending, false);
    assert.ok(client.agentBinding.dependencyConnectionId);
    assert.ok(client.agentBinding.executionConnectionId);
    assert.equal(fingerprint(JSON.parse(await resolveCredential(schoolRoot, 'school-device-setup-' + connectionId)).result), fingerprint(firstJournal.result));
    const bearer = token => ({ authorization: `Bearer ${token}` });
    const input = { version: 2, connectionId, installationId: deviceState.environment.installationId,
      deviceModules: deviceState.environment.services.filter(service => service.unit !== 'client') };
    const setup = async (body, token, status = 200) => (await schoolApi('connections/device-setup', body, bearer(token), status)).value;
    assert.equal(firstJournal.result.version, 2);
    assert.equal(client.grant.deviceSetup.version, 2);
    assert.equal((await setup({ ...input, version: 1 }, client.grant.token, 409)).error, 'incompatible');
    assert.equal((await setup({ ...input, deviceModules: input.deviceModules.map(item => item.unit === 'teaching-agent'
      ? { ...item, capabilities: ['teaching.agent'] } : item) }, client.grant.token, 409)).error, 'incompatible');
    assert.equal(fingerprint(await setup(input, client.grant.token)), fingerprint(firstJournal.result));
    assert.equal((await setup({ ...input, installationId: randomUUID() }, client.grant.token, 409)).error, 'identity-conflict');
    const changedPayload = { ...input, deviceModules: input.deviceModules.map((service, index) => index === 0
      ? { ...service, endpoint: 'http://127.0.0.1:65533' } : service) };
    assert.equal((await setup(changedPayload, client.grant.token, 409)).error, 'identity-conflict');
    await schoolApi('connections/device-setup', input, {}, 403);
    await schoolApi('connections/device-setup', { ...input, connectionId: randomUUID() }, bearer(client.grant.token), 403);
    async function approve(member) {
      const requestId = randomUUID(), verifier = randomUUID() + randomUUID();
      await schoolApi('connections/start', { requestId, clientId: randomUUID(), challenge: createHash('sha256').update(verifier).digest('base64url') });
      await schoolApi('connections/approve', { requestId }, member.headers);
      return (await schoolApi('connections/exchange', { requestId, verifier })).value;
    }
    const secondConnection = await approve(first);
    const secondInput = { version: 2, connectionId: secondConnection.connectionId, installationId: secondState.environment.installationId,
      deviceModules: secondState.environment.services.filter(service => service.unit !== 'client') };
    assert.equal((await setup(secondInput, secondConnection.token, 409)).error, 'identity-conflict');
    assert.equal(fingerprint(await setup(input, client.grant.token)), fingerprint(firstJournal.result), 'conflicting device leaves the first binding intact');
    const foreignConnection = await approve(foreign);
    const foreignInput = { ...input, connectionId: foreignConnection.connectionId };
    const foreignSetup = await setup(foreignInput, foreignConnection.token);
    assert.notEqual(foreignSetup.agent.grantId, firstJournal.result.agent.grantId);
    await schoolApi('connections/device-setup', input, bearer(foreignConnection.token), 403);
    const firstActivity = (await schoolApi('activities', { requestId: randomUUID(), goal: 'first member', question: '', references: [] }, first.headers)).value;
    const foreignActivity = (await schoolApi('activities', { requestId: randomUUID(), goal: 'foreign member', question: '', references: [] }, foreign.headers)).value;
    const source = input.deviceModules.find(service => service.unit === 'teaching-agent');
    function dependency(grant) {
      return createOutboundConnection({ connection: { connectionId: randomUUID(), sourceEnvironmentId: source.environmentId,
        sourceServiceId: source.serviceId, target: firstJournal.result.target, requiredCapabilities: ['agent.dependencies.v2'],
        optionalCapabilities: [], credentialRef: 'fixture' }, credential: async () => grant.token, allowInsecureLoopback: true });
    }
    const firstDependency = dependency(firstJournal.result.agent), foreignDependency = dependency(foreignSetup.agent);
    const requests = new Map();
    const read = async (transport, identity, activityId) => {
      const key = identity.principalId + ':' + activityId;
      if (!requests.has(key)) requests.set(key, { sessionId: randomUUID(), requestId: randomUUID() });
      const fixed = requests.get(key);
      const client = createAgentDependencyClient(call => transport.request('agent.dependencies.v2', call));
      try {
        await client.sessions.create(identity, { ...fixed, scenario: 'workspace-assistant',
          workspace: { activityId, target: { environmentId: firstJournal.result.target.environmentId,
            serviceId: firstJournal.result.target.serviceId, version: 1 } } });
        return await client.forSession(identity, fixed.sessionId).workspace();
      } catch (error) { if (error instanceof StorageError) return { error: error.code }; throw error; }
    };
    assert.equal((await read(firstDependency, first.identity, firstActivity.activityId)).activityId, firstActivity.activityId);
    assert.equal((await read(foreignDependency, foreign.identity, foreignActivity.activityId)).activityId, foreignActivity.activityId);
    assert.deepEqual(await read(firstDependency, foreign.identity, foreignActivity.activityId), { error: 'forbidden' });
    assert.deepEqual(await read(foreignDependency, first.identity, firstActivity.activityId), { error: 'forbidden' });
    await schoolApi('connections/revoke', { connectionId }, first.headers);
    assert.deepEqual(await read(firstDependency, first.identity, firstActivity.activityId), { error: 'forbidden' });
    assert.equal((await read(foreignDependency, foreign.identity, foreignActivity.activityId)).activityId, foreignActivity.activityId);
    await schoolApi('connections/device-setup', input, bearer(client.grant.token), 403);
    const replacement = await setup(secondInput, secondConnection.token);
    assert.equal(replacement.connectionId, secondConnection.connectionId, 'an explicitly revoked device does not block its replacement');
    assert.notEqual(replacement.agent.grantId, firstJournal.result.agent.grantId);
    assert.deepEqual(await read(firstDependency, first.identity, firstActivity.activityId), { error: 'forbidden' }, 'replacement cannot revive the old credential');
    await school.revoke(foreignSetup.agent.grantId, foreignSetup.target.serviceId);
    await assert.rejects(read(foreignDependency, foreign.identity, foreignActivity.activityId));
    await schoolApi('connections/device-setup', foreignInput, bearer(foreignConnection.token), 503);
  } finally {
    await Promise.allSettled([device.stop(), second.stop(), school.stop()]);
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
    await rm(directory, { recursive: true, force: true });
  }
});
