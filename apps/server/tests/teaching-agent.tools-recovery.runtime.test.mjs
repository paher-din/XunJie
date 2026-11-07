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
  teachingAgentMigrations, SupervisedSession, collectTeachingBoundary, createTeachingDependencyClient, createTeachingDependencyService,
  createTeachingAgentClient, createTeachingAgentService, createNativeChannel } from '@xunjie/learning-space';
import { createExecutions } from '../../../packages/learning-space/dist/learning-data/executions.js';
import { actionInputSchema } from '@xunjie/contracts/action-intents';
import { executionActionSchema, canonicalValue } from '@xunjie/contracts/execution';
import { accumulatorPackage } from '../../../components/state-accumulator/package.mjs';
import { aggregationPackage } from '../../../components/table-aggregation/package.mjs';
import { runPublishedAggregation } from './support/teaching-recovery.mjs';

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
function reply(response, { call, text = '', unknownUsage = false }) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const value of [
    { id: 'recovery-sdk', choices: [{ index: 0, delta: { role: 'assistant', content: text,
      ...(call ? { tool_calls: [{ index: 0, id: call.id, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : {}) }, finish_reason: null }] },
    { id: 'recovery-sdk', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] },
    ...(unknownUsage ? [] : [{ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }]),
  ]) response.write('data: ' + JSON.stringify(value) + '\n\n');
  response.end('data: [DONE]\n\n');
}
function protocolReply(response, protocol, text) {
  if (protocol === 'chat-completions') return reply(response, { text });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = event => response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
  if (protocol === 'responses') send({ type: 'response.completed', response: { id: 'resp-switched', object: 'response', status: 'completed',
    output: [{ id: 'msg-switched', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } });
  else {
    send({ type: 'message_start', message: { id: 'msg-switched', type: 'message', role: 'assistant', model: 'next-step-model',
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } });
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    send({ type: 'content_block_stop', index: 0 });
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 20, output_tokens: 10 } });
    send({ type: 'message_stop' });
  }
  response.end();
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
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
      const { ownedStorage = storage, ...driverOptions } = overrides;
      const agent = createTeachingAgent(ownedStorage, { authorize: who => spaces.authorize(who),
        identityFor: scope => spaces.lookup(scope.spaceId, scope.principalId),
        activity: (who, id) => learning.open(who, id), models, tools: host,
        // Ordinary scenarios use the production lease; takeover scenarios below
        // explicitly keep the short lease required by their injected process loss.
        start: false, driverId: randomUUID(), scanIntervalMs: 40, ...driverOptions });
      agents.push(agent);
      return agent;
    };
    return { root, activity, identity, models, learning, host, storage, agentBinding: binding, courses, learningStorage: storages[1], payloads, makeAgent, close,
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

test('model switching recovers lost owner replies across driver instances without repeating effects', { timeout: 180000 }, async () => {
  const f = await fixture((_payload, response) => reply(response, { text: '保留原回答与预算' }));
  try {
    const original = f.makeAgent();
    const runId = await f.send(original); original.resume();
    await f.completed(original, runId); original.close();
    const runBefore = await original.run(f.identity, f.activity.activityId, runId);
    const prior = await f.models.selection.snapshot(f.identity, 1);
    const connectionId = randomUUID(), grantId = randomUUID();
    await f.models.save(f.identity, { requestId: randomUUID(), connectionId, expectedVersion: 0,
      name: 'Fixed switch destination', protocol: 'chat-completions', baseUrl: prior.choice.connection.baseUrl,
      path: '/chat/completions', modelId: 'fixed-switch-target', dialect: 'standard', parameterMode: 'plain', enabled: true,
      contextWindow: 262144, maxOutputTokens: 1024, credential: { action: 'replace', value: 'synthetic-switch-key' } });
    await f.models.selection.createGrant(f.identity, f.identity, { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
    await f.models.selection.save(f.identity, { requestId: randomUUID(), expectedVersion: 1,
      source: { kind: 'personal', grantId, connectionId } });
    const input = { requestId: randomUUID(), selectionVersion: 2 };
    let closeEffects = 0, createEffects = 0;
    const enteredCreate = deferred(), releaseCreate = deferred();
    const faulted = { ...f.models, segments: { ...f.models.segments,
      async close(...args) {
        const result = await f.models.segments.close(...args);
        closeEffects++;
        if (closeEffects === 1) throw new Error('injected lost close reply');
        return result;
      },
      async create(...args) {
        enteredCreate.resolve(); await releaseCreate.promise;
        const result = await f.models.segments.create(...args); createEffects++;
        if (createEffects === 1) throw new Error('injected lost create reply');
        return result;
      } } };
    const first = f.makeAgent({ models: faulted });
    assert.equal((await first.switchModel(f.identity, f.activity.activityId, input)).state, 'paused');
    const second = f.makeAgent({ models: faulted });
    const pending = second.switchModel(f.identity, f.activity.activityId, input);
    await enteredCreate.promise;
    const contender = f.makeAgent({ models: faulted });
    assert.notEqual((await contender.switchModel(f.identity, f.activity.activityId, input)).state, 'completed');
    assert.equal(createEffects, 0, 'contender did not enter the remote effect');
    releaseCreate.resolve();
    assert.equal((await pending).state, 'paused');
    const recovered = f.makeAgent();
    const done = await recovered.switchModel(f.identity, f.activity.activityId, input);
    assert.equal(done.state, 'completed');
    assert.equal(done.model.modelId, 'fixed-switch-target');
    assert.equal(closeEffects, 1, 'closed original boundary is queried, never closed again');
    assert.equal(createEffects, 1, 'lost creation acknowledgement is recovered from the owner receipt');
    assert.equal((await f.events(recovered)).filter(event => event.kind === 'model-switch-completed').length, 1);
    const runAfter = await recovered.run(f.identity, f.activity.activityId, runId);
    assert.deepEqual(runAfter.usage, runBefore.usage);
    assert.equal(f.payloads.length, 1, 'switch recovery never pays for another model generation');
    await f.models.selection.revoke(f.identity, grantId, { requestId: randomUUID(), expectedVersion: 1 });
    await assert.rejects(() => recovered.switchModel(f.identity, f.activity.activityId, input), /forbidden/);
    await recovered.validate();
  } finally { await f.close(); }
});

test('an expired switch lease is taken over and a late old driver cannot overwrite completion', { timeout: 180000 }, async () => {
  const f = await fixture((_payload, response) => reply(response, { text: '原结果' }));
  const entered = deferred(), release = deferred();
  let pending;
  try {
    const original = f.makeAgent(); const runId = await f.send(original); original.resume();
    await f.completed(original, runId); original.close();
    const delayed = { ...f.models, segments: { ...f.models.segments, async create(...args) {
      entered.resolve(); await release.promise; return f.models.segments.create(...args);
    } } };
    const first = f.makeAgent({ models: delayed, leaseMs: 60_000 });
    const input = { requestId: randomUUID(), selectionVersion: 1 };
    pending = first.switchModel(f.identity, f.activity.activityId, input);
    await entered.promise;
    // Fault injection at the owner-coordination boundary: the original process
    // stopped renewing its persisted lease. The real owner operations stay intact.
    await f.storage.request({ requestId: randomUUID(), fingerprint: input.requestId }, async tx => {
      await tx.query("UPDATE teaching_model_switches SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE request_id=$1", [input.requestId]);
      return null;
    });
    const successor = f.makeAgent();
    const completed = await successor.switchModel(f.identity, f.activity.activityId, input);
    assert.equal(completed.state, 'completed');
    release.resolve();
    assert.deepEqual(await pending, completed, 'late driver only observes the successor completion');
    assert.equal((await f.events(successor)).filter(event => event.kind === 'model-switch-completed').length, 1);
    assert.equal(f.payloads.length, 1);
    await successor.validate();
  } finally { release.resolve(); await pending?.catch(() => {}); await f.close(); }
});

test('published WP07 owner migrations upgrade populated Runs and grants without replacing their histories', { timeout: 180000 }, async () => {
  const f = await fixture((_payload, response) => reply(response, { text: 'not dispatched' }));
  let older, upgraded;
  try {
    const database = await openProductRuntime({ root: f.root }).database();
    const { credentialRef, ...connection } = database;
    const admin = { ...connection, password: await resolveCredential(f.root, credentialRef) };
    for (const [kind, migrations, prefix] of [['agent', teachingAgentMigrations, 5], ['models', modelMigrations, 15]]) {
      const owner = { environmentId: f.identity.environmentId, serviceId: randomUUID() }, password = randomUUID();
      const backend = createFileBackend({ id: 'upgrade-' + kind, root: join(f.root, 'upgrade-' + kind) });
      const binding = await provisionStorage({ admin, owner, password, migrations: migrations.slice(0, prefix) });
      older = await openStorage({ binding, backend, migrations: migrations.slice(0, prefix) });
      const runId = randomUUID(), stepId = randomUUID(), grantId = randomUUID(), scope = 'migration-scope';
      await older.request({ requestId: randomUUID(), fingerprint: 'old-owner-data' }, async tx => {
        if (kind === 'agent') {
          await tx.query(`INSERT INTO teaching_runs(run_id,activity_id,request_id,input_id,identity,state,usage,created_at)
            VALUES($1,$2,$3,$4,$5,'completed',$6,'2026-11-01T00:00:00Z')`,
            [runId, f.activity.activityId, randomUUID(), randomUUID(), f.identity, { state: 'final', inputTokens: 20, outputTokens: 10 }]);
          await tx.query('INSERT INTO teaching_budgets VALUES($1,3,7,1,1234)', [runId]);
          await tx.query(`INSERT INTO teaching_steps(step_id,run_id,step_no,attempt_id,segment_id,snapshot_id,phase,plan,output_reserved,usage)
            VALUES($1,$2,0,$3,$4,$5,'final',$6,1024,$7)`, [stepId, runId, randomUUID(), randomUUID(), randomUUID(),
            { model: { contextWindow: 262144 } }, { state: 'final', inputTokens: 20, outputTokens: 10 }]);
        } else await tx.query('INSERT INTO model_paired_grants VALUES($1,$2,$3,$4,1)', [scope, 'segment', stepId, grantId]);
        return null;
      });
      const participant = older.participant();
      await participant.closeWrites(); await participant.closeDispatch(); await participant.drain();
      await older.close(); older = undefined;
      const updated = await provisionStorage({ admin, owner, password, migrations });
      upgraded = await openStorage({ binding: updated, backend, migrations });
      await upgraded.participant().resume();
      if (kind === 'agent') {
        const { rows: [budget] } = await upgraded.read('SELECT * FROM teaching_budgets WHERE run_id=$1', [runId]);
        assert.equal(budget.max_model_steps, 3); assert.equal(budget.max_tool_commands, 7); assert.equal(Number(budget.wait_ms), 1234);
        assert.equal(new Date(budget.deadline).toISOString(), '2026-11-02T00:00:00.000Z');
        assert.equal(Number(budget.max_input_tokens), 1048576); assert.equal(Number(budget.max_output_tokens), 65536);
        const { rows: [step] } = await upgraded.read('SELECT * FROM teaching_steps WHERE step_id=$1', [stepId]);
        assert.equal(Number(step.input_reserved), 262144); assert.equal(step.usage.inputTokens, 20);
        assert.equal(step.dispatch_generation, null, 'published Agent deployment columns remain present');
      } else {
        assert.equal((await upgraded.read('SELECT * FROM model_paired_grants WHERE id=$1', [stepId])).rows[0].grant_id, grantId);
        await upgraded.request({ requestId: randomUUID(), fingerprint: 'new-pin-grant' }, async tx => {
          await tx.query('INSERT INTO model_paired_grants VALUES($1,$2,$3,$4,1)', [scope, 'pin', randomUUID(), grantId]); return null;
        });
      }
      await upgraded.close(); upgraded = undefined;
    }
    assert.equal(f.payloads.length, 0);
  } finally { await older?.close(); await upgraded?.close(); await f.close(); }
});

test('an accepted unsent model attempt is cancelled at the fixed Run deadline without leaving a native slot', { timeout: 180000 }, async () => {
  const f = await fixture((_payload, response) => reply(response, { text: 'must not be called' }));
  const entered = deferred(), release = deferred();
  try {
    let attempt;
    const models = { ...f.models, checks: { ...f.models.checks, async receive(...args) {
      attempt = await f.models.checks.receive(...args); entered.resolve(); await release.promise; return attempt;
    } } };
    const agent = f.makeAgent({ models, limits: { hardDeadlineMs: 2000 } });
    const runId = await f.send(agent); agent.resume(); await entered.promise;
    await new Promise(resolve => setTimeout(resolve, 2100)); release.resolve();
    await until(async () => (await agent.run(f.identity, f.activity.activityId, runId)).state === 'paused', 'expired admission did not pause');
    assert.equal((await agent.run(f.identity, f.activity.activityId, runId)).reason, 'run-deadline-exceeded');
    assert.equal(f.payloads.length, 0);
    const original = await f.models.checks.read(f.identity, attempt.attemptId);
    assert.equal(original.state, 'cancelled'); assert.equal(original.physicalRequestEnded, true);
    assert.equal((await f.models.segments.read(f.identity, original.segment.segmentId)).pending, false);
    await agent.validate();
  } finally { release.resolve(); await f.close(); }
});

test('a completed model result observed after the deadline retains its original Run reference', { timeout: 180000 }, async () => {
  const f = await fixture((_payload, response) => reply(response, { text: '原回答保留来源' }));
  const entered = deferred(), release = deferred(), retained = [];
  try {
    let original;
    const models = { ...f.models, checks: { ...f.models.checks, async read(...args) {
      const fact = await f.models.checks.read(...args);
      if (fact.physicalRequestEnded && fact.resultRef) { original = fact; entered.resolve(); await release.promise; }
      return fact;
    } }, results: { ...f.models.results, async retain(...args) { retained.push(args[1]); return f.models.results.retain(...args); } } };
    const agent = f.makeAgent({ models, limits: { hardDeadlineMs: 2000 } });
    const runId = await f.send(agent); agent.resume(); await entered.promise;
    await new Promise(resolve => setTimeout(resolve, 2100)); release.resolve();
    await until(async () => (await agent.run(f.identity, f.activity.activityId, runId)).state === 'paused', 'late model result did not pause');
    assert.equal((await agent.run(f.identity, f.activity.activityId, runId)).reason, 'run-deadline-exceeded');
    assert.equal(f.payloads.length, 1); assert.equal(retained.length, 1);
    assert.equal(retained[0].resultRef, original.resultRef); assert.equal(retained[0].consumerId, runId);
    assert.equal((await f.models.results.read(f.identity, original.resultRef)).text, original.text);
    await agent.validate();
  } finally { release.resolve(); await f.close(); }
});

test('switching at a paired tool boundary keeps the same Run and its cumulative budgets', { timeout: 600000 }, async () => {
  const cases = [
    { limits: { maxModelSteps: 2 }, reason: '', protocol: 'responses' },
    { limits: { maxModelSteps: 2 }, reason: '', protocol: 'messages' },
    { limits: { maxModelSteps: 2 }, reason: '', school: 'initial' },
    { limits: { maxModelSteps: 2 }, reason: '', school: 'target', protocol: 'responses' },
    { limits: { maxModelSteps: 1 }, reason: 'model-step-budget-exhausted' },
    { limits: { maxModelSteps: 2 }, reason: '' },
    { limits: { maxInputTokens: 262163 }, reason: 'input-token-budget-exhausted' },
    { limits: { maxOutputTokens: 10 }, reason: 'output-token-budget-exhausted' },
    { limits: { maxCallMs: 1000 }, reason: 'model-call-budget-exhausted', delay: 780 },
    { limits: { hardDeadlineMs: 2000 }, reason: 'run-deadline-exceeded', wait: 2100 },
    { limits: { maxInputTokens: 262144 }, reason: 'input-token-budget-exhausted', unknownUsage: true },
    { limits: { maxOutputTokens: 1024 }, reason: 'output-token-budget-exhausted', unknownUsage: true },
  ];
  for (const scenario of cases) {
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'switch-budget.txt', kind: 'text', encoding: 'utf8',
      mediaType: 'text/plain', value: '原命令结果保留来源，不重新读取。' };
    const f = await fixture(async (payload, response, index) => {
      if (scenario.delay) await new Promise(resolve => setTimeout(resolve, scenario.delay));
      if (index === 1) reply(response, { unknownUsage: scenario.unknownUsage, call: { id: 'switch-read', name: 'read_work', arguments: { objectId: work.objectId, contentId: work.contentId } } });
      else {
        assert.equal(payload.model, 'next-step-model');
        assert.equal(JSON.stringify(payload).includes('switch-read'), false, 'old native tool IDs cannot cross the switch boundary');
        protocolReply(response, scenario.protocol ?? 'chat-completions', '沿用已完成的工具结果');
      }
    }, { course: !!scenario.school });
    const entered = deferred(), release = deferred();
    try {
      let reads = 0;
      const tools = { ...f.host, async dispatch(...args) { entered.resolve(); await release.promise; reads++; return f.host.dispatch(...args); } };
      if (scenario.school === 'initial') {
        const original = await f.models.selection.snapshot(f.identity, 1), connectionId = randomUUID();
        await f.models.school.save(f.identity.spaceId, { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'Initial school model',
          protocol: 'chat-completions', baseUrl: original.choice.connection.baseUrl, path: '/chat/completions', modelId: 'recovery-sdk',
          dialect: 'standard', parameterMode: 'plain', enabled: true, contextWindow: 262144, maxOutputTokens: 1024,
          credential: { action: 'replace', value: 'synthetic-school-key' },
          policy: { checksAllowed: true, maxChecksPerHour: 6, maxOutputTokens: 1024, timeoutMs: 30000 } });
        await f.models.selection.save(f.identity, { requestId: randomUUID(), expectedVersion: 1, source: { kind: 'school', connectionId } });
      }
      const agent = f.makeAgent({ tools, limits: scenario.limits });
      const runId = await f.send(agent, [work]); agent.resume(); await entered.promise;
      const selected = await f.models.selection.read(f.identity), selectionVersion = selected.version + 1;
      const old = await f.models.selection.snapshot(f.identity, selected.version), connectionId = randomUUID(), grantId = randomUUID();
      const protocol = scenario.protocol ?? 'chat-completions';
      const config = { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'Next step',
        protocol, baseUrl: old.choice.connection.baseUrl.replace(/\/v1$/, '') + (protocol === 'messages' ? '/anthropic' : '/v1'),
        path: protocol === 'messages' ? '/v1/messages' : protocol === 'responses' ? '/responses' : '/chat/completions', modelId: 'next-step-model',
        dialect: 'standard', parameterMode: 'plain', enabled: true, contextWindow: 262144, maxOutputTokens: 1024,
        credential: { action: 'replace', value: 'synthetic-next-step' } };
      if (scenario.school === 'target') await f.models.school.save(f.identity.spaceId, { ...config,
        policy: { checksAllowed: true, maxChecksPerHour: 6, maxOutputTokens: 1024, timeoutMs: 30000 } });
      else {
        await f.models.save(f.identity, config);
        await f.models.selection.createGrant(f.identity, f.identity, { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
      }
      await f.models.selection.save(f.identity, { requestId: randomUUID(), expectedVersion: selected.version,
        source: scenario.school === 'target' ? { kind: 'school', connectionId } : { kind: 'personal', connectionId, grantId } });
      const input = { requestId: randomUUID(), selectionVersion };
      assert.equal((await agent.switchModel(f.identity, f.activity.activityId, input)).state, 'paused');
      if (scenario.wait) await new Promise(resolve => setTimeout(resolve, scenario.wait));
      release.resolve();
      await until(async () => (await f.events(agent)).some(event => event.kind === 'model-switch-completed'), 'switch never reached its paired boundary');
      await until(async () => ['completed', 'paused'].includes((await agent.run(f.identity, f.activity.activityId, runId)).state), 'original Run did not continue');
      const run = await agent.run(f.identity, f.activity.activityId, runId);
      assert.equal(run.state, scenario.reason ? 'paused' : 'completed');
      if (scenario.reason) assert.equal(run.reason, scenario.reason);
      const expectedCalls = scenario.reason ? 1 : 2;
      assert.equal(f.payloads.length, expectedCalls);
      assert.equal(reads, 1);
      if (scenario.school) assert.deepEqual((await f.storage.read('SELECT plan FROM teaching_steps WHERE run_id=$1 ORDER BY step_no', [runId]))
        .rows.map(row => row.plan.modelSource), scenario.school === 'initial' ? ['school', 'personal'] : ['personal', 'school']);
      const { rows: budgets } = await f.storage.read('SELECT * FROM teaching_budgets WHERE run_id=$1', [runId]);
      assert.equal(budgets.length, 1); assert.equal(budgets[0].max_model_steps, scenario.limits.maxModelSteps ?? 16);
      for (const [key, column] of [['maxInputTokens','max_input_tokens'],['maxOutputTokens','max_output_tokens'],['maxCallMs','max_call_ms']])
        if (scenario.limits[key]) assert.equal(Number(budgets[0][column]), scenario.limits[key]);
      agent.close(); const recovered = f.makeAgent({ limits: { maxModelSteps: 100, maxInputTokens: 9999999,
        maxOutputTokens: 999999, maxCallMs: 9999999, hardDeadlineMs: 999999999 } }); recovered.resume(); await recovered.drain();
      assert.equal(f.payloads.length, expectedCalls, 'restart cannot reset the logical Run budget');
      assert.deepEqual((await f.storage.read('SELECT * FROM teaching_budgets WHERE run_id=$1', [runId])).rows, budgets);
      await recovered.validate();
    } finally { release.resolve(); await f.close(); }
  }
});

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
    await until(async () => (await first.run(f.identity, f.activity.activityId, runId)).state === 'paused', 'model budget did not pause')
      .catch(async error => {
        const conversation = await f.conversation(first);
        throw new Error(error.message + '\n' + JSON.stringify({ runs: conversation.runs,
          tools: conversation.tools.map(tool => ({ name: tool.name, state: tool.state })),
          events: (await f.events(first)).map(event => event.kind) }), { cause: error });
      });
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
      const first = f.makeAgent({ models: gateway, leaseMs: 1500 });
      const runId = await f.send(first, [work]);
      await until(() => original, 'did not reach complete durable native result');
      await first.drain(); first.closeDispatch(); first.close();
      assert.equal(f.payloads.length, 1);
      assert.equal((await f.events(first)).filter(event => event.kind === 'tool-intent').length, 0);
      assert.equal((await f.conversation(first)).tools.length, 0);
      // Move the real workspace head while the accepted immutable input stays unchanged.
      await f.learning.works.sync(f.identity, f.activity.activityId, { requestId: randomUUID(), baseRevision: 1,
        files: [{ ...work, contentId: randomUUID(), value: '新的内容：999。' }] });
      const recovered = f.makeAgent({ models: gateway, leaseMs: 1500 }); recovered.resume();
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
      const first = f.makeAgent({ tools: host, driverId: 'real-driver-a', leaseMs: 1500 });
      const runId = await f.send(first, [work]);
      await until(() => entered, 'first generation did not reach the real prepare boundary');
      // A healthy driver renews through a slow prepare RPC. Simulate the original node
      // losing dispatch authority before expecting a successor to claim its expired lease.
      first.closeDispatch();
      const second = f.makeAgent({ tools: host, driverId: 'real-driver-b', leaseMs: 1500 }); second.resume();
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
    const gate = deferred(), children = [], cleanupEntered = deferred(), releaseCleanup = deferred();
    let holdCleanup = false, heldCleanup = false, observer;
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
      const ownedStorage = { ...f.storage, request(input, effect) {
        return f.storage.request(input, async tx => {
          if (holdCleanup && !heldCleanup && input.requestId.startsWith('teaching-tool-cleanup:')) {
            heldCleanup = true; cleanupEntered.resolve(); await releaseCleanup.promise;
          }
          return effect(tx);
        });
      } };
      const agent = f.makeAgent({ ownedStorage, leaseMs: 10_000 }); agent.resume();
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

      observer = await openStorage({ binding: f.agentBinding, migrations: teachingAgentMigrations,
        backend: createFileBackend({ id: 'regression-agent', root: join(f.root, 'regression-agent-resources') }) });
      // Hold one real cleanup transaction while concurrent public stop requests
      // wait for that same durable receipt. This is a storage scheduling barrier, not a fake result.
      holdCleanup = true;
      const stops = Promise.allSettled(Array.from({ length: 8 }, () => agent.stop(f.identity, f.activity.activityId, runId, { requestId: randomUUID() })));
      await cleanupEntered.promise;
      await until(async () => {
        const { rows: [row] } = await observer.read(`SELECT count(*)::integer AS blocked FROM pg_stat_activity
          WHERE usename=current_user AND wait_event_type='Lock' AND query LIKE '%_storage_requests%'`);
        return row.blocked >= 7;
      }, 'concurrent original cleanup writes did not reach the transaction barrier');
      const leaseDuringCleanup = (await observer.read(`SELECT state,stop_requested,generation,lease_owner,
        lease_expires_at,lease_expires_at>=clock_timestamp() AS lease_live FROM teaching_runs WHERE run_id=$1`, [runId])).rows[0];
      releaseCleanup.resolve();
      const stopResults = await stops;
      const physical = await f.models.checks.read(f.identity, before.runs[0].attemptId);
      assert.equal(physical.physicalRequestEnded, true, 'the original model request has actually ended before cleanup assertions');
      assert.deepEqual(stopResults.filter(result => result.status === 'rejected').map(result => result.reason.code), [],
        'parallel cleanup of an already stopped model must not exhaust the Agent storage pool: '+JSON.stringify(leaseDuringCleanup));
      gate.resolve();
      await until(async () => (await agent.run(f.identity, f.activity.activityId, runId)).state === 'stopped',
        'the later model step did not stop').catch(async error => {
        const current = await agent.run(f.identity, f.activity.activityId, runId);
        const diagnostics = await Promise.allSettled([
          current.attemptId ? f.models.checks.read(f.identity, current.attemptId) : null,
          f.storage.read(`SELECT state,stop_requested,generation,lease_owner,lease_expires_at,
            lease_expires_at>=clock_timestamp() AS lease_live FROM teaching_runs WHERE run_id=$1`, [runId]),
          f.storage.read(`SELECT pid,state,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers,query
            FROM pg_stat_activity WHERE usename=current_user AND pid<>pg_backend_pid()`),
        ]);
        throw new Error(error.message + '\n' + JSON.stringify({ conversation: await f.conversation(agent), events: await f.events(agent), diagnostics }));
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
      const cleanupVersions = events => events.filter(event => event.kind === 'tool-result'
        && event.body.phase === 'stop-original-execution');
      const intermediate = cleanupVersions(await f.events(agent));
      const retainedVersions = new Map();
      for (const tool of before.tools) {
        const version = intermediate.findLast(event => event.body.commandId === tool.commandId);
        assert.ok(version);
        assert.equal(version.body.stepId, tool.stepId, 'Every cleanup version keeps its original step.');
        assert.match(version.body.resourceId, /^[0-9a-f-]{36}$/, 'Every cleanup event locates its retained resource.');
        assert.equal(version.body.outcome.state, 'completed', 'The completed operation is preserved alongside pending cleanup.');
        assert.deepEqual(version.body.outcome.result, pendingCleanup.tools.find(item => item.commandId === tool.commandId).result);
        assert.equal(version.body.outcome.result.stoppedExecution.cleanupCompleted, false);
        const bytes = Buffer.from(await f.storage.readResource(version.body.resourceId));
        assert.deepEqual(JSON.parse(bytes.toString('utf8')), version.body.outcome, 'The event describes the full saved outcome, not the stop-only receipt.');
        retainedVersions.set(tool.commandId, { version, bytes,
          sha256: createHash('sha256').update(JSON.stringify(canonicalValue(version.body.outcome.result))).digest('hex') });
      }
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
          && event.body.phase === 'stop-original-execution' && event.body.outcome.result.stoppedExecution?.sessionStopped === true).length, 1);
      }
      for (const tool of before.tools) {
        const old = retainedVersions.get(tool.commandId);
        const version = cleanupVersions(events).findLast(event => event.body.commandId === tool.commandId);
        assert.equal(version.body.stepId, tool.stepId);
        assert.notEqual(version.body.resourceId, old.version.body.resourceId, 'Terminal cleanup creates a distinct retained version.');
        assert.equal(version.body.outcome.state, 'completed');
        assert.equal(version.body.outcome.result.stoppedExecution.cleanupCompleted, true);
        assert.deepEqual(version.body.outcome.result.query, tool.result.query);
        assert.deepEqual(version.body.outcome.result, settled.tools.find(item => item.commandId === tool.commandId).result);
        assert.deepEqual(JSON.parse(Buffer.from(await f.storage.readResource(version.body.resourceId)).toString('utf8')), version.body.outcome);
        const oldBytes = Buffer.from(await f.storage.readResource(old.version.body.resourceId));
        assert.deepEqual(oldBytes, old.bytes, 'Replacing latest cannot change the intermediate cleanup bytes.');
        assert.equal(createHash('sha256').update(JSON.stringify(canonicalValue(JSON.parse(oldBytes.toString('utf8')).result))).digest('hex'), old.sha256);
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
      again.closeWrites(); again.closeDispatch(); await again.drain();
      const participant = f.storage.participant();
      await participant.closeDispatch(); await participant.closeWrites(); await participant.drain();
      const boundary = await collectTeachingBoundary(f.storage);
      assert.equal(boundary.evidence.formatVersion, 2);
      for (const version of cleanupVersions(events)) assert.ok(boundary.evidence.resources.some(resource => resource.resourceId === version.body.resourceId),
        'The owner maintenance inventory includes overwritten intermediate cleanup resources.');
    } finally {
      holdStop = false; gate.resolve(); releaseCleanup.resolve();
      await observer?.close();
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
        const { computed } = await runPublishedAggregation(action, manifest);
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
      const { computed } = await runPublishedAggregation(action, manifest);
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

for (const route of ['unaccepted-native', 'accepted-browser', 'accepted-native-outbox', 'accepted-native-outbox-before-enqueue']) test(`tool RPC fences a delayed Driver while ${route === 'accepted-browser' ? 'an accepted browser command remains claimable' : route.startsWith('accepted-native-outbox') ? `an accepted native outbox command remains claimable${route.endsWith('before-enqueue') ? ' after an interrupted enqueue' : ''}` : 'an unaccepted native command cannot start'}`,
  { timeout: 180000 }, async () => {
    const accepted = route !== 'unaccepted-native', browser = route === 'accepted-browser';
    const gate = deferred(); let pending, authority, agent, second, admitted = false, executions, channel, node;
    const f = await fixture((_payload, response, index) => {
      assert.equal(index, 1, 'no second model dispatch belongs to this test');
      reply(response, { call: { id: 'cross-rpc-permit', name: 'course_operation', arguments: browser
        ? { componentKey: 'table', operationId: 'aggregate', parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } }
        : { componentKey: 'counter', operationId: 'start_session', parameters: {} } } });
    }, { course: browser ? 'browser' : true });
    try {
      const realAgent = value => createTeachingAgentService(second, async (who, id) => { await f.learning.open(who, id); })(value);
      const remote = createTeachingAgentClient(f.storage.owner.serviceId, f.identity, f.activity.activityId, realAgent);
      let host = f.host;
      if (route.startsWith('accepted-native-outbox')) {
        const session = f.activity.course.components[0].definition.manifest.session;
        node = { connectionId: randomUUID(), nodeId: 'original-outbox-device', installationId: randomUUID(),
          platform: process.platform === 'darwin' ? 'macos-arm64' : 'windows-x64', supervisorEpoch: randomUUID(),
          adapters: [{ adapterId: session.adapterId, adapterVersion: session.adapterVersion }] };
        channel = createNativeChannel(f.learningStorage, { authenticate: async () => f.identity,
          authorize: (who, id) => f.learning.open(who, id), authorizeConnection: async () => {},
          assertAgentDispatch: (who, id, original) => remote.assertCommandDispatch(who, id, original) });
        await channel.register('fixture', node); await channel.heartbeat('fixture', node);
        let interrupted = false;
        const sender = { ...channel, async enqueue(...args) {
          if (route.endsWith('before-enqueue') && !interrupted) {
            interrupted = true;
            throw Object.assign(new Error('Injected: original owner committed; enqueue interrupted'), { code: 'unavailable' });
          }
          return channel.enqueue(...args);
        } };
        executions = createExecutions(f.learningStorage, { activity: (who, id) => f.learning.open(who, id), works: f.learning.works, channel: sender });
        host = createTeachingTools({ learning: () => ({ ...f.learning, executions }), courses: f.courses,
          authorizeDispatch: (scope, command) => remote.assertCommandDispatch(scope.identity, scope.activity.activityId,
            { runId: scope.runId, stepId: scope.stepId, snapshotId: scope.snapshotId, commandId: command.commandId,
              ...(scope.authority ? { authority: scope.authority } : {}) }) });
      }
      const service = createTeachingDependencyService({ authorize: async () => {}, identityFor: async () => f.identity,
        activity: (who, id) => f.learning.open(who, id), models: f.models,
        tools: { ...host, dispatch: (scope, command) => host.dispatch({ ...scope,
          assertDispatch: () => remote.assertCommandDispatch(scope.identity, scope.activity.activityId,
            { runId: scope.runId, stepId: scope.stepId, snapshotId: scope.snapshotId, commandId: command.commandId,
              ...(scope.authority ? { authority: scope.authority } : {}) }) }, command) } });
      const client = createTeachingDependencyClient(async input => {
        // JSON serialization is the actual remote seam: local assertDispatch cannot survive it.
        const wire = JSON.parse(JSON.stringify(input));
        if (wire.operation !== 'tool.dispatch') return service(wire);
        pending = wire;
        let outcome, lostReply;
        try { outcome = accepted ? await service(wire) : undefined; }
        catch (error) {
          if (!route.endsWith('before-enqueue') || error.code !== 'unavailable') throw error;
          lostReply = error;
        }
        admitted = true;
        await gate.promise;
        if (lostReply) throw lostReply;
        return accepted ? outcome : service(wire);
      });
      agent = f.makeAgent({ tools: client.tools, driverId: 'old-rpc-driver', leaseMs: 300 });
      second = f.makeAgent({ tools: client.tools, driverId: 'new-rpc-driver', leaseMs: 300,
        withAuthority: (value, work) => { authority = value; return work(); } });
      const binding = f.activity.course.components[0], manifest = binding.definition.manifest;
      const works = browser ? [{ objectId: randomUUID(), contentId: randomUUID(), name: 'components/table.json', kind: 'state',
        encoding: 'json', mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify({
          formatVersion: 1, instanceId: f.activity.activityId + ':table', componentId: manifest.componentId,
          version: manifest.version, definitionDigest: binding.definition.digest, stateVersion: 1,
          operationId: randomUUID(), content: manifest.initialState }) }] : [];
      const runId = await f.send(agent, works);
      await until(() => pending && (!accepted || admitted), 'tool RPC did not reach acceptance');
      assert.equal(pending.authority?.driverId, 'old-rpc-driver', 'the original dispatch authority must cross RPC');
      assert.equal(pending.authority.runId, runId);
      const permitted = (await f.events(agent)).find(event => event.kind === 'tool-permitted');
      assert.deepEqual(permitted.body.authority, pending.authority, 'the original authority is persisted before the RPC');
      const scope = pending.args[0], command = pending.args[1];
      const association = { runId, stepId: scope.stepId, snapshotId: scope.snapshotId, commandId: command.commandId };
      await remote.assertCommandDispatch(f.identity, f.activity.activityId, { ...association, authority: pending.authority });
      agent.closeDispatch();
      await new Promise(resolve => setTimeout(resolve, 400));
      await assert.rejects(remote.assertCommandDispatch(f.identity, f.activity.activityId,
        { ...association, authority: pending.authority }), { code: 'forbidden' });
      second.resume();
      await until(() => authority?.generation >= 2, 'replacement Driver did not take the expired lease');
      await assert.rejects(remote.assertCommandDispatch(f.identity, f.activity.activityId,
        { ...association, authority: pending.authority }), { code: 'forbidden' });
      if (route.startsWith('accepted-native-outbox')) {
        const claimed = await until(async () => {
          const result = await channel.claim('fixture', node);
          return result.command ? result : null;
        }, 'replacement Driver did not recover the original accepted outbox');
        assert.equal(claimed.command.commandId, command.commandId, 'formal native outbox must deliver its original accepted command');
        assert.equal(claimed.command.payload.action.requestId, command.commandId);
        assert.deepEqual(claimed.command.node, node, 'lease handover cannot reassign the original execution node');
        assert.equal((await channel.claim('fixture', node)).command, null, 'the accepted command cannot be dispatched twice');
      } else if (browser) {
        const browser = await f.learning.executions.agent.claimBrowser(f.identity, f.activity.activityId, command.commandId, randomUUID(),
          original => remote.assertCommandDispatch(f.identity, f.activity.activityId, original));
        assert.equal(browser.action.requestId, command.commandId, 'already accepted original command survives lease handover');
      } else {
        await assert.rejects(service({ ...pending, authority: undefined }), { code: 'forbidden' });
      }
      gate.resolve(); await agent.drain();
      if (!accepted) assert.equal((await f.learning.executions.sessions(f.identity, f.activity.activityId)).length, 0,
        'a stale RPC cannot create a physical execution');
    } finally { gate.resolve(); agent?.close(); second?.close(); await executions?.shutdown(); await f.close(); }
  });

test('closed activity rejects fresh model dispatch authority without changing the original attempt', { timeout: 180000 }, async () => {
  const gate = deferred(); let authority;
  const f = await fixture(async (_payload, response) => { await gate.promise; reply(response, { text: '原请求结果' }); });
  try {
    const agent = f.makeAgent({ withAuthority: (value, work) => { authority = value; return work(); } });
    const runId = await f.send(agent);
    await until(() => f.payloads.length, 'original SDK request never started');
    const run = await agent.run(f.identity, f.activity.activityId, runId);
    await agent.assertModelDispatch(f.identity, f.activity.activityId, { ...authority, attemptId: run.attemptId, dispatch: false });
    await f.learning.setStatus(f.identity, { requestId: randomUUID(), activityId: f.activity.activityId, status: 'closed' });
    await assert.rejects(agent.assertModelDispatch(f.identity, f.activity.activityId,
      { ...authority, attemptId: run.attemptId, dispatch: false }), { code: 'forbidden' });
    assert.equal((await agent.run(f.identity, f.activity.activityId, runId)).attemptId, run.attemptId);
  } finally { gate.resolve(); await f.close(); }
});
