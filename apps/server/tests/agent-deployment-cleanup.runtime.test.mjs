import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { createExecutions, executionMigration, executionActionTextMigration } from '../../../packages/learning-space/dist/learning-data/executions.js';
import { agentExecutionMigration } from '../../../packages/learning-space/dist/learning-data/agent-executions.js';
import { channelExecutionMigration, channelCheckpointMigration } from '../../../packages/learning-space/dist/learning-data/channel-executions.js';
import { collectExecutionBoundary, validateExecutionBoundary } from '../../../packages/learning-space/dist/learning-data/maintenance.js';
import { createNativeChannel, nativeChannelMigration, nativeChannelTargetMigration, nativeChannelObservationMigration, nativeChannelCancellationMigration, nativeChannelCleanupMigration } from '../../../packages/learning-space/dist/learning-data/native-channel.js';
import { nativeSessionMigration } from '../../../packages/learning-space/dist/learning-data/native-sessions.js';
import { sessionRecoveryMigration } from '../../../packages/learning-space/dist/learning-data/session-checkpoints.js';
import { createWorks, workMigration } from '../../../packages/learning-space/dist/learning-data/works.js';
import { accumulatorPackage } from '../../../components/state-accumulator/package.mjs';
import * as agentExecution from '../../../packages/learning-space/dist/learning-data/agent-executions.js';
import { createConnectionAuthority } from '@xunjie/product-runtime/connections';
import { createAgentRuntime, agentRuntimeMigrations } from '@xunjie/agent-runtime';
import { createWorkspaceAssistant } from '../../../packages/agents/dist/workspace-assistant/index.js';
import { createModelGateway, modelMigrations } from '@xunjie/model-gateway';
import { createServer } from 'node:http';
import { createQuestionDrafts } from '../../../packages/learning-space/dist/learning-data/drafts.js';
import { createSpaces, createCourses, spaceCourseMigrations } from '@xunjie/learning-space';
import { canonicalValue } from '@xunjie/contracts/execution';
const actionScope = (identity, activityId) => ({ environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId });
const hash = value => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');

async function fixture() {
  const pg = await nativeFixture();
  const migrations = [{ version: 1, name: 'activities', sql: 'CREATE TABLE activities(id uuid PRIMARY KEY,body jsonb NOT NULL);' },
    workMigration, executionMigration, nativeSessionMigration, sessionRecoveryMigration, executionActionTextMigration, channelExecutionMigration, channelCheckpointMigration, nativeChannelMigration, nativeChannelTargetMigration, nativeChannelObservationMigration, nativeChannelCancellationMigration, nativeChannelCleanupMigration, agentExecutionMigration, agentExecution.agentExecutionOriginMigration, agentExecution.agentExecutionAuthorityMigration].filter(Boolean).map((m, i) => ({ ...m, version: i + 1 }));
  const binding = await provisionStorage({ admin: pg.admin,
    owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID(), migrations }).catch(async error => { await pg.close(); throw error; });
  const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: 'files', root: pg.root + '/objects' }) });
  const { manifest } = await accumulatorPackage({ version: 1 });
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '真实空间身份' };
  const activityId = randomUUID();
  const activity = { activityId, identity, target: { ...storage.owner, version: 1 }, status: 'open', goal: '四态状态',
    question: '', references: [], createdAt: new Date().toISOString(), course: { associationId: randomUUID(), courseId: randomUUID(),
      courseName: 'owner seam course', taskId: randomUUID(), taskTitle: '真实状态', releaseId: randomUUID(), contentDigest: 'c'.repeat(64),
      objectives: ['连续观察真实状态'], requirements: '按输入观察', materials: [], starterWorks: [], capabilities: [],
      helpPolicy: { version: 1, questions: 'allowed', scope: 'course' }, components: [{ key: 'counter',
      definition: { digest: 'a'.repeat(64), manifest }, configuration: { title: '真实累加器' }, materialIds: [] }] } };
  await storage.request({ requestId: 'activity', fingerprint: activityId }, async tx => {
    await tx.query('INSERT INTO activities VALUES($1,$2)', [activityId, JSON.stringify(activity)]); return true;
  });
  let allowed = true;
  const authorize = async (who, id) => {
    if (!allowed || hash(who) !== hash(identity) || id !== activityId) throw new StorageError('forbidden');
    return activity;
  };
  const works = createWorks(storage, authorize);
  const owner = createExecutions(storage, { activity: authorize, works,
    native: { activity: authorize, works, nodePath: process.execPath, sessionRoot: pg.root + '/sessions',
      ...(process.env.XUNJIE_NATIVE_SESSION_HELPER ? { windowsHelper: process.env.XUNJIE_NATIVE_SESSION_HELPER } : {}) } });
  const d = manifest.session;
  const action = { protocolVersion: 2, kind: 'execution', requestId: randomUUID(), scope: actionScope(identity, activityId),
    receiver: { receiverId: 'native-execution', location: 'local', kind: 'execution' }, execution: {
      instance: { instanceId: activityId + ':counter', key: 'counter', componentId: manifest.componentId,
        componentVersion: manifest.version, definitionDigest: 'a'.repeat(64), hostApiVersion: 1, stateVersion: 1 },
      operation: { operationId: d.operation.operationId, effect: 'input' }, parameters: {},
      basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] },
      limits: { timeMs: d.budgets.operationTimeoutMs, memoryPages: 1, inputBytes: d.budgets.inputBytes,
        outputBytes: d.budgets.outputBytes, concurrentJobs: 2, queuedJobs: 0 },
      session: { adapterId: d.adapterId, adapterVersion: d.adapterVersion, limits: Object.fromEntries(
        ['operationTimeoutMs', 'idleMs', 'maxMs', 'memoryMiB', 'concurrentSessions', 'queuedSessions'].map(k => [k, d.budgets[k]])) },
      plan: { planId: 'native-session', planVersion: 1, location: 'native', kind: 'session',
        planDigest: hash({ planId: 'native-session', planVersion: 1, componentId: manifest.componentId,
          componentVersion: manifest.version, operationId: d.operation.operationId }) },
      initiator: { kind: 'agent', principalId: identity.principalId } } };
  const runtimeSource = { sourceEnvironmentId: randomUUID(), sourceServiceId: randomUUID(), sourceInstallationId: randomUUID() };
  const authority = createConnectionAuthority({ root: pg.root + '/runtime', service: { ...storage.owner, unit: 'learning-data', endpoint: 'http://127.0.0.1:1', protocolVersion: 1, capabilities: ['agent.dependencies.v2'] }, handlers: { 'agent.dependencies.v2': () => null } });
  const grant = await authority.authorize({ ...runtimeSource, capabilities: ['agent.dependencies.v2'] });
  const origin = { ...runtimeSource, grantId: grant.grantId };
  const context = { origin, runId: randomUUID(), stepId: randomUUID(), commandId: action.requestId, snapshotId: randomUUID(),
    assertDispatch: async () => { if (!allowed) throw new StorageError('forbidden'); } };
  return { pg, storage, owner, identity, activity, action, context, works, authorize, authority, grant, binding, migrations,
    revoke: () => { allowed = false; }, async close() { await owner.shutdown(); await storage.close(); await pg.close(); } };
}


for (const revoked of ['grant', 'activity']) test(`actual execution owner cleans its persisted Agent session after ${revoked} revocation`, { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const started = await f.owner.agent.dispatch(f.identity, f.activity.activityId, f.context, f.action);
    assert.equal(started.state, 'running');
    await assert.rejects(f.owner.agent.dispatch(f.identity, f.activity.activityId,
      { ...f.context, origin: { ...f.context.origin, sourceInstallationId: randomUUID() } }, f.action), { code: 'identity-conflict' });
    const authorize = async (identity, activityId, origin) => {
      await f.authorize(identity, activityId);
      try { if (origin) await f.authority.assertSourceAuthorized(origin, 'agent.dependencies.v2'); }
      catch (error) { if (error.code === 'unauthorized') throw new StorageError('forbidden'); throw error; }
    };
    assert.deepEqual(await f.owner.agent.reconcileAuthorization(authorize), []);
    if (revoked === 'grant') await f.authority.revoke(f.grant.grantId);
    else f.revoke();
    let cleanup; const deadline = Date.now() + 5000;
    do {
      cleanup = await f.owner.agent.reconcileAuthorization(authorize);
      if (cleanup.length) break;
      assert.ok(Date.now() < deadline, 'scheduled cleanup must run');
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (true);
    assert.equal(cleanup.length, 1);
    assert.equal(cleanup[0].requestId, f.action.requestId);
    assert.equal(cleanup[0].state, 'confirmed');
    assert.equal(cleanup[0].query.statusKnowledge, 'confirmed');
    assert.ok(['cancelled', 'failed', 'succeeded'].includes(cleanup[0].query.state));
    await f.owner.agent.reconcileAuthorization(authorize);
    await f.owner.agent.validate();
    await assert.rejects(f.owner.agent.dispatch(f.identity, f.activity.activityId, f.context, f.action), { code: 'forbidden' });
    // Cleanup never authorizes a different Run to touch the original session.
    await assert.rejects(f.owner.agent.cleanup(f.identity, f.activity.activityId, { ...f.context, runId: randomUUID() }, f.action.requestId,
      { stopId: randomUUID(), reason: '' }), { code: 'forbidden' });
  } finally { await f.close(); }
});


for (const revoked of [false, true]) test(`the new kernel stops an ongoing native session from a completed tool when later generation is stopped (${revoked ? 'revoked activity' : 'current activity'})`, { timeout: 120000 }, async () => {
  const f = await fixture(), opened = [];
  let runtime, models, count = 0, reached, release;
  const second = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* Read only synthetic model input. */ }
    count++;
    if (count > 1) { reached(); await gate; response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '', tool_calls: [{ index: 0,
      id: 'start-native-original', type: 'function', function: { name: 'course_operation', arguments: JSON.stringify({
        componentKey: 'counter', operationId: 'start_session', parameters: {} }) } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  async function open(name, migrations) {
    const binding = await provisionStorage({ admin: f.pg.admin, owner: { environmentId: f.storage.owner.environmentId, serviceId: randomUUID() },
      password: randomUUID(), migrations });
    const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: name, root: f.pg.root + '/' + name }) });
    opened.push(storage); return storage;
  }
  const authorize = async who => { assert.equal(hash(who), hash(f.identity)); };
  try {
    const space = await open('courses', spaceCourseMigrations), spaces = createSpaces(space), courses = createCourses(space, spaces);
    Object.assign(f.identity, await spaces.createMember({ requestId: randomUUID(), loginName: 'cleanup-' + randomUUID(), password: randomUUID() }));
    f.action.scope = actionScope(f.identity, f.activity.activityId);
    f.action.execution.initiator.principalId = f.identity.principalId;
    const component = await courses.components.register({ ...await accumulatorPackage({ version: 1 }), requestId: randomUUID() });
    const fixed = f.activity.course;
    fixed.components[0].definition = component;
    await courses.registerRelease({ formatVersion: 1, requestId: randomUUID(), course: { courseId: fixed.courseId, name: fixed.courseName },
      task: { taskId: fixed.taskId, title: fixed.taskTitle, summary: '' }, release: { releaseId: fixed.releaseId,
        objectives: fixed.objectives, requirements: fixed.requirements, materials: [], starterWorks: [], capabilities: [],
        helpPolicy: fixed.helpPolicy, components: fixed.components }, resources: [] });
    await courses.setAccess({ requestId: randomUUID(), courseId: fixed.courseId, principalId: f.identity.principalId, active: true });
    fixed.contentDigest = (await courses.readRelease(f.identity, fixed.releaseId)).contentDigest;
    await f.storage.request({ requestId: randomUUID(), fingerprint: 'actual-published-course' }, async tx => {
      await tx.query('UPDATE activities SET body=$2 WHERE id=$1', [f.activity.activityId, f.activity]); return null;
    });
    models = await createModelGateway(await open('models', modelMigrations), { authorize, holder: 'device',
      authorizePermit: (who, permit) => runtime.assertDispatch(who, permit) });
    const connectionId = randomUUID(), grantId = randomUUID();
    await models.save(f.identity, { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'Native cleanup',
      protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, path: '/chat/completions',
      modelId: 'native-cleanup', dialect: 'standard', parameterMode: 'plain', enabled: true, contextWindow: 262144,
      maxOutputTokens: 2048, credential: { action: 'replace', value: 'synthetic-cleanup-key' } });
    await models.selection.createGrant(f.identity, f.identity, { requestId: randomUUID(), connectionId, grantId, owner: 'self' });
    await models.selection.save(f.identity, { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, grantId } });
    runtime = createAgentRuntime(await open('agent', agentRuntimeMigrations), { authorize,
      pipeline: createWorkspaceAssistant({ models, workspace: () => f.authorize(f.identity, f.activity.activityId),
        learning: { open: f.authorize, works: f.works, executions: f.owner,
          drafts: createQuestionDrafts(f.storage, { activity: f.authorize, works: f.works, courses }) }, courses }) });
    const sessionId = randomUUID();
    await runtime.initialize({ sessionId, identity: f.identity, scenario: 'workspace-assistant', restartPolicy: 'automatic', createdAt: new Date().toISOString() });
    const action = { requestId: randomUUID(), receiver: { receiverId: 'agent-session:' + sessionId, kind: 'question', location: 'local' },
      scope: actionScope(f.identity, f.activity.activityId), draft: { token: randomUUID(), question: '启动计数器并解释状态', references: [], bases: [] }, works: [], evidence: [] };
    const input = await runtime.accept(f.identity, { requestId: randomUUID(), sessionId, text: action.draft.question, context: { action } });
    const advancing = runtime.advance(input.runId);
    await Promise.race([second, advancing.then(() => { throw Error('The original native session must be started before the later model call'); })]);
    const before = await runtime.snapshot(f.identity, sessionId, input.runId), tool = before.steps.find(step => step.operation.kind === 'tool.call');
    assert.equal(tool.state, 'completed');
    assert.equal(tool.result.value.outcome.result.sessionOngoing, true, JSON.stringify(tool.result.value.outcome));
    const student = structuredClone(tool.operation.input.command.input.prepared.basis.action);
    student.requestId = randomUUID(); student.execution.initiator = { kind: 'student', principalId: f.identity.principalId };
    await f.owner.accept(f.identity, f.activity.activityId, { action: student });
    if (revoked) f.revoke();
    const stopId = randomUUID();
    assert.equal((await runtime.stop(f.identity, sessionId, input.runId, stopId)).state, 'stopped');
    const model = before.steps.find(step => step.operation.kind === 'model.call');
    const original = { runId: input.runId, stepId: model.stepId, snapshotId: model.stepId,
      commandId: tool.operation.operationId, assertDispatch: async () => { throw new StorageError('forbidden'); } };
    const stopped = await f.owner.agent.cleanupStatus(f.identity, f.activity.activityId, original, tool.operation.operationId);
    assert.equal(stopped.cancelled, true, 'Stopping a later model step must also stop the original ongoing native effect');
    if (!revoked) assert.equal((await f.owner.read(f.identity, f.activity.activityId, student.requestId)).state, 'running',
      'The independent student native session is preserved');
    assert.equal((await runtime.stop(f.identity, sessionId, input.runId, stopId)).state, 'stopped');
    release(); await advancing;
    assert.equal(count, 2, 'Stopping never starts another model request');
  } finally {
    release(); await runtime?.close(); models?.closeWrites(); await models?.checks.drain();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const storage of opened.reverse()) await storage.close();
    await f.close();
  }
});

test('owner cleanup scanning is bounded, fair and stops monitoring confirmed physical history', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const ids = [];
    for (let index=0; index<21; index++) {
      const action = { ...f.action, requestId: randomUUID() };
      const context = { ...f.context, commandId: action.requestId };
      await f.owner.agent.dispatch(f.identity, f.activity.activityId, context, action);
      await f.owner.agent.cleanup(f.identity, f.activity.activityId, context, action.requestId, { stopId: randomUUID(), reason: '' });
      ids.push(action.requestId);
    }
    let checks=0;
    const authorize = async (identity, activityId) => { checks++; await f.authorize(identity, activityId); };
    const first = await f.owner.agent.reconcileAuthorization(authorize);
    assert.equal(first.length,20);
    const second = await f.owner.agent.reconcileAuthorization(authorize);
    assert.equal(second.length,1, 'the oldest unvisited command must get the next batch');
    const completed = [...first, ...second];
    assert.deepEqual(new Set(completed.map(item => item.requestId)), new Set(ids));
    assert.ok(completed.every(item => item.state === 'confirmed' && item.query.statusKnowledge === 'confirmed'));
    assert.equal(checks,0, 'explicit cleanup remains required without checking or revoking current authorization');
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.deepEqual(await f.owner.agent.reconcileAuthorization(authorize), [], 'confirmed ended sessions leave the recurring cleanup scan');
    assert.equal(checks,0);
    await f.owner.agent.validate();
  } finally { await f.close(); }
});

test('a stale authorization scan cannot cancel a command after a real replacement grant is adopted', { timeout: 120000 }, async () => {
  const f = await fixture();
  let entered, release;
  const checked = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  try {
    await f.owner.agent.dispatch(f.identity, f.activity.activityId, f.context, f.action);
    await f.authority.revoke(f.grant.grantId);
    const scan = f.owner.agent.reconcileAuthorization(async (_identity, _activityId, origin) => {
      try { await f.authority.assertSourceAuthorized(origin, 'agent.dependencies.v2'); }
      catch { entered(); await gate; throw new StorageError('forbidden'); }
    });
    await checked;
    const grant = await f.authority.authorize({ sourceEnvironmentId: f.context.origin.sourceEnvironmentId, sourceServiceId: f.context.origin.sourceServiceId,
      sourceInstallationId: f.context.origin.sourceInstallationId, capabilities: ['agent.dependencies.v2'] });
    await f.owner.agent.adoptAuthorization({ ...f.context.origin, grantId: grant.grantId },
      (from, to) => Promise.resolve(from.sourceInstallationId === to.sourceInstallationId));
    release(); await scan;
    assert.equal((await f.owner.agent.status(f.identity, f.activity.activityId, f.context, f.action.requestId)).cancelled, false);
    assert.equal((await f.owner.read(f.identity, f.activity.activityId, f.action.requestId)).stopRequested, false);
    await f.authority.revoke(grant.grantId);
    const deadline = Date.now() + 5000;
    while (!(await f.owner.agent.status(f.identity, f.activity.activityId, f.context, f.action.requestId)).cancelled) {
      await f.owner.agent.reconcileAuthorization(async (_identity, _activityId, origin) => {
        try { await f.authority.assertSourceAuthorized(origin, 'agent.dependencies.v2'); }
        catch { throw new StorageError('forbidden'); }
      });
      assert.ok(Date.now() < deadline, 'revoking every adopted grant must still cancel the original command');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await f.owner.agent.validate();
  } finally { release(); await f.close(); }
});


test('a reopened handle retains unconfirmed cleanup until the actual physical owner confirms it', { timeout: 120000 }, async () => {
  const f = await fixture(); let storage, reopened;
  try {
    await f.owner.agent.dispatch(f.identity, f.activity.activityId, f.context, f.action);
    await f.authority.revoke(f.grant.grantId);
    storage = await openStorage({ binding:f.binding, migrations:f.migrations, backend:createFileBackend({id:'files',root:f.pg.root+'/objects'}) });
    const works=createWorks(storage,f.authorize);
    reopened=createExecutions(storage,{activity:f.authorize,works,native:{activity:f.authorize,works,nodePath:process.execPath,sessionRoot:f.pg.root+'/sessions',
      ...(process.env.XUNJIE_NATIVE_SESSION_HELPER?{windowsHelper:process.env.XUNJIE_NATIVE_SESSION_HELPER}:{})}});
    let checks=0;
    const result=await reopened.agent.reconcileAuthorization(async (identity,activityId,origin)=>{
      checks++;assert.deepEqual(origin,f.context.origin);await f.authorize(identity,activityId);
      try {await f.authority.assertSourceAuthorized(origin,'agent.dependencies.v2');}
      catch(error){if(error.code==='unauthorized')throw new StorageError('forbidden');throw error;}
    });
    assert.equal(checks,1);assert.equal(result[0].state,'pending');assert.equal(result[0].query.statusKnowledge,'unknown');
    await reopened.agent.validate();
    let completed; const deadline=Date.now()+5000;
    do {
      const batch=await f.owner.agent.reconcileAuthorization(async()=>{throw new StorageError('forbidden');});
      completed=batch.find(item=>item.state==='confirmed');
      if(completed)break;
      assert.ok(Date.now()<deadline,'the actual owner must confirm its supervisor exit');
      await new Promise(resolve=>setTimeout(resolve,25));
    }while(true);
    assert.equal(completed.query.statusKnowledge,'confirmed');
    assert.deepEqual(await reopened.agent.reconcileAuthorization(async()=>{assert.fail('completed cleanup must leave the scan');}),[]);
    await reopened.agent.validate();
  }finally{await reopened?.shutdown();await storage?.close();await f.close();}
});


test('explicit cleanup through a reopened handle remains pending until its live owner confirms stop while authorization stays valid', { timeout: 120000 }, async () => {
  const f = await fixture(); let storage, reopened;
  try {
    const started = await f.owner.agent.dispatch(f.identity, f.activity.activityId, f.context, f.action);
    assert.equal(started.state, 'running');
    const input = { controlId: randomUUID(), operationId: 'advance', effect: 'input', expectedSeq: 0, parameters: { value: 7 } };
    const advanced = await f.owner.agent.control(f.identity, f.activity.activityId,
      { ...f.context, commandId: input.controlId }, f.action.requestId, input);
    assert.equal(advanced.session.observation.total, 7, 'the original owner supervises a real live counter');
    await f.authority.assertSourceAuthorized(f.context.origin, 'agent.dependencies.v2');
    await f.authorize(f.identity, f.activity.activityId);

    storage = await openStorage({ binding: f.binding, migrations: f.migrations,
      backend: createFileBackend({ id: 'files', root: f.pg.root + '/objects' }) });
    const works = createWorks(storage, f.authorize);
    reopened = createExecutions(storage, { activity: f.authorize, works,
      native: { activity: f.authorize, works, nodePath: process.execPath, sessionRoot: f.pg.root + '/sessions',
        ...(process.env.XUNJIE_NATIVE_SESSION_HELPER ? { windowsHelper: process.env.XUNJIE_NATIVE_SESSION_HELPER } : {}) } });
    const context = { ...f.context, assertDispatch: async () => { throw new StorageError('stale-generation'); } };
    const stop = { stopId: randomUUID(), reason: 'The original Run was explicitly stopped.' };
    const pending = await reopened.agent.cleanup(f.identity, f.activity.activityId, context, f.action.requestId, stop);
    assert.equal(pending.executionRef, started.executionRef);
    assert.equal(pending.stopRequested, true);
    assert.equal(pending.statusKnowledge, 'unknown', 'a second handle cannot confirm the first handle physical process exit');
    assert.equal((await reopened.agent.cleanupStatus(f.identity, f.activity.activityId, context, f.action.requestId)).cancelled, true);
    await reopened.shutdown(); reopened = undefined;
    await storage.close(); storage = undefined;

    let completed;
    const deadline = Date.now() + 5000;
    do {
      const batch = await f.owner.agent.reconcileAuthorization(async (identity, activityId, origin) => {
        await f.authorize(identity, activityId);
        await f.authority.assertSourceAuthorized(origin, 'agent.dependencies.v2');
      });
      completed = batch.find(item => item.requestId === f.action.requestId && item.state === 'confirmed');
      if (completed) break;
      assert.ok(Date.now() < deadline, 'explicit cancellation must be retried by its physical owner without revoking authorization');
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (true);
    assert.equal(completed.query.executionRef, started.executionRef);
    assert.equal(completed.query.statusKnowledge, 'confirmed');
    assert.equal(completed.query.state, 'cancelled');
    assert.equal(completed.query.stopRequested, true);
    await f.authority.assertSourceAuthorized(f.context.origin, 'agent.dependencies.v2');
    await f.authorize(f.identity, f.activity.activityId);
    assert.deepEqual(await f.owner.agent.cleanup(f.identity, f.activity.activityId, context, f.action.requestId, stop), completed.query);
    assert.deepEqual(await f.owner.agent.reconcileAuthorization(async () => {
      assert.fail('confirmed cleanup must leave the recurring scan');
    }), []);
    await f.owner.agent.validate();
  } finally { await reopened?.shutdown(); await storage?.close(); await f.close(); }
});

test('healthy authorization monitoring cannot repair or stop a session held by another live execution host', { timeout: 120000 }, async () => {
  const f=await fixture();let storage,monitor;
  try {
    const started=await f.owner.agent.dispatch(f.identity,f.activity.activityId,f.context,f.action);
    storage=await openStorage({binding:f.binding,migrations:f.migrations,backend:createFileBackend({id:'files',root:f.pg.root+'/objects'})});
    const works=createWorks(storage,f.authorize);
    // Production and an external public owner may share the same storage while supervising different session roots.
    monitor=createExecutions(storage,{activity:f.authorize,works,native:{activity:f.authorize,works,nodePath:process.execPath,sessionRoot:f.pg.root+'/other-live-host',
      ...(process.env.XUNJIE_NATIVE_SESSION_HELPER?{windowsHelper:process.env.XUNJIE_NATIVE_SESSION_HELPER}:{})}});
    assert.deepEqual(await monitor.agent.reconcileAuthorization(async(identity,activityId,origin)=>{
      await f.authorize(identity,activityId);await f.authority.assertSourceAuthorized(origin,'agent.dependencies.v2');
    }),[]);
    const current=await f.owner.agent.read(f.identity,f.activity.activityId,f.context,f.action.requestId);
    assert.equal(current.state,'running',JSON.stringify(current));
    assert.equal(current.executionRef,started.executionRef);assert.equal(current.stopRequested,false);
    const input={controlId:randomUUID(),operationId:'advance',effect:'input',expectedSeq:0,parameters:{value:1}};
    const advanced=await f.owner.agent.control(f.identity,f.activity.activityId,{...f.context,commandId:input.controlId},f.action.requestId,input);
    assert.equal(advanced.session.observation.total,1,'the original physical session must still accept its first real input');
  }finally{await monitor?.shutdown();await storage?.close();await f.close();}
});
