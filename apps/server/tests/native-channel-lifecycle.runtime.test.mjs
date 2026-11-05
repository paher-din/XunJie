import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createFileBackend, provisionStorage, openStorage } from '@xunjie/storage';
import { createNativeChannel, learningMigrations, validateNativeChannel } from '@xunjie/learning-space';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';

test('queued controls stay with original supervisor and discovery expires without losing terminal facts', { timeout: 120000 }, async () => {
  const fixture = await nativeFixture();
  let storage;
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations: learningMigrations });
    storage = await openStorage({ binding, migrations: learningMigrations, backend: createFileBackend({ id: 'channel', root: join(fixture.root, 'resources') }) });
    const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '学校' };
    const node = { connectionId: randomUUID(), nodeId: 'fixed-node', installationId: randomUUID(), platform: 'macos-arm64',
      supervisorEpoch: randomUUID(), adapters: [{ adapterId: 'four-state-accumulator', adapterVersion: 1 }] };
    const channel = createNativeChannel(storage, { async authenticate() { return identity; }, async authorize() {}, async authorizeConnection() {} });
    await channel.register('approved', node);
    await channel.heartbeat('approved', node);
    assert.deepEqual(await channel.nodes(identity), [node]);
    const activityId = randomUUID(), sessionId = randomUUID();
    const submit = { commandId: randomUUID(), activityId, sessionId, operation: 'submit', payload: {
      execution: { session: { supervisorEpoch: node.supervisorEpoch } }, action: { execution: { parameters: { longerKey: 1, x: 2 } } },
    } };
    await channel.enqueue(identity, node.connectionId, submit);
    const first = (await channel.claim('approved', node)).command;
    assert.equal(JSON.stringify(first.payload), JSON.stringify(submit.payload));
    await channel.report('approved', { node, commandId: submit.commandId, claimId: first.claimId, result: { state: 'running', statusKnowledge: 'confirmed' } });
    const control = { commandId: randomUUID(), activityId, sessionId, operation: 'control', payload: { expectedSeq: 0 } };
    await channel.enqueue(identity, node.connectionId, control);
    const oldPending = { ...submit, commandId: randomUUID(), sessionId: randomUUID() };
    await channel.enqueue(identity, node.connectionId, oldPending);
    const replacement = { ...node, supervisorEpoch: randomUUID() };
    await channel.register('approved', replacement);
    await channel.heartbeat('approved', replacement);
    assert.equal((await channel.claim('approved', replacement)).command, null);
    assert.equal((await channel.query(identity, control.commandId)).statusKnowledge, 'unknown');
    assert.equal((await channel.query(identity, oldPending.commandId)).statusKnowledge, 'unknown');
    await assert.rejects(channel.report('approved', { node, commandId: submit.commandId, claimId: first.claimId,
      result: { state: 'failed', statusKnowledge: 'confirmed' } }), { code: 'forbidden' });
    assert.equal((await storage.read('SELECT * FROM native_channel_late_reports')).rows.length, 1);
    assert.equal((await channel.query(identity, submit.commandId)).result.state, 'running');
    assert.equal((await channel.query(identity, submit.commandId)).result.statusKnowledge, 'unknown');
    await assert.rejects(channel.report('approved', { node: replacement, commandId: submit.commandId,
      claimId: first.claimId, result: { state: 'running', statusKnowledge: 'confirmed' } }), { code: 'forbidden' });
    const terminal = { ...submit, commandId: randomUUID(), sessionId: randomUUID(), payload: { execution: { session: { supervisorEpoch: replacement.supervisorEpoch } } } };
    await channel.enqueue(identity, node.connectionId, terminal);
    const next = (await channel.claim('approved', replacement)).command;
    assert.equal(next.commandId, terminal.commandId);
    await channel.report('approved', { node: replacement, commandId: terminal.commandId, claimId: next.claimId, result: { state: 'cancelled', statusKnowledge: 'confirmed' } });
    await storage.request({ requestId: randomUUID(), fingerprint: 'expire-channel-lease' }, async tx => {
      await tx.query("UPDATE native_channel_nodes SET lease_until=clock_timestamp()-interval '1 second'");
      return null;
    });
    assert.deepEqual(await channel.nodes(identity), []);
    assert.equal((await channel.query(identity, terminal.commandId)).result.statusKnowledge, 'confirmed');
    await validateNativeChannel(storage);
  } finally { if (storage) await storage.close(); await fixture.close(); }
});
