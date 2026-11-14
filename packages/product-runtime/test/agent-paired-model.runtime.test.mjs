import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { question, versionHeaders, completed } from './support/installed-agent-v2.mjs';
import { openProductRuntime, resolveCredential, createOutboundConnection } from '@xunjie/product-runtime';
import { createChunkClient } from '@xunjie/storage/chunk-channel';
import { createAgentDependencyClient } from '@xunjie/agents/transport/session-dependencies';

const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
if (!resources.postgresBin) throw new Error('Requires native PostgreSQL 18.6.');

for (const profile of ['model', 'local']) test(`a separate Agent uses an actively paired ${profile} device while activity ownership stays at school`, { timeout: 300000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xj-agent-paired-model-'));
  const school = openProductRuntime({ root: join(directory, 'school'), resources });
  const agent = openProductRuntime({ root: join(directory, 'agent'), resources });
  const device = openProductRuntime({ root: join(directory, 'device'), resources });
  const payloads = [];
  const upstream = createServer(async (request, response) => {
    const parts = []; for await (const part of request) parts.push(part);
    payloads.push(JSON.parse(Buffer.concat(parts)));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: '+JSON.stringify({ choices: [{ index: 0, delta: { content: '来自获准设备模型的回答' }, finish_reason: 'stop' }] })
      +'\n\ndata: '+JSON.stringify({ choices: [], usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 } })+'\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const request = async (endpoint, route, body, headers = {}) => {
    const response = await fetch(endpoint+'/api/learning/'+route, { headers: { 'content-type': 'application/json', ...versionHeaders(route), ...headers },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.equal(response.status, 200, route+': '+JSON.stringify(value));
    return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    const dependencyConnectionId = randomUUID(), agentConnectionId = randomUUID();
    await school.install({ profile: 'local' });
    await agent.install({ profile: 'agent', agent: { dependencyConnectionId } });
    await device.install({ profile });
    const schoolState = await school.start(), agentState = await agent.start(), deviceState = await device.start();
    const dataService = schoolState.environment.services.find(item => item.unit === 'learning-data');
    const agentService = agentState.environment.services.find(item => item.unit === 'teaching-agent');
    const modelService = deviceState.environment.services.find(item => item.unit === 'model-connection');
    assert.equal(deviceState.environment.services.some(item => item.unit === 'learning-data'), profile === 'local');
    const admin = { authorization: 'Bearer '+await resolveCredential(join(directory, 'school'), 'control') };
    const deviceAdmin = { authorization: 'Bearer '+await resolveCredential(join(directory, 'device'), 'control') };
    const loginName = 'paired-agent-'+randomUUID(), password = randomUUID();
    const identity = (await request(schoolState.endpoint, 'manage/members', { requestId: randomUUID(), loginName, password }, admin)).value;
    const login = await request(schoolState.endpoint, 'login', { loginName, password });
    const memberHeaders = { cookie: login.cookie, 'x-xj-space': 'school' };
    const schoolApi = async (route, body, headers = memberHeaders) => (await request(schoolState.endpoint, route, body, headers)).value;
    const deviceApi = async (route, body, headers = {}) => (await request(deviceState.endpoint, route, body, headers)).value;
    const activity = await schoolApi('activities', { requestId: randomUUID(), goal: '学校作品与本机模型', question: '', references: [] });
    assert.equal(activity.target.serviceId, dataService.serviceId);
    const acceptGrant = await agent.authorize({ sourceEnvironmentId: dataService.environmentId, sourceServiceId: dataService.serviceId,
      sourceInstallationId: schoolState.environment.installationId, capabilities: ['agent.sessions.v2'] }, agentService.serviceId);
    await school.connect({ connectionId: agentConnectionId, sourceEnvironmentId: dataService.environmentId, sourceServiceId: dataService.serviceId,
      target: agentService, requiredCapabilities: ['agent.sessions.v2'], optionalCapabilities: [], credentialRef: 'paired-agent' }, acceptGrant.token);
    await schoolApi('manage/agent-binding', { requestId: randomUUID(), identity, connectionId: agentConnectionId,
      target: agentService, installationId: agentState.environment.installationId }, admin);
    const dependencyGrant = await school.authorize({ sourceEnvironmentId: agentService.environmentId, sourceServiceId: agentService.serviceId,
      sourceInstallationId: agentState.environment.installationId, capabilities: ['agent.dependencies.v2'] }, dataService.serviceId);
    await agent.connect({ connectionId: dependencyConnectionId, sourceEnvironmentId: agentService.environmentId, sourceServiceId: agentService.serviceId,
      target: dataService, requiredCapabilities: ['agent.dependencies.v2'], optionalCapabilities: [], credentialRef: 'paired-dependencies' }, dependencyGrant.token);
    const connectionId = randomUUID();
    await deviceApi('client/start', { requestId: connectionId, schoolEndpoint: schoolState.endpoint });
    await schoolApi('connections/approve', { requestId: connectionId });
    await deviceApi('client/complete', { requestId: connectionId });
    const runtimeConnectionId = randomUUID(), modelTarget = { environmentId: modelService.environmentId, serviceId: modelService.serviceId, version: 1 };
    const modelGrant = await school.authorize({ sourceEnvironmentId: modelService.environmentId, sourceServiceId: modelService.serviceId,
      sourceInstallationId: deviceState.environment.installationId, capabilities: ['learning.authority'] });
    await device.connect({ connectionId: runtimeConnectionId, sourceEnvironmentId: modelService.environmentId, sourceServiceId: modelService.serviceId,
      target: schoolState.environment.services[0], requiredCapabilities: ['learning.authority'], optionalCapabilities: [], credentialRef: 'model-school-authority' }, modelGrant.token);
    await schoolApi('manage/model-device-binding', { identity, binding: { requestId: randomUUID(), expectedVersion: 0,
      owner: { environmentId: modelTarget.environmentId, serviceId: modelTarget.serviceId }, installationId: deviceState.environment.installationId,
      grantId: modelGrant.grantId, connectionId } }, admin);
    await deviceApi('manage/model-binding', { connectionId, runtimeConnectionId, target: modelTarget }, deviceAdmin);
    const personal = { 'x-xj-space': 'personal' }, selected = { 'x-xj-space': 'school:'+connectionId };
    const modelConnectionId = randomUUID(), useGrantId = randomUUID();
    await deviceApi('models/connections', { requestId: randomUUID(), connectionId: modelConnectionId, expectedVersion: 0,
      name: '设备持有的个人模型', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      path: '/chat/completions', modelId: 'paired-learning-fixture', dialect: 'standard', parameterMode: 'plain', enabled: true,
      contextWindow: 262144, maxOutputTokens: 1024, credential: { action: 'replace', value: 'synthetic-paired-agent-key' } }, personal);
    await deviceApi('models/grants', { requestId: randomUUID(), grantId: useGrantId, connectionId: modelConnectionId, owner: 'device' }, selected);
    // Open the formal school settings before ANY activity/Agent capabilities call.
    // Publishing options cannot select a model or warm an Agent route as a side effect.
    const rootOptions = await schoolApi('models/selection');
    assert.equal(rootOptions.version, 0); assert.equal(rootOptions.selected, null);
    assert.ok(rootOptions.options.some(choice => choice.kind === 'personal' && choice.grantId === useGrantId
      && choice.connection.connectionId === modelConnectionId), 'school settings discovers the paired device without Agent warmup');
    const rootSelection = await schoolApi('models/selection', { requestId: randomUUID(), expectedVersion: rootOptions.version,
      source: { kind: 'personal', connectionId: modelConnectionId, grantId: useGrantId } });
    assert.equal(rootSelection.version, 1);
    assert.equal(rootSelection.selected.connection.connectionId, modelConnectionId);
    const deviceView = await deviceApi('models/selection', undefined, selected);
    assert.equal(deviceView.version, rootSelection.version);
    assert.deepEqual(deviceView.selected, rootSelection.selected);
    // The installed product's existing selection form must write the same Root pointer.
    const deviceSelection = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: rootSelection.version,
      source: { kind: 'personal', connectionId: modelConnectionId, grantId: useGrantId } }, selected);
    assert.equal(deviceSelection.version, 2);
    assert.deepEqual(await schoolApi('models/selection'), deviceSelection);
    const session = await schoolApi('agent-sessions/workspace', { activityId: activity.activityId, target: activity.target });
    const input = question(activity, session, '请用当前获准个人模型解释原活动');
    const receipt = await schoolApi(`agent-sessions/${session.sessionId}/inputs`, input);
    const conversation = await completed(schoolApi, session.sessionId, receipt.runId);
    const snapshot = await schoolApi(`agent-sessions/${session.sessionId}/snapshots/${receipt.runId}`);
    const step = snapshot.steps.find(step => step.operation.kind === 'model.call');
    assert.equal(step.result.value.attempt.connection.connectionId, modelConnectionId);
    assert.equal(conversation.messages.filter(item => item.role === 'assistant').at(-1).text, '来自获准设备模型的回答');
    assert.equal(payloads.length, 1);
    await device.stop(); await device.start();
    assert.deepEqual(await schoolApi(`agent-sessions/${session.sessionId}/conversation`), conversation,
      'Model owner restart preserves the original completed activity record.');
    const originalQuery = createOutboundConnection({ connection: { connectionId: dependencyConnectionId,
      sourceEnvironmentId: agentService.environmentId, sourceServiceId: agentService.serviceId, target: dataService,
      requiredCapabilities: ['agent.dependencies.v2'], optionalCapabilities: [], credentialRef: 'paired-dependencies' },
      credential: async () => dependencyGrant.token, allowInsecureLoopback: true, timeoutMs: 15000 });
    const originalDependencies = createAgentDependencyClient(createChunkClient(call => originalQuery.request('agent.dependencies.v2', call)));
    const originalAttempt = await originalDependencies.forSession(identity, session.sessionId).models.checks.read(identity, step.operation.operationId);
    assert.equal(originalAttempt.state, 'completed');
    assert.equal(originalAttempt.attemptId, step.operation.operationId);
    assert.equal(payloads.length, 1, 'reopening the original result never creates a model call');
    assert.equal((await schoolApi('activities/'+activity.activityId)).target.serviceId, dataService.serviceId);
    assert.deepEqual(await schoolApi(`agent-sessions/${session.sessionId}/requests/${input.requestId}`), { receipt, input });
  } finally {
    await Promise.allSettled([agent.stop(), device.stop(), school.stop()]);
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
