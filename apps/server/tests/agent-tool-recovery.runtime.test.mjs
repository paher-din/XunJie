import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { executionActionSchema } from '@xunjie/contracts/execution';
import { recoveryOwners, runPublishedAggregation } from './support/teaching-recovery.mjs';
import { reply, until } from './support/session-product.mjs';

async function advanceUntil(f, runId, check) {
  return until(async () => {
    await f.runtime.advance(runId);
    const snapshot = await f.snapshot(runId);
    assert.ok(!['failed', 'paused'].includes(snapshot.run.state), JSON.stringify({ run: snapshot.run, steps: snapshot.steps.map(step => ({ kind: step.operation.kind, state: step.state, result: step.result })) }));
    return check(snapshot) ? snapshot : null;
  }, 'The original current-runtime operation did not reach its expected state.', 20000);
}

const operation = (id, name, parameters = {}, extra = {}) => ({ calls: [{ id, name: 'course_operation',
  arguments: { componentKey: 'counter', operationId: name, parameters, ...extra } }] });

test('a lost real native input receipt reconciles its original operation before the next stateful input', { timeout: 120000 }, async t => {
  let sessionRequestId, lostCommandId;
  const dispatched = [], reconciled = [];
  const f = await recoveryOwners(t, (_payload, response, index) => {
    if (index === 1) return reply(response, operation('native-start', 'start_session'));
    if (index === 2) return reply(response, operation('native-input-one', 'advance', { value: 1 }, { requestId: sessionRequestId, expectedSeq: 0 }));
    if (index === 3) return reply(response, operation('native-input-two', 'advance', { value: 2 }, { requestId: sessionRequestId, expectedSeq: 1 }));
    assert.equal(index, 4); reply(response, { text: '原输入 1 和后继输入 2 的真实累加值是 3。' });
  }, { native: true, decorate: module => ({ ...module,
    async dispatch(context, command, ...args) {
      dispatched.push(command.commandId);
      const result = await module.dispatch(context, command, ...args);
      const prepared = command.input.prepared;
      if (prepared.arguments.operationId === 'start_session') sessionRequestId = result.result.query.requestId;
      if (prepared.arguments.operationId === 'advance' && !lostCommandId) {
        assert.deepEqual(result.result.query.session.observation, { value: 1, total: 1, applied: 1 });
        lostCommandId = command.commandId;
        throw new Error('The original native input applied, but its transport reply was lost.');
      }
      return result;
    },
    async reconcile(context, command) { reconciled.push(command.commandId); return module.reconcile(context, command); },
  }) });
  const receipt = await f.send('启动真实累加器，依次输入 1 和 2，保留丢失的原回执。');
  const completed = await advanceUntil(f, receipt.runId, snapshot => snapshot.run.state === 'completed');
  assert.equal(f.payloads.length, 4);
  assert.equal(dispatched.length, 3); assert.equal(new Set(dispatched).size, 3);
  assert.ok(reconciled.includes(lostCommandId));
  const query = await f.learning.executions.read(f.identity, f.activity.activityId, sessionRequestId);
  assert.deepEqual(query.session.observation, { value: 3, total: 3, applied: 2 });
  const original = await f.learning.executions.controlReceipt(f.identity, f.activity.activityId, sessionRequestId, lostCommandId);
  assert.equal(original.controlId, lostCommandId); assert.equal(original.status, 'applied');
  assert.deepEqual(await f.learning.executions.controlReceipt(f.identity, f.activity.activityId, sessionRequestId, lostCommandId), original);
  assert.equal(completed.steps.filter(step => step.operation.operationId === lostCommandId).length, 1);
  assert.ok(completed.steps.filter(step => step.operation.kind === 'tool.call').every(step => step.state === 'completed'));
  await f.runtime.advance(receipt.runId);
  assert.deepEqual((await f.learning.executions.read(f.identity, f.activity.activityId, sessionRequestId)).session.observation, query.session.observation);
  assert.equal(f.payloads.length, 4);
  await f.learning.executions.stop(f.identity, f.activity.activityId, sessionRequestId, { stopId: randomUUID(), reason: 'fixture completed' });
});

async function browserWait(f) {
  const binding = f.activity.course.components[0], work = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/table.json',
    kind: 'state', encoding: 'json', mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify({
      formatVersion: 1, instanceId: f.activity.activityId + ':table', componentId: f.manifest.componentId, version: f.manifest.version,
      definitionDigest: binding.definition.digest, stateVersion: 1, operationId: randomUUID(), content: f.manifest.initialState }) };
  const works = await f.learning.works.read(f.identity, f.activity.activityId);
  await f.learning.works.sync(f.identity, f.activity.activityId, { requestId: randomUUID(), baseRevision: works.revision, files: [work] });
  const receipt = await f.send('计算原作品的真实均值。', [work]);
  const snapshot = await advanceUntil(f, receipt.runId, snapshot => snapshot.waits.some(wait => wait.kind === 'workspace-execution' && wait.state === 'pending'));
  const wait = snapshot.waits.find(wait => wait.kind === 'workspace-execution' && wait.state === 'pending');
  const commandId = wait.presentation.commandId, browserId = randomUUID();
  const claimed = await f.learning.executions.agent.claimBrowser(f.identity, f.activity.activityId, commandId, browserId, f.guard);
  assert.deepEqual(await f.learning.executions.agent.claimBrowser(f.identity, f.activity.activityId, commandId, browserId, f.guard), claimed);
  await assert.rejects(f.learning.executions.agent.claimBrowser(f.identity, f.activity.activityId, commandId, randomUUID(), f.guard), { code: 'identity-conflict' });
  assert.equal(claimed.action.requestId, commandId);
  assert.deepEqual(claimed.action.execution.basis.works, [work]);
  const computed = await runPublishedAggregation(claimed.action, f.manifest);
  assert.equal(computed.computed.result.value, 83.33333333333333);
  assert.equal(computed.computed.result.groups[0].mean, 83);
  return { receipt, snapshot, wait, commandId, browserId, claimed, ...computed };
}

async function archiveWasm(f, original) {
  const { commandId, browserId, claimed, resultInput } = original;
  const acceptance = original.acceptance ??= {
    receipt: { requestId: commandId, receiver: claimed.action.receiver, state: 'accepted', inputDigest: createHash('sha256').update(JSON.stringify(executionActionSchema.parse(claimed.action))).digest('hex'),
      receiptId: 'original-wasm:' + commandId, detail: '' }, execution: { executionRef: randomUUID(), acceptedSeq: 1 } };
  const accepted = await f.learning.executions.agent.acceptBrowser(f.identity, f.activity.activityId, commandId, browserId, acceptance, f.guard);
  const stored = await f.learning.executions.result(f.identity, f.activity.activityId, commandId, resultInput);
  await f.learning.executions.report(f.identity, f.activity.activityId, commandId, { ...stored, state: 'succeeded', confirmedSeq: 3 });
  return accepted;
}

test('a stopped current Run archives its already-claimed real Wasm result without revival or a second effect', { timeout: 120000 }, async t => {
  const f = await recoveryOwners(t, (_payload, response, index) => {
    assert.ok(index <= 2, 'Only a new student input may dispatch the second model request.');
    reply(response, { calls: [{ id: 'original-browser-' + index, name: 'course_operation', arguments: {
      componentKey: 'table', operationId: 'aggregate', parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } } }] });
  });
  const original = await browserWait(f);
  await f.runtime.stop(f.identity, f.sessionId, original.receipt.runId, randomUUID());
  const stopped = await f.snapshot(original.receipt.runId);
  assert.equal(stopped.run.state, 'stopped'); assert.equal(stopped.waits[0].state, 'cancelled');
  await assert.rejects(f.guard(original.claimed.association), { code: 'stale-generation' });
  const accepted = await archiveWasm(f, original);
  assert.equal(accepted.executionRef, original.acceptance.execution.executionRef);
  assert.equal(accepted.stopRequested, true);
  const archived = await f.learning.executions.read(f.identity, f.activity.activityId, original.commandId);
  assert.equal(archived.output.output.value, 83.33333333333333);
  assert.equal((await f.learning.executions.artifact(f.identity, f.activity.activityId, original.commandId)).text, original.computed.artifact.text);
  await assert.rejects(f.runtime.resolveWait(f.identity, f.sessionId, { requestId: randomUUID(), waitId: original.wait.waitId,
    expectedVersion: original.wait.version, result: archived }), { code: 'conflict' });
  const events = await f.runtime.events(f.identity, f.sessionId);
  assert.deepEqual(await archiveWasm(f, original), archived);
  await f.runtime.advance(original.receipt.runId);
  assert.deepEqual(await f.snapshot(original.receipt.runId), stopped);
  assert.deepEqual(await f.runtime.events(f.identity, f.sessionId), events);
  assert.equal(f.payloads.length, 1, 'Retaining a stopped command result never generates an explanation.');
  const next = await browserWait(f);
  assert.notEqual(next.commandId, original.commandId);
  await f.runtime.stop(f.identity, f.sessionId, next.receipt.runId, randomUUID());
  await archiveWasm(f, next);
  assert.equal(f.payloads.length, 2, 'The same component lane is available to the next original request.');
});

test('an expired current wait retains a late real Wasm result without model continuation', { timeout: 120000 }, async t => {
  const f = await recoveryOwners(t, (_payload, response, index) => {
    assert.equal(index, 1, 'An expired wait cannot generate a model continuation.');
    reply(response, { calls: [{ id: 'expired-original-wasm', name: 'course_operation', arguments: {
      componentKey: 'table', operationId: 'aggregate', parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } } }] });
  }, { decorate: module => ({ ...module, async dispatch(...args) {
    const outcome = await module.dispatch(...args);
    return outcome.wait ? { ...outcome, wait: { ...outcome.wait, deadline: new Date(Date.now() + 1000).toISOString() } } : outcome;
  } }) });
  const original = await browserWait(f);
  await until(() => Date.now() > Date.parse(original.wait.deadline), 'The actual saved wait deadline must expire.');
  // A host wakes only this registered Run. No library-wide scanner or user-wait polling is involved.
  await f.runtime.advance(original.receipt.runId);
  const expired = await f.snapshot(original.receipt.runId);
  assert.equal(expired.run.state, 'paused'); assert.equal(expired.run.reason, 'wait-expired');
  assert.equal(expired.waits[0].state, 'expired');
  await assert.rejects(f.guard(original.claimed.association), { code: 'stale-generation' });
  await archiveWasm(f, original);
  const archived = await f.learning.executions.read(f.identity, f.activity.activityId, original.commandId);
  assert.equal(archived.output.output.value, 83.33333333333333);
  assert.equal((await f.learning.executions.artifact(f.identity, f.activity.activityId, original.commandId)).text, original.computed.artifact.text);
  await assert.rejects(f.runtime.resolveWait(f.identity, f.sessionId, { requestId: randomUUID(), waitId: original.wait.waitId,
    expectedVersion: original.wait.version, result: archived }), { code: 'conflict' });
  const events = await f.runtime.events(f.identity, f.sessionId);
  await archiveWasm(f, original); await f.runtime.advance(original.receipt.runId);
  assert.deepEqual(await f.snapshot(original.receipt.runId), expired);
  assert.deepEqual(await f.runtime.events(f.identity, f.sessionId), events);
  assert.equal(f.payloads.length, 1);
});
