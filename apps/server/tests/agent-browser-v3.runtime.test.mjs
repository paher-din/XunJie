import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { learningMigrations } from '@xunjie/learning-space';
import { activitySchema } from '@xunjie/contracts/learning-data';
import { anyExecutionActionSchema, canonicalValue, courseExecutionPlanBasis } from '@xunjie/contracts/execution';
import { createExecutions, validateExecutions } from '../../../packages/learning-space/dist/learning-data/executions.js';
import { createWorks } from '../../../packages/learning-space/dist/learning-data/works.js';
import { collectExecutionBoundary, validateExecutionBoundary } from '../../../packages/learning-space/dist/learning-data/maintenance.js';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { aluCoursePackage } from '../../../components/alu-experiment/package.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonicalHash = value => hash(canonicalValue(value));

async function fixture(t) {
  const pg = await nativeFixture();
  let storage;
  t.after(async () => { try { await storage?.close(); } finally { await pg.close(); } });
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations: learningMigrations });
  const options = { binding, migrations: learningMigrations,
    backend: createFileBackend({ id: owner.serviceId, root: join(pg.root, 'objects') }) };
  storage = await openStorage(options);
  const published = await aluCoursePackage();
  const identity = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: 'Agent owner test' };
  const activity = activitySchema.parse({ activityId: randomUUID(), identity, target: { ...owner, version: 1 },
    goal: 'Verify the fixed question code', question: '', references: [], status: 'open', createdAt: new Date().toISOString(),
    course: { ...published.release, associationId: randomUUID(), courseId: published.course.courseId,
      courseName: published.course.name, taskId: published.task.taskId, taskTitle: published.task.title, contentDigest: 'a'.repeat(64), materials: [] } });
  await storage.request({ requestId: randomUUID(), fingerprint: randomUUID() }, async tx => {
    await tx.query('INSERT INTO activities VALUES($1,$2,$3,$4,$5)', [activity.activityId,
      identity.environmentId, identity.spaceId, identity.principalId, JSON.stringify(activity)]);
    return null;
  });
  const authorize = async (who, id) => {
    if (hash(who) !== hash(identity) || id !== activity.activityId) throw new StorageError('forbidden');
    return activity;
  };
  const makeOwner = () => createExecutions(storage, { activity: authorize, works: createWorks(storage, authorize) });
  let executions = makeOwner();
  function command() {
    const component = activity.course.components[0], manifest = component.definition.manifest;
    const operation = manifest.runtime.operations.find(item => item.operationId === 'run-single');
    const plan = activity.course.executionPlan;
    const action = anyExecutionActionSchema.parse({ protocolVersion: 3, kind: 'execution', requestId: randomUUID(),
      scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId: activity.activityId },
      receiver: { receiverId: 'browser-execution', location: 'local', kind: 'execution' },
      execution: { instance: { instanceId: `${activity.activityId}:${component.key}`, key: component.key,
        componentId: manifest.componentId, componentVersion: manifest.version, definitionDigest: component.definition.digest,
        hostApiVersion: manifest.hostApiVersion, stateVersion: manifest.stateVersion },
        operation: { operationId: operation.operationId, effect: 'execute' }, parameters: { A: 15, B: 1, M: 1, S: 0, Cin: 0 },
        basis: { works: [{ objectId: randomUUID(), contentId: randomUUID(), name: operation.compile.entryFiles[0],
          kind: 'code', encoding: 'utf8', mediaType: 'text/plain', value: 'module alu; endmodule\n' }],
          runtime: { adapterId: manifest.runtime.adapterId, adapterVersion: manifest.runtime.adapterVersion,
            bundleIdentity: manifest.runtime.bundleIdentity, resources: manifest.runtime.resources },
          compile: operation.compile, observation: operation.observation,
          course: { releaseId: activity.course.releaseId, behaviorRuleDigest: canonicalHash(activity.course.requirements), planDigest: plan.planDigest },
          expected: { stateContentId: null } },
        limits: { ...operation.budgets, concurrentJobs: manifest.budget.concurrentJobs, queuedJobs: manifest.budget.queuedJobs },
        plan: { planId: plan.planId, planVersion: plan.planVersion, planDigest: plan.planDigest, location: 'browser', kind: 'job' },
        initiator: { kind: 'agent', principalId: identity.principalId } } });
    let permitted = true;
    const context = { runId: randomUUID(), stepId: randomUUID(), commandId: action.requestId, snapshotId: randomUUID(),
      assertDispatch: async () => { if (!permitted) throw new StorageError('forbidden'); } };
    const { assertDispatch, ...association } = context;
    const acceptance = { receipt: { requestId: action.requestId, inputDigest: hash(action), receiver: action.receiver,
      state: 'accepted', receiptId: 'browser:' + action.requestId, detail: 'Original broker receipt' },
      execution: { executionRef: randomUUID(), acceptedSeq: 1 } };
    return { action, context, association, acceptance, revoke: () => { permitted = false; } };
  }
  return { get storage() { return storage; }, get executions() { return executions; }, identity, activity, command,
    async reopen() { await storage.close(); storage = await openStorage(options); executions = makeOwner(); } };
}

test('trusted V3 dispatch retains the fixed code, original association and browser binding across restart', { timeout: 120000 }, async t => {
  const f = await fixture(t), c = f.command(), id = f.activity.activityId, browserId = randomUUID();
  assert.equal(await f.executions.agent.dispatch(f.identity, id, c.context, c.action), null);
  const works = createWorks(f.storage, async () => f.activity);
  const original = c.action.execution.basis.works[0];
  const newer = { ...original, contentId: randomUUID(), value: 'module edited_after_question; endmodule\n' };
  await works.sync(f.identity, id, { requestId: randomUUID(), baseRevision: 0, files: [newer] });
  await f.reopen();
  assert.deepEqual(await f.executions.agent.pendingBrowser(f.identity, id), [{ action: c.action, association: c.association }]);
  assert.deepEqual(await f.executions.agent.claimBrowser(f.identity, id, c.action.requestId, browserId,
    async association => { assert.deepEqual(association, c.association); await c.context.assertDispatch(); }),
  { action: c.action, association: c.association });
  await assert.rejects(f.executions.agent.claimBrowser(f.identity, id, c.action.requestId, randomUUID(), async () => {}), { code: 'identity-conflict' });
  await assert.rejects(f.executions.agent.acceptBrowser(f.identity, id, c.action.requestId, randomUUID(), c.acceptance, async () => {}), { code: 'forbidden' });
  const accepted = await f.executions.agent.acceptBrowser(f.identity, id, c.action.requestId, browserId, c.acceptance, async () => {});
  assert.equal(accepted.inputDigest, c.acceptance.receipt.inputDigest);
  assert.equal(accepted.executionRef, c.acceptance.execution.executionRef);
  assert.deepEqual((await f.executions.history(f.identity, id)).entries[0].action, c.action);
  assert.deepEqual(await f.executions.agent.pendingBrowser(f.identity, id), []);
  await validateExecutions(f.storage);
});

test('Agent verification refuses student state or predictions even when they are not the expected state', { timeout: 120000 }, async t => {
  const f = await fixture(t), id = f.activity.activityId;
  const c = f.command();
  c.action.execution.basis.works.push({ objectId: randomUUID(), contentId: randomUUID(), name: 'components/alu.json',
    kind: 'state', encoding: 'json', mediaType: 'application/vnd.xunjie.component-state+json',
    value: JSON.stringify({ content: { caseRequestId: c.action.requestId, caseDraft: '{"predictedF":"0000","reason":"student prediction"}' } }) });
  await assert.rejects(f.executions.agent.dispatch(f.identity, id, c.context, c.action), { code: 'invalid' });
  assert.deepEqual(await f.executions.agent.pendingBrowser(f.identity, id), []);
});

test('the V3 owner rejects self-reported Agent roles and re-derives every declared runtime permission', { timeout: 120000 }, async t => {
  const f = await fixture(t), id = f.activity.activityId, c = f.command();
  await assert.rejects(f.executions.accept(f.identity, id, { action: c.action, acceptance: c.acceptance }), { code: 'forbidden' });
  for (const change of [
    a => { a.execution.parameters.A = 16; },
    a => { a.execution.parameters.extra = 'arbitrary'; },
    a => { a.execution.basis.runtime.bundleIdentity = 'f'.repeat(64); },
    a => { a.execution.basis.runtime.resources[0].sha256 = 'f'.repeat(64); },
    a => { a.execution.basis.compile.top = 'other'; },
    a => { a.execution.basis.observation.ports.result = 'other'; },
    a => { a.execution.basis.course.releaseId = randomUUID(); },
    a => { a.execution.basis.course.behaviorRuleDigest = 'f'.repeat(64); },
    a => { a.execution.plan.planDigest = 'f'.repeat(64); },
    a => { a.execution.limits.memoryMiB += 1; },
    a => { a.execution.basis.expected.stateContentId = randomUUID(); },
    a => { a.execution.basis.enabledBy = { requestId: randomUUID(), executionRef: randomUUID(), inputDigest: 'a'.repeat(64) }; },
    a => { a.execution.operation.operationId = 'check-all'; a.execution.parameters = {}; },
  ]) {
    const bad = f.command(); change(bad.action);
    await assert.rejects(f.executions.agent.dispatch(f.identity, id, bad.context, bad.action), { code: 'invalid' });
  }
  c.revoke();
  await assert.rejects(f.executions.agent.dispatch(f.identity, id, c.context, c.action), { code: 'forbidden' });
  const restricted = f.command(), plan = f.activity.course.executionPlan;
  const permissions = plan.components[0].operations;
  const originalDigest = plan.planDigest;
  plan.components[0].operations = [];
  plan.planDigest = canonicalHash(courseExecutionPlanBasis(plan));
  await assert.rejects(f.executions.agent.dispatch(f.identity, id, restricted.context, restricted.action), { code: 'forbidden' });
  plan.components[0].operations = permissions;
  plan.planDigest = originalDigest;
  const policy = f.activity.course.helpPolicy;
  f.activity.course.helpPolicy = { ...policy, questions: 'disabled' };
  await assert.rejects(f.executions.agent.dispatch(f.identity, id, restricted.context, restricted.action), { code: 'forbidden' });
  f.activity.course.helpPolicy = policy;
  assert.deepEqual(await f.executions.agent.pendingBrowser(f.identity, id), []);
});

test('V3 stops and revoked permits fence dispatch while late receipts retain the original browser and facts', { timeout: 120000 }, async t => {
  const f = await fixture(t), id = f.activity.activityId, browserId = randomUUID(), c = f.command();
  await f.executions.agent.dispatch(f.identity, id, c.context, c.action);
  await f.executions.agent.claimBrowser(f.identity, id, c.action.requestId, browserId, c.context.assertDispatch);
  const boundary = await collectExecutionBoundary(f.storage);
  assert.equal(boundary.blocking[0].code, 'unconfirmed-agent-browser-acceptance');
  await validateExecutionBoundary(f.storage, boundary);
  c.revoke();
  await assert.rejects(f.executions.agent.claimBrowser(f.identity, id, c.action.requestId, browserId, c.context.assertDispatch), { code: 'forbidden' });
  const stop = { stopId: randomUUID(), reason: '' };
  assert.equal(await f.executions.agent.stop(f.identity, id, c.context, c.action.requestId, stop), null);
  const notices = await f.executions.agent.browserStops(f.identity, id, browserId);
  assert.deepEqual(notices, [{ requestId: c.action.requestId, association: c.association, stop }]);
  assert.deepEqual(await f.executions.agent.browserStops(f.identity, id, randomUUID()), []);
  await f.reopen();
  const late = await f.executions.agent.acceptBrowser(f.identity, id, c.action.requestId, browserId, c.acceptance,
    async () => { assert.fail('archiving a receipt must not issue a new dispatch permit'); });
  assert.equal(late.stopRequested, true);
  assert.equal(late.executionRef, c.acceptance.execution.executionRef);
  const terminal = await f.executions.report(f.identity, id, c.action.requestId, { ...late, state: 'cancelled',
    confirmedSeq: late.confirmedSeq + 1, reason: { code: 'worker-terminated', detail: 'Original broker confirmed stop' } });
  await f.executions.agent.validate();
  await validateExecutions(f.storage);
  await f.reopen();
  assert.deepEqual(await f.executions.agent.read(f.identity, id, c.context, c.action.requestId), terminal);
  assert.deepEqual(await f.executions.agent.browserStops(f.identity, id, browserId), []);
  const before = await f.executions.history(f.identity, id);
  await validateExecutions(f.storage);
  await validateExecutionBoundary(f.storage, await collectExecutionBoundary(f.storage));
  assert.deepEqual(await f.executions.history(f.identity, id), before, 'maintenance reads do not dispatch or rewrite the fixed command');
  const unclaimed = f.command();
  await f.executions.agent.dispatch(f.identity, id, unclaimed.context, unclaimed.action);
  assert.equal(await f.executions.agent.cleanup(f.identity, id, unclaimed.context, unclaimed.action.requestId,
    { stopId: randomUUID(), reason: '' }), null);
  await assert.rejects(f.executions.agent.claimBrowser(f.identity, id, unclaimed.action.requestId, browserId, async () => {}), { code: 'forbidden' });
  assert.deepEqual(await f.executions.agent.pendingBrowser(f.identity, id), []);
  await validateExecutions(f.storage);
});
