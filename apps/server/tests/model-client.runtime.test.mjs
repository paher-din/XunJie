import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';

const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6', postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN,
  webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
test('installed client uses the real school subject to choose school or device models without copying credentials', { timeout: 180000 }, async () => {
  const requests = [];
  const payloads = [];
  const upstream = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const payload = JSON.parse(Buffer.concat(chunks)); payloads.push(payload);
    requests.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const tool = payload.messages[0]?.content === 'request-tool-for-boundary';
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: tool ? { role: 'assistant', reasoning_content: 'PRIVATE-SCHOOL-ORIGIN',
      tool_calls: [{ index: 0, id: 'original-school-tool', type: 'function', function: { name: 'read_marker', arguments: '{}' } }] }
      : { role: 'assistant', content: 'OK' }, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const schoolRoot = await mkdtemp(join(tmpdir(), 'xj-model-school-')), clientRoot = await mkdtemp(join(tmpdir(), 'xj-model-client-'));
  const school = openProductRuntime({ root: schoolRoot, resources }), client = openProductRuntime({ root: clientRoot, resources });
  try {
    await school.install({ profile: 'school' }); const schoolState = await school.start();
    await client.install({ profile: 'local' }); const clientState = await client.start();
    const call = async (endpoint, route, body, headers = {}) => {
      const response = await fetch(endpoint + '/api/learning/' + route, { headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    const schoolApi = (route, body, headers) => call(schoolState.endpoint, route, body, headers);
    const clientApi = (route, body, headers) => call(clientState.endpoint, route, body, headers);
    const admin = { authorization: 'Bearer ' + await resolveCredential(schoolRoot, 'control') };
    const password = randomUUID();
    assert.equal((await schoolApi('manage/members', { requestId: randomUUID(), loginName: 'device-model-alice', password }, admin)).status, 200);
    const login = await schoolApi('login', { loginName: 'device-model-alice', password });
    const schoolHeaders = { cookie: login.cookie };
    const config = (name, key) => ({ requestId: randomUUID(), connectionId: randomUUID(), expectedVersion: 0, name,
      protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions', modelId: name,
      dialect: 'standard', parameterMode: 'plain', enabled: true, credential: { action: 'replace', value: key } });
    const schoolConfig = config('学校服务', 'synthetic-school-owner'), deviceConfig = config('本机个人服务', 'synthetic-device-owner');
    assert.equal((await schoolApi('manage/model-default', { ...schoolConfig,
      policy: { checksAllowed: true, maxChecksPerHour: 6, maxOutputTokens: 64, timeoutMs: 10000 } }, admin)).status, 200);
    assert.equal((await clientApi('models/connections', deviceConfig, { 'x-xj-space': 'personal' })).status, 200);
    const pending = await clientApi('client/start', { requestId: randomUUID(), schoolEndpoint: schoolState.endpoint });
    assert.equal(pending.status, 200);
    assert.equal((await schoolApi('connections/approve', { requestId: pending.value.requestId }, schoolHeaders)).status, 200);
    const completed = await clientApi('client/complete', { requestId: pending.value.requestId }); assert.equal(completed.status, 200);
    const headers = { 'x-xj-space': 'school:' + pending.value.requestId, 'x-xj-namespace': clientState.environment.clientNamespace,
      'x-xj-expected-subject': [completed.value.identity.environmentId, completed.value.identity.spaceId, completed.value.identity.principalId].join('.') };
    const selected = await clientApi('models/selection', undefined, headers);
    assert.equal(selected.status, 200); assert.equal(selected.value.selected.kind, 'school');
    assert.equal(selected.value.options.find(item => item.origin === 'device').connection.connectionId, deviceConfig.connectionId);
    const prefix = { system: 'Check school capabilities through the installed client', tools: [],
      options: { requiredCapabilities: ['images', 'nativeReplay'] } };
    const preflight = await clientApi('models/capabilities', { source: { selected: true, selectionVersion: 0 }, prefix }, headers);
    assert.equal(preflight.status, 200); assert.equal(preflight.value.connectionId, schoolConfig.connectionId);
    assert.deepEqual(preflight.value.missing.map(item => item.capability), ['images', 'nativeReplay']);
    const capabilityFailure = await clientApi('models/segments', { requestId: randomUUID(), segmentId: randomUUID(),
      source: { selected: true, selectionVersion: 0 }, prefix, portable: [] }, headers);
    assert.equal(capabilityFailure.status, 422); assert.equal(capabilityFailure.value.error, 'capability-unavailable');
    assert.deepEqual(capabilityFailure.value.decision, preflight.value);
    assert.equal(requests.length, 0);
    const finish = async source => {
      const attemptId = randomUUID();
      const accepted = await clientApi('models/checks', { attemptId, purpose: 'connection-check', source, limits: { maxOutputTokens: 64, timeoutMs: 10000 } }, headers);
      assert.equal(accepted.status, 200);
      assert.equal((await clientApi(`models/checks/${attemptId}/dispatch`, {}, headers)).status, 200);
      for (let index = 0; index < 150; index++) {
        const result = await clientApi(`models/checks/${attemptId}`, undefined, headers);
        assert.equal(result.status, 200);
        if (result.value.physicalRequestEnded) { assert.equal(result.value.state, 'completed'); return result.value; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Bounded school/client call did not finish');
    };
    const originalSchool = await finish({ selected: true, selectionVersion: 0 });
    const grant = await clientApi('models/grants', { requestId: randomUUID(), grantId: randomUUID(), connectionId: deviceConfig.connectionId, owner: 'device' }, headers);
    assert.equal(grant.status, 200);
    const chosen = await clientApi('models/selection', { requestId: randomUUID(), expectedVersion: 0,
      source: { kind: 'personal', connectionId: deviceConfig.connectionId, grantId: grant.value.grantId } }, headers);
    assert.equal(chosen.status, 200);
    const crossOwnerReuse = await clientApi('models/checks', { attemptId: originalSchool.attemptId, purpose: 'connection-check',
      source: { selected: true, selectionVersion: 1 }, limits: { maxOutputTokens: 64, timeoutMs: 10000 } }, headers);
    assert.equal(crossOwnerReuse.status, 409, 'an accepted attempt ID cannot be reused after switching the credential holder');
    const repeatOriginal = await clientApi('models/checks', { attemptId: originalSchool.attemptId, purpose: 'connection-check',
      source: { selected: true, selectionVersion: 0 }, limits: { maxOutputTokens: 64, timeoutMs: 10000 } }, headers);
    assert.equal(repeatOriginal.status, 200); assert.equal(repeatOriginal.value.resultRef, originalSchool.resultRef);
    const originalPersonal = await finish({ selected: true, selectionVersion: 1 });
    assert.equal(originalPersonal.source.kind, 'personal'); assert.notEqual(originalPersonal.source.feeSource, originalSchool.source.feeSource);
    assert.deepEqual(requests, ['Bearer synthetic-school-owner', 'Bearer synthetic-device-owner']);
    assert.equal((await schoolApi(`models/checks/${originalPersonal.attemptId}`, undefined, schoolHeaders)).status, 404);
    assert.equal((await clientApi(`models/checks/${originalPersonal.attemptId}`, undefined, { 'x-xj-space': 'personal' })).status, 404);
    assert.equal((await clientApi('models/selection', undefined, { ...headers, 'x-xj-expected-subject': randomUUID() })).status, 403);
    await client.stop(); await client.start();
    assert.equal((await clientApi(`models/checks/${originalPersonal.attemptId}`, undefined, headers)).value.resultRef, originalPersonal.resultRef);
    assert.equal((await clientApi(`models/checks/${originalSchool.attemptId}`, undefined, headers)).value.resultRef, originalSchool.resultRef);
    const finishChat = async (segmentId, text) => {
      const attemptId = randomUUID();
      const input = { attemptId, purpose: 'chat-probe', segmentId, expectedSequence: 0,
        input: { text, images: [], toolResults: [] }, limits: { maxOutputTokens: 64, timeoutMs: 10000 } };
      assert.equal((await clientApi('models/calls', input, headers)).status, 200);
      assert.equal((await clientApi(`models/calls/${attemptId}/dispatch`, {}, headers)).status, 200);
      for (let index = 0; index < 150; index++) {
        const result = await clientApi(`models/calls/${attemptId}`, undefined, headers); assert.equal(result.status, 200);
        if (result.value.physicalRequestEnded) { assert.equal(result.value.state, 'completed'); return result.value; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Bounded cross-holder call did not finish');
    };
    const schoolSegment = randomUUID();
    assert.equal((await clientApi('models/segments', { requestId: randomUUID(), segmentId: schoolSegment,
      source: { school: { connectionId: schoolConfig.connectionId, version: 1 } }, prefix: { system: 'request-tool-for-boundary', tools: [
        { name: 'read_marker', description: '', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      ] }, portable: [] }, headers)).status, 200);
    const schoolNative = await finishChat(schoolSegment, '请求学校模型工具');
    const personalSegment = { requestId: randomUUID(), segmentId: randomUUID(), source: { selected: true, selectionVersion: 1 },
      previousSegmentId: schoolSegment, prefix: { system: 'personal-portable-prefix', tools: [] },
      portable: [{ text: '调用方提供的可移植问题', resultRef: schoolNative.resultRef }] };
    assert.equal((await clientApi('models/segments', personalSegment, headers)).status, 409, 'unsettled school tools cannot be hidden by changing holders');
    assert.equal((await clientApi(`models/segments/${schoolSegment}/tool-results`, { requestId: randomUUID(), expectedSequence: 1,
      results: [{ callId: 'original-school-tool', outcome: 'not-executed', text: '调用方明确不执行', images: [] }] }, headers)).status, 200);
    const moved = await clientApi('models/segments', personalSegment, headers);
    assert.equal(moved.status, 200); assert.equal(moved.value.provenance.boundary.segmentId, schoolSegment);
    assert.equal(moved.value.provenance.results[0].resultRef, schoolNative.resultRef);
    assert.equal(moved.value.provenance.results[0].owner.environmentId, schoolState.environment.environmentId);
    assert.equal((await clientApi(`models/segments/${schoolSegment}`, undefined, headers)).value.closed, true);
    const personalNative = await finishChat(personalSegment.segmentId, '用个人模型继续');
    const schoolAgain = { requestId: randomUUID(), segmentId: randomUUID(), source: { school: { connectionId: schoolConfig.connectionId, version: 1 } },
      previousSegmentId: personalSegment.segmentId, prefix: { system: 'school-portable-prefix', tools: [] }, portable: [{ text: '返回学校路线', resultRef: personalNative.resultRef }] };
    const returned = await clientApi('models/segments', schoolAgain, headers);
    assert.equal(returned.status, 200); assert.equal(returned.value.provenance.boundary.segmentId, personalSegment.segmentId);
    assert.equal(returned.value.provenance.results[0].resultRef, personalNative.resultRef);
    assert.equal(returned.value.provenance.results[0].owner.environmentId, clientState.environment.environmentId);
    await finishChat(schoolAgain.segmentId, '由学校模型接续');
    for (const payload of payloads.slice(3)) {
      assert.equal(JSON.stringify(payload).includes('PRIVATE-SCHOOL-ORIGIN'), false);
      assert.equal(JSON.stringify(payload).includes('original-school-tool'), false);
    }
    const denied = await clientApi('models/segments', { ...personalSegment, requestId: randomUUID(), segmentId: randomUUID(), previousSegmentId: schoolAgain.segmentId,
      portable: [{ text: '未经授权的结果引用', resultRef: randomUUID() }] }, headers);
    assert.equal(denied.status, 404);
    assert.equal((await clientApi(`models/segments/${schoolAgain.segmentId}`, undefined, headers)).value.closed, false);
    await client.stop(); await client.start();
    assert.deepEqual((await clientApi(`models/segments/${schoolAgain.segmentId}`, undefined, headers)).value.provenance, returned.value.provenance);
    assert.equal((await schoolApi('connections/revoke', { connectionId: pending.value.requestId }, schoolHeaders)).status, 200);
    assert.equal((await clientApi('models/checks', { attemptId: randomUUID(), purpose: 'connection-check', source: { selected: true, selectionVersion: 1 }, limits: { maxOutputTokens: 64, timeoutMs: 10000 } }, headers)).status, 403);
    assert.equal(requests.length, 5);
  } finally {
    await client.stop(); await school.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
});


test('installed client with a local Agent selects a remote school model from its listed options', { timeout: 180000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-remote-school-selection-'));
  const schoolRoot = join(root, 'school'), clientRoot = join(root, 'client');
  const school = openProductRuntime({ root: schoolRoot, resources });
  const client = openProductRuntime({ root: clientRoot, resources });
  try {
    await school.install({ profile: 'school' });
    await client.install({ profile: 'local' });
    const schoolState = await school.start(), clientState = await client.start();
    const call = async (endpoint, route, body, headers = {}) => {
      const response = await fetch(endpoint + '/api/learning/' + route, {
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    const admin = { authorization: 'Bearer ' + await resolveCredential(schoolRoot, 'control') };
    const password = randomUUID(), loginName = 'remote-school-selection';
    assert.equal((await call(schoolState.endpoint, 'manage/members', { requestId: randomUUID(), loginName, password }, admin)).status, 200);
    const login = await call(schoolState.endpoint, 'login', { loginName, password });
    const configuration = { requestId: randomUUID(), expectedVersion: 0, connectionId: randomUUID(), name: '远端学校模型',
      protocol: 'chat-completions', baseUrl: 'https://1.1.1.1/v1', path: '/chat/completions', modelId: 'school-selection-fixture',
      dialect: 'standard', parameterMode: 'plain', enabled: true, credential: { action: 'replace', value: 'synthetic-school-selection' },
      policy: { checksAllowed: true, maxChecksPerHour: 6, maxOutputTokens: 64, timeoutMs: 10000 } };
    assert.equal((await call(schoolState.endpoint, 'manage/model-default', configuration, admin)).status, 200);
    const requestId = randomUUID();
    assert.equal((await call(clientState.endpoint, 'client/start', { requestId, schoolEndpoint: schoolState.endpoint })).status, 200);
    assert.equal((await call(schoolState.endpoint, 'connections/approve', { requestId }, { cookie: login.cookie })).status, 200);
    assert.equal((await call(clientState.endpoint, 'client/complete', { requestId })).status, 200);
    const localAgent = clientState.environment.services.find(item => item.unit === 'teaching-agent');
    const schoolData = schoolState.environment.services.find(item => item.unit === 'learning-data');
    const dependencyId = randomUUID();
    const dependency = await school.authorize({ sourceEnvironmentId: localAgent.environmentId, sourceServiceId: localAgent.serviceId,
      sourceInstallationId: clientState.environment.installationId, capabilities: ['teaching.dependencies'] }, schoolData.serviceId);
    await client.connect({ connectionId: dependencyId, sourceEnvironmentId: localAgent.environmentId, sourceServiceId: localAgent.serviceId,
      target: schoolData, requiredCapabilities: ['teaching.dependencies'], optionalCapabilities: [], credentialRef: 'school-selection-dependency' }, dependency.token);
    const memberConnection = JSON.parse(await resolveCredential(clientRoot, 'school-client-' + requestId));
    assert.equal((await call(schoolState.endpoint, 'manage/agent-binding', { requestId: randomUUID(), identity: memberConnection.grant.identity,
      connectionId: requestId, target: localAgent,
      installationId: clientState.environment.installationId, delivery: 'client', grantId: dependency.grantId }, admin)).status, 200);
    assert.equal((await call(clientState.endpoint, 'manage/client-agent-binding', { connectionId: requestId,
      dependencyConnectionId: dependencyId, target: { environmentId: localAgent.environmentId, serviceId: localAgent.serviceId, version: 1 } },
      { authorization: 'Bearer ' + await resolveCredential(clientRoot, 'control') })).status, 200);
    const connection = JSON.parse(await resolveCredential(clientRoot, 'school-client-' + requestId));
    assert.equal(!!connection.agentBinding, true, 'the installed client uses its local Agent');
    const headers = { 'x-xj-space': 'school:' + requestId };
    const initial = await call(clientState.endpoint, 'models/selection', undefined, headers);
    assert.equal(initial.status, 200);
    const choice = initial.value.options.find(item => item.kind === 'school');
    assert.equal(choice.connection.connectionId, configuration.connectionId);
    const input = { requestId: randomUUID(), expectedVersion: initial.value.version,
      source: { kind: 'school', connectionId: choice.connection.connectionId } };
    const selected = await call(clientState.endpoint, 'models/selection', input, headers);
    assert.equal(selected.status, 200, 'a listed remote school model must be selectable with the local Agent');
    assert.equal(selected.value.version, input.expectedVersion + 1);
    assert.deepEqual(selected.value.selected, choice);
    assert.deepEqual((await call(clientState.endpoint, 'models/selection', input, headers)).value, selected.value);
    const refreshed = await call(clientState.endpoint, 'models/selection', { ...input, requestId: randomUUID(), expectedVersion: selected.value.version }, headers);
    assert.equal(refreshed.status, 200);
    await client.stop(); await client.start();
    const reopened = await call(clientState.endpoint, 'models/selection', undefined, headers);
    assert.equal(reopened.value.version, refreshed.value.version);
    assert.deepEqual(reopened.value.selected, choice);
    assert.equal((await call(clientState.endpoint, 'models/selection', { ...input, requestId: randomUUID() }, headers)).status, 409);
    assert.equal((await call(schoolState.endpoint, 'manage/model-default', { ...configuration, requestId: randomUUID(),
      expectedVersion: 1, enabled: false, credential: { action: 'keep' } }, admin)).status, 200);
    assert.equal((await call(clientState.endpoint, 'models/selection', { ...input, requestId: randomUUID(), expectedVersion: reopened.value.version }, headers)).status, 503);
  } finally {
    await Promise.allSettled([client.stop(), school.stop()]);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
