import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { openStorage, provisionStorage, createFileBackend } from '@xunjie/storage';
import { createTeachingAgent, createTeachingTools, createSpaces, createCourses, createLearningData, createModelGateway,
  teachingAgentMigrations, spaceCourseMigrations, learningMigrations, modelMigrations } from '@xunjie/learning-space';
import { actionInputSchema } from '@xunjie/contracts/action-intents';
import { aggregationPackage } from '../../../../components/table-aggregation/package.mjs';

export async function until(check, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(description);
}

export function reply(response, { text = '', calls = [] } = {}) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls.map((call, index) => ({
    index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  })) } : {}) };
  for (const value of [
    { id: 'input-control', choices: [{ index: 0, delta, finish_reason: null }] },
    { id: 'input-control', choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
  ]) response.write('data: ' + JSON.stringify(value) + '\n\n');
  response.end('data: [DONE]\n\n');
}

/** Real public HTTP, production owners, native PostgreSQL and resources; only the upstream model is controlled. */
export async function fixture(answer = (_payload, response) => reply(response, { text: '已按当前问题完成。' })) {
  const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
  if (!postgresBin) throw new Error('Requires native PostgreSQL 18.6.');
  const payloads = [], failures = [], ownedAgents = [], ownedStorages = [], ownedServices = [];
  const upstream = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      payloads.push(payload); await answer(payload, response, payloads.length);
    } catch (error) { failures.push(error); response.destroy(error); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const external = process.env.XUNJIE_INPUT_CONTROL_ENDPOINT;
  const root = external ? '' : await mkdtemp(join(tmpdir(), 'xj-input-control-'));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
    webRoot: process.env.XUNJIE_PRODUCT_WEB_ROOT ?? fileURLToPath(new URL('../../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
  const runtime = external ? null : openProductRuntime({ root, resources });
  if (runtime) await runtime.install({ profile: 'local' });
  let endpoint = external ?? (await runtime.start()).endpoint;
  const raw = async (route, body, headers = { 'x-xj-space': 'personal' }) => {
    const response = await fetch(new URL('/api/learning/' + route, endpoint), {
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const api = async (route, body, headers) => {
    const result = await raw(route, body, headers);
    assert.equal(result.status, 200, route + ': ' + JSON.stringify(result.body));
    return result.body;
  };
  return { root, resources, runtime, api, raw, payloads, failures, get endpoint() { return endpoint; },
    async configure(headers) {
      const modelApi = (route, body) => api(route, body, headers);
      const connectionId = randomUUID(), grantId = randomUUID();
      await modelApi('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0,
        name: '运行中输入验收', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
        path: '/chat/completions', modelId: 'fixture-input-control', dialect: 'standard', parameterMode: 'plain', enabled: true,
        contextWindow: 262144, maxOutputTokens: 2048, credential: { action: 'replace', value: 'synthetic-input-control-key' } });
      await modelApi('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
      const selected = await modelApi('models/selection');
      await modelApi('models/selection', { requestId: randomUUID(), expectedVersion: selected.version, source: { kind: 'personal', connectionId, grantId } });
    },
    async activity(goal = '核对补充与排队的真实顺序') {
      return api('activities', { requestId: randomUUID(), goal, question: '', references: [] });
    },
    async browserCourse({ withSession = false } = {}) {
      const headers = { authorization: 'Bearer ' + await resolveCredential(root, 'control') };
      const definition = await api('manage/component-import', { requestId: randomUUID(), ...await aggregationPackage() }, headers);
      const courseId = randomUUID(), releaseId = randomUUID(), password = randomUUID();
      await api('manage/course-import', { formatVersion: 1, requestId: randomUUID(),
        course: { courseId, name: '运行中输入的真实 WP03 样例' }, task: { taskId: randomUUID(), title: '解释真实分组均值', summary: '' },
        release: { releaseId, helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },
          objectives: ['核对真实计算与补充的顺序'], requirements: '保留原计算与实际结果。', starterWorks: [], capabilities: [],
          components: [{ key: 'table', definition, configuration: { title: '真实分组计算' }, materialIds: [] }], materials: [] }, resources: [] }, headers);
      const member = await api('manage/members', { requestId: randomUUID(), loginName: 'input-control-student', password }, headers);
      await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true }, headers);
      const login = await fetch(new URL('/api/learning/login', endpoint), { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'input-control-student', password }) });
      assert.equal(login.status, 200);
      const studentHeaders = { cookie: login.headers.get('set-cookie').split(';')[0] };
      const activity = await api('course-activities', { requestId: randomUUID(), releaseId }, studentHeaders);
      return withSession ? { activity, headers: studentHeaders, login: { loginName: 'input-control-student', password } } : activity;
    },
    /** Published host configuration seam: independent production owner, real dependencies, controlled receipt timing. */
    async controlled(activity, overrides = {}) {
      if (!runtime) throw new Error('Controlled owner tests require their own native runtime.');
      const environment = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
      async function reopen(unit, migrations) {
        const service = environment.services.find(item => item.unit === unit);
        const binding = JSON.parse(await resolveCredential(root, 'storage-' + service.serviceId));
        const storage = await openStorage({ binding, migrations,
          backend: createFileBackend({ id: unit, root: join(root, 'learning-resources', unit) }) });
        ownedStorages.push(storage); return storage;
      }
      const spaceStorage = await reopen('space-course', spaceCourseMigrations);
      const spaces = createSpaces(spaceStorage), courses = createCourses(spaceStorage, spaces);
      const learning = createLearningData(await reopen('learning-data', learningMigrations), spaces, courses, {});
      const models = await createModelGateway(await reopen('model-connection', modelMigrations),
        { authorize: who => spaces.authorize(who), holder: 'device' });
      ownedServices.push({ learning, models });
      const identity = activity.identity, connectionId = randomUUID(), grantId = randomUUID();
      await models.save(identity, { requestId: randomUUID(), connectionId, expectedVersion: 0,
        name: '真实工具控制时序', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
        path: '/chat/completions', modelId: 'fixture-input-control', dialect: 'standard', parameterMode: 'plain', enabled: true,
        contextWindow: 262144, maxOutputTokens: 2048, credential: { action: 'replace', value: 'synthetic-input-control-key' } });
      await models.selection.createGrant(identity, identity, { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
      const selection = await models.selection.read(identity);
      await models.selection.save(identity, { requestId: randomUUID(), expectedVersion: selection.version,
        source: { kind: 'personal', connectionId, grantId } });
      const { credentialRef, ...connection } = await runtime.database();
      const binding = await provisionStorage({ admin: { ...connection, password: await resolveCredential(root, credentialRef) },
        owner: { environmentId: environment.environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations: teachingAgentMigrations });
      const storage = await openStorage({ binding, migrations: teachingAgentMigrations,
        backend: createFileBackend({ id: 'input-control-agent', root: join(root, 'controlled-agent-resources') }) });
      ownedStorages.push(storage);
      const tools = createTeachingTools({ learning: () => learning, courses });
      const makeAgent = (options = {}, ownerStorage = storage) => {
        const agent = createTeachingAgent(ownerStorage, { models, tools, authorize: who => spaces.authorize(who),
          identityFor: scope => spaces.lookup(scope.spaceId, scope.principalId), activity: (who, id) => learning.open(who, id),
          start: false, driverId: randomUUID(), scanIntervalMs: 40, ...overrides, ...options });
        ownedAgents.push(agent); return agent;
      };
      const agent = makeAgent();
      return { agent, makeAgent, models, learning, tools, storage, identity,
        async send(question, delivery, works = [], target = agent) {
          const input = actionInputSchema.parse({ requestId: randomUUID(), scope: { environmentId: identity.environmentId,
            spaceId: identity.spaceId, principalId: identity.principalId, activityId: activity.activityId },
            receiver: target.receiver.identity, draft: { token: randomUUID(), question, references: [], bases: [] }, works, evidence: [],
            ...(delivery ? { delivery } : {}) });
          const receipt = await target.accept(input, createHash('sha256').update(JSON.stringify(input)).digest('hex'));
          return { input, receipt, ...JSON.parse(receipt.detail) };
        },
      };
    },
    async send(activity, question, delivery, works = [], headers) {
      const receiver = (await api(`agent/${activity.activityId}/capabilities`, undefined, headers)).receiver;
      const input = { requestId: randomUUID(), scope: { environmentId: activity.identity.environmentId,
        spaceId: activity.identity.spaceId, principalId: activity.identity.principalId, activityId: activity.activityId }, receiver,
        draft: { token: randomUUID(), question, references: [], bases: [] }, works, evidence: [],
        ...(delivery ? { delivery } : {}) };
      await api(`intents/${activity.activityId}`, input, headers);
      const accepted = await api(`intents/${activity.activityId}/${input.requestId}/dispatch`, {}, headers);
      return { input, receipt: accepted.receipt, ...JSON.parse(accepted.receipt.detail) };
    },
    async restart() { if (!runtime) throw new Error('External package lifecycle belongs to its launcher.'); await runtime.stop(); endpoint = (await runtime.start()).endpoint; },
    async close() {
      const errors = [];
      ownedAgents.forEach(agent => { agent.closeDispatch(); agent.close(); });
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
      await Promise.allSettled(ownedAgents.map(agent => agent.drain()));
      for (const { learning, models } of ownedServices) {
        models.closeWrites();
        try { await models.checks.drain(); } catch (error) { errors.push(error); }
        try { await learning.executions.shutdown(); } catch (error) { errors.push(error); }
      }
      await Promise.allSettled(ownedStorages.map(storage => storage.close()));
      if (!runtime) { if (errors.length) throw new AggregateError(errors, 'External fixture cleanup failed'); return; }
      let stopped = false;
      try { await runtime.stop(); stopped = true; } catch (error) { errors.push(error); }
      if (stopped) {
        if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('xj-input-control-')) throw new Error('Unexpected cleanup target');
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
      if (errors.length) throw new AggregateError(errors, 'Isolated test cleanup failed');
    },
  };
}
