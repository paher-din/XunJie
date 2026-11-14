import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { StorageError } from '@xunjie/storage';
import type { TeachingToolData } from '@xunjie/agents';
import { anyExecutionActionSchema, executionQuerySchema, type AnyExecutionAction } from '@xunjie/contracts/execution';
import { createExecutionRouting, createSchoolExecutionHandler,
  type SchoolExecutionAuthorization, type SchoolExecutionSource } from '../dist/execution-routing.js';

type Executions = TeachingToolData['executions'];
type Context = Parameters<Executions['agent']['dispatch']>[2];
const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school' as const, name: 'student' };
const activityId = randomUUID();
const scope = { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId };
const fixedContext = () => ({ runId: randomUUID(), stepId: randomUUID(), commandId: randomUUID(), snapshotId: randomUUID() });
function actionFor(location: 'local' | 'remote', requestId = randomUUID()) {
  return anyExecutionActionSchema.parse({ protocolVersion: 2, kind: 'execution', requestId, scope,
    receiver: { receiverId: 'native-execution', location, kind: 'execution' },
    execution: { instance: { instanceId: activityId + ':counter', key: 'counter', componentId: randomUUID(),
      componentVersion: 1, definitionDigest: 'a'.repeat(64), hostApiVersion: 1, stateVersion: 1 },
      operation: { operationId: 'advance', effect: 'input' }, parameters: {},
      basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] },
      limits: { timeMs: 1000, memoryPages: 1, inputBytes: 128, outputBytes: 2048, concurrentJobs: 1, queuedJobs: 0 },
      plan: { planId: 'native-session', planVersion: 1, planDigest: 'b'.repeat(64), location: 'native', kind: 'session' },
      session: { adapterId: 'four-state-accumulator', adapterVersion: 1,
        limits: { operationTimeoutMs: 1000, idleMs: 10000, maxMs: 60000, memoryMiB: 32, concurrentSessions: 1, queuedSessions: 0 } },
      initiator: { kind: 'agent', principalId: identity.principalId } } });
}
function queryFor(action: AnyExecutionAction) {
  return executionQuerySchema.parse({ requestId: action.requestId, inputDigest: 'c'.repeat(64), scope: action.scope,
    executionRef: randomUUID(), state: 'running', statusKnowledge: 'confirmed', stopRequested: false,
    confirmedSeq: 1, reason: null, output: null });
}
function port() {
  const calls: string[] = [], contexts: Context[] = [];
  const records = new Map<string, { action: AnyExecutionAction; context: Context; query: ReturnType<typeof queryFor> }>();
  let denyNormal = false, readDispatch = false;
  const record = (id: string) => records.get(id);
  const executions: Executions = {
    read: async (_i, _a, id) => { calls.push('read'); return record(id)?.query ?? null; },
    artifact: async (_i, _a, id) => { calls.push('artifact'); return record(id) ? {
      executionRef: record(id)!.query.executionRef, requestId: id, scope, name: 'result.txt', mediaType: 'text/plain',
      sha256: 'd'.repeat(64), byteLength: 2, text: 'ok', output: {} } : null; },
    controlReceipt: async (_i, _a, id, controlId) => { calls.push('controlReceipt'); return record(id) ? {
      controlId, requestId: id, executionRef: record(id)!.query.executionRef, inputDigest: 'e'.repeat(64),
      effect: 'input', status: 'applied', seq: 1, query: record(id)!.query } : null; },
    agent: {
      dispatch: async (_i, _a, ctx, value) => {
        calls.push('agent.dispatch'); contexts.push(ctx);
        await ctx.assertDispatch(); await ctx.assertDispatch();
        const action = anyExecutionActionSchema.parse(value), query = queryFor(action);
        records.set(action.requestId, { action, context: ctx, query }); return query;
      },
      control: async (_i, _a, ctx, id) => {
        calls.push('agent.control'); contexts.push(ctx); await ctx.assertDispatch();
        return record(id)!.query;
      },
      original: async (_i, _a, _ctx, id) => {
        calls.push('agent.original');
        if (denyNormal) throw new StorageError('forbidden');
        const saved = record(id);
        return saved ? { action: saved.action, association: {
          runId: saved.context.runId, stepId: saved.context.stepId,
          commandId: saved.context.commandId, snapshotId: saved.context.snapshotId } } : null;
      },
      read: async (_i, _a, ctx, id) => {
        calls.push('agent.read'); contexts.push(ctx);
        if (readDispatch) await ctx.assertDispatch();
        return record(id)?.query ?? null;
      },
      status: async (_i, _a, _ctx, id) => {
        calls.push('agent.status'); return record(id) ? { cancelled: false, claimed: true, browserId: null } : null;
      },
      cleanupStatus: async (_i, _a, _ctx, id) => {
        calls.push('agent.cleanupStatus'); return record(id) ? { cancelled: true, claimed: true, browserId: null } : null;
      },
      cleanup: async (_i, _a, ctx, id) => {
        calls.push('agent.cleanup'); contexts.push(ctx); return record(id)?.query ?? null;
      },
    },
  };
  return { executions, calls, contexts, records, denyNormal: () => { denyNormal = true; },
    dispatchOnRead: () => { readDispatch = true; } };
}
function fixture() {
  const local = port(), school = port(), requests: [string, unknown][] = [], authorizations: SchoolExecutionAuthorization[] = [];
  let permitted = true, grantActive = true;
  const source: SchoolExecutionSource = { sourceEnvironmentId: randomUUID(), sourceServiceId: randomUUID(),
    sourceInstallationId: randomUUID(), grantId: randomUUID(), assertAuthorized: async () => {
      if (!grantActive) throw new StorageError('forbidden');
    } };
  const handler = createSchoolExecutionHandler({ executions: school.executions, authorize: async input => {
    authorizations.push(input);
    if (!permitted && input.phase !== 'cleanup') throw new StorageError('forbidden');
  } });
  const call = async (who: typeof identity, id: string, args: [string, unknown]) => {
    // This is the real serialization boundary. No function can survive it.
    const wire = JSON.parse(JSON.stringify(args)) as [string, unknown]; requests.push(wire);
    return JSON.parse(JSON.stringify(await handler(who, id, wire, source))) as unknown;
  };
  const routing = () => createExecutionRouting({ local: local.executions, call });
  return { local, school, source, handler, requests, authorizations, routing,
    denyCourse: () => { permitted = false; }, revokeGrant: () => { grantActive = false; } };
}

test('remote Agent commands and every follow-up reach the original school owner across adapter restart', async () => {
  const f = fixture(), action = actionFor('remote'), metadata = { ...fixedContext(), commandId: action.requestId };
  let localGuards = 0;
  const ctx = { ...metadata, assertDispatch: async () => { localGuards++; } };
  const routed = f.routing();
  const query = await routed.agent.dispatch(identity, activityId, ctx, action);
  assert.equal(query!.requestId, action.requestId);
  assert.equal(localGuards, 1, 'the originating Run guard executes only on the device');
  assert.equal(f.school.contexts[0]!.origin!.grantId, f.source.grantId);
  assert.notEqual(f.school.contexts[0]!.assertDispatch, ctx.assertDispatch);
  assert.equal(JSON.stringify(f.requests[0]).includes('assertDispatch'), false);
  assert.equal(f.authorizations.filter(input => input.phase === 'dispatch').length, 3, 'school guard rechecks local authority at each effect boundary');
  const resumed = f.routing();
  assert.equal((await resumed.agent.original(identity, activityId, ctx, action.requestId))!.action.receiver.location, 'remote');
  assert.equal((await resumed.agent.read(identity, activityId, ctx, action.requestId))!.executionRef, query!.executionRef);
  assert.equal((await resumed.agent.status(identity, activityId, ctx, action.requestId))!.claimed, true);
  assert.equal((await resumed.read(identity, activityId, action.requestId))!.executionRef, query!.executionRef);
  assert.equal((await resumed.artifact(identity, activityId, action.requestId))!.text, 'ok');
  const controlId = randomUUID(), controlContext = { ...ctx, commandId: controlId };
  await resumed.agent.control(identity, activityId, controlContext, action.requestId,
    { controlId, operationId: 'advance', effect: 'input', expectedSeq: 0, parameters: { value: 1 } });
  assert.equal((await resumed.controlReceipt(identity, activityId, action.requestId, controlId))!.controlId, controlId);
  await resumed.agent.cleanupStatus(identity, activityId, ctx, action.requestId);
  await resumed.agent.cleanup(identity, activityId, ctx, action.requestId, { stopId: randomUUID(), reason: '' });
  for (const method of ['agent.dispatch', 'agent.control', 'agent.read', 'agent.original', 'agent.status',
    'agent.cleanupStatus', 'agent.cleanup', 'read', 'artifact', 'controlReceipt'])
    assert.ok(f.school.calls.includes(method), method);
  assert.equal(f.local.calls.includes('agent.dispatch'), false);
  assert.equal(f.local.calls.includes('agent.control'), false);
});

test('local requests stay local, and a lost school reply never dispatches on the device', async () => {
  const f = fixture(), localAction = actionFor('local'), ctx = { ...fixedContext(), commandId: localAction.requestId, assertDispatch: async () => {} };
  const e = f.routing();
  await e.agent.dispatch(identity, activityId, ctx, localAction);
  await e.agent.original(identity, activityId, ctx, localAction.requestId);
  await e.agent.read(identity, activityId, ctx, localAction.requestId);
  await e.agent.status(identity, activityId, ctx, localAction.requestId);
  await e.agent.cleanupStatus(identity, activityId, ctx, localAction.requestId);
  await e.agent.cleanup(identity, activityId, ctx, localAction.requestId, { stopId: randomUUID(), reason: '' });
  await e.read(identity, activityId, localAction.requestId);
  await e.artifact(identity, activityId, localAction.requestId);
  await e.controlReceipt(identity, activityId, localAction.requestId, randomUUID());
  assert.equal(f.requests.length, 0);
  const remote = actionFor('remote'), error = new StorageError('commit-unknown');
  const broken = createExecutionRouting({ local: f.local.executions, call: async () => { throw error; } });
  await assert.rejects(broken.agent.dispatch(identity, activityId, { ...ctx, commandId: remote.requestId }, remote), error);
  assert.equal(f.local.records.has(remote.requestId), false);
});

test('guard denial prevents transport; read-only original/status and revoked-course cleanup do not ask for a new permit', async () => {
  const f = fixture(), action = actionFor('remote'), metadata = { ...fixedContext(), commandId: action.requestId };
  let guards = 0;
  const denied = { ...metadata, assertDispatch: async () => { guards++; throw new StorageError('forbidden'); } };
  await assert.rejects(f.routing().agent.dispatch(identity, activityId, denied, action), { code: 'forbidden' });
  assert.equal(f.requests.length, 0);
  await f.routing().agent.dispatch(identity, activityId, { ...metadata, assertDispatch: async () => {} }, action);
  const count = guards;
  await f.routing().agent.original(identity, activityId, denied, action.requestId);
  await f.routing().agent.status(identity, activityId, denied, action.requestId);
  assert.equal(guards, count);
  const query = await f.routing().agent.read(identity, activityId, denied, action.requestId);
  assert.equal(query!.requestId, action.requestId);
  assert.equal((f.requests.at(-1)![1] as { dispatchAuthorized: boolean }).dispatchAuthorized, false);
  f.school.dispatchOnRead();
  await assert.rejects(f.routing().agent.read(identity, activityId, denied, action.requestId), { code: 'forbidden' });
  f.denyCourse(); f.local.denyNormal();
  await f.routing().agent.cleanupStatus(identity, activityId, denied, action.requestId);
  await f.routing().agent.cleanup(identity, activityId, denied, action.requestId, { stopId: randomUUID(), reason: '' });
  assert.equal(f.authorizations.at(-1)!.phase, 'cleanup');
});

test('source origin cannot be supplied over the wire; school authorization is checked before effects', async () => {
  const f = fixture(), action = actionFor('remote'), metadata = { ...fixedContext(), commandId: action.requestId };
  const args = ['agent.dispatch', { context: metadata, action, dispatchAuthorized: true }];
  await assert.rejects(f.handler(identity, activityId, ['agent.dispatch', { context: { ...metadata,
    origin: { grantId: randomUUID() } }, action, dispatchAuthorized: true }], f.source));
  await assert.rejects(f.handler(identity, activityId, args, { ...f.source, sourceInstallationId: undefined }));
  f.denyCourse();
  await assert.rejects(f.handler(identity, activityId, args, f.source), { code: 'forbidden' });
  assert.equal(f.school.calls.length, 0);
  f.revokeGrant();
  await assert.rejects(f.handler(identity, activityId, ['agent.cleanupStatus', { context: metadata, requestId: action.requestId }], f.source),
    { code: 'forbidden' });
});

test('remote action is fixed before an async guard, and mismatched responses are never exposed', async () => {
  const f = fixture(), action = actionFor('remote'), metadata = { ...fixedContext(), commandId: action.requestId };
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(done => { release = done; }), started = new Promise<void>(done => { entered = done; });
  const pending = f.routing().agent.dispatch(identity, activityId, { ...metadata, assertDispatch: async () => { entered(); await gate; } }, action);
  await started;
  action.execution.parameters = { later: 'different' };
  release(); await pending;
  assert.deepEqual(f.school.records.get(action.requestId)!.action.execution.parameters, {});
  const corrupt = createExecutionRouting({ local: f.local.executions, call: async () => ({
    ...queryFor(action), scope: { ...scope, principalId: randomUUID() } }) });
  await assert.rejects(corrupt.read(identity, activityId, action.requestId), { code: 'identity-conflict' });
  const malformed = createExecutionRouting({ local: f.local.executions, call: async () => ({ ready: true }) });
  await assert.rejects(malformed.agent.status(identity, activityId, { ...metadata, assertDispatch: async () => {} }, action.requestId),
    { code: 'unavailable' });
  const functional = actionFor('remote');
  functional.execution.parameters = { run: () => {} };
  await assert.rejects(f.routing().agent.dispatch(identity, activityId,
    { ...metadata, commandId: functional.requestId, assertDispatch: async () => {} }, functional));
  assert.equal(f.school.records.has(functional.requestId), false);
});
