import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { question, completed, versionHeaders } from './support/installed-agent-v2.mjs';
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
    const response = await fetch(endpoint+'/api/learning/'+route, { headers: { 'content-type': 'application/json', ...versionHeaders(route), ...headers },
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
    assert.equal(deviceState.environment.services.some(item => item.unit === 'learning-data'), dataAtDevice,
      'a remote data owner does not cause a replacement local learning-data owner');
    assert.ok(deviceState.environment.services.find(item => item.unit === 'tool-execution'));
    assert.ok(deviceState.environment.services.find(item => item.unit === 'model-connection'));
    assert.ok(deviceState.environment.services.find(item => item.unit === 'teaching-agent')?.capabilities.includes('agent.sessions.v2'),
      'a device Agent is available alongside the model and execution owners even when learning data lives at school');
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
    const capability = dataAtDevice ? 'learning.authority' : 'agent.dependencies.v2';
    let grant;
    if (dataAtDevice) {
    grant = await school.authorize({ sourceEnvironmentId: source.environmentId, sourceServiceId: source.serviceId,
      sourceInstallationId: deviceState.environment.installationId, capabilities: [capability] }, destination.serviceId);
    const dependencyConnectionId = randomUUID();
    await device.connect({ connectionId: dependencyConnectionId, sourceEnvironmentId: source.environmentId, sourceServiceId: source.serviceId,
      target: destination, requiredCapabilities: [capability], optionalCapabilities: [], credentialRef: 'school-data' }, grant.token);
    await deviceApi('manage/local-binding', { connectionId, runtimeConnectionId: dependencyConnectionId, target: dataTarget }, deviceAdmin);
    } else {
      const setup = JSON.parse(await resolveCredential(schoolRoot, 'school-device-setup-'+connectionId));
      grant = setup.result.agent;
      const first = JSON.parse(await resolveCredential(deviceRoot, 'school-client-'+connectionId));
      assert.ok(first.agentBinding.dependencyConnectionId, 'completion connects the local Agent automatically');
      assert.ok(first.agentBinding.executionConnectionId, 'completion connects local execution separately');
      assert.equal(first.setupPending, false);
      await school.stop(); await school.start();
      await deviceApi('client/complete', { requestId: connectionId });
      const again = JSON.parse(await resolveCredential(deviceRoot, 'school-client-'+connectionId));
      assert.deepEqual(again.agentBinding, first.agentBinding, 'retry after school restart retains the original connections');
      assert.equal(JSON.parse(await resolveCredential(schoolRoot, 'school-device-setup-'+connectionId)).result.agent.grantId,
        grant.grantId, 'retry does not issue a second Agent grant');
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
    const agentSession = (await deviceApi('agent-sessions/workspace', { activityId: activity.activityId, target: activity.target }, connected)).value;
    assert.equal(agentSession.owner.target.environmentId, agent.environmentId);
    assert.equal(agentSession.owner.target.serviceId, agent.serviceId, 'the real local Agent owns the kernel session');
    if (!dataAtDevice) assert.deepEqual((await schoolApi(`agent-sessions/${agentSession.sessionId}`, undefined, member)).value, agentSession,
      'the school learning-data owner retains the authoritative directory row');
    const input = question(activity, agentSession, '请简短解释本机路径');
    const receipt = (await deviceApi(`agent-sessions/${agentSession.sessionId}/inputs`, input, connected)).value;
    const conversation = await completed(async (route, body) => (await deviceApi(route, body, connected)).value, agentSession.sessionId, receipt.runId);
    assert.equal(conversation.messages.filter(item => item.role === 'assistant').at(-1).text, '本机直接生成的回答');
    assert.equal(generations, 1);
    await device.stop(); await device.start();
    assert.deepEqual((await deviceApi(`agent-sessions/${agentSession.sessionId}/conversation`, undefined, connected)).value, conversation);
    assert.deepEqual((await deviceApi(`agent-sessions/${agentSession.sessionId}/requests/${input.requestId}`, undefined, connected)).value, { receipt, input });
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
    await deviceApi(`agent-sessions/${agentSession.sessionId}/conversation`, undefined, connected, 403);
    assert.equal(generations, 1, 'revocation cannot cause a fallback model call');
  } finally {
    await Promise.allSettled([device.stop(), school.stop()]);
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
