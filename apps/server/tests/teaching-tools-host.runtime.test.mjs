import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { createExecutions, executionMigration, executionActionTextMigration } from '../../../packages/learning-space/dist/learning-data/executions.js';
import { agentExecutionMigration, agentExecutionOriginMigration, agentExecutionAuthorityMigration } from '../../../packages/learning-space/dist/learning-data/agent-executions.js';
import { channelExecutionMigration, channelCheckpointMigration } from '../../../packages/learning-space/dist/learning-data/channel-executions.js';
import { collectExecutionBoundary, validateExecutionBoundary } from '../../../packages/learning-space/dist/learning-data/maintenance.js';
import { createNativeChannel, nativeChannelMigration, nativeChannelTargetMigration, nativeChannelObservationMigration, nativeChannelCancellationMigration, nativeChannelCleanupMigration } from '../../../packages/learning-space/dist/learning-data/native-channel.js';
import { nativeSessionMigration, validateNativeSessions } from '../../../packages/learning-space/dist/learning-data/native-sessions.js';
import { teachingArtifactMigration } from '../../../packages/learning-space/dist/learning-data/teaching-artifacts.js';
import { sessionRecoveryMigration } from '../../../packages/learning-space/dist/learning-data/session-checkpoints.js';
import { createWorks, workMigration } from '../../../packages/learning-space/dist/learning-data/works.js';
import { accumulatorPackage } from '../../../components/state-accumulator/package.mjs';
import { canonicalValue } from '@xunjie/contracts/execution';
const actionScope = (identity, activityId) => ({ environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId });
const hash = value => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');

async function fixture() {
  const pg = await nativeFixture();
  const migrations = [{ version: 1, name: 'activities', sql: 'CREATE TABLE activities(id uuid PRIMARY KEY,body jsonb NOT NULL);' },
    workMigration, executionMigration, nativeSessionMigration, sessionRecoveryMigration, executionActionTextMigration, channelExecutionMigration, channelCheckpointMigration, nativeChannelMigration, nativeChannelTargetMigration, nativeChannelObservationMigration, nativeChannelCancellationMigration, nativeChannelCleanupMigration, agentExecutionMigration, agentExecutionOriginMigration, agentExecutionAuthorityMigration, teachingArtifactMigration].map((m, i) => ({ ...m, version: i + 1 }));
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
  const context = { runId: randomUUID(), stepId: randomUUID(), commandId: action.requestId, snapshotId: randomUUID(),
    assertDispatch: async () => { if (!allowed) throw new StorageError('forbidden'); } };
  return { pg, storage, owner, identity, activity, action, context, works, authorize,
    revoke: () => { allowed = false; }, async close() { await owner.shutdown(); await storage.close(); await pg.close(); } };
}

test('trusted execution owner runs an agent session, preserves prior input, fences student and cancelled dispatch', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.owner.accept(f.identity, f.activity.activityId, { action: f.action }), { code: 'forbidden' });
    const started = await f.owner.agent.dispatch(f.identity, f.activity.activityId, f.context, f.action);
    assert.equal(started.state, 'running');
    assert.equal(started.session.observation.total, 0);
    const control = (seq, value) => ({ controlId: randomUUID(), operationId: 'advance', effect: 'input', expectedSeq: seq, parameters: { value } });
    let result = started;
    for (const [seq, value, expected] of [[0, 1, 1], [1, 2, 3], [2, 2, 1]]) {
      const c = control(seq, value);
      result = await f.owner.agent.control(f.identity, f.activity.activityId, { ...f.context, commandId: c.controlId }, f.action.requestId, c);
      assert.equal(result.session.observation.value, expected);
      assert.equal(result.session.appliedSeq, seq + 1);
    }
    const blocked = control(3, 1);
    let dispatchChecks = 0;
    await assert.rejects(f.owner.agent.control(f.identity, f.activity.activityId,
      { ...f.context, commandId: blocked.controlId, assertDispatch: async () => {
        if (++dispatchChecks === 2) throw new StorageError('forbidden');
      } }, f.action.requestId, blocked), { code: 'forbidden' });
    assert.equal((await f.owner.controlReceipt(f.identity, f.activity.activityId, f.action.requestId, blocked.controlId)).status, 'rejected');
    assert.equal((await f.owner.read(f.identity, f.activity.activityId, f.action.requestId)).session.observation.total, 5,
      'losing a permit at the actual process boundary never applies another input');
    const original = await f.owner.agent.read(f.identity, f.activity.activityId, f.context, f.action.requestId);
    assert.equal(original.executionRef, started.executionRef);
    assert.equal(original.session.observation.total, 5);
    await assert.rejects(f.owner.agent.stop(f.identity, f.activity.activityId, { ...f.context, runId: randomUUID() }, f.action.requestId,
      { stopId: randomUUID(), reason: '' }), { code: 'forbidden' });
    const cancelled = await f.owner.agent.stop(f.identity, f.activity.activityId, f.context, f.action.requestId,
      { stopId: randomUUID(), reason: '' });
    assert.equal(cancelled.state, 'cancelled');
    const independentAction = { ...f.action, requestId: randomUUID(), execution: { ...f.action.execution,
      initiator: { kind: 'student', principalId: f.identity.principalId } } };
    const independent = await f.owner.accept(f.identity, f.activity.activityId, { action: independentAction });
    assert.equal(independent.state, 'running');
    assert.equal(await f.owner.agent.stop(f.identity, f.activity.activityId, f.context, independentAction.requestId,
      { stopId: randomUUID(), reason: '' }), null);
    assert.equal((await f.owner.read(f.identity, f.activity.activityId, independentAction.requestId)).state, 'running');
    await f.owner.agent.validate();
    f.revoke();
    await assert.rejects(f.owner.agent.dispatch(f.identity, f.activity.activityId, f.context,
      { ...f.action, requestId: randomUUID() }), { code: 'forbidden' });
  } finally { await f.close(); }
});

test('a native expectedSeq conflict retains a rejected original receipt without changing or stopping the parent session', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const started = await f.owner.agent.dispatch(f.identity, f.activity.activityId, f.context, f.action);
    assert.equal(started.session.appliedSeq, 0, 'starting a session does not apply a control');
    const input = { controlId: randomUUID(), operationId: 'advance', effect: 'input', expectedSeq: 2, parameters: { value: 1 } };
    const context = { ...f.context, commandId: input.controlId };
    await assert.rejects(f.owner.agent.control(f.identity, f.activity.activityId, context, f.action.requestId, input), { code: 'identity-conflict' });
    const rejected = await f.owner.controlReceipt(f.identity, f.activity.activityId, f.action.requestId, input.controlId);
    assert.ok(rejected, 'the owner must retain its definite no-effect rejection for recovery');
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.seq, 3);
    assert.equal(rejected.query.state, 'running');
    assert.equal(rejected.query.stopRequested, false);
    assert.equal(rejected.query.session.appliedSeq, 0);
    assert.deepEqual(rejected.query.session.observation, { value: 0, total: 0, applied: 0 });
    await assert.rejects(f.owner.agent.control(f.identity, f.activity.activityId, context, f.action.requestId, input), { code: 'invalid' });
    assert.deepEqual(await f.owner.controlReceipt(f.identity, f.activity.activityId, f.action.requestId, input.controlId), rejected);
    await assert.rejects(f.owner.agent.control(f.identity, f.activity.activityId, context, f.action.requestId,
      { ...input, expectedSeq: 0 }), { code: 'identity-conflict' });
    const valid = { ...input, controlId: randomUUID(), expectedSeq: 0 };
    const applied = await f.owner.agent.control(f.identity, f.activity.activityId,
      { ...f.context, commandId: valid.controlId }, f.action.requestId, valid);
    assert.equal(applied.executionRef, started.executionRef);
    assert.equal(applied.state, 'running');
    assert.equal(applied.session.appliedSeq, 1);
    assert.deepEqual(applied.session.observation, { value: 1, total: 1, applied: 1 });
    assert.equal((await f.owner.controlReceipt(f.identity, f.activity.activityId, f.action.requestId, input.controlId)).status, 'rejected');
    await f.owner.agent.validate();
    await validateNativeSessions(f.storage);
  } finally { await f.close(); }
});

test('actual tools report native sequence rejection as a no-effect model error before and after a concurrent advance', { timeout: 120000 }, async t => {
  const f = await fixture();
  try {
    const { createTeachingTools } = await import('../../../packages/agents/dist/workspace-assistant/tools/tools.js');
    const scope = { identity: f.identity, activity: f.activity, runId: f.context.runId, stepId: f.context.stepId,
      snapshotId: f.context.snapshotId, assertDispatch: f.context.assertDispatch,
      input: { requestId: randomUUID(), scope: actionScope(f.identity, f.activity.activityId),
        receiver: { receiverId: 'teaching-agent', kind: 'question', location: 'local' },
        draft: { token: 'fixed', question: 'apply one original input', references: [], bases: [] }, works: [], evidence: [] } };
    const host = createTeachingTools({ learning: () => ({ open: f.authorize, works: f.works, executions: f.owner }),
      courses: { verifyComponentReference: async () => {} } });
    const prepare = args => host.prepare(scope, { callId: randomUUID(), name: 'course_operation',
      arguments: { componentKey: 'counter', operationId: 'advance', parameters: { value: 1 }, ...args } }, randomUUID());
    const start = await prepare({ operationId: 'start_session', parameters: {} });
    const begun = await host.dispatch(scope, start);
    assert.equal(begun.state, 'completed');
    assert.equal(begun.result.query.session.appliedSeq, 0);
    assert.notEqual(begun.result.query.confirmedSeq, 0, 'confirmedSeq is not the input appliedSeq');

    const wrong = await prepare({ requestId: start.commandId, expectedSeq: 2 });
    const rejected = await host.dispatch(scope, wrong);
    assert.equal(rejected.state, 'failed');
    assert.equal(rejected.feedback.outcome, 'error');
    assert.equal(rejected.result.controlReceipt.status, 'rejected');
    assert.deepEqual(rejected.result.controlState, { expectedSeq: 2, appliedSeq: 0, effectApplied: false });
    assert.equal(rejected.result.operationCompleted, false);
    assert.equal(rejected.result.query.state, 'running');
    assert.equal(rejected.result.query.stopRequested, false);
    assert.equal((await host.reconcileOriginal(scope, wrong)).state, 'failed', 'recovery reads the original rejection, not parent running');

    const late = await prepare({ requestId: start.commandId, expectedSeq: 0 });
    const control = { controlId: randomUUID(), operationId: 'advance', effect: 'input', expectedSeq: 0, parameters: { value: 2 } };
    await f.owner.agent.control(f.identity, f.activity.activityId, { ...f.context, commandId: control.controlId }, start.commandId, control);
    const conflict = await host.dispatch(scope, late);
    assert.equal(conflict.state, 'failed');
    assert.equal(conflict.feedback.outcome, 'error');
    assert.deepEqual(conflict.result.controlState, { expectedSeq: 0, appliedSeq: 1, effectApplied: false });
    assert.deepEqual(conflict.result.query.session.observation, { value: 2, total: 2, applied: 1 });
    assert.equal((await host.reconcileOriginal(scope, late)).state, 'failed');
    assert.equal((await host.reconcileOriginal(scope, wrong)).result.controlState.appliedSeq, 1);

    const unsent = await prepare({ requestId: start.commandId, expectedSeq: 1 });
    const unconfirmed = await host.reconcileOriginal(scope, unsent);
    assert.equal(unconfirmed.state, 'unknown', 'a parent session cannot prove an unsent control accepted');
    assert.equal(unconfirmed.result.operationCompleted, false);
    assert.equal(unconfirmed.result.query.state, 'running');
    assert.equal(unconfirmed.result.query.stopRequested, false);
    const valid = await prepare({ requestId: start.commandId, expectedSeq: 1 });
    const applied = await host.dispatch(scope, valid);
    assert.equal(applied.state, 'completed');
    assert.deepEqual(applied.result.query.session.observation, { value: 3, total: 3, applied: 2 });
    await t.test('recovery rejects another control, request, execution or subject receipt', async () => {
      const readReceipt = f.owner.controlReceipt;
      const original = await readReceipt(f.identity, f.activity.activityId, start.commandId, valid.commandId);
      try {
        for (const foreign of [
          { ...original, controlId: randomUUID() },
          { ...original, requestId: randomUUID() },
          { ...original, executionRef: randomUUID() },
          { ...original, query: { ...original.query, requestId: randomUUID() } },
          { ...original, query: { ...original.query, executionRef: randomUUID() } },
          { ...original, query: { ...original.query, scope: { ...original.query.scope, principalId: randomUUID() } } },
        ]) {
          f.owner.controlReceipt = async () => foreign;
          await assert.rejects(host.reconcileOriginal(scope, valid), { code: 'identity-conflict' });
        }
      } finally { f.owner.controlReceipt = readReceipt; }
      assert.deepEqual((await host.reconcileOriginal(scope, valid)).result.controlState,
        { expectedSeq: 1, appliedSeq: 2, effectApplied: true });
    });
    await f.owner.agent.validate();
  } finally { await f.close(); }
});

test('tool host freezes an approved work and runs manifest-declared stateful operations through the actual owner', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const { createTeachingTools } = await import('../../../packages/agents/dist/workspace-assistant/tools/tools.js');
    const file = { objectId: randomUUID(), contentId: randomUUID(), name: 'notes.txt', kind: 'text', encoding: 'utf8', mediaType: 'text/plain', value: 'fixed: 1, 2, 2' };
    await f.works.sync(f.identity, f.activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [file] });
    const scope = { identity: f.identity, activity: f.activity, runId: f.context.runId, stepId: f.context.stepId,
      snapshotId: f.context.snapshotId, assertDispatch: f.context.assertDispatch,
      input: { requestId: randomUUID(), scope: actionScope(f.identity, f.activity.activityId),
        receiver: { receiverId: 'teaching-agent', kind: 'question', location: 'local' },
        draft: { token: 'fixed', question: 'read then advance', references: [], bases: [] }, works: [file], evidence: [] } };
    const host = createTeachingTools({ learning: () => ({ open: f.authorize, works: f.works, executions: f.owner }),
      courses: { verifyComponentReference: async () => {} } });
    const definitions = await host.definitions(scope);
    assert.deepEqual(definitions.map(d => d.name).sort(), ['course_operation', 'execution_query', 'execution_stop', 'generate_teaching_artifact',
      'read_material', 'read_reference', 'read_result', 'read_student_facts', 'read_teaching_artifact', 'read_work', 'search_materials']);
    const intent = (name, args) => ({ callId: randomUUID(), name, arguments: args });
    await assert.rejects(host.prepare(scope, intent('read_work', { objectId: file.objectId, contentId: file.contentId, path: '/' }), randomUUID()), { code: 'invalid' });
    await assert.rejects(host.prepare(scope, intent('read_work', { objectId: file.objectId, contentId: randomUUID() }), randomUUID()), { code: 'forbidden' });
    const reading = await host.prepare(scope, intent('read_work', { objectId: file.objectId, contentId: file.contentId }), randomUUID());
    const newer = { ...file, contentId: randomUUID(), value: 'new head must not replace the original' };
    // The real mutable head moves, while the tool must still read the originally approved resource.
    await f.works.sync(f.identity, f.activity.activityId, { requestId: randomUUID(), baseRevision: 1, files: [newer] });
    assert.equal((await host.dispatch(scope, reading)).result.file.value, 'fixed: 1, 2, 2');
    assert.equal((await host.dispatch(scope, reading)).result.sourceState, 'fixed-current', 'provenance stays at the prepare observation');
    const historical = await host.prepare(scope, intent('read_work', { objectId: file.objectId, contentId: file.contentId }), randomUUID());
    assert.equal((await host.dispatch(scope, historical)).result.sourceState, 'older-version');
    assert.equal((await f.works.read(f.identity, f.activity.activityId)).files[0].value, newer.value);
    assert.equal(definitions.every(d => d.strict === undefined), true, 'routes need no unverified strictTools capability');
    await assert.rejects(host.prepare(scope, intent('read_work', { objectId: 'x'.repeat(36), contentId: file.contentId }), randomUUID()), { code: 'invalid' });
    const unretained = { ...file, objectId: randomUUID(), contentId: randomUUID(), value: 'not synced' };
    const missingScope = { ...scope, input: { ...scope.input, works: [unretained] } };
    const missing = await host.prepare(missingScope, intent('read_work', { objectId: unretained.objectId, contentId: unretained.contentId }), randomUUID());
    assert.equal((await host.dispatch(missingScope, missing)).result.sourceState, 'missing');
    const pendingScope = { ...scope, input: { ...scope.input, works: [], draft: { ...scope.input.draft, bases: [unretained] } } };
    const unsynced = await host.prepare(pendingScope, intent('read_work', { objectId: unretained.objectId, contentId: unretained.contentId }), randomUUID());
    assert.equal((await host.dispatch(pendingScope, unsynced)).result.sourceState, 'missing');
    await f.works.registerBasis(f.identity, f.activity.activityId, unretained);
    const retained = await host.prepare(pendingScope, intent('read_work', { objectId: unretained.objectId, contentId: unretained.contentId }), randomUUID());
    assert.equal((await host.dispatch(pendingScope, retained)).result.sourceState, 'fixed-unpublished');
    await assert.rejects(host.prepare(scope, intent('shell', { command: 'anything' }), randomUUID()), { code: 'invalid' });
    const start = await host.prepare(scope, intent('course_operation', { componentKey: 'counter', operationId: 'start_session', parameters: {} }), randomUUID());
    assert.deepEqual(await f.owner.sessions(f.identity, f.activity.activityId), [], 'prepare never launches a process');
    const begun = await host.dispatch(scope, start);
    assert.equal(begun.state, 'completed');
    assert.equal(begun.result.sessionOngoing, true);
    assert.equal(begun.result.query.session.observation.value, 0);
    let seq = 0;
    for (const [value, expected] of [[1, 1], [2, 3], [2, 1]]) {
      const next = await host.prepare(scope, intent('course_operation', { componentKey: 'counter', operationId: 'advance',
        requestId: start.commandId, expectedSeq: seq++, parameters: { value } }), randomUUID());
      const result = await host.dispatch(scope, next);
      assert.equal(result.state, 'completed');
      assert.equal(result.result.query.session.observation.value, expected);
      assert.equal((await host.reconcile(scope, next)).result.controlReceipt.status, 'applied');
    }
    f.revoke();
    const stopped = await host.stop(scope, start);
    assert.equal(stopped.result.cleanup, true);
    assert.equal(stopped.result.query.state, 'cancelled');
    await assert.rejects(host.dispatch(scope, start), { code: 'forbidden' });
  } finally { await f.close(); }
});

test('browser handoff survives owner reconstruction, requires a live permit and retains a true Wasm result', { timeout: 120000 }, async () => {
  const f = await fixture();
  let reopened;
  try {
    const { createTeachingTools } = await import('../../../packages/agents/dist/workspace-assistant/tools/tools.js');
    const { aggregationPackage } = await import('../../../components/table-aggregation/package.mjs');
    const published = await aggregationPackage(), manifest = published.manifest;
    const binding = { key: 'table', definition: { manifest, digest: 'b'.repeat(64) }, configuration: {}, materialIds: [] };
    f.activity.course.components.push(binding);
    const state = { formatVersion: 1, instanceId: f.activity.activityId + ':table', componentId: manifest.componentId,
      version: manifest.version, definitionDigest: binding.definition.digest, stateVersion: 1, operationId: randomUUID(), content: manifest.initialState };
    const file = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/table.json', kind: 'state', encoding: 'json',
      mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify(state) };
    const scope = { identity: f.identity, activity: f.activity, runId: f.context.runId, stepId: f.context.stepId, snapshotId: f.context.snapshotId,
      assertDispatch: f.context.assertDispatch, input: { requestId: randomUUID(), scope: actionScope(f.identity, f.activity.activityId),
        receiver: { receiverId: 'teaching-agent', kind: 'question', location: 'local' },
        draft: { token: 'fixed', question: 'compute mean', references: [], bases: [] }, works: [file], evidence: [] } };
    const host = createTeachingTools({ learning: () => ({ open: f.authorize, works: f.works, executions: f.owner }),
      courses: { verifyComponentReference: async () => {} } });
    const command = await host.prepare(scope, { callId: 'compute', name: 'course_operation', arguments: { componentKey: 'table',
      operationId: 'aggregate', parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } } }, randomUUID());
    const invalidFile = { ...file, contentId: randomUUID(), value: JSON.stringify({ ...state, componentId: randomUUID() }) };
    const invalidAction = structuredClone(command.basis.action);
    invalidAction.requestId = randomUUID();
    invalidAction.execution.basis.works = [invalidFile];
    invalidAction.execution.basis.state.contentId = invalidFile.contentId;
    invalidAction.execution.basis.state.sha256 = hash(JSON.parse(invalidFile.value));
    invalidAction.execution.basis.expected.stateContentId = invalidFile.contentId;
    await assert.rejects(f.owner.agent.dispatch(f.identity, f.activity.activityId,
      { ...f.context, commandId: invalidAction.requestId }, invalidAction), { code: 'invalid' });
    assert.equal((await host.dispatch(scope, command)).state, 'accepted');
    assert.equal(await host.reconcile(scope, command), null, 'missing acceptance does not authorize replay');
    reopened = createExecutions(f.storage, { activity: f.authorize, works: f.works });
    const browserId = randomUUID();
    const pending = await reopened.agent.pendingBrowser(f.identity, f.activity.activityId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].association.snapshotId, scope.snapshotId);
    assert.deepEqual(pending[0].action.execution.basis.works, [file]);
    await assert.rejects(reopened.agent.claimBrowser(f.identity, f.activity.activityId, command.commandId, browserId,
      async () => { throw new StorageError('forbidden'); }), { code: 'forbidden' });
    const queuedBoundary = await collectExecutionBoundary(f.storage);
    assert.equal(queuedBoundary.agentPendingBrowser.length, 1);
    assert.equal(queuedBoundary.blocking.length, 0);
    const claimed = await reopened.agent.claimBrowser(f.identity, f.activity.activityId, command.commandId, browserId, async a => {
      assert.equal(a.runId, scope.runId); assert.equal(a.commandId, command.commandId);
    });
    await assert.rejects(reopened.agent.claimBrowser(f.identity, f.activity.activityId, command.commandId, randomUUID(), async () => {}), { code: 'identity-conflict' });
    const claimedBoundary = await collectExecutionBoundary(f.storage);
    assert.equal(claimedBoundary.blocking[0].code, 'unconfirmed-agent-browser-acceptance');
    await validateExecutionBoundary(f.storage, claimedBoundary);
    const changedBoundary = structuredClone(claimedBoundary);
    changedBoundary.agentPendingBrowser[0].browserId = randomUUID();
    await assert.rejects(validateExecutionBoundary(f.storage, changedBoundary), { code: 'corrupt' });
    const action = claimed.action;
    const { executionActionSchema } = await import('@xunjie/contracts/execution');
    const acceptance = { receipt: { requestId: action.requestId, receiver: action.receiver, state: 'accepted',
      inputDigest: createHash('sha256').update(JSON.stringify(executionActionSchema.parse(action))).digest('hex'),
      receiptId: 'actual-broker:' + action.requestId, detail: '' }, execution: { executionRef: randomUUID(), acceptedSeq: 1 } };
    await assert.rejects(reopened.agent.acceptBrowser(f.identity, f.activity.activityId, action.requestId, randomUUID(), acceptance, async () => {}), { code: 'forbidden' });
    const accepted = await reopened.agent.acceptBrowser(f.identity, f.activity.activityId, action.requestId, browserId, acceptance, async () => {});
    assert.equal(accepted.executionRef, acceptance.execution.executionRef);
    assert.equal((await reopened.agent.pendingBrowser(f.identity, f.activity.activityId)).length, 0);
    assert.equal((await reopened.agent.acceptBrowser(f.identity, f.activity.activityId, action.requestId, browserId, acceptance, async () => {})).executionRef, accepted.executionRef);
    // Run the actual browser adapter and the package's actual Wasm bytes, with no canned tool result.
    const { build } = await import('esbuild');
    const bundled = await build({ entryPoints: [fileURLToPath(new URL('../../../apps/web/src/tool-execution/algorithm.ts', import.meta.url))],
      bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022' });
    const js = bundled.outputFiles[0].text;
    const algorithm = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
    const job = algorithm.jobFromAction(action, action.execution.limits);
    const computed = algorithm.runAggregation({ ...job, bytes: Buffer.from(published.algorithmBase64, 'base64'),
      memoryPages: manifest.algorithm.memoryPages, entry: manifest.algorithm.entry });
    assert.equal(computed.result.value, 83.33333333333333);
    assert.equal(computed.result.groups[0].mean, 83);
    const bytes = Buffer.from(computed.artifact.text);
    const stored = await reopened.result(f.identity, f.activity.activityId, action.requestId, { contentId: randomUUID(),
      output: computed.result, text: computed.artifact.text, name: computed.artifact.name, mediaType: computed.artifact.mediaType,
      sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length });
    await reopened.report(f.identity, f.activity.activityId, action.requestId, { ...stored, state: 'succeeded', confirmedSeq: 3 });
    const result = await host.reconcile(scope, command);
    assert.equal(result.state, 'completed');
    assert.equal(result.result.query.output.output.value, 83.33333333333333);
    assert.equal(result.result.artifact.text, computed.artifact.text);
    const afterStop = await host.stop(scope, command);
    assert.equal(afterStop.state, 'completed');
    assert.equal(afterStop.result.query.output.output.value, 83.33333333333333);
    assert.equal(afterStop.result.artifact.text, computed.artifact.text);

    // The durable tombstone fences a not-yet-started browser action under the same identity.
    const cancelled = await host.prepare(scope, { callId: 'cancel', name: 'course_operation', arguments: command.arguments }, randomUUID());
    await host.dispatch(scope, cancelled);
    assert.equal((await host.stop(scope, cancelled)).state, 'not-dispatched');
    assert.equal((await host.reconcile(scope, cancelled)).state, 'not-dispatched');
    assert.equal((await reopened.agent.pendingBrowser(f.identity, f.activity.activityId)).length, 0);
    await assert.rejects(reopened.agent.claimBrowser(f.identity, f.activity.activityId, cancelled.commandId, browserId, async () => {}), { code: 'forbidden' });
    const race = await host.prepare(scope, { callId: 'race', name: 'course_operation', arguments: command.arguments }, randomUUID());
    await host.dispatch(scope, race);
    const granted = await reopened.agent.claimBrowser(f.identity, f.activity.activityId, race.commandId, browserId, async () => {});
    assert.equal((await host.stop(scope, race)).state, 'unknown');
    const notices = await reopened.agent.browserStops(f.identity, f.activity.activityId, browserId);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].requestId, race.commandId);
    assert.equal((await reopened.agent.browserStops(f.identity, f.activity.activityId, randomUUID())).length, 0);
    const late = { receipt: { ...acceptance.receipt, requestId: race.commandId,
      inputDigest: createHash('sha256').update(JSON.stringify(executionActionSchema.parse(granted.action))).digest('hex') },
      execution: { executionRef: randomUUID(), acceptedSeq: 1 } };
    const archived = await reopened.agent.acceptBrowser(f.identity, f.activity.activityId, race.commandId, browserId, late,
      async () => { throw new StorageError('forbidden'); });
    assert.equal(archived.stopRequested, true, 'a receipt after cancellation is archived without a new dispatch permit');
    assert.equal(archived.executionRef, late.execution.executionRef);
    await reopened.report(f.identity, f.activity.activityId, race.commandId, { ...archived, state: 'cancelled', confirmedSeq: 4,
      reason: { code: 'worker-terminated', detail: 'original browser confirmed stop' } });
    assert.equal((await reopened.agent.browserStops(f.identity, f.activity.activityId, browserId)).length, 0);
    await reopened.agent.validate();

  } finally { await reopened?.shutdown(); await f.close(); }
});

test('PNG work evidence uses the fixed verified WP06 route and durable image resource without base64 feedback', { timeout: 120000 }, async () => {
  const f = await fixture();
  let modelStorage;
  try {
    const { createTeachingTools } = await import('../../../packages/agents/dist/workspace-assistant/tools/tools.js');
    const { createModelGateway, modelMigrations } = await import('../../../packages/model-gateway/dist/index.js');
    const binding = await provisionStorage({ admin: f.pg.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() },
      password: randomUUID(), migrations: modelMigrations });
    modelStorage = await openStorage({ binding, migrations: modelMigrations,
      backend: createFileBackend({ id: 'images', root: f.pg.root + '/images' }) });
    const models = await createModelGateway(modelStorage, { authorize: async identity => {
      assert.equal(identity.principalId, f.identity.principalId);
    }, holder: 'device' });
    const connectionId = randomUUID();
    const connection = await models.save(f.identity, { requestId: randomUUID(), connectionId, expectedVersion: 0,
      name: 'verified route fixture', protocol: 'chat-completions', baseUrl: 'https://api.deepseek.com/v1', path: '/chat/completions',
      modelId: 'deepseek-flash', dialect: 'deepseek', parameterMode: 'thinking', enabled: true,
      credential: { action: 'replace', value: 'fixture-not-dispatched' } });
    assert.equal(connection.capabilities.images, 'verified');
    const segmentId = randomUUID();
    await models.segments.create(f.identity, { requestId: randomUUID(), segmentId, source: { connectionId, version: 1 },
      purpose: 'learning', prefix: { system: 'Only inspect the fixed image.', tools: [] }, portable: [] });
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
    const file = { objectId: randomUUID(), contentId: randomUUID(), name: 'diagram.png', kind: 'resource', encoding: 'base64', mediaType: 'image/png', value: png };
    await f.works.registerBasis(f.identity, f.activity.activityId, file);
    const scope = { identity: f.identity, activity: f.activity, segmentId, runId: f.context.runId, stepId: f.context.stepId, snapshotId: f.context.snapshotId,
      input: { requestId: randomUUID(), scope: actionScope(f.identity, f.activity.activityId),
        receiver: { receiverId: 'teaching-agent', kind: 'question', location: 'local' },
        draft: { token: 'fixed', question: 'read image', references: [], bases: [] }, works: [file], evidence: [] } };
    const host = createTeachingTools({ learning: () => ({ open: f.authorize, works: f.works, executions: f.owner }), courses: {}, models });
    const command = await host.prepare(scope, { callId: 'image', name: 'read_work', arguments: { objectId: file.objectId, contentId: file.contentId } }, randomUUID());
    const result = await host.dispatch(scope, command);
    assert.equal(result.state, 'completed');
    assert.equal(result.result.file.value, png);
    assert.equal(result.feedback.images.length, 1);
    assert.equal(result.feedback.text.includes(png), false);
    const image = await models.images.read(f.identity, result.feedback.images[0]);
    assert.equal(image.sha256, createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex'));
    assert.deepEqual((await host.reconcile(scope, command)).feedback.images, result.feedback.images, 'lost image receipt reuses the same immutable resource');
    // A later connection change does not alter the original segment's fixed image evidence.
    await models.save(f.identity, { requestId: randomUUID(), connectionId, expectedVersion: 1,
      name: 'unverified replacement', protocol: 'chat-completions', baseUrl: 'http://127.0.0.1:12345', path: '/chat/completions',
      modelId: 'unknown', dialect: 'standard', parameterMode: 'plain', enabled: true, credential: { action: 'replace', value: 'fixture-not-dispatched' } });
    assert.equal((await host.reconcile(scope, command)).state, 'completed');
    const unverifiedSegment = randomUUID();
    await models.segments.create(f.identity, { requestId: randomUUID(), segmentId: unverifiedSegment, source: { connectionId, version: 2 },
      purpose: 'learning', prefix: { system: 'No verified images.', tools: [] }, portable: [] });
    const deniedScope = { ...scope, segmentId: unverifiedSegment };
    const denied = await host.prepare(deniedScope, { callId: 'denied-image', name: 'read_work', arguments: command.arguments }, randomUUID());
    assert.equal((await host.dispatch(deniedScope, denied)).feedback.images.length, 0);
    assert.equal((await host.dispatch(deniedScope, denied)).state, 'failed');
  } finally { await modelStorage?.close(); await f.close(); }
});

test('the original native node rechecks the Agent permit at claim and a durable stop cancels its unclaimed start', { timeout: 120000 }, async () => {
  const f = await fixture();
  let owner;
  try {
    let permit = true, permitChecks = 0;
    const channel = createNativeChannel(f.storage, { authenticate: async () => f.identity, authorize: f.authorize,
      authorizeConnection: async () => {}, assertAgentDispatch: async (identity, activityId, association) => {
        permitChecks++;
        assert.equal(identity.principalId, f.identity.principalId);
        assert.equal(activityId, f.activity.activityId);
        assert.equal(association.snapshotId, f.context.snapshotId);
        if (!permit) throw new StorageError('forbidden');
      } });
    const node = { connectionId: randomUUID(), nodeId: 'original-device', installationId: randomUUID(),
      platform: process.platform === 'darwin' ? 'macos-arm64' : 'windows-x64', supervisorEpoch: randomUUID(),
      adapters: [{ adapterId: 'four-state-accumulator', adapterVersion: 1 }] };
    await channel.register('fixture', node);
    await channel.heartbeat('fixture', node);
    owner = createExecutions(f.storage, { activity: f.authorize, works: f.works, channel });
    const accepted = await owner.agent.dispatch(f.identity, f.activity.activityId, f.context, f.action);
    assert.equal(accepted.state, 'queued');
    permit = false;
    assert.equal((await channel.claim('fixture', node)).command, null, 'a lost teaching permit cancels only this command');
    assert.equal(permitChecks, 1);
    const refused = await owner.agent.read(f.identity, f.activity.activityId, f.context, f.action.requestId);
    assert.equal(refused.state, 'cancelled');
    assert.equal(refused.executionRef, accepted.executionRef);
    assert.equal(refused.statusKnowledge, 'confirmed');
    const cancelled = await owner.agent.stop(f.identity, f.activity.activityId, f.context, f.action.requestId,
      { stopId: randomUUID(), reason: '' });
    assert.equal(cancelled.state, 'cancelled');
    permit = true;
    assert.equal((await channel.claim('fixture', node)).command, null, 'a later permit never revives the cancelled original command');
  } finally { await owner?.shutdown(); await f.close(); }
});

test('revocation cleanup reclaims the original real native process without granting current activity access', { timeout: 120000 }, async () => {
  const f = await fixture();
  let owner, worker;
  try {
    const { createNativeChannelWorker, nativeChannelNode } = await import('@xunjie/product-runtime');
    const native = { nodePath: process.execPath, sessionRoot: f.pg.root + '/revoked-node',
      ...(process.env.XUNJIE_NATIVE_SESSION_HELPER ? { windowsHelper: process.env.XUNJIE_NATIVE_SESSION_HELPER } : {}) };
    const node = await nativeChannelNode({ ...native, connectionId: randomUUID(), installationId: randomUUID(), supervisorEpoch: randomUUID() });
    const authenticate = async () => { await f.authorize(f.identity, f.activity.activityId); return f.identity; };
    const channel = createNativeChannel(f.storage, { authenticate, authorize: f.authorize,
      authorizeConnection: async () => { await authenticate(); }, assertAgentDispatch: async () => f.context.assertDispatch() });
    await channel.register('fixture', node);
    await channel.heartbeat('fixture', node);
    owner = createExecutions(f.storage, { activity: f.authorize, works: f.works, channel });
    const accepted = await owner.agent.dispatch(f.identity, f.activity.activityId, f.context, f.action);
    const cleanupFacts = [];
    worker = createNativeChannelWorker({ root: f.pg.root + '/device', node, native, call: async (operation, input) => {
      if (operation === 'cleanup') {
        const result = await channel.cleanup(input);
        cleanupFacts.push(input.query); return result;
      }
      return channel[operation]('fixture', input);
    } });
    await worker.tick();
    const running = await owner.agent.read(f.identity, f.activity.activityId, f.context, f.action.requestId);
    assert.equal(running.state, 'running');
    assert.equal(running.session.observation.total, 0, 'the product adapter really started');
    f.revoke();
    await assert.rejects(owner.agent.read(f.identity, f.activity.activityId, f.context, f.action.requestId), { code: 'forbidden' });
    const stop = { stopId: randomUUID(), reason: '' };
    const pending = await owner.agent.cleanup(f.identity, f.activity.activityId, f.context, f.action.requestId, stop);
    assert.equal(pending.statusKnowledge, 'unknown', 'a requested cleanup is not an invented physical exit');
    await worker.tick().catch(error => { assert.equal(error.code, 'forbidden'); });
    await worker.stop();
    assert.ok(cleanupFacts.length > 0);
    assert.equal(cleanupFacts[0].state, 'cancelled');
    assert.equal(cleanupFacts[0].statusKnowledge, 'confirmed');
    assert.equal(cleanupFacts[0].executionRef, accepted.executionRef);
    const stopped = await owner.agent.cleanup(f.identity, f.activity.activityId, f.context, f.action.requestId, stop);
    assert.equal(stopped.state, 'cancelled');
    assert.equal(stopped.statusKnowledge, 'confirmed');
    assert.equal(stopped.executionRef, accepted.executionRef);
    await assert.rejects(owner.agent.read(f.identity, f.activity.activityId, f.context, f.action.requestId), { code: 'forbidden' },
      'a cleanup proof never restores activity access');
  } finally { await worker?.stop(); await owner?.shutdown(); await f.close(); }
});
