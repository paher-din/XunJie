import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { question, completed, versionHeaders } from './support/installed-agent-v2.mjs';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';

const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
if (!resources.postgresBin) throw new Error('Requires native PostgreSQL 18.6.');

test('installed school settings share the Root pointer and independent Agent dispatches the chosen school/self/device owner', { timeout: 300000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xj-agent-model-selection-'));
  const school = openProductRuntime({ root: join(directory, 'school'), resources });
  const agent = openProductRuntime({ root: join(directory, 'agent'), resources });
  const device = openProductRuntime({ root: join(directory, 'device'), resources });
  const payloads = [];
  const upstream = createServer(async (request, response) => {
    const parts = []; for await (const part of request) parts.push(part);
    const payload = JSON.parse(Buffer.concat(parts)); payloads.push(payload);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: '+JSON.stringify({ choices: [{ index: 0, delta: { content: 'route:' + payload.model }, finish_reason: 'stop' }] })
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
    await device.install({ profile: 'local' });
    const schoolState = await school.start(), agentState = await agent.start(), deviceState = await device.start();
    const dataService = schoolState.environment.services.find(item => item.unit === 'learning-data');
    const agentService = agentState.environment.services.find(item => item.unit === 'teaching-agent');
    const modelService = deviceState.environment.services.find(item => item.unit === 'model-connection');
    assert.equal(deviceState.environment.services.some(item => item.unit === 'learning-data'), true);
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
    const interaction = await deviceApi('agent-settings', undefined, selected);
    assert.equal(interaction.busyInputMode, 'steering');
    const preferenceRequest = { requestId: randomUUID(), expectedVersion: interaction.version, busyInputMode: 'queue' };
    const preference = await deviceApi('agent-settings', preferenceRequest, selected);
    assert.deepEqual(await schoolApi('agent-settings'), preference, 'Installed school preferences belong to the actual learning owner.');
    assert.deepEqual(await deviceApi('agent-settings/receipts/' + preferenceRequest.requestId, undefined, selected), preference);
    assert.equal((await deviceApi('agent-settings', undefined, personal)).busyInputMode, 'steering', 'School and device personal settings are isolated.');
    const configuration = (connectionId, modelId) => ({ requestId: randomUUID(), connectionId, expectedVersion: 0,
      name: modelId, protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions',
      modelId, dialect: 'standard', parameterMode: 'plain', enabled: true, contextWindow: 262144, maxOutputTokens: 1024,
      credential: { action: 'replace', value: 'synthetic-model-selection-key' } });
    const schoolModelId = randomUUID(), personalModelId = randomUUID(), selfModelId = randomUUID(), localSchoolModelId = randomUUID();
    await schoolApi('manage/model-default', { ...configuration(schoolModelId, 'school-route'),
      policy: { checksAllowed: true, maxChecksPerHour: 6, maxOutputTokens: 2048, timeoutMs: 30000 } }, admin);
    let rootPointer = await schoolApi('models/selection', { requestId: randomUUID(), expectedVersion: 0,
      source: { kind: 'school', connectionId: schoolModelId } });
    // The installed school form must read the Root pointer before Agent warmup or any local selection.
    assert.deepEqual(await deviceApi('models/selection', undefined, selected), rootPointer);
    await deviceApi('models/connections', configuration(personalModelId, 'device-route'), personal);
    const personalPointer = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: 0,
      source: { kind: 'personal', connectionId: personalModelId, owner: 'self' } }, personal);
    assert.equal(personalPointer.selected.grantId, undefined);
    // Existing school-scope personal configurations remain on this installed device.
    const localConfiguration = await deviceApi('models/connections', configuration(localSchoolModelId, 'local-school-scope'), selected);
    const editedConfiguration = await deviceApi('models/connections', { ...configuration(localSchoolModelId, 'local-school-scope'),
      expectedVersion: localConfiguration.version, name: '设备原scope内编辑', credential: { action: 'keep' } }, selected);
    assert.equal((await deviceApi('models/connections', undefined, selected)).find(item => item.connectionId === localSchoolModelId)?.version,
      editedConfiguration.version, 'editing preserves the original device configuration owner');
    assert.ok(!(await schoolApi('models/connections')).some(item => item.connectionId === localSchoolModelId));
    const settings = await deviceApi('models/selection', undefined, selected);
    const rawSelf = settings.options.find(choice => choice.connection.connectionId === localSchoolModelId && !choice.grantId);
    assert.equal(rawSelf?.origin, 'self', 'the installed form retains the actual holder of its ungranted school-scope configuration');
    rootPointer = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: rootPointer.version,
      source: { kind: 'personal', connectionId: localSchoolModelId, owner: 'self' } }, selected);
    assert.equal((await schoolApi('models/selection')).selected.connection.connectionId, localSchoolModelId);
    assert.equal(rootPointer.selected.grantId, undefined);
    const rawDevice = settings.options.find(choice => choice.connection.connectionId === personalModelId && !choice.grantId);
    assert.equal(rawDevice?.origin, 'device');
    rootPointer = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: rootPointer.version,
      source: { kind: 'personal', connectionId: personalModelId, owner: 'device' } }, selected);
    assert.equal(rootPointer.selected.grantId, undefined);
    assert.equal(rootPointer.selected.origin, 'device');
    assert.deepEqual(await schoolApi('models/selection'), rootPointer);
    assert.deepEqual(await deviceApi('models/selection', undefined, personal), personalPointer);
    const session = await schoolApi('agent-sessions/workspace', { activityId: activity.activityId, target: activity.target });
    async function ask(expectedConnectionId, modelId) {
      const input = question(activity, session, '核对当前显式模型选择 ' + modelId);
      const receipt = await schoolApi(`agent-sessions/${session.sessionId}/inputs`, input);
      const conversation = await completed(schoolApi, session.sessionId, receipt.runId);
      const snapshot = await schoolApi(`agent-sessions/${session.sessionId}/snapshots/${receipt.runId}`);
      const step = snapshot.steps.find(step => step.operation.kind === 'model.call');
      assert.equal(step.result.value.attempt.connection.connectionId, expectedConnectionId);
      assert.ok(conversation.messages.some(message => message.text === 'route:' + modelId));
      assert.equal(payloads.at(-1).model, modelId, 'the SDK reaches the selected configuration');
      return { input, receipt, snapshot };
    }
    rootPointer = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: rootPointer.version,
      source: { kind: 'personal', connectionId: localSchoolModelId, owner: 'self' } }, selected);
    await ask(localSchoolModelId, 'local-school-scope');
    rootPointer = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: rootPointer.version,
      source: { kind: 'personal', connectionId: personalModelId, owner: 'device' } }, selected);
    const deviceRun = await ask(personalModelId, 'device-route');
    rootPointer = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: rootPointer.version,
      source: { kind: 'school', connectionId: schoolModelId } }, selected);
    assert.equal(rootPointer.selected.kind, 'school');
    assert.deepEqual(await schoolApi('models/selection'), rootPointer);
    // A device's personal pointer can change without overriding the school Root pointer.
    await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: personalPointer.version,
      source: { kind: 'personal', connectionId: personalModelId, owner: 'self' } }, personal);
    const schoolPointer = await deviceApi('models/selection', undefined, selected);
    assert.equal(schoolPointer.version, rootPointer.version); assert.deepEqual(schoolPointer.selected, rootPointer.selected);
    await ask(schoolModelId, 'school-route');
    // Root self is configured by the Root school webpage, not moved from the installed device.
    await schoolApi('models/connections', configuration(selfModelId, 'root-self-route'));
    assert.ok((await schoolApi('models/connections')).some(item => item.connectionId === selfModelId));
    rootPointer = await schoolApi('models/selection', { requestId: randomUUID(), expectedVersion: rootPointer.version,
      source: { kind: 'personal', connectionId: selfModelId, owner: 'self' } });
    await ask(selfModelId, 'root-self-route');
    rootPointer = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: rootPointer.version,
      source: { kind: 'personal', connectionId: personalModelId, owner: 'device' } }, selected);
    const fixedDeviceRun = deviceRun;
    rootPointer = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: rootPointer.version,
      source: { kind: 'school', connectionId: schoolModelId } }, selected);
    await agent.stop(); await agent.start();
    const snapshotRoute = `agent-sessions/${session.sessionId}/snapshots/${fixedDeviceRun.receipt.runId}`;
    const retainedRun = await schoolApi(snapshotRoute);
    assert.deepEqual(retainedRun.steps, fixedDeviceRun.snapshot.steps,
      'later selection and Agent restart cannot retarget the original model operation');
    assert.deepEqual(retainedRun.run, fixedDeviceRun.snapshot.run);
    assert.equal(payloads.length, 4, 'changing selection never dispatches a hidden model call');
    assert.equal((await deviceApi('models/selection', undefined, personal)).selected.connection.connectionId, personalModelId);
    await device.stop(); await device.start();
    assert.deepEqual((await deviceApi(snapshotRoute, undefined, selected)).steps, fixedDeviceRun.snapshot.steps);
    const schoolSelectionBeforeControls = await schoolApi('models/selection');
    const personalSelectionBeforeControls = await deviceApi('models/selection', undefined, personal);
    const base = `agent-sessions/${session.sessionId}`;
    const originalInput = (await schoolApi(`${base}/conversation`)).inputs.at(-1);
    const edited = await fetch(deviceState.endpoint + '/api/learning/' + base + '/inputs/' + originalInput.inputId + '/control', {
      method: 'POST', headers: { 'content-type': 'application/json', ...versionHeaders(base), ...selected },
      body: JSON.stringify({ requestId: randomUUID(), expectedVersion: originalInput.version, operation: 'edit', text: 'late mutation' }) });
    assert.equal(edited.status, 409, 'adopted input remains immutable');
    const malformed = await fetch(deviceState.endpoint + '/api/learning/' + base + '/runs/' + originalInput.runId + '/continue', {
      method: 'POST', headers: { 'content-type': 'application/json', ...versionHeaders(base), ...selected },
      body: JSON.stringify({ requestId: randomUUID(), inputs: [] }) });
    assert.equal(malformed.status, 400, 'a control cannot smuggle replacement inputs');
    assert.equal(payloads.length, 4);
    assert.deepEqual(await schoolApi('models/selection'), schoolSelectionBeforeControls);
    assert.deepEqual(await deviceApi('models/selection', undefined, personal), personalSelectionBeforeControls);
    assert.deepEqual(schoolSelectionBeforeControls.options.filter(choice => choice.grantId), [],
      'selecting an owner does not silently create a model grant');
    assert.deepEqual(personalSelectionBeforeControls.options.filter(choice => choice.grantId), []);
    // Grants have public creation/revocation receipts, rather than a GET collection route.
    for (const [api, headers, connection] of [[schoolApi, memberHeaders, selfModelId], [deviceApi, personal, personalModelId]]) {
      const create = { requestId: randomUUID(), grantId: randomUUID(), connectionId: connection, owner: 'self' };
      const granted = await api('models/grants', create, headers);
      assert.equal(granted.grantId, create.grantId); assert.equal(granted.connectionId, connection);
      assert.equal(granted.active, true); assert.equal(granted.version, 1);
      assert.deepEqual(await api('models/grants', create, headers), granted);
      assert.ok((await api('models/selection', undefined, headers)).options.some(choice => choice.grantId === granted.grantId));
      const revoke = { requestId: randomUUID(), expectedVersion: granted.version };
      const route = `models/grants/${granted.grantId}/revoke`;
      const revoked = await api(route, revoke, headers);
      assert.deepEqual(revoked, { ...granted, version: 2, active: false });
      assert.deepEqual(await api(route, revoke, headers), revoked, 'a retried revocation returns its original receipt');
      assert.ok(!(await api('models/selection', undefined, headers)).options.some(choice => choice.grantId === granted.grantId));
    }
    assert.deepEqual(await schoolApi('models/selection'), schoolSelectionBeforeControls);
    assert.deepEqual(await deviceApi('models/selection', undefined, personal), personalSelectionBeforeControls);
    assert.deepEqual((await schoolApi(snapshotRoute)).steps, fixedDeviceRun.snapshot.steps);
    assert.equal(payloads.length, 4, 'rejected controls and grant receipts never dispatch another model request');

  } finally {
    await Promise.allSettled([agent.stop(), device.stop(), school.stop()]);
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
