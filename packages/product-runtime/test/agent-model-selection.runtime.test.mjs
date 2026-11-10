import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { storageErrorCodes } from '@xunjie/contracts/storage';
import pg from 'pg';

const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
if (!resources.postgresBin) throw new Error('Requires native PostgreSQL 18.6.');

// Read private evidence only on failure, and export an explicit metadata allowlist.
// Never pass a journal entry, SQL binding, payload, result, or Error to assertions.
const safeCode = value => storageErrorCodes.includes(value) || ['ENOENT', 'EACCES', 'ECONNREFUSED'].includes(value) ? value : null;
const safeOperation = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,100}$/.test(value) ? value : null;
async function agentFailureMetadata(agentRoot, serviceId, runId) {
  const transfers = [], steps = [];
  try {
    const path = join(agentRoot, 'private', 'agent-transfers');
    const names = await readdir(path);
    for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort()) {
      const entry = JSON.parse(await readFile(join(path, name), 'utf8'));
      const nested = entry.payload?.operation === 'model' ? entry.payload.args?.[0] : null;
      transfers.push({ capability: ['teaching.agent', 'teaching.dependencies'].includes(entry.capability) ? entry.capability : null,
        operation: nested ? 'model.' + safeOperation(nested.operation) : safeOperation(entry.payload?.operation),
        state: ['pending', 'received', 'consumed'].includes(entry.state) ? entry.state : null,
        errorCode: safeCode(entry.result?.error ?? (entry.result?.ok === false ? entry.result.code : null)),
        digest: /^[a-f0-9]{64}$/.test(entry.digest) ? entry.digest : null,
        transferId: /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(entry.transferId) ? entry.transferId : null });
    }
  } catch (error) { transfers.push({ state: 'diagnostic-unavailable', errorCode: safeCode(error.code) }); }
  if (runId) {
    let client;
    try {
      const binding = JSON.parse(await resolveCredential(agentRoot, 'storage-' + serviceId));
      client = new pg.Client(binding.connection); await client.connect();
      const schema = '"' + binding.schema.replaceAll('"', '""') + '"';
      const { rows } = await client.query(`SELECT phase FROM ${schema}.teaching_steps WHERE run_id=$1`, [runId]);
      for (const row of rows) steps.push({ phase: ['planned', 'model', 'final', 'tools', 'waiting', 'completed'].includes(row.phase) ? row.phase : null });
    } catch (error) { steps.push({ phase: 'diagnostic-unavailable', errorCode: safeCode(error.code) }); }
    finally { await client?.end().catch(() => {}); }
  }
  return { transfers, steps };
}

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
      if (run?.state !== 'completed') assert.fail('Agent model-selection failed: ' + JSON.stringify(
        await agentFailureMetadata(join(directory, 'agent'), agentService.serviceId, run?.runId)));
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
    rootPointer = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: rootPointer.version,
      source: { kind: 'personal', connectionId: localSchoolModelId, owner: 'self' } }, selected);
    await ask(localSchoolModelId, 'local-school-scope');
    rootPointer = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: rootPointer.version,
      source: { kind: 'personal', connectionId: personalModelId, owner: 'device' } }, selected);
    await switchTo(personalModelId);
    await ask(personalModelId, 'device-route');
    rootPointer = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: rootPointer.version,
      source: { kind: 'school', connectionId: schoolModelId } }, selected);
    assert.equal(rootPointer.selected.kind, 'school');
    assert.deepEqual(await schoolApi('models/selection'), rootPointer);
    // A device's personal pointer can change without overriding the school Root pointer.
    await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: personalPointer.version,
      source: { kind: 'personal', connectionId: personalModelId, owner: 'self' } }, personal);
    const schoolPointer = await deviceApi('models/selection', undefined, selected);
    assert.equal(schoolPointer.version, rootPointer.version); assert.deepEqual(schoolPointer.selected, rootPointer.selected);
    await switchTo(schoolModelId);
    await ask(schoolModelId, 'school-route');
    // Root self is configured by the Root school webpage, not moved from the installed device.
    await schoolApi('models/connections', configuration(selfModelId, 'root-self-route'));
    assert.ok((await schoolApi('models/connections')).some(item => item.connectionId === selfModelId));
    rootPointer = await schoolApi('models/selection', { requestId: randomUUID(), expectedVersion: rootPointer.version,
      source: { kind: 'personal', connectionId: selfModelId, owner: 'self' } });
    await switchTo(selfModelId);
    await ask(selfModelId, 'root-self-route');
    rootPointer = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: rootPointer.version,
      source: { kind: 'personal', connectionId: personalModelId, owner: 'device' } }, selected);
    const fixedDeviceSwitch = await switchTo(personalModelId);
    rootPointer = await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: rootPointer.version,
      source: { kind: 'school', connectionId: schoolModelId } }, selected);
    await agent.stop(); await agent.start();
    assert.deepEqual(await deviceApi(fixedDeviceSwitch.route, fixedDeviceSwitch.input, selected), fixedDeviceSwitch.result,
      'restart and later Root selection must not retarget the original device switch');
    assert.equal(payloads.length, 4, 'changing/reading selection does not dispatch hidden model requests');
    assert.equal((await deviceApi('models/selection', undefined, personal)).selected.connection.connectionId, personalModelId);
    await device.stop(); await device.start();
    assert.deepEqual(await deviceApi(fixedDeviceSwitch.route, fixedDeviceSwitch.input, selected), fixedDeviceSwitch.result,
      'direct model switches survive device restart without model grants');
    const controlBase = `agent/${activity.activityId}`;
    assert.equal(await deviceApi(`${controlBase}/controls/${randomUUID()}`, undefined, selected), null);
    const originalInput = (await deviceApi(`${controlBase}/conversation`, undefined, selected)).inputs.at(-1);
    const inputControl = { version: 1, requestId: randomUUID(), expectedVersion: originalInput.version,
      operation: 'revise', text: '已采用后不能改写的内容。' };
    const controlled = await deviceApi(`${controlBase}/inputs/${originalInput.inputId}/control`, inputControl, selected);
    assert.equal(controlled.status, 'rejected'); assert.equal(controlled.reason, 'input-consumed');
    assert.deepEqual(await deviceApi(`${controlBase}/controls/${inputControl.requestId}`, undefined, selected), controlled);
    const continued = { version: 2, requestId: randomUUID(), inputs: [] };
    const refused = await fetch(deviceState.endpoint + '/api/learning/' + controlBase + '/runs/' + originalInput.adoptedRunId + '/continue',
      { method: 'POST', headers: { 'content-type': 'application/json', ...selected }, body: JSON.stringify(continued) });
    assert.equal(refused.status, 409);
    assert.equal((await deviceApi(`${controlBase}/controls/${continued.requestId}`, undefined, selected)).status, 'rejected');
    assert.equal(payloads.length, 4, 'Input/control receipt queries and rejected late edits never create a model call.');
    for (const [name, state] of [['school', schoolState], ['device', deviceState]]) {
      const service = state.environment.services.find(item => item.unit === 'model-connection');
      const binding = JSON.parse(await resolveCredential(join(directory, name), 'storage-' + service.serviceId));
      const client = new pg.Client(binding.connection);
      try {
        await client.connect();
        const schema = '"' + binding.schema.replaceAll('"', '""') + '"';
        const { rows: [counts] } = await client.query(`SELECT count(*)::int AS grants FROM ${schema}.model_use_grants`);
        assert.equal(counts.grants, 0, name + ': direct model use must not create hidden model-use grants');
      } finally { await client.end(); }
    }

  } finally {
    await Promise.allSettled([agent.stop(), device.stop(), school.stop()]);
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
