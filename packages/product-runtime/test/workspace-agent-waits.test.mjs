import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { StorageError } from '@xunjie/storage';
import { createWorkspaceAgentWaits } from '../dist/workspace-agent-waits.js';

test('only an admitted workspace wait polls its original execution and user waits remain idle', async () => {
  const callbacks = new Map(), reads = [], resolutions = [];
  let next = 0, ready = false;
  const timers = { setTimeout(callback) { callbacks.set(++next, callback); return next; }, clearTimeout(id) { callbacks.delete(id); } };
  const session = { sessionId: randomUUID(), identity: { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(),
    kind: 'personal', name: '学生' }, scenario: 'workspace-assistant', restartPolicy: 'automatic', createdAt: new Date().toISOString() };
  const wait = { waitId: randomUUID(), runId: randomUUID(), operationId: randomUUID(), version: 1,
    kind: 'workspace-execution', state: 'pending', response: null, deadline: null,
    presentation: { activityId: randomUUID(), requestId: randomUUID(), commandId: randomUUID(),
      association: { runId: null, stepId: randomUUID(), snapshotId: randomUUID(), commandId: null } } };
  wait.presentation.association.runId = wait.runId;
  wait.presentation.association.commandId = wait.presentation.commandId;
  const waits = createWorkspaceAgentWaits({ timers, async read(original, fixed) {
    reads.push([original.sessionId, fixed.waitId, fixed.presentation.requestId]);
    if (!ready) throw new StorageError('unavailable');
    return { state: 'succeeded', statusKnowledge: 'confirmed', requestId: fixed.presentation.requestId, executionRef: randomUUID() };
  }, async resolve(original, fixed, result) { resolutions.push([original.sessionId, fixed.waitId, result]); } });
  assert.equal(callbacks.size, 0);
  waits.observe({ session, runId: wait.runId, waits: [{ ...wait, kind: 'user' }] });
  assert.equal(callbacks.size, 0);
  waits.observe({ session, runId: wait.runId, waits: [wait] });
  assert.equal(callbacks.size, 1);
  callbacks.values().next().value(); await waits.drain();
  assert.equal(reads.length, 1);
  assert.equal(resolutions.length, 0);
  assert.equal(callbacks.size, 1);
  ready = true;
  callbacks.values().next().value(); await waits.drain();
  assert.equal(reads.length, 2);
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0][2].requestId, wait.presentation.requestId);
  assert.equal(callbacks.size, 0);
  waits.observe({ session, runId: wait.runId, waits: [{ ...wait, waitId: randomUUID() }] });
  assert.equal(callbacks.size, 1);
  waits.observe({ session, runId: wait.runId, waits: [] });
  assert.equal(callbacks.size, 0);
  waits.closeDispatch(); await waits.drain();
});

test('a confirmed original input receipt resumes its wait while the native session stays running', async () => {
  const callbacks = new Map(), resolutions = [];
  let next = 0;
  const timers = { setTimeout(callback) { callbacks.set(++next, callback); return next; }, clearTimeout(id) { callbacks.delete(id); } };
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
  const session = { sessionId: randomUUID(), identity, scenario: 'workspace-assistant', restartPolicy: 'automatic', createdAt: new Date().toISOString() };
  const runId = randomUUID(), commandId = randomUUID(), activityId = randomUUID(), requestId = randomUUID();
  const wait = { waitId: randomUUID(), runId, operationId: randomUUID(), version: 1, kind: 'workspace-execution',
    state: 'pending', response: null, deadline: null, presentation: { activityId, requestId, commandId,
      association: { runId, commandId, stepId: randomUUID(), snapshotId: randomUUID() } } };
  const query = { requestId, executionRef: randomUUID(), inputDigest: 'a'.repeat(64),
    scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId },
    state: 'running', statusKnowledge: 'confirmed', stopRequested: false, confirmedSeq: 3, reason: null, output: null };
  const receipt = { controlId: commandId, requestId, executionRef: query.executionRef, inputDigest: 'b'.repeat(64),
    effect: 'input', status: 'applied', seq: 1, query };
  const waits = createWorkspaceAgentWaits({ timers,
    async read() { return { ...query, controlReceipt: receipt }; },
    async resolve(_session, fixed, result) { resolutions.push({ waitId: fixed.waitId, result }); } });
  try {
    waits.observe({ session, runId, waits: [wait] });
    callbacks.values().next().value(); await waits.drain();
    assert.equal(resolutions.length, 1, 'the original input is complete without stopping its parent session');
    assert.equal(resolutions[0].waitId, wait.waitId);
    assert.equal(resolutions[0].result.state, 'running');
    assert.equal(resolutions[0].result.controlReceipt.controlId, commandId);
    assert.equal(callbacks.size, 0);
  } finally { waits.closeDispatch(); await waits.drain(); }
});

test('an accepted native start resumes when its original process becomes ready instead of waiting for termination', async () => {
  const callbacks = new Map(), resolutions = []; let next = 0;
  const timers = { setTimeout(callback) { callbacks.set(++next, callback); return next; }, clearTimeout(id) { callbacks.delete(id); } };
  const session = { sessionId: randomUUID(), identity: { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(),
    kind: 'personal', name: '学生' }, scenario: 'workspace-assistant', restartPolicy: 'automatic', createdAt: new Date().toISOString() };
  const runId = randomUUID(), commandId = randomUUID();
  const wait = { waitId: randomUUID(), runId, operationId: randomUUID(), version: 1, kind: 'workspace-execution', state: 'pending', response: null,
    deadline: null, presentation: { activityId: randomUUID(), requestId: commandId, commandId,
      association: { runId, commandId, stepId: randomUUID(), snapshotId: randomUUID() } } };
  const result = { state: 'running', statusKnowledge: 'confirmed', requestId: commandId, executionRef: randomUUID(),
    session: { adapterId: 'four-state-accumulator', appliedSeq: 0 } };
  const waits = createWorkspaceAgentWaits({ timers, async read() { return result; },
    async resolve(_session, _wait, original) { resolutions.push(original); } });
  try {
    waits.observe({ session, runId, waits: [wait] });
    callbacks.values().next().value(); await waits.drain();
    assert.equal(resolutions.length, 1, 'the confirmed native start is ready for the next input');
    assert.equal(resolutions[0].state, 'running');
    assert.equal(callbacks.size, 0);
  } finally { waits.closeDispatch(); await waits.drain(); }
});
