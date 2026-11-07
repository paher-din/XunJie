import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { collectExecutionBoundary, validateExecutionBoundary } from '../../../packages/learning-space/dist/learning-data/maintenance.js';
import { learningMigrations } from '@xunjie/learning-space';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';

test('channel boundary derives original stop identities from the stored command envelope', { timeout: 120000 }, async t => {
  const fixture = await nativeFixture();
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  let storage;
  t.after(async () => { await storage?.close(); await fixture.close(); });
  const binding = await provisionStorage({ admin: fixture.admin, owner,
    password: randomBytes(32).toString('base64url'), migrations: learningMigrations });
  storage = await openStorage({ binding, migrations: learningMigrations,
    backend: createFileBackend({ id: owner.serviceId, root: join(fixture.root, 'channel-data') }) });
  const requestId = randomUUID(), activityId = randomUUID(), stopId = randomUUID(), executionRef = randomUUID();
  const inputDigest = randomBytes(32).toString('hex');
  const scope = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), activityId };
  const session = { adapterId: 'four-state-accumulator', adapterVersion: 1, instanceId: `${activityId}:accumulator`,
    instanceKey: 'accumulator', nodeId: 'boundary-node', installGeneration: randomUUID(), supervisorEpoch: randomUUID(),
    executorInstanceId: randomUUID(), appliedSeq: 0, lastControlId: null, observation: null, observations: [] };
  const execution = { requestId, inputDigest, executionRef, scope, session, state: 'running', statusKnowledge: 'unknown',
    stopRequested: true, confirmedSeq: 3, reason: { code: 'resource-unavailable', detail: '原连接已失效' }, output: null };
  const command = { operation: 'stop' };
  await storage.request({ requestId: randomUUID(), fingerprint: randomUUID() }, async tx => {
    await tx.query(`INSERT INTO channel_executions(request_id,activity_id,input_digest,action,action_text,activity,connection_id,execution)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [requestId, activityId, inputDigest, '{}', '{}', '{}', randomUUID(), JSON.stringify(execution)]);
    await tx.query(`INSERT INTO channel_execution_intents(command_id,request_id,command,command_text)
      VALUES($1,$2,$3,$4)`, [stopId, requestId, JSON.stringify(command), JSON.stringify(command)]);
    return null;
  });
  const boundary = await collectExecutionBoundary(storage);
  assert.deepEqual(boundary.commands, { total: 1, settled: 0, unresolved: 1 });
  assert.equal(boundary.unresolved[0].executionRef, executionRef);
  assert.deepEqual(boundary.unresolved[0].stopIds, [stopId]);
  assert.equal(boundary.unresolved[0].disposition, 'unknown');
  await validateExecutionBoundary(storage, boundary);

  const connectionId = randomUUID(), claimId = randomUUID();
  const node = { connectionId, nodeId: session.nodeId, installationId: randomUUID(), platform: 'windows-x64',
    supervisorEpoch: session.supervisorEpoch, adapters: [{ adapterId: session.adapterId, adapterVersion: 1 }] };
  const original = { ...execution, statusKnowledge: 'confirmed', stopRequested: false, confirmedSeq: 1, reason: null };
  const submit = { payload: { execution: original } };
  const { appliedSeq, lastControlId, observation, observations, ...sessionIdentity } = session;
  const exitedIdentity = { requestId, inputDigest, executionRef, scope, session: sessionIdentity };
  await storage.request({ requestId: randomUUID(), fingerprint: randomUUID() }, async tx => {
    await tx.query(`INSERT INTO native_channel_nodes(connection_id,node_id,installation_id,owner_generation,identity,snapshot)
      VALUES($1,$2,$3,$4,$5,$6)`, [connectionId, node.nodeId, node.installationId, storage.generation, '{}', JSON.stringify(node)]);
    await tx.query(`INSERT INTO native_channel_commands(command_id,connection_id,activity_id,session_id,operation,command,
      command_text,input_digest,state,claim_id,claim_generation,claim_node,target_generation,target_node)
      VALUES($1,$2,$3,$4,'submit',$5,$6,$7,'claimed',$8,$9,$10,$9,$10)`, [requestId, connectionId, activityId,
      executionRef, JSON.stringify(submit), JSON.stringify(submit), inputDigest, claimId, storage.generation, JSON.stringify(node)]);
    await tx.query(`INSERT INTO native_channel_cleanups(command_id,claim_id,node,owner,generation,execution_identity,proof_digest)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [requestId, claimId, JSON.stringify(node), JSON.stringify(owner), storage.generation,
      JSON.stringify({ ...exitedIdentity, executionRef: randomUUID() }), randomBytes(32).toString('hex')]);
    return null;
  });
  assert.equal((await collectExecutionBoundary(storage)).commands.unresolved, 1,
    'a cleanup naming another execution cannot settle this one');
  await storage.request({ requestId: randomUUID(), fingerprint: randomUUID() }, async tx => {
    await tx.query('UPDATE native_channel_cleanups SET execution_identity=$2 WHERE command_id=$1', [requestId, JSON.stringify(exitedIdentity)]);
    return null;
  });
  const exited = await collectExecutionBoundary(storage);
  assert.deepEqual(exited.commands, { total: 1, settled: 1, unresolved: 0 });
  assert.equal((await storage.read('SELECT execution FROM channel_executions WHERE request_id=$1', [requestId])).rows[0].execution.statusKnowledge, 'unknown',
    'exit proof settles the runtime boundary without rewriting the historical query');
  await assert.rejects(validateExecutionBoundary(storage, boundary), { code: 'corrupt' });
  await validateExecutionBoundary(storage, exited);
  const invalidSubmit = { payload: { execution: { ...original, session: null } } };
  await storage.request({ requestId: randomUUID(), fingerprint: randomUUID() }, async tx => {
    await tx.query('UPDATE native_channel_commands SET command=$2,command_text=$3 WHERE command_id=$1',
      [requestId, JSON.stringify(invalidSubmit), JSON.stringify(invalidSubmit)]);
    return null;
  });
  assert.equal((await collectExecutionBoundary(storage)).commands.unresolved, 1,
    'a missing original executor identity remains unsettled instead of borrowing a cleanup proof');
});

// The owner classifies the commands it really received. The fixture writes the stored facts through
// the owner's own storage transactions, so the classification reads exactly what a boundary read
// would read after a real drain, rather than a mocked inventory.
test('the execution owner classifies unsettled commands and refuses material it cannot re-derive', { timeout: 120000 }, async t => {
  const fixture = await nativeFixture();
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  let storage;
  t.after(async () => { await storage?.close(); await fixture.close(); });
  const binding = await provisionStorage({ admin: fixture.admin, owner,
    password: randomBytes(32).toString('base64url'), migrations: learningMigrations });
  storage = await openStorage({ binding, migrations: learningMigrations,
    backend: createFileBackend({ id: owner.serviceId, root: join(fixture.root, 'data') }) });
  const activityId = randomUUID();
  const identity = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID() };
  const target = { environmentId: owner.environmentId, serviceId: owner.serviceId, version: 1 };
  await storage.request({ requestId: randomUUID(), fingerprint: randomUUID() }, async tx => {
    await tx.query('INSERT INTO activities VALUES ($1,$2,$3,$4,$5)', [activityId, identity.environmentId, identity.spaceId,
      identity.principalId, JSON.stringify({ activityId, identity, target, goal: '维护边界', question: '',
        references: [], status: 'open', createdAt: new Date().toISOString() })]);
    return null;
  });
  async function command(state, statusKnowledge, stopRequested) {
    const requestId = randomUUID(), executionRef = randomUUID(), inputDigest = randomBytes(32).toString('hex');
    await storage.request({ requestId: randomUUID(), fingerprint: randomUUID() }, async tx => {
      await tx.query(`INSERT INTO execution_commands(request_id,activity_id,input_digest,execution_ref,body,acceptance,state,
        status_knowledge,stop_requested,confirmed_seq) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [requestId, activityId, inputDigest, executionRef, JSON.stringify({ activityId, requestId }),
        JSON.stringify({ accepted: true }), state, statusKnowledge, stopRequested, 1]);
      return null;
    });
    return { requestId, executionRef, inputDigest };
  }
  const notStarted = await command('queued', 'confirmed', false);
  const unknown = await command('running', 'unknown', false);
  const stopping = await command('paused', 'confirmed', true);

  const boundary = await collectExecutionBoundary(storage);
  assert.deepEqual(boundary.commands, { total: 3, settled: 0, unresolved: 3 });
  assert.equal(boundary.unresolved.length, 3);
  const disposition = new Map(boundary.unresolved.map(command => [command.requestId, command.disposition]));
  assert.equal(disposition.get(notStarted.requestId), 'accepted-not-started');
  assert.equal(disposition.get(unknown.requestId), 'unknown');
  assert.equal(disposition.get(stopping.requestId), 'stop-pending');
  assert.deepEqual(boundary.blocking.map(item => item.code).sort(), ['unconfirmed-browser-boundary', 'unresolved-stop-pending', 'unresolved-unknown']);
  for (const entry of boundary.unresolved) {
    assert.deepEqual([entry.activityId, entry.location], [activityId, 'browser']);
    assert.equal(entry.stopRequested, entry.requestId === stopping.requestId);
  }
  // The material round-trips only while it still describes the stored facts.
  await validateExecutionBoundary(storage, boundary);

  const tampered = structuredClone(boundary);
  tampered.unresolved.find(item => item.requestId === stopping.requestId).disposition = 'accepted-not-started';
  await assert.rejects(validateExecutionBoundary(storage, tampered), { code: 'corrupt' });
  const dropped = structuredClone(boundary);
  dropped.commands.total += 1;
  await assert.rejects(validateExecutionBoundary(storage, dropped), { code: 'corrupt' });
  const changedPosition = structuredClone(boundary);
  changedPosition.unresolved[0].confirmedSeq++;
  await assert.rejects(validateExecutionBoundary(storage, changedPosition), { code: 'corrupt' });
  const removedBlock = structuredClone(boundary);
  removedBlock.blocking = [];
  await assert.rejects(validateExecutionBoundary(storage, removedBlock), { code: 'corrupt' });

  // A confirmed terminal fact settles the command; the old material can no longer describe it.
  await storage.request({ requestId: randomUUID(), fingerprint: randomUUID() }, async tx => {
    await tx.query(`UPDATE execution_commands SET state='succeeded',status_knowledge='confirmed',confirmed_seq=2
      WHERE request_id=$1`, [unknown.requestId]);
    return null;
  });
  const settledBoundary = await collectExecutionBoundary(storage);
  assert.deepEqual(settledBoundary.commands, { total: 3, settled: 1, unresolved: 2 });
  assert.deepEqual(settledBoundary.blocking.map(item => item.code).sort(), ['unconfirmed-browser-boundary', 'unresolved-stop-pending']);
  await assert.rejects(validateExecutionBoundary(storage, boundary), { code: 'corrupt' });
  await validateExecutionBoundary(storage, settledBoundary);
});
