import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { collectExecutionBoundary, validateExecutionBoundary } from '../../../packages/learning-space/dist/learning-data/maintenance.js';
import { learningMigrations } from '@xunjie/learning-space';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';

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
