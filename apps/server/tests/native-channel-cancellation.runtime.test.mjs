import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { createNativeChannel, learningMigrations, validateNativeChannel } from '@xunjie/learning-space';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';

test('stopping an unclaimed native submit cancels it durably without dispatching a process', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  let storage;
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations: learningMigrations });
    const backend = createFileBackend({ id: 'cancelled-channel', root: join(fixture.root, 'resources') });
    storage = await openStorage({ binding, migrations: learningMigrations, backend });
    const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '学校' };
    const options = { async authenticate() { return identity; }, async authorize() {}, async authorizeConnection() {} };
    let channel = createNativeChannel(storage, options);
    const node = { connectionId: randomUUID(), nodeId: 'cancel-before-claim', installationId: randomUUID(), platform: 'macos-arm64',
      supervisorEpoch: randomUUID(), adapters: [{ adapterId: 'four-state-accumulator', adapterVersion: 1 }] };
    await channel.register('approved', node);
    const activityId = randomUUID(), requestId = randomUUID(), sessionId = randomUUID();
    const execution = { requestId, inputDigest: 'a'.repeat(64), executionRef: sessionId,
      scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId },
      state: 'queued', statusKnowledge: 'confirmed', stopRequested: false, confirmedSeq: 1, reason: null, output: null,
      session: { adapterId: 'four-state-accumulator', adapterVersion: 1, instanceId: `${activityId}:accumulator`, instanceKey: 'accumulator',
        nodeId: node.nodeId, installGeneration: node.installationId, supervisorEpoch: node.supervisorEpoch,
        executorInstanceId: randomUUID(), appliedSeq: 0, lastControlId: null, observation: null, observations: [] } };
    const submit = { commandId: requestId, activityId, sessionId, operation: 'submit', payload: { execution } };
    const stopId = randomUUID();
    const stop = { commandId: stopId, activityId, sessionId, operation: 'stop',
      payload: { requestId, executionRef: sessionId, stop: { stopId, reason: '' } } };
    await channel.enqueue(identity, node.connectionId, submit);
    await channel.enqueue(identity, node.connectionId, stop);
    assert.equal((await channel.claim('approved', node)).command, null, 'a queued cancellation must never start the original process');
    const cancelled = await channel.query(identity, requestId);
    assert.equal(cancelled.result.state, 'cancelled');
    assert.equal(cancelled.result.statusKnowledge, 'confirmed');
    assert.equal(cancelled.result.stopRequested, true);
    assert.equal(cancelled.result.confirmedSeq, 2);
    assert.equal(cancelled.result.executionRef, sessionId);
    assert.equal(cancelled.result.session.executorInstanceId, execution.session.executorInstanceId);
    assert.deepEqual((await channel.query(identity, stopId)).result, cancelled.result);
    await channel.enqueue(identity, node.connectionId, submit);
    await channel.enqueue(identity, node.connectionId, stop);
    await storage.close();
    storage = await openStorage({ binding, migrations: learningMigrations, backend });
    channel = createNativeChannel(storage, options);
    assert.equal((await channel.claim('approved', node)).command, null);
    assert.deepEqual(await channel.query(identity, requestId), cancelled);
    // Once a claim could have dispatched, a stop must reach that original worker instead
    // of inventing a confirmed cancellation in the school ledger.
    const claimedRequest = randomUUID(), claimedSession = randomUUID(), claimedStopId = randomUUID();
    await channel.enqueue(identity, node.connectionId, { ...submit, commandId: claimedRequest, sessionId: claimedSession,
      payload: { execution: { ...execution, requestId: claimedRequest, executionRef: claimedSession } } });
    assert.equal((await channel.claim('approved', node)).command.commandId, claimedRequest);
    await channel.enqueue(identity, node.connectionId, { ...stop, commandId: claimedStopId, sessionId: claimedSession,
      payload: { requestId: claimedRequest, executionRef: claimedSession, stop: { stopId: claimedStopId, reason: '' } } });
    assert.equal((await channel.query(identity, claimedRequest)).statusKnowledge, 'unknown');
    assert.equal((await channel.claim('approved', node)).command.commandId, claimedStopId);
    await validateNativeChannel(storage);
  } finally { await storage?.close(); await fixture.close(); }
});
