import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { openStorage, provisionStorage, createFileBackend } from '@xunjie/storage';
import { createSpaces, createCourses, createLearningData, createModelGateway, createTeachingAgent,
  createTeachingTools, spaceCourseMigrations, learningMigrations, modelMigrations,
  teachingAgentMigrations, SupervisedSession } from '@xunjie/learning-space';
import { actionInputSchema } from '@xunjie/contracts/action-intents';
import { executionActionSchema } from '@xunjie/contracts/execution';
import { accumulatorPackage } from '../../../components/state-accumulator/package.mjs';
import { aggregationPackage } from '../../../components/table-aggregation/package.mjs';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Requires native PostgreSQL 18.6.');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function until(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(description);
}
function reply(response, { call, text = '' }) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const value of [
    { id: 'recovery-sdk', choices: [{ index: 0, delta: { role: 'assistant', content: text,
      ...(call ? { tool_calls: [{ index: 0, id: call.id, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : {}) }, finish_reason: null }] },
    { id: 'recovery-sdk', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
  ]) response.write('data: ' + JSON.stringify(value) + '\n\n');
  response.end('data: [DONE]\n\n');
}

/** Real product provisioning and resources; only the named public owner boundary is faulted.
 * A separate Agent owner keeps the product's background driver out of the race under test.
 */
async function fixture(answer, { course = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'xj-tool-recovery-'));
  const payloads = [], transportErrors = [], storages = [], agents = [];
  let models, learning;
  const upstream = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks));
      payloads.push(payload);
      await answer(payload, response, payloads.length);
    } catch (error) { transportErrors.push(error); response.destroy(error); }
  });
  const windowsSessionHelper = process.env.XUNJIE_NATIVE_SESSION_HELPER;
  const windowsSessionHelperSha256 = windowsSessionHelper
    ? createHash('sha256').update(await readFile(windowsSessionHelper)).digest('hex') : undefined;
  const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0',
    windowsSessionHelper, windowsSessionHelperSha256,
    postgresBin, postgresVersion: '18.6', webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } });
  async function close() {
    for (const agent of agents) { agent.closeDispatch(); agent.close(); }
    upstream.closeAllConnections();
    await Promise.allSettled(agents.map(agent => agent.drain()));
    if (models) { models.closeWrites(); await models.checks.drain(); }
    await learning?.executions.shutdown();
    await Promise.allSettled(storages.map(storage => storage.close()));
    await runtime.stop();
    if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
  try {
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    await runtime.install({ profile: 'local' });
    const endpoint = (await runtime.start()).endpoint;
    const adminHeaders = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
    const api = async (route, body, headers = { 'x-xj-space': 'personal' }) => {
      const response = await fetch(new URL('/api/learning/' + route, endpoint), {
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      const value = await response.json();
      assert.equal(response.status, 200, route + ': ' + JSON.stringify(value));
      return value;
    };
    let activity;
    if (course) {
      const published = await (course === 'browser' ? aggregationPackage() : accumulatorPackage());
      const definition = await api('manage/component-import', { requestId: randomUUID(), ...published }, adminHeaders);
      const courseId = randomUUID(), releaseId = randomUUID();
      await api('manage/course-import', { formatVersion: 1, requestId: randomUUID(),
        course: { courseId, name: '恢复回归的真实 WP03 样例' }, task: { taskId: randomUUID(), title: '累加 1 和 2', summary: '' },
        release: { releaseId, helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },
          objectives: ['核对原执行'], requirements: '先输入 1，再输入 2，观察总数 3。', starterWorks: [], capabilities: [],
          components: [{ key: course === 'browser' ? 'table' : 'counter', definition,
            configuration: { title: '真实 WP03 样例' }, materialIds: [] }], materials: [] },
        resources: [] }, adminHeaders);
      const password = randomUUID();
      const member = await api('manage/members', { requestId: randomUUID(), loginName: 'recovery-student', password }, adminHeaders);
      await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true }, adminHeaders);
      const login = await fetch(new URL('/api/learning/login', endpoint), { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'recovery-student', password }) });
      assert.equal(login.status, 200);
      activity = await api('course-activities', { requestId: randomUUID(), releaseId },
        { cookie: login.headers.get('set-cookie').split(';')[0] });
    } else activity = await api('activities', { requestId: randomUUID(), goal: '固定作品恢复', question: '', references: [] });
    const environment = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
    async function reopen(unit, migrations) {
      const service = environment.services.find(item => item.unit === unit);
      const binding = JSON.parse(await resolveCredential(root, 'storage-' + service.serviceId));
      const storage = await openStorage({ binding, migrations,
        backend: createFileBackend({ id: unit, root: join(root, 'learning-resources', unit) }) });
      storages.push(storage);
      return storage;
    }
    const spaces = createSpaces(await reopen('space-course', spaceCourseMigrations));
    const courses = createCourses(storages[0], spaces);
    learning = createLearningData(await reopen('learning-data', learningMigrations), spaces, courses, {},
      { nodePath: process.execPath, sessionRoot: join(root, 'regression-sessions'),
        ...(windowsSessionHelper ? { windowsHelper: windowsSessionHelper } : {}) });
    models = await createModelGateway(await reopen('model-connection', modelMigrations),
      { authorize: identity => spaces.authorize(identity), holder: 'device' });
    const identity = activity.identity, connectionId = randomUUID(), grantId = randomUUID();
    await models.save(identity, { requestId: randomUUID(), connectionId, expectedVersion: 0,
      name: 'Recovery SDK transport', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      path: '/chat/completions', modelId: 'recovery-sdk', dialect: 'standard', parameterMode: 'plain', enabled: true,
      contextWindow: 262144, maxOutputTokens: 1024, credential: { action: 'replace', value: 'synthetic-recovery-key' } });
    await models.selection.createGrant(identity, identity, { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
    await models.selection.save(identity, { requestId: randomUUID(), expectedVersion: 0,
      source: { kind: 'personal', connectionId, grantId } });
    const database = await runtime.database();
    const { credentialRef, ...connection } = database;
    const binding = await provisionStorage({ admin: { ...connection, password: await resolveCredential(root, credentialRef) },
      owner: { environmentId: environment.environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations: teachingAgentMigrations });
    const storage = await openStorage({ binding, migrations: teachingAgentMigrations,
      backend: createFileBackend({ id: 'regression-agent', root: join(root, 'regression-agent-resources') }) });
    storages.push(storage);
    const host = createTeachingTools({ learning: () => learning, courses });
    const makeAgent = (overrides = {}) => {
      const agent = createTeachingAgent(storage, { authorize: who => spaces.authorize(who),
        identityFor: scope => spaces.lookup(scope.spaceId, scope.principalId),
        activity: (who, id) => learning.open(who, id), models, tools: host,
        start: false, driverId: randomUUID(), leaseMs: 1500, scanIntervalMs: 40, ...overrides });
      agents.push(agent);
      return agent;
    };
    return { root, activity, identity, models, learning, host, storage, payloads, makeAgent, close,
      async send(agent, works = []) {
        if (works.length) await learning.works.sync(identity, activity.activityId,
          { requestId: randomUUID(), baseRevision: 0, files: works });
        const input = actionInputSchema.parse({ requestId: randomUUID(),
          scope: { environmentId: identity.environmentId, spaceId: identity.spaceId,
            principalId: identity.principalId, activityId: activity.activityId }, receiver: agent.receiver.identity,
          draft: { token: randomUUID(), question: '读取真实依据，按步骤解释结果。', references: [], bases: [] }, works, evidence: [] });
        const receipt = await agent.accept(input, digest(input));
        assert.equal(receipt.state, 'accepted');
        return JSON.parse(receipt.detail).runId;
      },
      conversation: agent => agent.conversation(identity, activity.activityId),
      events: agent => agent.events(identity, activity.activityId),
      async completed(agent, runId) {
        let latest;
        return until(async () => {
          if (transportErrors.length) throw transportErrors[0];
          const value = await agent.conversation(identity, activity.activityId);
          latest = value;
          const run = value.runs.find(item => item.runId === runId);
          assert.ok(!['failed', 'paused', 'stopped'].includes(run?.state), JSON.stringify(value));
          return run?.state === 'completed' ? value : null;
        }, 'Original run did not recover: ' + runId).catch(async error => {
          const attempts = (await models.checks.list(identity)).map(attempt => ({ attemptId: attempt.attemptId,
            state: attempt.state, physicalRequestEnded: attempt.physicalRequestEnded, reason: attempt.reason }));
          throw new Error(error.message + '\n' + JSON.stringify({ runs: latest?.runs, tools: latest?.tools,
            waits: latest?.waits, requests: payloads.length, attempts }), { cause: error });
        });
      } };
  } catch (error) { await close(); throw error; }
}

function assertUniqueRunFacts(events, { steps, tools }) {
  for (const kind of ['tool-intent', 'tool-permitted', 'tools-paired'])
    assert.equal(events.filter(event => event.kind === kind).length, tools, kind);
  const settlements = events.filter(event => event.kind === 'budget-settled');
  assert.equal(settlements.length, steps);
  assert.equal(new Set(settlements.map(event => event.body.stepId)).size, steps);
  assert.equal(events.filter(event => event.kind === 'run-completed').length, 1);
}

test('a reserved model-step budget survives restart and prevents another paid continuation', { timeout: 180000 }, async () => {
  const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'budget.txt', kind: 'text', encoding: 'utf8',
    mediaType: 'text/plain', value: '真实预算样例：读取此固定内容。' };
  const f = await fixture((_payload, response, index) => {
    assert.equal(index, 1, 'the Run may reserve only one model step');
    reply(response, { call: { id: 'budget-read', name: 'read_work', arguments: { objectId: work.objectId, contentId: work.contentId } } });
  });
  try {
    const first = f.makeAgent({ limits: { maxModelSteps: 1 } });
    const runId = await f.send(first, [work]); first.resume();
    await until(async () => (await first.run(f.identity, f.activity.activityId, runId)).state === 'paused', 'model budget did not pause');
    const before = await f.conversation(first);
    assert.equal(before.runs[0].reason, 'model-step-budget-exhausted');
    assert.equal(before.tools[0].result.file.value, work.value);
    assert.deepEqual(before.runs[0].usage, { state: 'final', inputTokens: 20, outputTokens: 10, totalTokens: 30 });
    first.close();
    const recovered = f.makeAgent({ limits: { maxModelSteps: 100 } }); recovered.resume();
    await recovered.drain();
    assert.equal((await f.conversation(recovered)).runs[0].state, 'paused');
    assert.equal((await f.events(recovered)).filter(event => event.kind === 'budget-reserved').length, 1);
    assert.equal(f.payloads.length, 1);
  } finally { await f.close(); }
});

test('exhausting the reserved tool budget pairs not-executed and pauses before another model step', { timeout: 180000 }, async () => {
  const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'tool-budget.txt', kind: 'text', encoding: 'utf8',
    mediaType: 'text/plain', value: '只允许一次真实读取。' };
  const f = await fixture((_payload, response, index) => {
    assert.ok(index <= 2, 'tool budget exhaustion must not admit another model call');
    reply(response, { call: { id: 'tool-budget-read-' + index, name: 'read_work', arguments: { objectId: work.objectId, contentId: work.contentId } } });
  });
  try {
    const agent = f.makeAgent({ limits: { maxToolCommands: 1 } });
    const runId = await f.send(agent, [work]); agent.resume();
    await until(async () => (await agent.run(f.identity, f.activity.activityId, runId)).state === 'paused', 'tool budget did not pause');
    const result = await f.conversation(agent);
    assert.equal(result.runs[0].reason, 'tool-budget-exhausted');
    assert.deepEqual(result.tools.map(tool => tool.outcome), ['completed', 'not-dispatched']);
    assert.equal((await f.events(agent)).filter(event => event.kind === 'tool-permitted').length, 1);
    assert.equal((await f.events(agent)).filter(event => event.kind === 'tools-paired').length, 2);
    assert.equal(f.payloads.length, 2);
  } finally { await f.close(); }
});

test('saved native result survives loss before association, rereads the original attempt and reads the immutable real work',
  { timeout: 180000 }, async () => {
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'fixed.txt', kind: 'text', encoding: 'utf8',
      mediaType: 'text/plain', value: '原始测量记录：37；第二次测量：46。' };
    const f = await fixture((payload, response, index) => {
      if (index === 1) reply(response, { call: { id: 'original-read-call', name: 'read_work',
        arguments: { objectId: work.objectId, contentId: work.contentId } } });
      else {
        assert.equal(index, 2, 'recovery must not reask the first model step');
        const pair = payload.messages.find(message => message.role === 'tool');
        assert.equal(pair.tool_call_id, 'original-read-call');
        assert.equal(JSON.parse(pair.content).file.value, work.value);
        reply(response, { text: '固定作品中的两次测量是 37 和 46。' });
      }
    });
    try {
      let original;
      const reads = [];
      const gateway = { ...f.models, checks: { ...f.models.checks, async read(...args) {
        const fact = await f.models.checks.read(...args);
        if (fact.physicalRequestEnded && fact.resultRef) reads.push(fact.attemptId);
        if (!original && fact.physicalRequestEnded && fact.state === 'completed' && fact.toolIntents?.length) {
          original = fact;
          throw new Error('Injected: process lost after durable native result, before Agent association');
        }
        return fact;
      } } };
      const first = f.makeAgent({ models: gateway });
      const runId = await f.send(first, [work]);
      await until(() => original, 'did not reach complete durable native result');
      await first.drain(); first.closeDispatch(); first.close();
      assert.equal(f.payloads.length, 1);
      assert.equal((await f.events(first)).filter(event => event.kind === 'tool-intent').length, 0);
      assert.equal((await f.conversation(first)).tools.length, 0);
      // Move the real workspace head while the accepted immutable input stays unchanged.
      await f.learning.works.sync(f.identity, f.activity.activityId, { requestId: randomUUID(), baseRevision: 1,
        files: [{ ...work, contentId: randomUUID(), value: '新的内容：999。' }] });
      const recovered = f.makeAgent({ models: gateway }); recovered.resume();
      const result = await f.completed(recovered, runId);
      assert.ok(reads.filter(id => id === original.attemptId).length >= 2);
      const events = await f.events(recovered), intent = events.find(event => event.kind === 'tool-intent');
      assert.equal(intent.body.attemptId, original.attemptId);
      assert.equal(intent.body.resultRef, original.resultRef);
      assert.equal(intent.body.callId, 'original-read-call');
      assert.equal(result.tools[0].commandId, intent.body.command.commandId);
      assert.equal(result.tools[0].result.file.value, work.value);
      assert.equal(result.waits.length, 0);
      assert.equal(f.payloads.length, 2);
      assert.deepEqual(result.runs[0].usage, { state: 'final', inputTokens: 40, outputTokens: 20, totalTokens: 60 });
      assertUniqueRunFacts(events, { steps: 2, tools: 1 });
      await recovered.validate();
    } finally { await f.close(); }
  });

test('lost real native-input receipt reconciles the original command exactly once before the next stateful input',
  { timeout: 180000 }, async () => {
    let sessionRequestId;
    const f = await fixture((payload, response, index) => {
      const pairs = payload.messages.filter(message => message.role === 'tool');
      if (index === 1) reply(response, { call: { id: 'start-original', name: 'course_operation',
        arguments: { componentKey: 'counter', operationId: 'start_session', parameters: {} } } });
      else if (index === 2) {
        const started = JSON.parse(pairs.at(-1).content);
        assert.equal(started.query.session.observation.total, 0);
        sessionRequestId = started.query.requestId;
        reply(response, { call: { id: 'input-lost-receipt', name: 'course_operation', arguments: {
          componentKey: 'counter', operationId: 'advance', requestId: sessionRequestId, expectedSeq: 0, parameters: { value: 1 } } } });
      } else if (index === 3) {
        const observation = JSON.parse(payload.messages.at(-1).content[0].text);
        const result = JSON.parse(JSON.parse(observation.text).feedback);
        assert.deepEqual(result.query.session.observation, { value: 1, total: 1, applied: 1 });
        reply(response, { call: { id: 'input-after-recovery', name: 'course_operation', arguments: {
          componentKey: 'counter', operationId: 'advance', requestId: sessionRequestId, expectedSeq: 1, parameters: { value: 2 } } } });
      } else {
        assert.equal(index, 4);
        const computed = JSON.parse(pairs.at(-1).content);
        assert.deepEqual(computed.query.session.observation, { value: 3, total: 3, applied: 2 });
        reply(response, { text: '第一次输入 1，第二次输入 2；真实累加总数是 3。' });
      }
    }, { course: true });
    try {
      const dispatched = [], reconciled = [];
      let lostCommand;
      const host = { ...f.host, async dispatch(scope, command) {
        const outcome = await f.host.dispatch(scope, command);
        dispatched.push(command.commandId);
        if (command.arguments.operationId === 'advance' && !lostCommand) {
          assert.deepEqual(outcome.result.query.session.observation, { value: 1, total: 1, applied: 1 });
          lostCommand = command;
          throw new Error('Injected: actual native input applied, receipt lost');
        }
        return outcome;
      }, async reconcile(scope, command) {
        reconciled.push(command.commandId);
        return f.host.reconcile(scope, command);
      } };
      const agent = f.makeAgent({ tools: host }); agent.resume();
      const runId = await f.send(agent);
      const result = await f.completed(agent, runId);
      assert.equal(f.payloads.length, 4);
      assert.equal(dispatched.length, 3);
      assert.equal(new Set(dispatched).size, 3);
      assert.ok(reconciled.includes(lostCommand.commandId));
      const query = await f.learning.executions.read(f.identity, f.activity.activityId, sessionRequestId);
      assert.equal(query.requestId, result.tools[0].commandId);
      assert.deepEqual(query.session.observation, { value: 3, total: 3, applied: 2 });
      assert.equal(query.session.appliedSeq, 2);
      assert.equal((await f.learning.executions.sessions(f.identity, f.activity.activityId)).length, 1);
      const receipt = await f.learning.executions.controlReceipt(f.identity, f.activity.activityId, sessionRequestId, lostCommand.commandId);
      assert.equal(receipt.status, 'applied');
      assert.equal(receipt.controlId, lostCommand.commandId);
      assert.equal(result.tools.length, 3);
      assert.equal(result.tools.find(tool => tool.commandId === lostCommand.commandId).outcome, 'completed');
      assert.equal(result.waits.length, 1);
      assert.equal(result.waits[0].commandId, lostCommand.commandId);
      assert.equal(result.waits[0].state, 'consumed');
      const events = await f.events(agent);
      assertUniqueRunFacts(events, { steps: 4, tools: 3 });
      for (const kind of ['wait-created', 'wait-consumed']) {
        const waits = events.filter(event => event.kind === kind);
        assert.equal(waits.length, 1, kind);
        assert.equal(waits[0].body.commandId, lostCommand.commandId);
      }
      assert.deepEqual(events.filter(event => event.kind === 'tool-result' && event.body.commandId === lostCommand.commandId)
        .map(event => event.body.outcome.state), ['unknown', 'completed']);
      assert.deepEqual(result.runs[0].usage, { state: 'final', inputTokens: 80, outputTokens: 40, totalTokens: 120 });
      await agent.validate();
    } finally { await f.close(); }
  });

test('two real driver generations share the saved attempt and only the winner reads and settles its native call',
  { timeout: 180000 }, async () => {
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'race.txt', kind: 'text', encoding: 'utf8',
      mediaType: 'text/plain', value: '两推进者核对的原始读数为 83。' };
    const gate = deferred();
    let entered = false;
    const prepared = [];
    const f = await fixture((payload, response, index) => {
      if (index === 1) reply(response, { call: { id: 'race-original-read', name: 'read_work',
        arguments: { objectId: work.objectId, contentId: work.contentId } } });
      else {
        assert.equal(index, 2);
        const pair = payload.messages.find(message => message.role === 'tool');
        assert.equal(pair.tool_call_id, 'race-original-read');
        assert.equal(JSON.parse(pair.content).file.value, work.value);
        reply(response, { text: '原始读数是 83。' });
      }
    });
    try {
      const host = { ...f.host, async prepare(...args) {
        const command = await f.host.prepare(...args);
        prepared.push(command.commandId);
        if (!entered) { entered = true; await gate.promise; }
        return command;
      } };
      const first = f.makeAgent({ tools: host, driverId: 'real-driver-a' });
      const runId = await f.send(first, [work]);
      await until(() => entered, 'first generation did not reach the real prepare boundary');
      const second = f.makeAgent({ tools: host, driverId: 'real-driver-b' }); second.resume();
      const result = await f.completed(second, runId);
      gate.resolve(); await first.drain();
      assert.equal(prepared.length, 2);
      assert.equal(new Set(prepared).size, 1, 'generation takeover must not mint another command');
      const events = await f.events(second);
      assertUniqueRunFacts(events, { steps: 2, tools: 1 });
      assert.equal(events.find(event => event.kind === 'tool-permitted').body.generation, 2);
      assert.equal(result.tools.length, 1);
      assert.equal(result.tools[0].commandId, prepared[0]);
      assert.equal(result.tools[0].result.file.value, work.value);
      assert.equal(result.waits.length, 0);
      const dispatched = events.filter(event => event.kind === 'attempt-dispatched');
      assert.equal(dispatched.length, 2);
      assert.equal(new Set(dispatched.map(event => event.body.attemptId)).size, 2);
      const original = await f.models.checks.read(f.identity, dispatched[0].body.attemptId);
      assert.equal(original.state, 'completed');
      assert.equal(original.cancelRequested, false, 'losing the lease cannot cancel the shared original attempt');
      assert.equal(f.payloads.length, 2);
      assert.deepEqual(result.runs[0].usage, { state: 'final', inputTokens: 40, outputTokens: 20, totalTokens: 60 });
      await second.validate();
    } finally { gate.resolve(); await f.close(); }
  });

test('stop after a persisted tool permit prevents the true native host from creating any execution',
  { timeout: 180000 }, async () => {
    const gate = deferred();
    let permitted;
    const f = await fixture((_payload, response, index) => {
      assert.equal(index, 1, 'stop cannot ask a new model step');
      reply(response, { call: { id: 'stop-before-effect', name: 'course_operation',
        arguments: { componentKey: 'counter', operationId: 'start_session', parameters: {} } } });
    }, { course: true });
    try {
      const host = { ...f.host, async dispatch(scope, command) {
        permitted = command;
        await gate.promise;
        return f.host.dispatch(scope, command);
      } };
      const agent = f.makeAgent({ tools: host });
      const runId = await f.send(agent);
      await until(() => permitted, 'did not reach the actual host after durable permission');
      assert.equal((await f.events(agent)).filter(event => event.kind === 'tool-permitted').length, 1);
      await agent.stop(f.identity, f.activity.activityId, runId, { requestId: randomUUID() });
      gate.resolve(); await agent.drain();
      const stopped = await agent.run(f.identity, f.activity.activityId, runId);
      assert.equal(stopped.state, 'stopped');
      assert.equal((await f.learning.executions.sessions(f.identity, f.activity.activityId)).length, 0);
      assert.equal(await f.learning.executions.read(f.identity, f.activity.activityId, permitted.commandId), null);
      assert.equal(f.payloads.length, 1);
      const events = await f.events(agent);
      assert.equal(events.filter(event => event.kind === 'tool-intent').length, 1);
      assert.equal(events.filter(event => event.kind === 'tool-permitted').length, 1);
      assert.equal(events.filter(event => event.kind === 'run-stopped').length, 1);
      assert.equal(events.filter(event => event.kind === 'run-completed').length, 0);
      const conversation = await f.conversation(agent);
      assert.deepEqual(conversation.runs[0].usage,
        { state: 'final', inputTokens: 20, outputTokens: 10, totalTokens: 30 });
      assert.equal(events.filter(event => event.kind === 'budget-settled').length, 1);
    } finally { gate.resolve(); await f.close(); }
  });

test('stopping a later model step stops the Agent ongoing native session and preserves a student independent session',
  { timeout: 180000 }, async () => {
    const gate = deferred();
    let sessionRequestId, explaining = false;
    const f = await fixture(async (payload, response, index) => {
      if (index === 1) reply(response, { call: { id: 'ongoing-start', name: 'course_operation',
        arguments: { componentKey: 'counter', operationId: 'start_session', parameters: {} } } });
      else if (index === 2) {
        const started = JSON.parse(payload.messages.find(message => message.role === 'tool').content);
        sessionRequestId = started.query.requestId;
        reply(response, { call: { id: 'ongoing-input', name: 'course_operation', arguments: {
          componentKey: 'counter', operationId: 'advance', requestId: sessionRequestId, expectedSeq: 0, parameters: { value: 2 } } } });
      } else {
        assert.equal(index, 3);
        const result = JSON.parse(payload.messages.filter(message => message.role === 'tool').at(-1).content);
        assert.deepEqual(result.query.session.observation, { value: 2, total: 2, applied: 1 });
        explaining = true;
        await gate.promise;
        if (!response.destroyed) reply(response, { text: '原输入已经完成。' });
      }
    }, { course: true });
    try {
      const agent = f.makeAgent({ leaseMs: 10_000 }); agent.resume();
      const runId = await f.send(agent);
      await until(() => explaining, 'did not reach the model step after real native input');
      const before = await f.conversation(agent);
      assert.equal(before.tools.length, 2);
      assert.ok(before.tools.every(tool => tool.outcome === 'completed'));
      const action = structuredClone(before.tools[0].basis.action);
      action.requestId = randomUUID();
      action.execution.initiator = { kind: 'student', principalId: f.identity.principalId };
      const independent = await f.learning.executions.accept(f.identity, f.activity.activityId, { action });
      assert.equal(independent.state, 'running');
      await agent.stop(f.identity, f.activity.activityId, runId, { requestId: randomUUID() });
      gate.resolve();
      await until(async () => (await agent.run(f.identity, f.activity.activityId, runId)).state === 'stopped',
        'stopping the later model did not settle the original Run').catch(async error => {
        throw new Error(error.message + '\n' + JSON.stringify({ conversation: await f.conversation(agent), events: await f.events(agent) }));
      });
      await agent.drain();
      const stopped = await f.learning.executions.read(f.identity, f.activity.activityId, sessionRequestId);
      assert.equal(stopped.state, 'cancelled');
      assert.deepEqual(stopped.session.observation, { value: 2, total: 2, applied: 1 });
      const preserved = await f.learning.executions.read(f.identity, f.activity.activityId, independent.requestId);
      assert.equal(preserved.executionRef, independent.executionRef);
      assert.equal(preserved.state, 'running');
      assert.equal(preserved.stopRequested, false);
      assert.equal(preserved.session.appliedSeq, 0);
      const after = await f.conversation(agent);
      assert.equal(after.tools.length, 2);
      assert.ok(after.tools.every(tool => tool.outcome === 'completed'), 'completed inputs remain completed');
      assert.deepEqual(after.tools[1].result.query.session.observation, { value: 2, total: 2, applied: 1 });
      assert.equal(after.tools[0].result.stoppedExecution.query.state, 'cancelled');
      assert.equal(after.tools[1].result.stoppedExecution.query.state, 'cancelled');
      const events = await f.events(agent);
      assert.equal(events.filter(event => event.kind === 'tool-permitted').length, 2);
      assert.equal(events.filter(event => event.kind === 'run-stopped').length, 1);
      assert.equal(events.filter(event => event.kind === 'run-completed').length, 0);
      assert.equal(f.payloads.length, 3);
      await agent.validate();
    } finally { gate.resolve(); await f.close(); }
  });

test('pending cleanup of completed native inputs survives Agent restart without reviving the stopped Run',
  { timeout: 180000 }, async t => {
    const gate = deferred(), children = [];
    const originalCreate = SupervisedSession.create;
    t.mock.method(SupervisedSession, 'create', async function (...args) {
      const child = await originalCreate.apply(this, args);
      children.push(child);
      return child;
    });
    let sessionRequestId, explaining = false, holdStop = true;
    const f = await fixture(async (payload, response, index) => {
      if (index === 1) reply(response, { call: { id: 'cleanup-start', name: 'course_operation',
        arguments: { componentKey: 'counter', operationId: 'start_session', parameters: {} } } });
      else if (index === 2) {
        const started = JSON.parse(payload.messages.find(message => message.role === 'tool').content);
        sessionRequestId = started.query.requestId;
        reply(response, { call: { id: 'cleanup-input', name: 'course_operation', arguments: {
          componentKey: 'counter', operationId: 'advance', requestId: sessionRequestId, expectedSeq: 0, parameters: { value: 2 } } } });
      } else {
        assert.equal(index, 3, 'cleanup must not request another model generation');
        const result = JSON.parse(payload.messages.filter(message => message.role === 'tool').at(-1).content);
        assert.deepEqual(result.query.session.observation, { value: 2, total: 2, applied: 1 });
        explaining = true;
        await gate.promise;
        if (!response.destroyed) reply(response, { text: '原输入已经完成。' });
      }
    }, { course: true });
    try {
      const agent = f.makeAgent({ leaseMs: 10_000 }); agent.resume();
      const runId = await f.send(agent);
      await until(() => explaining, 'did not reach the later model step after completed native input');
      const before = await f.conversation(agent);
      assert.equal(before.tools.length, 2);
      assert.ok(before.tools.every(tool => tool.state === 'settled' && tool.outcome === 'completed'));
      const child = children.find(item => item.instanceId === before.tools[0].result.query.session.executorInstanceId);
      assert.ok(child, 'capture the actual Agent-owned supervised child');
      const originalStop = child.stop.bind(child);
      // Only delay stop confirmation at the OS boundary; every tool outcome remains real.
      t.mock.method(child, 'stop', (...args) => holdStop ? Promise.resolve(false) : originalStop(...args));
      const action = structuredClone(before.tools[0].basis.action);
      action.requestId = randomUUID();
      action.execution.initiator = { kind: 'student', principalId: f.identity.principalId };
      const independent = await f.learning.executions.accept(f.identity, f.activity.activityId, { action });
      const independentChild = children.find(item => item.instanceId === independent.session.executorInstanceId);
      assert.ok(independentChild);
      assert.equal(independent.state, 'running');

      await agent.stop(f.identity, f.activity.activityId, runId, { requestId: randomUUID() });
      gate.resolve();
      await until(async () => (await agent.run(f.identity, f.activity.activityId, runId)).state === 'stopped',
        'the later model step did not stop').catch(async error => {
        throw new Error(error.message + '\n' + JSON.stringify({ conversation: await f.conversation(agent), events: await f.events(agent) }));
      });
      await agent.drain();
      agent.close();
      assert.equal(child.exitFact, null);
      assert.doesNotThrow(() => process.kill(child.pid, 0), 'the actual child is still alive');
      const pendingCleanup = await f.conversation(agent);
      const cleanupWaits = pendingCleanup.waits.filter(wait => wait.reason === 'cleanup');
      assert.equal(cleanupWaits.length, 2, 'settled native commands require independent durable cleanup Waits');
      for (const tool of before.tools) {
        const wait = cleanupWaits.find(wait => wait.commandId === tool.commandId);
        assert.equal(wait?.state, 'pending');
        assert.equal(wait.runId, runId);
        assert.equal(wait.stepId, tool.stepId);
        assert.equal(wait.consumedAt, null);
      }
      assert.deepEqual(pendingCleanup.tools[1].result.query, before.tools[1].result.query);
      await agent.validate();

      const recovered = f.makeAgent();
      const reopened = await f.conversation(recovered);
      assert.deepEqual(reopened.waits, pendingCleanup.waits, 'cleanup identity and deadlines survive restart');
      assert.equal(reopened.runs[0].state, 'stopped');
      holdStop = false;
      assert.equal(await originalStop(), true, 'the real child exits only after recovery');
      assert.equal(child.exitFact.confirmed, true);
      await until(async () => (await f.learning.executions.read(f.identity, f.activity.activityId, sessionRequestId)).state === 'cancelled',
        'the real execution owner did not archive the child exit');
      recovered.resume();
      const settled = await until(async () => {
        const value = await f.conversation(recovered);
        return cleanupWaits.every(wait => value.waits.find(item => item.waitId === wait.waitId)?.state === 'consumed') ? value : null;
      }, 'recovered cleanup did not archive and consume the original Waits');
      assert.equal(settled.runs[0].state, 'stopped');
      for (const tool of before.tools) {
        const archived = settled.tools.find(item => item.commandId === tool.commandId);
        assert.equal(archived.state, 'settled');
        assert.equal(archived.outcome, 'completed');
        assert.equal(archived.feedback, tool.feedback);
        assert.deepEqual(archived.result.query, tool.result.query, 'completed operation inputs remain immutable');
        assert.equal(archived.result.stoppedExecution.query.state, 'cancelled');
        assert.equal(archived.result.stoppedExecution.sessionStopped, true);
      }
      assert.deepEqual(settled.tools[1].result.query.session.observation, { value: 2, total: 2, applied: 1 });
      const preserved = await f.learning.executions.read(f.identity, f.activity.activityId, independent.requestId);
      assert.equal(preserved.executionRef, independent.executionRef);
      assert.equal(preserved.state, 'running');
      assert.equal(preserved.stopRequested, false);
      assert.equal(preserved.session.appliedSeq, 0);
      assert.equal(independentChild.exitFact, null);
      assert.doesNotThrow(() => process.kill(independentChild.pid, 0));
      const events = await f.events(recovered);
      for (const wait of cleanupWaits) {
        const consumed = settled.waits.find(item => item.waitId === wait.waitId);
        assert.ok(consumed.consumedAt);
        assert.equal(consumed.deadline, wait.deadline);
        for (const kind of ['wait-created', 'wait-consumed'])
          assert.equal(events.filter(event => event.kind === kind && event.body.waitId === wait.waitId).length, 1, kind);
        assert.equal(events.find(event => event.kind === 'wait-consumed' && event.body.waitId === wait.waitId).body.terminalRun, true);
        assert.equal(events.filter(event => event.kind === 'tool-result' && event.body.commandId === wait.commandId
          && event.body.phase === 'stop-original-execution' && event.body.outcome.result.sessionStopped === true).length, 1);
      }
      assert.equal(events.filter(event => event.kind === 'run-stopped').length, 1);
      assert.equal(events.filter(event => event.kind === 'run-completed').length, 0);
      recovered.close();
      const again = f.makeAgent(); again.resume();
      await again.drain();
      await again.stop(f.identity, f.activity.activityId, runId, { requestId: randomUUID() });
      assert.deepEqual((await f.conversation(again)).tools, settled.tools, 'repeated recovery cannot rewrite archived cleanup');
      assert.deepEqual((await f.conversation(again)).waits, settled.waits);
      assert.deepEqual(await f.events(again), events, 'terminal cleanup and Wait consumption happen once');
      assert.equal(f.payloads.length, 3);
      await again.validate();
    } finally {
      holdStop = false; gate.resolve();
      await Promise.allSettled(children.map(child => child.dispose()));
      await f.close();
    }
  });

test('expired Waits archive a late real Wasm result once, preserve paused or stopped Runs and release the component lane',
  { timeout: 180000 }, async t => {
    for (const terminalState of ['paused', 'stopped']) await t.test(terminalState, async () => {
      const f = await fixture((_payload, response, index) => {
        assert.ok(index <= 2, 'only the original Run and a new student request may call the model');
        reply(response, { call: { id: 'expired-aggregate-' + index, name: 'course_operation', arguments: {
          componentKey: 'table', operationId: 'aggregate',
          parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } } } });
      }, { course: 'browser' });
      try {
        const binding = f.activity.course.components[0], manifest = binding.definition.manifest;
        const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/table.json', kind: 'state',
          encoding: 'json', mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify({
            formatVersion: 1, instanceId: f.activity.activityId + ':table', componentId: manifest.componentId,
            version: manifest.version, definitionDigest: binding.definition.digest, stateVersion: 1,
            operationId: randomUUID(), content: manifest.initialState }) };
        const agent = f.makeAgent({ limits: { waitMs: 1 } });
        const runId = await f.send(agent, [work]);
        const waiting = await until(async () => {
          const value = await f.conversation(agent);
          return value.waits.length === 1 && value.runs[0].state === 'waiting' ? value : null;
        }, 'browser command did not persist its Wait');
        await agent.drain();
        const commandId = waiting.tools[0].commandId, browserId = randomUUID();
        const execution = f.learning.executions;
        const claimed = await execution.agent.claimBrowser(f.identity, f.activity.activityId, commandId, browserId,
          association => agent.assertCommandDispatch(f.identity, f.activity.activityId, association));
        const action = claimed.action;
        assert.equal(action.requestId, commandId);
        // Execute the published WP03 Wasm; delay only the original receipt and result delivery.
        const ts = await import('../../../packages/learning-space/node_modules/typescript/lib/typescript.js');
        const source = await readFile(new URL('../../web/src/tool-execution/algorithm.ts', import.meta.url), 'utf8');
        const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
        const algorithm = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
        const published = await aggregationPackage();
        const computed = algorithm.runAggregation({ ...algorithm.jobFromAction(action, action.execution.limits),
          bytes: Buffer.from(published.algorithmBase64, 'base64'), memoryPages: manifest.algorithm.memoryPages,
          entry: manifest.algorithm.entry });
        assert.equal(computed.result.value, 83.33333333333333);
        assert.equal(computed.result.groups[0].mean, 83);
        if (terminalState === 'stopped') {
          await agent.stop(f.identity, f.activity.activityId, runId, { requestId: randomUUID() });
          await agent.drain();
        }
        agent.resume();
        const expired = await until(async () => {
          const value = await f.conversation(agent);
          return value.waits[0].state === 'expired' && value.runs[0].state === terminalState ? value : null;
        }, 'Wait expiry did not preserve the terminal Run state');
        assert.equal(expired.tools[0].state, 'waiting');
        if (terminalState === 'paused') assert.equal(expired.runs[0].reason, 'wait-expired');
        assert.equal(f.payloads.length, 1, 'expiry cannot request a model continuation');
        agent.close();
        const recovered = f.makeAgent();
        const acceptance = { receipt: { requestId: commandId, receiver: action.receiver, state: 'accepted',
          inputDigest: digest(executionActionSchema.parse(action)), receiptId: 'expired-browser:' + commandId, detail: '' },
          execution: { executionRef: randomUUID(), acceptedSeq: 1 } };
        const archive = () => execution.agent.acceptBrowser(f.identity, f.activity.activityId, commandId, browserId, acceptance,
          association => recovered.assertCommandDispatch(f.identity, f.activity.activityId, association));
        const archived = await archive();
        const bytes = Buffer.from(computed.artifact.text);
        const result = { contentId: randomUUID(), output: computed.result, text: computed.artifact.text,
          name: computed.artifact.name, mediaType: computed.artifact.mediaType,
          sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
        const stored = await execution.result(f.identity, f.activity.activityId, commandId, result);
        const report = { ...stored, state: 'succeeded', confirmedSeq: 3 };
        await execution.report(f.identity, f.activity.activityId, commandId, report);
        // Clock injection only: make the saved check due without rewriting any Wait/Run state.
        await f.storage.request({ requestId: randomUUID(), fingerprint: commandId }, async tx => {
          await tx.query("UPDATE teaching_waits SET next_check_at=clock_timestamp()-interval '1 second' WHERE command_id=$1", [commandId]);
          return null;
        });
        recovered.resume();
        const settled = await until(async () => {
          const value = await f.conversation(recovered);
          return value.waits[0].state === 'consumed' ? value : null;
        }, 'late original Wasm result was not archived after Wait expiry', 5000);
        assert.equal(settled.runs[0].state, terminalState);
        assert.equal(settled.tools[0].commandId, commandId);
        assert.equal(settled.tools[0].runId, runId);
        assert.equal(settled.tools[0].state, 'settled');
        assert.equal(settled.tools[0].outcome, 'completed');
        assert.equal(settled.tools[0].result.query.output.output.value, 83.33333333333333);
        assert.equal(settled.tools[0].result.artifact.text, computed.artifact.text);
        assert.ok(settled.waits[0].consumedAt);
        await archive();
        await execution.result(f.identity, f.activity.activityId, commandId, result);
        await execution.report(f.identity, f.activity.activityId, commandId, report);
        recovered.close();
        const again = f.makeAgent(); again.resume();
        await again.drain();
        assert.deepEqual((await f.conversation(again)).tools, settled.tools);
        assert.equal((await execution.read(f.identity, f.activity.activityId, commandId)).executionRef, archived.executionRef);
        // A new request for this same component must obtain the lane held by the expired command.
        const nextRunId = await f.send(again);
        const next = await until(async () => {
          const value = await f.conversation(again);
          return value.tools.find(tool => tool.runId === nextRunId && tool.state === 'waiting');
        }, 'the archived expired command still blocks the component lane');
        assert.notEqual(next.commandId, commandId);
        const nextClaim = await execution.agent.claimBrowser(f.identity, f.activity.activityId, next.commandId, randomUUID(),
          association => again.assertCommandDispatch(f.identity, f.activity.activityId, association));
        assert.equal(nextClaim.action.requestId, next.commandId);
        const events = (await f.events(again)).filter(event => event.body.runId === runId);
        for (const kind of ['tool-intent', 'tool-permitted', 'wait-created', 'wait-expired', 'wait-consumed'])
          assert.equal(events.filter(event => event.kind === kind).length, 1, kind);
        assert.equal(events.filter(event => event.kind === 'tool-result' && event.body.outcome.state === 'accepted').length, 1);
        assert.equal(events.filter(event => event.kind === 'tool-result' && event.body.outcome.state === 'completed').length, 1,
          'the late terminal result is archived once, independently of stop-request progress');
        assert.equal(events.find(event => event.kind === 'wait-consumed').body.terminalRun, true);
        assert.equal(events.filter(event => event.kind === 'run-completed').length, 0);
        assert.equal((await again.run(f.identity, f.activity.activityId, runId)).state, terminalState);
        assert.equal(f.payloads.length, 2);
        await again.validate();
      } finally { await f.close(); }
    });
  });

test('a real Wasm result arriving after stopped terminal is archived and consumed once without reviving the Run',
  { timeout: 180000 }, async () => {
    const f = await fixture((_payload, response, index) => {
      assert.equal(index, 1, 'a stopped Run never asks the model to explain its late result');
      reply(response, { call: { id: 'late-aggregate', name: 'course_operation', arguments: {
        componentKey: 'table', operationId: 'aggregate',
        parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } } } });
    }, { course: 'browser' });
    try {
      const binding = f.activity.course.components[0], manifest = binding.definition.manifest;
      const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/table.json', kind: 'state',
        encoding: 'json', mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify({
          formatVersion: 1, instanceId: f.activity.activityId + ':table', componentId: manifest.componentId,
          version: manifest.version, definitionDigest: binding.definition.digest, stateVersion: 1,
          operationId: randomUUID(), content: manifest.initialState }) };
      const agent = f.makeAgent();
      const runId = await f.send(agent, [work]);
      const waiting = await until(async () => {
        const value = await f.conversation(agent);
        return value.waits.length === 1 && value.runs[0].state === 'waiting' ? value : null;
      }, 'browser command did not persist its Wait');
      await agent.drain();
      const commandId = waiting.tools[0].commandId, browserId = randomUUID();
      const execution = f.learning.executions;
      const claimed = await execution.agent.claimBrowser(f.identity, f.activity.activityId, commandId, browserId,
        association => agent.assertCommandDispatch(f.identity, f.activity.activityId, association));
      const action = claimed.action;
      assert.equal(action.requestId, commandId);
      assert.deepEqual(action.execution.basis.works, [work]);
      // Compute before stop at the real WP03 ABI. Only delivery of the original receipt/result is late.
      const ts = await import('../../../packages/learning-space/node_modules/typescript/lib/typescript.js');
      const source = await readFile(new URL('../../web/src/tool-execution/algorithm.ts', import.meta.url), 'utf8');
      const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
      const algorithm = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
      const published = await aggregationPackage();
      const computed = algorithm.runAggregation({ ...algorithm.jobFromAction(action, action.execution.limits),
        bytes: Buffer.from(published.algorithmBase64, 'base64'), memoryPages: manifest.algorithm.memoryPages,
        entry: manifest.algorithm.entry });
      assert.equal(computed.result.value, 83.33333333333333);
      assert.equal(computed.result.groups[0].mean, 83);
      await agent.stop(f.identity, f.activity.activityId, runId, { requestId: randomUUID() });
      await agent.drain();
      assert.equal((await agent.run(f.identity, f.activity.activityId, runId)).state, 'stopped');
      assert.equal((await f.conversation(agent)).waits[0].state, 'pending');
      const acceptance = { receipt: { requestId: commandId, receiver: action.receiver, state: 'accepted',
        inputDigest: digest(executionActionSchema.parse(action)), receiptId: 'original-browser:' + commandId, detail: '' },
        execution: { executionRef: randomUUID(), acceptedSeq: 1 } };
      const archive = () => execution.agent.acceptBrowser(f.identity, f.activity.activityId, commandId, browserId, acceptance,
        association => agent.assertCommandDispatch(f.identity, f.activity.activityId, association));
      const archived = await archive();
      assert.equal(archived.stopRequested, true);
      assert.equal(archived.executionRef, acceptance.execution.executionRef);
      const bytes = Buffer.from(computed.artifact.text);
      const result = { contentId: randomUUID(), output: computed.result, text: computed.artifact.text,
        name: computed.artifact.name, mediaType: computed.artifact.mediaType,
        sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
      const stored = await execution.result(f.identity, f.activity.activityId, commandId, result);
      const report = { ...stored, state: 'succeeded', confirmedSeq: 3 };
      await execution.report(f.identity, f.activity.activityId, commandId, report);
      agent.resume();
      const settled = await until(async () => {
        const value = await f.conversation(agent);
        return value.waits[0].state === 'consumed' ? value : null;
      }, 'late original computation was not archived in its stopped Run').catch(async error => {
        const conversation = await f.conversation(agent);
        throw new Error(error.message + '\n' + JSON.stringify({ run: conversation.runs[0], tools: conversation.tools,
          waits: conversation.waits, execution: await execution.read(f.identity, f.activity.activityId, commandId),
          events: (await f.events(agent)).map(event => ({ kind: event.kind, body: event.body })) }), { cause: error });
      });
      assert.equal(settled.runs[0].state, 'stopped');
      assert.equal(settled.tools[0].commandId, commandId);
      assert.ok(settled.tools[0].result.query, JSON.stringify(settled.tools[0]));
      assert.equal(settled.tools[0].result.query.output.output.value, 83.33333333333333);
      assert.equal(settled.tools[0].result.artifact.text, computed.artifact.text);
      const beforeDuplicates = await f.events(agent);
      // Repeated actual deliveries retain the same execution, resource and consumed Wait.
      await archive();
      await execution.result(f.identity, f.activity.activityId, commandId, result);
      await execution.report(f.identity, f.activity.activityId, commandId, report);
      const recovered = f.makeAgent(); recovered.resume();
      await recovered.drain();
      assert.deepEqual((await f.conversation(recovered)).tools, settled.tools);
      const events = await f.events(recovered);
      assert.equal(events.filter(event => event.kind === 'tool-result').length,
        beforeDuplicates.filter(event => event.kind === 'tool-result').length);
      for (const kind of ['tool-intent', 'tool-permitted', 'wait-created', 'wait-consumed', 'run-stopped'])
        assert.equal(events.filter(event => event.kind === kind).length, 1, kind);
      assert.equal(events.find(event => event.kind === 'wait-consumed').body.terminalRun, true);
      assert.equal(events.filter(event => event.kind === 'run-completed').length, 0);
      assert.equal(f.payloads.length, 1);
      assert.deepEqual(settled.runs[0].usage, { state: 'final', inputTokens: 20, outputTokens: 10, totalTokens: 30 });
      assert.equal((await execution.read(f.identity, f.activity.activityId, commandId)).executionRef, archived.executionRef);
      await recovered.validate();
    } finally { await f.close(); }
  });
