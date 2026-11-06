import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
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
    const response = await fetch(endpoint+'/api/learning/'+route, { headers: { 'content-type': 'application/json', ...headers },
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
      sourceInstallationId: schoolState.environment.installationId, capabilities: ['teaching.agent'] }, agentService.serviceId);
    await school.connect({ connectionId: agentConnectionId, sourceEnvironmentId: dataService.environmentId, sourceServiceId: dataService.serviceId,
      target: agentService, requiredCapabilities: ['teaching.agent'], optionalCapabilities: [], credentialRef: 'paired-agent' }, acceptGrant.token);
    await schoolApi('manage/agent-binding', { requestId: randomUUID(), identity, connectionId: agentConnectionId,
      target: agentService, installationId: agentState.environment.installationId }, admin);
    const dependencyGrant = await school.authorize({ sourceEnvironmentId: agentService.environmentId, sourceServiceId: agentService.serviceId,
      sourceInstallationId: agentState.environment.installationId, capabilities: ['teaching.dependencies'] }, dataService.serviceId);
    await agent.connect({ connectionId: dependencyConnectionId, sourceEnvironmentId: agentService.environmentId, sourceServiceId: agentService.serviceId,
      target: dataService, requiredCapabilities: ['teaching.dependencies'], optionalCapabilities: [], credentialRef: 'paired-dependencies' }, dependencyGrant.token);
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
    const personalGrantId = randomUUID();
    const personalGrant = await deviceApi('models/grants', { requestId: randomUUID(), grantId: personalGrantId,
      connectionId: personalModelId, owner: 'self' }, personal);
    const personalPointer = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: 0,
      source: { kind: 'personal', connectionId: personalModelId, grantId: personalGrantId } }, personal);
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
    const localGrantId = randomUUID();
    await deviceApi('models/grants', { requestId: randomUUID(), grantId: localGrantId, connectionId: localSchoolModelId,
      owner: rawSelf.origin === 'device' ? 'device' : 'self' }, selected);
    // No reload between grants and selection: this is the real choose() sequence.
    rootPointer = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: rootPointer.version,
      source: { kind: 'personal', connectionId: localSchoolModelId, grantId: localGrantId } }, selected);
    assert.equal((await schoolApi('models/selection')).selected.grantId, localGrantId);
    assert.ok((await deviceApi('models/connections', undefined, selected)).some(item => item.connectionId === localSchoolModelId),
      'authorizing/selecting a configuration never moves it to Root or removes it from the original settings list');
    const rawDevice = settings.options.find(choice => choice.connection.connectionId === personalModelId && !choice.grantId);
    assert.equal(rawDevice?.origin, 'device');
    const deviceGrantId = randomUUID();
    const deviceGrant = await deviceApi('models/grants', { requestId: randomUUID(), grantId: deviceGrantId,
      connectionId: personalModelId, owner: 'device' }, selected);
    assert.deepEqual(deviceGrant.owner, personalGrant.owner, 'the credential owner remains the device personal identity');
    assert.equal(deviceGrant.recipient.principalId, identity.principalId);
    // Match ModelSelection.choose: grant acknowledgement is followed immediately by pointer save, without reload.
    rootPointer = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: rootPointer.version,
      source: { kind: 'personal', connectionId: personalModelId, grantId: deviceGrantId } }, selected);
    assert.ok(rootPointer.options.some(choice => choice.grantId === deviceGrantId), 'grant creation publishes choices before pointer save');
    assert.equal(rootPointer.selected.origin, 'device');
    assert.deepEqual(await schoolApi('models/selection'), rootPointer);
    assert.deepEqual(await deviceApi('models/selection', undefined, personal), personalPointer);
    async function ask(expectedConnectionId, modelId) {
      const capability = await schoolApi(`agent/${activity.activityId}/capabilities`);
      assert.equal(capability.modelAvailable, true, JSON.stringify(capability));
      const requestId = randomUUID();
      await schoolApi(`intents/${activity.activityId}`, { requestId, receiver: capability.receiver,
        scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId,
          activityId: activity.activityId }, draft: { token: randomUUID(), question: '核对当前显式模型选择 '+modelId,
          references: [], bases: [] }, works: [], evidence: [] });
      assert.equal((await schoolApi(`intents/${activity.activityId}/${requestId}/dispatch`, {})).state, 'accepted');
      const until = Date.now()+90000; let run, conversation;
      do {
        conversation = await schoolApi(`agent/${activity.activityId}/conversation`);
        run = conversation.runs.find(item => item.requestId === requestId);
        if (run && ['completed','failed','paused','stopped'].includes(run.state)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now()<until);
      assert.equal(run?.state, 'completed', JSON.stringify(conversation));
      assert.equal(run.model.connectionId, expectedConnectionId);
      assert.ok(conversation.messages.some(message => message.text === 'route:'+modelId));
      assert.equal(payloads.at(-1).model, modelId, 'the actual SDK reaches the selected owner/configuration');
      return run;
    }
    async function switchTo(connectionId) {
      const input = { requestId: randomUUID(), selectionVersion: rootPointer.version };
      const route = `agent/${activity.activityId}/model-switches`;
      const result = await deviceApi(route, input, selected);
      assert.equal(result.state, 'completed', JSON.stringify(result));
      assert.equal(result.model.connectionId, connectionId);
      assert.deepEqual(await deviceApi(route, input, selected), result);
      return { input, result, route };
    }
    await ask(personalModelId, 'device-route');
    rootPointer = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: rootPointer.version,
      source: { kind: 'school', connectionId: schoolModelId } }, selected);
    assert.equal(rootPointer.selected.kind, 'school');
    assert.deepEqual(await schoolApi('models/selection'), rootPointer);
    // A device's personal pointer can change without overriding the school Root pointer.
    await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: personalPointer.version,
      source: { kind: 'personal', connectionId: personalModelId, grantId: personalGrantId } }, personal);
    const schoolPointer = await deviceApi('models/selection', undefined, selected);
    assert.equal(schoolPointer.version, rootPointer.version); assert.deepEqual(schoolPointer.selected, rootPointer.selected);
    await switchTo(schoolModelId);
    await ask(schoolModelId, 'school-route');
    // Root self is configured by the Root school webpage, not moved from the installed device.
    await schoolApi('models/connections', configuration(selfModelId, 'root-self-route'));
    assert.ok((await schoolApi('models/connections')).some(item => item.connectionId === selfModelId));
    const selfGrantId = randomUUID();
    const selfGrant = await schoolApi('models/grants', { requestId: randomUUID(), grantId: selfGrantId,
      connectionId: selfModelId, owner: 'self' });
    assert.deepEqual(selfGrant.owner, identity, 'self in a school space belongs to the Root model owner');
    rootPointer = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: rootPointer.version,
      source: { kind: 'personal', connectionId: selfModelId, grantId: selfGrantId } }, selected);
    await switchTo(selfModelId);
    await ask(selfModelId, 'root-self-route');
    rootPointer = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: rootPointer.version,
      source: { kind: 'personal', connectionId: personalModelId, grantId: deviceGrantId } }, selected);
    const fixedDeviceSwitch = await switchTo(personalModelId);
    rootPointer = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: rootPointer.version,
      source: { kind: 'school', connectionId: schoolModelId } }, selected);
    await agent.stop(); await agent.start();
    assert.deepEqual(await deviceApi(fixedDeviceSwitch.route, fixedDeviceSwitch.input, selected), fixedDeviceSwitch.result,
      'restart and later Root selection must not retarget the original device switch');
    assert.equal(payloads.length, 3, 'changing/reading selection does not dispatch hidden model requests');
    await deviceApi('models/grants/'+deviceGrantId+'/revoke', { requestId: randomUUID(), expectedVersion: deviceGrant.version }, selected);
    const revokedSwitch = await fetch(deviceState.endpoint+'/api/learning/'+fixedDeviceSwitch.route, { method: 'POST',
      headers: { 'content-type': 'application/json', ...selected }, body: JSON.stringify(fixedDeviceSwitch.input) });
    assert.equal(revokedSwitch.status, 403, 'the completed switch receipt cannot bypass live Root/device grant revocation');
    const revokedView = await schoolApi('models/selection');
    assert.ok(!revokedView.options.some(choice => choice.grantId === deviceGrantId));
    const denied = await fetch(deviceState.endpoint+'/api/learning/models/selection', { method:'POST',
      headers:{'content-type':'application/json',...selected}, body:JSON.stringify({ requestId:randomUUID(),
        expectedVersion:rootPointer.version, source:{kind:'personal',connectionId:personalModelId,grantId:deviceGrantId} }) });
    assert.equal(denied.status,403,JSON.stringify(await denied.json()));
    assert.equal((await deviceApi('models/selection', undefined, personal)).selected.grantId, personalGrantId,
      'revoking a school device grant preserves the personal-space grant and pointer');
  } finally {
    await Promise.allSettled([agent.stop(), device.stop(), school.stop()]);
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
