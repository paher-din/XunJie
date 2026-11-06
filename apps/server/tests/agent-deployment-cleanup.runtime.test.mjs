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
import { teachingAgentMigrations } from '../../../packages/learning-space/dist/teaching-agent/index.js';
import { createTeachingRunDriver } from '../../../packages/learning-space/dist/teaching-agent/driver.js';
import { createTeachingTools } from '../../../packages/learning-space/dist/teaching-agent/tools.js';
import { canonicalValue } from '@xunjie/contracts/execution';
const actionScope = (identity, activityId) => ({ environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId });
const hash = value => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');

async function fixture() {
  const pg = await nativeFixture();
  const migrations = [{ version: 1, name: 'activities', sql: 'CREATE TABLE activities(id uuid PRIMARY KEY,body jsonb NOT NULL);' },
    workMigration, executionMigration, nativeSessionMigration, sessionRecoveryMigration, executionActionTextMigration, channelExecutionMigration, channelCheckpointMigration, nativeChannelMigration, nativeChannelTargetMigration, nativeChannelObservationMigration, nativeChannelCancellationMigration, nativeChannelCleanupMigration, agentExecutionMigration, agentExecution.agentExecutionOriginMigration, agentExecution.agentExecutionAuthorityMigration, ...teachingAgentMigrations].filter(Boolean).map((m, i) => ({ ...m, version: i + 1 }));
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
  const authority = createConnectionAuthority({ root: pg.root + '/runtime', service: { ...storage.owner, unit: 'learning-data', endpoint: 'http://127.0.0.1:1', protocolVersion: 1, capabilities: ['teaching.dependencies'] }, handlers: { 'teaching.dependencies': () => null } });
  const grant = await authority.authorize({ ...runtimeSource, capabilities: ['teaching.dependencies'] });
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
      { ...f.context, origin: { ...f.context.origin, grantId: randomUUID() } }, f.action), { code: 'identity-conflict' });
    const authorize = async (identity, activityId, origin) => {
      await f.authorize(identity, activityId);
      try { if (origin) await f.authority.assertSourceAuthorized(origin, 'teaching.dependencies'); }
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


test('Driver cleanup reconstructs the original stored scope after activity revocation without reading current sources', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    await f.owner.agent.dispatch(f.identity, f.activity.activityId, f.context, f.action);
    const segmentId = randomUUID(), requestId = randomUUID();
    const run = { runId: f.context.runId, activityId: f.activity.activityId, requestId, inputId: randomUUID(), state: 'waiting' };
    const input = { requestId, receiver: { receiverId: 'teaching-agent:'+f.storage.owner.serviceId, location: 'remote', kind: 'question' },
      scope: actionScope(f.identity, f.activity.activityId), draft: { token: randomUUID(), question: '课程操作', references: [], bases: [] }, works: [], evidence: [] };
    const command = { version: 1, commandId: f.action.requestId, name: 'course_operation', arguments: {}, effect: 'execute', location: 'native', conflictKey: f.activity.activityId,
      basis: { requestId: f.action.requestId, scope: { identity: f.identity, activityId: f.activity.activityId,
        runId: run.runId, stepId: f.context.stepId, snapshotId: f.context.snapshotId, segmentId, input, course: f.activity.course } } };
    await f.storage.request({ requestId: randomUUID(), fingerprint: 'original-driver-fault-state' }, async tx => {
      await tx.query("INSERT INTO teaching_runs(run_id,activity_id,request_id,input_id,identity,state,usage) VALUES($1,$2,$3,$4,$5,'waiting',$6)",
        [run.runId, run.activityId, requestId, run.inputId, f.identity, {state:'unknown'}]);
      await tx.query("INSERT INTO teaching_steps(step_id,run_id,step_no,attempt_id,segment_id,snapshot_id,phase,plan,output_reserved,input_reserved) VALUES($1,$2,0,$3,$4,$5,'waiting',$6,0,0)",
        [f.context.stepId, run.runId, randomUUID(), segmentId, f.context.snapshotId, {}]);
      await tx.query("INSERT INTO teaching_commands(command_id,run_id,step_id,call_id,ordinal,command,state) VALUES($1,$2,$3,'original-call',0,$4,'dispatching')",
        [command.commandId, run.runId, f.context.stepId, command]);
      return null;
    });
    f.revoke();
    const host = createTeachingTools({ learning: () => ({ executions: f.owner, open: f.authorize }), courses: {} });
    const driver = createTeachingRunDriver(f.storage, { tools: host, models: {}, activity: async () => { assert.fail('cleanup must not read current activity'); },
      runRow: async () => ({...run,identity:f.identity}), identity: () => f.identity, appendEvent: async () => null,
      dispatchClosed: () => false, requestRow: async () => { assert.fail('cleanup must not reload current sources'); } });
    await driver.stopTools(run);
    const [record] = await driver.records(run.activityId);
    assert.equal(record.result.cleanupCompleted, true);
    assert.equal(record.result.sessionStopped, true);
    await f.owner.agent.validate();
  } finally { await f.close(); }
});

test('owner authorization scanning is bounded, fair and stops monitoring confirmed physical history', { timeout: 120000 }, async () => {
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
    await f.owner.agent.reconcileAuthorization(authorize);
    assert.equal(checks,20);
    await f.owner.agent.reconcileAuthorization(authorize);
    assert.equal(checks,21, 'the oldest unvisited command must get the next batch');
    await new Promise(resolve=>setTimeout(resolve,1100));
    await f.owner.agent.reconcileAuthorization(authorize);
    assert.equal(checks,21,'confirmed ended sessions leave the recurring authorization scan');
    await f.owner.agent.validate();
  } finally { await f.close(); }
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
      try {await f.authority.assertSourceAuthorized(origin,'teaching.dependencies');}
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
      await f.authorize(identity,activityId);await f.authority.assertSourceAuthorized(origin,'teaching.dependencies');
    }),[]);
    const current=await f.owner.agent.read(f.identity,f.activity.activityId,f.context,f.action.requestId);
    assert.equal(current.state,'running',JSON.stringify(current));
    assert.equal(current.executionRef,started.executionRef);assert.equal(current.stopRequested,false);
    const input={controlId:randomUUID(),operationId:'advance',effect:'input',expectedSeq:0,parameters:{value:1}};
    const advanced=await f.owner.agent.control(f.identity,f.activity.activityId,{...f.context,commandId:input.controlId},f.action.requestId,input);
    assert.equal(advanced.session.observation.total,1,'the original physical session must still accept its first real input');
  }finally{await monitor?.shutdown();await storage?.close();await f.close();}
});
