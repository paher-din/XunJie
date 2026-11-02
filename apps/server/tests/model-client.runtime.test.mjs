import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
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
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Real SDK consumes synthetic input. */ }
    requests.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
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
    assert.equal((await schoolApi('connections/revoke', { connectionId: pending.value.requestId }, schoolHeaders)).status, 200);
    assert.equal((await clientApi('models/checks', { attemptId: randomUUID(), purpose: 'connection-check', source: { selected: true, selectionVersion: 1 }, limits: { maxOutputTokens: 64, timeoutMs: 10000 } }, headers)).status, 403);
    assert.equal(requests.length, 2);
  } finally {
    await client.stop(); await school.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
});
