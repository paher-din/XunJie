import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { openStorage, createFileBackend } from '@xunjie/storage';
import { learningMigrations } from '@xunjie/learning-space';
import { canonicalValue } from '@xunjie/contracts/execution';
import { manifestResources } from '@xunjie/contracts/components';
import { accumulatorPackage } from '../../../components/state-accumulator/package.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');

const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6',
  webRoot: process.env.XUNJIE_PRODUCT_WEB_ROOT ?? fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
if (!resources.postgresBin) throw new Error('Requires native PostgreSQL 18.6.');

for (const dataAtDevice of [false, true]) test(`device Agent uses ${dataAtDevice ? 'device' : 'school'} learning data without school callbacks or model/execution modules`, { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xj-device-agent-school-'));
  const schoolRoot = join(directory, 'school'), deviceRoot = join(directory, 'device');
  const school = openProductRuntime({ root: schoolRoot, resources }), device = openProductRuntime({ root: deviceRoot, resources });
  let generations = 0;
  const provider = createServer(async (request, response) => {
    for await (const _ of request) { /* Consume the fixed native request without logging it. */ }
    generations++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: '+JSON.stringify({ choices: [{ index: 0, delta: { content: '本机直接生成的回答' }, finish_reason: 'stop' }] })
      +'\n\ndata: '+JSON.stringify({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } })+'\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const request = async (endpoint, route, body, headers = {}, expected = 200) => {
    const response = await fetch(endpoint+'/api/learning/'+route, { headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.equal(response.status, expected, route+': '+JSON.stringify(value));
    return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    const schoolModules = dataAtDevice ? ['space-course'] : ['space-course', 'learning-data'];
    await school.install({ profile: 'school', deployment: { formatVersion: 1, modules: schoolModules, dependencies: {} } });
    await device.install({ profile: 'local', deployment: { formatVersion: 1,
      modules: ['space-course', ...(dataAtDevice ? ['learning-data'] : []), 'teaching-agent', 'model-connection', 'tool-execution'], dependencies: {} } });
    const schoolState = await school.start(), deviceState = await device.start();
    const schoolApi = (route, body, headers, expected) => request(schoolState.endpoint, route, body, headers, expected);
    const deviceApi = (route, body, headers, expected) => request(deviceState.endpoint, route, body, headers, expected);
    assert.deepEqual(schoolState.deployment.configuration.modules, schoolModules);
    assert.equal(schoolState.environment.services.some(item => ['teaching-agent', 'model-connection', 'tool-execution'].includes(item.unit)), false);
    assert.equal(schoolState.state, 'ready');
    assert.ok(deviceState.environment.services.find(item => item.unit === 'tool-execution'));
    const admin = { authorization: 'Bearer '+await resolveCredential(schoolRoot, 'control') };
    const deviceAdmin = { authorization: 'Bearer '+await resolveCredential(deviceRoot, 'control') };
    const loginName = 'device-agent-'+randomUUID(), password = randomUUID();
    const data = (dataAtDevice ? deviceState : schoolState).environment.services.find(item => item.unit === 'learning-data');
    const dataTarget = { environmentId: data.environmentId, serviceId: data.serviceId, version: 1 };
    const identity = (await schoolApi('manage/members', { requestId: randomUUID(), loginName, password,
      ...(dataAtDevice ? { target: dataTarget } : {}) }, admin)).value;
    const login = await schoolApi('login', { loginName, password });
    const member = { cookie: login.cookie, 'x-xj-space': 'school' };
    await schoolApi('native-channel/register', {}, { authorization: 'Bearer unavailable' }, 403);
    const connectionId = randomUUID();
    await deviceApi('client/start', { requestId: connectionId, schoolEndpoint: schoolState.endpoint });
    await schoolApi('connections/approve', { requestId: connectionId }, member);
    await deviceApi('client/complete', { requestId: connectionId });
    const agent = deviceState.environment.services.find(item => item.unit === 'teaching-agent');
    const source = dataAtDevice ? data : agent, destination = dataAtDevice ? schoolState.environment.services[0] : data;
    const capability = dataAtDevice ? 'learning.authority' : 'teaching.dependencies';
    const grant = await school.authorize({ sourceEnvironmentId: source.environmentId, sourceServiceId: source.serviceId,
      sourceInstallationId: deviceState.environment.installationId, capabilities: [capability] }, destination.serviceId);
    const dependencyConnectionId = randomUUID();
    await device.connect({ connectionId: dependencyConnectionId, sourceEnvironmentId: source.environmentId, sourceServiceId: source.serviceId,
      target: destination, requiredCapabilities: [capability], optionalCapabilities: [], credentialRef: 'school-data' }, grant.token);
    if (dataAtDevice) await deviceApi('manage/local-binding', { connectionId, runtimeConnectionId: dependencyConnectionId, target: dataTarget }, deviceAdmin);
    else {
      const executor = deviceState.environment.services.find(item => item.unit === 'tool-execution');
      const publication = await school.authorize({ sourceEnvironmentId: executor.environmentId, sourceServiceId: executor.serviceId,
        sourceInstallationId: deviceState.environment.installationId, capabilities: ['teaching.dependencies'] }, data.serviceId);
      const executionConnectionId = randomUUID();
      await device.connect({ connectionId: executionConnectionId, sourceEnvironmentId: executor.environmentId, sourceServiceId: executor.serviceId,
        target: data, requiredCapabilities: ['teaching.dependencies'], optionalCapabilities: [], credentialRef: 'school-records' }, publication.token);
      await schoolApi('manage/agent-binding', { requestId: randomUUID(), identity, delivery: 'client', connectionId,
        grantId: grant.grantId, executionGrantId: publication.grantId, target: agent, installationId: deviceState.environment.installationId,
        deviceModules: deviceState.environment.services.filter(item => item.unit !== 'client') }, admin);
      await deviceApi('manage/client-agent-binding', { connectionId, dependencyConnectionId, executionConnectionId,
        target: { environmentId: agent.environmentId, serviceId: agent.serviceId, version: 1 } }, deviceAdmin);
    }
    assert.equal((await school.status()).environment.services[0].capabilities.includes('learning.authority'), true);
    const personal = { 'x-xj-space': 'personal' }, connected = { 'x-xj-space': 'school:'+connectionId };
    const modelId = randomUUID();
    await deviceApi('models/connections', { requestId: randomUUID(), connectionId: modelId, expectedVersion: 0,
      name: '本机测试模型',
      protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${provider.address().port}`, path: '/chat/completions',
      modelId: 'device-fixture', dialect: 'standard', parameterMode: 'plain', enabled: true,
      contextWindow: 262144, maxOutputTokens: 1024, credential: { action: 'replace', value: 'synthetic-device-key' } }, personal);
    const use = (await deviceApi('models/grants', { requestId: randomUUID(), grantId: randomUUID(), connectionId: modelId,
      owner: 'device' }, connected)).value;
    await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: 0,
      source: { kind: 'personal', connectionId: modelId, grantId: use.grantId } }, connected);
    const activity = (await deviceApi('activities', { requestId: randomUUID(), goal: '学校数据与本机智能', question: '', references: [] }, connected)).value;
    assert.equal(activity.target.serviceId, data.serviceId);
    const note = (await deviceApi(`materials/${activity.activityId}`, { requestId: randomUUID(), materialId: randomUUID(),
      name: '本机连接的学校笔记.md', mediaType: 'text/markdown', dataBase64: Buffer.from('固定笔记正文').toString('base64') }, connected)).value;
    assert.equal((await deviceApi(`materials/${activity.activityId}`, undefined, connected)).value[0].materialId, note.materialId);
    assert.equal((await deviceApi(`materials/${activity.activityId}/${note.materialId}/versions/1`, undefined, connected)).value.text, '固定笔记正文');
    const capabilities = (await deviceApi(`agent/${activity.activityId}/capabilities`, undefined, connected)).value;
    assert.equal(capabilities.modelAvailable, true, JSON.stringify(capabilities));
    const requestId = randomUUID();
    await deviceApi(`intents/${activity.activityId}`, { requestId, receiver: capabilities.receiver,
      scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId: activity.activityId },
      draft: { token: randomUUID(), question: '请简短解释本机路径', references: [], bases: [] }, works: [], evidence: [] }, connected);
    const receipt = (await deviceApi(`intents/${activity.activityId}/${requestId}/dispatch`, {}, connected)).value;
    assert.equal(receipt.state, 'accepted');
    let conversation;
    const deadline = Date.now()+60000;
    do {
      conversation = (await deviceApi(`agent/${activity.activityId}/conversation`, undefined, connected)).value;
      if (conversation.runs.some(run => ['completed', 'failed', 'paused'].includes(run.state))) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now()<deadline);
    assert.equal(conversation.runs[0]?.state, 'completed', JSON.stringify(conversation));
    assert.equal(generations, 1);
    assert.equal((await (dataAtDevice ? deviceApi(`intents/${activity.activityId}/${requestId}`, undefined, connected)
      : schoolApi(`intents/${activity.activityId}/${requestId}`, undefined, member))).value.state, 'accepted');
    assert.deepEqual((await school.status()).deployment.configuration.modules, schoolModules);
    await device.stop(); await device.start();
    assert.deepEqual((await deviceApi(`agent/${activity.activityId}/conversation`, undefined, connected)).value, conversation);
    assert.equal((await deviceApi(`intents/${activity.activityId}/${requestId}/dispatch`, {}, connected)).value.state, 'accepted');
    assert.equal(generations, 1, 'restart and receipt recovery do not generate again');
    if (!dataAtDevice) {
      const published = await accumulatorPackage({ version: 1 });
      const definition = (await schoolApi('manage/component-import', { requestId: randomUUID(), ...published }, admin)).value;
      const binding = { key: 'counter', definition, configuration: { title: '本机运行' }, materialIds: [] };
      const session = definition.manifest.session;
      const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
      const design = { courseId, taskId, releaseId, components: [binding], plan: {
        version: 2, planId: 'device-course', planVersion: 1,
        components: [{ key: binding.key, definitionDigest: definition.digest, configurationDigest: digest(binding.configuration), operations: ['advance'] }],
        capabilities: ['execution.submit', 'native-session'], locations: ['native'], remote: null,
        resources: { browser: null, native: { memoryMiB: session.budgets.memoryMiB,
          operationTimeoutMs: session.budgets.operationTimeoutMs, maxMs: session.budgets.maxMs } },
        placements: [{ componentKey: binding.key, operationId: 'advance', target: 'student-runtime', budgets: session.budgets,
          resources: [definition.manifest.entry, ...manifestResources(definition.manifest)].map(({ resourceId, sha256, byteLength }) => ({ resourceId, sha256, byteLength })) }],
      } };
      const plan = (await schoolApi('manage/course-execution-compile', { identity, input: design }, admin)).value;
      const prepared = (await schoolApi('manage/course-deployment-prepare', { identity,
        input: { requestId: randomUUID(), ...design, plan } }, admin)).value;
      assert.equal(prepared.state, 'ready');
      await schoolApi('manage/course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '本机执行课程' },
        task: { taskId, title: '固定本机位置', summary: '' }, release: { releaseId, objectives: ['真实运行'], requirements: '连续输入并查看状态。',
          materials: [], starterWorks: [], capabilities: [], components: [binding], executionPlan: plan,
          helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } }, resources: [] }, admin);
      await schoolApi('manage/course-access', { requestId: randomUUID(), courseId, principalId: identity.principalId, active: true }, admin);
      const courseActivity = (await deviceApi('course-activities', { requestId: randomUUID(), releaseId }, connected)).value;
      const facts = (await deviceApi('execution-environment', undefined, connected)).value;
      assert.equal(facts.nodeClass, 'device');
      assert.equal(facts.device.native.prepared, 'ready');
      const nativeRequestId = randomUUID();
      const action = { protocolVersion: 2, kind: 'execution', requestId: nativeRequestId,
        scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId: courseActivity.activityId },
        receiver: { receiverId: 'native-execution', location: 'local', kind: 'execution' }, execution: {
          instance: { instanceId: courseActivity.activityId+':counter', key: 'counter', componentId: definition.manifest.componentId,
            componentVersion: definition.manifest.version, definitionDigest: definition.digest, hostApiVersion: 1, stateVersion: 1 },
          operation: { operationId: 'advance', effect: 'input' }, parameters: {},
          basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] },
          limits: { timeMs: session.budgets.operationTimeoutMs, memoryPages: 1, inputBytes: session.budgets.inputBytes,
            outputBytes: session.budgets.outputBytes, concurrentJobs: session.budgets.concurrentSessions, queuedJobs: session.budgets.queuedSessions },
          plan: { planId: 'native-session', planVersion: 1, location: 'native', kind: 'session', planDigest: digest({ planId: 'native-session', planVersion: 1,
            componentId: definition.manifest.componentId, componentVersion: definition.manifest.version, operationId: 'advance' }) },
          session: { adapterId: session.adapterId, adapterVersion: session.adapterVersion, limits: {
            operationTimeoutMs: session.budgets.operationTimeoutMs, idleMs: session.budgets.idleMs,
            maxMs: session.budgets.maxMs, memoryMiB: session.budgets.memoryMiB,
            concurrentSessions: session.budgets.concurrentSessions, queuedSessions: session.budgets.queuedSessions } },
          initiator: { kind: 'student', principalId: identity.principalId }, device: facts.device,
        } };
      const path = 'executions/'+courseActivity.activityId;
      const missingDevice = structuredClone(action); delete missingDevice.execution.device;
      await deviceApi(path, { action: missingDevice }, connected, 403);
      const started = (await deviceApi(path, { action }, connected)).value;
      assert.equal(started.state, 'running');
      assert.deepEqual(started.session.observation, { value: 0, total: 0, applied: 0 });
      const changed = (await deviceApi(path+'/'+nativeRequestId+'/control', { controlId: randomUUID(), operationId: 'advance',
        effect: 'input', expectedSeq: 0, parameters: { value: 1 } }, connected)).value;
      assert.deepEqual(changed.session.observation, { value: 1, total: 1, applied: 1 });
      assert.equal((await deviceApi(path, { action }, connected)).value.executionRef, started.executionRef);
      const stopped = (await deviceApi(path+'/'+nativeRequestId+'/stop', { stopId: randomUUID(), reason: '验收完成' }, connected)).value;
      assert.equal(stopped.state, 'cancelled');
      const dataBinding = JSON.parse(await resolveCredential(schoolRoot, 'storage-'+data.serviceId));
      const records = await openStorage({ binding: dataBinding, migrations: learningMigrations,
        backend: createFileBackend({ id: 'learning-data', root: join(schoolRoot, 'learning-resources', 'learning-data') }) });
      try {
        let replicated;
        const syncDeadline = Date.now()+30000;
        do {
          const { rows } = await records.read('SELECT query FROM execution_records WHERE request_id=$1', [nativeRequestId]);
          replicated = rows[0]?.query;
          if (replicated?.state === 'cancelled') break;
          await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now()<syncDeadline);
        assert.equal(replicated?.executionRef, started.executionRef, 'school stores the original execution reference');
        assert.equal(replicated?.state, 'cancelled', 'school receives the local terminal fact without a callback');
        assert.equal(replicated?.session.observations[0]?.state.total, 1);
        assert.equal((await records.read('SELECT request_id FROM execution_commands')).rows.length, 0,
          'school facts never become school executor commands');
      } finally { await records.close(); }
      assert.equal((await school.status()).deployment.modules.find(item => item.unit === 'tool-execution').enabled, false);
    }
    await school.revoke(grant.grantId, destination.serviceId);
    await deviceApi(`agent/${activity.activityId}/conversation`, undefined, connected, 403);
    assert.equal(generations, 1, 'revocation cannot cause a fallback model call');
  } finally {
    await Promise.allSettled([device.stop(), school.stop()]);
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
